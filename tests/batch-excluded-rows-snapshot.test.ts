// issue #28: complete deterministic snapshots, not the five-row sample.
import { describe, expect, it } from 'vitest'
import { openSchemaDb } from './helpers'
import { seed } from '../src/main/db/seed'
import { applyBillPlan, stageBill } from '../src/main/domain/bill'
import { executeBatch } from '../src/main/domain/batch'
import { getBatchSummary } from '../src/main/domain/batch-summary'
import { getPending } from '../src/main/domain/pending'

function fixture() {
  const db = openSchemaDb(':memory:')
  seed(db)
  return db
}

const header = ['交易时刻', '商户', '金额(元)', '方向', '说明', '附注']

describe('排除行完整快照', () => {
  it('保留超过五行的原文、真实排除原因及确定性金额时间，坏值为null', () => {
    const db = fixture()
    try {
      const rows = [
        ['2026/4/1 8:09', '合成退回', '￥1,234.56', '收入', '排除', '原文末列'],
        ['20260402091011', '合成转出', '(12.34)', '转出', '排除', ''],
        ['2026年4月3日 下午3:20', '', '免费', '神秘方向', '排除', '说明不能变交易'],
        ['2026-13-45', '合成坏日期', '-2.50', '支出', '正常', '例外排除'],
        ['', '合成空日期', '1.234,56', '收入', '排除', ''],
        ['2026-04-06', '合成第六', '', '', '排除', '完整第六行'],
        ['2026-04-07', '合成第七', '7.07', '支出', '排除', '完整第七行'],
        ['2026-04-08', '合成入账', '8.08', '支出', '正常', ''],
      ]
      const table = stageBill(db, { sourceType: 'xlsx', cells: [header, ...rows] })
      const result = applyBillPlan(db, {
        table_id: table.id,
        columns: { time: '交易时刻', merchant: '商户', amount: '金额', direction: '方向' },
        account_name: '现金',
        skip_when: [{ column: '说明', contains: '排除' }],
        row_overrides: [{ from_row: 4, to_row: 4, type: 'skip' }],
        categories: [{ match: '合成', category_name: '其他' }],
      }, { sessionId: 'synthetic-snapshot' })
      expect(result.skippedSamples).toHaveLength(5)
      expect(result.skippedCount).toBe(7)
      const expected = [
        { tableId: table.id, rowNo: 1, sourceText: rows[0].join(' · '), merchant: '合成退回', amountCents: 123456, occurredAt: '2026-04-01 08:09:00', reason: '不计收支：说明 含「排除」' },
        { tableId: table.id, rowNo: 2, sourceText: rows[1].join(' · ').trim(), merchant: '合成转出', amountCents: 1234, occurredAt: '2026-04-02 09:10:11', reason: '不计收支：说明 含「排除」' },
        { tableId: table.id, rowNo: 3, sourceText: rows[2].join(' · '), merchant: null, amountCents: null, occurredAt: '2026-04-03 15:20:00', reason: '不计收支：说明 含「排除」' },
        { tableId: table.id, rowNo: 4, sourceText: rows[3].join(' · '), merchant: '合成坏日期', amountCents: 250, occurredAt: null, reason: '按方案逐行排除' },
        { tableId: table.id, rowNo: 5, sourceText: rows[4].join(' · ').trim(), merchant: '合成空日期', amountCents: null, occurredAt: null, reason: '不计收支：说明 含「排除」' },
        { tableId: table.id, rowNo: 6, sourceText: rows[5].join(' · '), merchant: '合成第六', amountCents: null, occurredAt: '2026-04-06 00:00:00', reason: '不计收支：说明 含「排除」' },
        { tableId: table.id, rowNo: 7, sourceText: rows[6].join(' · '), merchant: '合成第七', amountCents: 707, occurredAt: '2026-04-07 00:00:00', reason: '不计收支：说明 含「排除」' },
      ]
      expect(result.plan).toMatchObject({ excludedRows: expected })
      expect(JSON.parse(getPending(db, result.gateId!)!.payload).plan.excludedRows).toEqual(expected)
      expect(getBatchSummary(db, result.gateId!)).toBeNull()
      expect(executeBatch(db, result.gateId!)?.completed).toHaveLength(1)
      expect(getBatchSummary(db, result.gateId!)!.excludedRows).toEqual(expected)
      expect(db.prepare('SELECT merchant FROM transactions').all()).toEqual([{ merchant: '合成入账' }])
    } finally {
      db.close()
    }
  })
})
