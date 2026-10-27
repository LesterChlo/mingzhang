import { createHash } from 'node:crypto'
import type { Database } from 'better-sqlite3-multiple-ciphers'
import { nowIso } from '../db/time'
import { buildCard } from './cards'
import { createPending, findOpenByTxAndField, getPending } from './pending'
import { getTransaction, restore, snapshot, softDelete, writeAudit } from './ledger'
import type {
  TransactionActionsDTO,
  TransactionSplitItemDTO,
  TransactionSplitItemInput,
  TransactionSplitPlanDTO,
  TransactionSplitResultDTO,
} from '../../shared/types'

type TxRow = Record<string, unknown> & {
  id: number
  account_id: number
  category_id: number | null
  amount_cents: number
  type: string
  to_account_id: number | null
  occurred_at: string
  state: string
  confidence_score: number | null
  merchant: string | null
  note: string | null
  source_message_id: string | null
}

type SplitPayload = {
  sourceVersion: string
  items: TransactionSplitItemDTO[]
  original: TransactionSplitPlanDTO['original']
  totalCents: number
  execution?: {
    originalId: number
    childIds: number[]
    fingerprints: Record<string, string>
    undone: boolean
    undoVersion: string
  }
}

type SplitLink = { gateId: number; originalId: number; childIds: number[]; role: 'original' | 'child'; state: 'active' | 'undone' }

type ExclusionMetadata = {
  originalType: 'expense' | 'income'
  originalCategoryId: number
  expectedVersion?: string | null
}

const MAX_CENTS = Number.MAX_SAFE_INTEGER
const SPLIT_LINK_PREFIX = 'transaction.split-link:'
const EXCLUSION_PREFIX = 'transaction.exclude:'

function hash(value: unknown): string {
  return `v1-${createHash('sha256').update(JSON.stringify(value)).digest('hex')}`
}

function row(db: Database, txId: number): TxRow | null {
  return (db.prepare('SELECT * FROM transactions WHERE id=?').get(txId) as TxRow | undefined) ?? null
}

function setting(db: Database, key: string): { present: boolean; value: string | null } {
  const found = db.prepare('SELECT value FROM settings WHERE key=?').get(key) as { value: string } | undefined
  return found ? { present: true, value: found.value } : { present: false, value: null }
}

function writeSetting(db: Database, key: string, value: string): void {
  db.prepare('INSERT INTO settings(key,value,updated_at) VALUES(?,?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_at=excluded.updated_at')
    .run(key, value, nowIso())
}

function removeSetting(db: Database, key: string): void {
  db.prepare('DELETE FROM settings WHERE key=?').run(key)
}

function atomic<T>(db: Database, action: () => T): T {
  let result!: T
  db.transaction(() => { result = action() })()
  return result
}

function readLink(db: Database, txId: number): SplitLink | null {
  const found = setting(db, `${SPLIT_LINK_PREFIX}${txId}`)
  if (!found.present) return null
  try {
    const link = JSON.parse(found.value ?? '') as SplitLink
    if (!Number.isSafeInteger(link.gateId) || !Number.isSafeInteger(link.originalId) || !Array.isArray(link.childIds) || !['original', 'child'].includes(link.role) || !['active', 'undone'].includes(link.state)) throw new Error('bad split link')
    return link
  } catch {
    throw new Error(`交易 #${txId} 的拆账关联损坏，已停止操作以避免重复计账`)
  }
}

function exclusionMetadata(db: Database, txId: number): { present: boolean; raw: string | null; value: ExclusionMetadata | null } {
  const found = setting(db, `${EXCLUSION_PREFIX}${txId}`)
  if (!found.present) return { present: false, raw: null, value: null }
  try {
    const value = JSON.parse(found.value ?? '') as ExclusionMetadata
    if (!['expense', 'income'].includes(value.originalType) || !Number.isSafeInteger(value.originalCategoryId) || value.originalCategoryId <= 0) throw new Error('bad exclusion metadata')
    return { present: true, raw: found.value, value }
  } catch {
    return { present: true, raw: found.value, value: null }
  }
}

function metadataForVersion(meta: ReturnType<typeof exclusionMetadata>): unknown {
  if (!meta.present) return null
  if (!meta.value) return { corrupt: meta.raw }
  const stable = { ...meta.value }
  delete stable.expectedVersion
  return stable
}

