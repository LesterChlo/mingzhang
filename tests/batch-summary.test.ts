// 批次结果条读回（D-03a「按批次读回」+ K3 设计 G 组事实条）。
//
// 这条通道的全部意义：**重启后仍能说清「刚才那批发生了什么」**。
// 所以这里刻意不用内存事件（gate-executed 只活在一轮对话里）——
// 数字一律从库里现算：已入账/待分类查 transactions，重复/不计收支/待核对取 plan。
//
// 口径：
//   待分类 ⊂ 已入账；删除一律排除；126+38+33 不是分区，必须能算平。
import { describe, expect, it } from 'vitest'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openSchemaDb } from './helpers'
import { seed } from '../src/main/db/seed'
import { prepareBatch, executeBatch } from '../src/main/domain/batch'
import { getBatchSummary, getLatestBatchSummary } from '../src/main/domain/batch-summary'
import { confirm, createTransaction, getOrCreateCategoryId, updateFields } from '../src/main/domain/ledger'

const CHANNEL = '测试渠道'

/** 临时数据目录里的账本（绝不碰真实 %APPDATA%\mingzhang）。 */
function tmpFile(): string {
  return join(mkdtempSync(join(tmpdir(), 'mz-bs-')), 'test.db')
}

function mkDb(file: string) {
  const db = openSchemaDb(file)
  seed(db)
  return db
}

/**
 * 造一个「什么都有一份」的批次：3 笔可入账（其中 1 笔无分类 → 转待确认）
 * + 1 笔重复（dedupKey 命中已有交易）+ 1 笔缺金额（unparsed），方案里另标 2 行不计收支。
 */
function prepareMixedBatch(db: ReturnType<typeof openSchemaDb>): { gateId: number; dupTxId: number } {
  // 预置一笔带 dedup_key 的交易：下面同渠道同交易号那笔应当被判为重复
  const dupTxId = createTransaction(db, { amountCents: 990, txType: 'expense', merchant: '老商户' })
  db.prepare('UPDATE transactions SET dedup_key = ? WHERE id = ?').run(`${CHANNEL}:DUP-1`, dupTxId)

  const { gateId, plan } = prepareBatch(db, {
    sourceType: 'csv',
    channel: CHANNEL,
    sessionId: 's1',
    skippedCount: 2,
    items: [
      { merchant: '演示甲', amount_cents: 1200, tx_type: 'expense', category_name: '餐饮' },
      { merchant: '演示乙', amount_cents: 3400, tx_type: 'expense', category_name: '交通' },
      // 无分类：常识表也命中不了 → 转 needs_review（= 待分类那一笔）
      { merchant: '演示丙', amount_cents: 500, tx_type: 'expense' },
      { merchant: '重复商户', amount_cents: 990, tx_type: 'expense', category_name: '餐饮', reliable_id: 'DUP-1' },
      // 缺金额：转待核对，不入账
      { merchant: '缺金额商户' },
    ],
  })
  expect(plan.newCount).toBe(3)
  expect(plan.duplicateCount).toBe(1)
  expect(plan.unparsedCount).toBe(1)
  expect(plan.skippedCount).toBe(2)
  expect(executeBatch(db, gateId)).not.toBeNull()
  return { gateId, dupTxId }
}

describe('批次结果条 · 按批次读回', () => {
  it('数字逐个对得上：已入账/待分类查库，重复/不计收支/待核对取 plan', () => {
    const db = mkDb(tmpFile())
    const { gateId } = prepareMixedBatch(db)

    const dto = getBatchSummary(db, gateId)
    expect(dto).not.toBeNull()
    expect(dto!.gateId).toBe(gateId)
    expect(dto!.batchId).toMatch(/^batch-/)
    expect(typeof dto!.importId).toBe('number')
    expect(dto!.executedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/)

    // 已入账 3 笔（含待分类那笔：待分类 ⊂ 已入账）；重复/不计收支/待核对都不入账
    expect(dto!.counts).toEqual({
      booked: 3,
      needsCategory: 1,
      excluded: 2,
      duplicates: 1,
      unparsed: 1,
    })

    // 重复行逐行带得出来（商户 + 金额 + 原因），不是只有一个数字
    expect(dto!.duplicatesRows).toEqual([
      { merchant: '重复商户', amountCents: 990, reason: expect.stringContaining('自动跳过') },
    ])

    // 不计收支的逐行明细本单没有（D-03b 未实现）：显式 null，UI 必须自己说「待后端」
    expect(dto!.excludedRows).toBeNull()
  })

  it('重载语义：换一个连接读同一库，DTO 完全一致（不依赖内存事件）', () => {
    const file = tmpFile()
    const db = mkDb(file)
    const { gateId } = prepareMixedBatch(db)
    const before = getBatchSummary(db, gateId)
    db.close()

    // 模拟应用重启：全新连接、无任何内存状态
    const reopened = mkDb(file)
    const after = getLatestBatchSummary(reopened)
    expect(after).toEqual(before)
    expect(after!.counts).toEqual({ booked: 3, needsCategory: 1, excluded: 2, duplicates: 1, unparsed: 1 })
  })

  it('待分类清零：把缺分类那笔定掉后 needsCategory 变 0，booked 不变', () => {
    const db = mkDb(tmpFile())
    prepareMixedBatch(db)

    const review = db
      .prepare(
        "SELECT id FROM transactions WHERE state='needs_review' AND category_id IS NULL AND source_message_id LIKE 'batch-%'",
      )
      .get() as { id: number }
    expect(review.id).toBeGreaterThan(0)

    // 与 engine.doConfirmRecord 同一路径：先定分类，再 confirm
    updateFields(db, review.id, { category_id: getOrCreateCategoryId(db, '其他', 'expense') }, { reasoning: '用户确认时选择分类' })
    confirm(db, review.id, { reasoning: '用户在界面上点击确认' })

    const after = getLatestBatchSummary(db)!
    expect(after.counts.needsCategory).toBe(0)
    expect(after.counts.booked).toBe(3)
  })

  it('空库返回 null；未执行（open）的批次门不得被选中', () => {
    const empty = mkDb(tmpFile())
    expect(getLatestBatchSummary(empty)).toBeNull()

    // 一批已执行 + 一批只 prepare 没执行：最新的门是 open 的，结果条必须仍指向已执行那批
    const db = mkDb(tmpFile())
    const { gateId } = prepareMixedBatch(db)
    const open = prepareBatch(db, {
      sourceType: 'csv',
      channel: CHANNEL,
      sessionId: 's2',
      items: [{ merchant: '还没确认的商户', amount_cents: 100, tx_type: 'expense', category_name: '餐饮' }],
    })
    expect(open.gateId).toBeGreaterThan(gateId)

    const latest = getLatestBatchSummary(db)!
    expect(latest.gateId).toBe(gateId)
    expect(latest.batchId).not.toBe(open.plan.batchId)
    // 指定 open 的门读不到（还没执行，没有「执行结果」可言）
    expect(getBatchSummary(db, open.gateId)).toBeNull()
  })

  it('指定不存在的门 / 非批次门：返回 null，不编数字', () => {
    const db = mkDb(tmpFile())
    prepareMixedBatch(db)
    expect(getBatchSummary(db, 999999)).toBeNull()
  })
})
