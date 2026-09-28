// 第 4 单 A：待收尾就地回答 —— 与对话补答同一条域层路径（answerPending）。
// 覆盖：revision 校验 / gate 类拒绝 / 幂等（已关闭报错）/ 答案进审计 / 交易更新不重复记账。

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
  auditChain,
  getTransaction,
  getOrCreateCategoryId,
  createImport,
} from '../src/main/domain/ledger'
import { createPending, getPending } from '../src/main/domain/pending'
import { answerPending } from '../src/main/domain/pending-answer'

let db: ReturnType<typeof openSchemaDb>
beforeEach(() => {
  db = openSchemaDb(join(mkdtempSync(join(tmpdir(), 'mz-pa-')), 't.db'))
  seed(db)
})

function makePendingTx(): { txId: number; gateId: number } {
  const txId = createTransaction(db, { amountCents: 4200, txType: 'expense', merchant: '无名小店' })
  recordParse(db, txId, { confidenceScore: 0.5 })
  requestReview(db, txId, { reason: '分类未定', confidenceScore: 0.5 })
  const gateId = createPending(db, {
    txId,
    sessionId: 's1',
    field: 'confirm_record',
    question: '分类未定',
    payload: { txId, reason: '分类未定' },
  })
  return { txId, gateId }
}

describe('answerPending（第 4 单 A：就地回答 = 对话补答同路径）', () => {
  it('confirm_record：分类答复 → 交易更新 + 关闭 + 审计（changed_by=user）', () => {
    const { txId, gateId } = makePendingTx()
    const r = answerPending(db, gateId, '餐饮', { sessionId: 's1', via: 'panel' })
    expect(r.text).toContain('confirmed')
    expect(getTransaction(db, txId)?.state).toBe('confirmed')
    expect((db.prepare('SELECT name FROM categories WHERE id=(SELECT category_id FROM transactions WHERE id=?)').get(txId) as { name: string }).name).toBe('餐饮')
    const last = db
      .prepare("SELECT change_type c, changed_by b, reasoning r FROM audit_log WHERE entity_type='transaction' ORDER BY id DESC LIMIT 1")
      .get() as { c: string; b: string; r: string }
    expect(last.c).toBe('confirm')
    expect(last.b).toBe('user')
    expect(last.r).toContain('待收尾面板')
    expect(getPending(db, gateId)?.status).toBe('resolved')
  })

  it('重复作答被拒（已关闭）——幂等', () => {
    const { gateId } = makePendingTx()
    answerPending(db, gateId, '餐饮', { sessionId: 's1', via: 'panel' })
    expect(() => answerPending(db, gateId, '购物', { sessionId: 's1', via: 'panel' })).toThrow(/已关闭/)
  })

  it('缺分类的「确认」被拒且事项保持打开（DDL 兜底口径）', () => {
    const { gateId, txId } = makePendingTx()
    expect(() => answerPending(db, gateId, '确认', { sessionId: 's1', via: 'panel' })).toThrow(/分类/)
    expect(getTransaction(db, txId)?.state).toBe('needs_review')
    expect(getPending(db, gateId)?.status).toBe('open')
  })

  it('gate 类（delete_confirm）拒绝作答', () => {
    const txId = createTransaction(db, { amountCents: 1000, txType: 'expense' })
    const gateId = createPending(db, { txId, sessionId: 's1', field: 'delete_confirm', question: '删除待确认' })
    expect(() => answerPending(db, gateId, '确认', { sessionId: 's1', via: 'panel' })).toThrow(/只能由用户在界面上点按钮/)
    expect(getPending(db, gateId)?.status).toBe('open')
  })

  it('batch_item：金额答复建新交易（不重复记账）+ 审计；答案审计可查', () => {
    const importId = createImport(db, { sourceType: 'screenshot', sourceRef: 'att-1.png', sourceMessageId: 'msg-b1' })
    const gateId = createPending(db, {
      txId: null,
      sessionId: 's1',
      field: 'batch_item',
      question: '金额待补：演示丙',
      payload: { importId, merchant: '演示丙', attachments: ['att-1.png'] },
    })
    const before = (db.prepare('SELECT COUNT(*) n FROM transactions').get() as { n: number }).n
    const r = answerPending(db, gateId, '15 餐饮', { sessionId: 's1', via: 'panel' })
    expect(r.text).toContain('confirmed')
    expect((db.prepare('SELECT COUNT(*) n FROM transactions').get() as { n: number }).n).toBe(before + 1)
    const tx = db.prepare('SELECT id, amount_cents c, state s FROM transactions ORDER BY id DESC LIMIT 1').get() as {
      id: number
      c: number
      s: string
    }
    expect(tx.c).toBe(1500)
    expect(tx.s).toBe('confirmed')
    expect(auditChain(db, tx.id)).toContain('create')
    expect(getPending(db, gateId)?.status).toBe('resolved')
  })
})
