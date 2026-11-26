// 第五阶段：经营概览 + 实时盈亏测算测试。
// 口径：净销售额 = 销售 - 退款；毛利 = 净销售额 - 销售成本；净利润 = 毛利 + 客服 + 其他收入 - 经营支出 - 其他支出。
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import DatabaseCtor from 'better-sqlite3-multiple-ciphers'
import type { Database } from 'better-sqlite3-multiple-ciphers'
import schemaSql from '../src/main/db/schema.sql?raw'
import { runMigrations } from '../src/main/db/migrations'
import { seedBusiness } from '../src/main/db/seed-business'
import {
  listProducts, listVariants, createVariant,
  recordSale, recordPurchase, recordRefund, recordCSIncome, recordOther, recordExpense,
  getBusinessOverview, calculateProfit,
} from '../src/main/domain/business'

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

describe('经营概览 + 盈亏测算 · 第五阶段', () => {
  let db: Database
  beforeEach(() => { db = makeDb() })
  afterEach(() => { db.close() })

  it('空库概览：全零，不报错', () => {
    const o = getBusinessOverview(db)
    expect(o.sales_cents).toBe(0)
    expect(o.net_profit_cents).toBe(0)
    expect(o.gross_margin).toBe(0)
    expect(o.products).toHaveLength(6) // 6 商品都在（LEFT JOIN 保留）
    expect(o.channels).toHaveLength(0)
  })

  it('全局概览：销售→成本→毛利→净利全链条', () => {
    const { product, variant } = variantOf(db, '猫粮', '1kg 装')
    // 进 10 件 50 元 → 成本 5 元/件
    recordPurchase(db, { product_id: product.id, variant_id: variant.id, occurred_at: '2026-11-26T10:00:00Z', qty: 10, total_cents: 5000, channel: '微信支出' })
    // 卖 4 件 10 元/件 = 40 元，成本 20 元，毛利 20 元
    recordSale(db, { product_id: product.id, variant_id: variant.id, occurred_at: '2026-11-26T11:00:00Z', qty: 4, unit_price_cents: 1000, channel: '微信收入' })
    // 客服收入 30 元
    recordCSIncome(db, { occurred_at: '2026-11-26T12:00:00Z', amount_cents: 3000, channel: '微信收入' })
    // 其他收入 50 元
    recordOther(db, { kind: 'income', occurred_at: '2026-11-26T12:30:00Z', amount_cents: 5000, channel: '支付宝收入', item_name: '理财' })
    // 经营支出 20 元
    recordExpense(db, { occurred_at: '2026-11-26T13:00:00Z', amount_cents: 2000, channel: '微信支出', category: '平台费用' })

    const o = getBusinessOverview(db)
    expect(o.sales_cents).toBe(4000)
    expect(o.refund_cents).toBe(0)
    expect(o.net_sales_cents).toBe(4000)
    expect(o.cost_cents).toBe(2000)
    expect(o.gross_profit_cents).toBe(2000)
    expect(o.gross_margin).toBeCloseTo(0.5) // 2000/4000
    expect(o.cs_income_cents).toBe(3000)
    expect(o.other_income_cents).toBe(5000)
    expect(o.expense_cents).toBe(2000)
    // 净利 = 2000 + 3000 + 5000 - 2000 = 8000
    expect(o.net_profit_cents).toBe(8000)
    // 净利率 = 8000 / (4000 + 3000 + 5000) = 0.6667
    expect(o.net_margin).toBeCloseTo(8000 / 12000)
    // 库存：进 10 卖 4 = 6 件，成本 30 元
    expect(o.stock_qty).toBe(6)
    expect(o.stock_cost_cents).toBe(3000)
    expect(o.order_count).toBe(1)
    expect(o.sales_qty).toBe(4)
  })

  it('概览：退款拉低净销售与毛利', () => {
    const { product, variant } = variantOf(db, '猫粮', '1kg 装')
    recordPurchase(db, { product_id: product.id, variant_id: variant.id, occurred_at: '2026-11-26', qty: 10, total_cents: 5000, channel: '微信支出' })
    const sale = recordSale(db, { product_id: product.id, variant_id: variant.id, occurred_at: '2026-11-26', qty: 5, unit_price_cents: 1000, channel: '微信收入' })
    recordRefund(db, { sales_order_id: sale.orderId, product_id: product.id, occurred_at: '2026-11-26', refund_cents: 2000, channel: '微信退款' })
    const o = getBusinessOverview(db)
    expect(o.sales_cents).toBe(5000)
    expect(o.refund_cents).toBe(2000)
    expect(o.net_sales_cents).toBe(3000)
    expect(o.cost_cents).toBe(2500) // 销售成本不变（快照）
    expect(o.gross_profit_cents).toBe(500) // 3000 - 2500
  })

  it('概览：商品维度按商品汇总', () => {
    const cat = variantOf(db, '猫粮', '1kg 装')
    const card = variantOf(db, '月卡', '1 个月卡')
    recordPurchase(db, { product_id: cat.product.id, variant_id: cat.variant.id, occurred_at: '2026-11-26', qty: 10, total_cents: 5000, channel: '微信支出' })
    recordSale(db, { product_id: cat.product.id, variant_id: cat.variant.id, occurred_at: '2026-11-26', qty: 2, unit_price_cents: 1000, channel: '微信收入' })
    recordSale(db, { product_id: card.product.id, variant_id: card.variant.id, occurred_at: '2026-11-26', qty: 3, unit_price_cents: 3000, channel: '支付宝收入' })

    const o = getBusinessOverview(db)
    const catProfit = o.products.find((p) => p.product_name === '猫粮')!
    const cardProfit = o.products.find((p) => p.product_name === '月卡')!
    expect(catProfit.sales_cents).toBe(2000)
    expect(catProfit.cost_cents).toBe(1000) // 2 件 × 5 元
    expect(catProfit.gross_profit_cents).toBe(1000)
    expect(catProfit.gross_margin).toBeCloseTo(0.5)
    expect(cardProfit.sales_cents).toBe(9000)
    expect(cardProfit.cost_cents).toBe(0) // 月卡没进货，成本 0
    expect(cardProfit.gross_profit_cents).toBe(9000)
  })

  it('概览：渠道维度分收入/支出', () => {
    const { product, variant } = variantOf(db, '猫粮', '1kg 装')
    recordPurchase(db, { product_id: product.id, variant_id: variant.id, occurred_at: '2026-11-26', qty: 5, total_cents: 2500, channel: '微信支出' })
    recordSale(db, { product_id: product.id, variant_id: variant.id, occurred_at: '2026-11-26', qty: 1, unit_price_cents: 1000, channel: '微信收入' })
    recordSale(db, { product_id: product.id, variant_id: variant.id, occurred_at: '2026-11-26', qty: 1, unit_price_cents: 1000, channel: '支付宝收入' })
    recordExpense(db, { occurred_at: '2026-11-26', amount_cents: 800, channel: '支付宝支出', category: '平台费用' })

    const o = getBusinessOverview(db)
    const wxIncome = o.channels.find((c) => c.channel === '微信收入' && c.kind === 'income')!
    const aliIncome = o.channels.find((c) => c.channel === '支付宝收入' && c.kind === 'income')!
    const aliExpense = o.channels.find((c) => c.channel === '支付宝支出' && c.kind === 'expense')!
    expect(wxIncome.amount_cents).toBe(1000)
    expect(aliIncome.amount_cents).toBe(1000)
    expect(aliExpense.amount_cents).toBe(800)
  })

  it('概览：区间过滤（只统计区间内）', () => {
    const { product, variant } = variantOf(db, '猫粮', '1kg 装')
    recordSale(db, { product_id: product.id, variant_id: variant.id, occurred_at: '2026-11-01T10:00:00Z', qty: 1, unit_price_cents: 1000, channel: '微信收入' })
    recordSale(db, { product_id: product.id, variant_id: variant.id, occurred_at: '2026-11-20T10:00:00Z', qty: 1, unit_price_cents: 2000, channel: '微信收入' })
    recordSale(db, { product_id: product.id, variant_id: variant.id, occurred_at: '2026-12-05T10:00:00Z', qty: 1, unit_price_cents: 4000, channel: '微信收入' })

    const all = getBusinessOverview(db)
    expect(all.sales_cents).toBe(7000)

    const november = getBusinessOverview(db, { from: '2026-11-01T00:00:00Z', to: '2026-12-01T00:00:00Z' })
    expect(november.sales_cents).toBe(3000)
    expect(november.order_count).toBe(2)

    const december = getBusinessOverview(db, { from: '2026-12-01T00:00:00Z', to: null })
    expect(december.sales_cents).toBe(4000)
  })

  it('盈亏测算：成本/毛利/毛利率/保本价/建议售价', () => {
    const { product, variant } = variantOf(db, '猫粮', '1kg 装')
    recordPurchase(db, { product_id: product.id, variant_id: variant.id, occurred_at: '2026-11-26', qty: 10, total_cents: 5000, channel: '微信支出' })
    const r = calculateProfit(db, { product_id: product.id, variant_id: variant.id, qty: 3, unit_price_cents: 1000 })
    expect(r.cost_per_unit_cents).toBe(500)
    expect(r.amount_cents).toBe(3000)
    expect(r.total_cost_cents).toBe(1500)
    expect(r.gross_profit_cents).toBe(1500)
    expect(r.gross_margin).toBeCloseTo(0.5)
    expect(r.break_even_price_cents).toBe(500)
    // 建议售价 = 500 / 0.7 ≈ 714
    expect(r.suggested_price_cents).toBe(Math.round(500 / 0.7))
  })

  it('盈亏测算：分摊支出扣进净利润', () => {
    const { product, variant } = variantOf(db, '猫粮', '1kg 装')
    recordPurchase(db, { product_id: product.id, variant_id: variant.id, occurred_at: '2026-11-26', qty: 10, total_cents: 5000, channel: '微信支出' })
    const r = calculateProfit(db, { product_id: product.id, variant_id: variant.id, qty: 2, unit_price_cents: 1000, extra_expense_cents: 300 })
    // 毛利 = 2000 - 1000 = 1000；净利 = 1000 - 300 = 700
    expect(r.gross_profit_cents).toBe(1000)
    expect(r.net_profit_cents).toBe(700)
    expect(r.net_margin).toBeCloseTo(700 / 2000)
  })

  it('盈亏测算：缺省售价取规格标准售价', () => {
    const { product, variant } = variantOf(db, '猫粮', '1kg 装')
    // 设置标准售价 12 元
    db.prepare('UPDATE product_variants SET standard_price_cents = 1200 WHERE id = ?').run(variant.id)
    const r = calculateProfit(db, { product_id: product.id, variant_id: variant.id, qty: 1 })
    expect(r.unit_price_cents).toBe(1200)
    expect(r.amount_cents).toBe(1200)
  })

  it('亏损场景：售价低于成本，毛利为负', () => {
    const { product, variant } = variantOf(db, '猫粮', '1kg 装')
    recordPurchase(db, { product_id: product.id, variant_id: variant.id, occurred_at: '2026-11-26', qty: 10, total_cents: 20000, channel: '微信支出' }) // 20 元/件
    const r = calculateProfit(db, { product_id: product.id, variant_id: variant.id, qty: 1, unit_price_cents: 1000 })
    expect(r.gross_profit_cents).toBe(-1000)
    expect(r.gross_margin).toBeLessThan(0)
    // 概览也反映亏损
    recordSale(db, { product_id: product.id, variant_id: variant.id, occurred_at: '2026-11-26', qty: 1, unit_price_cents: 1000, channel: '微信收入' })
    const o = getBusinessOverview(db)
    const catProfit = o.products.find((p) => p.product_name === '猫粮')!
    expect(catProfit.gross_profit_cents).toBe(-1000)
    expect(o.gross_profit_cents).toBe(-1000)
  })
})