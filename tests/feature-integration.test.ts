// Combined PR38/42/43/44/45 lifecycle controls; generated data only.
import { afterEach, beforeEach, expect, it } from 'vitest'
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openSchemaDb } from './helpers'
import { seed } from '../src/main/db/seed'
import { executeBatch, prepareBatch } from '../src/main/domain/batch'
import { getTransactionActions, prepareTransactionSplit, executeTransactionSplit, undoTransactionSplit } from '../src/main/domain/transaction-actions'
import { getTransactionAttachments, removeTransactionAttachment } from '../src/main/domain/transaction-attachments'
import { getTransactionEditForm } from '../src/main/domain/transaction-date-type'
import { renameAccountById } from '../src/main/domain/accounts'

let db: ReturnType<typeof openSchemaDb>, file: string, dir: string, txId: number, categoryId: number
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGNoCtD9DwAEVgH/dFWU5AAAAABJRU5ErkJggg==', 'base64')
const refs = (id: number) => getTransactionAttachments(db, id, dir).items.map(item => item.ref)
const facts = () => Object.fromEntries((db.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all() as { name: string }[]).map(({ name }) => [name, db.prepare(`SELECT * FROM "${name.replaceAll('"', '""')}" ORDER BY rowid`).all()]))
const total = () => Number((db.prepare('SELECT COALESCE(SUM(amount_cents),0) n FROM v_reportable_transactions').get() as { n: number }).n)
const plan = () => prepareTransactionSplit(db, { txId, expectedVersion: getTransactionActions(db, txId)!.version, items: [{ amountCents: 3179, categoryId }, { amountCents: 6821, categoryId }] }, { via: 'panel', sessionId: 'synthetic-combined' })
beforeEach(() => {
  const root = mkdtempSync(join(tmpdir(), 'mz-combined-'))
  file = join(root, 'synthetic.db'); dir = join(root, 'attachments'); mkdirSync(dir)
  for (const name of ['source-one.png', 'source-two.png']) writeFileSync(join(dir, name), png)
  db = openSchemaDb(file); seed(db)
  categoryId = (db.prepare("SELECT id FROM categories WHERE name='餐饮' AND kind='expense'").get() as { id: number }).id
  const prepared = prepareBatch(db, { sourceType: 'screenshot', sessionId: 'synthetic-combined', attachments: ['source-one.png', 'source-two.png'], items: [{ amount_cents: 10000, tx_type: 'expense', occurred_at: '2026-04-01T09:17:00+08:00', account_name: '现金', category_name: '餐饮', merchant: '合成组合商户' }] })
  expect(prepared.plan.newCount).toBe(1)
  const result = executeBatch(db, prepared.gateId)!
  expect(result.completed).toHaveLength(1); txId = result.completed[0].txId
  expect(total()).toBe(10000)
})
afterEach(() => { if (db?.open) db.close() })

it('structured batch multiple sources survive split, restart and undo without changing total', () => {
  expect(refs(txId)).toEqual(['source-one.png', 'source-two.png'])
  const p = plan(), done = executeTransactionSplit(db, { gateId: p.gateId, expectedVersion: p.version }, { via: 'panel' })
  expect(done.childIds).toHaveLength(2); expect(total()).toBe(10000)
  db.close(); db = openSchemaDb(file)
  for (const id of done.childIds) {
    expect(refs(id)).toEqual(['source-one.png', 'source-two.png'])
    expect(getTransactionAttachments(db, id, dir).items.every(item => item.available)).toBe(true)
  }
  const undo = getTransactionActions(db, done.childIds[0])!.undoSplit!
  undoTransactionSplit(db, { gateId: p.gateId, expectedVersion: undo.version }, { via: 'panel' })
  expect(total()).toBe(10000); expect(refs(txId)).toEqual(['source-one.png', 'source-two.png'])
  expect(db.prepare('SELECT state FROM transactions WHERE id=?').get(txId)).toEqual({ state: 'confirmed' })
  for (const id of done.childIds) expect(db.prepare('SELECT state FROM transactions WHERE id=?').get(id)).toEqual({ state: 'deleted' })
  for (const name of ['source-one.png', 'source-two.png']) expect(readFileSync(join(dir, name))).toEqual(png)
})

it('local attachment removal invalidates existing split authorization with no extra writes on rejection', () => {
  const p = plan(), before = getTransactionAttachments(db, txId, dir)
  removeTransactionAttachment(db, { txId, expectedVersion: before.version, ref: 'source-one.png' }, { attachmentsDir: dir, validateImage: () => true })
  expect(refs(txId)).toEqual(['source-two.png'])
  const snapshot = facts()
  expect(() => executeTransactionSplit(db, { gateId: p.gateId, expectedVersion: p.version }, { via: 'panel' })).toThrow()
  expect(facts()).toEqual(snapshot); expect(total()).toBe(10000)
  expect(readFileSync(join(dir, 'source-one.png'))).toEqual(png)
})

it('account rename refreshes both date/type and split versions while old split cannot write', () => {
  const form = getTransactionEditForm(db, txId)!, p = plan()
  renameAccountById(db, { accountId: form.accountId, expectedName: '现金', newName: '合成组合现金' })
  expect(getTransactionEditForm(db, txId)!.version).not.toBe(form.version)
  const snapshot = facts()
  expect(() => executeTransactionSplit(db, { gateId: p.gateId, expectedVersion: p.version }, { via: 'panel' })).toThrow()
  expect(facts()).toEqual(snapshot); expect(total()).toBe(10000)
  expect(refs(txId)).toEqual(['source-one.png', 'source-two.png'])
})