function latestAudit(db: Database, entityType: 'transaction' | 'category' | 'account' | 'import', entityId: number): Record<string, unknown> | null {
  return (db.prepare('SELECT * FROM audit_log WHERE entity_type=? AND entity_id=? ORDER BY id DESC LIMIT 1').get(entityType, entityId) as Record<string, unknown> | undefined) ?? null
}

function referenceRows(db: Database, tx: TxRow, extraCategoryIds: number[] = []): Record<string, unknown> {
  const accountRow = db.prepare('SELECT * FROM accounts WHERE id=?').get(tx.account_id) as Record<string, unknown> | undefined
  const toAccountRow = tx.to_account_id == null ? undefined : db.prepare('SELECT * FROM accounts WHERE id=?').get(tx.to_account_id) as Record<string, unknown> | undefined
  const categoryIds = [...new Set([tx.category_id, ...extraCategoryIds].filter((id): id is number => id !== null && Number.isSafeInteger(id) && id > 0))].sort((a, b) => a - b)
  const categories = categoryIds.map((id) => ({
    row: db.prepare('SELECT * FROM categories WHERE id=?').get(id) ?? null,
    audit: latestAudit(db, 'category', id),
  }))
  return {
    account: accountRow ? { row: accountRow, audit: latestAudit(db, 'account', tx.account_id) } : null,
    toAccount: toAccountRow && tx.to_account_id != null ? { row: toAccountRow, audit: latestAudit(db, 'account', tx.to_account_id) } : null,
    categories,
  }
}

function legacyAttachmentSources(db: Database, sourceMessageId: string | null): { row: Record<string, unknown>; audit: Record<string, unknown> | null }[] {
  if (!sourceMessageId) return []
  const rows = db.prepare('SELECT * FROM imports WHERE source_message_id=? ORDER BY id').all(sourceMessageId) as Record<string, unknown>[]
  return rows.map((item) => ({ row: item, audit: latestAudit(db, 'import', Number(item.id)) }))
}

/** A stable source token includes the full transaction row, latest audit, references, and attachment override. */
function sourceVersion(db: Database, txId: number, extraCategoryIds: number[] = []): string {
  const tx = row(db, txId)
  if (!tx) throw new Error(`交易 #${txId} 不存在`)
  return hash({
    tx,
    audit: latestAudit(db, 'transaction', txId),
    references: referenceRows(db, tx, extraCategoryIds),
    legacyAttachmentSources: legacyAttachmentSources(db, tx.source_message_id),
    attachmentOverride: setting(db, `tx.attachments:${txId}`),
    exclusion: metadataForVersion(exclusionMetadata(db, txId)),
  })
}

function getCategory(db: Database, categoryId: number): { id: number; name: string; kind: string } | null {
  return (db.prepare('SELECT id,name,kind FROM categories WHERE id=?').get(categoryId) as { id: number; name: string; kind: string } | undefined) ?? null
}

function resolveItems(db: Database, tx: TxRow, inputs: TransactionSplitItemInput[]): TransactionSplitItemDTO[] {
  if (!Array.isArray(inputs) || inputs.length < 2 || inputs.length > 50) throw new Error('拆账必须包含2至50项')
  if (tx.type !== 'expense' && tx.type !== 'income') throw new Error('仅支出或收入可以拆账')
  const originalCategory = tx.category_id == null ? null : getCategory(db, tx.category_id)
  if (!originalCategory || originalCategory.kind !== tx.type) throw new Error('原交易分类缺失或方向不匹配，不能拆账')
  let sum = 0
  const items = inputs.map((item) => {
    if (!item || !Number.isSafeInteger(item.amountCents) || item.amountCents <= 0) throw new Error('每个拆账金额必须是正的安全整数分')
    sum += item.amountCents
    if (!Number.isSafeInteger(sum) || sum > MAX_CENTS) throw new Error('拆账金额合计超出安全整数范围')
    const categoryId = item.categoryId === undefined ? originalCategory.id : item.categoryId
    if (!Number.isSafeInteger(categoryId) || categoryId <= 0) throw new Error('拆账分类无效')
    const category = getCategory(db, categoryId)
    if (!category || category.kind !== tx.type) throw new Error('拆账分类不存在或方向不匹配')
    if (item.merchant !== undefined && item.merchant !== null && typeof item.merchant !== 'string') throw new Error('拆账商户无效')
    if (item.note !== undefined && item.note !== null && typeof item.note !== 'string') throw new Error('拆账备注无效')
    return {
      amountCents: item.amountCents,
      categoryId,
      categoryName: category.name,
      merchant: item.merchant === undefined ? tx.merchant : item.merchant,
      note: item.note === undefined ? tx.note : item.note,
    }
  })
  if (sum !== tx.amount_cents) throw new Error(`拆账子项合计 ${sum} 分必须等于原交易 ${tx.amount_cents} 分`)
  return items
}

