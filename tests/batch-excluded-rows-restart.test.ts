// issue #28: snapshots survive restart before confirmation and never read mutable bill_rows.
import { describe, expect, it } from 'vitest'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openSchemaDb } from './helpers'
import { seed } from '../src/main/db/seed'
import { applyBillPlan, stageBill } from '../src/main/domain/bill'
import { executeBatch } from '../src/main/domain/batch'
import { getBatchSummary, getLatestBatchSummary } from '../src/main/domain/batch-summary'
import { getPending } from '../src/main/domain/pending'

const header = ['时间', '商户', '金额', '状态']

function apply(db: ReturnType<typeof openSchemaDb>, cells: string[][]) {
  const table = stageBill(db, { sourceType: 'csv', cells: [header, ...cells], fileName: 'synthetic-restart.csv' })
  const result = applyBillPlan(db, {
    table_id: table.id,
    columns: { time: '时间', merchant: '商户', amount: '金额' },
    skip_when: [{ column: '状态', contains: '排除' }],
    categories: [{ match: '合成', category_name: '其他' }],
  }, { sessionId: 'synthetic-restart' })
  return { table, result }
}

function facts(db: ReturnType<typeof openSchemaDb>) {
  return ['transactions', 'audit_log', 'imports', 'bill_rows', 'pending_clarifications', 'rules']
    .map((table) => db.prepare(`SELECT * FROM ${table} ORDER BY ${table === 'bill_rows' ? 'table_id,row_no' : 'id'}`).all())
}

describe('排除行重启与来源隔离', () => {
  it('两表0items/混合计划确认前重启，删改原表后执行与再次重启仍逐字读回自己的来源', () => {
    const file = join(mkdtempSync(join(tmpdir(), 'mz-excluded-restart-')), 'synthetic.db')
    const db = openSchemaDb(file)
    seed(db)
    const a = apply(db, [['2026-04-11', '合成甲排除', '1.11', '排除']])
    const b = apply(db, [['2026-04-12', '合成乙入账', '2.22', '正常'], ['2026-04-13', '合成乙排除', '3.33', '排除']])
    const expectedA = JSON.parse(getPending(db, a.result.gateId!)!.payload).plan.excludedRows
    const expectedB = JSON.parse(getPending(db, b.result.gateId!)!.payload).plan.excludedRows
    try {
      expect(expectedA[0]).toMatchObject({ tableId: a.table.id, rowNo: 1, merchant: '合成甲排除' })
      expect(expectedB[0]).toMatchObject({ tableId: b.table.id, rowNo: 2, merchant: '合成乙排除' })
      expect(getLatestBatchSummary(db)).toBeNull()
      db.prepare('DELETE FROM bill_rows WHERE table_id=?').run(a.table.id)
      db.prepare('UPDATE bill_rows SET cells=?, reason=? WHERE table_id=? AND row_no=2').run('["later unrelated source"]', 'later reason', b.table.id)
    } finally {
      db.close()
    }

    const restarted = openSchemaDb(file)
    let afterA: ReturnType<typeof getBatchSummary>, afterB: ReturnType<typeof getBatchSummary>
    try {
      expect(getBatchSummary(restarted, a.result.gateId!)).toBeNull()
      expect(getBatchSummary(restarted, b.result.gateId!)).toBeNull()
      expect(executeBatch(restarted, a.result.gateId!)?.completed).toHaveLength(0)
      expect(executeBatch(restarted, b.result.gateId!)?.completed).toHaveLength(1)
      afterA = getBatchSummary(restarted, a.result.gateId!)
      afterB = getBatchSummary(restarted, b.result.gateId!)
      expect(afterA?.excludedRows).toEqual(expectedA)
      expect(afterB?.excludedRows).toEqual(expectedB)
      const before = facts(restarted)
      afterA!.excludedRows![0].merchant = 'caller mutation'
      expect(getBatchSummary(restarted, a.result.gateId!)?.excludedRows).toEqual(expectedA)
      afterA = getBatchSummary(restarted, a.result.gateId!)
      expect(facts(restarted)).toEqual(before)
    } finally {
      restarted.close()
    }

    const secondRestart = openSchemaDb(file)
    try {
      const before = facts(secondRestart)
      expect(getBatchSummary(secondRestart, a.result.gateId!)).toEqual(afterA!)
      expect(getBatchSummary(secondRestart, b.result.gateId!)).toEqual(afterB!)
      expect(getLatestBatchSummary(secondRestart)?.gateId).toBe(b.result.gateId)
      expect(executeBatch(secondRestart, a.result.gateId!)).toBeNull()
      expect(facts(secondRestart)).toEqual(before)
    } finally {
      secondRestart.close()
    }
  })
})
