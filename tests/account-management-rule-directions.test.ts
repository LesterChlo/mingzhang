import { expect, it } from 'vitest'
import { openSchemaDb } from './helpers'
import { seed } from '../src/main/db/seed'
import { createCategory, renameCategory } from '../src/main/domain/categories'
import { createRule, deactivateRule } from '../src/main/domain/rules'

function fixture() { const db = openSchemaDb(':memory:'); seed(db); return db }
function state(db: ReturnType<typeof fixture>) {
  return ['categories', 'rules', 'audit_log', 'sqlite_sequence'].map(table => db.prepare(`SELECT * FROM ${table}`).all())
}
function action(db: ReturnType<typeof fixture>, id: number): string {
  return (db.prepare('SELECT action FROM rules WHERE id=?').get(id) as { action: string }).action
}

it('旧无 direction 规则原名与新名均唯一时迁移 action 并审计，condition 不变', () => {
  const db = fixture()
  try {
    const id = createCategory(db, { name: '合成旧唯一类', kind: 'income' })
    const r = createRule(db, { match: 'merchant', op: 'equals', value: '合成旧唯一店' }, { set_category: '合成旧唯一类' })
    const condition = (db.prepare('SELECT condition FROM rules WHERE id=?').get(r) as { condition: string }).condition
    renameCategory(db, { categoryId: id, expectedName: '合成旧唯一类', newName: '合成新唯一类' })
    expect(JSON.parse(action(db, r))).toEqual({ set_category: '合成新唯一类' })
    expect(db.prepare('SELECT condition FROM rules WHERE id=?').get(r)).toEqual({ condition })
    expect(db.prepare("SELECT entity_id FROM audit_log WHERE entity_type='rule' AND change_type='update'").all()).toEqual([{ entity_id: r }])
  } finally { db.close() }
})
it('旧无方向规则引用两方向同名时可读拒绝且无任何写入；停用旧习惯后可改且不迁移歧义停用规则', () => {
  const db = fixture()
  try {
    const id = createCategory(db, { name: '合成歧义类', kind: 'expense' })
    const opposite = createCategory(db, { name: '合成歧义类', kind: 'income' })
    const legacy = createRule(db, { match: 'merchant', op: 'equals', value: '合成旧习惯' }, { set_category: '合成歧义类' })
    const direct = createRule(db, { match: 'merchant', op: 'equals', value: '合成新习惯', direction: 'expense' }, { set_category: '合成歧义类' })
    const before = state(db)
    expect(() => renameCategory(db, { categoryId: id, expectedName: '合成歧义类', newName: '合成支出新名' })).toThrow(/旧.*习惯|习惯.*方向/)
    expect(state(db)).toEqual(before)
    deactivateRule(db, legacy)
    const beforeLegacy = db.prepare('SELECT * FROM rules WHERE id=?').get(legacy)
    renameCategory(db, { categoryId: id, expectedName: '合成歧义类', newName: '合成支出新名' })
    expect(db.prepare('SELECT * FROM rules WHERE id=?').get(legacy)).toEqual(beforeLegacy)
    expect(db.prepare('SELECT id,name FROM categories WHERE id=?').get(opposite)).toEqual({ id: opposite, name: '合成歧义类' })
    expect(JSON.parse(action(db, direct)).set_category).toBe('合成支出新名')
  } finally { db.close() }
})
it('旧无方向规则改向反方向既有同名的新名时拒绝，防止规则覆盖范围扩大', () => {
  const db = fixture()
  try {
    const id = createCategory(db, { name: '合成支出独有', kind: 'expense' })
    createCategory(db, { name: '合成新名收入', kind: 'income' })
    createRule(db, { match: 'merchant', op: 'equals', value: '合成防扩大' }, { set_category: '合成支出独有' })
    const before = state(db)
    expect(() => renameCategory(db, { categoryId: id, expectedName: '合成支出独有', newName: '合成新名收入' })).toThrow(/旧.*习惯|习惯.*方向/)
    expect(state(db)).toEqual(before)
  } finally { db.close() }
})
it('收入改名可与反方向同名；只迁移 income 明确规则，不动 expense 同名规则', () => {
  const db = fixture()
  try {
    const income = createCategory(db, { name: '合成双向原名', kind: 'income' })
    createCategory(db, { name: '合成双向原名', kind: 'expense' })
    createCategory(db, { name: '合成收入新名', kind: 'expense' })
    const inRule = createRule(db, { match: 'merchant', op: 'equals', value: '合成收款店', direction: 'income' }, { set_category: '合成双向原名' })
    const outRule = createRule(db, { match: 'merchant', op: 'equals', value: '合成付款店', direction: 'expense' }, { set_category: '合成双向原名' })
    const beforeOut = db.prepare('SELECT * FROM rules WHERE id=?').get(outRule)
    renameCategory(db, { categoryId: income, expectedName: '合成双向原名', newName: '合成收入新名' })
    expect(JSON.parse(action(db, inRule)).set_category).toBe('合成收入新名')
    expect(db.prepare('SELECT * FROM rules WHERE id=?').get(outRule)).toEqual(beforeOut)
  } finally { db.close() }
})
it.each(['null', '[]', '42', '{synthetic-broken', '{"match":"merchant","op":"equals","value":"合成","direction":"transfer"}', '{"match":"merchant","op":"no","value":"合成","direction":"expense"}'])('坏或无关condition %# 不改规则也不阻止合法改名', condition => {
  const db = fixture()
  try {
    const id = createCategory(db, { name: '合成坏规则类', kind: 'expense' })
    const r = createRule(db, { match: 'merchant', op: 'equals', value: '合成坏规则店', direction: 'expense' }, { set_category: '合成坏规则类' })
    db.prepare('UPDATE rules SET condition=? WHERE id=?').run(condition, r)
    const before = db.prepare('SELECT * FROM rules WHERE id=?').get(r)
    renameCategory(db, { categoryId: id, expectedName: '合成坏规则类', newName: '合成坏规则新类' })
    expect(db.prepare('SELECT * FROM rules WHERE id=?').get(r)).toEqual(before)
    expect(db.prepare("SELECT id FROM audit_log WHERE entity_type='rule' AND change_type='update'").all()).toEqual([])
  } finally { db.close() }
})
