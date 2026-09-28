// 账本页 / 账户屏 / 报告屏 / 阈值 的数据层读模型（从 ipc.ts 抽出的可测函数）。
//
// 为什么单独成文件：ipc.ts 只做「取 db → 调域层 → 返回」，真正的 SQL 口径在这里，
// 于是数据层用例可以不开 Electron 直接打真库（tests/ledger-filters.test.ts 等）。
//
// 三条纪律：
//   ① 金额区间一律按 ABS(t.amount_cents) 比较——库内 expense/income/transfer 恒正
//      （schema CHECK），只有 adjustment 可负；取绝对值后「筛选 10~50 元」对四种类型同义。
//   ② agg 与筛选同口径：month/state 不变的部分照旧，新增的 category/account/金额区间
//      同样进 scope（筛选一变，汇总跟着变）。state 仍**故意**不进 scope（既有契约：
//      汇总卡要能在按状态筛选时仍显示"另有 N 笔待确认"，见 LedgerAgg 注释）。
//   ③ 账户列表不带余额：accounts 表没有期初余额列，算不出真余额就不给字段，宁缺勿编。

import type { Database } from 'better-sqlite3-multiple-ciphers'
import type {
  AccountOption,
  LedgerAgg,
  LedgerFilter,
  LedgerPageDTO,
  LedgerRow,
  ReportCardData,
} from '../../shared/types'
import { getSetting, getThreshold, setSetting } from './ledger'
import { buildReport, reportText } from './reports'

export function emptyLedgerAgg(month: string | null): LedgerAgg {
  return {
    month,
    count: 0,
    expenseCents: 0,
    incomeCents: 0,
    reviewCount: 0,
    reviewExpenseCents: 0,
    byCategory: [],
  }
}

/** 列表口径 JOIN：accounts a 用 INNER（account_id NOT NULL + 外键强制，与改动前逐字一致），
 *  accounts ta 用 LEFT（to_account_id 可空，转账未入账时为空）。新增的 ta 只扩列不增行，无扇出。 */
const JOINS_LIST =
  ' FROM transactions t' +
  ' LEFT JOIN categories c ON c.id = t.category_id' +
  ' JOIN accounts a ON a.id = t.account_id' +
  ' LEFT JOIN accounts ta ON ta.id = t.to_account_id'

/** 📎 列（账本屏规格 §3.2）：来源附件相对文件名，无则 NULL。
 *  为什么用标量子查询而不是 LEFT JOIN imports：一个 source_message_id 可能对应多条 imports，
 *  JOIN 会扇出重复行（同一笔账变成两行）；标量子查询只取最近一条非空 source_ref，行数恒定。
 *  口径与 txDetail 的 attachmentRef 一致——都读 imports.source_ref（attachments/ 内相对名）。 */
const ATTACHMENT_REF_COL =
  ' (SELECT i.source_ref FROM imports i WHERE i.source_message_id = t.source_message_id' +
  ' AND i.source_ref IS NOT NULL ORDER BY i.id DESC LIMIT 1) AS attachmentRef'

/** 聚合口径 JOIN：改动前只 JOIN categories；这里补 a/ta 一律 LEFT —— LEFT 只会补 NULL 列，
 *  不会丢行也不会扇出，所以既有聚合数字逐字不变。 */
const JOINS_AGG =
  ' FROM transactions t' +
  ' LEFT JOIN categories c ON c.id = t.category_id' +
  ' LEFT JOIN accounts a ON a.id = t.account_id' +
  ' LEFT JOIN accounts ta ON ta.id = t.to_account_id'

/** 把新增筛选条件（分类/账户/金额区间）压进 where+args。两处（列表与口径）共用，保证同口径。 */
function pushExtraFilters(
  filter: LedgerFilter,
  where: string[],
  args: unknown[],
): void {
  if (filter.category) {
    where.push('c.name = ?')
    args.push(filter.category)
  }
  if (filter.account) {
    // 转账的对方账户也算：只看本方账户会把「转入 X」的记录整片筛掉
    where.push('(a.name = ? OR ta.name = ?)')
    args.push(filter.account, filter.account)
  }
  if (filter.amountMinCents !== undefined && filter.amountMinCents !== null) {
    where.push('ABS(t.amount_cents) >= ?')
    args.push(filter.amountMinCents)
  }
  if (filter.amountMaxCents !== undefined && filter.amountMaxCents !== null) {
    where.push('ABS(t.amount_cents) <= ?')
    args.push(filter.amountMaxCents)
  }
}

