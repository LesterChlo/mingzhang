// 导入异常的只读描述与用户结构化续办。不得从来源文本猜缺值，所有写入在一个同步事务中。
import type { Database } from 'better-sqlite3-multiple-ciphers'
import { createHash } from 'node:crypto'
import type { ExecResult, ImportExceptionDTO, ImportExceptionField, ImportExceptionTxType, ResolveImportExceptionInput, TransactionCardData } from '../../shared/types'
import { getPending, createPending, settleImportForBatch, type PendingRow } from './pending'
import { createTransaction, getTransaction, updateFields, confirm, requestReview, writeAudit, snapshot } from './ledger'
import { buildCard } from './cards'
import { nowIso } from '../db/time'

type Payload = Record<string, unknown>
const text = (v: unknown): string | null => typeof v === 'string' && v.length > 0 ? v : null
const id = (v: unknown): number | null => typeof v === 'number' && Number.isSafeInteger(v) && v > 0 ? v : null
const txType = (v: unknown): ImportExceptionTxType | null => ['expense','income','transfer','adjustment'].includes(v as string) ? v as ImportExceptionTxType : null
const amount = (v: unknown, kind: ImportExceptionTxType | null): number | null => typeof v === 'number' && Number.isSafeInteger(v) && (kind === 'adjustment' ? v !== 0 : v > 0) ? v : null

/** 严格实际日历；本地完整时间与带时区ISO保持原文，不允许 Date 的月/日 rollover。 */
export function validImportOccurredAt(value: unknown): value is string {
  if (typeof value !== 'string') return false
  const m = /^(\d{4})-(\d{2})-(\d{2})(?:[ T](\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,3}))?(Z|[+-]\d{2}:\d{2})?)?$/.exec(value)
  if (!m) return false
  const [y, mo, d, h, mi, s] = [Number(m[1]), Number(m[2]), Number(m[3]), Number(m[4] ?? 0), Number(m[5] ?? 0), Number(m[6] ?? 0)]
  if (y < 1 || mo < 1 || mo > 12 || h > 23 || mi > 59 || s > 59) return false
  const leap = y % 4 === 0 && (y % 100 !== 0 || y % 400 === 0)
  if (d < 1 || d > [31, leap ? 29 : 28, 31,30,31,30,31,31,30,31,30,31][mo - 1]) return false
  if (m[8] && m[8] !== 'Z') {
    const [oh, om] = m[8].slice(1).split(':').map(Number)
    if (oh > 14 || om > 59 || (oh === 14 && om !== 0)) return false
  }
  return true
}

function object(v: unknown): v is Payload { return v !== null && typeof v === 'object' && !Array.isArray(v) && [Object.prototype, null].includes(Object.getPrototypeOf(v)) }
function payloadOf(row: PendingRow): Payload | null {
  try { const p: unknown = JSON.parse(row.payload); return object(p) ? p : null } catch { return null }
}
function account(db: Database, accountId: unknown, name: unknown): number | null {
  if (id(accountId)) return (db.prepare('SELECT id FROM accounts WHERE id=?').get(accountId) as {id:number} | undefined)?.id ?? null
  return text(name) ? (db.prepare('SELECT id FROM accounts WHERE name=?').get(name) as {id:number} | undefined)?.id ?? null : null
}
function valuesOf(db: Database, p: Payload, row?: PendingRow): ImportExceptionDTO['values'] {
  const tx = row?.tx_id ? getTransaction(db, row.tx_id) : null
  const kind = txType(tx?.type ?? p.txType)
  const categoryId = id(tx?.category_id ?? p.categoryId) ?? (text(p.categoryName) && (kind === 'expense' || kind === 'income')
    ? (db.prepare('SELECT id FROM categories WHERE name=? AND kind=?').get(p.categoryName, kind) as {id:number} | undefined)?.id ?? null : null)
  const cat = categoryId ? db.prepare('SELECT kind FROM categories WHERE id=?').get(categoryId) as {kind:string} | undefined : null
  const occurredAt = tx?.occurred_at ?? p.occurredAt
  const accountId = account(db, tx?.account_id ?? p.accountId, p.accountName)
  const toAccountId = kind === 'transfer' ? account(db, tx?.to_account_id ?? p.toAccountId, p.toAccountName) : null
  return {
    amountCents: amount(tx?.amount_cents ?? p.amountCents, kind), txType: kind,
    occurredAt: validImportOccurredAt(occurredAt) ? occurredAt : null,
    accountId,
    toAccountId: toAccountId === accountId ? null : toAccountId,
    categoryId: cat && cat.kind === kind ? categoryId : null,
  }
}
function missing(values: ImportExceptionDTO['values']): ImportExceptionField[] {
  const out: ImportExceptionField[] = []
  for (const key of ['amountCents','txType','occurredAt','accountId'] as const) if (values[key] === null) out.push(key)
  if (values.txType === 'transfer' && (values.toAccountId === null || values.toAccountId === values.accountId)) out.push('toAccountId')
  return out
}