function makePlanVersion(gateId: number, payload: string, revision: number): string {
  return hash({ kind: 'split-plan', gateId, payload, revision })
}

function decodePayload(json: string): SplitPayload {
  const p = JSON.parse(json) as SplitPayload
  if (!p || typeof p.sourceVersion !== 'string' || !Array.isArray(p.items) || !p.original || !Number.isSafeInteger(p.totalCents)) throw new Error('拆账方案数据损坏')
  return p
}

function planFromGate(gateId: number, payloadJson: string, revision: number): TransactionSplitPlanDTO {
  const payload = decodePayload(payloadJson)
  return {
    gateId,
    version: makePlanVersion(gateId, payloadJson, revision),
    original: payload.original,
    items: payload.items,
    totalCents: payload.totalCents,
  }
}

function undoVersion(gateId: number, payload: SplitPayload, revision: number): string {
  const { execution, ...base } = payload
  if (!execution) throw new Error('拆账执行关联缺失')
  const { undoVersion: _token, ...unsignedExecution } = execution
  return hash({ kind: 'split-undo', gateId, revision, payload: { ...base, execution: unsignedExecution } })
}

function canUndoGroup(db: Database, payload: SplitPayload): { canUndo: boolean; reason: string | null } {
  const execution = payload.execution
  if (!execution) return { canUndo: false, reason: '拆账尚未执行' }
  if (execution.undone) return { canUndo: false, reason: '拆账已经撤销' }
  const expectedIds = [execution.originalId, ...execution.childIds]
  for (const id of expectedIds) {
    if (!execution.fingerprints[String(id)] || sourceVersion(db, id) !== execution.fingerprints[String(id)]) {
      return { canUndo: false, reason: '关联交易、审计或来源附件已变化，不能覆盖后续操作' }
    }
  }
  const original = row(db, execution.originalId)
  if (!original || original.state !== 'deleted') return { canUndo: false, reason: '原交易状态已变化' }
  for (const id of execution.childIds) {
    const child = row(db, id)
    if (!child || child.state !== 'confirmed') return { canUndo: false, reason: `子项 #${id} 状态已变化` }
  }
  return { canUndo: true, reason: null }
}

function currentUndo(db: Database, txId: number): TransactionActionsDTO['undoSplit'] {
  const link = readLink(db, txId)
  if (!link) return null
  const gate = getPending(db, link.gateId)
  if (!gate || gate.field !== 'split_confirm') return { gateId: link.gateId, version: '', originalId: link.originalId, canUndo: false, reason: '拆账关联门缺失或损坏' }
  try {
    const payload = decodePayload(gate.payload)
    if (!payload.execution) return null
    const check = canUndoGroup(db, payload)
    return {
      gateId: gate.id,
      version: undoVersion(gate.id, payload, gate.revision),
      originalId: link.originalId,
      canUndo: check.canUndo,
      reason: check.reason,
    }
  } catch {
    return { gateId: gate.id, version: '', originalId: link.originalId, canUndo: false, reason: '拆账关联数据损坏，已停止撤销' }
  }
}

