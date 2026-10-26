// Parent-frozen issue #28 contract: actual bill -> batch -> execute -> summary.
import { describe, expect, it } from 'vitest'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openSchemaDb } from './helpers'
import { seed } from '../src/main/db/seed'
import { stageBill, applyBillPlan } from '../src/main/domain/bill'
import { executeBatch, prepareBatch } from '../src/main/domain/batch'
import { getBatchSummary } from '../src/main/domain/batch-summary'

const header = ['时间', '对方', '金额', '收支', '状态']
function fixture(file = ':memory:') { const db = openSchemaDb(file); seed(db); return db }
function apply(db: ReturnType<typeof fixture>, cells: string[][]) {
  const table = stageBill(db, { sourceType: 'csv', fileName: 'synthetic.csv', cells: [header, ...cells] })
  const result = applyBillPlan(db, { table_id: table.id, columns: { time: '时间', merchant: '对方', amount: '金额', direction: '收支' }, account_name: '现金', skip_when: [{ column: '状态', contains: '排除' }], categories: [{ match: '合成', category_name: '其他' }] }, { sessionId: 'synthetic-session' })
  return { table, result }
}
function facts(db: ReturnType<typeof fixture>) {
  return ['transactions', 'audit_log', 'imports', 'bill_rows', 'pending_clarifications'].map(t => db.prepare(`SELECT * FROM ${t} ORDER BY ${t === 'bill_rows' ? 'table_id,row_no' : 'id'}`).all())
}

describe('不计收支逐行明细 · 父冻结验收', () => {
  it('混合账单按来源行保存全部排除明细，未执行仍无结果，读回零写入', () => {
    const db = fixture()
    try {
      const { table, result } = apply(db, [
        ['2026-06-01 09:00:00', '合成消费', '13.70', '支出', '正常'],
        ['2026-06-02 10:00:00', '合成退回', '8.25', '收入', '排除'],
        ['', '说明行', '', '', '排除'],
      ])
      expect(result.rowsConsidered).toBe(3); expect(result.skippedCount).toBe(2)
      expect(result.gateId).not.toBeNull()
      expect(getBatchSummary(db, result.gateId!)).toBeNull()
      expect(executeBatch(db, result.gateId!)).not.toBeNull()
      const before = facts(db)
      const s = getBatchSummary(db, result.gateId!)!
      expect(s.counts).toMatchObject({ booked: 1, excluded: 2 })
      expect(s.excludedRows).toEqual([
        { tableId: table.id, rowNo: 2, sourceText: '2026-06-02 10:00:00 · 合成退回 · 8.25 · 收入 · 排除', merchant: '合成退回', amountCents: 825, occurredAt: '2026-06-02 10:00:00', reason: '不计收支：状态 含「排除」' },
        { tableId: table.id, rowNo: 3, sourceText: '· 说明行 ·  ·  · 排除', merchant: '说明行', amountCents: null, occurredAt: null, reason: '不计收支：状态 含「排除」' },
      ])
      expect(facts(db)).toEqual(before)
    } finally { db.close() }
  })
  it('排除明细属于冻结计划：原表后来变化、另一批和重启都不串', () => {
    const file = join(mkdtempSync(join(tmpdir(), 'mz-excluded-parent-')), 'synthetic.db')
    const db = fixture(file)
    let first: number, second: number, before: unknown
    try {
      const a = apply(db, [['2026-06-03', '合成甲', '1.11', '收入', '排除'], ['2026-06-04', '合成乙', '2.22', '支出', '正常']])
      const b = apply(db, [['2026-06-05', '合成丙', '3.33', '收入', '排除'], ['2026-06-06', '合成丁', '4.44', '支出', '正常']])
      first = a.result.gateId!; second = b.result.gateId!
      executeBatch(db, first); executeBatch(db, second)
      before = getBatchSummary(db, first)
      expect((before as { excludedRows: { merchant: string }[] }).excludedRows[0].merchant).toBe('合成甲')
      expect((getBatchSummary(db, second)!.excludedRows as unknown as { merchant: string }[])[0].merchant).toBe('合成丙')
      db.prepare("UPDATE bill_rows SET cells='[\"changed\"]', reason='changed' WHERE table_id=? AND row_no=1").run(a.table.id)
      expect(getBatchSummary(db, first)).toEqual(before)
    } finally { db.close() }
    const reopened = openSchemaDb(file)
    try { expect(getBatchSummary(reopened, first!)).toEqual(before) } finally { reopened.close() }
  })
  it('全排除也留可确认结果来源；零笔交易而不是丢掉这份账单', () => {
    const db = fixture()
    try {
      const { result } = apply(db, [['2026-06-07', '合成排除', '5.55', '转出', '排除']])
      expect(result.gateId).not.toBeNull()
      expect(executeBatch(db, result.gateId!)).not.toBeNull()
      const s = getBatchSummary(db, result.gateId!)!
      expect(s.counts).toMatchObject({ booked: 0, excluded: 1 })
      expect(s.excludedRows).toHaveLength(1)
      expect(db.prepare('SELECT COUNT(*) n FROM transactions').get()).toEqual({ n: 0 })
    } finally { db.close() }
  })
  it('没有保存明细的旧批明确null；取消门不是已执行结果', () => {
    const db = fixture()
    try {
      const legacy = prepareBatch(db, { sourceType: 'csv', sessionId: 'old', skippedCount: 2, items: [{ amount_cents: 500, merchant: '旧合成', category_name: '其他' }] })
      executeBatch(db, legacy.gateId)
      expect(getBatchSummary(db, legacy.gateId)!.excludedRows).toBeNull()
      const cancel = prepareBatch(db, { sourceType: 'csv', sessionId: 'cancel', items: [{ amount_cents: 100 }] })
      db.prepare("UPDATE pending_clarifications SET status='cancelled' WHERE id=?").run(cancel.gateId)
      expect(getBatchSummary(db, cancel.gateId)).toBeNull()
    } finally { db.close() }
  })
})
