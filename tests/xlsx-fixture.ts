// 合成"假微信账单" XLSX 夹具（红线：绝不读真实账单）。脚本化生成，供 xlsx 导入解析测试用。
import * as XLSX from 'xlsx'

// 表头前若干行说明文字（微信账单真实形态）+ 真实表头 + 数据行 + 尾部落款空行。
const PREAMBLE = [
  ['微信支付账单流水文件(20260304-20260904)——导出时间：2026-09-04 22:34:12'],
  [],
  ['--------- 账单概要 ---------'],
  ['出入账类型：全部'],
  ['收入金额：￥123.45'],
  ['支出金额：￥678.90'],
  ['时间区间：[2026-03-04,2026-09-04]'],
  [],
  ['--------- 交易记录 ---------'],
]

export const WECHAT_HEADER = [
  '交易时间',
  '交易类型',
  '交易对方',
  '商品',
  '收/支',
  '金额(元)',
  '支付方式',
  '当前状态',
  '交易单号',
  '商户单号',
  '备注',
]

export const WECHAT_ROWS: string[][] = [
  ['2026-09-01 10:12:00', '商户消费', '星巴克咖啡', '拿铁', '支出', '¥35.00', '零钱', '支付成功', 'WX20260901A', 'M1', ''],
  ['2026-09-01 18:30:00', '商户消费', '全家便利店', '关东煮', '支出', '¥12.50', '零钱', '支付成功', 'WX20260901B', 'M2', ''],
  ['2026-09-02 09:00:00', '转账', '小明', '/', '支出', '¥50.00', '零钱通', '已转账', 'WX20260902T', 'M3', '还款'],
  ['2026-09-03 12:00:00', '零钱充值', '本人', '/', '/', '¥100.00', '招商银行', '充值成功', 'WX20260903C', 'M4', ''],
]

/** 生成一份"假微信账单" xlsx 的字节（ArrayBuffer）。 */
export function makeWechatXlsxBuffer(rowCount?: number): ArrayBuffer {
  const rows = rowCount === undefined ? WECHAT_ROWS : bulkWechatRows(rowCount)
  const aoa: (string[] | undefined)[][] = [...PREAMBLE, WECHAT_HEADER, ...rows, [], ['---- 以上为账单内容 ----']]
  const ws = XLSX.utils.aoa_to_sheet(aoa)
  const wb = XLSX.utils.book_new()
  XLSX.utils.book_append_sheet(wb, ws, '微信支付账单')
  return XLSX.write(wb, { type: 'array', bookType: 'xlsx' }) as ArrayBuffer
}

/** 生成一份没有账单表头的坏 xlsx（模拟非账单文件）。 */
export function makeJunkXlsxBuffer(): ArrayBuffer {
  const ws = XLSX.utils.aoa_to_sheet([['随便', '一些', '列'], ['a', 'b', 'c']])
  const wb = XLSX.utils.book_new()
  XLSX.utils.book_append_sheet(wb, ws, 'Sheet1')
  return XLSX.write(wb, { type: 'array', bookType: 'xlsx' }) as ArrayBuffer
}

/**
 * 批量假账单（第 8 单大批量回归）：金额与"不计收支"行都可由行数精确推出，真值另算与实现无关。
 * 每 50 行插一行「不计收支 + 已全额退款」（应被方案排除、不进账）；日期落在本月内避免跨月口径。
 */
export function bulkWechatRows(n: number): string[][] {
  const now = new Date()
  const ym = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`
  const days = Math.min(28, new Date(now.getFullYear(), now.getMonth() + 1, 0).getDate())
  return Array.from({ length: n }, (_, i) => {
    const refund = i % 50 === 49
    return [
      `${ym}-${String((i % days) + 1).padStart(2, '0')} ${String(8 + (i % 12)).padStart(2, '0')}:${String(i % 60).padStart(2, '0')}:00`,
      '商户消费',
      `演示商户${i}`,
      '测试商品',
      refund ? '不计收支' : '支出',
      `¥${(((i % 97) + 1) * 100 / 100).toFixed(2)}`,
      '零钱',
      refund ? '已全额退款' : '支付成功',
      `BULK${String(i).padStart(6, '0')}`,
      `M${i}`,
      '',
    ]
  })
}

/** 批量假账单的真值：入账笔数 / 入账合计（分）/ 不计收支行数。 */
export function bulkExpect(n: number): { count: number; cents: number; skipped: number } {
  let count = 0
  let cents = 0
  let skipped = 0
  for (let i = 0; i < n; i++) {
    if (i % 50 === 49) {
      skipped += 1
      continue
    }
    count += 1
    cents += (i % 97 + 1) * 100
  }
  return { count, cents, skipped }
}