export function getTransactionActions(db: Database, txId: number): TransactionActionsDTO | null {
  if (!Number.isSafeInteger(txId) || txId <= 0) return null
  const tx = row(db, txId)
  if (!tx) return null
  const meta = exclusionMetadata(db, txId)
  const excluded = Boolean(meta.value && tx.type === 'adjustment' && tx.state === 'confirmed')
  const link = readLink(db, txId)
  const openGate = findOpenByTxAndField(db, txId, 'split_confirm')
  const category = tx.category_id == null ? null : getCategory(db, tx.category_id)
  const version = sourceVersion(db, txId)
  const basicEligible = tx.state === 'confirmed' && (tx.type === 'expense' || tx.type === 'income') && category?.kind === tx.type && tx.amount_cents > 0 && Number.isSafeInteger(tx.amount_cents)
  const metadataValid = !meta.present || meta.value !== null
  const metadataVersionMatches = Boolean(meta.value?.expectedVersion && meta.value.expectedVersion === version)
  const adjustmentRestorable = tx.type === 'adjustment' && excluded && meta.value !== null && metadataVersionMatches && tx.category_id === meta.value.originalCategoryId && category?.kind === meta.value.originalType
  const canSplit = basicEligible && !meta.present && !link && !openGate
  const canExclude = metadataValid && tx.state === 'confirmed' && !link && !openGate && ((!meta.present && basicEligible) || adjustmentRestorable)
  let reason: string | null = null
  if (meta.present && !meta.value) reason = '不计收支来源记录损坏，已停止操作'
  else if (meta.present && tx.type !== 'adjustment') reason = '不计收支来源状态不一致，已停止操作'
  else if (link) reason = '该交易属于已拆账组，不能再次拆分或单独调整'
  else if (openGate) reason = '已有待确认拆账方案，请先处理该方案'
  else if (meta.value && !metadataVersionMatches) reason = '标记后交易或来源已变化，拒绝覆盖后续修改'
  else if (!basicEligible && !canExclude) reason = tx.state !== 'confirmed' ? '仅已确认交易可执行此操作' : '仅方向有效且分类匹配的支出或收入可拆分'
  const openGateId = openGate?.id ?? null
  return {
    txId,
    version,
    txType: tx.type as TransactionActionsDTO['txType'],
    state: tx.state,
    amountCents: tx.amount_cents,
    canSplit: Boolean(canSplit),
    canExclude: Boolean(canExclude && !(meta.present && !meta.value)),
    excluded,
    openSplitGateId: openGateId,
    undoSplit: currentUndo(db, txId),
    reason,
  }
}

export function prepareTransactionSplit(
  db: Database,
  input: { txId: number; expectedVersion: string; items: TransactionSplitItemInput[] },
  opts: { via: 'panel' | 'chat'; sessionId?: string },
): TransactionSplitPlanDTO {
  if (!input || !Number.isSafeInteger(input.txId) || input.txId <= 0 || typeof input.expectedVersion !== 'string' || !input.expectedVersion) throw new Error('拆账参数或交易版本无效')
  if (!opts || !['panel', 'chat'].includes(opts.via)) throw new Error('拆账来源无效')
  const tx = row(db, input.txId)
  if (!tx) throw new Error(`交易 #${input.txId} 不存在`)
  const actions = getTransactionActions(db, input.txId)
  if (!actions || actions.version !== input.expectedVersion) throw new Error('交易已变化，请重新读取后再准备拆账')
  const items = resolveItems(db, tx, input.items)
  const source = sourceVersion(db, tx.id, items.map((item) => item.categoryId))
  const existing = findOpenByTxAndField(db, tx.id, 'split_confirm')
  if (existing) {
    const saved = decodePayload(existing.payload)
    if (saved.sourceVersion === source && JSON.stringify(saved.items) === JSON.stringify(items)) return planFromGate(existing.id, existing.payload, existing.revision)
    throw new Error('已有另一拆账方案待确认，请先取消旧方案')
  }
  if (!actions.canSplit) throw new Error(actions.reason ?? '当前交易不能拆账')
  const original = buildCard(db, getTransaction(db, tx.id)!).tx
  const payload: SplitPayload = { sourceVersion: source, items, original, totalCents: tx.amount_cents }
  const gateId = createPending(db, {
    txId: tx.id,
    sessionId: opts.sessionId ?? 'transaction-actions',
    field: 'split_confirm',
    question: '拆账方案等待用户在界面确认',
    payload: payload as unknown as Record<string, unknown>,
  })
  const gate = getPending(db, gateId)!
  return planFromGate(gateId, gate.payload, gate.revision)
}

