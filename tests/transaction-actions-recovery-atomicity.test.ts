// Parent-frozen R1 acceptance: real registered IPC/Engine/SQLite, synthetic data only.
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { mkdtempSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
const { handlers } = vi.hoisted(() => ({ handlers: new Map<string, (...args: any[]) => any>() }))
vi.mock('electron', () => ({ ipcMain: { handle: (name: string, fn: any) => handlers.set(name, fn) }, nativeTheme: {} }))
import { openPlainDb, openSchemaDb } from './helpers'
import { seed } from '../src/main/db/seed'
import { createTransaction, recordParse, confirm } from '../src/main/domain/ledger'
import { createPending } from '../src/main/domain/pending'
import { getTransactionActions, prepareTransactionSplit } from '../src/main/domain/transaction-actions'
import { registerIpc } from '../src/main/ipc'
import { Engine } from '../src/main/engine/engine'

let db: ReturnType<typeof openPlainDb>
let file: string
let dir: string
let original: number
let engine: Engine
let events: any[]
const parts = [7019, 11027, 13033]
const total = parts.reduce((a, b) => a + b, 0)
const call = (name: string, ...args: any[]) => handlers.get('mz:' + name)!({}, ...args)
const tx = (id: number) => db.prepare('SELECT * FROM transactions WHERE id=?').get(id) as any
const tables = () => Object.fromEntries((db.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all() as { name: string }[]).map(({ name }) => [name, db.prepare('SELECT * FROM "' + name.replaceAll('"', '""') + '" ORDER BY rowid').all()]))
const reportTotal = () => (db.prepare('SELECT COALESCE(SUM(amount_cents),0) cents FROM v_reportable_transactions').get() as { cents: number }).cents
function connect() {
  events = []
  engine = new Engine(db, {} as never, {} as never, {} as never, (event) => events.push(event))
  handlers.clear()
  registerIpc({ getDb: () => db, engines: { get: () => engine } } as never, { dataDir: dir, dbFile: file })
}
async function split() {
  const category = tx(original).category_id
  const plan = prepareTransactionSplit(db, { txId: original, expectedVersion: getTransactionActions(db, original)!.version, items: parts.map((amountCents) => ({ amountCents, categoryId: category })) }, { via: 'panel' })
  expect(await call('confirmGate', plan.gateId, plan.version)).toMatchObject({ status: 'ok' })
  return events.find((event) => event.type === 'gate-executed').payload.result as { childIds: number[]; gateId: number }
}
function abortAudit(kind: string, marker: string) {
  db.exec(`CREATE TRIGGER r1_audit_abort BEFORE INSERT ON audit_log WHEN NEW.entity_type='transaction' AND NEW.change_type='${kind}' BEGIN SELECT RAISE(ABORT,'${marker}'); END`)
}
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'mz-split-r1-frozen-'))
  file = join(dir, 'synthetic.db')
  db = openSchemaDb(file)
  seed(db)
  const category = (db.prepare("SELECT id FROM categories WHERE kind='expense' AND name='购物'").get() as { id: number }).id
  original = createTransaction(db, { amountCents: total, txType: 'expense', accountId: 3, occurredAt: '2038-11-18T07:12:46-04:30', merchant: 'R1合成原笔', sourceMessageId: 'parent-r1-synthetic', changedBy: 'user' })
  recordParse(db, original, { categoryId: category })
  confirm(db, original)
  connect()
})
afterEach(() => { if (db?.open) db.close(); handlers.clear() })

