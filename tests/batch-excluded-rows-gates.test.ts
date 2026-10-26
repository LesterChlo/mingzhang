// issue #28: excluded-only batches still need the existing confirmation gate.
import { describe, expect, it } from 'vitest'
import { openSchemaDb } from './helpers'
import { seed } from '../src/main/db/seed'
import { applyBillPlan, getBillTable, stageBill } from '../src/main/domain/bill'
import { executeBatch, prepareBatch } from '../src/main/domain/batch'
import { getBatchSummary } from '../src/main/domain/batch-summary'
import { getPending } from '../src/main/domain/pending'

function fixture() {
  const db = openSchemaDb(':memory:')
  seed(db)
  return db
}

function facts(db: ReturnType<typeof fixture>) {
  return ['transactions', 'audit_log', 'imports', 'bill_rows', 'pending_clarifications', 'rules']
    .map((table) => db.prepare(`SELECT * FROM ${table} ORDER BY ${table === 'bill_rows' ? 'table_id,row_no' : 'id'}`).all())
}

describe('全排除批次确认门', () => {
  it('0 items仍保存真实排除方案，确认一次关闭门并收口import，绝不落账', () => {
    const db = fixture()
    try {
      const table = stageBill(db, {
        sourceType: 'csv',
        cells: [['时间', '对方', '金额', '状态'], ['不明时刻', '合成只排除', '免费', '排除']],
      })
      const result = applyBillPlan(db, {
        table_id: table.id,
        columns: { time: '时间', merchant: '对方', amount: '金额' },
        row_overrides: [{ rows: [1], type: 'skip' }],
      }, { sessionId: 'synthetic-only-excluded' })
      expect(result.gateId).not.toBeNull()
      expect(result.plan).toMatchObject({
        items: [], newCount: 0, duplicateCount: 0, unparsedCount: 0, skippedCount: 1, rowsConsidered: 1,
        excludedRows: [{ tableId: table.id, rowNo: 1, merchant: '合成只排除', amountCents: null, occurredAt: null, reason: '按方案逐行排除', sourceText: '不明时刻 · 合成只排除 · 免费 · 排除' }],
      })
      expect(getPending(db, result.gateId!)?.status).toBe('open')
      expect(getPending(db, result.gateId!)?.question).toContain('1 行按方案不计收支')
      expect(getBillTable(db, table.id)?.openRows).toBe(0)
      expect(getBatchSummary(db, result.gateId!)).toBeNull()
      expect(executeBatch(db, result.gateId!)).toEqual({
        completed: [], duplicates: [], unparsedKept: 0, transfersSkipped: [], unmatchedAccounts: 0, importStatus: 'confirmed',
      })
      expect(getPending(db, result.gateId!)?.status).toBe('resolved')
      expect(db.prepare('SELECT status FROM imports WHERE id=?').get(result.plan!.importId)).toEqual({ status: 'confirmed' })
      expect(getBatchSummary(db, result.gateId!)?.counts).toEqual({ booked: 0, needsCategory: 0, excluded: 1, duplicates: 0, unparsed: 0 })
      expect(getBatchSummary(db, result.gateId!)?.excludedRows).toEqual(result.plan!.excludedRows)
      expect(db.prepare('SELECT COUNT(*) n FROM transactions').get()).toEqual({ n: 0 })
      const before = facts(db)
      expect(executeBatch(db, result.gateId!)).toBeNull()
      expect(() => applyBillPlan(db, { table_id: table.id, columns: { time: '时间', amount: '金额' } }, { sessionId: 'again' })).toThrow(/都处理过了/)
      expect(facts(db)).toEqual(before)
    } finally {
      db.close()
    }
  })

  it('真正空批次或只有旧计数没有明细的0 items仍拒绝且零写入', () => {
    const db = fixture()
    try {
      const before = facts(db)
      for (const extra of [{}, { skippedCount: 1 }, { skippedCount: 0, excludedRows: [] }]) {
        expect(() => prepareBatch(db, { sourceType: 'csv', sessionId: 'synthetic-empty', items: [], ...extra })).toThrow(/批次为空/)
        expect(facts(db)).toEqual(before)
      }
    } finally {
      db.close()
    }
  })
})
