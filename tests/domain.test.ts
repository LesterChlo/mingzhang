// 域层单测：状态机 / 审计 / 阈值直通 / 聚合口径 / pending 关闭。断言口径沿 legacy demo_phase2。

import { describe, expect, it, beforeEach } from 'vitest'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openSchemaDb } from './helpers'
import {
  createTransaction,
  recordParse,
  autoConfirm,
  requestReview,
  confirm,
  softDelete,
  restore,
  auditChain,
  getThreshold,
  setSetting,
  getOrCreateCategoryId,
  resolveAccountId,
  createImport,
  getTransaction,
  snapshot,
  updateFields,
} from '../src/main/domain/ledger'
import { aggregate, resolvePeriod, previousPeriod } from '../src/main/domain/queries'
import { createPending, closePending, getPending } from '../src/main/domain/pending'
import { seed } from '../src/main/db/seed'

function freshDb(): ReturnType<typeof openSchemaDb> {
  const dir = mkdtempSync(join(tmpdir(), 'mz-test-'))
  const db = openSchemaDb(join(dir, 'test.db'))
  seed(db)
  return db
}

let db: ReturnType<typeof openSchemaDb>
beforeEach(() => {
  db = freshDb()
})

describe('数据架构硬规则', () => {
  it('seed 预置 4 账户 + 8 分类 + 3 设置', () => {
    expect((db.prepare('SELECT COUNT(*) n FROM accounts').get() as { n: number }).n).toBe(4)
    expect((db.prepare('SELECT COUNT(*) n FROM categories').get() as { n: number }).n).toBe(8)
    expect((db.prepare('SELECT COUNT(*) n FROM settings').get() as { n: number }).n).toBe(3)
    // 常用支出分类齐备：离线演示常见商户不再全落「其他」
    const names = (db.prepare("SELECT name FROM categories WHERE kind='expense'").all() as { name: string }[]).map((r) => r.name)
    for (const must of ['餐饮', '咖啡', '交通', '购物', '其他']) expect(names).toContain(must)
  })

  it('R1 金额整数分：非整数分/零金额被 CHECK 拒绝', () => {
    expect(() => createTransaction(db, { amountCents: 0, txType: 'expense' })).toThrow()
  })

  it('R5 单币种 CHECK 存在', () => {
    expect(() =>
      db
        .prepare("INSERT INTO accounts (name, type, currency, created_at, updated_at) VALUES ('测试','cash','USD','t','t')")
        .run(),
    ).toThrow(/CHECK/)
  })

  it('转账完整性：confirmed 转账必须有目标账户', () => {
    const accId = resolveAccountId(db, '现金')
    const txId = createTransaction(db, { amountCents: 1000, txType: 'transfer', accountId: accId })
    recordParse(db, txId, { txType: 'transfer', confidenceScore: 0.9 })
    expect(() => autoConfirm(db, txId)).toThrow(/CHECK/) // 无目标账户 → confirmed 被 DDL 拒绝
  })
})

describe('状态机（§5.5）', () => {
  it('create → parse → autoConfirm 的审计链', () => {
    const txId = createTransaction(db, { amountCents: 3500, txType: 'expense', merchant: '星巴克' })
    recordParse(db, txId, { categoryId: getOrCreateCategoryId(db, '餐饮', 'expense'), confidenceScore: 0.92 })
    autoConfirm(db, txId, { confidenceScore: 0.92 })
    expect(getTransaction(db, txId)?.state).toBe('confirmed')
    expect(auditChain(db, txId)).toEqual(['create', 'parse', 'auto_confirm'])
  })

  it('低置信度 → needs_review → 用户补分类后确认', () => {
    const txId = createTransaction(db, { amountCents: 2000, txType: 'expense' })
    recordParse(db, txId, { confidenceScore: 0.4 })
    requestReview(db, txId, { reason: '分类未定', confidenceScore: 0.4 })
    expect(getTransaction(db, txId)?.state).toBe('needs_review')
    // 用户在确认前给出分类（UI 按钮确认时分类已定）
    updateFields(db, txId, { category_id: getOrCreateCategoryId(db, '餐饮', 'expense') }, { reasoning: '用户答复分类' })
    confirm(db, txId, { reasoning: '用户在界面上点击确认' })
    expect(getTransaction(db, txId)?.state).toBe('confirmed')
    expect(auditChain(db, txId)).toEqual(['create', 'parse', 'request_review', 'update', 'confirm'])
    expect(snapshot(db, txId)?.state).toBe('confirmed')
  })

  it('软删与恢复：deleted 终态可回到删除前状态', () => {
    const txId = createTransaction(db, { amountCents: 500, txType: 'expense' })
    recordParse(db, txId, { categoryId: getOrCreateCategoryId(db, '餐饮', 'expense'), confidenceScore: 0.9 })
    autoConfirm(db, txId)
    softDelete(db, txId)
    expect(getTransaction(db, txId)?.state).toBe('deleted')
    const target = restore(db, txId)
    expect(target).toBe('confirmed')
    expect(auditChain(db, txId)).toContain('restore')
  })
})

