// 端到端业务流程验收：模拟用户从空库到完整经营闭环
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import DatabaseCtor from 'better-sqlite3-multiple-ciphers'
import type { Database } from 'better-sqlite3-multiple-ciphers'
import schemaSql from '../src/main/db/schema.sql?raw'
import { runMigrations } from '../src/main/db/migrations'
import { seedBusiness } from '../src/main/db/seed-business'
import {
  listProductsWithVariants, listVariants, getVariant,
  createVariant, updateVariant, deleteVariant,
  recordPurchase, recordSale, recordRefund, recordCSIncome, recordOther, recordExpense,
  getBusinessOverview, getProductProfile, calculateProfit,
  getMonthlyReport, listBusinessMonths, getTrend,
} from '../src/main/domain/business'
import { buildBusinessWorkbook, readSheet } from '../src/main/domain/business-export'
import { createTemplate, listTemplates, touchTemplate } from '../src/main/domain/templates'

function makeDb(): Database {
  const db = new DatabaseCtor(':memory:')
  db.exec(schemaSql as string)
  runMigrations(db)
  seedBusiness(db)
  return db
}

// 第十阶段起商品不再预置规格：用例里按需建规格，保证自洽。
function ensureVariant(db: Database, productId: number, specName: string): number {
  const exist = listVariants(db, productId).find((v) => v.spec_name === specName)
  if (exist) return exist.id
  return createVariant(db, { product_id: productId, spec_name: specName, standard_price_cents: 1000 })
}

