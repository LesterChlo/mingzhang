// 待收尾分类盲盒优化（T0922-2318）：测试锁。
// 覆盖：①卡片摘要行 ②同商户批量条出现条件 ③规则自动学习（含跳过已存在）④常识兜底（命中/未命中/用户规则优先）。

import { describe, expect, it, beforeEach } from 'vitest'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openSchemaDb } from './helpers'
import { seed } from '../src/main/db/seed'
import {
  createTransaction,
  recordParse,
  requestReview,
  getTransaction,
  getOrCreateCategoryId,
  updateFields,
} from '../src/main/domain/ledger'
import { createPending } from '../src/main/domain/pending'
import { answerPending } from '../src/main/domain/pending-answer'
import { createRule } from '../src/main/domain/rules'
import { matchBuiltinCategory, classifyByMerchant } from '../src/main/domain/builtin-categories'
import { txSummary, groupSameMerchant } from '../src/renderer/src/lib/pendingBatch'
import type { PendingItemDTO } from '../src/shared/types'

let db: ReturnType<typeof openSchemaDb>
beforeEach(() => {
  db = openSchemaDb(join(mkdtempSync(join(tmpdir(), 'mz-bb-')), 't.db'))
  seed(db)
})

function item(over: Partial<PendingItemDTO> & { gateId: number }): PendingItemDTO {
  return {
    field: 'confirm_record',
    question: '批次入账缺分类，待确认',
    txId: null,
    createdAt: '2026-09-04T10:00:00',
    groupId: 'g1',
    groupLabel: '微信账单',
    ...over,
  }
}

function makeConfirmPending(merchant: string): { txId: number; gateId: number } {
  const txId = createTransaction(db, { amountCents: 2600, txType: 'expense', merchant })
  recordParse(db, txId, { confidenceScore: 0.5 })
  requestReview(db, txId, { reason: '分类未定', confidenceScore: 0.5 })
  const gateId = createPending(db, {
    txId,
    sessionId: 's1',
    field: 'confirm_record',
    question: '批次入账缺分类，待确认',
    payload: { txId, reason: '分类未定' },
  })
  return { txId, gateId }
}

function ruleRows(): { condition: string; action: string; provenance: string }[] {
  return db.prepare('SELECT condition, action, provenance FROM rules').all() as unknown as {
    condition: string
    action: string
    provenance: string
  }[]
}

describe('① 卡片摘要 txSummary', () => {
  it('有 txId：商户 · ¥金额 · MM-DD', () => {
    expect(
      txSummary(item({ gateId: 1, txId: 7, merchant: '麦当劳', amountCents: 2600, occurredAt: '2026-09-04T12:00:00' })),
    ).toBe('麦当劳 · ¥26.00 · 09-04')
  })
  it('无 txId 事项保持原样（null，不渲染摘要行）', () => {
    expect(txSummary(item({ gateId: 2, txId: null, merchant: '麦当劳', amountCents: 2600 }))).toBeNull()
  })
  it('有 txId 但三字段全空 → null', () => {
    expect(txSummary(item({ gateId: 3, txId: 9 }))).toBeNull()
  })
})

describe('② 同商户批量条 groupSameMerchant', () => {
  it('同一分组内同商户 confirm_record ≥ 2 条 → 出批量条', () => {
    const out = groupSameMerchant([
      item({ gateId: 1, txId: 1, merchant: '麦当劳' }),
      item({ gateId: 2, txId: 2, merchant: '麦当劳' }),
      item({ gateId: 3, txId: 3, merchant: '星巴克' }),
    ])
    expect(out).toEqual([{ merchant: '麦当劳', gateIds: [1, 2] }])
  })
  it('单条商户 / 无商户 / batch_item / 其他 field 都不出条', () => {
    const out = groupSameMerchant([
      item({ gateId: 1, txId: 1, merchant: '星巴克' }),
      item({ gateId: 2, txId: null }),
      item({ gateId: 3, txId: null, field: 'batch_item', merchant: '麦当劳' }),
      item({ gateId: 4, txId: null, field: 'batch_item', merchant: '麦当劳' }),
      item({ gateId: 5, txId: 5, field: 'note', merchant: '麦当劳' }),
      item({ gateId: 6, txId: 6, field: 'note', merchant: '麦当劳' }),
    ])
    expect(out).toEqual([])
  })
})

