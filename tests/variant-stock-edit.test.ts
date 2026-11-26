// 第十三阶段：规格的库存与单件成本可手工校准。
//
// 背景：用户反馈「能改售价和名称，改不了库存和单件成本」。原来这两个字段只能由
// 进货流程按加权平均自动维护，私域手工发货 / 期初建账 / 盘点对账时走不通。
//
// 不变量（本文件守的就是这些）：
//   1. 手工校准后 stock_cost_cents = stock_qty × avg_cost_cents；
//   2. 商品层汇总（products.stock_qty / stock_cost_cents / avg_cost_cents）= 各规格之和；
//   3. 已成交订单的成本快照不被回溯篡改（改成本不改历史利润）；
//   4. cumulative_* 是历史事实累计，手工校准不碰它；
//   5. 负数、NaN、Infinity 一律拒绝。
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import DatabaseCtor from 'better-sqlite3-multiple-ciphers'
import type { Database } from 'better-sqlite3-multiple-ciphers'
import schemaSql from '../src/main/db/schema.sql?raw'
import { runMigrations } from '../src/main/db/migrations'
import { seedBusiness } from '../src/main/db/seed-business'
import {
  listProducts, listVariants, getProduct, getVariant,
  createVariant, updateVariant, recordSale, recordPurchase,
} from '../src/main/domain/business'

function makeDb(): Database {
  const db = new DatabaseCtor(':memory:')
  db.exec(schemaSql as string)
  runMigrations(db)
  seedBusiness(db)
  return db
}

function productNamed(db: Database, name: string) {
  const p = listProducts(db).find((x) => x.name === name)
  if (!p) throw new Error(`找不到商品 ${name}`)
  return p
}

function newVariant(db: Database, productName = '猫粮', specName = '1kg 装') {
  const p = productNamed(db, productName)
  const id = createVariant(db, { product_id: p.id, spec_name: specName, standard_price_cents: 2990 })
  return { product: p, variant: getVariant(db, id)! }
}

