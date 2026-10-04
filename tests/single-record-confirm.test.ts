import { afterEach, describe, expect, it } from 'vitest'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openSchemaDb } from './helpers'
import { seed } from '../src/main/db/seed'
import { createLedgerTools, type TurnContext } from '../src/main/engine/tools'
import { autoConfirm, createTransaction, getOrCreateCategoryId, getTransaction, recordParse } from '../src/main/domain/ledger'
import { getPending } from '../src/main/domain/pending'
import { answerPending } from '../src/main/domain/pending-answer'
import { aggregate } from '../src/main/domain/queries'
import type { TransactionCardData } from '../src/shared/types'

const dbs: ReturnType<typeof openSchemaDb>[] = []
afterEach(() => { for (const db of dbs.splice(0)) db.close() })
function setup(hasImage = false, visionUnverified = false) {
  const db = openSchemaDb(join(mkdtempSync(join(tmpdir(), 'mz-single-')), 'test.db'))
  dbs.push(db)
  seed(db)
  const ctx: TurnContext = { sessionId: 'synthetic', sourceMessageId: 'single', hasImage, visionUnverified, attachments: hasImage ? ['synthetic.png'] : [] }
  const tools = createLedgerTools({ db, getTurnContext: () => ctx })
  const record = tools.find(t => t.name === 'record')!
  const run = (params: Record<string, unknown>) => (record.execute as unknown as (id: string, p: Record<string, unknown>) => Promise<{ content: { text?: string }[]; details: { card: TransactionCardData } }>)('test', params)
  return { db, run }
}

describe('所有单笔 record 必须先确认', () => {
  it.each([
    ['高置信文字', false, false, { category_name: '餐饮', confidence: 1 }],
    ['高置信截图', true, false, { category_name: '餐饮', confidence: 1 }],
    ['未自检截图', true, true, { category_name: '餐饮', confidence: 1 }],
    ['低置信常识命中', false, false, { merchant: '麦当劳', confidence: 0.1 }],
    ['无分类文字', false, false, { confidence: 0.1 }],
    ['收入', false, false, { tx_type: 'income', category_name: '工资', confidence: 1 }],
    ['目标已定转账', false, false, { tx_type: 'transfer', to_account_name: '支付宝', confidence: 1 }],
    ['调整', false, false, { tx_type: 'adjustment', confidence: 1 }],
  ])('%s：真实待办、needs_review、无 auto_confirm、统计排除', async (_label, image, unverified, extra) => {
    const { db, run } = setup(image, unverified)
    const result = await run({ amount_cents: 3500, tx_type: 'expense', merchant: '合成小店', ...extra })
    const card = result.details.card
    expect(card.tx.state).toBe('needs_review')
    expect(card.gateId).toBeGreaterThan(0)
    expect(getPending(db, card.gateId!) ).toMatchObject({ tx_id: card.tx.id, field: 'confirm_record', status: 'open', session_id: 'synthetic' })
    expect(db.prepare("SELECT * FROM audit_log WHERE change_type='auto_confirm'").all()).toHaveLength(0)
    expect(aggregate(db, { metric: 'total_expense', period: 'this_month' }).totalCents).toBe(0)
    expect(aggregate(db, { metric: 'total_income', period: 'this_month' }).totalCents).toBe(0)
    expect(result.content[0].text).toContain('确认入账')
    expect(result.content[0].text).not.toContain('已入账：')
  })

  it('单笔确认门不能被模型 pending answer 或面板补答绕过', async () => {
    const { db, run } = setup()
    const result = await run({ amount_cents: 3500, tx_type: 'expense', category_name: '餐饮', confidence: 0.1 })
    const { id } = result.details.card.tx
    const gateId = result.details.card.gateId!
    for (const via of ['chat', 'panel'] as const) {
      expect(() => answerPending(db, gateId, '确认', { sessionId: 'synthetic', via })).toThrow(/界面.*按钮/)
      expect(getTransaction(db, id)?.state).toBe('needs_review')
      expect(getPending(db, gateId)?.status).toBe('open')
    }
  })

  it('已确认历史不被新单笔记账改动', async () => {
    const { db, run } = setup()
    const oldId = createTransaction(db, { amountCents: 1200, txType: 'expense', merchant: '合成历史' })
    recordParse(db, oldId, { categoryId: getOrCreateCategoryId(db, '餐饮', 'expense'), confidenceScore: 1 })
    autoConfirm(db, oldId)
    const before = getTransaction(db, oldId)
    await run({ amount_cents: 3500, tx_type: 'expense', category_name: '餐饮', confidence: 1 })
    expect(getTransaction(db, oldId)).toEqual(before)
    expect(aggregate(db, { metric: 'total_expense', period: 'this_month' })).toMatchObject({ totalCents: 1200, count: 1 })
  })
})