describe('直通阈值', () => {
  it('读 settings.confidence_threshold，可改', () => {
    expect(getThreshold(db)).toBe(0.7)
    setSetting(db, 'confidence_threshold', '0.8')
    expect(getThreshold(db)).toBe(0.8)
  })
})

describe('查账聚合口径（R4）', () => {
  it('周期解析', () => {
    const d = new Date(2026, 8, 18) // 2026-09-18
    const [s, e] = resolvePeriod('this_month', d)
    expect([s, e]).toEqual(['2026-09-01', '2026-09-30'])
    expect(resolvePeriod('last_month', d)).toEqual(['2026-08-01', '2026-08-31'])
    expect(resolvePeriod('this_week', d)).toEqual(['2026-09-14', '2026-09-20'])
    expect(resolvePeriod('last_7_days', d)).toEqual(['2026-09-12', '2026-09-18'])
    expect(previousPeriod('this_month', d)).toEqual(['2026-08-01', '2026-08-31'])
  })

  it('只统计 confirmed 的 expense/income；转账与软删不计入', () => {
    const today = new Date()
    const iso = (offsetDays = 0) => {
      const d = new Date(today)
      d.setDate(d.getDate() + offsetDays)
      return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}T12:00:00+08:00`
    }
    const accId = resolveAccountId(db, '现金')

    // 已确认支出 35 + 12
    for (const cents of [3500, 1200]) {
      const tx = createTransaction(db, { amountCents: cents, txType: 'expense', accountId: accId, occurredAt: iso() })
      recordParse(db, tx, { categoryId: getOrCreateCategoryId(db, '餐饮', 'expense'), confidenceScore: 0.9 })
      autoConfirm(db, tx)
    }
    // 已确认支出但软删 → 不计
    const delTx = createTransaction(db, { amountCents: 999, txType: 'expense', accountId: accId, occurredAt: iso() })
    recordParse(db, delTx, { categoryId: getOrCreateCategoryId(db, '餐饮', 'expense'), confidenceScore: 0.9 })
    autoConfirm(db, delTx)
    softDelete(db, delTx)

    // 转账 confirmed → 不计
    const bankId = resolveAccountId(db, '银行卡')
    const trTx = createTransaction(db, {
      amountCents: 100000,
      txType: 'transfer',
      accountId: accId,
      toAccountId: bankId,
      occurredAt: iso(),
    })
    recordParse(db, trTx, { confidenceScore: 0.9 })
    autoConfirm(db, trTx)

    // 未确认支出 → 不计
    createTransaction(db, { amountCents: 777, txType: 'expense', accountId: accId, occurredAt: iso() })

    const r = aggregate(db, { metric: 'total_expense', period: 'this_month' })
    expect(r.totalCents).toBe(3500 + 1200)
    expect(r.count).toBe(2)

    const byCat = aggregate(db, { metric: 'by_category', period: 'this_month' })
    expect(byCat.byCategory[0].category).toBe('餐饮')
    expect(byCat.budgetCents).toBeNull()
  })
})

describe('pending / 确认门', () => {
  it('创建 → 关闭（revision 校验）→ 重复关闭无效', () => {
    const txId = createTransaction(db, { amountCents: 100, txType: 'expense' })
    const id = createPending(db, { txId, sessionId: 's1', field: 'confirm_record', question: '分类未定' })
    expect(getPending(db, id)?.status).toBe('open')
    // revision 不匹配 → 拒绝关闭
    expect(closePending(db, id, 'resolved', 99)).toBeNull()
    expect(closePending(db, id, 'resolved', 1)).not.toBeNull()
    // 已关闭再关 → 无效
    expect(closePending(db, id, 'resolved')).toBeNull()
  })
})

describe('imports / 审计', () => {
  it('import 记录产生 create 审计', () => {
    const importId = createImport(db, { sourceType: 'screenshot', sourceMessageId: 'msg-x' })
    expect(importId).toBeGreaterThan(0)
    const row = db
      .prepare("SELECT entity_type, change_type FROM audit_log WHERE entity_type='import' AND entity_id=?")
      .get(importId) as { entity_type: string; change_type: string }
    expect(row.change_type).toBe('create')
  })
})
