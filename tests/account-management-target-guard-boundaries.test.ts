import { expect, it } from 'vitest'
import { openSchemaDb } from './helpers'
import { seed } from '../src/main/db/seed'
import { createCategory, renameCategory } from '../src/main/domain/categories'
import { createRule, resolveRuleMatch } from '../src/main/domain/rules'
import { createTransaction, recordParse, confirm } from '../src/main/domain/ledger'

type Mode = 'create' | 'rename'
const modes: Mode[] = ['create', 'rename']
const guardMessage = '旧分类习惯缺少收支方向且同名有歧义，请先停用旧习惯，再按方向重新保存'

function fixture() {
  const db = openSchemaDb(':memory:')
  seed(db)
  const original = '合成边界原类', target = '合成边界目标类'
  const id = createCategory(db, { name: original, kind: 'income' })
  const opposite = createCategory(db, { name: target, kind: 'expense' })
  const tx = createTransaction(db, { amountCents: 2345, txType: 'income', merchant: '合成历史不同商户' })
  recordParse(db, tx, { categoryId: id, confidenceScore: 1 })
  confirm(db, tx)
  const mutate = (mode: Mode) => mode === 'create'
    ? createCategory(db, { name: `  ${target}  `, kind: 'income' })
    : (renameCategory(db, { categoryId: id, expectedName: original, newName: `  ${target}  ` }), id)
  const facts = () => ['categories', 'rules', 'transactions', 'audit_log', 'settings', 'pending_clarifications', 'sqlite_sequence']
    .map(table => db.prepare(`SELECT * FROM ${table}`).all())
  return { db, id, opposite, target, mutate, facts }
}

it.each(modes)('%s：trim目标及action的contains旧习惯须在分类/审计写入前拒绝，商户不必是当前历史商户', mode => {
  const f = fixture()
  try {
    const rule = createRule(f.db, { match: 'merchant', op: 'contains', value: '  合成另一商户片段  ' }, { set_category: f.target })
    f.db.prepare('UPDATE rules SET action=? WHERE id=?')
      .run(JSON.stringify({ set_category: `  ${f.target}  `, note: '合成保留字节', extra: { keep: true } }), rule)
    f.db.exec("CREATE TRIGGER synthetic_guard_insert BEFORE INSERT ON categories BEGIN SELECT RAISE(ABORT,'synthetic-category-write'); END")
    f.db.exec("CREATE TRIGGER synthetic_guard_update BEFORE UPDATE ON categories BEGIN SELECT RAISE(ABORT,'synthetic-category-write'); END")
    f.db.exec("CREATE TRIGGER synthetic_guard_audit BEFORE INSERT ON audit_log BEGIN SELECT RAISE(ABORT,'synthetic-audit-write'); END")
    const before = f.facts()
    expect(() => f.mutate(mode)).toThrow(guardMessage)
    expect(f.facts()).toEqual(before)
  } finally { f.db.close() }
})

it.each(modes)('%s：目标名习惯显式本向允许生效，不猜方向、不改规则字节和历史', mode => {
  const f = fixture()
  try {
    const merchant = '合成显式本向商户'
    createRule(f.db, { match: 'merchant', op: 'equals', value: merchant, direction: 'income' }, { set_category: f.target })
    const beforeRules = f.db.prepare('SELECT * FROM rules').all()
    const beforeTx = f.db.prepare('SELECT * FROM transactions').all()
    expect(resolveRuleMatch(f.db, merchant, 'income').status).toBe('invalid')
    const id = f.mutate(mode)
    expect(f.db.prepare('SELECT id,name,kind FROM categories WHERE id=?').get(id)).toEqual({ id, name: f.target, kind: 'income' })
    expect(id).not.toBe(f.opposite)
    expect(resolveRuleMatch(f.db, merchant, 'income').status).toBe('matched')
    expect(f.db.prepare('SELECT * FROM rules').all()).toEqual(beforeRules)
    expect(f.db.prepare('SELECT * FROM transactions').all()).toEqual(beforeTx)
  } finally { f.db.close() }
})

it.each(modes)('%s：坏JSON、空商户和无关action不平白拦截目标同名，也不重写旧规则', mode => {
  const f = fixture()
  try {
    const condition = { match: 'merchant', op: 'equals', value: '合成无关商户' } as const
    const unrelated = createCategory(f.db, { name: '合成无关唯一类', kind: 'income' })
    const cases = [
      { condition: '{synthetic-broken', action: JSON.stringify({ set_category: f.target }) },
      { condition: JSON.stringify({ ...condition, value: '合成坏动作商户' }), action: '{synthetic-broken' },
      { condition: JSON.stringify({ ...condition, value: '  ' }), action: JSON.stringify({ set_category: f.target }) },
      { condition: JSON.stringify({ ...condition, value: '合成无关分类商户' }), action: JSON.stringify({ set_category: '合成无关唯一类' }) },
    ]
    for (const [index, row] of cases.entries()) {
      const rule = createRule(f.db, { ...condition, value: `合成插入夹具${index}` }, { set_category: f.target })
      f.db.prepare('UPDATE rules SET condition=?,action=? WHERE id=?').run(row.condition, row.action, rule)
    }
    const beforeRules = f.db.prepare('SELECT * FROM rules').all()
    const beforeTx = f.db.prepare('SELECT * FROM transactions').all()
    const beforeAudits = f.db.prepare('SELECT * FROM audit_log ORDER BY id').all()
    const id = f.mutate(mode)
    expect(f.db.prepare('SELECT id,name,kind FROM categories WHERE id=?').get(id)).toEqual({ id, name: f.target, kind: 'income' })
    expect(id).not.toBe(f.opposite)
    expect(f.db.prepare('SELECT name FROM categories WHERE id=?').get(unrelated)).toEqual({ name: '合成无关唯一类' })
    expect(f.db.prepare('SELECT * FROM rules').all()).toEqual(beforeRules)
    expect(f.db.prepare('SELECT * FROM transactions').all()).toEqual(beforeTx)
    const afterAudits = f.db.prepare('SELECT * FROM audit_log ORDER BY id').all()
    expect(afterAudits.slice(0, beforeAudits.length)).toEqual(beforeAudits)
    expect(afterAudits.slice(beforeAudits.length)).toEqual([expect.objectContaining({
      entity_type: 'category', entity_id: id, change_type: mode === 'create' ? 'create' : 'update',
    })])
  } finally { f.db.close() }
})
