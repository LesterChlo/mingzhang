// 经营报表 Excel 导出（第七阶段）：多 Sheet 工作簿。
// Sheet 结构：
//   ① 经营总览   —— 汇总指标（销售/退款/净销售/成本/毛利/客服/其他/支出/净利/毛利率/净利率）
//   ② 商品规格汇总 —— 每个规格的售价/成本/库存/累计销售/退款/毛利
//   ③ 销售明细   —— 逐笔订单（含规格快照、成本快照、毛利）
//   ④ 进货明细   —— 逐笔进货（含加权平均成本变化）
//   ⑤ 退款明细   —— 逐笔退款（关联订单/手动、原渠道）
//   ⑥ 月度汇总   —— 逐月趋势
//   ⑦ 其他收支   —— 客服收入 + 其他收支出 + 经营支出
// 金额一律写「真数值（元）」而非字符串，Excel 里可直接求和。
// 导出是只读副本，不触碰账本、审计与加密材料。

import * as XLSX from 'xlsx'
import type { Database } from 'better-sqlite3-multiple-ciphers'
import { getBusinessOverview, getMonthlyReport, listBusinessMonths } from './business'

export interface BusinessExportOptions {
  /** 限定月份 'YYYY-MM'；空 = 导出全部。 */
  month?: string | null
}

/** 分 → 元（数值，供 Excel 求和）。 */
function yuan(cents: number): number {
  return Math.round(cents) / 100
}

/** 安全取字符串。 */
function s(value: unknown): string {
  return value === null || value === undefined ? '' : String(value)
}

/** 通用工作表生成：设表头样式宽度。 */
function appendSheet(
  wb: XLSX.WorkBook,
  name: string,
  headers: string[],
  rows: (string | number)[][],
  widths: number[],
): void {
  const aoa: (string | number)[][] = [headers, ...rows]
  const ws = XLSX.utils.aoa_to_sheet(aoa)
  ws['!cols'] = widths.map((w) => ({ wch: w }))
  // 冻结首行，方便滚动查看
  ws['!freeze'] = { xSplit: '0', ySplit: '1' } as never
  XLSX.utils.book_append_sheet(wb, ws, name)
}

/** 时间区间过滤 SQL 片段（occurred_at 前 7 位 = 月份）。 */
function monthWhere(month?: string | null): { sql: string; args: string[] } {
  if (!month) return { sql: '', args: [] }
  if (!/^\d{4}-\d{2}$/.test(month)) throw new Error(`月份格式应为 YYYY-MM，收到：${month}`)
  return { sql: ' AND substr(occurred_at,1,7) = ?', args: [month] }
}

