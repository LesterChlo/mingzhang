// 账本导出（CSV / XLSX）：只读流水，走主进程保存对话框，渲染层不接触文件路径。
// 口径严格对齐报告：state='confirmed' 且 type ∈ {expense, income}（见 v_reportable_transactions）。
// 待确认、转账、不计收支（adjustment）、已删除原笔都不导出；已确认的拆账子项是真实流水，按报告口径保留。

import * as XLSX from 'xlsx'
import type { Database } from 'better-sqlite3-multiple-ciphers'
import type { LedgerFilter, LedgerRow } from '../../shared/types'
import { queryLedgerPage } from './ledger-page'

export type LedgerExportFormat = 'csv' | 'xlsx'

const HEADERS = ['日期', '类型', '分类', '账户', '金额(元)', '备注', '说明', '附件'] as const
const TYPE_LABELS: Record<string, string> = { expense: '支出', income: '收入' }
const REPORTABLE_TYPES = new Set(['expense', 'income'])

/** queryLedgerPage 单页硬上限 500；导出按页取全量。 */
const PAGE_SIZE = 500
/** 异常大库的保险丝：一次最多导出 5 万笔，避免把内存吃光。 */
const MAX_ROWS = 50_000

function text(value: string | null | undefined): string {
  return value === null || value === undefined ? '' : String(value)
}

/** CSV 单元格：统一双引号包裹；Excel 公式注入字符前置单引号。 */
function csvCell(value: string): string {
  const safe = /^[=+\-@\t\r]/.test(value) ? `'${value}` : value
  return `"${safe.replace(/"/g, '""')}"`
}

function rowValues(row: LedgerRow): string[] {
  return [
    text(row.occurredAt),
    TYPE_LABELS[row.type] ?? row.type,
    text(row.categoryName),
    text(row.accountName),
    (row.amountCents / 100).toFixed(2),
    text(row.note),
    text(row.merchant),
    text(row.attachmentRef),
  ]
}

/** UTF-8 BOM 让 Excel 直接打开中文不乱码。 */
export function buildLedgerCsv(rows: LedgerRow[]): string {
  const lines = [HEADERS.map(csvCell).join(',')]
  for (const row of rows) lines.push(rowValues(row).map(csvCell).join(','))
  return `\uFEFF${lines.join('\r\n')}\r\n`
}

/** 金额列写真数值（不是字符串），便于 Excel 里直接求和。 */
export function buildLedgerXlsx(rows: LedgerRow[]): Buffer {
  const sheet: (string | number)[][] = [[...HEADERS]]
  for (const row of rows) {
    const values = rowValues(row)
    sheet.push([...values.slice(0, 4), Number(values[4]), ...values.slice(5)])
  }
  const ws = XLSX.utils.aoa_to_sheet(sheet)
  ws['!cols'] = [
    { wch: 22 }, { wch: 10 }, { wch: 14 }, { wch: 14 },
    { wch: 14 }, { wch: 28 }, { wch: 28 }, { wch: 28 },
  ]
  const wb = XLSX.utils.book_new()
  XLSX.utils.book_append_sheet(wb, ws, '流水')
  return XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' }) as Buffer
}

/** 按当前筛选分页取全量，并强制收敛到报告口径（只留已确认收支）。 */
export function collectLedgerRows(db: Database, filter: LedgerFilter): LedgerRow[] {
  const fetched: LedgerRow[] = []
  let offset = 0
  while (fetched.length < MAX_ROWS) {
    // state 强制 confirmed：界面即使停在"待确认/已删除"筛选，导出也不会夹带未确认流水。
    const scoped: LedgerFilter = { ...filter, state: 'confirmed', limit: PAGE_SIZE, offset }
    if (scoped.type && !REPORTABLE_TYPES.has(scoped.type)) delete scoped.type
    const page = queryLedgerPage(db, scoped)
    fetched.push(...page.items)
    if (page.items.length === 0 || fetched.length >= page.total) break
    offset += page.items.length
  }
  return fetched.filter((r) => REPORTABLE_TYPES.has(r.type)).slice(0, MAX_ROWS)
}
