import { expect, it } from 'vitest'
import * as XLSX from 'xlsx'
import { openSchemaDb } from './helpers'
import { seed } from '../src/main/db/seed'
import { buildLedgerCsv, buildLedgerXlsx, collectLedgerRows } from '../src/main/domain/ledger-export'

function fixture() {
  const db = openSchemaDb(':memory:')
  seed(db)
  const insert = db.prepare(
    'INSERT INTO transactions (account_id,category_id,amount_cents,type,to_account_id,occurred_at,state,merchant,note,created_at,updated_at)' +
    ' VALUES (?,?,?,?,?,?,?,?,?,\'2026-10-05\',\'2026-10-05\')',
  )
  insert.run(1, 1, 1234, 'expense', null, '2026-10-05 10:12:00', 'confirmed', '=1+1 危险商户', '合成备注')
  // 报告口径之外：待确认、不计收支、转账、已删除原笔，都不该出现在导出里。
  insert.run(1, 1, 999, 'expense', null, '2026-10-05 11:00:00', 'needs_review', '待确认', null)
  insert.run(1, 1, 888, 'adjustment', null, '2026-10-05 12:00:00', 'confirmed', '不计收支', null)
  insert.run(1, null, 777, 'transfer', 2, '2026-10-05 13:00:00', 'confirmed', '转账', null)
  insert.run(1, 1, 666, 'expense', null, '2026-10-05 14:00:00', 'deleted', '已删除', null)
  return db
}

it('CSV 带 BOM、中文表头与备注，对公式注入字符转义，且只导出已确认收支', () => {
  const db = fixture()
  try {
    const rows = collectLedgerRows(db, { month: '2026-10' })
    expect(rows).toHaveLength(1)
    const csv = buildLedgerCsv(rows)
    expect(csv.startsWith('\uFEFF')).toBe(true)
    expect(csv).toContain('"日期"')
    expect(csv).toContain('"支出"')
    expect(csv).toContain('"餐饮"')
    expect(csv).toContain('"合成备注"')
    expect(csv).toContain('"\'=1+1 危险商户"')
    expect(csv).toContain('"12.34"')
    expect(csv).not.toContain('待确认')
    expect(csv).not.toContain('转账')
  } finally {
    db.close()
  }
})

it('XLSX 是真工作簿：报告口径、中文类型、金额数值、备注列', () => {
  const db = fixture()
  try {
    expect(collectLedgerRows(db, { month: '2026-09' })).toHaveLength(0)
    // 即使界面停在"待确认"筛选，导出仍按报告口径取已确认流水。
    const rows = collectLedgerRows(db, { month: '2026-10', state: 'needs_review' })
    const wb = XLSX.read(buildLedgerXlsx(rows), { type: 'buffer' })
    const sheet = XLSX.utils.sheet_to_json<unknown[]>(wb.Sheets['流水'], { header: 1 })
    expect(sheet[0]).toEqual(['日期', '类型', '分类', '账户', '金额(元)', '备注', '说明', '附件'])
    expect(sheet).toHaveLength(2)
    expect(sheet[1][1]).toBe('支出')
    expect(sheet[1][2]).toBe('餐饮')
    expect(sheet[1][4]).toBe(12.34)
    expect(sheet[1][5]).toBe('合成备注')
  } finally {
    db.close()
  }
})
