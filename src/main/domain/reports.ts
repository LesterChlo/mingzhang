// 月报（A7）—— 最简可靠口径。落库纪律：不写 transactions、不写 audit_log，只记 agent_runs。
// 状态用 settings KV 记时间戳（免审计）；月报文本 = 模板生成（防幻觉），不交给模型。
// 移植自 legacy backend/domain/reports.py。

import type { Database } from 'better-sqlite3-multiple-ciphers'
import { getSetting, setSetting } from './ledger'
import { monthRange, previousMonth, sumRange } from './queries'
import { nowIso } from '../db/time'

const TOP_N = 5

const KEY_GENERATED = 'report_generated_{month}'
const KEY_READ = 'report_read_{month}'

export interface TopCategory {
  category: string
  totalCents: number
  count: number
}

export interface MonthReport {
  month: string
  range: [string, string]
  totalExpenseCents: number
  totalIncomeCents: number
  countExpense: number
  countIncome: number
  topCategories: TopCategory[]
  compare: { month: string; totalCents: number; deltaCents: number; hasData: boolean }
  budgetCents: number | null
  budgetRemainingCents: number | null
  empty: boolean
}

export function buildReport(db: Database, year: number, month: number): MonthReport {
  const [start, end] = monthRange(year, month)
  const { total: expense, count: nExpense } = sumRange(db, 'expense', start, end)
  const { total: income, count: nIncome } = sumRange(db, 'income', start, end)

  const rows = db
    .prepare(
      "SELECT COALESCE(c.name,'未分类') AS category, COALESCE(SUM(t.amount_cents),0) AS total_cents," +
        ' COUNT(*) AS n FROM v_reportable_transactions t' +
        ' LEFT JOIN categories c ON c.id = t.category_id' +
        " WHERE t.type='expense' AND substr(t.occurred_at,1,10) BETWEEN ? AND ?" +
        ' GROUP BY c.name ORDER BY total_cents DESC LIMIT ?',
    )
    .all(start, end, TOP_N) as unknown as { category: string; total_cents: number; n: number }[]
  const top: TopCategory[] = rows.map((r) => ({
    category: r.category,
    totalCents: Number(r.total_cents),
    count: Number(r.n),
  }))

  // 环比：上一个自然月
  const prevYear = month === 1 ? year - 1 : year
  const prevMonth = month === 1 ? 12 : month - 1
  const [prevStart, prevEnd] = monthRange(prevYear, prevMonth)
  const { total: prevExpense, count: prevN } = sumRange(db, 'expense', prevStart, prevEnd)
  const pad = (n: number) => String(n).padStart(2, '0')

  const budgetRaw = getSetting(db, 'monthly_budget_cents', '0')
  const budget = Number.parseInt(budgetRaw ?? '0', 10) || 0

  return {
    month: `${year}-${pad(month)}`,
    range: [start, end],
    totalExpenseCents: expense,
    totalIncomeCents: income,
    countExpense: nExpense,
    countIncome: nIncome,
    topCategories: top,
    compare: {
      month: `${prevYear}-${pad(prevMonth)}`,
      totalCents: prevExpense,
      deltaCents: expense - prevExpense,
      hasData: prevN > 0,
    },
    budgetCents: budget || null,
    budgetRemainingCents: budget ? budget - expense : null,
    empty: nExpense + nIncome === 0,
  }
}

/** 历史月份小卡的一条（报告屏「过去几个月」网格；mz:reportMonths 的返回元素）。 */
export interface MonthSummary {
  /** 'YYYY-MM' */
  month: string
  expenseCents: number
  incomeCents: number
  /** 该月已确认收支总笔数（支出 + 收入，与 buildReport 的 empty 口径同源）。 */
  count: number
  /** count === 0 —— 空月也要占一张卡，网格才恒为 N 张。 */
  empty: boolean
}

/** 网格最多回溯几个月（挡住「传 10000 个月」这类离谱入参）。 */
export const MAX_SUMMARY_MONTHS = 24

/**
 * 近 count 个自然月的轻量汇总（含空月，从早到晚排）。
 *
 * 口径与 buildReport 一致：只统计 v_reportable_transactions（已确认的支出/收入），
 * 转账/不计收支/待确认/软删除都不进。一条 GROUP BY 聚合 SQL 出全部有数月份，
 * 没有数的月份在内存里补零（网格因此恒为 count 张卡，不必靠"有数据才有卡"）。
 * 纯读：不写 transactions / audit_log / settings。
 */
