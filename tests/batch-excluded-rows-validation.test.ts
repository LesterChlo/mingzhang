// issue #28: an incomplete/corrupt snapshot cannot claim complete excluded details.
import { describe, expect, it } from 'vitest'
import { openSchemaDb } from './helpers'
import { seed } from '../src/main/db/seed'
import { executeBatch, prepareBatch } from '../src/main/domain/batch'
import { getBatchSummary } from '../src/main/domain/batch-summary'
import { getPending } from '../src/main/domain/pending'
import type { BatchExcludedRowDTO } from '../src/shared/types'

function fixture() {
  const db = openSchemaDb(':memory:')
  seed(db)
  return db
}

const row: BatchExcludedRowDTO = {
  tableId: 41, rowNo: 2, sourceText: '2026-04-02 · 合成排除 · 2.22', merchant: '合成排除',
  amountCents: 222, occurredAt: '2026-04-02 00:00:00', reason: '按方案逐行排除',
}

function input(excludedRows: unknown = [row]) {
  return {
    sourceType: 'csv' as const, sessionId: 'synthetic-validation', billTableId: 41, rowsConsidered: 2, skippedCount: 1,
    items: [{ tx_type: 'expense' as const, occurred_at: '2026-04-01T09:17:00+08:00', account_name: '现金', amount_cents: 100, category_name: '其他', row_no: 1 }],
    excludedRows: excludedRows as BatchExcludedRowDTO[],
  }
}

function facts(db: ReturnType<typeof fixture>) {
  return ['transactions', 'audit_log', 'imports', 'pending_clarifications', 'rules']
    .map((table) => db.prepare(`SELECT * FROM ${table} ORDER BY id`).all())
}

const invalidRows: [string, unknown][] = [
  ['object instead of array', { ...row }],
  ['empty but skippedCount is one', []],
  ['null element', [null]],
  ['missing reason', [{ ...row, reason: undefined }]],
  ['empty reason', [{ ...row, reason: ' ' }]],
  ['empty source text', [{ ...row, sourceText: '' }]],
  ['missing merchant', [{ ...row, merchant: undefined }]],
  ['bad merchant type', [{ ...row, merchant: 99 }]],
  ['noninteger table id', [{ ...row, tableId: 41.5 }]],
  ['wrong source table', [{ ...row, tableId: 42 }]],
  ['nonpositive row number', [{ ...row, rowNo: 0 }]],
  ['overlaps booked row', [{ ...row, rowNo: 1 }]],
  ['noninteger cents', [{ ...row, amountCents: 2.22 }]],
  ['negative cents', [{ ...row, amountCents: -222 }]],
  ['missing time', [{ ...row, occurredAt: undefined }]],
  ['bad time type', [{ ...row, occurredAt: 20260402 }]],
]

