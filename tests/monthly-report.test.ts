// 第六阶段：月度经营报表 + 趋势测试。
// 口径：与经营概览一致，只是限定在某个自然月（occurred_at 前 7 位）。
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import DatabaseCtor from 'better-sqlite3-multiple-ciphers'
import type { Database } from 'better-sqlite3-multiple-ciphers'
import schemaSql from '../src/main/db/schema.sql?raw'
import { runMigrations } from '../src/main/db/migrations'
import { seedBusiness } from '../src/main/db/seed-business'
import {
  listProducts, listVariants, createVariant,
  recordSale, recordPurchase, recordRefund, recordCSIncome, recordOther, recordExpense,
  getMonthlyReport, listBusinessMonths, getTrend,
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

describe('月度报表 + 趋势 · 第六阶段', () => {
  let db: Database
  beforeEach(() => { db = makeDb() })
  afterEach(() => { db.close() })

  it('空月报：全零、日趋势补满当月天数', () => {
    const r = getMonthlyReport(db, '2026-11')
    expect(r.month).toBe('2026-11')
    expect(r.sales_cents).toBe(0)
    expect(r.net_profit_cents).toBe(0)
    // 11 月 30 天
    expect(r.daily).toHaveLength(30)
    expect(r.daily.every((d) => d.sales_cents === 0)).toBe(true)
    expect(r.product_rank).toHaveLength(0)
    expect(r.income_channels).toHaveLength(0)
    expect(r.expense_categories).toHaveLength(0)
  })

  it('月份格式校验', () => {
    expect(() => getMonthlyReport(db, '2026-1')).toThrow(/YYYY-MM/)
    expect(() => getMonthlyReport(db, 'bad')).toThrow(/YYYY-MM/)
  })

  it('月报汇总与概览口径一致', () => {
    const { product, variant } = variantOf(db, '猫粮', '1kg 装')
    recordPurchase(db, { product_id: product.id, variant_id: variant.id, occurred_at: '2026-11-05T10:00:00Z', qty: 10, total_cents: 5000, channel: '微信支出' })
    recordSale(db, { product_id: product.id, variant_id: variant.id, occurred_at: '2026-11-10T10:00:00Z', qty: 4, unit_price_cents: 1000, channel: '微信收入' })
    recordCSIncome(db, { occurred_at: '2026-11-12T10:00:00Z', amount_cents: 3000, channel: '微信收入' })
    recordExpense(db, { occurred_at: '2026-11-15T10:00:00Z', amount_cents: 1000, channel: '微信支出', category: '平台费用' })

    const r = getMonthlyReport(db, '2026-11')
    expect(r.sales_cents).toBe(4000)
    expect(r.cost_cents).toBe(2000)
    expect(r.gross_profit_cents).toBe(2000)
    expect(r.gross_margin).toBeCloseTo(0.5)
    expect(r.cs_income_cents).toBe(3000)
    expect(r.expense_cents).toBe(1000)
    // 净利 = 2000 + 3000 - 1000 = 4000
    expect(r.net_profit_cents).toBe(4000)
    expect(r.order_count).toBe(1)
    expect(r.sales_qty).toBe(4)
  })

  it('月报只统计该月数据，跨月隔离', () => {
    const { product, variant } = variantOf(db, '猫粮', '1kg 装')
    recordSale(db, { product_id: product.id, variant_id: variant.id, occurred_at: '2026-10-20T10:00:00Z', qty: 1, unit_price_cents: 5000, channel: '微信收入' })
    recordSale(db, { product_id: product.id, variant_id: variant.id, occurred_at: '2026-11-20T10:00:00Z', qty: 1, unit_price_cents: 3000, channel: '微信收入' })
    recordSale(db, { product_id: product.id, variant_id: variant.id, occurred_at: '2026-12-20T10:00:00Z', qty: 1, unit_price_cents: 7000, channel: '微信收入' })

    expect(getMonthlyReport(db, '2026-10').sales_cents).toBe(5000)
    expect(getMonthlyReport(db, '2026-11').sales_cents).toBe(3000)
    expect(getMonthlyReport(db, '2026-12').sales_cents).toBe(7000)
  })

  it('日趋势：按天聚合，指定日有数据', () => {
    const { product, variant } = variantOf(db, '猫粮', '1kg 装')
    recordSale(db, { product_id: product.id, variant_id: variant.id, occurred_at: '2026-11-10T08:00:00Z', qty: 1, unit_price_cents: 1000, channel: '微信收入' })
    recordSale(db, { product_id: product.id, variant_id: variant.id, occurred_at: '2026-11-10T18:00:00Z', qty: 1, unit_price_cents: 2000, channel: '微信收入' })
    recordSale(db, { product_id: product.id, variant_id: variant.id, occurred_at: '2026-11-25T12:00:00Z', qty: 1, unit_price_cents: 5000, channel: '微信收入' })

    const r = getMonthlyReport(db, '2026-11')
    const d10 = r.daily.find((d) => d.date === '2026-11-10')!
    const d25 = r.daily.find((d) => d.date === '2026-11-25')!
    const d11 = r.daily.find((d) => d.date === '2026-11-11')!
    expect(d10.net_sales_cents).toBe(3000) // 同日两笔合并
    expect(d10.order_count).toBe(2)
    expect(d25.net_sales_cents).toBe(5000)
    expect(d11.net_sales_cents).toBe(0) // 空日补 0
  })

  it('商品排行：按净销售额降序，含退款扣减', () => {
    const cat = variantOf(db, '猫粮', '1kg 装')
    const card = variantOf(db, '月卡', '1 个月卡')
    const s1 = recordSale(db, { product_id: cat.product.id, variant_id: cat.variant.id, occurred_at: '2026-11-10', qty: 2, unit_price_cents: 1000, channel: '微信收入' })
    recordSale(db, { product_id: card.product.id, variant_id: card.variant.id, occurred_at: '2026-11-11', qty: 1, unit_price_cents: 5000, channel: '微信收入' })
    // 猫粮退 500 → 净销售 1500
    recordRefund(db, { sales_order_id: s1.orderId, product_id: cat.product.id, occurred_at: '2026-11-12', refund_cents: 500, channel: '微信退款' })

    const r = getMonthlyReport(db, '2026-11')
    expect(r.product_rank).toHaveLength(2)
    // 月卡 5000 排第一
    expect(r.product_rank[0].product_name).toBe('月卡')
    expect(r.product_rank[0].net_sales_cents).toBe(5000)
    // 猫粮 2000 - 500 = 1500
    expect(r.product_rank[1].product_name).toBe('猫粮')
    expect(r.product_rank[1].net_sales_cents).toBe(1500)
    expect(r.product_rank[1].gross_profit_cents).toBe(1500) // 成本 0
  })

  it('收入渠道占比：销售 + 客服 + 其他收入合并统计', () => {
    const { product, variant } = variantOf(db, '猫粮', '1kg 装')
    recordSale(db, { product_id: product.id, variant_id: variant.id, occurred_at: '2026-11-10', qty: 1, unit_price_cents: 6000, channel: '微信收入' })
    recordSale(db, { product_id: product.id, variant_id: variant.id, occurred_at: '2026-11-11', qty: 1, unit_price_cents: 3000, channel: '支付宝收入' })
    recordCSIncome(db, { occurred_at: '2026-11-12', amount_cents: 1000, channel: '微信收入' })

    const r = getMonthlyReport(db, '2026-11')
    const total = 6000 + 3000 + 1000
    const wx = r.income_channels.find((c) => c.label === '微信收入')!
    const ali = r.income_channels.find((c) => c.label === '支付宝收入')!
    expect(wx.amount_cents).toBe(6000)
    expect(wx.ratio).toBeCloseTo(6000 / total)
    expect(ali.amount_cents).toBe(3000)
    expect(ali.ratio).toBeCloseTo(3000 / total)
    // 客服收入带「（客服）」后缀
    expect(r.income_channels.some((c) => c.label.includes('客服'))).toBe(true)
  })

  it('支出分类占比', () => {
    recordExpense(db, { occurred_at: '2026-11-10', amount_cents: 3000, channel: '微信支出', category: '平台费用' })
    recordExpense(db, { occurred_at: '2026-11-11', amount_cents: 1000, channel: '微信支出', category: '运营费用' })
    recordOther(db, { kind: 'expense', occurred_at: '2026-11-12', amount_cents: 2000, channel: '微信支出', item_name: '杂费' })

    const r = getMonthlyReport(db, '2026-11')
    const total = 3000 + 1000 + 2000
    const platform = r.expense_categories.find((c) => c.label === '平台费用')!
    const ops = r.expense_categories.find((c) => c.label === '运营费用')!
    const other = r.expense_categories.find((c) => c.label === '其他支出')!
    expect(platform.amount_cents).toBe(3000)
    expect(platform.ratio).toBeCloseTo(3000 / total)
    expect(ops.amount_cents).toBe(1000)
    expect(other.amount_cents).toBe(2000)
    // 降序
    expect(r.expense_categories[0].amount_cents).toBe(3000)
  })

  it('月份列表：只含真实有数据的月份，降序', () => {
    const { product, variant } = variantOf(db, '猫粮', '1kg 装')
    recordSale(db, { product_id: product.id, variant_id: variant.id, occurred_at: '2026-09-10', qty: 1, unit_price_cents: 1000, channel: '微信收入' })
    recordSale(db, { product_id: product.id, variant_id: variant.id, occurred_at: '2026-11-10', qty: 1, unit_price_cents: 1000, channel: '微信收入' })
    recordExpense(db, { occurred_at: '2026-10-10', amount_cents: 500, channel: '微信支出', category: '平台费用' })

    const months = listBusinessMonths(db)
    expect(months).toEqual(['2026-11', '2026-10', '2026-09'])
  })

  it('趋势：近 N 月含空月补 0，从旧到新', () => {
    const { product, variant } = variantOf(db, '猫粮', '1kg 装')
    recordSale(db, { product_id: product.id, variant_id: variant.id, occurred_at: '2026-11-10T10:00:00Z', qty: 1, unit_price_cents: 5000, channel: '微信收入' })

    const trend = getTrend(db, 3, '2026-11')
    expect(trend).toHaveLength(3)
    expect(trend.map((t) => t.month)).toEqual(['2026-09', '2026-10', '2026-11'])
    expect(trend[0].net_sales_cents).toBe(0) // 9 月空
    expect(trend[1].net_sales_cents).toBe(0) // 10 月空
    expect(trend[2].net_sales_cents).toBe(5000) // 11 月
    expect(trend[2].order_count).toBe(1)
  })

  it('趋势：跨年月份正确回退', () => {
    const trend = getTrend(db, 3, '2026-01')
    expect(trend.map((t) => t.month)).toEqual(['2025-11', '2025-12', '2026-01'])
  })

  it('趋势：净利润含客服收入与支出', () => {
    const { product, variant } = variantOf(db, '猫粮', '1kg 装')
    recordPurchase(db, { product_id: product.id, variant_id: variant.id, occurred_at: '2026-11-01', qty: 10, total_cents: 5000, channel: '微信支出' })
    recordSale(db, { product_id: product.id, variant_id: variant.id, occurred_at: '2026-11-10', qty: 2, unit_price_cents: 1000, channel: '微信收入' })
    recordCSIncome(db, { occurred_at: '2026-11-11', amount_cents: 2000, channel: '微信收入' })
    recordExpense(db, { occurred_at: '2026-11-12', amount_cents: 500, channel: '微信支出', category: '平台费用' })

    const trend = getTrend(db, 1, '2026-11')
    // 毛利 = 2000 - 1000 = 1000；净利 = 1000 + 2000 - 500 = 2500
    expect(trend[0].gross_profit_cents).toBe(1000)
    expect(trend[0].net_profit_cents).toBe(2500)
  })

  it('2 月份天数正确（闰年/平年）', () => {
    expect(getMonthlyReport(db, '2026-02').daily).toHaveLength(28)
    expect(getMonthlyReport(db, '2028-02').daily).toHaveLength(29) // 2028 闰年
  })
})