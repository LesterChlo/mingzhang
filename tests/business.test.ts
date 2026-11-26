// 第三/四阶段商品经营核心逻辑测试：
// 多规格独立核算、加权平均成本、成本快照、退款关联、规格 CRUD、商品汇总重算。
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import DatabaseCtor from 'better-sqlite3-multiple-ciphers'
import type { Database } from 'better-sqlite3-multiple-ciphers'
import schemaSql from '../src/main/db/schema.sql?raw'
import { runMigrations } from '../src/main/db/migrations'
import { seedBusiness } from '../src/main/db/seed-business'
import {
  listProducts, listProductsWithVariants, getProduct, listVariants, getVariant,
  createVariant, updateVariant, deleteVariant, updateVariantPrice,
  recordSale, recordPurchase, recordRefund,
  recordCSIncome, recordOther, recordExpense, getProductProfile, getVariantProfile,
} from '../src/main/domain/business'

function makeDb(): Database {
  const db = new DatabaseCtor(':memory:')
  db.exec(schemaSql as string)
  runMigrations(db)
  seedBusiness(db)
  return db
}

/** 取某商品的某个规格（按规格名）。 */
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

describe('商品经营 · 多规格', () => {
  let db: Database
  beforeEach(() => { db = makeDb() })
  afterEach(() => { db.close() })

  it('预置 6 商品，规格由用户自行添加（第十阶段起不再预置）', () => {
    const ps = listProductsWithVariants(db)
    expect(ps).toHaveLength(6)
    expect(new Set(ps.map((p) => `${p.brand}/${p.name}`))).toEqual(new Set([
      'LM/100币', 'MUFY/猫粮', 'MUFY/月卡', 'Rubii/账号', 'Rubii/300宝石', 'Rubii/月卡',
    ]))
    // 全部商品初始规格为空——规格、进价、售价都由用户自己添加
    expect(ps.every((p) => p.variants.length === 0)).toBe(true)
    // 全部商品 locked=1
    expect(ps.every((p) => p.locked === 1)).toBe(true)
  })

  it('规格 CRUD：新增 / 改名改价 / 删除保护', () => {
    const p = listProducts(db).find((x) => x.name === '猫粮')!
    // 新增
    const before = listVariants(db, p.id).length
    const id = createVariant(db, { product_id: p.id, spec_name: '15kg 装', standard_price_cents: 30000 })
    expect(getVariant(db, id)!.spec_name).toBe('15kg 装')
    expect(listVariants(db, p.id)).toHaveLength(before + 1)
    // 重名拒绝
    expect(() => createVariant(db, { product_id: p.id, spec_name: '15kg 装' })).toThrow()
    // 改名 + 改价
    updateVariant(db, { id, spec_name: '15kg 大包装', standard_price_cents: 28000 })
    const v = getVariant(db, id)!
    expect(v.spec_name).toBe('15kg 大包装')
    expect(v.standard_price_cents).toBe(28000)
    // 无历史 → 可删除
    deleteVariant(db, id)
    expect(getVariant(db, id)).toBeNull()
  })

  it('有历史记录的规格不可删除', () => {
    const { product, variant } = variantOf(db, '猫粮', '1kg 装')
    recordPurchase(db, { product_id: product.id, variant_id: variant.id, occurred_at: '2026-11-26', qty: 10, total_cents: 5000, channel: '微信支出' })
    expect(() => deleteVariant(db, variant.id)).toThrow(/历史记录/)
  })

  it('销售记账：规格级成本快照 + 规格与商品双联动', () => {
    const { product, variant } = variantOf(db, '猫粮', '1kg 装')
    recordPurchase(db, { product_id: product.id, variant_id: variant.id, occurred_at: '2026-11-26', qty: 10, total_cents: 5000, channel: '微信支出' })
    const r = recordSale(db, {
      product_id: product.id, variant_id: variant.id, occurred_at: '2026-11-26',
      qty: 2, unit_price_cents: 1000, channel: '微信收入',
    })
    expect(r.variant_id).toBe(variant.id)
    expect(r.variant_name).toBe('1kg 装')
    expect(r.amount_cents).toBe(2000)
    expect(r.cost_per_unit_cents).toBe(500)
    expect(r.total_cost_cents).toBe(1000)
    expect(r.gross_profit_cents).toBe(1000)
    // 规格层
    const v2 = getVariant(db, variant.id)!
    expect(v2.cumulative_sales_qty).toBe(2)
    expect(v2.cumulative_sales_cents).toBe(2000)
    expect(v2.stock_qty).toBe(8)
    // 商品层汇总
    const p2 = getProduct(db, product.id)!
    expect(p2.cumulative_sales_qty).toBe(2)
    expect(p2.cumulative_sales_cents).toBe(2000)
    expect(p2.stock_qty).toBe(8)
    expect(p2.sales_order_count).toBe(1)
  })

  it('不同规格独立核算：成本/库存互不干扰', () => {
    const cat = listProducts(db).find((x) => x.name === '猫粮')!
    const v1 = variantOf(db, '猫粮', '1kg 装').variant
    const v2 = variantOf(db, '猫粮', '5kg 装').variant
    // 1kg 进 10 件共 50 元 → 5 元/件
    recordPurchase(db, { product_id: cat.id, variant_id: v1.id, occurred_at: '2026-11-26', qty: 10, total_cents: 5000, channel: '微信支出' })
    // 5kg 进 4 件共 80 元 → 20 元/件
    recordPurchase(db, { product_id: cat.id, variant_id: v2.id, occurred_at: '2026-11-26', qty: 4, total_cents: 8000, channel: '微信支出' })
    expect(getVariant(db, v1.id)!.avg_cost_cents).toBe(500)
    expect(getVariant(db, v2.id)!.avg_cost_cents).toBe(2000)
    expect(getVariant(db, v1.id)!.stock_qty).toBe(10)
    expect(getVariant(db, v2.id)!.stock_qty).toBe(4)
    // 商品层 = 两者之和
    const p = getProduct(db, cat.id)!
    expect(p.stock_qty).toBe(14)
    expect(p.stock_cost_cents).toBe(13000)
    // 加权平均：13000/14 ≈ 929
    expect(p.avg_cost_cents).toBe(Math.round(13000 / 14))
    // 销售 1kg 规格不影响 5kg 规格成本
    recordSale(db, { product_id: cat.id, variant_id: v1.id, occurred_at: '2026-11-26', qty: 1, unit_price_cents: 1000, channel: '微信收入' })
    expect(getVariant(db, v2.id)!.avg_cost_cents).toBe(2000)
    expect(getVariant(db, v2.id)!.stock_qty).toBe(4)
  })

  it('加权平均成本（需求示例 10件5元 + 10件8元 = 6.5元）', () => {
    const { product, variant } = variantOf(db, '猫粮', '1kg 装')
    recordPurchase(db, { product_id: product.id, variant_id: variant.id, occurred_at: '2026-11-26', qty: 10, total_cents: 5000, channel: '微信支出' })
    expect(getVariant(db, variant.id)!.avg_cost_cents).toBe(500)
    const r = recordPurchase(db, { product_id: product.id, variant_id: variant.id, occurred_at: '2026-11-26', qty: 10, total_cents: 8000, channel: '微信支出' })
    expect(r.new_avg_cost_cents).toBe(650)
    expect(getVariant(db, variant.id)!.avg_cost_cents).toBe(650)
  })

  it('成本快照：后续进货不改历史订单利润', () => {
    const { product, variant } = variantOf(db, '猫粮', '1kg 装')
    recordPurchase(db, { product_id: product.id, variant_id: variant.id, occurred_at: '2026-11-26', qty: 10, total_cents: 5000, channel: '微信支出' })
    const sale = recordSale(db, { product_id: product.id, variant_id: variant.id, occurred_at: '2026-11-26', qty: 3, unit_price_cents: 1000, channel: '微信收入' })
    expect(sale.cost_per_unit_cents).toBe(500)
    // 涨价进货
    recordPurchase(db, { product_id: product.id, variant_id: variant.id, occurred_at: '2026-11-26', qty: 10, total_cents: 20000, channel: '微信支出' })
    const order = db.prepare('SELECT cost_per_unit_cents, total_cost_cents, variant_name FROM sales_orders WHERE id = ?').get(sale.orderId) as { cost_per_unit_cents: number; total_cost_cents: number; variant_name: string }
    expect(order.cost_per_unit_cents).toBe(500)
    expect(order.total_cost_cents).toBe(1500)
    expect(order.variant_name).toBe('1kg 装')
  })

  it('退款关联原订单：规格随订单 + 部分/全额 + 超退拒绝', () => {
    const { product, variant } = variantOf(db, '猫粮', '5kg 装')
    const sale = recordSale(db, { product_id: product.id, variant_id: variant.id, occurred_at: '2026-11-26', qty: 1, unit_price_cents: 10000, channel: '微信收入' })
    recordRefund(db, { sales_order_id: sale.orderId, product_id: product.id, occurred_at: '2026-11-26', refund_cents: 4000, channel: '微信退款' })
    expect(() => recordRefund(db, { sales_order_id: sale.orderId, product_id: product.id, occurred_at: '2026-11-26', refund_cents: 7000, channel: '微信退款' })).toThrow(/超出可退/)
    const r = recordRefund(db, { sales_order_id: sale.orderId, product_id: product.id, occurred_at: '2026-11-26', refund_cents: 6000, channel: '支付宝退款' })
    expect(r.linked).toBe(true)
    expect(r.variant_name).toBe('5kg 装')
    const order = db.prepare('SELECT status, refunded_cents FROM sales_orders WHERE id=?').get(sale.orderId) as { status: string; refunded_cents: number }
    expect(order.status).toBe('refunded')
    expect(order.refunded_cents).toBe(10000)
    // 规格累计退款
    expect(getVariant(db, variant.id)!.cumulative_refund_cents).toBe(10000)
    expect(getProduct(db, product.id)!.cumulative_refund_cents).toBe(10000)
  })

  it('手动退款：指定规格，linked=0', () => {
    const { product, variant } = variantOf(db, '猫粮', '2kg 装')
    const r = recordRefund(db, {
      product_id: product.id, variant_id: variant.id, occurred_at: '2026-11-26',
      refund_cents: 500, channel: '微信退款', reason: '找不到原订单',
    })
    expect(r.linked).toBe(false)
    expect(r.variant_name).toBe('2kg 装')
    expect(r.original_channel).toBeNull()
    expect(getVariant(db, variant.id)!.cumulative_refund_cents).toBe(500)
  })

  it('规格售价独立设置', () => {
    const p = listProducts(db).find((x) => x.name === '猫粮')!
    const v1 = variantOf(db, '猫粮', '规格甲').variant
    const v2 = variantOf(db, '猫粮', '规格乙').variant
    updateVariantPrice(db, v1.id, 1200)
    updateVariantPrice(db, v2.id, 2200)
    expect(getVariant(db, v1.id)!.standard_price_cents).toBe(1200)
    expect(getVariant(db, v2.id)!.standard_price_cents).toBe(2200)
  })

  it('商品档案：含各规格计算字段', () => {
    const { product, variant } = variantOf(db, '猫粮', '1kg 装')
    recordPurchase(db, { product_id: product.id, variant_id: variant.id, occurred_at: '2026-11-26', qty: 10, total_cents: 5000, channel: '微信支出' })
    const sale = recordSale(db, { product_id: product.id, variant_id: variant.id, occurred_at: '2026-11-26', qty: 5, unit_price_cents: 1000, channel: '微信收入' })
    recordRefund(db, { sales_order_id: sale.orderId, product_id: product.id, occurred_at: '2026-11-26', refund_cents: 1000, channel: '微信退款' })
    const profile = getProductProfile(db, product.id)!
    expect(profile.cumulative_sales_cents).toBe(5000)
    expect(profile.cumulative_refund_cents).toBe(1000)
    expect(profile.net_sales_cents).toBe(4000)
    expect(profile.gross_profit_cents).toBe(4000 - 2500) // 净销售 - 销售成本(5*500)
    expect(profile.refund_amount_rate).toBeCloseTo(0.2)
    // 规格档案
    const vp = getVariantProfile(db, variant.id)!
    expect(vp.net_sales_cents).toBe(4000)
    expect(vp.gross_profit_cents).toBe(1500)
    expect(profile.variants.length).toBeGreaterThanOrEqual(1)
    const first = profile.variants.find((v) => v.id === variant.id)!
    expect(first.gross_profit_cents).toBe(1500)
  })

  it('客服收入 / 其他收支 / 经营支出', () => {
    expect(recordCSIncome(db, { occurred_at: '2026-11-26', amount_cents: 3000, channel: '微信收入', description: '客服咨询' })).toBeGreaterThan(0)
    expect(recordOther(db, { kind: 'income', occurred_at: '2026-11-26', amount_cents: 5000, channel: '支付宝收入', item_name: '理财收益' })).toBeGreaterThan(0)
    expect(recordExpense(db, { occurred_at: '2026-11-26', amount_cents: 2000, channel: '微信支出', category: '平台费用', purpose: '手续费' })).toBeGreaterThan(0)
  })
})