describe('③ 规则自动学习 answerPending', () => {
  it('分类答复 → 建 merchant contains 规则（provenance=learned_from_correction），主流程照常 confirmed', () => {
    const { txId, gateId } = makeConfirmPending('麦当劳测试店')
    const r = answerPending(db, gateId, '餐饮', { sessionId: 's1', via: 'panel' })
    expect(r.text).toContain('confirmed')
    expect(getTransaction(db, txId)?.state).toBe('confirmed')
    const rows = ruleRows()
    expect(rows).toHaveLength(1)
    expect(JSON.parse(rows[0].condition)).toEqual({ match: 'merchant', op: 'contains', value: '麦当劳测试店' })
    expect(JSON.parse(rows[0].action)).toEqual({ set_category: '餐饮' })
    expect(rows[0].provenance).toBe('learned_from_correction')
  })
  it('已有同条件规则 → 跳过不覆盖（条数不变、动作不变），主流程不阻塞', () => {
    const { gateId } = makeConfirmPending('麦当劳测试店')
    createRule(
      db,
      { match: 'merchant', op: 'contains', value: '麦当劳测试店' },
      { set_category: '快餐' },
      { provenance: 'manual' },
    )
    const r = answerPending(db, gateId, '餐饮', { sessionId: 's1', via: 'panel' })
    expect(r.text).toContain('confirmed')
    const rows = ruleRows()
    expect(rows).toHaveLength(1)
    expect(JSON.parse(rows[0].action)).toEqual({ set_category: '快餐' })
    expect(rows[0].provenance).toBe('manual')
  })
  it('裸「确认」（已有分类）→ 不学规则', () => {
    const txId = createTransaction(db, { amountCents: 1000, txType: 'expense', merchant: '确认测试店' })
    const catId = getOrCreateCategoryId(db, '餐饮', 'expense', { changedBy: 'user' })
    updateFields(db, txId, { category_id: catId }, { reasoning: '预置分类' })
    recordParse(db, txId, { confidenceScore: 0.9 })
    requestReview(db, txId, { reason: '分类未定', confidenceScore: 0.9 })
    const gateId = createPending(db, { txId, sessionId: 's1', field: 'confirm_record', question: 'q' })
    answerPending(db, gateId, '确认', { sessionId: 's1', via: 'panel' })
    expect(ruleRows()).toHaveLength(0)
  })
})

describe('④ 常识分类兜底', () => {
  it('命中：拼多多 → 购物（expense）', () => {
    expect(matchBuiltinCategory('拼多多-订单123', 'expense')).toBe('购物')
  })
  it('命中：医院/单车/Steam/蜜雪/Apple 各归其类', () => {
    expect(matchBuiltinCategory('挂号费-市医院', 'expense')).toBe('医疗')
    expect(matchBuiltinCategory('哈啰单车', 'expense')).toBe('交通')
    expect(matchBuiltinCategory('Steam 游戏', 'expense')).toBe('娱乐')
    expect(matchBuiltinCategory('蜜雪冰城', 'expense')).toBe('餐饮')
    expect(matchBuiltinCategory('Apple iCloud', 'expense')).toBe('订阅')
  })
  it('未命中：无名商户 → null；income 永不命中', () => {
    expect(matchBuiltinCategory('无名小店', 'expense')).toBeNull()
    expect(matchBuiltinCategory(null, 'expense')).toBeNull()
    expect(matchBuiltinCategory('拼多多', 'income')).toBeNull()
  })
  it('用户规则优先于常识：同商户已有手动规则 → 走规则不走常识', () => {
    createRule(
      db,
      { match: 'merchant', op: 'contains', value: '拼多多' },
      { set_category: '数码' },
      { provenance: 'manual' },
    )
    const decided = classifyByMerchant(db, { merchant: '拼多多-订单', kind: 'expense', changedBy: 'llm' })
    expect(decided.ruleHit?.categoryName).toBe('数码')
    expect(decided.builtinName).toBeNull()
  })
  it('无规则时常识生效：classifyByMerchant 返回常识分类 + 建好分类', () => {
    const decided = classifyByMerchant(db, { merchant: '京东商城', kind: 'expense', changedBy: 'llm' })
    expect(decided.builtinName).toBe('购物')
    expect(decided.ruleHit).toBeNull()
    expect(decided.categoryId).not.toBeNull()
  })
})

describe('⑤ T0923-0017 模糊缺口补齐（Agent 先定）', () => {
  it('便利店变体 → 餐饮', () => {
    expect(matchBuiltinCategory('天天便利', 'expense')).toBe('餐饮')
    expect(matchBuiltinCategory('乐淘便利店', 'expense')).toBe('餐饮')
  })
  it('出行代扣 → 交通', () => {
    expect(matchBuiltinCategory('北京鸿易博先乘后付', 'expense')).toBe('交通')
  })
  it('API 消费 → 订阅', () => {
    expect(matchBuiltinCategory('深度求索API调用', 'expense')).toBe('订阅')
    expect(matchBuiltinCategory('DeepSeek API', 'expense')).toBe('订阅')
  })
  it('猫眼/网咖/打赏 → 娱乐', () => {
    expect(matchBuiltinCategory('猫眼电影65', 'expense')).toBe('娱乐')
    expect(matchBuiltinCategory('酷锐网咖', 'expense')).toBe('娱乐')
    expect(matchBuiltinCategory('喵勒个咪打赏', 'expense')).toBe('娱乐')
  })
  it('零食连锁 → 餐饮', () => {
    expect(matchBuiltinCategory('赵一鸣零食', 'expense')).toBe('餐饮')
  })
  it('不确定的故意不定：个人名/邮政到付/财政缴费 → null（转待确认交用户）', () => {
    expect(matchBuiltinCategory('X（个人名）', 'expense')).toBeNull()
    expect(matchBuiltinCategory('邮政到付', 'expense')).toBeNull()
    expect(matchBuiltinCategory('广东财政缴费', 'expense')).toBeNull()
  })
})
