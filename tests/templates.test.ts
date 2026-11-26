// 第八阶段：快捷记账模板测试。
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import DatabaseCtor from 'better-sqlite3-multiple-ciphers'
import type { Database } from 'better-sqlite3-multiple-ciphers'
import schemaSql from '../src/main/db/schema.sql?raw'
import { runMigrations } from '../src/main/db/migrations'
import { seedBusiness } from '../src/main/db/seed-business'
import { listProducts, listVariants, createVariant } from '../src/main/domain/business'
import {
  listTemplates, getTemplate, createTemplate, updateTemplate, deleteTemplate, touchTemplate, templateCounts,
} from '../src/main/domain/templates'

function makeDb(): Database {
  const db = new DatabaseCtor(':memory:')
  db.exec(schemaSql as string)
  runMigrations(db)
  seedBusiness(db)
  return db
}

// 第十阶段起商品不再预置规格，测试需要时按名取、没有就建（保证用例自洽）。
function variantOf(db: Database, productName: string, specName: string) {
  const p = listProducts(db).find((x) => x.name === productName)!
  let v = listVariants(db, p.id).find((x) => x.spec_name === specName)
  if (!v) {
    const id = createVariant(db, { product_id: p.id, spec_name: specName, standard_price_cents: 1000 })
    v = listVariants(db, p.id).find((x) => x.id === id)!
  }
  return { product: p, variant: v }
}

