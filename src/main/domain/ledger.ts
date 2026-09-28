// 账务写操作层 —— 所有写操作都必须经这里，因为它负责同步写 audit_log（R3）。
// 移植自 legacy backend/domain/ledger.py：语义逐行对齐，仅改为 TS + better-sqlite3（同步单连接，天然串行）。

import type { Database } from 'better-sqlite3-multiple-ciphers'
import { nowIso } from '../db/time'

export interface TxSnapshot {
  id: number
  account_id: number | null
  category_id: number | null
  amount_cents: number | null
  type: string | null
  to_account_id: number | null
  occurred_at: string | null
  state: string | null
  confidence_score: number | null
  merchant: string | null
  note: string | null
}

export interface WriteAuditInput {
  entity_type: 'transaction' | 'category' | 'account' | 'rule' | 'setting' | 'import'
  entity_id: number
  changed_by: 'user' | 'llm' | 'rule_engine' | 'import'
  change_type: 'create' | 'parse' | 'auto_confirm' | 'request_review' | 'confirm' | 'update' | 'delete' | 'restore'
  before_value?: unknown
  after_value?: unknown
  source_message_id?: string | null
  reasoning?: string | null
  confidence_score?: number | null
}

const AUDIT_FIELDS = [
  'id', 'account_id', 'category_id', 'amount_cents', 'type', 'to_account_id',
  'occurred_at', 'state', 'confidence_score', 'merchant', 'note',
] as const

function json(v: unknown): string | null {
  return v === undefined || v === null ? null : JSON.stringify(v)
}

export function writeAudit(db: Database, input: WriteAuditInput): number {
  const cur = db
    .prepare(
      'INSERT INTO audit_log (entity_type, entity_id, changed_by, change_type, before_value,' +
        ' after_value, source_message_id, reasoning, confidence_score, changed_at)' +
        ' VALUES (?,?,?,?,?,?,?,?,?,?)',
    )
    .run(
      input.entity_type,
      input.entity_id,
      input.changed_by,
      input.change_type,
      json(input.before_value),
      json(input.after_value),
      input.source_message_id ?? null,
      input.reasoning ?? null,
      input.confidence_score ?? null,
      nowIso(),
    )
  return Number(cur.lastInsertRowid)
}

export function snapshot(db: Database, txId: number): TxSnapshot | null {
  const row = db.prepare('SELECT * FROM transactions WHERE id = ?').get(txId) as
    | Record<string, unknown>
    | undefined
  if (!row) return null
  const out = {} as Record<string, unknown>
  for (const f of AUDIT_FIELDS) out[f] = row[f]
  return out as unknown as TxSnapshot
}

export function auditChain(db: Database, txId: number): string[] {
  const rows = db
    .prepare(
      "SELECT change_type FROM audit_log WHERE entity_type='transaction' AND entity_id=? ORDER BY id",
    )
    .all(txId) as { change_type: string }[]
  return rows.map((r) => r.change_type)
}

// ---------------------------------------------------------------- 设置

export function getSetting(db: Database, key: string, fallback: string | null = null): string | null {
  const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key) as
    | { value: string }
    | undefined
  return row ? row.value : fallback
}

export function getThreshold(db: Database): number {
  const raw = getSetting(db, 'confidence_threshold', '0.7')
  const v = Number.parseFloat(raw ?? '')
  return Number.isFinite(v) ? v : 0.7
}

export function setSetting(
  db: Database,
  key: string,
  value: string,
  opts: { audit?: boolean } = {},
): void {
  const before = getSetting(db, key)
  db.prepare(
    'INSERT INTO settings (key, value, updated_at) VALUES (?,?,?)' +
      ' ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at',
  ).run(key, value, nowIso())
  if (opts.audit !== false) {
    // 系统记账键（月报时间戳等）传 audit:false —— 与 legacy set_setting(audit=False) 口径一致
    writeAudit(db, {
      entity_type: 'setting',
      entity_id: 0,
      changed_by: 'user',
      change_type: 'update',
      before_value: { key, value: before },
      after_value: { key, value },
    })
  }
}

