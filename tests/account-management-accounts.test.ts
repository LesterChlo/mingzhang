import { describe, expect, it } from 'vitest'
import * as accounts from '../src/main/domain/accounts'
import { createTransaction, recordParse, confirm, getOrCreateCategoryId } from '../src/main/domain/ledger'
import { seed } from '../src/main/db/seed'
import { openSchemaDb } from './helpers'

function fixture() {
  const db = openSchemaDb(':memory:')
  seed(db)
  return db
}
function state(db: ReturnType<typeof fixture>) {
  return ['accounts', 'transactions', 'audit_log', 'sqlite_sequence']
    .map(table => db.prepare(`SELECT * FROM ${table}`).all())
}
function cashId(db: ReturnType<typeof fixture>): number {
  return (db.prepare("SELECT id FROM accounts WHERE name='现金'").get() as { id: number }).id
}

describe('按 ID 改账户名', () => {
  it('保全已有交易引用、金额与账户属性；审计记旧新名称', () => {
    const db = fixture()
    try {
      const id = cashId(db)
      const oldAccount = db.prepare('SELECT * FROM accounts WHERE id=?').get(id) as Record<string, unknown>
      const tx = createTransaction(db, { amountCents: 357, txType: 'expense', accountId: id })
      recordParse(db, tx, { categoryId: getOrCreateCategoryId(db, '餐饮', 'expense'), confidenceScore: 1 })
      confirm(db, tx)
      const beforeTx = db.prepare('SELECT * FROM transactions WHERE id=?').get(tx)
      accounts.renameAccountById(db, { accountId: id, expectedName: '现金', newName: '  合成现金  ' })
      expect(db.prepare('SELECT * FROM transactions WHERE id=?').get(tx)).toEqual(beforeTx)
      expect(db.prepare('SELECT * FROM accounts WHERE id=?').get(id)).toMatchObject({ ...oldAccount, name: '合成现金', updated_at: expect.any(String) })
      const audit = db.prepare("SELECT * FROM audit_log WHERE entity_type='account' AND entity_id=?").get(id) as Record<string, string>
      expect(audit).toMatchObject({ changed_by: 'user', change_type: 'update' })
      expect(JSON.parse(audit.before_value)).toEqual({ name: '现金' })
      expect(JSON.parse(audit.after_value)).toEqual({ name: '合成现金' })
    } finally { db.close() }
  })
  it('过期 expectedName 不写入；刷新后可改名', () => {
    const db = fixture()
    try {
      const id = cashId(db)
      accounts.renameAccountById(db, { accountId: id, expectedName: '现金', newName: '合成现金一' })
      const before = state(db)
      expect(() => accounts.renameAccountById(db, { accountId: id, expectedName: '现金', newName: '合成现金二' })).toThrow(/过期|变更/)
      expect(state(db)).toEqual(before)
      accounts.renameAccountById(db, { accountId: id, expectedName: '合成现金一', newName: '合成现金二' })
      expect(db.prepare('SELECT name FROM accounts WHERE id=?').get(id)).toEqual({ name: '合成现金二' })
    } finally { db.close() }
  })
  it.each([0, -1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1, '1', null, undefined])('拒绝非法 ID %# 且不写库', accountId => {
    const db = fixture()
    try {
      const before = state(db)
      expect(() => accounts.renameAccountById(db, { accountId, expectedName: '现金', newName: '合成名' } as never)).toThrow(/ID|参数/)
      expect(state(db)).toEqual(before)
    } finally { db.close() }
  })
  it.each([null, [], {}, { accountId: 99999, expectedName: '不存在', newName: '合成名' }, { accountId: 1, expectedName: 1, newName: '合成名' }, { accountId: 1, expectedName: ' 现金 ', newName: '合成名' }])('运行时拒绝缺失/不存在/不匹配输入 %#', input => {
    const db = fixture()
    try {
      const before = state(db)
      expect(() => accounts.renameAccountById(db, input as never)).toThrow()
      expect(state(db)).toEqual(before)
    } finally { db.close() }
  })
  it.each(['', ' ', '合成\n名', '合成\u0000名', '名'.repeat(101), ' 微信 '])('新名非法或重复 %# 全库不变', newName => {
    const db = fixture()
    try {
      const before = state(db)
      expect(() => accounts.renameAccountById(db, { accountId: cashId(db), expectedName: '现金', newName })).toThrow()
      expect(state(db)).toEqual(before)
    } finally { db.close() }
  })
  it('审计失败回滚 ID 路径账户与引用', () => {
    const db = fixture()
    try {
      const id = cashId(db)
      createTransaction(db, { amountCents: 421, txType: 'expense', accountId: id })
      const before = state(db)
      db.exec("CREATE TRIGGER fail_id_account_audit BEFORE INSERT ON audit_log WHEN NEW.entity_type='account' BEGIN SELECT RAISE(ABORT,'synthetic-id-account-audit'); END")
      expect(() => accounts.renameAccountById(db, { accountId: id, expectedName: '现金', newName: '合成未落名' })).toThrow('synthetic-id-account-audit')
      expect(state(db)).toEqual(before)
    } finally { db.close() }
  })
  it('原按名称接口也 trim 新名并拒绝空白与重名', () => {
    const db = fixture()
    try {
      const before = state(db)
      expect(() => accounts.renameAccount(db, '现金', ' ')).toThrow()
      expect(() => accounts.renameAccount(db, '现金', ' 微信 ')).toThrow()
      expect(state(db)).toEqual(before)
      accounts.renameAccount(db, '现金', '  合成旧入口  ')
      expect(db.prepare('SELECT name FROM accounts WHERE id=?').get(cashIdFromBefore(before)))
        .toEqual({ name: '合成旧入口' })
    } finally { db.close() }
  })
})

function cashIdFromBefore(before: ReturnType<typeof state>): number {
  return (before[0] as { id: number; name: string }[]).find(a => a.name === '现金')!.id
}