export function listMonthSummaries(db: Database, count = 12, base: Date = new Date()): MonthSummary[] {
  const n = Math.trunc(count)
  if (!Number.isFinite(count) || n < 1 || n > MAX_SUMMARY_MONTHS) {
    throw new Error(`月份数应为 1~${MAX_SUMMARY_MONTHS} 的整数，收到「${String(count)}」`)
  }
  const pad = (x: number) => String(x).padStart(2, '0')
  const months: string[] = []
  for (let i = n - 1; i >= 0; i--) {
    const d = new Date(base.getFullYear(), base.getMonth() - i, 1)
    months.push(`${d.getFullYear()}-${pad(d.getMonth() + 1)}`)
  }

  const rows = db
    .prepare(
      "SELECT substr(occurred_at,1,7) AS month," +
        " COALESCE(SUM(CASE WHEN type='expense' THEN amount_cents ELSE 0 END),0) AS expense_cents," +
        " COALESCE(SUM(CASE WHEN type='income' THEN amount_cents ELSE 0 END),0) AS income_cents," +
        ' COUNT(*) AS n FROM v_reportable_transactions' +
        ' WHERE substr(occurred_at,1,7) BETWEEN ? AND ?' +
        ' GROUP BY month',
    )
    .all(months[0], months[months.length - 1]) as unknown as {
    month: string
    expense_cents: number
    income_cents: number
    n: number
  }[]

  const byMonth = new Map(rows.map((r) => [String(r.month), r]))
  return months.map((month) => {
    const r = byMonth.get(month)
    const n = r ? Number(r.n) : 0
    return {
      month,
      expenseCents: r ? Number(r.expense_cents) : 0,
      incomeCents: r ? Number(r.income_cents) : 0,
      count: n,
      empty: n === 0,
    }
  })
}

export function reportText(report: MonthReport): string {
  const yuan = report.totalExpenseCents / 100
  const income = report.totalIncomeCents / 100
  if (report.empty) {
    return `${report.month} 没有任何已确认的收支记录，这份月报是空的。`
  }
  const parts: string[] = [
    `${report.month} 月报：支出 ¥${yuan.toFixed(2)}（${report.countExpense} 笔），收入 ¥${income.toFixed(2)}（${report.countIncome} 笔）。`,
  ]
  if (report.topCategories.length > 0) {
    parts.push(
      '支出主要去向：' +
        report.topCategories.map((c) => `${c.category} ¥${(c.totalCents / 100).toFixed(2)}`).join('、') +
        '。',
    )
  }
  const cmp = report.compare
  if (cmp.hasData) {
    const delta = cmp.deltaCents / 100
    if (cmp.totalCents) {
      const pct = (Math.abs(cmp.deltaCents) / cmp.totalCents) * 100
      parts.push(`比 ${cmp.month} ${delta > 0 ? '多' : '少'}了 ¥${Math.abs(delta).toFixed(2)}（${pct.toFixed(1)}%）。`)
    }
  } else {
    parts.push(`${cmp.month} 没有记录，无法环比。`)
  }
  if (report.budgetCents) {
    const remain = (report.budgetRemainingCents ?? 0) / 100
    parts.push(
      `月度预算 ¥${(report.budgetCents / 100).toFixed(2)}，` +
        (remain >= 0 ? `还剩 ¥${remain.toFixed(2)}。` : `已超支 ¥${Math.abs(remain).toFixed(2)}。`),
    )
  } else {
    parts.push('（未设置月度预算，以上是同期对比，不是预算提醒。）')
  }
  return parts.join(' ')
}

export function isGenerated(db: Database, month: string): boolean {
  return getSetting(db, KEY_GENERATED.replace('{month}', month)) !== null
}

export function isRead(db: Database, month: string): boolean {
  return getSetting(db, KEY_READ.replace('{month}', month)) !== null
}

/** 免审计写标记：月报不得写 audit_log（A7 落库纪律）。 */
export function markGenerated(db: Database, month: string): void {
  setSetting(db, KEY_GENERATED.replace('{month}', month), nowIso(), { audit: false })
}

export function markRead(db: Database, month: string): void {
  setSetting(db, KEY_READ.replace('{month}', month), nowIso(), { audit: false })
}

/** 应用启动：上月月报尚未生成过 → 生成一次（幂等）。空月不生成、不标记（终审 2026-09-16）。 */
export function startupReportCheck(db: Database, today?: Date): MonthReport | null {
  const now = today ?? new Date()
  const { year, month } = previousMonth(now)
  const pad = (n: number) => String(n).padStart(2, '0')
  const key = `${year}-${pad(month)}`
  if (isGenerated(db, key)) return null

  const report = buildReport(db, year, month)
  if (report.empty) return null
  db.prepare(
    'INSERT INTO agent_runs (session_id, user_input, llm_provider, tool_calls,' +
      " output_summary, trigger, status, created_at, updated_at)" +
      " VALUES ('startup', NULL, ?, ?, ?, 'scheduled', 'success', ?, ?)",
  ).run(null, '["monthly_report"]', reportText(report).slice(0, 500), nowIso(), nowIso())
  markGenerated(db, key)
  return report
}