// ---------------------------------------------------------------- 账户 / 分类

export interface AccountRow {
  id: number
  name: string
  type: string
}

export function resolveAccountId(db: Database, name?: string | null): number {
  return resolveAccountIdWithMatch(db, name).id
}

/**
 * 账户名解析（带匹配标志，缺陷③）。
 *
 * 老 resolveAccountId 查不到名字就 `ORDER BY id LIMIT 1`——seed 第一条是"现金"，
 * 于是用户说"记在招行卡上"、模型写成"招商银行"，账就悄悄记成现金，用户还看不见。
 * 这里把"**提供了名字但匹配不上**"与"**根本没提供名字**"分开：
 *   - 未提供（name 为空）→ 默认账户，matched=true（这是正常口径，不是失败）；
 *   - 提供了但匹配不上   → 仍给默认账户 id（不打断记账），但 matched=false，
 *     调用点据此在回给用户的消息里点名"账户「X」不存在"，不许静默套第一条。
 * resolveAccountId 保持原签名与行为不变，老调用点不受影响。
 */
export function resolveAccountIdWithMatch(db: Database, name?: string | null): { id: number; matched: boolean } {
  const want = (name ?? '').trim()
  if (want) {
    const row = db.prepare('SELECT id FROM accounts WHERE name = ?').get(want) as { id: number } | undefined
    if (row) return { id: row.id, matched: true }
  }
  const fallback = db.prepare('SELECT id FROM accounts ORDER BY id LIMIT 1').get() as { id: number } | undefined
  if (!fallback) throw new Error('账户表为空，请先执行 seed')
  return { id: fallback.id, matched: !want }
}

export function listAccounts(db: Database): AccountRow[] {
  return db.prepare('SELECT id, name, type FROM accounts ORDER BY id').all() as unknown as AccountRow[]
}

export function getOrCreateCategoryId(
  db: Database,
  name: string,
  kind: 'expense' | 'income',
  opts: { sourceMessageId?: string | null; changedBy?: 'user' | 'llm' | 'rule_engine' } = {},
): number {
  const row = db.prepare('SELECT id FROM categories WHERE name = ? AND kind = ?').get(name, kind) as
    | { id: number }
    | undefined
  if (row) return row.id
  const ts = nowIso()
  const cur = db
    .prepare('INSERT INTO categories (name, kind, parent_id, created_at, updated_at) VALUES (?, ?, NULL, ?, ?)')
    .run(name, kind, ts, ts)
  const catId = Number(cur.lastInsertRowid)
  writeAudit(db, {
    entity_type: 'category',
    entity_id: catId,
    changed_by: opts.changedBy ?? 'user',
    change_type: 'create',
    after_value: { name, kind },
    source_message_id: opts.sourceMessageId ?? null,
    reasoning: '分类不存在，按需新建',
  })
  return catId
}

export function findCategoryId(
  db: Database,
  name: string,
  kind: 'expense' | 'income',
): number | null {
  const row = db.prepare('SELECT id FROM categories WHERE name = ? AND kind = ?').get(name, kind) as
    | { id: number }
    | undefined
  return row ? row.id : null
}

// ---------------------------------------------------------------- 交易生命周期

export interface CreateTxInput {
  amountCents: number
  txType: 'expense' | 'income' | 'transfer' | 'adjustment'
  accountId?: number | null
  toAccountId?: number | null
  occurredAt?: string | null
  merchant?: string | null
  note?: string | null
  sourceMessageId?: string | null
  changedBy?: 'user' | 'llm' | 'import'
}