/** 三个例外constructor共用；保留原值、身份和附件，不从正常批次默认值补进例外。 */
export function importExceptionPayload(db: Database, plan: {batchId:string;importId:number;channel:string|null;attachments:string[];billTableId?:number|null}, item: {
  txType?:string|null;amountCents?:number|null;occurredAt?:string|null;accountName?:string|null;toAccountName?:string|null;categoryName?:string|null;dedupKey?:string|null;merchant?:string|null;sourceText?:string|null;rowNo?:number|null;reason?:string;note?:string|null
}): Payload {
  const p: Payload = {exceptionVersion:1, batchId:plan.batchId, importId:plan.importId, channel:plan.channel, tableId:plan.billTableId ?? null,
    rowNo:item.rowNo ?? null, sourceText:item.sourceText ?? null, merchant:item.merchant ?? null,
    amountCents:item.amountCents ?? null, txType:item.txType ?? null, occurredAt:item.occurredAt ?? null,
    accountName:item.accountName ?? null, toAccountName:item.toAccountName ?? null, categoryName:item.categoryName ?? null,
    dedupKey:item.dedupKey ?? null, attachments:plan.attachments, reason:item.reason ?? null, note:item.note ?? null}
  p.missingFields = missing(valuesOf(db, p))
  return p
}

/** 纯SELECT，query_only连接也可读取。版本覆盖原payload、revision、交易及来源/关联身份。 */
export function describeImportException(db: Database, gateId: number): ImportExceptionDTO | null {
  if (!id(gateId)) return null
  const row = getPending(db, gateId)
  if (!row || row.status !== 'open' || !['batch_item','transfer_account'].includes(row.field)) return null
  const p = payloadOf(row)
  if (!p || (p.exceptionVersion !== undefined && p.exceptionVersion !== 1)) return null
  const values = valuesOf(db, p, row)
  const source: ImportExceptionDTO['source'] = {batchId:text(p.batchId),importId:id(p.importId),tableId:id(p.tableId ?? p.billTableId),rowNo:id(p.rowNo),sourceText:text(p.sourceText),merchant:text(p.merchant),accountName:text(p.accountName)}
  const referenced = {
    accounts: db.prepare('SELECT * FROM accounts WHERE id IN (?,?) OR name IN (?,?) ORDER BY id').all(values.accountId, values.toAccountId, text(p.accountName), text(p.toAccountName)),
    categories: db.prepare('SELECT * FROM categories WHERE id=? OR (name=? AND kind=?) ORDER BY id').all(values.categoryId, text(p.categoryName), values.txType),
    tx: row.tx_id ? db.prepare('SELECT * FROM transactions WHERE id=?').get(row.tx_id) ?? null : null,
    linkedPending: row.tx_id ? db.prepare('SELECT * FROM pending_clarifications WHERE tx_id=? AND id<>? ORDER BY id').all(row.tx_id,row.id) : [],
    dedup: text(p.dedupKey) ? db.prepare('SELECT * FROM transactions WHERE dedup_key=? ORDER BY id').all(p.dedupKey) : [],
    import: source.importId ? db.prepare('SELECT * FROM imports WHERE id=?').get(source.importId) ?? null : null,
    table: source.tableId ? db.prepare('SELECT * FROM bill_tables WHERE id=?').get(source.tableId) ?? null : null,
    billRow: source.tableId && source.rowNo ? db.prepare('SELECT * FROM bill_rows WHERE table_id=? AND row_no=?').get(source.tableId, source.rowNo) ?? null : null,
  }
  const version = createHash('sha256').update(JSON.stringify({row,values,source,referenced})).digest('hex')
  return {gateId,version,missingFields:missing(values),values,source,reason:text(p.reason) ?? row.question}
}

