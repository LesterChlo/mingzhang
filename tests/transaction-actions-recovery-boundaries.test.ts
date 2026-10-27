// R1 regression boundaries: real ledger/tools/Engine with synthetic SQLite only.
import { afterEach, beforeEach, expect, it } from 'vitest'
import { mkdtempSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { openPlainDb, openSchemaDb } from './helpers'
import { seed } from '../src/main/db/seed'
import { confirm, createImport, createTransaction, recordParse, restore, softDelete } from '../src/main/domain/ledger'
import { executeTransactionSplit, getTransactionActions, prepareTransactionSplit, undoTransactionSplit } from '../src/main/domain/transaction-actions'
import { createLedgerTools } from '../src/main/engine/tools'
import { Engine } from '../src/main/engine/engine'

let db: ReturnType<typeof openPlainDb>
let file: string
beforeEach(() => {
  file = join(mkdtempSync(join(tmpdir(), 'mz-r1-recovery-boundary-')), 'synthetic.db')
  db = openSchemaDb(file)
  seed(db)
})
afterEach(() => { if (db?.open) db.close() })

const row = (id: number) => db.prepare('SELECT * FROM transactions WHERE id=?').get(id) as any
const all = () => Object.fromEntries((db.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all() as { name: string }[])
  .map(({ name }) => [name, db.prepare(`SELECT * FROM "${name.replaceAll('"', '""')}" ORDER BY rowid`).all()]))
const total = () => (db.prepare('SELECT COALESCE(SUM(amount_cents),0) cents FROM v_reportable_transactions').get() as { cents: number }).cents
const linkKey = (id: number) => `transaction.split-link:${id}`
const linkRaw = (id: number) => (db.prepare('SELECT value FROM settings WHERE key=?').get(linkKey(id)) as { value: string }).value
const modelRestore = (id: number) => createLedgerTools({ db, getTurnContext: () => ({ sessionId: 'r1-boundary-model', sourceMessageId: 'r1-boundary-new-turn', hasImage: false, visionUnverified: false, attachments: [] }) })
  .find((tool) => tool.name === 'restore')!.execute('synthetic-restore', { tx_id: id }, undefined, undefined, {} as never)

function group(kind: 'income' | 'expense') {
  const parts = kind === 'income' ? [209, 4777, 10001] : [1297, 5101]
  const amount = parts.reduce((sum, value) => sum + value, 0)
  const category = (db.prepare('SELECT id FROM categories WHERE kind=? ORDER BY id DESC LIMIT 1').get(kind) as { id: number }).id
  const original = createTransaction(db, { amountCents: amount, txType: kind, accountId: 4, occurredAt: '2041-02-13T22:43:59+05:45', merchant: '合成边界商户', note: 'R1自造来源', sourceMessageId: 'r1-boundary-source' })
  recordParse(db, original, { categoryId: category })
  confirm(db, original)
  createImport(db, { sourceType: 'screenshot', status: 'confirmed', sourceRef: 'r1-synthetic-image-not-present.png', sourceMessageId: 'r1-boundary-source' })
  db.prepare("INSERT INTO settings(key,value,updated_at) VALUES(?,?, 'synthetic')").run(`tx.attachments:${original}`, JSON.stringify({ version: 3, items: [], syntheticMarker: 'explicit-empty-authority' }))
  const plan = prepareTransactionSplit(db, { txId: original, expectedVersion: getTransactionActions(db, original)!.version, items: parts.map((amountCents) => ({ amountCents, categoryId: category })) }, { via: 'panel', sessionId: 'r1-boundary' })
  return { ...executeTransactionSplit(db, { gateId: plan.gateId, expectedVersion: plan.version }, { via: 'panel' }), amount, parts }
}

it.each(['income', 'expense'] as const)('S1 %s active child survives physical reopen and real model restore without renewing undo', async (kind) => {
  const split = group(kind)
  const id = split.childIds[0]
  const beforeChild = row(id)
  const original = row(split.originalId)
  const siblings = split.childIds.slice(1).map(row)
  const oldUndo = getTransactionActions(db, split.originalId)!.undoSplit!
  const metadata = db.prepare("SELECT * FROM settings WHERE key LIKE 'transaction.split-link:%' ORDER BY key").all()
  softDelete(db, id, { reasoning: '合成普通单笔删除' })
  expect(total()).toBe(split.amount - split.parts[0])
  db.close()
  db = openPlainDb(file)
  const result = await modelRestore(id) as any
  expect(result.details.card.tx).toMatchObject({ id, state: 'confirmed', amountCents: split.parts[0] })
  expect(result.content[0].text).toBe(`已恢复 #${id}（confirmed）。`)
  expect(row(id)).toEqual({ ...beforeChild, updated_at: row(id).updated_at })
  expect(row(split.originalId)).toEqual(original)
  expect(split.childIds.slice(1).map(row)).toEqual(siblings)
  expect(total()).toBe(split.amount)
  expect(db.prepare("SELECT * FROM settings WHERE key LIKE 'transaction.split-link:%' ORDER BY key").all()).toEqual(metadata)
  expect(getTransactionActions(db, split.originalId)!.undoSplit).toMatchObject({ canUndo: false, version: oldUndo.version })
  const stable = all()
  expect(() => undoTransactionSplit(db, { gateId: split.gateId, expectedVersion: oldUndo.version }, { via: 'panel' })).toThrow(/变化/)
  expect(all()).toEqual(stable)
  db.close()
  db = openPlainDb(file)
  expect(total()).toBe(split.amount)
  expect(getTransactionActions(db, split.originalId)!.undoSplit!.canUndo).toBe(false)
})

it('S1 rejects active original and undone child through ledger, model and Engine with zero writes', async () => {
  const split = group('income')
  const engine = new Engine(db, {} as never, {} as never, {} as never, () => { throw new Error('must not broadcast') })
  const active = all()
  expect(() => restore(db, split.originalId)).toThrow('拆账组不能单独恢复，请使用原笔的「撤销拆账」一次性恢复，避免重复计账')
  await expect(modelRestore(split.originalId)).rejects.toThrow(/拆账组不能单独恢复/)
  expect(await engine.editTx(split.originalId, { op: 'restore' })).toMatchObject({ status: 'error' })
  expect(all()).toEqual(active)
  const undo = getTransactionActions(db, split.originalId)!.undoSplit!
  undoTransactionSplit(db, { gateId: undo.gateId, expectedVersion: undo.version }, { via: 'panel' })
  const undone = all()
  for (const id of split.childIds) {
    expect(() => restore(db, id)).toThrow(/拆账组不能单独恢复/)
    await expect(modelRestore(id)).rejects.toThrow(/拆账组不能单独恢复/)
    expect(await engine.editTx(id, { op: 'restore' })).toMatchObject({ status: 'error' })
    expect(all()).toEqual(undone)
  }
  expect(total()).toBe(split.amount)
})

it('S1 damaged split metadata stays fail closed for direct and real model restore', async () => {
  const split = group('expense'), id = split.childIds[1]
  softDelete(db, id)
  const valid = JSON.parse(linkRaw(id))
  const corrupt = ['{broken', 'null', '[]', JSON.stringify({ ...valid, role: 'unexpected' }), JSON.stringify({ ...valid, state: 'unexpected' }), JSON.stringify({ ...valid, gateId: 'not-a-number' }), JSON.stringify({ role: 'child', state: 'active', gateId: valid.gateId }), JSON.stringify({ ...valid, gateId: 0 }), JSON.stringify({ ...valid, gateId: -7 }), JSON.stringify({ ...valid, originalId: null }), JSON.stringify({ ...valid, childIds: [id, id] }), JSON.stringify({ ...valid, childIds: [id] }), JSON.stringify({ ...valid, childIds: [id, -4] })]
  for (const raw of corrupt) {
    db.prepare('UPDATE settings SET value=? WHERE key=?').run(raw, linkKey(id))
    const before = all()
    expect(() => restore(db, id)).toThrow()
    await expect(modelRestore(id)).rejects.toThrow()
    expect(all()).toEqual(before)
  }
  db.prepare('UPDATE settings SET value=? WHERE key=?').run(JSON.stringify(valid), linkKey(id))
  expect(restore(db, id)).toBe('confirmed')
  expect(total()).toBe(split.amount)
})

it('S1 active child refuses restoration if its original is no longer deleted', async () => {
  const split = group('income'), id = split.childIds[1]
  softDelete(db, id)
  // Synthetic corruption only: no production API permits reviving the active original.
  db.prepare("UPDATE transactions SET state='confirmed' WHERE id=?").run(split.originalId)
  const before = all()
  expect(() => restore(db, id)).toThrow(/拆账组不能单独恢复/)
  await expect(modelRestore(id)).rejects.toThrow(/拆账组不能单独恢复/)
  expect(all()).toEqual(before)
})

it('S2 real model active-child restore COMMIT failure preserves the whole group and retries after physical reopen', async () => {
  const split = group('income'), id = split.childIds[2]
  const child = row(id), original = row(split.originalId), siblings = split.childIds.slice(0, 2).map(row)
  softDelete(db, id)
  db.exec('CREATE TABLE model_commit_guard(id INTEGER PRIMARY KEY AUTOINCREMENT, account_id INTEGER REFERENCES accounts(id) DEFERRABLE INITIALLY DEFERRED)')
  db.exec(`CREATE TRIGGER model_restore_commit_failure AFTER INSERT ON audit_log WHEN NEW.entity_type='transaction' AND NEW.entity_id=${id} AND NEW.change_type='restore' BEGIN INSERT INTO model_commit_guard(account_id) VALUES(-904); END`)
  const before = all(), stats = total()
  await expect(modelRestore(id)).rejects.toThrow('FOREIGN KEY constraint failed')
  expect(db.inTransaction).toBe(false)
  expect(all()).toEqual(before)
  expect(total()).toBe(stats)
  db.close()
  db = openPlainDb(file)
  expect(all()).toEqual(before)
  db.exec('DROP TRIGGER model_restore_commit_failure')
  expect(await modelRestore(id)).toMatchObject({ details: { card: { tx: { id, state: 'confirmed' } } } })
  expect(row(id)).toEqual({ ...child, updated_at: row(id).updated_at })
  expect(row(split.originalId)).toEqual(original)
  expect(split.childIds.slice(0, 2).map(row)).toEqual(siblings)
  expect(total()).toBe(split.amount)
  expect(getTransactionActions(db, split.originalId)!.undoSplit!.canUndo).toBe(false)
})