export function getTransactionSplitPlan(db: Database, gateId: number): TransactionSplitPlanDTO | null {
  if (!Number.isSafeInteger(gateId) || gateId <= 0) return null
  const gate = getPending(db, gateId)
  if (!gate || gate.field !== 'split_confirm' || gate.status !== 'open') return null
  try {
    return planFromGate(gate.id, gate.payload, gate.revision)
  } catch {
    return null
  }
}

function assertPanel(via: 'panel' | 'chat'): void {
  if (via !== 'panel') throw new Error('此操作只能由用户在界面按钮执行')
}

function setLink(db: Database, txId: number, link: SplitLink): void {
  writeSetting(db, `${SPLIT_LINK_PREFIX}${txId}`, JSON.stringify(link))
}

export function executeTransactionSplit(
  db: Database,
  input: { gateId: number; expectedVersion: string },
  opts: { via: 'panel' | 'chat' },
): TransactionSplitResultDTO {
  assertPanel(opts?.via)
  if (!input || !Number.isSafeInteger(input.gateId) || input.gateId <= 0 || typeof input.expectedVersion !== 'string' || !input.expectedVersion) throw new Error('拆账确认参数无效')
  const gate = getPending(db, input.gateId)
  if (!gate || gate.field !== 'split_confirm' || gate.status !== 'open') throw new Error('拆账确认门不存在或已关闭')
  const plan = planFromGate(gate.id, gate.payload, gate.revision)
  if (plan.version !== input.expectedVersion) throw new Error('拆账预览版本已变化，请刷新后重新确认')
  const payload = decodePayload(gate.payload)
  const tx = row(db, gate.tx_id ?? -1)
  if (!tx || tx.id !== plan.original.id || tx.state !== 'confirmed' || (tx.type !== 'expense' && tx.type !== 'income')) throw new Error('原交易已变化，拆账方案失效')
  const resolved = resolveItems(db, tx, payload.items.map((item) => ({ amountCents: item.amountCents, categoryId: item.categoryId, merchant: item.merchant, note: item.note })))
  if (JSON.stringify(resolved) !== JSON.stringify(payload.items) || sourceVersion(db, tx.id, resolved.map((item) => item.categoryId)) !== payload.sourceVersion) throw new Error('原交易、分类、账户或附件来源已变化，请重新准备拆账')
  const expectedRevision = gate.revision
  const result = atomic(db, (): TransactionSplitResultDTO => {
    const current = getPending(db, gate.id)
    if (!current || current.status !== 'open' || current.field !== 'split_confirm' || current.revision !== expectedRevision || current.payload !== gate.payload) throw new Error('拆账确认门已变化，请刷新后重试')
    const beforeTx = row(db, tx.id)
    if (!beforeTx || sourceVersion(db, tx.id, resolved.map((item) => item.categoryId)) !== payload.sourceVersion) throw new Error('原交易来源已变化，请重新准备拆账')
    softDelete(db, tx.id, { sourceMessageId: tx.source_message_id, reasoning: '用户在界面确认拆账，原笔由子项替代' })
    const childIds: number[] = []
    const attachment = setting(db, `tx.attachments:${tx.id}`)
    for (const item of resolved) {
      const ts = nowIso()
      const inserted = db.prepare(
        'INSERT INTO transactions(account_id,category_id,amount_cents,type,to_account_id,occurred_at,state,confidence_score,merchant,note,source_message_id,created_at,updated_at) VALUES(?,?,?,?,?,?,\'confirmed\',NULL,?,?,?,?,?)',
      ).run(tx.account_id, item.categoryId, item.amountCents, tx.type, tx.to_account_id, tx.occurred_at, item.merchant, item.note, tx.source_message_id, ts, ts)
      const childId = Number(inserted.lastInsertRowid)
      childIds.push(childId)
      writeAudit(db, {
        entity_type: 'transaction', entity_id: childId, changed_by: 'user', change_type: 'create',
        after_value: snapshot(db, childId), source_message_id: tx.source_message_id,
        reasoning: '用户确认拆账子项',
      })
      if (attachment.present) writeSetting(db, `tx.attachments:${childId}`, attachment.value ?? '')
    }
    for (const id of [tx.id, ...childIds]) setLink(db, id, {
      gateId: gate.id, originalId: tx.id, childIds, role: id === tx.id ? 'original' : 'child', state: 'active',
    })
    const fingerprints = Object.fromEntries([tx.id, ...childIds].map((id) => [String(id), sourceVersion(db, id)]))
    const execution: NonNullable<SplitPayload['execution']> = { originalId: tx.id, childIds, fingerprints, undone: false, undoVersion: '' }
    const nextPayload: SplitPayload = { ...payload, execution }
    const nextRevision = current.revision + 1
    execution.undoVersion = undoVersion(gate.id, nextPayload, nextRevision)
    const payloadJson = JSON.stringify(nextPayload)
    const updated = db.prepare("UPDATE pending_clarifications SET status='resolved',payload=?,revision=?,updated_at=? WHERE id=? AND status='open' AND revision=?")
      .run(payloadJson, nextRevision, nowIso(), gate.id, current.revision)
    if (updated.changes !== 1) throw new Error('拆账确认门已变化，请刷新后重试')
    return { gateId: gate.id, originalId: tx.id, childIds, version: execution.undoVersion }
  })
  return result
}

