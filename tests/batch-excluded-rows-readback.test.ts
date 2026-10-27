// issue #28: only resolved batch_confirm gates are executed results.
import { describe, expect, it } from 'vitest'
import { openSchemaDb } from './helpers'
import { seed } from '../src/main/db/seed'
import { executeBatch, prepareBatch } from '../src/main/domain/batch'
import { applyBillPlan, stageBill } from '../src/main/domain/bill'
import { getBatchSummary, getLatestBatchSummary } from '../src/main/domain/batch-summary'
import { closePending, getPending } from '../src/main/domain/pending'
import { createRule } from '../src/main/domain/rules'

function fixture() {
  const db = openSchemaDb(':memory:')
  seed(db)
  return db
}

function facts(db: ReturnType<typeof fixture>) {
  return ['transactions', 'audit_log', 'imports', 'bill_rows', 'pending_clarifications', 'rules']
    .map((table) => db.prepare(`SELECT * FROM ${table} ORDER BY ${table === 'bill_rows' ? 'table_id,row_no' : 'id'}`).all())
}

describe('排除行结果读回语义', () => {
  it('取消的较新门不是结果：指定读回为null，最新结果仍指向已执行批次', () => {
    const db = fixture()
    try {
      const first = prepareBatch(db, { sourceType: 'csv', sessionId: 'synthetic-resolved', items: [{ amount_cents: 100, merchant: '合成已执行', category_name: '其他' }] })
      executeBatch(db, first.gateId)
      const resolved = getBatchSummary(db, first.gateId)
      const cancelled = prepareBatch(db, { sourceType: 'csv', sessionId: 'synthetic-cancelled', items: [{ amount_cents: 200 }] })
      closePending(db, cancelled.gateId, 'cancelled')
      db.prepare("UPDATE pending_clarifications SET updated_at='2099-01-01T00:00:00+08:00' WHERE id=?").run(cancelled.gateId)
      const before = facts(db)
      expect(getBatchSummary(db, cancelled.gateId)).toBeNull()
      expect(getLatestBatchSummary(db)).toEqual(resolved)
      expect(executeBatch(db, cancelled.gateId)).toBeNull()
      expect(facts(db)).toEqual(before)
    } finally {
      db.close()
    }
  })

  it('旧批缺字段或显式null即使计数为0仍是null，不从bill_rows重建来源', () => {
    const db = fixture()
    try {
      for (const excludedRows of [undefined, null]) {
        const legacy = prepareBatch(db, { sourceType: 'text', sessionId: 'synthetic-legacy', items: [{ amount_cents: 100, category_name: '其他' }] })
        const payload = JSON.parse(getPending(db, legacy.gateId)!.payload)
        if (excludedRows === undefined) delete payload.plan.excludedRows
        else payload.plan.excludedRows = excludedRows
        db.prepare('UPDATE pending_clarifications SET payload=? WHERE id=?').run(JSON.stringify(payload), legacy.gateId)
        executeBatch(db, legacy.gateId)
        expect(getBatchSummary(db, legacy.gateId)?.counts.excluded).toBe(0)
        expect(getBatchSummary(db, legacy.gateId)?.excludedRows).toBeNull()
      }
    } finally {
      db.close()
    }
  })

  it('读回反复遇到实际规则仍不加hit、不造交易或分类审计', () => {
    const db = fixture()
    try {
      const ruleId = createRule(db, { match: 'merchant', op: 'contains', value: '合成规则' }, { set_category: '其他' })
      const table = stageBill(db, { sourceType: 'csv', cells: [
        ['时间', '商户', '金额', '状态'],
        ['2026-04-01', '合成规则已入账', '1.00', '正常'],
        ['2026-04-02', '合成规则排除', '2.00', '排除'],
      ] })
      const result = applyBillPlan(db, {
        table_id: table.id, columns: { time: '时间', merchant: '商户', amount: '金额' }, default_type: 'expense', account_name: '现金',
        skip_when: [{ column: '状态', contains: '排除' }],
      }, { sessionId: 'synthetic-readonly-rules' })
      executeBatch(db, result.gateId!)
      expect(db.prepare('SELECT hit_count FROM rules WHERE id=?').get(ruleId)).toEqual({ hit_count: 1 })
      const before = facts(db)
      const summary = getBatchSummary(db, result.gateId!)
      for (let i = 0; i < 3; i++) {
        expect(getBatchSummary(db, result.gateId!)).toEqual(summary)
        expect(getLatestBatchSummary(db)).toEqual(summary)
      }
      expect(facts(db)).toEqual(before)
      expect(db.prepare('SELECT hit_count FROM rules WHERE id=?').get(ruleId)).toEqual({ hit_count: 1 })
    } finally {
      db.close()
    }
  })

  it('确定性套表完整保存且没有排除时返回[]，与旧null区分', () => {
    const db = fixture()
    try {
      const table = stageBill(db, { sourceType: 'csv', cells: [['时间', '金额'], ['2026-04-01', '1.00']] })
      const result = applyBillPlan(db, { table_id: table.id, columns: { time: '时间', amount: '金额' } }, { sessionId: 'synthetic-zero-excluded' })
      expect(result.plan?.excludedRows).toEqual([])
      executeBatch(db, result.gateId!)
      expect(getBatchSummary(db, result.gateId!)?.excludedRows).toEqual([])
      expect(getBatchSummary(db, result.gateId!)?.counts.excluded).toBe(0)
    } finally {
      db.close()
    }
  })
})