describe('规格库存 / 单件成本手工校准 · 第十三阶段', () => {
  let db: Database
  beforeEach(() => { db = makeDb() })
  afterEach(() => { db.close() })

  it('直接设定库存与单件成本：规格字段立即生效，库存成本自动算出', () => {
    const { variant } = newVariant(db)
    updateVariant(db, { id: variant.id, avg_cost_cents: 1500, stock_qty: 10 })

    const v = getVariant(db, variant.id)!
    expect(v.stock_qty).toBe(10)
    expect(v.avg_cost_cents).toBe(1500)
    expect(v.stock_cost_cents).toBe(15000) // 10 × 15 元
  })

  it('商品层汇总跟随规格变化（库存/库存成本/平均成本）', () => {
    const { product, variant } = newVariant(db)
    updateVariant(db, { id: variant.id, avg_cost_cents: 800, stock_qty: 5 })

    const p = getProduct(db, product.id)!
    expect(p.stock_qty).toBe(5)
    expect(p.stock_cost_cents).toBe(4000)
    expect(p.avg_cost_cents).toBe(800) // 汇总平均 = 库存成本 / 库存数量
  })

  it('多规格场景：商品汇总 = 各规格之和，手工改一个不影响另一个', () => {
    const p = productNamed(db, '猫粮')
    const a = createVariant(db, { product_id: p.id, spec_name: '1kg 装', standard_price_cents: 2990 })
    const b = createVariant(db, { product_id: p.id, spec_name: '5kg 装', standard_price_cents: 12900 })
    updateVariant(db, { id: a, avg_cost_cents: 1000, stock_qty: 10 }) // 成本 100 元
    updateVariant(db, { id: b, avg_cost_cents: 8000, stock_qty: 2 }) // 成本 160 元

    const after = getProduct(db, p.id)!
    expect(after.stock_qty).toBe(12)
    expect(after.stock_cost_cents).toBe(26000)
    expect(after.avg_cost_cents).toBe(Math.round(26000 / 12))
    expect(getVariant(db, a)!.avg_cost_cents).toBe(1000) // 互不污染
  })

  it('库存改成 0：库存成本归零，但单件成本保留（下次进货仍有参考）', () => {
    const { variant } = newVariant(db)
    updateVariant(db, { id: variant.id, avg_cost_cents: 1200, stock_qty: 3 })
    updateVariant(db, { id: variant.id, stock_qty: 0 })

    const v = getVariant(db, variant.id)!
    expect(v.stock_qty).toBe(0)
    expect(v.stock_cost_cents).toBe(0)
    expect(v.avg_cost_cents).toBe(1200)
  })

  it('支持小数库存（0.5 件 / 1.25 kg）', () => {
    const { variant } = newVariant(db)
    updateVariant(db, { id: variant.id, avg_cost_cents: 1000, stock_qty: 1.25 })
    const v = getVariant(db, variant.id)!
    expect(v.stock_qty).toBe(1.25)
    expect(v.stock_cost_cents).toBe(1250)
  })

  it('只改名称与售价时，库存与成本原样保留', () => {
    const { variant } = newVariant(db)
    updateVariant(db, { id: variant.id, avg_cost_cents: 900, stock_qty: 7 })
    updateVariant(db, { id: variant.id, spec_name: '1kg 袋装', standard_price_cents: 3990 })

    const v = getVariant(db, variant.id)!
    expect(v.spec_name).toBe('1kg 袋装')
    expect(v.standard_price_cents).toBe(3990)
    expect(v.stock_qty).toBe(7)
    expect(v.avg_cost_cents).toBe(900)
    expect(v.stock_cost_cents).toBe(6300)
  })

  it('负数库存 / 负成本 / NaN / Infinity 一律拒绝，且不留半截修改', () => {
    const { variant } = newVariant(db)
    updateVariant(db, { id: variant.id, avg_cost_cents: 1000, stock_qty: 4 })

    expect(() => updateVariant(db, { id: variant.id, stock_qty: -1 })).toThrow('库存数量不能为负')
    expect(() => updateVariant(db, { id: variant.id, avg_cost_cents: -1 })).toThrow('单件成本不能为负')
    expect(() => updateVariant(db, { id: variant.id, stock_qty: NaN })).toThrow('库存数量无效')
    expect(() => updateVariant(db, { id: variant.id, avg_cost_cents: Infinity })).toThrow('单件成本无效')

    const v = getVariant(db, variant.id)!
    expect(v.stock_qty).toBe(4)
    expect(v.avg_cost_cents).toBe(1000)
  })

  it('改成本不回溯历史订单：旧订单的成本快照与毛利保持原样', () => {
    const { product, variant } = newVariant(db)
    // 先手工设成本 10 元、库存 5 件，再卖 2 件 30 元/件
    updateVariant(db, { id: variant.id, avg_cost_cents: 1000, stock_qty: 5 })
    const sale = recordSale(db, {
      product_id: product.id, variant_id: variant.id,
      occurred_at: '2026-11-26T10:00:00Z', qty: 2, unit_price_cents: 3000, channel: '微信收入',
    })
    expect(sale.cost_per_unit_cents).toBe(1000)
    expect(sale.gross_profit_cents).toBe(6000 - 2000)

    // 事后把成本改成 25 元：历史订单不许变，库存成本按新成本重算
    updateVariant(db, { id: variant.id, avg_cost_cents: 2500 })
    const order = db.prepare('SELECT cost_per_unit_cents, total_cost_cents, gross_profit_cents FROM sales_orders WHERE id = ?')
      .get(sale.orderId) as { cost_per_unit_cents: number; total_cost_cents: number; gross_profit_cents: number }
    expect(order.cost_per_unit_cents).toBe(1000)
    expect(order.total_cost_cents).toBe(2000)
    expect(order.gross_profit_cents).toBe(4000)

    // 库存剩 3 件 × 新成本 25 元
    const v = getVariant(db, variant.id)!
    expect(v.stock_qty).toBe(3)
    expect(v.stock_cost_cents).toBe(7500)
  })

  it('手工校准不改累计进货/累计销售（历史事实累计保持独立）', () => {
    const { product, variant } = newVariant(db)
    recordPurchase(db, {
      product_id: product.id, variant_id: variant.id,
      occurred_at: '2026-11-26T09:00:00Z', qty: 10, total_cents: 5000, channel: '微信支出',
    })
    const before = getVariant(db, variant.id)!
    updateVariant(db, { id: variant.id, avg_cost_cents: 999, stock_qty: 3 })
    const after = getVariant(db, variant.id)!

    expect(after.cumulative_purchase_qty).toBe(before.cumulative_purchase_qty)
    expect(after.cumulative_purchase_cents).toBe(before.cumulative_purchase_cents)
    expect(after.stock_qty).toBe(3)
    expect(after.avg_cost_cents).toBe(999)
  })

  it('手工校准后接着进货：仍按加权平均，不出现负数或除以零', () => {
    const { product, variant } = newVariant(db)
    updateVariant(db, { id: variant.id, avg_cost_cents: 1000, stock_qty: 2 }) // 库存成本 20 元
    const r = recordPurchase(db, {
      product_id: product.id, variant_id: variant.id,
      occurred_at: '2026-11-26T12:00:00Z', qty: 3, total_cents: 9000, channel: '微信支出',
    })
    // (2000 + 9000) / (2 + 3) = 2200
    expect(r.new_avg_cost_cents).toBe(2200)
    const v = getVariant(db, variant.id)!
    expect(v.stock_qty).toBe(5)
    expect(v.stock_cost_cents).toBe(11000)
  })

  it('新增规格时可直接带期初库存与单件成本', () => {
    const p = productNamed(db, '300宝石')
    const id = createVariant(db, {
      product_id: p.id, spec_name: '300 宝石', standard_price_cents: 3000,
      stock_qty: 20, avg_cost_cents: 1200,
    })
    const v = getVariant(db, id)!
    expect(v.stock_qty).toBe(20)
    expect(v.avg_cost_cents).toBe(1200)
    expect(v.stock_cost_cents).toBe(24000)

    const after = getProduct(db, p.id)!
    expect(after.stock_qty).toBe(20)
    expect(after.stock_cost_cents).toBe(24000)
  })

  it('新增规格不带期初值时保持全零（不影响其它规格汇总）', () => {
    const p = productNamed(db, '100币')
    const keep = createVariant(db, { product_id: p.id, spec_name: '100 币', standard_price_cents: 1000 })
    updateVariant(db, { id: keep, avg_cost_cents: 700, stock_qty: 4 })
    createVariant(db, { product_id: p.id, spec_name: '200 币', standard_price_cents: 1900 })

    const after = getProduct(db, p.id)!
    expect(after.stock_qty).toBe(4)
    expect(after.stock_cost_cents).toBe(2800)
    expect(listVariants(db, p.id)).toHaveLength(2)
  })
})
