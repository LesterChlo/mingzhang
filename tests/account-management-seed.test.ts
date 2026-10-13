import { expect, it } from 'vitest'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openSchemaDb } from './helpers'
import { seed } from '../src/main/db/seed'
import { renameAccountById } from '../src/main/domain/accounts'
import { renameCategory } from '../src/main/domain/categories'

function state(db: ReturnType<typeof openSchemaDb>) {
  return ['accounts', 'categories', 'settings', 'audit_log'].map(table => db.prepare(`SELECT * FROM ${table}`).all())
}

it('真正首启仍种 4账户/8分类/3设置，重复seed零新增且全库无变化', () => {
  const db = openSchemaDb(':memory:')
  try {
    expect(seed(db)).toEqual({ accounts: 4, categories: 8, settings: 3 })
    const before = state(db)
    expect(seed(db)).toEqual({ accounts: 0, categories: 0, settings: 0 })
    expect(state(db)).toEqual(before)
  } finally { db.close() }
})
it('默认账户/双方向分类改名后文件重启+seed不复活旧名，保全ID与设置数', () => {
  const file = join(mkdtempSync(join(tmpdir(), 'mz-account-management-restart-')), 'synthetic.db')
  let db = openSchemaDb(file)
  try {
    seed(db)
    renameAccountById(db, { accountId: 1, expectedName: '现金', newName: '合成现金初名' })
    renameAccountById(db, { accountId: 1, expectedName: '合成现金初名', newName: '合成现金最终名' })
    renameCategory(db, { categoryId: 1, expectedName: '餐饮', newName: '合成支出类' })
    renameCategory(db, { categoryId: 8, expectedName: '其他', newName: '合成收入类' })
    const before = state(db)
    const version = db.pragma('user_version', { simple: true })
    db.close()
    db = openSchemaDb(file)
    expect(seed(db)).toEqual({ accounts: 0, categories: 0, settings: 0 })
    expect(state(db)).toEqual(before)
    expect(db.prepare("SELECT id FROM accounts WHERE name='现金'").all()).toEqual([])
    expect(db.prepare("SELECT id FROM categories WHERE name='餐饮' AND kind='expense'").all()).toEqual([])
    expect(db.prepare("SELECT id FROM categories WHERE name='其他' AND kind='income'").all()).toEqual([])
    expect(db.prepare("SELECT id FROM categories WHERE name='其他' AND kind='expense'").all()).toEqual([{ id: 5 }])
    expect(db.pragma('user_version', { simple: true })).toBe(version)
  } finally { db.close() }
})
it('已初始化旧库使用原按名改账户的审计格式也可识别，坏JSON审计不导致启动失败', () => {
  const db = openSchemaDb(':memory:')
  try {
    seed(db)
    db.prepare("UPDATE accounts SET name='合成旧库卡' WHERE id=2").run()
    db.prepare("INSERT INTO audit_log (entity_type,entity_id,changed_by,change_type,before_value,after_value,changed_at) VALUES ('account',2,'user','update',?,?,?)")
      .run(JSON.stringify({ name: '银行卡' }), JSON.stringify({ name: '合成旧库卡' }), '2026-01-01T12:00:00+08:00')
    db.prepare("INSERT INTO audit_log (entity_type,entity_id,changed_by,change_type,before_value,after_value,changed_at) VALUES ('category',9999,'user','update',?,?,?)")
      .run('{synthetic-invalid', '{synthetic-invalid', '2026-01-01T12:00:00+08:00')
    const before = state(db)
    expect(seed(db)).toEqual({ accounts: 0, categories: 0, settings: 0 })
    expect(state(db)).toEqual(before)
  } finally { db.close() }
})
it('旧库从未种过的咖啡/交通分类仍补齐，不因已有表非空一刀切跳过seed', () => {
  const db = openSchemaDb(':memory:')
  try {
    // 合成旧版初始化库：6分类，无咖啡/交通，原默认设置与账户已存在。
    const ts = '2026-01-01T12:00:00+08:00'
    const insert = db.prepare('INSERT INTO categories(name,kind,created_at,updated_at) VALUES (?,?,?,?)')
    for (const [name, kind] of [['餐饮', 'expense'], ['购物', 'expense'], ['其他', 'expense'], ['生活费', 'income'], ['红包', 'income'], ['其他', 'income']]) insert.run(name, kind, ts, ts)
    expect(seed(db)).toEqual({ accounts: 4, categories: 2, settings: 3 })
    expect(seed(db)).toEqual({ accounts: 0, categories: 0, settings: 0 })
    expect(db.prepare("SELECT name FROM categories WHERE kind='expense' ORDER BY name").all()).toHaveLength(5)
  } finally { db.close() }
})
