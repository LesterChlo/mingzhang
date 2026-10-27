import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Database } from 'better-sqlite3-multiple-ciphers'
import { openSchemaDb } from './helpers'
import { seed } from '../src/main/db/seed'
import {
  confirm as confirmTx,
  createTransaction,
  getTransaction,
  recordParse,
  requestReview,
} from '../src/main/domain/ledger'
import { Engine } from '../src/main/engine/engine'
import { getTransactionEditForm, applyTransactionDateTypeEdit } from '../src/main/domain/transaction-date-type'

let db: Database
let accountId: number
let expenseCategoryId: number
let incomeCategoryId: number

const allTables = (): Record<string, unknown[]> =>
  Object.fromEntries(
    (db.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all() as { name: string }[]).map(
      ({ name }) => [name, db.prepare(`SELECT * FROM "${name.replaceAll('"', '""')}" ORDER BY rowid`).all()],
    ),
  )

function addTransaction(options: {
  type?: 'expense' | 'income' | 'transfer' | 'adjustment'
  state?: 'confirmed' | 'needs_review' | 'raw_input'
  categoryId?: number | null
  toAccountId?: number | null
} = {}): number {
  const type = options.type ?? 'expense'
  const id = createTransaction(db, {
    amountCents: type === 'adjustment' ? -1250 : 1250,
    txType: type,
    accountId,
    toAccountId: options.toAccountId ?? null,
    occurredAt: '2026-10-31T23:59:59+08:00',
    merchant: '合成日期边界',
    sourceMessageId: 'synthetic-date-boundary',
    changedBy: 'user',
  })
  if (options.categoryId != null) recordParse(db, id, { categoryId: options.categoryId })
  if (options.state === 'needs_review') requestReview(db, id, { reason: '合成待核对' })
  else if (options.state !== 'raw_input') confirmTx(db, id)
  return id
}

function account(name: string): number {
  return (db.prepare('SELECT id FROM accounts WHERE name=?').get(name) as { id: number }).id
}

beforeEach(() => {
  db = openSchemaDb(join(mkdtempSync(join(tmpdir(), 'mz-date-type-boundary-')), 'synthetic.db'))
  seed(db)
  accountId = account('现金')
  expenseCategoryId = (db.prepare("SELECT id FROM categories WHERE kind='expense' AND name='餐饮'").get() as { id: number }).id
  incomeCategoryId = (db.prepare("SELECT id FROM categories WHERE kind='income' AND name='生活费'").get() as { id: number }).id
})

afterEach(() => db.close())

