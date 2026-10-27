import { expect, it } from 'vitest'
import { openSchemaDb } from './helpers'
import { seed } from '../src/main/db/seed'
import { createCategory } from '../src/main/domain/categories'
import { createRule } from '../src/main/domain/rules'
import { createTransaction, recordParse, confirm } from '../src/main/domain/ledger'
import { createPending } from '../src/main/domain/pending'

function fixture() { const db = openSchemaDb(':memory:'); seed(db); return db }
function state(db: ReturnType<typeof fixture>) {
  return ['categories', 'rules', 'transactions', 'audit_log', 'settings', 'pending_clarifications', 'sqlite_sequence'].map(table => db.prepare(`SELECT * FROM ${table}`).all())
}
function rule(db: ReturnType<typeof fixture>, merchant: string, name: string, direction?: 'expense' | 'income') {
  return createRule(db, { match: 'merchant', op: 'equals', value: merchant, ...(direction ? { direction } : {}) }, { set_category: name })
}

it('改分类名保持 ID/方向/交易与历史payload；仅更新匹配规则action字段且逐条审计', async () => {
  const { renameCategory } = await import('../src/main/domain/categories')
  const db = fixture()
  try {
    const id = createCategory(db, { name: '合成原类', kind: 'expense' })
    const target = rule(db, '合成商户甲', '合成原类', 'expense')
    const dormant = rule(db, '合成商户乙', '合成原类', 'expense')
    const opposite = rule(db, '合成商户丙', '合成原类', 'income')
    const other = rule(db, '合成商户丁', '餐饮', 'expense')
    const broken = rule(db, '合成坏JSON', '合成原类', 'expense')
    const brokenCondition = rule(db, '合成坏条件', '合成原类', 'expense')
    const unrelated = rule(db, '合成无关动作', '合成原类', 'expense')
    db.prepare('UPDATE rules SET action=?,hit_count=7 WHERE id=?').run(JSON.stringify({ set_category: '合成原类', note: '合成原类', extra: { text: '合成原类' } }), target)
    db.prepare('UPDATE rules SET active=0,provenance=? WHERE id=?').run('learned_from_correction', dormant)
    db.prepare('UPDATE rules SET action=? WHERE id=?').run('{synthetic-broken', broken)
    db.prepare('UPDATE rules SET condition=? WHERE id=?').run('{synthetic-condition', brokenCondition)
    db.prepare('UPDATE rules SET action=? WHERE id=?').run(JSON.stringify({ note: '合成原类', extra: { set_category: '合成原类' } }), unrelated)
    const tx = createTransaction(db, { amountCents: 2468, txType: 'expense' })
    recordParse(db, tx, { categoryId: id, confidenceScore: 1 }); confirm(db, tx)
    createPending(db, { sessionId: 'synthetic', field: 'synthetic-historical', question: '合成原类', payload: { set_category: '合成原类' } })
    const beforeTx = db.prepare('SELECT * FROM transactions').all()
    const beforePending = db.prepare('SELECT * FROM pending_clarifications').all()
    const beforeAudits = db.prepare('SELECT * FROM audit_log ORDER BY id').all()
    const untouched = [opposite, other, broken, brokenCondition, unrelated].map(ruleId => db.prepare('SELECT * FROM rules WHERE id=?').get(ruleId))
    const beforeTarget = db.prepare('SELECT * FROM rules WHERE id=?').get(target) as Record<string, unknown>
    const beforeDormant = db.prepare('SELECT * FROM rules WHERE id=?').get(dormant) as Record<string, unknown>
    renameCategory(db, { categoryId: id, expectedName: '合成原类', newName: '  合成新类  ' })
    expect(db.prepare('SELECT id,name,kind FROM categories WHERE id=?').get(id)).toEqual({ id, name: '合成新类', kind: 'expense' })
    expect(db.prepare('SELECT * FROM transactions').all()).toEqual(beforeTx)
    expect(db.prepare('SELECT * FROM pending_clarifications').all()).toEqual(beforePending)
    expect(db.prepare('SELECT * FROM audit_log ORDER BY id').all().slice(0, beforeAudits.length)).toEqual(beforeAudits)
    expect([opposite, other, broken, brokenCondition, unrelated].map(ruleId => db.prepare('SELECT * FROM rules WHERE id=?').get(ruleId))).toEqual(untouched)
    expect(db.prepare('SELECT * FROM rules WHERE id=?').get(target)).toMatchObject({ ...beforeTarget, action: JSON.stringify({ set_category: '合成新类', note: '合成原类', extra: { text: '合成原类' } }), updated_at: expect.any(String) })
    expect(db.prepare('SELECT * FROM rules WHERE id=?').get(dormant)).toMatchObject({ ...beforeDormant, action: JSON.stringify({ set_category: '合成新类' }), updated_at: expect.any(String) })
    const newAudits = db.prepare('SELECT entity_type,entity_id,changed_by,change_type,before_value,after_value FROM audit_log ORDER BY id').all().slice(beforeAudits.length) as { entity_type: string; entity_id: number; changed_by: string; change_type: string; before_value: string; after_value: string }[]
    expect(newAudits.map(a => [a.entity_type, a.entity_id, a.changed_by, a.change_type])).toEqual([
      ['category', id, 'user', 'update'], ['rule', target, 'user', 'update'], ['rule', dormant, 'user', 'update'],
    ])
    expect(JSON.parse(newAudits[1].before_value).action.set_category).toBe('合成原类')
    expect(JSON.parse(newAudits[1].after_value).action.set_category).toBe('合成新类')
  } finally { db.close() }
})
it.each([0, -1, 1.1, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1, '1', null, undefined])('分类改名非法ID %# 全库不变', async categoryId => {
  const { renameCategory } = await import('../src/main/domain/categories')
  const db = fixture()
  try {
    const before = state(db)
    expect(() => renameCategory(db, { categoryId, expectedName: '餐饮', newName: '合成名' } as never)).toThrow(/ID|参数/)
    expect(state(db)).toEqual(before)
  } finally { db.close() }
})
it.each([null, [], {}, { categoryId: 99999, expectedName: '不存在', newName: '合成名' }, { categoryId: 1, expectedName: 42, newName: '合成名' }, { categoryId: 1, expectedName: ' 餐饮 ', newName: '合成名' }])('分类改名非法对象/不存在/旧名不匹配 %# 全库不变', async input => {
  const { renameCategory } = await import('../src/main/domain/categories')
  const db = fixture()
  try {
    const before = state(db)
    expect(() => renameCategory(db, input as never)).toThrow()
    expect(state(db)).toEqual(before)
  } finally { db.close() }
})
it.each(['', ' ', '\n合成名', '合成\u0000名', '名'.repeat(101), ' 咖啡 '])('分类改名非法名称/同向重名 %# 全库不变', async newName => {
  const { renameCategory } = await import('../src/main/domain/categories')
  const db = fixture()
  try {
    const before = state(db)
    expect(() => renameCategory(db, { categoryId: 1, expectedName: '餐饮', newName })).toThrow()
    expect(state(db)).toEqual(before)
  } finally { db.close() }
})
it('分类过期名称拒绝，刷新后可继续；同名不写审计', async () => {
  const { renameCategory } = await import('../src/main/domain/categories')
  const db = fixture()
  try {
    const id = createCategory(db, { name: '合成初名', kind: 'income' })
    renameCategory(db, { categoryId: id, expectedName: '合成初名', newName: '合成次名' })
    const before = state(db)
    expect(() => renameCategory(db, { categoryId: id, expectedName: '合成初名', newName: '合成终名' })).toThrow(/过期|变更/)
    expect(state(db)).toEqual(before)
    renameCategory(db, { categoryId: id, expectedName: '合成次名', newName: ' 合成次名 ' })
    expect(state(db)).toEqual(before)
    renameCategory(db, { categoryId: id, expectedName: '合成次名', newName: '合成终名' })
    expect(db.prepare('SELECT name FROM categories WHERE id=?').get(id)).toEqual({ name: '合成终名' })
  } finally { db.close() }
})
it('分类第一审计失败回滚全部', async () => {
  const { renameCategory } = await import('../src/main/domain/categories')
  const db = fixture()
  try {
    rule(db, '合成审计店', '餐饮', 'expense')
    const before = state(db)
    db.exec("CREATE TRIGGER fail_category_rename_audit BEFORE INSERT ON audit_log WHEN NEW.entity_type='category' BEGIN SELECT RAISE(ABORT,'synthetic-category-rename-audit'); END")
    expect(() => renameCategory(db, { categoryId: 1, expectedName: '餐饮', newName: '合成食物' })).toThrow('synthetic-category-rename-audit')
    expect(state(db)).toEqual(before)
  } finally { db.close() }
})
it('分类审计之后的第二审计（首条规则审计）失败也全部回滚', async () => {
  const { renameCategory } = await import('../src/main/domain/categories')
  const db = fixture()
  try {
    rule(db, '合成第二审计店', '餐饮', 'expense')
    const before = state(db)
    db.exec("CREATE TRIGGER fail_first_rule_update_audit BEFORE INSERT ON audit_log WHEN NEW.entity_type='rule' AND NEW.change_type='update' BEGIN SELECT RAISE(ABORT,'synthetic-second-audit'); END")
    expect(() => renameCategory(db, { categoryId: 1, expectedName: '餐饮', newName: '合成第二审计新类' })).toThrow('synthetic-second-audit')
    expect(state(db)).toEqual(before)
  } finally { db.close() }
})
it('第二规则审计失败：分类、两条规则、前面已写审计全部原子回滚', async () => {
  const { renameCategory } = await import('../src/main/domain/categories')
  const db = fixture()
  try {
    rule(db, '合成第一店', '餐饮', 'expense')
    const second = rule(db, '合成第二店', '餐饮', 'expense')
    const before = state(db)
    db.exec(`CREATE TRIGGER fail_second_rule_audit BEFORE INSERT ON audit_log WHEN NEW.entity_type='rule' AND NEW.entity_id=${second} AND NEW.change_type='update' BEGIN SELECT RAISE(ABORT,'synthetic-second-rule-audit'); END`)
    expect(() => renameCategory(db, { categoryId: 1, expectedName: '餐饮', newName: '合成食物' })).toThrow('synthetic-second-rule-audit')
    expect(state(db)).toEqual(before)
  } finally { db.close() }
})