function exact(v: unknown, allowed: readonly string[], what: string): asserts v is Payload {
  if (!object(v) || Reflect.ownKeys(v).some(k => typeof k !== 'string' || !allowed.includes(k))) throw new Error(`${what}包含无效或未知字段`)
}
function validateInput(input: ResolveImportExceptionInput): void {
  exact(input, ['gateId','expectedVersion','fields'], '补录参数')
  if (!id(input.gateId) || typeof input.expectedVersion !== 'string' || !input.expectedVersion) throw new Error('待办或版本参数无效，请重新读取')
  exact(input.fields, ['amountCents','txType','occurredAt','accountId','toAccountId','categoryId'], '补录字段')
  for (const [key, value] of Object.entries(input.fields)) {
    if (key === 'txType') { if (!txType(value)) throw new Error('收支方向无效') }
    else if (key === 'occurredAt') { if (!validImportOccurredAt(value)) throw new Error('交易日期无效，必须是实际日期') }
    else if (key === 'amountCents') { if (typeof value !== 'number' || !Number.isSafeInteger(value) || value === 0) throw new Error('金额必须是非零安全整数分') }
    else if (!id(value)) throw new Error('账户或分类必须是现有真实ID')
  }
}

export function resolveImportException(db: Database, input: ResolveImportExceptionInput, opts: {sessionId:string;via:'panel'|'chat'}): {txId:number;card:TransactionCardData;text:string} {
  validateInput(input)
  if (opts?.via !== 'panel' || typeof opts.sessionId !== 'string' || !opts.sessionId) throw new Error('导入异常只能由用户在原待办界面结构化提交，不能通过对话补答')
  let result: {txId:number;card:TransactionCardData;text:string} | null = null
  db.transaction((): void => {
    const d = describeImportException(db, input.gateId)
    if (!d) throw new Error(`待收尾 #${input.gateId} 不存在、已办结或不支持结构化补录`)
    if (d.version !== input.expectedVersion) throw new Error('导入异常版本已过期，请刷新后重新复核')
    const row = getPending(db, input.gateId)!, p = payloadOf(row)!
    for (const [key, value] of Object.entries(input.fields)) {
      const original = d.values[key as keyof typeof d.values]
      if (original !== null && original !== value) throw new Error(`不能覆盖已有有效原值：${key}`)
    }
    const v = {...d.values, ...input.fields}
    if (missing(v).length > 0) throw new Error(`仍缺少必填字段：${missing(v).join('、')}`)
    if (amount(v.amountCents,v.txType) === null) throw new Error('该方向金额必须为有效整数分')
    for (const accountId of [v.accountId, ...(v.txType === 'transfer' ? [v.toAccountId] : [])]) {
      if (!id(accountId) || !db.prepare('SELECT id FROM accounts WHERE id=?').get(accountId)) throw new Error('账户不存在，请选择现有账户')
    }
    if (v.txType !== 'transfer' && input.fields.toAccountId !== undefined) throw new Error('非转账不得填写转入账户')
    if (v.txType === 'transfer' && v.accountId === v.toAccountId) throw new Error('转入和转出账户不能相同')
    if (v.categoryId !== null) {
      const cat = db.prepare('SELECT kind FROM categories WHERE id=?').get(v.categoryId) as {kind:string}|undefined
      if (!cat || cat.kind !== v.txType) throw new Error('分类不存在或与收支方向不匹配')
    }
    const imp = d.source.importId ? db.prepare('SELECT source_message_id FROM imports WHERE id=?').get(d.source.importId) as {source_message_id:string|null}|undefined : null
    if (d.source.importId && !imp) throw new Error('原导入批次不存在')
    if (imp?.source_message_id && d.source.batchId && imp.source_message_id !== d.source.batchId) throw new Error('原导入来源身份不一致')
    const batchId = d.source.batchId ?? imp?.source_message_id ?? null
    if (!batchId) throw new Error('缺少原批次来源，不能另记一笔代替')
    if (d.source.tableId !== null) {
      if (!d.source.rowNo || !db.prepare('SELECT row_no FROM bill_rows WHERE table_id=? AND row_no=?').get(d.source.tableId,d.source.rowNo)) throw new Error('原账单行不存在')
      const owner = db.prepare('SELECT id,payload FROM pending_clarifications WHERE id<>? AND field IN (\'batch_item\',\'transfer_account\')').all(row.id) as {id:number;payload:string}[]
      if (owner.some(o => { try { const q = JSON.parse(o.payload); return (q.tableId ?? q.billTableId) === d.source.tableId && q.rowNo === d.source.rowNo && getPending(db,o.id)?.status === 'resolved' } catch { return false } })) throw new Error('原账单行已补录，不能重复记账')
    }
    const existing = row.tx_id ? getTransaction(db,row.tx_id) : null
    if (row.tx_id && (!existing || existing.state === 'deleted' || existing.state === 'confirmed' || existing.source_message_id !== batchId)) throw new Error('原关联交易不可补录，请刷新检查')
    const dedupKey = text(p.dedupKey)
    const duplicate = dedupKey ? db.prepare('SELECT id FROM transactions WHERE dedup_key=? AND id<>? LIMIT 1').get(dedupKey,row.tx_id ?? -1) : null
    if (duplicate) throw new Error('同来源交易号已入账，拒绝重复补录')
    const reason = `用户在原待收尾面板结构化补录 #${row.id}：${JSON.stringify(input.fields)}`
    const txId = existing?.id ?? createTransaction(db,{amountCents:v.amountCents!,txType:v.txType!,occurredAt:v.occurredAt!,accountId:v.accountId!,toAccountId:v.txType === 'transfer' ? v.toAccountId : null,merchant:d.source.merchant,note:text(p.note) ?? d.source.sourceText,sourceMessageId:batchId,changedBy:'user'})
    updateFields(db,txId,{amount_cents:v.amountCents,account_id:v.accountId,to_account_id:v.txType === 'transfer' ? v.toAccountId : null,occurred_at:v.occurredAt,category_id:v.categoryId},{changedBy:'user',reasoning:reason,sourceMessageId:batchId})
    if (dedupKey) db.prepare('UPDATE transactions SET dedup_key=? WHERE id=?').run(dedupKey,txId)
    const needsCategory = (v.txType === 'expense' || v.txType === 'income') && v.categoryId === null
    let confirmGate: number | undefined
    if (needsCategory) {
      requestReview(db,txId,{reason:'导入异常已补齐，分类未定',sourceMessageId:batchId})
      const linked = db.prepare("SELECT * FROM pending_clarifications WHERE tx_id=? AND field='confirm_record' AND status='open' LIMIT 1").get(txId) as unknown as PendingRow | undefined
      const linkedPayload = {...(linked ? payloadOf(linked) : {}),txId,batchId,importId:d.source.importId,requiresExplicitConfirm:true,importExceptionGateId:row.id,reason:'分类未定'}
      if (linked) {
        db.prepare('UPDATE pending_clarifications SET payload=?,revision=revision+1,updated_at=? WHERE id=?').run(JSON.stringify(linkedPayload),nowIso(),linked.id)
        confirmGate = linked.id
      } else confirmGate = createPending(db,{txId,sessionId:opts.sessionId,field:'confirm_record',question:'原导入行已补齐，仍需选择分类后确认',payload:linkedPayload})
    } else {
      confirm(db,txId,{reasoning:reason,sourceMessageId:batchId})
      // 已有原交易的分类门被这次明确提交一并满足；只关闭同tx的确认门，不触其他行。
      db.prepare("UPDATE pending_clarifications SET status='resolved',revision=revision+1,updated_at=? WHERE tx_id=? AND field='confirm_record' AND status='open'").run(nowIso(),txId)
    }
    writeAudit(db,{entity_type:'transaction',entity_id:txId,changed_by:'user',change_type:'update',after_value:{...snapshot(db,txId),importExceptionGateId:row.id,fields:input.fields,dedupKey,attachments:p.attachments ?? []},source_message_id:batchId,reasoning:reason})
    const closed = db.prepare("UPDATE pending_clarifications SET tx_id=?,status='resolved',revision=revision+1,updated_at=? WHERE id=? AND status='open' AND revision=?").run(txId,nowIso(),row.id,row.revision)
    if (closed.changes !== 1) throw new Error('待办版本已变化，请刷新重试')
    if (d.source.tableId && d.source.rowNo) db.prepare("UPDATE bill_rows SET disposition='planned',reason=NULL WHERE table_id=? AND row_no=?").run(d.source.tableId,d.source.rowNo)
    settleImportForBatch(db,{batchId,importId:d.source.importId,changedBy:'user'})
    result = {txId,card:buildCard(db,getTransaction(db,txId)!,{gateId:confirmGate,reviewReason:needsCategory?'分类未定':null}),text:needsCategory ? `原行已补录 #${txId}（needs_review），还需选择分类后确认，尚未确认入账。` : `原行已补录 #${txId}（confirmed）。`}
  })()
  if (!result) throw new Error('补录未产出结果')
  return result
}

