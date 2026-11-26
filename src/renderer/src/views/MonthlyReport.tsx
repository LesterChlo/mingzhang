// 月度经营报表（第六阶段）：
//   月份选择器 + 月度汇总卡 + 日趋势柱状图 + 商品排行 + 收入渠道环形图 + 支出分类环形图。
// 口径与经营概览一致（getMonthlyReport 限月聚合），前端只做展示与格式化。

import { useCallback, useEffect, useMemo, useState } from 'react'
import type { ReactElement } from 'react'
import type { MonthlyReportDTO } from '../../../shared/types'
import {
  getMonthlyReport, listBusinessMonths, money, moneyCompact, percent, humanError,
  currentMonth, monthLabel, dayLabel, exportBusinessExcel,
} from '../lib/business'
import { BarChart, DonutChart, RankBars } from './charts'
import { Skeleton } from './Skeleton'

export interface MonthlyReportProps {
  refreshToken?: number
  onError: (msg: string) => void
  /** 导出成功后提示。 */
  onToast?: (msg: string) => void
}

export function MonthlyReportView({ refreshToken, onError, onToast }: MonthlyReportProps): ReactElement {
  const [months, setMonths] = useState<string[]>([])
  const [month, setMonth] = useState<string>(currentMonth())
  const [report, setReport] = useState<MonthlyReportDTO | null>(null)
  const [loading, setLoading] = useState(false)
  const [exporting, setExporting] = useState(false)

  // 月份列表（含当前月，即使还没数据）
  useEffect(() => {
    void (async () => {
      try {
        const list = await listBusinessMonths(36)
        const merged = Array.from(new Set([currentMonth(), ...list])).sort().reverse()
        setMonths(merged)
      } catch (e) {
        onError(humanError(e))
      }
    })()
  }, [onError, refreshToken])

  const load = useCallback(async (m: string) => {
    setLoading(true)
    try {
      setReport(await getMonthlyReport(m))
    } catch (e) {
      onError(humanError(e))
    } finally {
      setLoading(false)
    }
  }, [onError])

  useEffect(() => { void load(month) }, [load, month, refreshToken])

  // 日趋势柱状图数据（只显示有数据的日，避免 30 根空柱）
  const dailyBars = useMemo(() => {
    if (!report) return []
    return report.daily.map((d) => ({
      label: dayLabel(d.date),
      value: d.net_sales_cents,
      title: `${d.date}：净销售 ${money(d.net_sales_cents)}｜毛利 ${money(d.gross_profit_cents)}｜${d.order_count} 单`,
      color: d.net_sales_cents < 0 ? 'var(--danger)' : 'var(--accent)',
    }))
  }, [report])

  if (!report) return <Skeleton rows={4} tall short />

  const profitTone = report.net_profit_cents >= 0 ? 'is-accent' : 'is-danger'
  const hasAnyData = report.order_count > 0 || report.expense_cents > 0 || report.cs_income_cents > 0

  return (
    <div className="mz-biz-report">
      {/* 月份选择 */}
      <div className="mz-biz-toolbar">
        <select
          className="mz-biz-month-select"
          value={month}
          onChange={(e) => setMonth(e.target.value)}
        >
          {months.map((m) => <option key={m} value={m}>{monthLabel(m)}</option>)}
        </select>
        <button type="button" className="mz-biz-btn" onClick={() => void load(month)} disabled={loading}>
          {loading ? '刷新中…' : '刷新'}
        </button>
        <button
          type="button"
          className="mz-biz-btn is-primary"
          disabled={exporting}
          onClick={() => {
            void (async () => {
              setExporting(true)
              try {
                const path = await exportBusinessExcel(month)
                if (path) onToast?.(`已导出：${path}`)
              } catch (e) {
                onError(humanError(e))
              } finally {
                setExporting(false)
              }
            })()
          }}
        >
          {exporting ? '导出中…' : '导出本月 Excel'}
        </button>
        <span className="mz-biz-toolbar-hint">月份按有经营数据的月份列出</span>
      </div>

      {!hasAnyData && (
        <div className="mz-biz-empty">「{monthLabel(report.month)}」还没有经营数据，去记一笔吧</div>
      )}

      {/* 汇总卡 */}
      <div className="mz-biz-kpi-grid">
        <div className="mz-biz-kpi">
          <div className="mz-biz-kpi-label">净销售额</div>
          <div className="mz-biz-kpi-value mz-num">{money(report.net_sales_cents)}</div>
          <div className="mz-biz-kpi-sub">销售 {money(report.sales_cents)} · 退款 {money(report.refund_cents)}</div>
        </div>
        <div className="mz-biz-kpi is-accent">
          <div className="mz-biz-kpi-label">毛利润</div>
          <div className="mz-biz-kpi-value mz-num">{money(report.gross_profit_cents)}</div>
          <div className="mz-biz-kpi-sub">毛利率 {percent(report.gross_margin)} · 成本 {money(report.cost_cents)}</div>
        </div>
        <div className={`mz-biz-kpi ${profitTone}`}>
          <div className="mz-biz-kpi-label">净利润</div>
          <div className="mz-biz-kpi-value mz-num">{money(report.net_profit_cents)}</div>
          <div className="mz-biz-kpi-sub">净利率 {percent(report.net_margin)}</div>
        </div>
        <div className="mz-biz-kpi">
          <div className="mz-biz-kpi-label">本月规模</div>
          <div className="mz-biz-kpi-value mz-num">{report.order_count} 单</div>
          <div className="mz-biz-kpi-sub">销量 {report.sales_qty} 件</div>
        </div>
      </div>

      {/* 收支补充 */}
      <div className="mz-biz-detail-row">
        <div className="mz-biz-detail-item"><span className="mz-biz-detail-label">客服收入</span><span className="mz-biz-detail-value mz-num is-income">{money(report.cs_income_cents)}</span></div>
        <div className="mz-biz-detail-item"><span className="mz-biz-detail-label">其他收入</span><span className="mz-biz-detail-value mz-num is-income">{money(report.other_income_cents)}</span></div>
        <div className="mz-biz-detail-item"><span className="mz-biz-detail-label">经营支出</span><span className="mz-biz-detail-value mz-num">{money(report.expense_cents)}</span></div>
        <div className="mz-biz-detail-item"><span className="mz-biz-detail-label">其他支出</span><span className="mz-biz-detail-value mz-num">{money(report.other_expense_cents)}</span></div>
      </div>

      {/* 日趋势 */}
      <section className="mz-biz-subsection">
        <h3>每日净销售</h3>
        <BarChart data={dailyBars} format={moneyCompact} height={170} />
      </section>

      {/* 商品排行 */}
      <section className="mz-biz-subsection">
        <h3>商品排行（按净销售额）</h3>
        <RankBars
          negativeRed
          items={report.product_rank.map((p) => ({
            label: `${p.brand} / ${p.product_name}`,
            sub: `${p.sales_qty} 件 · ${p.order_count} 单`,
            value: p.net_sales_cents,
            formatted: money(p.net_sales_cents),
          }))}
        />
      </section>

      {/* 环形图两列 */}
      <div className="mz-biz-report-charts">
        <section className="mz-biz-subsection">
          <h3>收入渠道占比</h3>
          <DonutChart
            slices={report.income_channels.map((c) => ({ label: c.label, value: c.amount_cents }))}
            centerText={moneyCompact(report.net_sales_cents + report.cs_income_cents + report.other_income_cents)}
            centerSub="总收入"
            size={170}
          />
        </section>
        <section className="mz-biz-subsection">
          <h3>支出分类占比</h3>
          <DonutChart
            slices={report.expense_categories.map((c) => ({ label: c.label, value: c.amount_cents }))}
            centerText={moneyCompact(report.expense_cents + report.other_expense_cents)}
            centerSub="总支出"
            size={170}
          />
        </section>
      </div>

      {/* 渠道明细表 */}
      {(report.income_channels.length > 0 || report.expense_categories.length > 0) && (
        <section className="mz-biz-subsection">
          <h3>明细</h3>
          <div className="mz-biz-report-tables">
            <table className="mz-biz-table">
              <thead>
                <tr><th>收入渠道</th><th className="mz-num">金额</th><th className="mz-num">占比</th><th className="mz-num">笔数</th></tr>
              </thead>
              <tbody>
                {report.income_channels.map((c, i) => (
                  <tr key={`inc-${c.label}-${i}`}>
                    <td>{c.label}</td>
                    <td className="mz-num is-income">{money(c.amount_cents)}</td>
                    <td className="mz-num">{percent(c.ratio)}</td>
                    <td className="mz-num">{c.count}</td>
                  </tr>
                ))}
                {report.income_channels.length === 0 && <tr><td colSpan={4} className="mz-biz-td-empty">本月无收入</td></tr>}
              </tbody>
            </table>
            <table className="mz-biz-table">
              <thead>
                <tr><th>支出分类</th><th className="mz-num">金额</th><th className="mz-num">占比</th><th className="mz-num">笔数</th></tr>
              </thead>
              <tbody>
                {report.expense_categories.map((c, i) => (
                  <tr key={`exp-${c.label}-${i}`}>
                    <td>{c.label}</td>
                    <td className="mz-num">{money(c.amount_cents)}</td>
                    <td className="mz-num">{percent(c.ratio)}</td>
                    <td className="mz-num">{c.count}</td>
                  </tr>
                ))}
                {report.expense_categories.length === 0 && <tr><td colSpan={4} className="mz-biz-td-empty">本月无支出</td></tr>}
              </tbody>
            </table>
          </div>
        </section>
      )}
    </div>
  )
}