export function undoTransactionSplit(
  db: Database,
  input: { gateId: number; expectedVersion: string },
  opts: { via: 'panel' | 'chat' },
): TransactionActionsDTO {
  assertPanel(opts?.via)
  if (!input || !Number.isSafeInteger(input.gateId) || input.gateId <= 0 || typeof input.expectedVersion !== 'string' || !input.expectedVersion) throw new Error('撤销拆账参数无效')
  const gate = getPending(db, input.gateId)
  if (!gate || gate.field !== 'split_confirm' || gate.status !== 'resolved') throw new Error('拆账已撤销、未执行或确认门不存在')
  const payload = decodePayload(gate.payload)
  if (!payload.execution || payload.execution.undone) throw new Error('拆账已经撤销或执行关联损坏')
  if (undoVersion(gate.id, payload, gate.revision) !== input.expectedVersion) throw new Error('撤销版本已变化，请刷新后重试')
  const possible = canUndoGroup(db, payload)
  if (!possible.canUndo) throw new Error(possible.reason ?? '拆账组已变化，不能撤销')
  const result = atomic(db, (): TransactionActionsDTO => {
    const current = getPending(db, gate.id)
    if (!current || current.revision !== gate.revision || current.payload !== gate.payload || current.status !== 'resolved') throw new Error('拆账关联已变化，请刷新后重试')
    const freshPayload = decodePayload(current.payload)
    const check = canUndoGroup(db, freshPayload)
    if (!check.canUndo) throw new Error(check.reason ?? '拆账组已变化，不能撤销')
    const execution = freshPayload.execution!
    const originalLink = readLink(db, execution.originalId)
    if (!originalLink || originalLink.gateId !== gate.id) throw new Error('原交易拆账关联损坏')
    setLink(db, execution.originalId, { ...originalLink, state: 'undone' })
    restore(db, execution.originalId, { sourceMessageId: row(db, execution.originalId)?.source_message_id as string | null, reasoning: '用户撤销拆账，恢复原交易' })
    for (const id of execution.childIds) {
      const link = readLink(db, id)
      if (!link || link.gateId !== gate.id || link.role !== 'child') throw new Error(`子项 #${id} 拆账关联损坏`)
      softDelete(db, id, { sourceMessageId: row(db, id)?.source_message_id as string | null, reasoning: '用户撤销拆账，作废子项' })
      setLink(db, id, { ...link, state: 'undone' })
    }
    execution.undone = true
    const revision = current.revision + 1
    execution.undoVersion = undoVersion(gate.id, freshPayload, revision)
    const updated = db.prepare('UPDATE pending_clarifications SET payload=?,revision=?,updated_at=? WHERE id=? AND status=\'resolved\' AND revision=?')
      .run(JSON.stringify(freshPayload), revision, nowIso(), gate.id, current.revision)
    if (updated.changes !== 1) throw new Error('拆账关联已变化，请刷新后重试')
    const result = getTransactionActions(db, execution.originalId)
    if (!result) throw new Error('原交易恢复后不可读')
    return result
  })
  return result
}

