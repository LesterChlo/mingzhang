import { expect, it, vi } from 'vitest'
import { openSchemaDb } from './helpers'
import { seed } from '../src/main/db/seed'
import { createTransaction, requestReview, updateFields } from '../src/main/domain/ledger'
import { applyClassify, buildClassifyProposal, prepareClassify } from '../src/main/domain/classify'

function fixture() {
  const db = openSchemaDb(':memory:'); seed(db)
  const add = (merchant: string, batchId = 'b4') => {
    const id = createTransaction(db, { amountCents: 123, txType: 'expense', merchant, sourceMessageId: batchId })
    requestReview(db, id, { reason: '合成测试' }); return id
  }
  const selected = add('合成选定'); const unselected = add('合成未选')
  const input = () => ({ sessionId: 'test', batchId: 'b4', assignments: [{ groupKey: 'expense::合成选定', categoryName: '餐饮', txIds: [selected] }], expectedProposalVersion: buildClassifyProposal(db, { batchId: 'b4' }).proposalVersion })
  return { db, add, selected, unselected, input }
}

it.each(['amount', 'state', 'merchant', 'category', 'unselected', 'added', 'removed', 'aba'] as const)('完整proposal变化%s拒绝prepare且不落门/审计', change => {
  const { db, selected, unselected, input, add } = fixture()
  try {
    const shown = input()
    if (change === 'amount') updateFields(db, selected, { amount_cents: 999 })
    if (change === 'state') db.prepare("UPDATE transactions SET state='parsed' WHERE id=?").run(selected)
    if (change === 'merchant') updateFields(db, selected, { merchant: '合成更名' })
    if (change === 'category') updateFields(db, selected, { category_id: (db.prepare("SELECT id FROM categories WHERE name='餐饮' AND kind='expense'").get() as { id: number }).id })
    if (change === 'unselected') updateFields(db, unselected, { amount_cents: 999 })
    if (change === 'added') add('合成新增')
    if (change === 'removed') db.prepare("UPDATE transactions SET state='deleted' WHERE id=?").run(unselected)
    if (change === 'aba') {
      vi.useFakeTimers(); vi.setSystemTime(new Date('2026-01-01T00:00:00Z'))
      updateFields(db, selected, { amount_cents: 999 }); updateFields(db, selected, { amount_cents: 123 })
    }
    const before = db.serialize()
    expect(() => prepareClassify(db, shown)).toThrow(/过期/)
    expect(db.serialize()).toEqual(before)
  } finally { vi.useRealTimers(); db.close() }
})

it('版本确定性、跨时间稳定、纯读；范围外变化不使本批过期，子集确认保留金额', () => {
  const { db, selected, input, add } = fixture()
  try {
    const shown = input(); const before = db.serialize()
    vi.useFakeTimers(); vi.setSystemTime(new Date('2030-01-01T00:00:00Z'))
    expect(input().expectedProposalVersion).toBe(shown.expectedProposalVersion)
    expect(db.serialize()).toEqual(before)
    add('合成其他批次', 'other-batch')
    expect(input().expectedProposalVersion).toBe(shown.expectedProposalVersion)
    const gate = prepareClassify(db, shown)
    expect(gate.plan.groups[0].txIds).toEqual([selected])
    expect(gate.plan.groups[0].totalCents).toBe(123)
    expect(applyClassify(db, gate.gateId)?.appliedCount).toBe(1)
  } finally { vi.useRealTimers(); db.close() }
})

it('旧模型领域签名仍可prepare；无效token拒绝，prepare后的变化仍由apply拦截', () => {
  const { db, selected, input } = fixture()
  try {
    const shown = input()
    for (const expectedProposalVersion of ['', 'forged', null, 42]) {
      expect(() => prepareClassify(db, { ...shown, expectedProposalVersion: expectedProposalVersion as string })).toThrow(/过期/)
    }
    const { expectedProposalVersion: _token, ...legacy } = shown
    const gate = prepareClassify(db, legacy)
    updateFields(db, selected, { amount_cents: 999 })
    expect(() => applyClassify(db, gate.gateId)).toThrow(/过期/)
  } finally { db.close() }
})

it('B4 RED: 展示579分后改成1455分，旧展示版本必须在prepare前拒绝', () => {
  const db = openSchemaDb(':memory:'); seed(db)
  try {
    const ids = [123, 456].map(amountCents => {
      const id = createTransaction(db, { amountCents, txType: 'expense', merchant: '合成B4店', sourceMessageId: 'b4-batch' })
      requestReview(db, id, { reason: '合成测试' }); return id
    })
    const shown = buildClassifyProposal(db, { batchId: 'b4-batch' })
    expect(shown.groups[0].totalCents).toBe(579)
    updateFields(db, ids[0], { amount_cents: 999 })
    const input = { sessionId: 'test', batchId: 'b4-batch', assignments: [{ groupKey: shown.groups[0].groupKey, categoryName: '餐饮', txIds: ids }], expectedProposalVersion: shown.proposalVersion }
    const gatesBefore = db.prepare('SELECT * FROM pending_clarifications').all()
    let acceptedTotal: number | undefined
    expect(() => {
      const gate = prepareClassify(db, input)
      acceptedTotal = gate.plan.groups[0].totalCents
      expect(applyClassify(db, gate.gateId)?.appliedCount).toBe(2)
      console.log('B4_STALE_ACCEPTED', JSON.stringify({ shown: 579, applied: acceptedTotal }))
    }).toThrow(/过期/)
    expect(db.prepare('SELECT * FROM pending_clarifications').all()).toEqual(gatesBefore)
  } finally { db.close() }
})