export function createTransaction(db: Database, input: CreateTxInput): number {
  const ts = nowIso()
  const accountId = input.accountId ?? resolveAccountId(db)
  const cur = db
    .prepare(
      'INSERT INTO transactions (account_id, category_id, amount_cents, type, to_account_id,' +
        " occurred_at, state, confidence_score, merchant, note, source_message_id, created_at, updated_at)" +
        " VALUES (?, NULL, ?, ?, ?, ?, 'raw_input', NULL, ?, ?, ?, ?, ?)",
    )
    .run(
      accountId,
      input.amountCents,
      input.txType,
      input.toAccountId ?? null,
      input.occurredAt ?? ts,
      input.merchant ?? null,
      input.note ?? null,
      input.sourceMessageId ?? null,
      ts,
      ts,
    )
  const txId = Number(cur.lastInsertRowid)
  writeAudit(db, {
    entity_type: 'transaction',
    entity_id: txId,
    changed_by: input.changedBy ?? 'user',
    change_type: 'create',
    after_value: snapshot(db, txId),
    source_message_id: input.sourceMessageId ?? null,
  })
  return txId
}

export interface ParsePatch {
  amountCents?: number | null
  txType?: string | null
  accountId?: number | null
  categoryId?: number | null
  occurredAt?: string | null
  merchant?: string | null
  note?: string | null
  confidenceScore?: number | null
  sourceMessageId?: string | null
  reasoning?: string | null
}

/** raw_input → parsed：写入解析结果（changed_by=llm）。 */
export function recordParse(db: Database, txId: number, patch: ParsePatch): void {
  const before = snapshot(db, txId)
  db.prepare(
    'UPDATE transactions SET amount_cents=COALESCE(?,amount_cents), type=COALESCE(?,type),' +
      ' account_id=COALESCE(?,account_id), category_id=COALESCE(?,category_id),' +
      ' occurred_at=COALESCE(?,occurred_at), merchant=COALESCE(?,merchant),' +
      ' note=COALESCE(?,note), confidence_score=COALESCE(?,confidence_score),' +
      " state='parsed', updated_at=? WHERE id=?",
  ).run(
    patch.amountCents ?? null,
    patch.txType ?? null,
    patch.accountId ?? null,
    patch.categoryId ?? null,
    patch.occurredAt ?? null,
    patch.merchant ?? null,
    patch.note ?? null,
    patch.confidenceScore ?? null,
    nowIso(),
    txId,
  )
  writeAudit(db, {
    entity_type: 'transaction',
    entity_id: txId,
    changed_by: 'llm',
    change_type: 'parse',
    before_value: before,
    after_value: snapshot(db, txId),
    source_message_id: patch.sourceMessageId ?? null,
    reasoning: patch.reasoning ?? null,
    confidence_score: patch.confidenceScore ?? null,
  })
}

function setState(
  db: Database,
  txId: number,
  state: string,
  opts: {
    changedBy: 'user' | 'llm'
    changeType: 'auto_confirm' | 'request_review' | 'confirm' | 'delete' | 'restore'
    reasoning?: string | null
    sourceMessageId?: string | null
    confidenceScore?: number | null
  },
): void {
  const before = snapshot(db, txId)
  db.prepare('UPDATE transactions SET state=?, updated_at=? WHERE id=?').run(state, nowIso(), txId)
  writeAudit(db, {
    entity_type: 'transaction',
    entity_id: txId,
    changed_by: opts.changedBy,
    change_type: opts.changeType,
    before_value: before,
    after_value: snapshot(db, txId),
    source_message_id: opts.sourceMessageId ?? null,
    reasoning: opts.reasoning ?? null,
    confidence_score: opts.confidenceScore ?? null,
  })
}

/** parsed → confirmed（隐式确认，changed_by=llm）。 */
export function autoConfirm(
  db: Database,
  txId: number,
  opts: { confidenceScore?: number | null; sourceMessageId?: string | null; reasoning?: string | null } = {},
): void {
  setState(db, txId, 'confirmed', {
    changedBy: 'llm',
    changeType: 'auto_confirm',
    reasoning: opts.reasoning ?? '置信度达标且无歧义，自动确认（用户不纠正即视为接受）',
    sourceMessageId: opts.sourceMessageId ?? null,
    confidenceScore: opts.confidenceScore ?? null,
  })
}

