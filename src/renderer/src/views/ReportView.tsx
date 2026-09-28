// 报告屏（规格 §3.3）：当月大卡 + 历史月份小卡网格。**只读屏**——不产生待决项、不写账本。
//
// 数据口径纪律（与账本屏同源，不在前端反算）：
//   ① 大卡走 latestReport(month)：总额/笔数/分类 Top/环比/预算全由后端 buildReport 算好。
//   ② 网格走 reportMonths(N)：一条聚合 SQL 出近 N 个月（含空月，卡片数恒为 N）。
//   ③ 前端只做「原始值 → 人话」的格式化，不猜、不补、不把空月说成有数据。
//
// 屏内允许的动作只有两类，都不改数据：切月份（看）与跳账本（带筛选）。
// 滚动口径（第 3 轮定的规矩）：本屏在**自身区域内滚**，应用本体零页面滚动。

import { useCallback, useEffect, useMemo, useState } from 'react'
import type { ReactElement } from 'react'
import type { MonthSummaryDTO, ReportCardData } from '../../../shared/types'
import { humanError, money } from '../lib/ledgerFilter'
import { localMonth } from '../lib/shellFormat'

/** 网格回溯几个月（规格：近 12 个月）。 */
const HISTORY_MONTHS = 12

export interface ReportViewProps {
  /** 点分类条：带着「该月 + 该分类」跳账本（筛选由 AppShell 组装，账本屏自己仍是唯一筛选入口）。 */
  onGoLedger?: (filter: { month: string; category: string }) => void
}

/** 'YYYY-MM' → 「2026 年 9 月」（与设计稿月份标题同口径）。 */
export function monthLabel(month: string): string {
  const m = /^(\d{4})-(\d{1,2})$/.exec(month.trim())
  if (!m) return month
  return `${m[1]} 年 ${Number(m[2])} 月`
}

/** 报告屏图标（空态用；§2.4 48px 线性，透明度由 .mz-empty svg 统一施加）。 */
const REPORT_ICON = (
  <svg
    width="48"
    height="48"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="1.5"
    strokeLinecap="round"
    strokeLinejoin="round"
    aria-hidden="true"
  >
    <path d="M3 3v18h18" />
    <path d="M18 17V9" />
    <path d="M13 17V5" />
    <path d="M8 17v-3" />
  </svg>
)