/** 账本页查询：items（分页）+ total（筛选内总笔数）+ agg（筛选口径聚合，与分页无关）。 */
export function queryLedgerPage(db: Database, filter: LedgerFilter): LedgerPageDTO {
  const month = filter.month || null
  if (filter.amountMinCents !== undefined && filter.amountMaxCents !== undefined) {
    const min = Math.abs(Number(filter.amountMinCents))
    const max = Math.abs(Number(filter.amountMaxCents))
    if (min > max) throw new Error('金额区间无效：下限大于上限')
  }

  // ---- 列表口径：month / state / type / q + 新增三项（分页在此之上） ----
  const where: string[] = []
  const args: unknown[] = []
  if (filter.month) {
    where.push('substr(t.occurred_at,1,7) = ?')
    args.push(filter.month)
  }
  if (filter.state) {
    where.push('t.state = ?')
    args.push(filter.state)
  }
  if (filter.type) {
    where.push('t.type = ?')
    args.push(filter.type)
  }
  if (filter.q) {
    // 关键词搜索：商户 / 备注 / 分类名
    where.push('(t.merchant LIKE ? OR t.note LIKE ? OR c.name LIKE ?)')
    const like = `%${filter.q}%`
    args.push(like, like, like)
  }
  pushExtraFilters(filter, where, args)
  const whereSql = where.length ? ` WHERE ${where.join(' AND ')}` : ''

  const total = Number(
    (db.prepare('SELECT COUNT(*) n' + JOINS_LIST + whereSql).get(...args) as { n: number }).n,
  )
  const limit = Math.min(Math.max(filter.limit ?? 200, 1), 500)
  const offset = Math.max(filter.offset ?? 0, 0)
  const rows = db
    .prepare(
      'SELECT t.id, t.amount_cents AS amountCents, t.type, t.state, t.merchant, t.note, c.name AS categoryName,' +
        ' a.name AS accountName, t.occurred_at AS occurredAt,' +
        ATTACHMENT_REF_COL +
        JOINS_LIST +
        whereSql +
        ' ORDER BY t.occurred_at DESC, t.id DESC LIMIT ? OFFSET ?',
    )
    .all(...args, limit, offset) as unknown as LedgerRow[]

  // ---- 口径聚合：与列表同一套筛选（新增三项一起进 scope），但不含 state、不受分页影响 ----
  const scope: string[] = ["t.state <> 'deleted'"]
  const sargs: unknown[] = []
  if (filter.month) {
    scope.push('substr(t.occurred_at,1,7) = ?')
    sargs.push(filter.month)
  }
  if (filter.type) {
    scope.push('t.type = ?')
    sargs.push(filter.type)
  }
  if (filter.q) {
    scope.push('(t.merchant LIKE ? OR t.note LIKE ? OR c.name LIKE ?)')
    const like = `%${filter.q}%`
    sargs.push(like, like, like)
  }
  pushExtraFilters(filter, scope, sargs)
  const scopeSql = ` WHERE ${scope.join(' AND ')}`

  const sums = db
    .prepare(
      'SELECT COUNT(*) count,' +
        " SUM(CASE WHEN t.state='confirmed' AND t.type='expense' THEN t.amount_cents ELSE 0 END) expenseCents," +
        " SUM(CASE WHEN t.state='confirmed' AND t.type='income' THEN t.amount_cents ELSE 0 END) incomeCents," +
        " SUM(CASE WHEN t.state='needs_review' THEN 1 ELSE 0 END) reviewCount," +
        " SUM(CASE WHEN t.state='needs_review' AND t.type='expense' THEN t.amount_cents ELSE 0 END) reviewExpenseCents" +
        JOINS_AGG +
        scopeSql,
    )
    .get(...sargs) as {
    count: number
    expenseCents: number | null
    incomeCents: number | null
    reviewCount: number | null
    reviewExpenseCents: number | null
  }
  const byCategory = db
    .prepare(
      "SELECT COALESCE(c.name,'未分类') category, SUM(t.amount_cents) cents, COUNT(*) count" +
        JOINS_AGG +
        scopeSql +
        " AND t.state='confirmed' AND t.type='expense' GROUP BY category ORDER BY cents DESC",
    )
    .all(...sargs) as unknown as { category: string; cents: number; count: number }[]

  const agg: LedgerAgg = {
    month,
    count: Number(sums.count || 0),
    expenseCents: Number(sums.expenseCents || 0),
    incomeCents: Number(sums.incomeCents || 0),
    reviewCount: Number(sums.reviewCount || 0),
    reviewExpenseCents: Number(sums.reviewExpenseCents || 0),
    byCategory,
  }
  return { items: rows, total, agg }
}

