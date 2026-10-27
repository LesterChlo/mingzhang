// Parent-frozen contract for issue #25. Synthetic SQLite only.
import { describe, expect, it } from 'vitest'
import { openSchemaDb } from './helpers'
import { seed } from '../src/main/db/seed'
import { createAccount, renameAccount } from '../src/main/domain/accounts'
import { createTransaction, recordParse, confirm, getOrCreateCategoryId } from '../src/main/domain/ledger'
import { createRule, matchRule } from '../src/main/domain/rules'

function fixture() { const db = openSchemaDb(':memory:'); seed(db); return db }
function state(db: ReturnType<typeof fixture>) {
  return ['accounts', 'categories', 'transactions', 'rules', 'audit_log'].map(t => db.prepare(`SELECT * FROM ${t} ORDER BY id`).all())
}

describe('账户管理 · 父冻结验收', () => {
  it('空白名称拒绝且不改库；合法账户仍能创建', () => {
    const db = fixture()
    try {
      const before = state(db)
      expect(() => createAccount(db, { name: '  \t ', type: 'bank' })).toThrow()
      expect(state(db)).toEqual(before)
      const id = createAccount(db, { name: '演示新卡', type: 'bank' })
      expect(db.prepare('SELECT name FROM accounts WHERE id=?').get(id)).toEqual({ name: '演示新卡' })
    } finally { db.close() }
  })
  it('账户新增时审计失败：账户与审计全部回滚', () => {
    const db = fixture()
    try {
      const before = state(db)
      db.exec("CREATE TRIGGER fail_account_audit BEFORE INSERT ON audit_log WHEN NEW.entity_type='account' BEGIN SELECT RAISE(ABORT,'synthetic-account-audit'); END")
      expect(() => createAccount(db, { name: '不应残留', type: 'cash' })).toThrow('synthetic-account-audit')
      expect(state(db)).toEqual(before)
    } finally { db.close() }
  })
  it('账户改名时审计失败：旧名称及引用保全', () => {
    const db = fixture()
    try {
      createTransaction(db, { amountCents: 810, txType: 'expense', merchant: '合成小店' })
      const before = state(db)
      db.exec("CREATE TRIGGER fail_account_audit BEFORE INSERT ON audit_log WHEN NEW.entity_type='account' BEGIN SELECT RAISE(ABORT,'synthetic-rename-audit'); END")
      expect(() => renameAccount(db, '现金', '现金新名')).toThrow('synthetic-rename-audit')
      expect(state(db)).toEqual(before)
    } finally { db.close() }
  })
  it('已记流水只含本月confirmed收支，不冒充余额；空账户保留', async () => {
    const db = fixture()
    try {
      const mk = (cents: number, type: 'expense'|'income', when: string, confirmed: boolean) => {
        const id = createTransaction(db, { amountCents: cents, txType: type, occurredAt: when })
        recordParse(db, id, { txType: type, categoryId: getOrCreateCategoryId(db, '其他', type), confidenceScore: 1 })
        if (confirmed) confirm(db, id)
      }
      mk(1234, 'expense', '2026-06-15 10:00:00', true)
      mk(4500, 'income', '2026-06-16 11:00:00', true)
      mk(9900, 'expense', '2026-05-01 10:00:00', true)
      mk(700, 'expense', '2026-06-17 12:00:00', false)
      createAccount(db, { name: '空账户', type: 'bank' })
      const before = state(db)
      const { listAccountSummaries } = await import('../src/main/domain/account-summary')
      const summary = listAccountSummaries(db, '2026-06')
      const cash = summary.accounts.find(a => a.name === '现金')!
      expect(summary.month).toBe('2026-06')
      expect(cash).toMatchObject({ expenseCents: 1234, incomeCents: 4500, count: 2 })
      expect(cash).not.toHaveProperty('balanceCents')
      expect(summary.accounts.find(a => a.name === '空账户')).toMatchObject({ expenseCents: 0, incomeCents: 0, count: 0 })
      expect(() => listAccountSummaries(db, '2026-13')).toThrow()
      expect(state(db)).toEqual(before)
    } finally { db.close() }
  })
  it('分类改名保持ID/历史金额，方向规则跟随且不污染反方向同名分类', async () => {
    const db = fixture()
    try {
      const { createCategory, renameCategory } = await import('../src/main/domain/categories')
      const expenseId = createCategory(db, { name: '自定义类', kind: 'expense' })
      const incomeId = createCategory(db, { name: '自定义类', kind: 'income' })
      const expenseRule = createRule(db, { match: 'merchant', op: 'equals', value: '合成甲', direction: 'expense' }, { set_category: '自定义类' })
      const incomeRule = createRule(db, { match: 'merchant', op: 'equals', value: '合成乙', direction: 'income' }, { set_category: '自定义类' })
      const tx = createTransaction(db, { amountCents: 3700, txType: 'expense' })
      recordParse(db, tx, { txType: 'expense', categoryId: expenseId, confidenceScore: 1 }); confirm(db, tx)
      const oldTx = db.prepare('SELECT * FROM transactions WHERE id=?').get(tx)
      renameCategory(db, { categoryId: expenseId, expectedName: '自定义类', newName: '新支出类' })
      expect(db.prepare('SELECT * FROM transactions WHERE id=?').get(tx)).toEqual(oldTx)
      expect(db.prepare('SELECT id,name FROM categories WHERE id=?').get(expenseId)).toEqual({ id: expenseId, name: '新支出类' })
      expect(db.prepare('SELECT id,name FROM categories WHERE id=?').get(incomeId)).toEqual({ id: incomeId, name: '自定义类' })
      expect(JSON.parse(matchRule(db, '合成甲', 'expense')!.action).set_category).toBe('新支出类')
      expect(JSON.parse(matchRule(db, '合成乙', 'income')!.action).set_category).toBe('自定义类')
      expect(db.prepare("SELECT entity_id FROM audit_log WHERE entity_type='rule' AND change_type='update' ORDER BY id").all()).toContainEqual({ entity_id: expenseRule })
      expect(db.prepare("SELECT entity_id FROM audit_log WHERE entity_type='rule' AND change_type='update' ORDER BY id").all()).not.toContainEqual({ entity_id: incomeRule })
    } finally { db.close() }
  })
})
