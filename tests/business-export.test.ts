// 第七阶段：经营 Excel 导出测试。
// 验证：Sheet 结构完整、金额为真数值（可求和）、月份过滤生效、空库不报错。
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import DatabaseCtor from 'better-sqlite3-multiple-ciphers'
import type { Database } from 'better-sqlite3-multiple-ciphers'
import * as XLSX from 'xlsx'
import schemaSql from '../src/main/db/schema.sql?raw'
import { runMigrations } from '../src/main/db/migrations'
import { seedBusiness } from '../src/main/db/seed-business'
import {
  listProducts, listVariants, createVariant,
  recordSale, recordPurchase, recordRefund, recordCSIncome, recordOther, recordExpense,
} from '../src/main/domain/business'
import {
  buildBusinessWorkbook, listWorkbookSheets, readSheet, businessExportFileName,
} from '../src/main/domain/business-export'

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

describe('经营 Excel 导出 · 第七阶段', () => {
  let db: Database
  beforeEach(() => { db = makeDb() })
  afterEach(() => { db.close() })

  it('工作簿含 7 个工作表', () => {
    const sheets = listWorkbookSheets(db)
    expect(sheets).toEqual([
      '经营总览', '商品规格汇总', '销售明细', '进货明细', '退款明细', '月度汇总', '其他收支',
    ])
  })

  it('空库导出不报错，总览全 0', () => {
    const rows = readSheet(db, '经营总览')
    expect(rows[0]).toEqual(['项目', '数值', '说明'])
    const salesRow = rows.find((r) => r[0] === '销售总额（元）')!
    expect(salesRow[1]).toBe(0)
    const profitRow = rows.find((r) => r[0] === '净利润（元）')!
    expect(profitRow[1]).toBe(0)
  })

  it('总览金额为真数值（可求和）且与域逻辑一致', () => {
    const { product, variant } = variantOf(db, '猫粮', '1kg 装')
    recordPurchase(db, { product_id: product.id, variant_id: variant.id, occurred_at: '2026-11-10T10:00:00Z', qty: 10, total_cents: 5000, channel: '微信支出' })
    recordSale(db, { product_id: product.id, variant_id: variant.id, occurred_at: '2026-11-11T10:00:00Z', qty: 4, unit_price_cents: 1000, channel: '微信收入' })
    recordCSIncome(db, { occurred_at: '2026-11-12T10:00:00Z', amount_cents: 3000, channel: '微信收入' })
    recordExpense(db, { occurred_at: '2026-11-13T10:00:00Z', amount_cents: 1000, channel: '微信支出', category: '平台费用' })

    const rows = readSheet(db, '经营总览')
    const get = (label: string) => rows.find((r) => r[0] === label)![1]
    // 金额写成数值（元），不是字符串
    expect(typeof get('销售总额（元）')).toBe('number')
    expect(get('销售总额（元）')).toBe(40) // 4000 分 = 40 元
    expect(get('销售成本（元）')).toBe(20)
    expect(get('毛利润（元）')).toBe(20)
    expect(get('客服收入（元）')).toBe(30)
    expect(get('经营支出（元）')).toBe(10)
    expect(get('净利润（元）')).toBe(40) // 20 + 30 - 10
  })

  it('商品规格汇总：每规格一行，含净销售与毛利', () => {
    const { product, variant } = variantOf(db, '猫粮', '1kg 装')
    recordPurchase(db, { product_id: product.id, variant_id: variant.id, occurred_at: '2026-11-10', qty: 10, total_cents: 5000, channel: '微信支出' })
    recordSale(db, { product_id: product.id, variant_id: variant.id, occurred_at: '2026-11-11', qty: 2, unit_price_cents: 1000, channel: '微信收入' })

    const rows = readSheet(db, '商品规格汇总')
    expect(rows[0][0]).toBe('品牌')
    // 第十阶段起不预置规格：本用例只建了「猫粮/1kg 装」一个规格
    expect(rows.length - 1).toBe(1)
    const catRow = rows.find((r) => r[1] === '猫粮' && r[2] === '1kg 装')!
    // 列序：0品牌 1商品 2规格 3标准售价 4平均成本 5库存 6库存成本 7累计进货量
    //       8累计进货额 9累计销量 10累计销售额 11销售成本 12累计退款量 13累计退款额
    //       14净销售额 15毛利润 16订单数
    expect(catRow[10]).toBe(20) // 累计销售额 2000 分 = 20 元
    expect(catRow[14]).toBe(20) // 净销售额
    expect(catRow[15]).toBe(10) // 毛利 = 20 - 成本 10
  })

  it('销售明细：含规格快照与成本快照', () => {
    const { product, variant } = variantOf(db, '猫粮', '2kg 装')
    recordPurchase(db, { product_id: product.id, variant_id: variant.id, occurred_at: '2026-11-01', qty: 10, total_cents: 8000, channel: '微信支出' })
    recordSale(db, { product_id: product.id, variant_id: variant.id, occurred_at: '2026-11-02', qty: 2, unit_price_cents: 1500, channel: '支付宝收入', note: '测试订单' })

    const rows = readSheet(db, '销售明细')
    expect(rows[0]).toContain('规格')
    expect(rows[0]).toContain('成本单价(元)')
    expect(rows.length).toBe(2) // 表头 + 1 行
    const row = rows[1]
    expect(row[5]).toBe('2kg 装') // 规格快照
    expect(row[7]).toBe(15) // 单价 1500 分 = 15 元
    expect(row[8]).toBe(30) // 金额 3000 分 = 30 元
    expect(row[9]).toBe(8) // 成本单价 800 分 = 8 元
    expect(row[11]).toBe(14) // 毛利 = 30 - 16
    expect(row[12]).toBe('支付宝收入')
    expect(row[15]).toBe('测试订单')
  })

  it('进货明细：含加权平均成本变化', () => {
    const { product, variant } = variantOf(db, '猫粮', '1kg 装')
    recordPurchase(db, { product_id: product.id, variant_id: variant.id, occurred_at: '2026-11-01', qty: 10, total_cents: 5000, channel: '微信支出' })
    recordPurchase(db, { product_id: product.id, variant_id: variant.id, occurred_at: '2026-11-02', qty: 10, total_cents: 8000, channel: '微信支出' })

    const rows = readSheet(db, '进货明细')
    expect(rows.length).toBe(3) // 表头 + 2 行（倒序）
    // 最新一笔：原成本 5 元 → 新成本 6.5 元
    const latest = rows[1]
    expect(latest[9]).toBe(5) // 原平均成本
    expect(latest[11]).toBe(6.5) // 新平均成本
  })

  it('退款明细：区分关联/手动', () => {
    const { product, variant } = variantOf(db, '猫粮', '1kg 装')
    const sale = recordSale(db, { product_id: product.id, variant_id: variant.id, occurred_at: '2026-11-01', qty: 1, unit_price_cents: 1000, channel: '微信收入' })
    recordRefund(db, { sales_order_id: sale.orderId, product_id: product.id, occurred_at: '2026-11-02', refund_cents: 500, channel: '微信退款' })
    recordRefund(db, { product_id: product.id, variant_id: variant.id, occurred_at: '2026-11-03', refund_cents: 300, channel: '微信退款', reason: '手动' })

    const rows = readSheet(db, '退款明细')
    expect(rows.length).toBe(3)
    const types = rows.slice(1).map((r) => r[10])
    expect(types).toContain('关联退款')
    expect(types).toContain('手动退款')
  })

  it('月度汇总：逐月一行', () => {
    const { product, variant } = variantOf(db, '猫粮', '1kg 装')
    recordSale(db, { product_id: product.id, variant_id: variant.id, occurred_at: '2026-09-10', qty: 1, unit_price_cents: 1000, channel: '微信收入' })
    recordSale(db, { product_id: product.id, variant_id: variant.id, occurred_at: '2026-11-10', qty: 1, unit_price_cents: 2000, channel: '微信收入' })

    const rows = readSheet(db, '月度汇总')
    // 表头 + 2 个月（升序）
    expect(rows.length).toBe(3)
    expect(rows[1][0]).toBe('2026-09')
    expect(rows[1][1]).toBe(10) // 销售额 10 元
    expect(rows[2][0]).toBe('2026-11')
    expect(rows[2][1]).toBe(20)
  })

  it('其他收支：三类合并到一个表', () => {
    recordCSIncome(db, { occurred_at: '2026-11-01', amount_cents: 1000, channel: '微信收入', description: '服务费' })
    recordOther(db, { kind: 'expense', occurred_at: '2026-11-02', amount_cents: 500, channel: '微信支出', item_name: '杂费' })
    recordExpense(db, { occurred_at: '2026-11-03', amount_cents: 800, channel: '微信支出', category: '平台费用', purpose: '手续费' })

    const rows = readSheet(db, '其他收支')
    expect(rows.length).toBe(4)
    const types = rows.slice(1).map((r) => r[0])
    expect(types).toContain('客服收入')
    expect(types).toContain('其他支出')
    expect(types).toContain('经营支出')
  })

  it('月份过滤生效', () => {
    const { product, variant } = variantOf(db, '猫粮', '1kg 装')
    recordSale(db, { product_id: product.id, variant_id: variant.id, occurred_at: '2026-10-10', qty: 1, unit_price_cents: 1000, channel: '微信收入' })
    recordSale(db, { product_id: product.id, variant_id: variant.id, occurred_at: '2026-11-10', qty: 1, unit_price_cents: 2000, channel: '微信收入' })

    // 全部：2 笔
    expect(readSheet(db, '销售明细').length).toBe(3)
    // 只导出 11 月：1 笔
    expect(readSheet(db, '销售明细', { month: '2026-11' }).length).toBe(2)
    const rows = readSheet(db, '销售明细', { month: '2026-11' })
    expect(rows[1][8]).toBe(20) // 11 月那笔 2000 分
  })

  it('月份格式非法时报错', () => {
    expect(() => buildBusinessWorkbook(db, { month: '2026-1' })).toThrow(/YYYY-MM/)
  })

  it('导出的缓冲区可被 Excel 解析', () => {
    const buf = buildBusinessWorkbook(db)
    expect(Buffer.isBuffer(buf)).toBe(true)
    const wb = XLSX.read(buf, { type: 'buffer' })
    expect(wb.SheetNames).toHaveLength(7)
  })

  it('文件名带日期或月份', () => {
    expect(businessExportFileName()).toMatch(/^记账中心-经营报表-\d{4}-\d{2}-\d{2}\.xlsx$/)
    expect(businessExportFileName('2026-11')).toBe('记账中心-经营报表-2026-11.xlsx')
  })
})