/** 账户列表（账户屏 + 账本屏账户筛选下拉）。
 *  accounts 表实际列：id/name/type/currency/created_at/updated_at —— 没有期初余额列，
 *  余额无法计算，故不返回余额字段（编一个假余额比不给更糟）。 */
export function listAccountOptions(db: Database): AccountOption[] {
  const rows = db
    .prepare('SELECT id, name, type, currency, created_at FROM accounts ORDER BY id')
    .all() as unknown as { id: number; name: string; type: string; currency: string; created_at: string }[]
  return rows.map((r) => ({
    id: Number(r.id),
    name: r.name,
    kind: r.type,
    currency: r.currency,
    createdAt: r.created_at,
  }))
}

/** 'YYYY-MM' → {year, month}；非法格式抛错（不静默回退到"当前月"）。 */
export function parseMonthParam(month: string): { year: number; month: number } {
  const m = /^(\d{4})-(\d{1,2})$/.exec(month.trim())
  if (!m) throw new Error(`月份格式应为 YYYY-MM，收到「${month}」`)
  const mm = Number(m[2])
  if (mm < 1 || mm > 12) throw new Error(`月份超出范围（1-12），收到「${month}」`)
  return { year: Number(m[1]), month: mm }
}

/** 月报查询：传 month = 该月月报；不传 = 上一个自然月（既有行为，收件箱右栏依赖）。
 *  空月的处理刻意分岔：
 *   - 不传 month：空 → null（既有契约，渲染层 `report && <ReportPanel/>` 依赖它）；
 *   - 传 month：  空 → 仍返回 {month, empty:true}，让报告屏能说清"2026-07 没数据"
 *                 而不是把"该月为空"与"通道出错"混成同一个 null。 */
export function reportForMonth(
  db: Database,
  month: string | undefined,
  fallback: { year: number; month: number },
): ReportCardData | null {
  const target = month === undefined || month === null || month === '' ? fallback : parseMonthParam(month)
  const report = buildReport(db, target.year, target.month)
  if (report.empty && (month === undefined || month === null || month === '')) return null
  return { kind: 'report' as const, ...report, text: reportText(report) }
}

/** 置信度直通阈值（settings.confidence_threshold，默认 0.7）。 */
export function readConfidenceThreshold(db: Database): number {
  return getThreshold(db)
}

/** 写阈值：必须是 0~1 的有限数，否则报清楚错，不落盘。 */
export function writeConfidenceThreshold(db: Database, value: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new Error(`置信度阈值必须是 0~1 之间的数字，收到「${String(value)}」`)
  }
  if (value < 0 || value > 1) throw new Error(`置信度阈值必须在 0~1 之间，收到 ${value}`)
  setSetting(db, 'confidence_threshold', String(value), { audit: true })
  return getThreshold(db)
}

/** settings 键名（导出给用例/巡检，避免字符串散落）。 */
export const CONFIDENCE_THRESHOLD_KEY = 'confidence_threshold'

/** 直读 settings 原值（诊断用：能看到用户手改成什么样，不做归一）。 */
export function rawConfidenceThreshold(db: Database): string | null {
  return getSetting(db, CONFIDENCE_THRESHOLD_KEY)
}
