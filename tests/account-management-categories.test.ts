import { expect, it } from 'vitest'
import { openSchemaDb } from './helpers'
import { seed } from '../src/main/db/seed'

function fixture() { const db = openSchemaDb(':memory:'); seed(db); return db }
function state(db: ReturnType<typeof fixture>) {
  return ['categories', 'rules', 'transactions', 'audit_log', 'settings', 'sqlite_sequence'].map(table => db.prepare(`SELECT * FROM ${table}`).all())
}

it('显式创建分类 trim 名称，方向各自唯一，审计与 ID 一起落库', async () => {
  const { createCategory } = await import('../src/main/domain/categories')
  const db = fixture()
  try {
    const expenseId = createCategory(db, { name: '  合成新分类  ', kind: 'expense' })
    const incomeId = createCategory(db, { name: '合成新分类', kind: 'income' })
    expect(expenseId).not.toBe(incomeId)
    expect(db.prepare('SELECT name,kind,parent_id FROM categories WHERE id=?').get(expenseId)).toEqual({ name: '合成新分类', kind: 'expense', parent_id: null })
    const before = state(db)
    expect(() => createCategory(db, { name: ' 合成新分类 ', kind: 'expense' })).toThrow(/已存在/)
    expect(state(db)).toEqual(before)
    const audits = db.prepare("SELECT entity_id,changed_by,change_type,after_value FROM audit_log WHERE entity_type='category' ORDER BY id").all() as { entity_id: number; changed_by: string; change_type: string; after_value: string }[]
    expect(audits.map(a => ({ ...a, after_value: JSON.parse(a.after_value) }))).toEqual([
      { entity_id: expenseId, changed_by: 'user', change_type: 'create', after_value: { name: '合成新分类', kind: 'expense' } },
      { entity_id: incomeId, changed_by: 'user', change_type: 'create', after_value: { name: '合成新分类', kind: 'income' } },
    ])
  } finally { db.close() }
})
it.each([null, [], {}, { name: 42, kind: 'expense' }, { name: '合成类', kind: 'transfer' }, { name: '合成类', kind: null }, { name: '', kind: 'expense' }, { name: ' ', kind: 'income' }, { name: '合成\n类', kind: 'expense' }, { name: '\t合成类', kind: 'income' }, { name: '合成\u007f类', kind: 'expense' }, { name: '名'.repeat(101), kind: 'expense' }])('分类新增运行时拒绝非法输入 %# 且不写库', async input => {
  const { createCategory } = await import('../src/main/domain/categories')
  const db = fixture()
  try {
    const before = state(db)
    expect(() => createCategory(db, input as never)).toThrow()
    expect(state(db)).toEqual(before)
  } finally { db.close() }
})
it('分类创建审计被真实 SQLite trigger 拒绝时全部回滚', async () => {
  const { createCategory } = await import('../src/main/domain/categories')
  const db = fixture()
  try {
    const before = state(db)
    db.exec("CREATE TRIGGER fail_category_create_audit BEFORE INSERT ON audit_log WHEN NEW.entity_type='category' BEGIN SELECT RAISE(ABORT,'synthetic-category-create-audit'); END")
    expect(() => createCategory(db, { name: '合成不应落库', kind: 'expense' })).toThrow('synthetic-category-create-audit')
    expect(state(db)).toEqual(before)
  } finally { db.close() }
})