/** 组装多 Sheet 经营工作簿。 */
export function buildBusinessWorkbook(db: Database, options: BusinessExportOptions = {}): Buffer {
  const month = options.month ?? null
  const wb = XLSX.utils.book_new()
  const mw = monthWhere(month)

  // ① 经营总览
  const range = month ? { from: `${month}-01T00:00:00.000Z`, to: null } : undefined
  const ov = getBusinessOverview(db, range)
  const overviewRows: (string | number)[][] = [
    ['统计范围', month ? `${month}（单月）` : '全部数据', ''],
    ['销售总额（元）', yuan(ov.sales_cents), ''],
    ['退款总额（元）', yuan(ov.refund_cents), ''],
    ['净销售额（元）', yuan(ov.net_sales_cents), ''],
    ['销售成本（元）', yuan(ov.cost_cents), '成本快照之和'],
    ['毛利润（元）', yuan(ov.gross_profit_cents), ''],
    ['毛利率', `${(ov.gross_margin * 100).toFixed(2)}%`, ''],
    ['客服收入（元）', yuan(ov.cs_income_cents), ''],
    ['其他收入（元）', yuan(ov.other_income_cents), ''],
    ['经营支出（元）', yuan(ov.expense_cents), ''],
    ['其他支出（元）', yuan(ov.other_expense_cents), ''],
    ['净利润（元）', yuan(ov.net_profit_cents), '毛利 + 客服 + 其他收入 − 支出'],
    ['净利率', `${(ov.net_margin * 100).toFixed(2)}%`, ''],
    ['订单数', ov.order_count, ''],
    ['销售件数', ov.sales_qty, ''],
    ['库存件数', ov.stock_qty, ''],
    ['库存成本（元）', yuan(ov.stock_cost_cents), ''],
  ]
  appendSheet(wb, '经营总览', ['项目', '数值', '说明'], overviewRows, [22, 18, 36])

  // ② 商品规格汇总
  const variantRows = db.prepare(`
    SELECT p.brand, p.name AS product_name, v.spec_name,
      v.standard_price_cents, v.avg_cost_cents, v.stock_qty, v.stock_cost_cents,
      v.cumulative_purchase_qty, v.cumulative_purchase_cents,
      v.cumulative_sales_qty, v.cumulative_sales_cents, v.cumulative_sales_cost_cents,
      v.cumulative_refund_qty, v.cumulative_refund_cents, v.sales_order_count
    FROM product_variants v JOIN products p ON p.id = v.product_id
    ORDER BY p.id, v.sort_order, v.id
  `).all() as unknown as Record<string, number | string>[]
  appendSheet(
    wb,
    '商品规格汇总',
    ['品牌', '商品', '规格', '标准售价(元)', '平均成本(元)', '库存', '库存成本(元)',
      '累计进货量', '累计进货额(元)', '累计销量', '累计销售额(元)', '销售成本(元)',
      '累计退款量', '累计退款额(元)', '净销售额(元)', '毛利润(元)', '订单数'],
    variantRows.map((r) => {
      const netSales = Number(r.cumulative_sales_cents) - Number(r.cumulative_refund_cents)
      const gross = netSales - Number(r.cumulative_sales_cost_cents)
      return [
        s(r.brand), s(r.product_name), s(r.spec_name),
        yuan(Number(r.standard_price_cents)), yuan(Number(r.avg_cost_cents)),
        Number(r.stock_qty), yuan(Number(r.stock_cost_cents)),
        Number(r.cumulative_purchase_qty), yuan(Number(r.cumulative_purchase_cents)),
        Number(r.cumulative_sales_qty), yuan(Number(r.cumulative_sales_cents)), yuan(Number(r.cumulative_sales_cost_cents)),
        Number(r.cumulative_refund_qty), yuan(Number(r.cumulative_refund_cents)),
        yuan(netSales), yuan(gross), Number(r.sales_order_count),
      ]
    }),
    [10, 12, 14, 13, 13, 9, 14, 12, 15, 10, 15, 14, 11, 15, 14, 13, 9],
  )

  // ③ 销售明细
  const saleRows = db.prepare(`
    SELECT so.id, so.order_no, so.occurred_at, p.brand, p.name AS product_name,
      so.variant_name, so.qty, so.unit_price_cents, so.amount_cents,
      so.cost_per_unit_cents, so.total_cost_cents, so.gross_profit_cents,
      so.channel, so.status, so.refunded_cents, so.note
    FROM sales_orders so JOIN products p ON p.id = so.product_id
    WHERE 1=1${mw.sql} ORDER BY so.occurred_at DESC, so.id DESC
  `).all(...mw.args) as unknown as Record<string, number | string | null>[]
  appendSheet(
    wb,
    '销售明细',
    ['订单号', '平台单号', '时间', '品牌', '商品', '规格', '数量', '单价(元)', '金额(元)',
      '成本单价(元)', '总成本(元)', '毛利(元)', '渠道', '状态', '已退(元)', '备注'],
    saleRows.map((r) => [
      Number(r.id), s(r.order_no), s(r.occurred_at), s(r.brand), s(r.product_name), s(r.variant_name ?? ''),
      Number(r.qty), yuan(Number(r.unit_price_cents)), yuan(Number(r.amount_cents)),
      yuan(Number(r.cost_per_unit_cents)), yuan(Number(r.total_cost_cents)), yuan(Number(r.gross_profit_cents)),
      s(r.channel), s(r.status), yuan(Number(r.refunded_cents)), s(r.note),
    ]),
    [8, 18, 22, 10, 12, 14, 8, 11, 11, 13, 11, 11, 14, 14, 11, 24],
  )

  // ④ 进货明细
  const purchaseRows = db.prepare(`
    SELECT pr.id, pr.occurred_at, p.brand, p.name AS product_name, pr.variant_name,
      pr.qty, pr.total_cents, pr.unit_cost_cents, pr.channel,
      pr.prev_avg_cost_cents, pr.prev_stock_qty, pr.new_avg_cost_cents, pr.note
    FROM purchase_records pr JOIN products p ON p.id = pr.product_id
    WHERE 1=1${mw.sql}
    ORDER BY pr.occurred_at DESC, pr.id DESC
  `).all(...mw.args) as unknown as Record<string, number | string | null>[]
  appendSheet(
    wb,
    '进货明细',
    ['记录号', '时间', '品牌', '商品', '规格', '数量', '总金额(元)', '单价(元)', '渠道',
      '原平均成本(元)', '原库存', '新平均成本(元)', '备注'],
    purchaseRows.map((r) => [
      Number(r.id), s(r.occurred_at), s(r.brand), s(r.product_name), s(r.variant_name ?? ''),
      Number(r.qty), yuan(Number(r.total_cents)), yuan(Number(r.unit_cost_cents)), s(r.channel),
      yuan(Number(r.prev_avg_cost_cents)), Number(r.prev_stock_qty), yuan(Number(r.new_avg_cost_cents)), s(r.note),
    ]),
    [9, 22, 10, 12, 14, 8, 13, 11, 14, 15, 9, 15, 24],
  )

  // ⑤ 退款明细
  const refundRows = db.prepare(`
    SELECT rf.id, rf.sales_order_id, rf.occurred_at, p.brand, p.name AS product_name,
      rf.variant_name, rf.refund_cents, rf.refund_qty, rf.channel, rf.original_channel,
      rf.linked, rf.reason, rf.note
    FROM refunds rf JOIN products p ON p.id = rf.product_id
    WHERE 1=1${mw.sql}
    ORDER BY rf.occurred_at DESC, rf.id DESC
  `).all(...mw.args) as unknown as Record<string, number | string | null>[]
  appendSheet(
    wb,
    '退款明细',
    ['退款号', '关联订单', '时间', '品牌', '商品', '规格', '退款金额(元)', '退款数量',
      '退款渠道', '原订单渠道', '类型', '原因', '备注'],
    refundRows.map((r) => [
      Number(r.id), r.sales_order_id == null ? '' : Number(r.sales_order_id), s(r.occurred_at),
      s(r.brand), s(r.product_name), s(r.variant_name ?? ''),
      yuan(Number(r.refund_cents)), Number(r.refund_qty),
      s(r.channel), s(r.original_channel ?? ''), Number(r.linked) === 1 ? '关联退款' : '手动退款',
      s(r.reason), s(r.note),
    ]),
    [9, 11, 22, 10, 12, 14, 14, 11, 14, 15, 11, 20, 22],
  )

  // ⑥ 月度汇总
  const months = listBusinessMonths(db, 60)
  const monthRows: (string | number)[][] = []
  // 逐月算（月份数有限，成本可接受；且保证与报表口径完全一致）
  for (const m of [...months].reverse()) {
    const r = getMonthlyReport(db, m)
    monthRows.push([
      m, yuan(r.sales_cents), yuan(r.refund_cents), yuan(r.net_sales_cents),
      yuan(r.cost_cents), yuan(r.gross_profit_cents), `${(r.gross_margin * 100).toFixed(2)}%`,
      yuan(r.cs_income_cents), yuan(r.other_income_cents),
      yuan(r.expense_cents), yuan(r.other_expense_cents),
      yuan(r.net_profit_cents), `${(r.net_margin * 100).toFixed(2)}%`,
      r.order_count, r.sales_qty,
    ])
  }
  appendSheet(
    wb,
    '月度汇总',
    ['月份', '销售额(元)', '退款(元)', '净销售额(元)', '销售成本(元)', '毛利润(元)', '毛利率',
      '客服收入(元)', '其他收入(元)', '经营支出(元)', '其他支出(元)', '净利润(元)', '净利率', '订单数', '销量'],
    monthRows,
    [10, 13, 12, 14, 14, 13, 10, 13, 13, 13, 13, 13, 10, 9, 9],
  )

  // ⑦ 其他收支（客服 + 其他收支出 + 经营支出）
  const otherRows: (string | number)[][] = []
  const csRows = db.prepare(
    `SELECT occurred_at, amount_cents, channel, description, note FROM customer_service_income WHERE 1=1${mw.sql} ORDER BY occurred_at DESC`,
  ).all(...mw.args) as unknown as Record<string, number | string | null>[]
  csRows.forEach((r) => {
    otherRows.push(['客服收入', s(r.occurred_at), yuan(Number(r.amount_cents)), s(r.channel), '', s(r.description), s(r.note)])
  })
  const oieRows = db.prepare(
    `SELECT kind, occurred_at, amount_cents, channel, item_name, note FROM other_income_expense WHERE 1=1${mw.sql} ORDER BY occurred_at DESC`,
  ).all(...mw.args) as unknown as Record<string, number | string | null>[]
  oieRows.forEach((r) => {
    otherRows.push([
      r.kind === 'income' ? '其他收入' : '其他支出',
      s(r.occurred_at), yuan(Number(r.amount_cents)), s(r.channel), s(r.item_name), '', s(r.note),
    ])
  })
  const expRows = db.prepare(
    `SELECT occurred_at, amount_cents, channel, category, purpose, note FROM expense_records WHERE 1=1${mw.sql} ORDER BY occurred_at DESC`,
  ).all(...mw.args) as unknown as Record<string, number | string | null>[]
  expRows.forEach((r) => {
    otherRows.push(['经营支出', s(r.occurred_at), yuan(Number(r.amount_cents)), s(r.channel), s(r.category), s(r.purpose), s(r.note)])
  })
  appendSheet(
    wb,
    '其他收支',
    ['类型', '时间', '金额(元)', '渠道', '项目/分类', '描述/用途', '备注'],
    otherRows,
    [11, 22, 12, 14, 16, 22, 24],
  )

  return XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' }) as Buffer
}

/** 默认文件名：记账中心-经营报表-YYYY-MM-DD.xlsx 或 -YYYY-MM.xlsx。 */
export function businessExportFileName(month?: string | null): string {
  const day = new Date().toISOString().slice(0, 10)
  return month
    ? `记账中心-经营报表-${month}.xlsx`
    : `记账中心-经营报表-${day}.xlsx`
}

/** 供测试/预览：返回工作簿里各 sheet 的名称。 */
export function listWorkbookSheets(db: Database, options: BusinessExportOptions = {}): string[] {
  const buf = buildBusinessWorkbook(db, options)
  const wb = XLSX.read(buf, { type: 'buffer' })
  return wb.SheetNames
}

/** 供测试：读某 sheet 为二维数组。 */
export function readSheet(db: Database, sheetName: string, options: BusinessExportOptions = {}): (string | number)[][] {
  const buf = buildBusinessWorkbook(db, options)
  const wb = XLSX.read(buf, { type: 'buffer' })
  const ws = wb.Sheets[sheetName]
  if (!ws) throw new Error(`工作表「${sheetName}」不存在`)
  return XLSX.utils.sheet_to_json(ws, { header: 1, raw: true }) as (string | number)[][]
}
