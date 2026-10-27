// issue #28: database faults must leave rows, imports and gates retryable.
import { describe, expect, it } from 'vitest'
import { openSchemaDb } from './helpers'
import { seed } from '../src/main/db/seed'
import { applyBillPlan, type BillPlanInput, stageBill } from '../src/main/domain/bill'
import { executeBatch, prepareBatch } from '../src/main/domain/batch'
import { getBatchSummary } from '../src/main/domain/batch-summary'
import { getPending } from '../src/main/domain/pending'
import type { BatchExcludedRowDTO } from '../src/shared/types'

function fixture() {
  const db = openSchemaDb(':memory:')
  seed(db)
  return db
}

function facts(db: ReturnType<typeof fixture>) {
  return ['transactions', 'audit_log', 'imports', 'bill_rows', 'pending_clarifications', 'rules']
    .map((table) => db.prepare(`SELECT * FROM ${table} ORDER BY ${table === 'bill_rows' ? 'table_id,row_no' : 'id'}`).all())
}

const excluded: BatchExcludedRowDTO = {
  tableId: 1, rowNo: 1, sourceText: '合成来源', merchant: null, amountCents: null, occurredAt: null, reason: '按方案逐行排除',
}

const modes = ['mixed', 'excluded-only'] as const

describe('排除行原子性与重试', () => {
  it('prepare建门失败不得留下孤儿import或审计，恢复后只能产生一个真实方案', () => {
    const db = fixture()
    try {
      db.exec("CREATE TEMP TRIGGER fail_prepare BEFORE INSERT ON pending_clarifications WHEN NEW.field='batch_confirm' BEGIN SELECT RAISE(ABORT, 'synthetic-prepare-failure'); END")
      const before = facts(db)
      const input = { sourceType: 'csv' as const, sessionId: 'synthetic-prepare', items: [], skippedCount: 1, excludedRows: [excluded] }
      expect(() => prepareBatch(db, input)).toThrow(/synthetic-prepare-failure/)
      expect(facts(db)).toEqual(before)
      db.exec('DROP TRIGGER fail_prepare')
      const result = prepareBatch(db, input)
      expect(result.plan.excludedRows).toEqual([excluded])
      expect(db.prepare('SELECT COUNT(*) n FROM imports').get()).toEqual({ n: 1 })
      expect(db.prepare("SELECT COUNT(*) n FROM pending_clarifications WHERE field='batch_confirm'").get()).toEqual({ n: 1 })
    } finally {
      db.close()
    }
  })

  it.each(modes)('apply建门失败原表、import、审计全部回滚：%s', (mode) => {
    const db = fixture()
    try {
      const cells = [['时间', '金额', '状态'], ['2026-04-01', '1.00', '排除']]
      if (mode === 'mixed') cells.push(['2026-04-02', '2.00', '正常'])
      const table = stageBill(db, { sourceType: 'csv', cells })
      const plan: BillPlanInput = { table_id: table.id, columns: { time: '时间', amount: '金额' }, skip_when: [{ column: '状态', contains: '排除' }] }
      db.exec("CREATE TEMP TRIGGER fail_apply BEFORE INSERT ON pending_clarifications WHEN NEW.field='batch_confirm' BEGIN SELECT RAISE(ABORT, 'synthetic-apply-failure'); END")
      const before = facts(db)
      expect(() => applyBillPlan(db, plan, { sessionId: 'synthetic-apply' })).toThrow(/synthetic-apply-failure/)
      expect(facts(db)).toEqual(before)
      db.exec('DROP TRIGGER fail_apply')
      const result = applyBillPlan(db, plan, { sessionId: 'synthetic-apply' })
      expect(result.plan?.excludedRows).toHaveLength(1)
      expect(db.prepare('SELECT COUNT(*) n FROM imports').get()).toEqual({ n: 1 })
    } finally {
      db.close()
    }
  })

  it('apply更新排除行失败不得部分消费已计划行或门，恢复后可重试', () => {
    const db = fixture()
    try {
      const table = stageBill(db, { sourceType: 'csv', cells: [['时间', '金额', '状态'], ['2026-04-01', '1.00', '正常'], ['2026-04-02', '2.00', '排除']] })
      const plan: BillPlanInput = { table_id: table.id, columns: { time: '时间', amount: '金额' }, skip_when: [{ column: '状态', contains: '排除' }] }
      db.exec("CREATE TEMP TRIGGER fail_rows BEFORE UPDATE ON bill_rows WHEN NEW.disposition='skipped' BEGIN SELECT RAISE(ABORT, 'synthetic-row-failure'); END")
      const before = facts(db)
      expect(() => applyBillPlan(db, plan, { sessionId: 'synthetic-rows' })).toThrow(/synthetic-row-failure/)
      expect(facts(db)).toEqual(before)
      db.exec('DROP TRIGGER fail_rows')
      expect(applyBillPlan(db, plan, { sessionId: 'synthetic-rows' }).gateId).not.toBeNull()
    } finally {
      db.close()
    }
  })

  it.each(modes)('execute关门失败回滚交易与import，保持open且无结果，重试只执行一次：%s', (mode) => {
    const db = fixture()
    try {
      const items = mode === 'mixed' ? [{ tx_type: 'expense' as const, occurred_at: '2026-04-01T09:17:00+08:00', account_name: '现金', amount_cents: 100, merchant: '合成执行', category_name: '其他' }] : []
      const prepared = prepareBatch(db, { sourceType: 'csv', sessionId: 'synthetic-execute', items, skippedCount: 1, excludedRows: [excluded] })
      db.exec("CREATE TEMP TRIGGER fail_close BEFORE UPDATE OF status ON pending_clarifications WHEN NEW.field='batch_confirm' AND NEW.status='resolved' BEGIN SELECT RAISE(ABORT, 'synthetic-close-failure'); END")
      const before = facts(db)
      expect(() => executeBatch(db, prepared.gateId)).toThrow(/synthetic-close-failure/)
      expect(facts(db)).toEqual(before)
      expect(getPending(db, prepared.gateId)?.status).toBe('open')
      expect(getBatchSummary(db, prepared.gateId)).toBeNull()
      db.exec('DROP TRIGGER fail_close')
      expect(executeBatch(db, prepared.gateId)?.completed).toHaveLength(mode === 'mixed' ? 1 : 0)
      expect(getBatchSummary(db, prepared.gateId)?.excludedRows).toEqual([excluded])
      const after = facts(db)
      expect(executeBatch(db, prepared.gateId)).toBeNull()
      expect(facts(db)).toEqual(after)
    } finally {
      db.close()
    }
  })
})