export function ReportView({ onGoLedger }: ReportViewProps = {}): ReactElement {
  const thisMonth = useMemo(() => localMonth(), [])
  const [selected, setSelected] = useState<string>(thisMonth)
  const [months, setMonths] = useState<MonthSummaryDTO[] | null>(null)
  const [report, setReport] = useState<ReportCardData | null>(null)
  /** 首次加载（还没拿到任何数据）才出骨架；切月份只换内容，不闪整屏。 */
  const [loading, setLoading] = useState(true)
  // 两条通道各记各的错：共用一个 error 会被"另一条查成功了"顺手清掉，
  // 结果是网格读失败被大卡的成功掩盖（界面照常渲染一张空月卡）。
  const [monthsError, setMonthsError] = useState<string | null>(null)
  const [reportError, setReportError] = useState<string | null>(null)
  const [reloadKey, setReloadKey] = useState(0)
  const error = monthsError ?? reportError

  const reload = useCallback(() => setReloadKey((k) => k + 1), [])

  // 网格：近 N 个月（含空月）。读失败就是失败——不拿空数组冒充「没有数据」。
  useEffect(() => {
    let cancelled = false
    void window.mz
      .reportMonths(HISTORY_MONTHS)
      .then((r) => {
        if (cancelled) return
        setMonths(r)
        setMonthsError(null)
        // 选中的月份若不在窗口内（例如跨月后停在旧月），回到本月
        setSelected((cur) => (r.some((m) => m.month === cur) ? cur : thisMonth))
      })
      .catch((e) => {
        if (cancelled) return
        setMonthsError(humanError(e))
        setMonths(null)
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [reloadKey, thisMonth])

  // 大卡：选中月的月报。后端对空月返回 {empty:true}（不返回 null），所以「该月没记录」与「读失败」分得开。
  useEffect(() => {
    let cancelled = false
    void window.mz
      .latestReport(selected)
      .then((r) => {
        if (cancelled) return
        if (!r) throw new Error('账本未就绪')
        setReport(r)
        setReportError(null)
      })
      .catch((e) => {
        if (cancelled) return
        setReportError(humanError(e))
        setReport(null)
      })
    return () => {
      cancelled = true
    }
  }, [selected, reloadKey])

  // 账本变了（入账/改分类/删除/恢复）→ 本屏跟上：与账本屏同一套事件源，不另开轮询。
  useEffect(() => {
    const off = window.mz.onChatEvent((evt) => {
      switch (evt.type) {
        case 'record-confirmed':
        case 'gate-executed':
        case 'gate-cancelled':
        case 'tx-deleted':
        case 'tx-restored':
        case 'turn-end':
        case 'agent-end':
          reload()
          break
        default:
          break
      }
    })
    return off
  }, [reload])

  const focusCapture = useCallback(() => {
    const el = document.querySelector('input[aria-label="速记行"]')
    if (el instanceof HTMLInputElement) el.focus()
  }, [])

  // 整段窗口都没有一笔已确认收支 → 空态（不是「这个月没数据」，是「还没有可生成的报告」）。
  // 两路数据都到齐才判：只有网格先回来时不算空（否则会闪一下空态）。
  const isVoid = months !== null && report !== null && months.every((m) => m.empty) && report.empty
  // 骨架：首屏加载中，或两路都还没回来（别闪成白屏）；出错时不出骨架。
  const showSkeleton = loading || (error === null && months === null && report === null)
  // 网格按「新 → 旧」排（设计稿口径：最近的在左上角）。
  const cards = useMemo(() => (months ? [...months].reverse() : []), [months])
  const index = cards.findIndex((m) => m.month === selected)
  const isCurrent = selected === thisMonth

  return (
    <div className="mz-report" data-testid="report-view">
      {showSkeleton && (
        <div className="mz-report-skel" data-testid="report-loading" aria-busy="true" aria-label="正在生成报告">
          <div className="mz-skel" style={{ width: 180, height: 22 }} />
          <div className="mz-skel" style={{ width: '100%', height: 148 }} />
          <div className="mz-skel" style={{ width: 120, height: 16 }} />
          <div className="mz-report-skel-grid">
            {Array.from({ length: 6 }).map((_, i) => (
              <div key={i} className="mz-skel" style={{ height: 64 }} />
            ))}
          </div>
        </div>
      )}

      {error && (
        <div className="mz-error-card" data-testid="report-error" role="alert">
          <div className="mz-error-title">报告生成失败：{error}</div>
          <div className="mz-error-sub">账本数据不受影响，可重新生成或从快照恢复</div>
          <div className="mz-actions">
            <button type="button" className="mz-btn mz-btn-primary" data-testid="report-retry" onClick={reload}>
              重新生成
            </button>
          </div>
        </div>
      )}

      {!showSkeleton && !error && isVoid && (
        <div className="mz-empty" data-testid="report-empty">
          {REPORT_ICON}
          <div className="mz-empty-title">还没有可生成的报告</div>
          <div className="mz-empty-hint">记第一笔吧 —— 说一句，或把截图拖进上面的输入行</div>
          <button type="button" className="mz-btn mz-btn-primary" data-testid="report-empty-cta" onClick={focusCapture}>
            记第一笔
          </button>
        </div>
      )}

      {!showSkeleton && !error && !isVoid && report && (
        <>
          {/* ---------- 月份头：当前看的是哪个月，一眼可见；‹ › 在窗口内前后翻 ---------- */}
          <div className="mz-report-head">
            <button
              type="button"
              className="mz-report-nav"
              aria-label="上一月"
              data-testid="report-prev-month"
              disabled={index < 0 || index >= cards.length - 1}
              onClick={() => index >= 0 && index < cards.length - 1 && setSelected(cards[index + 1].month)}
            >
              ‹
            </button>
            <h2 className="mz-report-title mz-num" data-testid="report-month">
              {monthLabel(selected)}
            </h2>
            <button
              type="button"
              className="mz-report-nav"
              aria-label="下一月"
              data-testid="report-next-month"
              disabled={index <= 0}
              onClick={() => index > 0 && setSelected(cards[index - 1].month)}
            >
              ›
            </button>
            {isCurrent && (
              <span className="mz-tag mz-tag-blue" data-testid="report-current-tag">
                本月
              </span>
            )}
          </div>

          {/* ---------- 当月大卡 ---------- */}
          <section className="mz-report-hero" data-testid="report-hero" aria-label={`${monthLabel(selected)}月报`}>
            <div className="mz-report-hero-top">
              <div>
                <div className="mz-report-lb">本月支出</div>
                <div className="mz-report-expense mz-num" data-testid="report-expense">
                  {money(report.totalExpenseCents)}
                </div>
                <DeltaTag report={report} />
              </div>
              <div>
                <div className="mz-report-lb">本月收入</div>
                <div className="mz-report-income mz-num" data-testid="report-income">
                  {money(report.totalIncomeCents)}
                </div>
              </div>
              <div className="mz-report-stats">
                <div className="mz-report-stat">
                  <div className="mz-report-lb">支出笔数</div>
                  <div className="mz-report-stat-v mz-num" data-testid="report-count-expense">
                    {report.countExpense} 笔
                  </div>
                </div>
                <div className="mz-report-stat">
                  <div className="mz-report-lb">收入笔数</div>
                  <div className="mz-report-stat-v mz-num" data-testid="report-count-income">
                    {report.countIncome} 笔
                  </div>
                </div>
              </div>
            </div>

            {/* 预算进度条：没设预算就不显示（不拿 0 元预算画一根满条） */}
            {report.budgetCents ? (
              <div className="mz-report-budget" data-testid="report-budget">
                <div className="mz-report-budget-row">
                  <span className="mz-report-lb">月度预算</span>
                  <span className="mz-num">
                    已用 <b>{money(report.totalExpenseCents)}</b> / 预算 <b>{money(report.budgetCents)}</b>
                  </span>
                  <span className="mz-report-budget-remain mz-num" data-testid="report-budget-remain">
                    {budgetRemainText(report.budgetRemainingCents ?? 0)}
                  </span>
                </div>
                <div
                  className="mz-report-budget-track"
                  role="progressbar"
                  aria-label="月度预算已用比例"
                  aria-valuemin={0}
                  aria-valuemax={100}
                  aria-valuenow={Math.min(100, budgetPct(report.totalExpenseCents, report.budgetCents))}
                >
                  <div
                    className={`mz-report-budget-fill ${budgetTone(report.totalExpenseCents, report.budgetCents)}`}
                    data-testid="report-budget-fill"
                    style={{ width: `${Math.min(100, budgetPct(report.totalExpenseCents, report.budgetCents))}%` }}
                  />
                </div>
              </div>
            ) : null}

            {report.empty ? (
              <div className="mz-report-month-empty" data-testid="report-month-empty">
                {monthLabel(selected)}还没有已确认的收支 —— 换个月份看看，或在上面记一笔。
              </div>
            ) : (
              <>
                <div className="mz-report-lb mz-report-section-lb">分类支出（点一条跳账本，按该月 + 该分类筛）</div>
                <div className="mz-report-cats" data-testid="report-cats">
                  {report.topCategories.map((c) => {
                    const top = report.topCategories[0]?.totalCents || 1
                    const pct = Math.max(2, Math.round((c.totalCents / top) * 100))
                    const share =
                      report.totalExpenseCents > 0 ? Math.round((c.totalCents / report.totalExpenseCents) * 100) : 0
                    return (
                      <button
                        key={c.category}
                        type="button"
                        className="mz-report-cat"
                        data-testid="report-cat"
                        data-category={c.category}
                        title={`看 ${monthLabel(selected)}「${c.category}」的账`}
                        onClick={() => onGoLedger?.({ month: report.month, category: c.category })}
                      >
                        <span className="mz-report-cat-nm">{c.category}</span>
                        <span className="mz-report-cat-track" aria-hidden="true">
                          <span className="mz-report-cat-fill" style={{ width: `${pct}%` }} />
                        </span>
                        <span className="mz-report-cat-val mz-num">
                          <b>{money(c.totalCents)}</b> · {c.count} 笔 · {share}%
                        </span>
                      </button>
                    )
                  })}
                </div>
              </>
            )}
          </section>

          {/* ---------- 历史月份小卡网格：近 12 个月，点卡切当月大卡 ---------- */}
          <div className="mz-report-history">
            <div className="mz-report-history-lb">过去 {HISTORY_MONTHS} 个月（点一张切换上面的月报）</div>
            <div className="mz-report-grid" data-testid="report-months">
              {cards.map((m) => (
                <button
                  key={m.month}
                  type="button"
                  className={`mz-report-card${m.month === selected ? ' is-active' : ''}`}
                  data-testid="report-month-card"
                  data-month={m.month}
                  data-empty={m.empty ? 'true' : 'false'}
                  aria-current={m.month === selected ? 'true' : undefined}
                  onClick={() => setSelected(m.month)}
                >
                  <span className="mz-report-card-mn">{monthLabel(m.month)}</span>
                  <span className="mz-report-card-mv mz-num">
                    {m.empty ? <span className="mz-text-3">无记录</span> : money(m.expenseCents)}
                  </span>
                  <span className="mz-report-card-sub mz-num">{m.empty ? '—' : `${m.count} 笔 · 支出`}</span>
                </button>
              ))}
            </div>
          </div>
        </>
      )}
    </div>
  )
}

/** 环比：↑/↓ + 金额 + 百分比。上月无记录就如实说没有，不画 0%。 */
function DeltaTag({ report }: { report: ReportCardData }): ReactElement {
  const cmp = report.compare
  if (!cmp.hasData || cmp.totalCents === 0) {
    return (
      <span className="mz-report-delta is-none mz-num" data-testid="report-delta">
        {cmp.month} 无记录，无法环比
      </span>
    )
  }
  const down = cmp.deltaCents < 0
  const pct = Math.abs((cmp.deltaCents / cmp.totalCents) * 100).toFixed(1)
  // 金额写「较上月多/少花多少」（差额），别只写个 ¥ 让人误读成上月的总数
  return (
    <span className={`mz-report-delta ${down ? 'is-down' : 'is-up'} mz-num`} data-testid="report-delta">
      {down ? '↓' : '↑'} {pct}% · 较 {cmp.month} {down ? '少花' : '多花'} {money(Math.abs(cmp.deltaCents))}
    </span>
  )
}

function budgetPct(expenseCents: number, budgetCents: number): number {
  if (budgetCents <= 0) return 0
  return (expenseCents / budgetCents) * 100
}

/** >90% 转黄、超支转红（规格 §3.3）。 */
function budgetTone(expenseCents: number, budgetCents: number): string {
  const pct = budgetPct(expenseCents, budgetCents)
  if (pct > 100) return 'is-over'
  if (pct > 90) return 'is-warn'
  return 'is-ok'
}

function budgetRemainText(remainCents: number): string {
  return remainCents >= 0 ? `剩余 ${money(remainCents)}` : `已超支 ${money(-remainCents)}`
}