describe('端到端业务流程验收', () => {
  let db: Database
  beforeEach(() => { db = makeDb() })
  afterEach(() => { db.close() })

  it('完整经营闭环：进货→销售→退款→其他收支→概览→报表→导出→模板', () => {
    const ps = listProductsWithVariants(db)
    expect(ps).toHaveLength(6)
    const cat = ps.find(p => p.name === '猫粮')!
    const v1kgId = ensureVariant(db, cat.id, '1kg 装')

    // ① 进货：1kg 装 20 件 100 元（5元/件）
    recordPurchase(db, {
      product_id: cat.id, variant_id: v1kgId,
      occurred_at: '2026-11-20T09:00:00Z', qty: 20, total_cents: 10000, channel: '微信支出',
    })
    expect(getVariant(db, v1kgId)!.avg_cost_cents).toBe(500)
    expect(getVariant(db, v1kgId)!.stock_qty).toBe(20)

    // ② 销售：卖 5 件 12 元/件 = 60 元
    const sale = recordSale(db, {
      product_id: cat.id, variant_id: v1kgId,
      occurred_at: '2026-11-21T10:00:00Z', qty: 5, unit_price_cents: 1200, channel: '微信收入',
    })
    expect(sale.amount_cents).toBe(6000)
    expect(sale.gross_profit_cents).toBe(6000 - 2500) // 毛利 = 60 - 25

    // ③ 退款：退 1 件 = 12 元
    recordRefund(db, {
      sales_order_id: sale.orderId, product_id: cat.id,
      occurred_at: '2026-11-22T11:00:00Z', refund_cents: 1200, channel: '微信退款',
    })

    // ④ 客服收入 + 其他收入 + 经营支出
    recordCSIncome(db, { occurred_at: '2026-11-23T09:00:00Z', amount_cents: 5000, channel: '微信收入', description: '咨询费' })
    recordOther(db, { kind: 'income', occurred_at: '2026-11-23T10:00:00Z', amount_cents: 2000, channel: '支付宝收入', item_name: '利息' })
    recordExpense(db, { occurred_at: '2026-11-24T09:00:00Z', amount_cents: 1500, channel: '微信支出', category: '平台费用', purpose: '手续费' })

    // ⑤ 概览核算
    const ov = getBusinessOverview(db)
    expect(ov.sales_cents).toBe(6000)
    expect(ov.refund_cents).toBe(1200)
    expect(ov.net_sales_cents).toBe(4800)
    expect(ov.cost_cents).toBe(2500)       // 成本快照：5件 × 5元
    expect(ov.gross_profit_cents).toBe(2300) // 4800 - 2500
    expect(ov.cs_income_cents).toBe(5000)
    expect(ov.other_income_cents).toBe(2000)
    expect(ov.expense_cents).toBe(1500)
    // 净利 = 2300 + 5000 + 2000 - 1500
    expect(ov.net_profit_cents).toBe(7800)

    // ⑥ 商品档案
    const profile = getProductProfile(db, cat.id)!
    expect(profile.net_sales_cents).toBe(4800)
    expect(profile.gross_profit_cents).toBe(2300)
    expect(profile.variants.length).toBeGreaterThanOrEqual(1)

    // ⑦ 月度报表
    const months = listBusinessMonths(db)
    expect(months).toContain('2026-11')
    const report = getMonthlyReport(db, '2026-11')
    expect(report.sales_cents).toBe(6000)
    expect(report.net_profit_cents).toBe(7800)
    expect(report.daily).toHaveLength(30)
    expect(report.product_rank[0].product_name).toBe('猫粮')
    expect(report.income_channels.length).toBeGreaterThan(0)
    expect(report.expense_categories.length).toBeGreaterThan(0)

    // ⑧ 趋势
    const trend = getTrend(db, 3, '2026-11')
    expect(trend).toHaveLength(3)
    expect(trend[2].net_profit_cents).toBe(7800)

    // ⑨ Excel 导出
    const buf = buildBusinessWorkbook(db, { month: '2026-11' })
    expect(Buffer.isBuffer(buf)).toBe(true)
    const overview = readSheet(db, '经营总览', { month: '2026-11' })
    expect(overview.find(r => r[0] === '净利润（元）')![1]).toBe(78)

    // ⑩ 盈亏测算
    const calc = calculateProfit(db, { product_id: cat.id, variant_id: v1kgId, qty: 10, unit_price_cents: 1500 })
    expect(calc.gross_profit_cents).toBe(10 * (1500 - 500))

    // ⑪ 快捷模板
    const tplId = createTemplate(db, {
      name: '猫粮1kg常卖', kind: 'sale',
      product_id: cat.id, variant_id: v1kgId,
      channel: '微信收入', default_qty: 1, default_price_cents: 1200,
    })
    expect(listTemplates(db)).toHaveLength(1)
    touchTemplate(db, tplId)
    expect(listTemplates(db)[0].use_count).toBe(1)

    // ⑫ 规格增删
    const beforeCount = listVariants(db, cat.id).length
    const newId = createVariant(db, { product_id: cat.id, spec_name: '20kg 装', standard_price_cents: 30000 })
    expect(listVariants(db, cat.id)).toHaveLength(beforeCount + 1)
    updateVariant(db, { id: newId, spec_name: '20kg 大包装', standard_price_cents: 28000 })
    expect(getVariant(db, newId)!.spec_name).toBe('20kg 大包装')
    deleteVariant(db, newId)
    expect(listVariants(db, cat.id)).toHaveLength(beforeCount)
  })

  it('库存与成本在多次进货后仍精确（无漂移）', () => {
    const cat = listProductsWithVariants(db).find(p => p.name === '猫粮')!
    const vid = ensureVariant(db, cat.id, '1kg 装')
    // 进 10 件 50 元 → 5元/件
    recordPurchase(db, { product_id: cat.id, variant_id: vid, occurred_at: '2026-11-01', qty: 10, total_cents: 5000, channel: '微信支出' })
    // 再进 10 件 80 元 → (5000+8000)/(10+10) = 650
    recordPurchase(db, { product_id: cat.id, variant_id: vid, occurred_at: '2026-11-02', qty: 10, total_cents: 8000, channel: '微信支出' })
    const v = getVariant(db, vid)!
    expect(v.avg_cost_cents).toBe(650)
    expect(v.stock_qty).toBe(20)
    expect(v.stock_cost_cents).toBe(13000)

    // 卖 15 件 → 库存 5，成本 650*5 = 3250
    recordSale(db, { product_id: cat.id, variant_id: vid, occurred_at: '2026-11-03', qty: 15, unit_price_cents: 1000, channel: '微信收入' })
    const v2 = getVariant(db, vid)!
    expect(v2.stock_qty).toBe(5)
    expect(v2.stock_cost_cents).toBe(3250)
    // 商品层汇总一致
    const p = listProductsWithVariants(db).find(x => x.name === '猫粮')!
    expect(p.stock_qty).toBe(5)
    expect(p.stock_cost_cents).toBe(3250)
  })

  it('超退防护：累计退款不得超过订单金额', () => {
    const cat = listProductsWithVariants(db).find(p => p.name === '猫粮')!
    const sale = recordSale(db, { product_id: cat.id, variant_id: ensureVariant(db, cat.id, '1kg 装'), occurred_at: '2026-11-01', qty: 1, unit_price_cents: 1000, channel: '微信收入' })
    recordRefund(db, { sales_order_id: sale.orderId, product_id: cat.id, occurred_at: '2026-11-02', refund_cents: 600, channel: '微信退款' })
    // 再退 500 会超（600+500 > 1000）
    expect(() => recordRefund(db, { sales_order_id: sale.orderId, product_id: cat.id, occurred_at: '2026-11-03', refund_cents: 500, channel: '微信退款' })).toThrow(/超出可退/)
    // 退 400 刚好满额
    expect(() => recordRefund(db, { sales_order_id: sale.orderId, product_id: cat.id, occurred_at: '2026-11-03', refund_cents: 400, channel: '微信退款' })).not.toThrow()
  })

  it('多规格互不干扰（独立性铁律）', () => {
    const cat = listProductsWithVariants(db).find(p => p.name === '猫粮')!
    const v1kgId2 = ensureVariant(db, cat.id, '1kg 装')
    const v5kgId = ensureVariant(db, cat.id, '5kg 装')
    const v1kg = { id: v1kgId2 }
    const v5kg = { id: v5kgId }
    // 1kg 进 10 件 50 元 → 5元
    recordPurchase(db, { product_id: cat.id, variant_id: v1kg.id, occurred_at: '2026-11-01', qty: 10, total_cents: 5000, channel: '微信支出' })
    // 5kg 进 4 件 80 元 → 20元
    recordPurchase(db, { product_id: cat.id, variant_id: v5kg.id, occurred_at: '2026-11-01', qty: 4, total_cents: 8000, channel: '微信支出' })
    expect(getVariant(db, v1kg.id)!.avg_cost_cents).toBe(500)
    expect(getVariant(db, v5kg.id)!.avg_cost_cents).toBe(2000)
    // 卖 1kg 不影响 5kg
    recordSale(db, { product_id: cat.id, variant_id: v1kg.id, occurred_at: '2026-11-02', qty: 3, unit_price_cents: 1000, channel: '微信收入' })
    expect(getVariant(db, v5kg.id)!.stock_qty).toBe(4)
    expect(getVariant(db, v5kg.id)!.avg_cost_cents).toBe(2000)
    expect(getVariant(db, v1kg.id)!.stock_qty).toBe(7)
  })
})
