// 账单材料入库（staging）+ 确定性套表。
// 分工红线：模型只交「读表方案」（列在哪、哪些行不算、方向怎么判、例外行怎么办、取值怎么映射），
//   每一行的金额与日期由本模块从原表解析——数字不经模型的手，笔数也不靠模型报数。
// 程序不猜：方案没覆盖到的列取值一律整批退回（不静默归类），把未覆盖取值回给模型改方案。

import type { Database } from 'better-sqlite3-multiple-ciphers'
import { nowIso } from '../db/time'
import { prepareBatch, type BatchItemInput, type BatchPlan } from './batch'
import { listAccounts } from './ledger'

/** 一次入库的最大数据行数（超过要求按更短区间拆分，与字节上限无关）。 */
export const MAX_BILL_ROWS = 5000
/** 方案退回时最多回显多少个未覆盖取值（给模型看，太多没意义）。 */
const UNMATCHED_SAMPLES = 12

export type BillSourceType = 'csv' | 'xlsx'

export interface BillTable {
  id: number
  sourceType: BillSourceType
  fileName: string | null
  channel: string | null
  header: string[]
  rowCount: number
  openRows: number
}

export interface BillColumnMap {
  amount: string
  merchant?: string | null
  time?: string | null
  id?: string | null
  direction?: string | null
  account?: string | null
}

export interface BillCondition {
  column: string
  contains: string
}

export interface BillCategoryRule {
  match: string
  op?: 'contains' | 'equals'
  category_name: string
}

/** 取值映射：原始列值（包含匹配）→ 账户名 / 收支方向。方案没覆盖的取值会被整批退回。 */
export interface BillValueMap {
  contains: string
  account_name?: string
  type?: 'expense' | 'income' | 'transfer'
}

export interface BillRowOverride {
  rows?: number[]
  from_row?: number
  to_row?: number
  type?: 'expense' | 'income' | 'transfer' | 'adjustment' | 'skip'
  category_name?: string | null
  account_name?: string | null
}

export interface BillPlanInput {
  table_id: number
  columns: BillColumnMap
  channel?: string | null
  account_name?: string | null
  direction_column_values?: BillValueMap[]
  account_column_values?: BillValueMap[]
  /** 金额列自带正负号表方向：负=支出、正=收入（不与 direction 列同时用）。 */
  amount_signed?: boolean
  skip_when?: BillCondition[]
  categories?: BillCategoryRule[]
  row_overrides?: BillRowOverride[]
  default_type?: 'expense' | 'income'
}

export interface BillRowSample {
  row: number
  text: string
  reason?: string
}

export interface BillApplyResult {
  tableId: number
  gateId: number | null
  plan: BatchPlan | null
  rowsConsidered: number
  newCount: number
  duplicateCount: number
  reviewCount: number
  skippedCount: number
  reviewSamples: BillRowSample[]
  skippedSamples: BillRowSample[]
}

/** 方案不合格：整批退回，不消费任何行。message 直接给模型看。 */
export class BillPlanError extends Error {}

const DEFAULT_DIRECTION: Record<'expense' | 'income' | 'transfer', string[]> = {
  transfer: ['转入', '转出', '提现', '还款', '零钱通', '余额宝'],
  income: ['收入', '进账', '退款到账'],
  expense: ['支出', '消费', '付款'],
}