export function setTransactionExcluded(
  db: Database,
  input: { txId: number; expectedVersion: string; excluded: boolean },
  opts: { via: 'panel' | 'chat' },
): TransactionActionsDTO {
  assertPanel(opts?.via)
  if (!input || !Number.isSafeInteger(input.txId) || input.txId <= 0 || typeof input.expectedVersion !== 'string' || !input.expectedVersion || typeof input.excluded !== 'boolean') throw new Error('不计收支参数无效')
  const tx = row(db, input.txId)
  const actions = getTransactionActions(db, input.txId)
  if (!tx || !actions) throw new Error(`交易 #${input.txId} 不存在`)
  if (actions.version !== input.expectedVersion) throw new Error('交易版本已变化，请刷新后重试')
  const meta = exclusionMetadata(db, input.txId)
  if (meta.present && !meta.value) throw new Error('不计收支来源记录损坏，已停止操作')
  const currentlyExcluded = Boolean(meta.value && tx.type === 'adjustment' && tx.state === 'confirmed')
  if (currentlyExcluded === input.excluded && actions.canExclude) return actions
  if (!actions.canExclude) throw new Error(actions.reason ?? '当前交易不能更改收支统计口径')
  if (input.excluded) {
    if ((tx.type !== 'expense' && tx.type !== 'income') || tx.state !== 'confirmed' || tx.category_id === null) throw new Error('仅已确认且分类有效的支出或收入可以设置为不计收支')
    const category = getCategory(db, tx.category_id)
    if (!category || category.kind !== tx.type) throw new Error('交易分类与收支方向不匹配，不能设置为不计收支')
    const result = atomic(db, (): TransactionActionsDTO => {
      if (sourceVersion(db, tx.id) !== input.expectedVersion) throw new Error('交易版本已变化，请刷新后重试')
      const before = snapshot(db, tx.id)
      db.prepare("UPDATE transactions SET type='adjustment',updated_at=? WHERE id=? AND state='confirmed' AND type IN ('expense','income')").run(nowIso(), tx.id)
      writeAudit(db, {
        entity_type: 'transaction', entity_id: tx.id, changed_by: 'user', change_type: 'update',
        before_value: before, after_value: snapshot(db, tx.id), source_message_id: tx.source_message_id,
        reasoning: '用户明确设置为不计收支统计',
      })
      const stored: ExclusionMetadata = { originalType: tx.type as 'expense' | 'income', originalCategoryId: tx.category_id!, expectedVersion: null }
      writeSetting(db, `${EXCLUSION_PREFIX}${tx.id}`, JSON.stringify(stored))
      stored.expectedVersion = sourceVersion(db, tx.id)
      writeSetting(db, `${EXCLUSION_PREFIX}${tx.id}`, JSON.stringify(stored))
      return getTransactionActions(db, tx.id)!
    })
    return result
  }
  if (!meta.value || tx.type !== 'adjustment' || tx.state !== 'confirmed') throw new Error('该调整交易没有可恢复的原收支来源记录')
  if (meta.value.expectedVersion !== input.expectedVersion) throw new Error('标记后交易或来源已变化，拒绝覆盖后续修改')
  const category = getCategory(db, meta.value.originalCategoryId)
  if (!category || category.kind !== meta.value.originalType || tx.category_id !== meta.value.originalCategoryId) throw new Error('原分类已变化或方向不匹配，拒绝恢复收支')
  const result = atomic(db, (): TransactionActionsDTO => {
    if (sourceVersion(db, tx.id) !== input.expectedVersion) throw new Error('标记后交易或来源已变化，拒绝覆盖后续修改')
    const before = snapshot(db, tx.id)
    db.prepare('UPDATE transactions SET type=?,updated_at=? WHERE id=? AND state=\'confirmed\' AND type=\'adjustment\'').run(meta.value!.originalType, nowIso(), tx.id)
    writeAudit(db, {
      entity_type: 'transaction', entity_id: tx.id, changed_by: 'user', change_type: 'update',
      before_value: before, after_value: snapshot(db, tx.id), source_message_id: tx.source_message_id,
      reasoning: '用户恢复计入收支统计',
    })
    removeSetting(db, `${EXCLUSION_PREFIX}${tx.id}`)
    return getTransactionActions(db, tx.id)!
  })
  return result
}