/** parsed → needs_review：置信度不足或存在歧义，转人工。 */
export function requestReview(
  db: Database,
  txId: number,
  opts: { reason: string; sourceMessageId?: string | null; confidenceScore?: number | null },
): void {
  setState(db, txId, 'needs_review', {
    changedBy: 'llm',
    changeType: 'request_review',
    reasoning: opts.reason,
    sourceMessageId: opts.sourceMessageId ?? null,
    confidenceScore: opts.confidenceScore ?? null,
  })
}

/** needs_review → confirmed（changed_by=user）。UI 确认按钮走这里。
 *  第 6 单 段1 护栏：deleted 必须先恢复才能确认；已 confirmed 幂等不重复写审计（防历史快照把已删账改活）。 */
export function confirm(
  db: Database,
  txId: number,
  opts: { reasoning?: string; sourceMessageId?: string | null } = {},
): void {
  const cur = db.prepare('SELECT state FROM transactions WHERE id=?').get(txId) as { state: string } | undefined
  if (!cur) throw new Error(`交易 #${txId} 不存在`)
  if (cur.state === 'deleted') throw new Error('这笔已删除，请先恢复')
  if (cur.state === 'confirmed') return
  setState(db, txId, 'confirmed', {
    changedBy: 'user',
    changeType: 'confirm',
    reasoning: opts.reasoning ?? '用户在界面上点击确认',
    sourceMessageId: opts.sourceMessageId ?? null,
  })
}

export interface UpdateFieldsOpts {
  changedBy?: 'user' | 'llm'
  changeType?: 'update'
  reasoning?: string | null
  sourceMessageId?: string | null
}

/** 通用字段更新（状态不变），自动记 before/after 审计。字段名必须是白名单列。 */
const UPDATABLE_COLUMNS = new Set(['category_id', 'amount_cents', 'account_id', 'to_account_id', 'occurred_at', 'merchant', 'note'])

export function updateFields(
  db: Database,
  txId: number,
  fields: Record<string, unknown>,
  opts: UpdateFieldsOpts = {},
): void {
  const keys = Object.keys(fields).filter((k) => fields[k] !== undefined)
  if (keys.length === 0) return
  for (const k of keys) {
    if (!UPDATABLE_COLUMNS.has(k)) throw new Error(`不允许更新的字段：${k}`)
  }
  // 第 6 单 段1 护栏：已删除的交易不能就地改字段（须先恢复）——历史快照不得改活已删账
  const cur = db.prepare('SELECT state FROM transactions WHERE id=?').get(txId) as { state: string } | undefined
  if (cur?.state === 'deleted') throw new Error('这笔已删除，请先恢复后再修改')
  const before = snapshot(db, txId)
  const assignments = keys.map((k) => `${k}=?`).join(', ')
  db.prepare(`UPDATE transactions SET ${assignments}, updated_at=? WHERE id=?`).run(
    ...keys.map((k) => fields[k] ?? null),
    nowIso(),
    txId,
  )
  writeAudit(db, {
    entity_type: 'transaction',
    entity_id: txId,
    changed_by: opts.changedBy ?? 'user',
    change_type: opts.changeType ?? 'update',
    before_value: before,
    after_value: snapshot(db, txId),
    source_message_id: opts.sourceMessageId ?? null,
    reasoning: opts.reasoning ?? null,
  })
}

/** deleted 终态软删（changed_by=user）。重复删除幂等不炸。 */
export function softDelete(
  db: Database,
  txId: number,
  opts: { sourceMessageId?: string | null; reasoning?: string } = {},
): void {
  const cur = db.prepare('SELECT state FROM transactions WHERE id=?').get(txId) as { state: string } | undefined
  if (!cur) throw new Error(`交易 #${txId} 不存在`)
  if (cur.state === 'deleted') return // 幂等：已删除不再重复写审计
  setState(db, txId, 'deleted', {
    changedBy: 'user',
    changeType: 'delete',
    reasoning: opts.reasoning ?? '用户删除',
    sourceMessageId: opts.sourceMessageId ?? null,
  })
}