const norm = (s: string): string => s.replace(/[\s\u3000"'“”]/g, '').toLowerCase()

/** 列名 → 下标：先精确（忽略空白与全角），再唯一包含匹配；命中不到或不唯一 → null。 */
function columnIndex(header: string[], wanted: string): number | null {
  const w = norm(wanted)
  if (!w) return null
  const exact = header.findIndex((h) => norm(h) === w)
  if (exact >= 0) return exact
  const partial = header.map((h, i) => ({ h, i })).filter((x) => norm(x.h).includes(w) || w.includes(norm(x.h)))
  return partial.length === 1 ? partial[0].i : null
}

/** 金额（整数分）解析：¥/￥/元/千分位/全角逗号/括号负数/正负号。解析不出 → null（绝不猜）。 */
export function parseAmountCents(raw: string | undefined | null): { cents: number; negative: boolean } | null {
  if (!raw) return null
  let s = String(raw).trim()
  if (!s || s === '-' || s === '—') return null
  let negative = false
  if (/^[（(].*[)）]$/.test(s)) {
    negative = true
    s = s.slice(1, -1)
  }
  s = s.replace(/[¥￥圆元\s]/g, '')
  if (/^[+-]\d/.test(s)) {
    negative = s.startsWith('-')
    s = s.slice(1)
  }
  // 逗号只允许作千分位（1,234.56）；"1.234,56" 这类小数逗号不猜，判为解析不出
  if (/[，,]/.test(s)) {
    const t = s.replace(/，/g, ',')
    if (!/^\d{1,3}(,\d{3})+(\.\d{1,2})?$/.test(t)) return null
    s = t.replace(/,/g, '')
  }
  if (!/^\d+(\.\d{1,2})?$/.test(s)) return null
  const cents = Math.round(Number(s) * 100)
  if (!Number.isFinite(cents) || cents <= 0 || cents > 1_000_000_000_00) return null
  return { cents, negative }
}

const pad = (n: number): string => String(n).padStart(2, '0')
const stamp = (y: number, m: number, d: number, hh: number, mm: number, ss: number): string | null => {
  if (m < 1 || m > 12 || d < 1 || d > 31 || hh > 23 || mm > 59 || ss > 59) return null
  return `${y}-${pad(m)}-${pad(d)} ${pad(hh)}:${pad(mm)}:${pad(ss)}`
}

/**
 * 交易时间解析（多格式，返回本地 'YYYY-MM-DD HH:mm:ss'）；解析不出 → null。
 * 支持：ISO / 斜杠 / 中文年月日 / 无年份（按现在所在年份就近取过去年月）/ 14 位紧凑 / Excel 序列号 / 上下午。
 */
export function parseOccurredAt(raw: string | undefined | null, now: Date = new Date()): string | null {
  if (!raw) return null
  const s = String(raw).trim()
  if (!s) return null

  if (/^\d{14}$/.test(s)) {
    return stamp(+s.slice(0, 4), +s.slice(4, 6), +s.slice(6, 8), +s.slice(8, 10), +s.slice(10, 12), +s.slice(12, 14))
  }
  if (/^\d{8}$/.test(s)) {
    return stamp(+s.slice(0, 4), +s.slice(4, 6), +s.slice(6, 8), 0, 0, 0)
  }
  // Excel 日期序列号（4~5 位，可选小数时间部分）：1900 历元起算，落在 1990~2100 才认
  if (/^\d{4,5}(\.\d+)?$/.test(s)) {
    const serial = Number(s)
    if (serial >= 36526 && serial < 73416) {
      const d = new Date(Date.UTC(1899, 11, 30) + serial * 86400000)
      return stamp(d.getUTCFullYear(), d.getUTCMonth() + 1, d.getUTCDate(), d.getUTCHours(), d.getUTCMinutes(), d.getUTCSeconds())
    }
    return null
  }

  let hh = 0
  let mm = 0
  let ss = 0
  const timeM = /(凌晨|早上|上午|中午|下午|晚上)?\s*(\d{1,2}):(\d{2})(?::(\d{2}))?\s*(凌晨|早上|上午|中午|下午|晚上)?/.exec(s)
  if (timeM) {
    hh = Number(timeM[2])
    mm = Number(timeM[3])
    ss = Number(timeM[4] ?? 0)
    const ap = timeM[1] || timeM[5] // 「下午3:20」与「3:20 下午」都认
    if ((ap === '下午' || ap === '晚上') && hh < 12) hh += 12
    if (ap === '中午' && hh < 11) hh += 12
    if (ap === '凌晨' && hh === 12) hh = 0
  }

  const full = /(\d{4})\s*[-/年.]\s*(\d{1,2})\s*[-/月.]\s*(\d{1,2})/.exec(s)
  if (full) return stamp(+full[1], +full[2], +full[3], hh, mm, ss)
  const short = /(\d{1,2})\s*[-/月]\s*(\d{1,2})\s*日?/.exec(s)
  if (short) {
    const m = +short[1]
    const d = +short[2]
    let y = now.getFullYear()
    if (m >= 1 && m <= 12 && m > now.getMonth() + 1) y -= 1 // 还没到的月份 → 大概率是去年的
    return stamp(y, m, d, hh, mm, ss)
  }
  return null
}

// ------------------------------------------------------------------ 入库

/** 把解析好的二维表（首行表头）落进账本，返回表信息与可直接喂给模型的样本摘要。 */
export function stageBill(
  db: Database,
  input: { sourceType: BillSourceType; cells: string[][]; fileName?: string | null; channel?: string | null },
): BillTable {
  const cleaned = input.cells.map((r) => r.map((c) => String(c ?? '').trim()))
  const header = cleaned[0] ?? []
  if (!header.some((h) => h !== '')) throw new Error('表头是空的：这份材料没有列名，请确认首行是表头')
  const width = cleaned.reduce((w, r) => Math.max(w, r.length), header.length)
  const headerFull = Array.from({ length: width }, (_, i) => header[i] || `第${i + 1}列`)
  const dataRows = cleaned.slice(1).filter((r) => r.some((c) => c !== ''))
  if (dataRows.length === 0) throw new Error('表头之下没有数据行')
  if (dataRows.length > MAX_BILL_ROWS) {
    throw new Error(`这份材料有 ${dataRows.length} 行，超过单次上限 ${MAX_BILL_ROWS} 行——请导出时按更短的时间区间拆分`)
  }

  const ts = nowIso()
  const cur = db
    .prepare(
      'INSERT INTO bill_tables (source_type, file_name, channel, header, row_count, created_at, updated_at)' +
        ' VALUES (?, ?, ?, ?, ?, ?, ?)',
    )
    .run(input.sourceType, input.fileName ?? null, input.channel ?? null, JSON.stringify(headerFull), dataRows.length, ts, ts)
  const tableId = Number(cur.lastInsertRowid)
  const ins = db.prepare('INSERT INTO bill_rows (table_id, row_no, cells, disposition) VALUES (?, ?, ?, \'open\')')
  db.transaction(() => {
    dataRows.forEach((r, i) => {
      const cells = Array.from({ length: width }, (_, c) => r[c] ?? '')
      ins.run(tableId, i + 1, JSON.stringify(cells))
    })
  })()

  const table = getBillTable(db, tableId)
  if (!table) throw new Error('入库后读不回账单表（不应发生）')
  return table
}

export function getBillTable(db: Database, id: number): BillTable | null {
  const row = db
    .prepare(
      'SELECT t.id, t.source_type, t.file_name, t.channel, t.header, t.row_count,' +
        " (SELECT COUNT(*) FROM bill_rows r WHERE r.table_id = t.id AND r.disposition = 'open') open_rows" +
        ' FROM bill_tables t WHERE t.id = ?',
    )
    .get(id) as
    | {
        id: number
        source_type: string
        file_name: string | null
        channel: string | null
        header: string
        row_count: number
        open_rows: number
      }
    | undefined
  if (!row) return null
  return {
    id: row.id,
    sourceType: row.source_type as BillSourceType,
    fileName: row.file_name,
    channel: row.channel,
    header: JSON.parse(row.header) as string[],
    rowCount: Number(row.row_count),
    openRows: Number(row.open_rows),
  }
}

export function listBillTables(db: Database, limit = 10): BillTable[] {
  const ids = db
    .prepare('SELECT id FROM bill_tables ORDER BY id DESC LIMIT ?')
    .all(limit) as unknown as { id: number }[]
  return ids.map((x) => getBillTable(db, x.id)).filter((t): t is BillTable => t !== null)
}

export interface BillRowView {
  no: number
  cells: string[]
  disposition: string
  reason: string | null
}

/** 分页读原表（这是 Agent 的"眼睛"：它自己决定看哪一段，程序只负责如实给）。 */
export function readBillRows(
  db: Database,
  tableId: number,
  fromRow = 1,
  limit = 50,
): { table: BillTable; from: number; to: number; rows: BillRowView[] } {
  const table = getBillTable(db, tableId)
  if (!table) throw new Error(`账单材料 #${tableId} 不存在（可用 list_bills 看已入库的材料）`)
  const size = Math.min(Math.max(limit, 1), 200)
  const from = Math.max(fromRow, 1)
  const rows = db
    .prepare('SELECT row_no, cells, disposition, reason FROM bill_rows WHERE table_id = ? AND row_no >= ? ORDER BY row_no LIMIT ?')
    .all(tableId, from, size) as unknown as { row_no: number; cells: string; disposition: string; reason: string | null }[]
  return {
    table,
    from,
    to: rows.length ? rows[rows.length - 1].row_no : from - 1,
    rows: rows.map((r) => ({
      no: r.row_no,
      cells: JSON.parse(r.cells) as string[],
      disposition: r.disposition,
      reason: r.reason,
    })),
  }
}

// ------------------------------------------------------------------ 套表

interface ResolvedPlan {
  amount: number
  merchant: number | null
  time: number | null
  id: number | null
  direction: number | null
  account: number | null
}

function resolveColumns(header: string[], columns: BillPlanInput['columns']): ResolvedPlan {
  const pick = (name: string | null | undefined, what: string): number | null => {
    if (!name) return null
    const idx = columnIndex(header, name)
    if (idx === null) {
      throw new BillPlanError(
        `表里没有对得上「${name}」的列（${what}）。这份材料的列名是：${header.filter((h) => h).join(' | ')}`,
      )
    }
    return idx
  }
  const amount = pick(columns.amount, '金额列')
  if (amount === null) throw new BillPlanError('必须给出金额列（columns.amount）')
  return {
    amount,
    merchant: pick(columns.merchant, '商户列'),
    time: pick(columns.time, '交易时间列'),
    id: pick(columns.id, '交易号列'),
    direction: pick(columns.direction, '收支方向列'),
    account: pick(columns.account, '支付/账户列'),
  }
}

function overrideCovers(ov: BillRowOverride, rowNo: number): boolean {
  if (ov.rows?.includes(rowNo)) return true
  if (ov.from_row && ov.to_row && rowNo >= ov.from_row && rowNo <= ov.to_row) return true
  if (ov.from_row && !ov.to_row && rowNo === ov.from_row) return true
  return false
}

function cell(row: string[], idx: number | null): string {
  return idx === null || idx === undefined ? '' : (row[idx] ?? '').trim()
}

function rowText(row: string[]): string {
  return row.join(' · ').replace(/\s·\s·\s*$/g, '').trim()
}

/** 方向判定：账户/方向列取值 → 映射；未覆盖 → null（由调用方收集后整批退回）。 */
function mapValue(
  value: string,
  maps: BillValueMap[] | undefined,
  defaults: Record<'expense' | 'income' | 'transfer', string[]>,
): 'expense' | 'income' | 'transfer' | 'unmapped' | undefined {
  if (!value) return undefined
  const v = norm(value)
  for (const m of maps ?? []) {
    if (m.contains && v.includes(norm(m.contains))) {
      if (m.account_name && m.type === undefined) return undefined // 账户映射，不参与方向判定
      return m.type ?? 'expense'
    }
  }
  for (const kind of ['transfer', 'income', 'expense'] as const) {
    if (defaults[kind].some((k) => v.includes(norm(k)))) return kind
  }
  return 'unmapped'
}

/**
 * 套用方案：逐行从原表确定性解析金额/时间/方向/账户/分类，产出批次确认门。
 * 不变量：本次消费的行数 == 将入账 + 重复跳过 + 待核对 + 不计收支；不平即回滚报错。
 * 方案没覆盖的列取值 → 整批退回（不消费任何行），未覆盖清单回给模型改方案。
 */
export function applyBillPlan(
  db: Database,
  plan: BillPlanInput,
  ctx: { sessionId: string; sourceMessageId?: string | null },
): BillApplyResult {
  const table = getBillTable(db, plan.table_id)
  if (!table) throw new Error(`账单材料 #${plan.table_id} 不存在（可用 list_bills 看已入库的材料）`)
  const resolved = resolveColumns(table.header, plan.columns)
  const accounts = new Set(listAccounts(db).map((a) => a.name))
  if (plan.account_name && !accounts.has(plan.account_name)) {
    throw new BillPlanError(
      `账户「${plan.account_name}」不存在。现有账户：${[...accounts].join('、')}；或改用 account_column_values 做映射。`,
    )
  }

  const rows = db
    .prepare("SELECT row_no, cells FROM bill_rows WHERE table_id = ? AND disposition = 'open' ORDER BY row_no")
    .all(table.id) as unknown as { row_no: number; cells: string }[]
  if (rows.length === 0) throw new Error(`账单材料 #${table.id} 的每一行都处理过了，没有待处理行`)

  const parsedRows = rows.map((r) => ({ no: r.row_no, cells: JSON.parse(r.cells) as string[] }))

  // 没给时间列就把整批记到今天，是最难被发现的一种错——直接拒
  if (plan.columns.time === undefined || plan.columns.time === null || resolved.time === null) {
    throw new BillPlanError(
      `必须指定交易时间列（columns.time），否则整批会被记到今天。这份材料的列名是：${table.header.filter((h) => h).join(' | ')}`,
    )
  }

  // 预检：先判"这行要不要办"，要办的行才要求方案覆盖到位（方向/账户/时间）——不静默归类
  const skipReason = new Map<number, string>()
  const unmappedDirection = new Map<string, number>()
  const unmappedAccount = new Map<string, number>()
  const badTime: { no: number; raw: string }[] = []
  for (const r of parsedRows) {
    const ov = (plan.row_overrides ?? []).find((o) => overrideCovers(o, r.no))
    if (ov?.type === 'skip') {
      skipReason.set(r.no, '按方案逐行排除')
      continue
    }
    const hitSkip = (plan.skip_when ?? []).find((c) => {
      if (!c.contains) return false
      const idx = columnIndex(table.header, c.column)
      return idx !== null && norm(cell(r.cells, idx)).includes(norm(c.contains))
    })
    if (hitSkip) {
      skipReason.set(r.no, `不计收支：${hitSkip.column} 含「${hitSkip.contains}」`)
      continue
    }
    const dv = cell(r.cells, resolved.direction)
    if (dv && ov?.type === undefined && mapValue(dv, plan.direction_column_values, DEFAULT_DIRECTION) === 'unmapped') {
      unmappedDirection.set(dv, (unmappedDirection.get(dv) ?? 0) + 1)
    }
    const av = cell(r.cells, resolved.account)
    if (av && ov?.account_name === undefined) {
      const hit = (plan.account_column_values ?? []).find((m) => norm(av).includes(norm(m.contains)))
      const target = hit?.account_name ?? plan.account_name
      if (!target || !accounts.has(target)) unmappedAccount.set(av, (unmappedAccount.get(av) ?? 0) + 1)
    }
    const tv = cell(r.cells, resolved.time)
    if (tv && parseOccurredAt(tv) === null) badTime.push({ no: r.no, raw: tv })
  }

  const problems: string[] = []
  if (unmappedDirection.size) {
    problems.push(
      `收支方向列「${plan.columns.direction}」里有方案没覆盖的取值：` +
        [...unmappedDirection.entries()].slice(0, UNMATCHED_SAMPLES).map(([v, n]) => `「${v}」×${n}`).join('、') +
        '。请补 direction_column_values 映射（含 type=expense/income/transfer），或用 skip_when 排除这些行。',
    )
  }
  if (unmappedAccount.size) {
    problems.push(
      `账户列「${plan.columns.account}」里有对不上账本的取值：` +
        [...unmappedAccount.entries()].slice(0, UNMATCHED_SAMPLES).map(([v, n]) => `「${v}」×${n}`).join('、') +
        `。请补 account_column_values 映射（含 account_name），或整批用 account_name 指定；现有账户：${[...accounts].join('、')}。`,
    )
  }
  if (problems.length) throw new BillPlanError(problems.join('\n'))
  if (badTime.length > 0 && badTime.length >= parsedRows.length / 2) {
    throw new BillPlanError(
      `时间列「${plan.columns.time}」有 ${badTime.length}/${parsedRows.length} 行解析不出来（如第 ${badTime[0].no} 行「${badTime[0].raw}」）——多半是列选错了。`,
    )
  }

  const items: BatchItemInput[] = []
  const dispositions: { no: number; disposition: 'planned' | 'skipped' | 'review'; reason: string | null }[] = []
  const skippedSamples: BillRowSample[] = []
  let skippedCount = 0

  for (const r of parsedRows) {
    const text = rowText(r.cells)
    const ov = (plan.row_overrides ?? []).find((o) => overrideCovers(o, r.no))
    const preSkip = skipReason.get(r.no)
    if (preSkip) {
      skippedCount += 1
      dispositions.push({ no: r.no, disposition: 'skipped', reason: preSkip })
      if (skippedSamples.length < 5) skippedSamples.push({ row: r.no, text, reason: preSkip })
      continue
    }

    const amt = parseAmountCents(cell(r.cells, resolved.amount))
    if (!amt) {
      const rawAmount = cell(r.cells, resolved.amount)
      const reason = rawAmount ? `金额「${rawAmount}」解析不出` : '金额列为空'
      dispositions.push({ no: r.no, disposition: 'review', reason })
      items.push({ row_no: r.no, amount_cents: null, source_text: text, merchant: cell(r.cells, resolved.merchant) || null, review_reason: reason })
      continue
    }

    let txType: BatchItemInput['tx_type']
    if (ov?.type && ov.type !== 'skip') txType = ov.type
    else {
      const mapped = mapValue(cell(r.cells, resolved.direction), plan.direction_column_values, DEFAULT_DIRECTION)
      if (mapped && mapped !== 'unmapped') txType = mapped
      else if (plan.amount_signed) txType = amt.negative ? 'expense' : 'income'
      else txType = plan.default_type ?? 'expense'
    }

    const occurredAt = parseOccurredAt(cell(r.cells, resolved.time))
    const reason = occurredAt ? null : `交易时间「${cell(r.cells, resolved.time)}」解析不出`
    if (!occurredAt) {
      dispositions.push({ no: r.no, disposition: 'review', reason })
      items.push({
        row_no: r.no,
        amount_cents: amt.cents,
        tx_type: txType,
        merchant: cell(r.cells, resolved.merchant) || null,
        occurred_at: null,
        source_text: text,
        review_reason: reason ?? undefined,
      })
      continue
    }

    let accountName: string | null = null
    if (ov?.account_name) accountName = ov.account_name
    else {
      const av = cell(r.cells, resolved.account)
      const hit = av ? (plan.account_column_values ?? []).find((m) => norm(av).includes(norm(m.contains))) : undefined
      accountName = hit?.account_name ?? plan.account_name ?? (av ? av : null)
    }

    let categoryName: string | null = ov?.category_name ?? null
    if (!categoryName) {
      const merchantText = cell(r.cells, resolved.merchant)
      const rule = (plan.categories ?? []).find((c) =>
        c.op === 'equals' ? norm(merchantText) === norm(c.match) : norm(merchantText).includes(norm(c.match)),
      )
      if (rule) categoryName = rule.category_name
    }

    dispositions.push({ no: r.no, disposition: 'planned', reason: null })
    items.push({
      row_no: r.no,
      amount_cents: amt.cents,
      tx_type: txType,
      merchant: cell(r.cells, resolved.merchant) || null,
      occurred_at: occurredAt,
      category_name: categoryName,
      reliable_id: cell(r.cells, resolved.id) || null,
      account_name: accountName,
      source_text: text,
    })
  }

  const newish = items.filter((i) => !i.review_reason)
  const reviewCount = items.length - newish.length
  const rowsConsidered = parsedRows.length

  let out: BillApplyResult | null = null
  const run = db.transaction((): void => {
    let gateId: number | null = null
    let plan_: BatchPlan | null = null
    let newCount = 0
    let duplicateCount = 0
    if (items.length > 0) {
      const prep = prepareBatch(db, {
        items,
        channel: plan.channel ?? table.channel,
        sourceType: table.sourceType,
        sessionId: ctx.sessionId,
        billTableId: table.id,
        rowsConsidered,
        skippedCount,
      })
      gateId = prep.gateId
      plan_ = prep.plan
      newCount = prep.plan.newCount
      duplicateCount = prep.plan.duplicateCount
      const gate = gateId
      const upd = db.prepare("UPDATE bill_rows SET disposition = ?, gate_id = ?, reason = ? WHERE table_id = ? AND row_no = ?")
      for (const it of prep.plan.items) {
        if (it.rowNo === null || it.rowNo === undefined) continue
        const d = dispositions.find((x) => x.no === it.rowNo)
        const disposition = it.status === 'unparsed' ? 'review' : 'planned'
        upd.run(disposition, gate, d?.reason ?? null, table.id, it.rowNo)
      }
    }
    const skipUpd = db.prepare("UPDATE bill_rows SET disposition = 'skipped', reason = ? WHERE table_id = ? AND row_no = ?")
    for (const d of dispositions) {
      if (d.disposition === 'skipped') skipUpd.run(d.reason, table.id, d.no)
    }

    // 硬对账：一行都不能凭空消失，也不能一行算两次
    const accounted = newCount + duplicateCount + reviewCount + skippedCount
    if (accounted !== rowsConsidered) {
      throw new Error(`内部对账不平：材料 ${rowsConsidered} 行，但各项相加 ${accounted} 行（入账 ${newCount} + 重复 ${duplicateCount} + 待核对 ${reviewCount} + 不计 ${skippedCount}）`)
    }
    const after = getBillTable(db, table.id)
    if (items.length > 0 && after && after.openRows !== 0) {
      throw new Error(`内部对账不平：处理后材料 #${table.id} 仍有 ${after.openRows} 行未被任何归宿覆盖`)
    }
    out = {
      tableId: table.id,
      gateId,
      plan: plan_,
      rowsConsidered,
      newCount,
      duplicateCount,
      reviewCount,
      skippedCount,
      reviewSamples: (plan_?.items ?? [])
        .filter((i) => i.status === 'unparsed')
        .slice(0, 20)
        .map((i) => ({ row: i.rowNo ?? 0, text: i.sourceText ?? '', reason: i.reason ?? '待核对' })),
      skippedSamples,
    }
  })
  run()
  if (!out) throw new Error('套表没有产出结果（不应发生）')
  return out
}