describe('排除行快照校验', () => {
  it.each(invalidRows)('读回坏明细为null且计数仍取plan：%s', (_name, value) => {
    const db = fixture()
    try {
      const prepared = prepareBatch(db, input())
      executeBatch(db, prepared.gateId)
      const payload = JSON.parse(getPending(db, prepared.gateId)!.payload)
      payload.plan.excludedRows = value
      db.prepare('UPDATE pending_clarifications SET payload=? WHERE id=?').run(JSON.stringify(payload), prepared.gateId)
      const before = facts(db)
      const summary = getBatchSummary(db, prepared.gateId)!
      expect(summary.counts.excluded).toBe(1)
      expect(summary.excludedRows).toBeNull()
      expect(facts(db)).toEqual(before)
    } finally {
      db.close()
    }
  })

  it('重复来源行即使数量凑齐也不是完整明细', () => {
    const db = fixture()
    try {
      const prepared = prepareBatch(db, input())
      executeBatch(db, prepared.gateId)
      const payload = JSON.parse(getPending(db, prepared.gateId)!.payload)
      payload.plan.skippedCount = 2
      payload.plan.rowsConsidered = 3
      payload.plan.excludedRows = [row, { ...row }]
      db.prepare('UPDATE pending_clarifications SET payload=? WHERE id=?').run(JSON.stringify(payload), prepared.gateId)
      expect(getBatchSummary(db, prepared.gateId)?.counts.excluded).toBe(2)
      expect(getBatchSummary(db, prepared.gateId)?.excludedRows).toBeNull()
    } finally {
      db.close()
    }
  })

  it('行数对账不平不称完整明细，保持原计数而不从原表补齐', () => {
    const db = fixture()
    try {
      const prepared = prepareBatch(db, input())
      executeBatch(db, prepared.gateId)
      const payload = JSON.parse(getPending(db, prepared.gateId)!.payload)
      payload.plan.rowsConsidered = 99
      db.prepare('UPDATE pending_clarifications SET payload=? WHERE id=?').run(JSON.stringify(payload), prepared.gateId)
      expect(getBatchSummary(db, prepared.gateId)?.excludedRows).toBeNull()
    } finally {
      db.close()
    }
  })

  it.each(invalidRows)('prepare拒绝坏明细并在写入前退出：%s', (_name, value) => {
    const db = fixture()
    try {
      const before = facts(db)
      expect(() => prepareBatch(db, input(value))).toThrow(/排除行/)
      expect(facts(db)).toEqual(before)
    } finally {
      db.close()
    }
  })

  it.each([
    ['invalid JSON', '{'],
    ['no plan', '{}'],
    ['items is an object', { items: {} }],
    ['null plan item', { items: [null] }],
    ['unknown item status', { items: [{ status: 'invented' }] }],
    ['invalid import id', { importId: '1' }],
    ['invalid skipped count', { skippedCount: '1' }],
    ['negative skipped count', { skippedCount: -1 }],
    ['fractional duplicate count', { duplicateCount: 0.5 }],
    ['invalid unparsed count', { unparsedCount: [] }],
  ])('坏核心计划返回null而不抛出或编计数：%s', (_name, delta) => {
    const db = fixture()
    try {
      const prepared = prepareBatch(db, input())
      executeBatch(db, prepared.gateId)
      const payload = JSON.parse(getPending(db, prepared.gateId)!.payload)
      const corrupted = typeof delta === 'string' ? delta : JSON.stringify({ plan: { ...payload.plan, ...delta } })
      db.prepare('UPDATE pending_clarifications SET payload=? WHERE id=?').run(corrupted, prepared.gateId)
      const before = facts(db)
      expect(getBatchSummary(db, prepared.gateId)).toBeNull()
      expect(facts(db)).toEqual(before)
    } finally {
      db.close()
    }
  })

  it.each([
    ['new count disagrees with items', { newCount: 0 }],
    ['duplicate count disagrees with items', { duplicateCount: 1 }],
    ['unparsed count disagrees with items', { unparsedCount: 1 }],
  ])('方案计数与条目不平不得假称完整来源：%s', (_name, delta) => {
    const db = fixture()
    try {
      const prepared = prepareBatch(db, input())
      executeBatch(db, prepared.gateId)
      const payload = JSON.parse(getPending(db, prepared.gateId)!.payload)
      Object.assign(payload.plan, delta)
      db.prepare('UPDATE pending_clarifications SET payload=? WHERE id=?').run(JSON.stringify(payload), prepared.gateId)
      const before = facts(db)
      expect(getBatchSummary(db, prepared.gateId)).toBeNull()
      expect(facts(db)).toEqual(before)
    } finally {
      db.close()
    }
  })

  it.each([
    ['missing snapshot', undefined], ['explicit null', null], ['wrong count', []],
    ['wrong DTO', [{ ...row, reason: null }]],
  ])('execute拒绝0 items的坏排除计划且门保持open：%s', (_name, excludedRows) => {
    const db = fixture()
    try {
      const prepared = prepareBatch(db, { ...input(), items: [], rowsConsidered: 1 })
      const payload = JSON.parse(getPending(db, prepared.gateId)!.payload)
      if (excludedRows === undefined) delete payload.plan.excludedRows
      else payload.plan.excludedRows = excludedRows
      db.prepare('UPDATE pending_clarifications SET payload=? WHERE id=?').run(JSON.stringify(payload), prepared.gateId)
      const before = facts(db)
      expect(() => executeBatch(db, prepared.gateId)).toThrow(/排除行|批次为空/)
      expect(getPending(db, prepared.gateId)?.status).toBe('open')
      expect(getBatchSummary(db, prepared.gateId)).toBeNull()
      expect(facts(db)).toEqual(before)
    } finally {
      db.close()
    }
  })

  it('prepare复制DTO与数组，调用方后续修改不能污染plan或门payload', () => {
    const db = fixture()
    try {
      const source = [{ ...row }]
      const prepared = prepareBatch(db, input(source))
      source[0].merchant = 'later mutation'
      source[0].reason = 'later mutation'
      source.push({ ...row, rowNo: 3 })
      expect(prepared.plan.excludedRows).toEqual([row])
      expect(JSON.parse(getPending(db, prepared.gateId)!.payload).plan.excludedRows).toEqual([row])
      executeBatch(db, prepared.gateId)
      expect(getBatchSummary(db, prepared.gateId)?.excludedRows).toEqual([row])
    } finally {
      db.close()
    }
  })
})
