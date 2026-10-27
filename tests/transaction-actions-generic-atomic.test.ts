// R1 atomicity regressions: synchronous SQLite, real write layer and real Engine.
import { afterEach, beforeEach, expect, it } from 'vitest'
import { mkdtempSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { openPlainDb, openSchemaDb } from './helpers'
import { seed } from '../src/main/db/seed'
import { confirm, createTransaction, recordParse, requestReview, restore, softDelete, updateFields } from '../src/main/domain/ledger'
import { createLedgerTools } from '../src/main/engine/tools'
import { Engine } from '../src/main/engine/engine'
import { createPending, getPending } from '../src/main/domain/pending'

let db: ReturnType<typeof openPlainDb>
let file: string
beforeEach(() => {
  file = join(mkdtempSync(join(tmpdir(), 'mz-r1-generic-atomic-')), 'synthetic.db')
  db = openSchemaDb(file)
  seed(db)
})
afterEach(() => { if (db?.open) db.close() })
const row = (id: number) => db.prepare('SELECT * FROM transactions WHERE id=?').get(id) as any
const all = () => Object.fromEntries((db.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all() as { name: string }[])
  .map(({ name }) => [name, db.prepare(`SELECT * FROM "${name.replaceAll('"', '""')}" ORDER BY rowid`).all()]))
const sums = () => db.prepare('SELECT type, COUNT(*) count, SUM(amount_cents) cents FROM v_reportable_transactions GROUP BY type ORDER BY type').all()
function ordinary(kind: 'income' | 'expense' = 'income', state: 'confirmed' | 'needs_review' = 'confirmed') {
  const category = (db.prepare('SELECT id FROM categories WHERE kind=? ORDER BY id LIMIT 1').get(kind) as { id: number }).id
  const id = createTransaction(db, { amountCents: kind === 'income' ? 28643 : 17381, txType: kind, accountId: 2, occurredAt: '2043-08-09T01:37:22-03:30', merchant: 'R1事务合成', note: '先前说明', sourceMessageId: 'r1-generic-synthetic' })
  recordParse(db, id, { categoryId: category, confidenceScore: 0.61 })
  if (state === 'confirmed') confirm(db, id)
  else requestReview(db, id, { reason: '合成待确认' })
  return id
}
function failAudit(change: string, entity = 'transaction') {
  db.exec(`CREATE TRIGGER atomic_audit_failure BEFORE INSERT ON audit_log WHEN NEW.entity_type='${entity}' AND NEW.change_type='${change}' BEGIN SELECT RAISE(ABORT,'R1_OWN_${entity}_${change}'); END`)
}
const reopen = () => { db.close(); db = openPlainDb(file) }
const toolRestore = (id: number) => createLedgerTools({ db, getTurnContext: () => ({ sessionId: 'r1-generic-model', sourceMessageId: 'r1-model-followup', hasImage: false, visionUnverified: false, attachments: [] }) })
  .find((tool) => tool.name === 'restore')!.execute('r1-model-restore', { tx_id: id }, undefined, undefined, {} as never)

it('S2 direct updateFields audit abort restores every table and statistics, then exact retry succeeds', () => {
  const id = ordinary(), before = all(), stats = sums()
  failAudit('update')
  const change = () => updateFields(db, id, { amount_cents: 31289, merchant: '合成改后商户', note: null }, { sourceMessageId: 'r1-own-update', reasoning: '合成更正原因' })
  expect(change).toThrow('R1_OWN_transaction_update')
  expect(all()).toEqual(before)
  expect(sums()).toEqual(stats)
  reopen()
  expect(all()).toEqual(before)
  db.exec('DROP TRIGGER atomic_audit_failure')
  change()
  expect(row(id)).toMatchObject({ amount_cents: 31289, merchant: '合成改后商户', note: null, state: 'confirmed' })
  const audit = db.prepare('SELECT * FROM audit_log ORDER BY id DESC LIMIT 1').get() as any
  expect(audit).toMatchObject({ changed_by: 'user', change_type: 'update', source_message_id: 'r1-own-update', reasoning: '合成更正原因' })
  expect(JSON.parse(audit.before_value)).toMatchObject({ amount_cents: 28643, note: '先前说明' })
  expect(JSON.parse(audit.after_value)).toMatchObject({ amount_cents: 31289, note: null })
})

it('S2 direct softDelete audit abort is atomic and same call can be retried after reopen', () => {
  const id = ordinary('expense'), before = all(), stats = sums()
  failAudit('delete')
  expect(() => softDelete(db, id, { sourceMessageId: 'r1-own-delete' })).toThrow('R1_OWN_transaction_delete')
  expect(all()).toEqual(before)
  expect(sums()).toEqual(stats)
  reopen()
  expect(all()).toEqual(before)
  db.exec('DROP TRIGGER atomic_audit_failure')
  softDelete(db, id, { sourceMessageId: 'r1-own-delete' })
  expect(row(id).state).toBe('deleted')
  const deleted = all()
  softDelete(db, id)
  expect(all()).toEqual(deleted)
})

it('S2 direct restore audit abort keeps needs_review deletion recoverable rather than auto-confirming', () => {
  const id = ordinary('income', 'needs_review')
  softDelete(db, id)
  const before = all()
  failAudit('restore')
  expect(() => restore(db, id, { sourceMessageId: 'r1-own-restore' })).toThrow('R1_OWN_transaction_restore')
  expect(all()).toEqual(before)
  reopen()
  expect(all()).toEqual(before)
  db.exec('DROP TRIGGER atomic_audit_failure')
  expect(restore(db, id, { sourceMessageId: 'r1-own-restore' })).toBe('needs_review')
  expect(row(id).state).toBe('needs_review')
  expect(sums()).toEqual([])
})

it('S2 real model restore cannot retain an unaudited restoration and can retry successfully', async () => {
  const id = ordinary('expense')
  softDelete(db, id)
  const before = all(), stats = sums()
  failAudit('restore')
  await expect(toolRestore(id)).rejects.toThrow('R1_OWN_transaction_restore')
  expect(all()).toEqual(before)
  expect(sums()).toEqual(stats)
  reopen()
  expect(all()).toEqual(before)
  db.exec('DROP TRIGGER atomic_audit_failure')
  expect(await toolRestore(id)).toMatchObject({ content: [{ type: 'text', text: `已恢复 #${id}（confirmed）。` }], details: { card: { kind: 'transaction', tx: { id, state: 'confirmed', amountCents: 17381 } } } })
})

it('S2 failed nested update rolls back only its savepoint and keeps the outer transaction usable', () => {
  const id = ordinary()
  failAudit('update')
  db.transaction(() => {
    db.prepare("INSERT INTO settings(key,value,updated_at) VALUES('r1.outer.before','kept','synthetic')").run()
    const before = all()
    expect(() => updateFields(db, id, { amount_cents: 9001 })).toThrow('R1_OWN_transaction_update')
    expect(all()).toEqual(before)
    db.prepare("INSERT INTO settings(key,value,updated_at) VALUES('r1.outer.after','kept','synthetic')").run()
  })()
  expect(row(id).amount_cents).toBe(28643)
  expect(db.prepare("SELECT key FROM settings WHERE key LIKE 'r1.outer.%' ORDER BY key").all()).toEqual([{ key: 'r1.outer.after' }, { key: 'r1.outer.before' }])
})

it('S2 healthy generic edits preserve field permissions, state, no-op and error text', async () => {
  const id = ordinary('expense'), events: unknown[] = []
  const engine = new Engine(db, {} as never, {} as never, {} as never, (event) => events.push(event))
  const before = all()
  updateFields(db, id, {})
  expect(all()).toEqual(before)
  expect(() => updateFields(db, id, { type: 'income' })).toThrow('不允许更新的字段：type')
  expect(all()).toEqual(before)
  expect(await engine.editTx(id, { op: 'set', fields: { accountName: '不存在的合成账户', categoryName: '不可被创建' } })).toEqual({ status: 'error', message: '找不到账户「不存在的合成账户」' })
  expect(all()).toEqual(before)
  expect(await engine.editTx(id, { op: 'set', fields: { amountCents: 18397, note: '合成健康更正' } })).toMatchObject({ status: 'ok', card: { tx: { amountCents: 18397, state: 'confirmed' } } })
  expect(events).toEqual([])
  expect(await engine.editTx(id, { op: 'delete' })).toMatchObject({ status: 'ok' })
  const deleted = all()
  expect(await engine.editTx(id, { op: 'delete' })).toEqual({ status: 'already_closed', message: '这笔已经是删除状态' })
  expect(() => updateFields(db, id, { note: '拒绝更正' })).toThrow('这笔已删除，请先恢复后再修改')
  expect(all()).toEqual(deleted)
  expect(await engine.editTx(id, { op: 'restore' })).toMatchObject({ status: 'ok' })
  const restored = all()
  expect(await engine.editTx(id, { op: 'restore' })).toEqual({ status: 'already_closed', message: '这笔未处于删除状态' })
  expect(all()).toEqual(restored)
  const { streamId } = engine.panelHistoryState
  expect(events).toEqual([
    { type: 'tx-deleted', payload: { txId: id }, sessionId: engine.sessionId, streamId, eventSeq: 1 },
    { type: 'tx-restored', payload: { txId: id }, sessionId: engine.sessionId, streamId, eventSeq: 2 },
  ])
})

function observe(id: number, pendingId?: number) {
  const events: any[] = []
  const engine = new Engine(db, {} as never, {} as never, {} as never, (event) => {
    // A separate connection must see committed facts when the success event is delivered.
    const reader = openPlainDb(file)
    try {
      events.push({ event, inTransaction: db.inTransaction,
        row: reader.prepare('SELECT * FROM transactions WHERE id=?').get(id),
        audit: reader.prepare("SELECT * FROM audit_log WHERE entity_type='transaction' AND entity_id=? ORDER BY id DESC LIMIT 1").get(id),
        pending: pendingId === undefined ? undefined : getPending(reader, pendingId) })
    } finally { reader.close() }
  })
  return { engine, events }
}

it.each(['category-audit', 'transaction-update', 'transaction-audit'] as const)('S2 Engine new income category rolls back on %s failure and real retry creates it once', async (stage) => {
  const id = ordinary(), before = all(), stats = sums(), { engine, events } = observe(id)
  if (stage === 'category-audit') failAudit('create', 'category')
  else if (stage === 'transaction-audit') failAudit('update')
  else db.exec("CREATE TRIGGER own_tx_update_abort BEFORE UPDATE ON transactions BEGIN SELECT RAISE(ABORT,'R1_OWN_AFTER_CATEGORY'); END")
  const op = { op: 'set' as const, fields: { categoryName: 'R1合成收入新分类', amountCents: 29989, note: '合成分类复合编辑' } }
  expect(await engine.editTx(id, op)).toMatchObject({ status: 'error', message: expect.stringContaining(stage === 'transaction-update' ? 'R1_OWN_AFTER_CATEGORY' : 'R1_OWN_') })
  expect(all()).toEqual(before)
  expect(sums()).toEqual(stats)
  expect(events).toEqual([])
  reopen()
  expect(all()).toEqual(before)
  db.exec(stage === 'transaction-update' ? 'DROP TRIGGER own_tx_update_abort' : 'DROP TRIGGER atomic_audit_failure')
  expect(await observe(id).engine.editTx(id, op)).toMatchObject({ status: 'ok', card: { tx: { amountCents: 29989, categoryName: 'R1合成收入新分类', state: 'confirmed' } } })
  const created = db.prepare("SELECT * FROM categories WHERE name='R1合成收入新分类'").all() as any[]
  expect(created).toHaveLength(1)
  expect(created[0].kind).toBe('income')
  expect(db.prepare("SELECT * FROM audit_log WHERE entity_type='category' AND entity_id=?").all(created[0].id)).toHaveLength(1)
})

it('S2 Engine late pending close failure rolls back deletion, audit and sequences; retry emits committed facts once', async () => {
  const id = ordinary('income', 'needs_review')
  const pending = createPending(db, { txId: id, sessionId: 'r1-own-pending', field: 'confirm_record', question: '合成待确认' })
  const untouched = createPending(db, { txId: id, sessionId: 'r1-own-pending', field: 'note', question: '不应被关闭' })
  const before = all(), { engine, events } = observe(id, pending)
  db.exec("CREATE TRIGGER own_pending_late_failure BEFORE UPDATE ON pending_clarifications WHEN OLD.id=" + pending + " BEGIN SELECT RAISE(ABORT,'R1_OWN_PENDING_LATE'); END")
  expect(await engine.editTx(id, { op: 'delete' })).toEqual({ status: 'error', message: '操作失败：R1_OWN_PENDING_LATE' })
  expect(all()).toEqual(before)
  expect(events).toEqual([])
  reopen()
  expect(all()).toEqual(before)
  db.exec('DROP TRIGGER own_pending_late_failure')
  const retry = observe(id, pending)
  expect(await retry.engine.editTx(id, { op: 'delete' })).toMatchObject({ status: 'ok' })
  expect(retry.events).toHaveLength(1)
  expect(retry.events[0]).toMatchObject({ event: { type: 'tx-deleted', payload: { txId: id } }, inTransaction: false, row: { state: 'deleted' }, pending: { status: 'cancelled' }, audit: { change_type: 'delete', changed_by: 'user' } })
  expect(getPending(db, untouched)!.status).toBe('open')
})

function deferredFailure(trigger: string) {
  // Test-only schema forces a failure at COMMIT, after all normal SQL has succeeded.
  db.exec('CREATE TABLE own_deferred_commit(id INTEGER PRIMARY KEY AUTOINCREMENT, account_id INTEGER REFERENCES accounts(id) DEFERRABLE INITIALLY DEFERRED)')
  db.exec(trigger)
}

it('S2 delete COMMIT failure sends no success event and rolls back earlier pending close and audit', async () => {
  const id = ordinary('expense', 'needs_review')
  const pending = createPending(db, { txId: id, sessionId: 'r1-commit', field: 'confirm_record', question: '合成提交故障' })
  deferredFailure(`CREATE TRIGGER own_commit_failure AFTER UPDATE ON pending_clarifications WHEN NEW.id=${pending} BEGIN INSERT INTO own_deferred_commit(account_id) VALUES(-881); END`)
  const before = all(), { engine, events } = observe(id, pending)
  expect(await engine.editTx(id, { op: 'delete' })).toMatchObject({ status: 'error', message: expect.stringContaining('FOREIGN KEY constraint failed') })
  expect(all()).toEqual(before)
  expect(events).toEqual([])
  db.exec('DROP TRIGGER own_commit_failure')
  expect(await engine.editTx(id, { op: 'delete' })).toMatchObject({ status: 'ok' })
  expect(events).toHaveLength(1)
  expect(events[0]).toMatchObject({ inTransaction: false, event: { type: 'tx-deleted' }, row: { state: 'deleted' }, pending: { status: 'cancelled' } })
})

it('S2 restore COMMIT failure emits nothing; successful retry broadcasts only committed restored row and audit', async () => {
  const id = ordinary('income')
  softDelete(db, id)
  deferredFailure(`CREATE TRIGGER own_commit_failure AFTER INSERT ON audit_log WHEN NEW.entity_type='transaction' AND NEW.entity_id=${id} AND NEW.change_type='restore' BEGIN INSERT INTO own_deferred_commit(account_id) VALUES(-882); END`)
  const before = all(), { engine, events } = observe(id)
  expect(await engine.editTx(id, { op: 'restore' })).toMatchObject({ status: 'error', message: expect.stringContaining('FOREIGN KEY constraint failed') })
  expect(all()).toEqual(before)
  expect(events).toEqual([])
  db.exec('DROP TRIGGER own_commit_failure')
  expect(await engine.editTx(id, { op: 'restore' })).toMatchObject({ status: 'ok' })
  expect(events).toHaveLength(1)
  expect(events[0]).toMatchObject({ inTransaction: false, event: { type: 'tx-restored', payload: { txId: id } }, row: { state: 'confirmed' }, audit: { change_type: 'restore', changed_by: 'user' } })
})

it.each(['confirm-audit', 'commit'] as const)('S2 transfer completion %s failure rolls back accounts and confirmation with no record-confirmed event', async (stage) => {
  const id = createTransaction(db, { amountCents: 4207, txType: 'transfer', accountId: 2, sourceMessageId: 'r1-synthetic-transfer' })
  recordParse(db, id, {})
  requestReview(db, id, { reason: '合成缺转入账户' })
  const account = (db.prepare('SELECT name FROM accounts WHERE id=4').get() as { name: string }).name
  if (stage === 'confirm-audit') failAudit('confirm')
  else deferredFailure(`CREATE TRIGGER own_commit_failure AFTER INSERT ON audit_log WHEN NEW.entity_type='transaction' AND NEW.entity_id=${id} AND NEW.change_type='confirm' BEGIN INSERT INTO own_deferred_commit(account_id) VALUES(-883); END`)
  const before = all(), { engine, events } = observe(id)
  const op = { op: 'transferAccounts' as const, toAccountName: account }
  expect(await engine.editTx(id, op)).toMatchObject({ status: 'error', message: expect.stringContaining(stage === 'commit' ? 'FOREIGN KEY constraint failed' : 'R1_OWN_transaction_confirm') })
  expect(all()).toEqual(before)
  expect(events).toEqual([])
  db.exec(stage === 'commit' ? 'DROP TRIGGER own_commit_failure' : 'DROP TRIGGER atomic_audit_failure')
  expect(await engine.editTx(id, op)).toMatchObject({ status: 'ok', card: { tx: { state: 'confirmed', toAccountName: account } } })
  expect(events).toHaveLength(1)
  expect(events[0]).toMatchObject({ inTransaction: false, event: { type: 'record-confirmed' }, row: { state: 'confirmed', to_account_id: 4 }, audit: { change_type: 'confirm', changed_by: 'user' } })
})