it('R1 control ordinary confirmed transaction remains deletable and restorable', async () => {
  expect(await call('editTx', original, { op: 'delete' })).toMatchObject({ status: 'ok' })
  expect(reportTotal()).toBe(0)
  expect(await call('editTx', original, { op: 'restore' })).toMatchObject({ status: 'ok' })
  expect(reportTotal()).toBe(total)
})
it('R1 active child can be restored after delete and physical reopen without rebasing old group undo', async () => {
  const group = await split(), id = group.childIds[1], before = tx(id)
  expect(await call('editTx', id, { op: 'delete' })).toMatchObject({ status: 'ok' })
  db.close(); db = openPlainDb(file); connect()
  expect(await call('editTx', id, { op: 'restore' })).toMatchObject({ status: 'ok' })
  expect(tx(id)).toEqual({ ...before, updated_at: tx(id).updated_at })
  expect(tx(original).state).toBe('deleted')
  expect(reportTotal()).toBe(total)
  const undo = call('getTransactionActions', original).undoSplit
  expect(undo.canUndo).toBe(false)
  const state = tables()
  expect(() => call('undoTransactionSplit', { gateId: undo.gateId, expectedVersion: undo.version })).toThrow()
  expect(tables()).toEqual(state)
})
it('R1 failed child amount audit rolls back every table, sequence and undo authority; real retry succeeds', async () => {
  const group = await split(), id = group.childIds[0], before = tables()
  abortAudit('update', 'R1_AMOUNT_AUDIT')
  const count = events.length
  expect(await call('editTx', id, { op: 'set', fields: { amountCents: parts[0] + 53 } })).toMatchObject({ status: 'error', message: expect.stringContaining('R1_AMOUNT_AUDIT') })
  expect(tables()).toEqual(before)
  expect(events.slice(count)).toEqual([])
  expect(call('getTransactionActions', original).undoSplit.canUndo).toBe(true)
  db.exec('DROP TRIGGER r1_audit_abort')
  expect(await call('editTx', id, { op: 'set', fields: { amountCents: parts[0] + 53 } })).toMatchObject({ status: 'ok' })
  expect(tx(id).amount_cents).toBe(parts[0] + 53)
})
it('R1 failed child delete audit leaves all tables and events unchanged; real retry succeeds', async () => {
  const group = await split(), id = group.childIds[2], before = tables()
  abortAudit('delete', 'R1_DELETE_AUDIT')
  const count = events.length
  expect(await call('editTx', id, { op: 'delete' })).toMatchObject({ status: 'error', message: expect.stringContaining('R1_DELETE_AUDIT') })
  expect(tables()).toEqual(before)
  expect(events.slice(count)).toEqual([])
  db.exec('DROP TRIGGER r1_audit_abort')
  expect(await call('editTx', id, { op: 'delete' })).toMatchObject({ status: 'ok' })
})
it('R1 generic restore audit failure after successful undo is atomic and retry remains available', async () => {
  await split()
  const undo = call('getTransactionActions', original).undoSplit
  call('undoTransactionSplit', { gateId: undo.gateId, expectedVersion: undo.version })
  expect(await call('editTx', original, { op: 'delete' })).toMatchObject({ status: 'ok' })
  const before = tables(), count = events.length
  abortAudit('restore', 'R1_RESTORE_AUDIT')
  expect(await call('editTx', original, { op: 'restore' })).toMatchObject({ status: 'error', message: expect.stringContaining('R1_RESTORE_AUDIT') })
  expect(tables()).toEqual(before)
  expect(events.slice(count)).toEqual([])
  db.exec('DROP TRIGGER r1_audit_abort')
  expect(await call('editTx', original, { op: 'restore' })).toMatchObject({ status: 'ok' })
  expect(reportTotal()).toBe(total)
})
it('R1 field-edit audit failure also rolls back newly created category and its audit', async () => {
  const group = await split(), id = group.childIds[0], before = tables()
  abortAudit('update', 'R1_CATEGORY_THEN_UPDATE')
  expect(await call('editTx', id, { op: 'set', fields: { categoryName: 'R1合成新分类', amountCents: parts[0] + 73 } })).toMatchObject({ status: 'error', message: expect.stringContaining('R1_CATEGORY_THEN_UPDATE') })
  expect(tables()).toEqual(before)
})
it('R1 failure closing related confirm pending rolls back the earlier delete and audit', async () => {
  const group = await split(), id = group.childIds[0]
  createPending(db, { txId: id, sessionId: 'parent-r1-synthetic', field: 'confirm_record', question: 'R1合成待确认' })
  const before = tables(), count = events.length
  db.exec("CREATE TRIGGER r1_pending_abort BEFORE UPDATE ON pending_clarifications WHEN OLD.field='confirm_record' BEGIN SELECT RAISE(ABORT,'R1_LATE_PENDING_CLOSE'); END")
  expect(await call('editTx', id, { op: 'delete' })).toMatchObject({ status: 'error', message: expect.stringContaining('R1_LATE_PENDING_CLOSE') })
  expect(tables()).toEqual(before)
  expect(events.slice(count)).toEqual([])
})
it('R1 control active original and group-undone children still cannot be individually revived', async () => {
  const group = await split(), active = tables()
  expect(await call('editTx', original, { op: 'restore' })).toMatchObject({ status: 'error' })
  expect(tables()).toEqual(active)
  const undo = call('getTransactionActions', original).undoSplit
  call('undoTransactionSplit', { gateId: undo.gateId, expectedVersion: undo.version })
  const undone = tables()
  expect(await call('editTx', group.childIds[0], { op: 'restore' })).toMatchObject({ status: 'error' })
  expect(tables()).toEqual(undone)
})
