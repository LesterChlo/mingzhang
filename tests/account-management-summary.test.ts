import { expect, it, vi } from 'vitest'
import { openSchemaDb } from './helpers'
import { seed } from '../src/main/db/seed'
import { createTransaction, recordParse, confirm, softDelete, getOrCreateCategoryId } from '../src/main/domain/ledger'

it('汇总按账户区分本月 confirmed 收支，日期边界、转账、调整、删除与未确认均排除；query_only 可读', async () => {
  const db = openSchemaDb(':memory:')
  seed(db)
  try {
    const cash = (db.prepare("SELECT id FROM accounts WHERE name='现金'").get() as { id: number }).id
    const bank = (db.prepare("SELECT id FROM accounts WHERE name='银行卡'").get() as { id: number }).id
    const add = (accountId: number, cents: number, type: 'expense' | 'income' | 'transfer' | 'adjustment', when: string, done: boolean, deleted = false) => {
      const id = createTransaction(db, { accountId, amountCents: cents, txType: type, occurredAt: when, toAccountId: type === 'transfer' ? bank : undefined })
      recordParse(db, id, { txType: type, categoryId: type === 'expense' || type === 'income' ? getOrCreateCategoryId(db, '其他', type) : undefined, confidenceScore: 1 })
      if (done) confirm(db, id)
      if (deleted) softDelete(db, id)
    }
    add(cash, 101, 'expense', '2026-02-01T00:00:00+08:00', true)
    add(cash, 202, 'income', '2026-02-28 23:59:59', true)
    add(bank, 303, 'expense', '2026-02-20 12:00:00', true)
    add(cash, 400, 'expense', '2026-01-31 23:59:59', true)
    add(cash, 500, 'income', '2026-03-01T00:00:00+08:00', true)
    add(cash, 600, 'expense', '2026-02-15 12:00:00', false)
    add(cash, 700, 'expense', '2026-02-15 12:00:00', true, true)
    add(cash, 800, 'transfer', '2026-02-15 12:00:00', true)
    add(cash, -900, 'adjustment', '2026-02-15 12:00:00', true)
    const before = db.prepare('SELECT total_changes() AS n').get()
    db.pragma('query_only = ON')
    const { listAccountSummaries } = await import('../src/main/domain/account-summary')
    const result = listAccountSummaries(db, '2026-02')
    expect(result.month).toBe('2026-02')
    expect(result.accounts.map(a => a.id)).toEqual([cash, bank, 3, 4])
    expect(result.accounts.find(a => a.id === cash)).toMatchObject({ name: '现金', kind: 'cash', currency: 'CNY', createdAt: expect.any(String), expenseCents: 101, incomeCents: 202, count: 2 })
    expect(result.accounts.find(a => a.id === bank)).toMatchObject({ expenseCents: 303, incomeCents: 0, count: 1 })
    expect(result.accounts.find(a => a.name === '微信')).toMatchObject({ expenseCents: 0, incomeCents: 0, count: 0 })
    for (const account of result.accounts) expect(Object.keys(account).sort()).toEqual(['id', 'name', 'kind', 'currency', 'createdAt', 'expenseCents', 'incomeCents', 'count'].sort())
    expect(db.prepare('SELECT total_changes() AS n').get()).toEqual(before)
  } finally { db.close() }
})

it.each(['', '2026-00', '2026-13', '2026-2', '26-02', '0000-01', '2026-02-01', ' 2026-02', '2026-02\n', 202602, null, {}, []])('非法月份 %# 只拒绝，不写库', async month => {
  const { listAccountSummaries } = await import('../src/main/domain/account-summary')
  const db = openSchemaDb(':memory:')
  seed(db)
  try {
    const before = db.prepare('SELECT total_changes() AS n').get()
    expect(() => listAccountSummaries(db, month as never)).toThrow(/月份/)
    expect(db.prepare('SELECT total_changes() AS n').get()).toEqual(before)
  } finally { db.close() }
})

it('不传月份用本地自然月而非上月；真正空库仍返回月份与空数组', async () => {
  const { listAccountSummaries } = await import('../src/main/domain/account-summary')
  const db = openSchemaDb(':memory:')
  vi.useFakeTimers()
  try {
    vi.setSystemTime(new Date(2026, 0, 1, 0, 1))
    expect(listAccountSummaries(db)).toEqual({ month: '2026-01', accounts: [] })
    vi.setSystemTime(new Date(2026, 11, 31, 23, 59))
    expect(listAccountSummaries(db)).toEqual({ month: '2026-12', accounts: [] })
  } finally { vi.useRealTimers(); db.close() }
})