/** 仅处理本模块生成的二级分类确认门；其他历史/普通单笔返回null，保持旧Engine路径。 */
export function confirmImportExceptionRecord(db: Database, txId: number, categoryName?: string): ExecResult | null {
  if (!id(txId)) throw new Error('交易ID无效')
  const candidates = db.prepare("SELECT * FROM pending_clarifications WHERE tx_id=? AND field='confirm_record' AND status='open' ORDER BY id").all(txId) as unknown as PendingRow[]
  const txSource = getTransaction(db, txId)?.source_message_id ?? null
  const hasOriginalException = txSource && (db.prepare("SELECT payload FROM pending_clarifications WHERE field IN ('batch_item','transfer_account')").all() as {payload:string}[]).some(r => {
    try { return JSON.parse(r.payload).batchId === txSource } catch { return false }
  })
  const gate = candidates.find(g => id(payloadOf(g)?.importExceptionGateId) !== null) ?? (hasOriginalException ? candidates[0] : undefined)
  if (!gate) return null
  let result: ExecResult | null = null
  db.transaction((): void => {
    const row = getPending(db, gate.id), p = row ? payloadOf(row) : null
    const tx = getTransaction(db, txId)
    if (!row || row.status !== 'open' || !p || !tx || tx.state === 'deleted' || tx.state === 'confirmed') throw new Error('原行确认状态已变化，请刷新')
    const batchId = text(p.batchId) ?? tx.source_message_id, importId = id(p.importId)
    if (!batchId || tx.source_message_id !== batchId) throw new Error('原行来源身份不一致')
    let categoryId = tx.category_id
    if (tx.type === 'expense' || tx.type === 'income') {
      if (categoryName !== undefined) {
        if (typeof categoryName !== 'string' || !categoryName) throw new Error('请选择已有分类')
        categoryId = (db.prepare('SELECT id FROM categories WHERE name=? AND kind=?').get(categoryName,tx.type) as {id:number}|undefined)?.id ?? null
        if (categoryId === null) throw new Error('分类不存在或方向不匹配')
      }
      if (categoryId === null) throw new Error('还差分类才能入账，请选择已有分类')
      const cat = db.prepare('SELECT kind FROM categories WHERE id=?').get(categoryId) as {kind:string}|undefined
      if (cat?.kind !== tx.type) throw new Error('分类方向不匹配')
    }
    const reason = `用户在原导入行选择分类并确认 #${txId}`
    if (categoryId !== tx.category_id) updateFields(db,txId,{category_id:categoryId},{changedBy:'user',reasoning:reason,sourceMessageId:batchId})
    confirm(db,txId,{reasoning:reason,sourceMessageId:batchId})
    if (db.prepare("UPDATE pending_clarifications SET status='resolved',revision=revision+1,updated_at=? WHERE id=? AND status='open' AND revision=?").run(nowIso(),row.id,row.revision).changes !== 1) throw new Error('原确认待办版本变化')
    settleImportForBatch(db,{batchId,importId,changedBy:'user'})
    result = {status:'ok',message:`已入账 #${txId}`,card:buildCard(db,getTransaction(db,txId)!)}
  })()
  return result
}