describe('快捷记账模板 · 第八阶段', () => {
  let db: Database
  beforeEach(() => { db = makeDb() })
  afterEach(() => { db.close() })

  it('v5 迁移给 quick_templates 补上 variant_id 与 use_count', () => {
    const cols = db.prepare("PRAGMA table_info('quick_templates')").all() as unknown as { name: string }[]
    expect(cols.some((c) => c.name === 'variant_id')).toBe(true)
    expect(cols.some((c) => c.name === 'use_count')).toBe(true)
    expect(db.pragma('user_version', { simple: true })).toBe(6)
  })

  it('新建 / 读取 / 列表', () => {
    const { product, variant } = variantOf(db, '猫粮', '1kg 装')
    const id = createTemplate(db, {
      name: '猫粮1kg常卖', kind: 'sale',
      product_id: product.id, variant_id: variant.id,
      channel: '微信收入', default_qty: 1, default_price_cents: 1000,
    })
    const t = getTemplate(db, id)!
    expect(t.name).toBe('猫粮1kg常卖')
    expect(t.kind).toBe('sale')
    expect(t.variant_name).toBe('1kg 装')
    expect(t.product_name).toBe('猫粮')
    expect(t.use_count).toBe(0)
    expect(listTemplates(db)).toHaveLength(1)
  })

  it('同名同类型拒绝，不同名可建', () => {
    createTemplate(db, { name: '模板A', kind: 'sale' })
    expect(() => createTemplate(db, { name: '模板A', kind: 'sale' })).toThrow(/已存在同名/)
    // 不同类型可以用同名
    expect(() => createTemplate(db, { name: '模板A', kind: 'purchase' })).not.toThrow()
  })

  it('模板类型非法拒绝', () => {
    expect(() => createTemplate(db, { name: 'X', kind: 'bad' as never })).toThrow(/模板类型无效/)
  })

  it('规格与商品不匹配拒绝', () => {
    const cat = variantOf(db, '猫粮', '1kg 装')
    const card = variantOf(db, '月卡', '1 个月卡')
    expect(() => createTemplate(db, {
      name: '错配', kind: 'sale',
      product_id: cat.product.id, variant_id: card.variant.id,
    })).toThrow(/规格与商品不匹配/)
  })

  it('修改模板名称/渠道/数量', () => {
    const id = createTemplate(db, { name: '旧名', kind: 'sale', channel: '微信收入', default_qty: 1 })
    updateTemplate(db, { id, name: '新名', channel: '支付宝收入', default_qty: 3 })
    const t = getTemplate(db, id)!
    expect(t.name).toBe('新名')
    expect(t.channel).toBe('支付宝收入')
    expect(t.default_qty).toBe(3)
  })

  it('删模板', () => {
    const id = createTemplate(db, { name: '待删', kind: 'sale' })
    deleteTemplate(db, id)
    expect(getTemplate(db, id)).toBeNull()
    expect(() => deleteTemplate(db, id)).toThrow(/不存在/)
  })

  it('使用次数累加后排序：常用优先', () => {
    const a = createTemplate(db, { name: '模板A', kind: 'sale' })
    const b = createTemplate(db, { name: '模板B', kind: 'sale' })
    const c = createTemplate(db, { name: '模板C', kind: 'sale' })
    // 默认按 id 降序（新建在前）→ C, B, A
    expect(listTemplates(db).map((t) => t.name)).toEqual(['模板C', '模板B', '模板A'])
    // B 用 3 次，A 用 1 次 → B, A, C
    touchTemplate(db, b); touchTemplate(db, b); touchTemplate(db, b)
    touchTemplate(db, a)
    expect(listTemplates(db).map((t) => t.name)).toEqual(['模板B', '模板A', '模板C'])
    expect(getTemplate(db, b)!.use_count).toBe(3)
    expect(getTemplate(db, c)!.use_count).toBe(0)
  })

  it('按类型过滤', () => {
    createTemplate(db, { name: '销售1', kind: 'sale' })
    createTemplate(db, { name: '销售2', kind: 'sale' })
    createTemplate(db, { name: '进货1', kind: 'purchase' })
    createTemplate(db, { name: '支出1', kind: 'expense' })

    expect(listTemplates(db, 'sale')).toHaveLength(2)
    expect(listTemplates(db, 'purchase')).toHaveLength(1)
    expect(listTemplates(db, 'refund')).toHaveLength(0)
    expect(listTemplates(db)).toHaveLength(4)
  })

  it('各类型计数', () => {
    createTemplate(db, { name: 's1', kind: 'sale' })
    createTemplate(db, { name: 's2', kind: 'sale' })
    createTemplate(db, { name: 'p1', kind: 'purchase' })
    const counts = templateCounts(db)
    expect(counts.sale).toBe(2)
    expect(counts.purchase).toBe(1)
    expect(counts.expense).toBe(0)
    expect(counts.refund).toBe(0)
  })

  it('v4 → v5 增量迁移：老库（无 variant_id/use_count）升级安全', () => {
    const old = new DatabaseCtor(':memory:')
    old.exec(schemaSql as string)
    // 手工建一个 v4 状态的 quick_templates（缺两列）
    old.exec(`CREATE TABLE quick_templates (
      id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL,
      kind TEXT NOT NULL CHECK(kind IN ('sale','purchase','expense','refund','cs_income','other')),
      product_id INTEGER NULL, channel TEXT, default_qty REAL, default_price_cents INTEGER,
      note TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL)`)
    old.pragma('user_version = 4')
    old.prepare('INSERT INTO quick_templates (name,kind,created_at,updated_at) VALUES (?,?,?,?)')
      .run('老模板', 'sale', 't', 't')

    runMigrations(old)
    expect(old.pragma('user_version', { simple: true })).toBe(6)
    const cols = old.prepare("PRAGMA table_info('quick_templates')").all() as unknown as { name: string }[]
    expect(cols.some((c) => c.name === 'variant_id')).toBe(true)
    expect(cols.some((c) => c.name === 'use_count')).toBe(true)
    // 老数据完好，新列取默认值（不 JOIN products，此合成库无业务表）
    const row = old.prepare('SELECT name, variant_id, use_count FROM quick_templates WHERE id = 1')
      .get() as { name: string; variant_id: number | null; use_count: number }
    expect(row.name).toBe('老模板')
    expect(row.variant_id).toBeNull()
    expect(row.use_count).toBe(0)
    old.close()
  })
})