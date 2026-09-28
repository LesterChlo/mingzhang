// 回归：批次含「转账」条目时执行不得崩溃（真实微信账单含零钱通转入触发；
// CHECK 约束：无对方账户的转账不得置 confirmed——原实现走到 autoConfirm 抛 SqliteError，
// 导致整批中断、gate 永不关闭、连点重复入账）。
import { describe, expect, it } from 'vitest'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openSchemaDb } from './helpers'
import { seed } from '../src/main/db/seed'
import { prepareBatch, executeBatch, batchFollowUpSummary } from '../src/main/domain/batch'
import { getPending } from '../src/main/domain/pending'

function mkDb() {
  const db = openSchemaDb(join(mkdtempSync(join(tmpdir(), 'mz-bt-')), 'test.db'))
  seed(db)
  return db
}

const ITEMS = [
  { merchant: 'Apple', amount_cents: 500, tx_type: 'expense' as const, source_text: 'Apple -5.00' },
  { merchant: '京东', amount_cents: 15900, tx_type: 'expense' as const, category_name: '购物' },
  { merchant: '零钱通转入', amount_cents: 10152, tx_type: 'transfer' as const, source_text: '零钱通转入 101.52' },
  { merchant: '美团', amount_cents: 990, tx_type: 'expense' as const, category_name: '餐饮' },
]

describe('批次执行 · 转账条目回归', () => {
  it('含转账的批次可完整执行：转账跳过、其余入账、gate 关闭、不抛错', () => {
    const db = mkDb()
    const { gateId } = prepareBatch(db, { sourceType: 'screenshot', sessionId: 's1', items: ITEMS })

    const result = executeBatch(db, gateId)
    expect(result).not.toBeNull()
    expect(result?.transfersSkipped).toHaveLength(1)
    expect(result?.transfersSkipped[0]?.merchant).toBe('零钱通转入')
    expect(result?.completed).toHaveLength(3)

    // 转账未入账（不产生 transfer 行）
    const types = db.prepare('SELECT type, COUNT(*) n FROM transactions GROUP BY type').all() as { type: string; n: number }[]
    expect(types.find((t) => t.type === 'transfer')).toBeUndefined()

    // gate 正常关闭（幂等前提）
    expect(getPending(db, gateId)?.status).toBe('resolved')
  })

  it('同一 gate 重复执行：第二次返回 null，不产生重复交易', () => {
    const db = mkDb()
    const { gateId } = prepareBatch(db, { sourceType: 'screenshot', sessionId: 's1', items: ITEMS })

    expect(executeBatch(db, gateId)).not.toBeNull()
    const after1 = (db.prepare('SELECT COUNT(*) n FROM transactions').get() as { n: number }).n
    expect(executeBatch(db, gateId)).toBeNull()
    const after2 = (db.prepare('SELECT COUNT(*) n FROM transactions').get() as { n: number }).n
    expect(after2).toBe(after1)
  })

  it('执行中途抛错：整批回滚、gate 保持 open（可安全重试）', () => {
    const db = mkDb()
    const { gateId } = prepareBatch(db, { sourceType: 'screenshot', sessionId: 's1', items: ITEMS })
    // 注入故障：把分类表打断（制造 createTransaction 之后的抛错）
    db.exec('DROP TABLE rules')
    expect(() => executeBatch(db, gateId)).toThrow()
    expect((db.prepare('SELECT COUNT(*) n FROM transactions').get() as { n: number }).n).toBe(0)
    expect(getPending(db, gateId)?.status).toBe('open')
  })

  it('转账补录回执（C3）：跳过的转账进回执，且指示模型追问转入/转出账户', () => {
    const db = mkDb()
    const { gateId } = prepareBatch(db, { sourceType: 'screenshot', sessionId: 's1', items: ITEMS })
    const result = executeBatch(db, gateId)
    expect(result).not.toBeNull()
    const summary = batchFollowUpSummary(result!)
    // 转账被点名未入账，附金额
    expect(summary).toContain('零钱通转入')
    expect(summary).toContain('未入账')
    // 明确要求模型追问「转出/转入账户」并补记（对话补录流程，而非静默丢弃）
    expect(summary).toContain('转出账户')
    expect(summary).toContain('转入账户')
    expect(summary).toContain('补记')
  })

  it('纯收支批次：回执不含转账追问文案', () => {
    const db = mkDb()
    const { gateId } = prepareBatch(db, {
      sourceType: 'screenshot',
      sessionId: 's1',
      items: [
        { merchant: '买菜', amount_cents: 2000, tx_type: 'expense', category_name: '餐饮' },
      ],
    })
    const result = executeBatch(db, gateId)
    expect(result?.transfersSkipped).toHaveLength(0)
    expect(batchFollowUpSummary(result!)).not.toContain('转账')
  })
})