describe('日期与收支类型编辑：边界契约', () => {
  it('逐字保留支持的日期、当地时间与 ISO offset 格式', () => {
    const txId = addTransaction({ categoryId: expenseCategoryId })
    const valid = [
      '2024-02-29',
      '2024-02-29 09:07',
      '2024-02-29 09:07:08',
      '2024-02-29T09:07',
      '2024-02-29T09:07:08Z',
      '2024-02-29T09:07:08-05:30',
    ]
    for (const occurredAt of valid) {
      const form = getTransactionEditForm(db, txId)!
      const result = applyTransactionDateTypeEdit(db, { txId, expectedVersion: form.version, fields: { occurredAt } })
      expect(result.occurredAt).toBe(occurredAt)
      expect(getTransaction(db, txId)?.occurred_at).toBe(occurredAt)
    }
  })

  it('同值 no-op 不改更新时间、审计或sqlite_sequence', () => {
    const txId = addTransaction({ categoryId: expenseCategoryId })
    const form = getTransactionEditForm(db, txId)!
    const before = allTables()
    const result = applyTransactionDateTypeEdit(db, {
      txId,
      expectedVersion: form.version,
      fields: { occurredAt: form.occurredAt, txType: form.txType as 'expense' },
    })
    expect(result.version).toBe(form.version)
    expect(allTables()).toEqual(before)
  })

  it('引用账户或类别事实变化会使opaque版本失效', () => {
    const txId = addTransaction({ categoryId: expenseCategoryId })
    const initial = getTransactionEditForm(db, txId)!
    db.prepare("UPDATE accounts SET name='现金-版本边界' WHERE id=?").run(accountId)
    const accountChanged = getTransactionEditForm(db, txId)!
    expect(accountChanged.version).not.toBe(initial.version)
    db.prepare("UPDATE categories SET name='餐饮-版本边界' WHERE id=?").run(expenseCategoryId)
    const categoryChanged = getTransactionEditForm(db, txId)!
    expect(categoryChanged.version).not.toBe(accountChanged.version)
    const before = allTables()
    expect(() => applyTransactionDateTypeEdit(db, {
      txId,
      expectedVersion: initial.version,
      fields: { occurredAt: '2026-11-01' },
    })).toThrow()
    expect(allTables()).toEqual(before)
  })

  it('待核对记录可改发生时间或以真实方向分类切换类型但不自动确认', () => {
    const txId = addTransaction({ state: 'needs_review' })
    const form = getTransactionEditForm(db, txId)!
    const result = applyTransactionDateTypeEdit(db, {
      txId,
      expectedVersion: form.version,
      fields: { occurredAt: '2026-11-01', txType: 'income', categoryId: incomeCategoryId },
    })
    expect(result).toMatchObject({ txType: 'income', state: 'needs_review', categoryId: incomeCategoryId })
    expect(getTransaction(db, txId)).toMatchObject({ type: 'income', state: 'needs_review', category_id: incomeCategoryId })
  })

  it('transfer与adjustment只允许改日期，不允许转换为收支', () => {
    const transferTo = account('微信')
    for (const type of ['transfer', 'adjustment'] as const) {
      const txId = addTransaction({ type, toAccountId: type === 'transfer' ? transferTo : null, state: 'raw_input' })
      const form = getTransactionEditForm(db, txId)!
      const result = applyTransactionDateTypeEdit(db, { txId, expectedVersion: form.version, fields: { occurredAt: '2024-02-29' } })
      expect(result).toMatchObject({ txType: type, occurredAt: '2024-02-29', state: 'raw_input' })
      const before = allTables()
      expect(() => applyTransactionDateTypeEdit(db, {
        txId,
        expectedVersion: result.version,
        fields: { txType: 'expense' },
      })).toThrow()
      expect(allTables()).toEqual(before)
    }
  })

  it('拒绝非安全整数及未知字段，不触碰数据库', () => {
    const txId = addTransaction({ categoryId: expenseCategoryId })
    const form = getTransactionEditForm(db, txId)!
    for (const badId of [0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1, NaN, '1']) {
      expect(() => getTransactionEditForm(db, badId as number)).toThrow()
      expect(() => applyTransactionDateTypeEdit(db, {
        txId: badId as number,
        expectedVersion: form.version,
        fields: { occurredAt: '2026-11-01' },
      })).toThrow()
    }
    for (const fields of [{ occurredAt: '2026-11-01', unexpected: true }, { txType: 'income', categoryId: null }]) {
      const before = allTables()
      expect(() => applyTransactionDateTypeEdit(db, {
        txId,
        expectedVersion: form.version,
        fields: fields as never,
      })).toThrow()
      expect(allTables()).toEqual(before)
    }
  })

  it('Engine dateType分支返回新卡片与跨月反馈，未启动模型也可完成', async () => {
    const txId = addTransaction({ categoryId: expenseCategoryId })
    const form = getTransactionEditForm(db, txId)!
    const engine = new Engine(db, {} as never, {} as never, {} as never, () => {})
    expect(engine.ready).toBe(false)
    const result = await engine.editTx(txId, {
      op: 'dateType',
      expectedVersion: form.version,
      fields: { occurredAt: '2026-11-01T00:10:00+08:00' },
    })
    expect(result.status).toBe('ok')
    expect(result.card?.tx).toMatchObject({ id: txId, occurredAt: '2026-11-01T00:10:00+08:00', type: 'expense' })
    expect(result.message).toContain('2026-10')
    expect(result.message).toContain('2026-11')
    expect(engine.ready).toBe(false)
  })

  it('Engine缺失或未知op拒绝且不落入旧set字段更新', async () => {
    const txId = addTransaction({ categoryId: expenseCategoryId })
    const engine = new Engine(db, {} as never, {} as never, {} as never, () => {})
    const before = allTables()
    for (const badOp of [
      { fields: { merchant: '不应写入' } },
      { op: 'future', fields: { merchant: '不应写入' } },
    ]) {
      const result = await engine.editTx(txId, badOp as never)
      expect(result.status).toBe('error')
      expect(allTables()).toEqual(before)
    }
  })
})
