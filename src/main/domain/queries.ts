// 查账聚合层 —— 查询规格由 LLM 生成，SQL 由这里执行（禁止 LLM 直写 SQL）。
// 口径（R4）：只统计 v_reportable_transactions（已确认的支出/收入）；转账/调整不计入。
// 移植自 legacy backend/domain/queries.py，逐行对齐。

import type { Database } from 'better-sqlite3-multiple-ciphers'
import { getSetting } from './ledger'

export const PERIODS = ['this_month', 'last_month', 'this_week', 'last_7_days'] as const
export type Period = (typeof PERIODS)[number]

function today(): Date {
  return new Date()
}

function isoDate(d: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}

function addDays(d: Date, days: number): Date {
  const out = new Date(d)
  out.setDate(out.getDate() + days)
  return out
}

export function resolvePeriod(period: Period, base?: Date): [string, string] {
  const now = base ?? today()
  if (period === 'this_month') {
    const start = new Date(now.getFullYear(), now.getMonth(), 1)
    const end = new Date(now.getFullYear(), now.getMonth() + 1, 0)
    return [isoDate(start), isoDate(end)]
  }
  if (period === 'last_month') {
    const start = new Date(now.getFullYear(), now.getMonth() - 1, 1)
    const end = new Date(now.getFullYear(), now.getMonth(), 0)
    return [isoDate(start), isoDate(end)]
  }
  if (period === 'this_week') {
    // 周一为一周之始
    const start = addDays(now, -((now.getDay() + 6) % 7))
    return [isoDate(start), isoDate(addDays(start, 6))]
  }
  if (period === 'last_7_days') {
    return [isoDate(addDays(now, -6)), isoDate(now)]
  }
  throw new Error(`未知周期：${period}`)
}

/** 同期对比区间：整月/整周往前平移一个周期，last_7_days 往前平移 7 天。
 *  月份周期取上个完整自然月（legacy 的 span 平移在大小月交错时窗口差一天，这里按"整月平移"本意修正）。 */
export function previousPeriod(period: Period, base?: Date): [string, string] {
  const now = base ?? today()
  if (period === 'this_month' || period === 'last_month') {
    const [startS] = resolvePeriod(period, now)
    const start = new Date(`${startS}T00:00:00`)
    const prevStart = new Date(start.getFullYear(), start.getMonth() - 1, 1)
    const prevEnd = new Date(start.getFullYear(), start.getMonth(), 0)
    return [isoDate(prevStart), isoDate(prevEnd)]
  }
  const [startS, endS] = resolvePeriod(period, now)
  const start = new Date(`${startS}T00:00:00`)
  const end = new Date(`${endS}T00:00:00`)
  const span = Math.round((end.getTime() - start.getTime()) / 86400000) + 1
  return [isoDate(addDays(start, -span)), isoDate(addDays(end, -span))]
}

export function sumRange(
  db: Database,
  txType: 'expense' | 'income',
  start: string,
  end: string,
): { total: number; count: number } {
  const row = db
    .prepare(
      'SELECT COALESCE(SUM(amount_cents),0) AS total, COUNT(*) AS n FROM v_reportable_transactions' +
        " WHERE type = ? AND substr(occurred_at,1,10) BETWEEN ? AND ?",
    )
    .get(txType, start, end) as { total: number; n: number }
  return { total: Number(row.total), count: Number(row.n) }
}

/** 任意年月的 [起, 止]（含端点，本地日期字符串）——月报用。 */
export function monthRange(year: number, month: number): [string, string] {
  const last = new Date(year, month, 0).getDate()
  const pad = (n: number) => String(n).padStart(2, '0')
  return [`${year}-${pad(month)}-01`, `${year}-${pad(month)}-${pad(last)}`]
}

export function previousMonth(today: Date): { year: number; month: number } {
  const first = new Date(today.getFullYear(), today.getMonth(), 1)
  const lastPrev = new Date(first.getFullYear(), first.getMonth(), 0)
  return { year: lastPrev.getFullYear(), month: lastPrev.getMonth() + 1 }
}

export interface AggregateResult {
  metric: string
  period: string
  range: [string, string]
  txType: string
  categoryName: string | null
  totalCents: number
  count: number
  byCategory: { category: string; totalCents: number; count: number }[]
  previous?: { range: [string, string]; totalCents: number; count: number; deltaCents: number }
  budgetCents: number | null
  budgetRemainingCents?: number
}

export interface AggregateInput {
  metric: 'total_expense' | 'total_income' | 'by_category'
  period: Period
  categoryName?: string | null
  comparePrevious?: boolean
}

export function aggregate(db: Database, input: AggregateInput): AggregateResult {
  const txType = input.metric === 'total_income' ? 'income' : 'expense'
  const [start, end] = resolvePeriod(input.period)
  const categoryName = input.categoryName ?? null

  let total: number
  let count: number
  if (categoryName) {
    const row = db
      .prepare(
        'SELECT COALESCE(SUM(t.amount_cents),0) AS total, COUNT(*) AS n' +
          ' FROM v_reportable_transactions t JOIN categories c ON c.id = t.category_id' +
          ' WHERE t.type = ? AND c.name = ? AND substr(t.occurred_at,1,10) BETWEEN ? AND ?',
      )
      .get(txType, categoryName, start, end) as { total: number; n: number }
    total = Number(row.total)
    count = Number(row.n)
  } else {
    const r = sumRange(db, txType, start, end)
    total = r.total
    count = r.count
  }

  const byCategory: AggregateResult['byCategory'] = []
  if (input.metric === 'by_category' || !categoryName) {
    const rows = db
      .prepare(
        "SELECT COALESCE(c.name,'未分类') AS category, COALESCE(SUM(t.amount_cents),0) AS total_cents," +
          ' COUNT(*) AS n FROM v_reportable_transactions t' +
          ' LEFT JOIN categories c ON c.id = t.category_id' +
          ' WHERE t.type = ? AND substr(t.occurred_at,1,10) BETWEEN ? AND ?' +
          ' GROUP BY c.name ORDER BY total_cents DESC',
      )
      .all(txType, start, end) as { category: string; total_cents: number; n: number }[]
    for (const r of rows) {
      byCategory.push({ category: r.category, totalCents: Number(r.total_cents), count: Number(r.n) })
    }
  }

  const result: AggregateResult = {
    metric: input.metric,
    period: input.period,
    range: [start, end],
    txType,
    categoryName,
    totalCents: total,
    count,
    byCategory,
    budgetCents: null,
  }

  if (input.comparePrevious) {
    const [prevStart, prevEnd] = previousPeriod(input.period)
    const prev = sumRange(db, txType, prevStart, prevEnd)
    result.previous = {
      range: [prevStart, prevEnd],
      totalCents: prev.total,
      count: prev.count,
      deltaCents: total - prev.total,
    }
  }

  const budgetRaw = getSetting(db, 'monthly_budget_cents', '0')
  const budget = Number.parseInt(budgetRaw ?? '0', 10) || 0
  result.budgetCents = budget > 0 ? budget : null // 0 / 未设置 → null，退回趋势对比
  if (budget > 0) result.budgetRemainingCents = budget - total
  return result
}
