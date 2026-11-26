// 第十阶段：v6 迁移清理预置规格 + 用户自建规格共存。
// 核心不变量：只清「完全空壳」规格；任何有进货/销售/退款/库存数据的规格一律保留。
import { describe, it, expect } from 'vitest'
import DatabaseCtor from 'better-sqlite3-multiple-ciphers'
import type { Database } from 'better-sqlite3-multiple-ciphers'
import schemaSql from '../src/main/db/schema.sql?raw'
import { runMigrations } from '../src/main/db/migrations'
import { seedBusiness } from '../src/main/db/seed-business'
import {
  listProducts, listVariants, createVariant, recordPurchase, recordSale, recordRefund,
} from '../src/main/domain/business'

function makeDb(): Database {
  const db = new DatabaseCtor(':memory:')
  db.exec(schemaSql as string)
  runMigrations(db)
  seedBusiness(db)
  return db
}

describe('v6 清理预置规格 · 第十阶段', () => {
  it('全新库：6 个商品存在，但一个规格都没有', () => {
    const db = makeDb()
    const ps = listProducts(db)
    expect(ps).toHaveLength(6)
    for (const p of ps) {
      expect(listVariants(db, p.id), `${p.brand}/${p.name} 不应有预置规格`).toHaveLength(0)
    }
    expect(db.pragma('user_version', { simple: true })).toBe(6)
    db.close()
  })

  it('v5 旧库（含预置空规格）升级后：空规格被清空', () => {
    // 造一个 v5 状态的库：手写预置规格
    const db = new DatabaseCtor(':memory:')
    db.exec(schemaSql as string)
    runMigrations(db)
    // 手动插入 v5 时期的预置商品 + 规格（模拟用户当前库）
    const ts = '2026-11-01T00:00:00.000Z'
    db.prepare(
      "INSERT INTO products (name,brand,locked,created_at,updated_at) VALUES ('猫粮','MUFY',1,?,?)",
    ).run(ts, ts)
    const pid = Number(db.prepare("SELECT id FROM products WHERE name='猫粮'").get() && (db.prepare("SELECT id FROM products WHERE name='猫粮'").get() as { id: number }).id)
    for (const spec of ['1kg 装', '2kg 装', '5kg 装']) {
      db.prepare(
        'INSERT INTO product_variants (product_id,spec_name,standard_price_cents,created_at,updated_at) VALUES (?,?,0,?,?)',
      ).run(pid, spec, ts, ts)
    }
    db.pragma('user_version = 5')
    expect(listVariants(db, pid)).toHaveLength(3)

    runMigrations(db) // → v6
    expect(db.pragma('user_version', { simple: true })).toBe(6)
    expect(listVariants(db, pid)).toHaveLength(0)
    db.close()
  })

  it('有历史记录的规格必须保留（不可伤账）', () => {
    const db = makeDb()
    const cat = listProducts(db).find((p) => p.name === '猫粮')!
    const keepId = createVariant(db, { product_id: cat.id, spec_name: '有记录规格', standard_price_cents: 1000 })
    const emptyId = createVariant(db, { product_id: cat.id, spec_name: '空规格', standard_price_cents: 500 })
    // 给 keepId 记一笔进货
    recordPurchase(db, {
      product_id: cat.id, variant_id: keepId,
      occurred_at: '2026-11-01', qty: 5, total_cents: 2500, channel: '微信支出',
    })
    // 回退版本号，模拟「再次升级」以触发 v6
    db.pragma('user_version = 5')
    runMigrations(db)

    const left = listVariants(db, cat.id)
    expect(left.map((v) => v.spec_name)).toEqual(['有记录规格'])
    expect(left.some((v) => v.id === keepId)).toBe(true)
    expect(left.some((v) => v.id === emptyId)).toBe(false)
    db.close()
  })

  it('销售/退款过的规格都保留（退款落在原订单规格上）', () => {
    const db = makeDb()
    const cat = listProducts(db).find((p) => p.name === '猫粮')!
    const vSold = createVariant(db, { product_id: cat.id, spec_name: '卖过又退过的', standard_price_cents: 1000 })
    const vEmpty = createVariant(db, { product_id: cat.id, spec_name: '纯空壳', standard_price_cents: 1000 })
    const sale = recordSale(db, {
      product_id: cat.id, variant_id: vSold,
      occurred_at: '2026-11-01', qty: 1, unit_price_cents: 1000, channel: '微信收入',
    })
    // 关联退款会强制退到原订单规格（业务规则），这正是我们要保住的账
    recordRefund(db, {
      sales_order_id: sale.orderId, product_id: cat.id,
      occurred_at: '2026-11-02', refund_cents: 500, channel: '微信退款',
    })
    db.pragma('user_version = 5')
    runMigrations(db)

    const names = listVariants(db, cat.id).map((v) => v.spec_name)
    expect(names).toEqual(['卖过又退过的'])   // 有账的留下
    expect(names).not.toContain('纯空壳')     // 空壳清掉
    void vEmpty
    db.close()
  })

  it('删空后商品层汇总归零（不残留旧数字）', () => {
    const db = makeDb()
    const cat = listProducts(db).find((p) => p.name === '猫粮')!
    // 造一个空规格，但手工把商品层汇总写成非零（模拟历史脏数据）
    const vid = createVariant(db, { product_id: cat.id, spec_name: '空壳', standard_price_cents: 0 })
    db.prepare(
      'UPDATE products SET stock_qty = 99, stock_cost_cents = 9900, avg_cost_cents = 100, cumulative_sales_cents = 8888 WHERE id = ?',
    ).run(cat.id)
    db.pragma('user_version = 5')
    runMigrations(db)

    const after = listProducts(db).find((p) => p.id === cat.id)!
    expect(after.stock_qty).toBe(0)
    expect(after.stock_cost_cents).toBe(0)
    expect(after.avg_cost_cents).toBe(0)
    expect(after.cumulative_sales_cents).toBe(0)
    expect(listVariants(db, cat.id)).toHaveLength(0)
    void vid
    db.close()
  })

  it('模板引用的规格被删时自动解绑（不留悬空外键）', () => {
    const db = makeDb()
    const cat = listProducts(db).find((p) => p.name === '猫粮')!
    const vid = createVariant(db, { product_id: cat.id, spec_name: '被模板引用的空规格', standard_price_cents: 1000 })
    db.prepare(
      'INSERT INTO quick_templates (name,kind,product_id,variant_id,use_count,created_at,updated_at) VALUES (?,?,?,?,0,?,?)',
    ).run('测试模板', 'sale', cat.id, vid, 't', 't')

    db.pragma('user_version = 5')
    runMigrations(db)

    const tpl = db.prepare("SELECT variant_id FROM quick_templates WHERE name='测试模板'").get() as { variant_id: number | null }
    expect(tpl.variant_id).toBeNull()  // 解绑而非删除模板
    db.close()
  })

  it('迁移幂等：重复执行不报错、结果稳定', () => {
    const db = makeDb()
    const cat = listProducts(db).find((p) => p.name === '猫粮')!
    createVariant(db, { product_id: cat.id, spec_name: 'A', standard_price_cents: 100 })
    db.pragma('user_version = 5')
    runMigrations(db)
    const first = listVariants(db, cat.id).length
    expect(() => runMigrations(db)).not.toThrow()
    expect(listVariants(db, cat.id).length).toBe(first)
    db.close()
  })

  it('用户自建规格可正常新增并独立核算（清理后仍可用）', () => {
    const db = makeDb()
    const cat = listProducts(db).find((p) => p.name === '猫粮')!
    expect(listVariants(db, cat.id)).toHaveLength(0)
    // 用户自己加规格
    const a = createVariant(db, { product_id: cat.id, spec_name: '1斤装', standard_price_cents: 1500 })
    const b = createVariant(db, { product_id: cat.id, spec_name: '3斤装', standard_price_cents: 4000 })
    expect(listVariants(db, cat.id)).toHaveLength(2)
    // 各自独立进货核算
    recordPurchase(db, { product_id: cat.id, variant_id: a, occurred_at: '2026-11-01', qty: 10, total_cents: 10000, channel: '微信支出' })
    recordPurchase(db, { product_id: cat.id, variant_id: b, occurred_at: '2026-11-01', qty: 5, total_cents: 15000, channel: '微信支出' })
    const va = listVariants(db, cat.id).find((v) => v.id === a)!
    const vb = listVariants(db, cat.id).find((v) => v.id === b)!
    expect(va.avg_cost_cents).toBe(1000)  // 10元/斤
    expect(vb.avg_cost_cents).toBe(3000)  // 30元/3斤
    db.close()
  })
})