function stateBeforeDelete(db: Database, txId: number): string {
  const row = db
    .prepare(
      "SELECT before_value FROM audit_log WHERE entity_type='transaction' AND entity_id=?" +
        " AND change_type='delete' ORDER BY id DESC LIMIT 1",
    )
    .get(txId) as { before_value: string | null } | undefined
  if (!row?.before_value) return 'confirmed'
  try {
    return (JSON.parse(row.before_value) as { state?: string }).state ?? 'confirmed'
  } catch {
    return 'confirmed'
  }
}

/** deleted → 删除前状态（通常 confirmed），记 restore 审计。仅对 deleted 有效。 */
export function restore(
  db: Database,
  txId: number,
  opts: { sourceMessageId?: string | null; reasoning?: string } = {},
): string {
  const cur = db.prepare('SELECT state FROM transactions WHERE id=?').get(txId) as { state: string } | undefined
  if (!cur) throw new Error(`交易 #${txId} 不存在`)
  if (cur.state !== 'deleted') throw new Error('这笔当前未处于删除状态，无需恢复')
  const target = stateBeforeDelete(db, txId)
  setState(db, txId, target, {
    changedBy: 'user',
    changeType: 'restore',
    reasoning: opts.reasoning ?? '用户恢复删除',
    sourceMessageId: opts.sourceMessageId ?? null,
  })
  return target
}

// ---------------------------------------------------------------- 导入批次

export function createImport(
  db: Database,
  input: {
    sourceType: 'screenshot' | 'text' | 'csv' | 'xlsx'
    status?: 'pending' | 'parsed' | 'confirmed' | 'failed'
    sourceRef?: string | null
    sourceMessageId?: string | null
    changedBy?: 'user' | 'llm' | 'import'
  },
): number {
  const ts = nowIso()
  const cur = db
    .prepare(
      'INSERT INTO imports (source_type, status, source_ref, source_message_id, created_at, updated_at) VALUES (?,?,?,?,?,?)',
    )
    .run(input.sourceType, input.status ?? 'parsed', input.sourceRef ?? null, input.sourceMessageId ?? null, ts, ts)
  const importId = Number(cur.lastInsertRowid)
  writeAudit(db, {
    entity_type: 'import',
    entity_id: importId,
    changed_by: input.changedBy ?? 'import',
    change_type: 'create',
    after_value: { source_type: input.sourceType, status: input.status ?? 'parsed', source_ref: input.sourceRef ?? null },
    source_message_id: input.sourceMessageId ?? null,
  })
  return importId
}

// ---------------------------------------------------------------- 读取（卡片用）

export interface TransactionFull {
  id: number
  amount_cents: number
  type: string
  state: string
  confidence_score: number | null
  merchant: string | null
  note: string | null
  occurred_at: string
  account_id: number
  category_id: number | null
  to_account_id: number | null
  source_message_id: string | null
}

export function getTransaction(db: Database, txId: number): TransactionFull | null {
  return (db.prepare('SELECT * FROM transactions WHERE id = ?').get(txId) as TransactionFull | undefined) ?? null
}

export function updateImportStatus(
  db: Database,
  importId: number,
  status: 'pending' | 'parsed' | 'confirmed' | 'failed',
  opts: { sourceMessageId?: string | null; changedBy?: 'user' | 'llm' | 'import' } = {},
): void {
  const before = db.prepare('SELECT status FROM imports WHERE id=?').get(importId) as { status: string } | undefined
  db.prepare('UPDATE imports SET status=?, updated_at=? WHERE id=?').run(status, nowIso(), importId)
  writeAudit(db, {
    entity_type: 'import',
    entity_id: importId,
    changed_by: opts.changedBy ?? 'import',
    change_type: 'update',
    before_value: { status: before?.status ?? null },
    after_value: { status },
    source_message_id: opts.sourceMessageId ?? null,
  })
}
