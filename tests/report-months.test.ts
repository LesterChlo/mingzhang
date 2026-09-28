// 报告屏「过去几个月」网格的后端口（reports.listMonthSummaries + mz:reportMonths 的数据面）。
//
// 覆盖口径：
//   ① 一条聚合 SQL 出近 N 个月，且**空月也占一张卡**（网格恒为 N 张，界面不必"有数据才有卡"）；
//   ② 与 buildReport 同口径：只算已确认的支出/收入 —— 转账 / 不计收支 / 待确认 / 软删除都不进；
//   ③ 跨年边界（1 月回溯到去年 12 月）与 base 注入（用例不依赖"今天几号"）；
//   ④ 非法 count 报错，不静默回退成 12。
//
// 全部走真库（openSchemaDb + seed），不 mock SQL。

import { describe, expect, it, beforeEach } from 'vitest'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openSchemaDb } from './helpers'
import { MAX_SUMMARY_MONTHS, listMonthSummaries } from '../src/main/domain/reports'
import { autoConfirm, createTransaction, getOrCreateCategoryId, recordParse, resolveAccountId } from '../src/main/domain/ledger'
import { requestReview, softDelete } from '../src/main/domain/ledger'
import { seed } from '../src/main/db/seed'

type Db = ReturnType<typeof openSchemaDb>

let db: Db

/** 往库里放一笔交易（日期显式给，不依赖"今天"）。 */
function addTx(input: {
  month: string
  day: number
  cents: number
  type?: 'expense' | 'income' | 'transfer' | 'adjustment'
  category?: string
  merchant?: string
}): number {
  const txType = input.type ?? 'expense'
  const id = createTransaction(db, {
    amountCents: input.cents,
    txType,
    accountId: resolveAccountId(db, '现金'),
    // 转账的对方账户必填（schema CHECK：confirmed 的转账必须有 to_account_id 且不等于本方）
    toAccountId: txType === 'transfer' ? resolveAccountId(db, '微信') : null,
    occurredAt: `${input.month}-${String(input.day).padStart(2, '0')}T12:00:00+08:00`,
    merchant: input.merchant ?? null,
    sourceMessageId: null,
  })
  recordParse(db, id, {
    categoryId: input.category ? getOrCreateCategoryId(db, input.category, txType === 'income' ? 'income' : 'expense') : null,
    confidenceScore: 0.95,
  })
  autoConfirm(db, id)
  return id
}

beforeEach(() => {
  const dir = mkdtempSync(join(tmpdir(), 'mz-report-months-'))
  db = openSchemaDb(join(dir, 'test.db'))
  seed(db)
})

describe('listMonthSummaries：近 N 个月轻量汇总', () => {
  // 固定 base，用例不依赖"今天几号"（否则月初跑会跨月翻车）
  const base = new Date(2026, 8, 29) // 2026-09

  it('一条聚合 SQL 出足 N 张卡：空月也占位，卡片数恒等于 count', () => {
    addTx({ month: '2026-09', day: 3, cents: 3500, category: '餐饮' })
    addTx({ month: '2026-07', day: 9, cents: 12000, category: '购物' })

    const r = listMonthSummaries(db, 12, base)
    expect(r).toHaveLength(12)
    // 从早到晚，最后一个月就是 base 所在月
    expect(r[0].month).toBe('2025-10')
    expect(r[11].month).toBe('2026-09')
    // 跨年边界：2025-10/11/12 与 2026-01 都在窗口里
    expect(r.map((m) => m.month)).toContain('2025-12')
    expect(r.map((m) => m.month)).toContain('2026-01')
    // 有数的月份
    const sep = r.find((m) => m.month === '2026-09')
    expect(sep).toEqual({ month: '2026-09', expenseCents: 3500, incomeCents: 0, count: 1, empty: false })
    const jul = r.find((m) => m.month === '2026-07')
    expect(jul?.expenseCents).toBe(12000)
    // 没数的月份：补零且标 empty（不是"查不到"，是"这个月没有"）
    const aug = r.find((m) => m.month === '2026-08')
    expect(aug).toEqual({ month: '2026-08', expenseCents: 0, incomeCents: 0, count: 0, empty: true })
  })

  it('口径与 buildReport 同源：转账 / 不计收支 / 待确认 / 软删除都不进汇总', () => {
    const expense = addTx({ month: '2026-09', day: 1, cents: 2000, category: '餐饮' })
    addTx({ month: '2026-09', day: 2, cents: 50000, type: 'transfer' })
    addTx({ month: '2026-09', day: 3, cents: 700, type: 'adjustment' })
    // 待确认：有分类但没确认
    const reviewId = createTransaction(db, {
      amountCents: 9900,
      txType: 'expense',
      accountId: resolveAccountId(db, '现金'),
      toAccountId: null,
      occurredAt: '2026-09-04T12:00:00+08:00',
      merchant: '待确认商户',
      sourceMessageId: null,
    })
    requestReview(db, reviewId, { reason: '分类未定' })
    // 软删除
    softDelete(db, expense)

    const r = listMonthSummaries(db, 12, base)
    const sep = r.find((m) => m.month === '2026-09')
    expect(sep?.count).toBe(0)
    expect(sep?.expenseCents).toBe(0)
    expect(sep?.empty).toBe(true)
  })

  it('支出 / 收入分列，count 是两者之和', () => {
    addTx({ month: '2026-09', day: 1, cents: 3500, category: '餐饮' })
    addTx({ month: '2026-09', day: 2, cents: 1250, category: '餐饮' })
    addTx({ month: '2026-09', day: 5, cents: 800000, type: 'income', category: '生活费' })

    const sep = listMonthSummaries(db, 3, base).find((m) => m.month === '2026-09')
    expect(sep?.expenseCents).toBe(4750)
    expect(sep?.incomeCents).toBe(800000)
    expect(sep?.count).toBe(3)
    expect(sep?.empty).toBe(false)
  })

  it('窗口外的月份不出现（回溯 3 个月就只有 3 张卡）', () => {
    addTx({ month: '2026-09', day: 1, cents: 100, category: '餐饮' })
    addTx({ month: '2025-01', day: 1, cents: 999, category: '餐饮' })
    const r = listMonthSummaries(db, 3, base)
    expect(r.map((m) => m.month)).toEqual(['2026-07', '2026-08', '2026-09'])
  })

  it('count 非法：0 / 负数 / 超上限 / 非数字都报错，不静默回退', () => {
    expect(() => listMonthSummaries(db, 0, base)).toThrow(/1~24/)
    expect(() => listMonthSummaries(db, -3, base)).toThrow(/1~24/)
    expect(() => listMonthSummaries(db, MAX_SUMMARY_MONTHS + 1, base)).toThrow(/1~24/)
    expect(() => listMonthSummaries(db, Number.NaN, base)).toThrow(/1~24/)
    // 边界值合法
    expect(listMonthSummaries(db, 1, base)).toHaveLength(1)
    expect(listMonthSummaries(db, MAX_SUMMARY_MONTHS, base)).toHaveLength(MAX_SUMMARY_MONTHS)
  })

  it('纯读：连调两次结果一致（不写库、不改口径）', () => {
    addTx({ month: '2026-09', day: 1, cents: 3500, category: '餐饮' })
    const a = listMonthSummaries(db, 12, base)
    const b = listMonthSummaries(db, 12, base)
    expect(b).toEqual(a)
  })
})
