// 经营概览面板（第五阶段）：全局盈亏总览 + 商品维度 + 渠道维度。
// 数据全部来自后端 getBusinessOverview，前端只做格式化。

import { useCallback, useEffect, useState } from 'react'
import type { ReactElement } from 'react'
import type { BusinessOverviewDTO, OverviewRangeDTO } from '../../../shared/types'
import { getBusinessOverview, money, percent, humanError, todayStartISO, monthStartISO } from '../lib/business'
import { Skeleton } from './Skeleton'

type RangeKind = 'all' | 'today' | 'month' | 'custom'

const RANGES: { id: RangeKind; label: string }[] = [
  { id: 'all', label: '全部' },
  { id: 'today', label: '今日' },
  { id: 'month', label: '本月' },
  { id: 'custom', label: '自定义' },
]

export interface BusinessOverviewProps {
  /** 外部触发刷新的版本号（记账成功后 +1）。 */
  refreshToken?: number
  onError: (msg: string) => void
}

export function BusinessOverview({ refreshToken, onError }: BusinessOverviewProps): ReactElement {
  const [kind, setKind] = useState<RangeKind>('all')
  const [from, setFrom] = useState('')
  const [to, setTo] = useState('')
  const [data, setData] = useState<BusinessOverviewDTO | null>(null)
  const [loading, setLoading] = useState(false)

  const buildRange = useCallback((): OverviewRangeDTO | undefined => {
    if (kind === 'today') return { from: todayStartISO(), to: null }
    if (kind === 'month') return { from: monthStartISO(), to: null }
    if (kind === 'custom') {
      const r: OverviewRangeDTO = {}
      if (from) { const d = new Date(from); d.setHours(0, 0, 0, 0); r.from = d.toISOString() }
      if (to) { const d = new Date(to); d.setHours(23, 59, 59, 999); r.to = d.toISOString() }
      return r
    }
    return undefined
  }, [kind, from, to])

  const load = useCallback(async () => {
    setLoading(true)
    try {
      setData(await getBusinessOverview(buildRange()))
    } catch (e) {
      onError(humanError(e))
    } finally {
      setLoading(false)
    }
  }, [buildRange, onError])

  useEffect(() => { void load() }, [load, refreshToken])

  if (!data) return <Skeleton rows={4} tall short />

  const profitPositive = data.net_profit_cents >= 0

  return (
    <div className="mz-biz-overview">
      {/* 区间切换 */}
      <div className="mz-biz-toolbar">
        <div className="mz-biz-range">
          {RANGES.map(r => (
            <button
              key={r.id}
              type="button"
              className={`mz-biz-range-btn${kind === r.id ? ' is-active' : ''}`}
              onClick={() => setKind(r.id)}
            >
              {r.label}
            </button>
          ))}
        </div>
        {kind === 'custom' && (
          <span className="mz-biz-range-custom">
            <input type="date" value={from} onChange={e => setFrom(e.target.value)} />
            <span>～</span>
            <input type="date" value={to} onChange={e => setTo(e.target.value)} />
          </span>
        )}
        <button type="button" className="mz-biz-btn" onClick={() => void load()} disabled={loading}>
          {loading ? '刷新中…' : '刷新'}
        </button>
      </div>

      {/* 核心盈亏卡 */}
      <div className="mz-biz-kpi-grid">
        <KpiCard label="净销售额" value={money(data.net_sales_cents)} sub={`销售 ${money(data.sales_cents)} · 退款 ${money(data.refund_cents)}`} />
        <KpiCard label="毛利润" value={money(data.gross_profit_cents)} sub={`毛利率 ${percent(data.gross_margin)} · 成本 ${money(data.cost_cents)}`} tone="accent" />
        <KpiCard
          label="净利润"
          value={money(data.net_profit_cents)}
          sub={`净利率 ${percent(data.net_margin)}`}
          tone={profitPositive ? 'accent' : 'danger'}
        />
        <KpiCard label="库存占用" value={money(data.stock_cost_cents)} sub={`库存 ${data.stock_qty} 件`} />
      </div>

      {/* 收支明细行 */}
      <div className="mz-biz-detail-row">
        <DetailItem label="客服收入" value={money(data.cs_income_cents)} tone="income" />
        <DetailItem label="其他收入" value={money(data.other_income_cents)} tone="income" />
        <DetailItem label="经营支出" value={money(data.expense_cents)} tone="expense" />
        <DetailItem label="其他支出" value={money(data.other_expense_cents)} tone="expense" />
        <DetailItem label="订单数" value={`${data.order_count} 单`} />
        <DetailItem label="销售件数" value={`${data.sales_qty} 件`} />
      </div>

      {/* 今日快照 */}
      <div className="mz-biz-subsection">
        <h3>今日快照</h3>
        <div className="mz-biz-today">
          <TodayItem label="今日销售" value={money(data.today.sales_cents)} />
          <TodayItem label="今日退款" value={money(data.today.refund_cents)} />
          <TodayItem label="今日毛利" value={money(data.today.gross_profit_cents)} tone="accent" />
          <TodayItem label="今日支出" value={money(data.today.expense_cents)} tone="expense" />
          <TodayItem
            label="今日净利"
            value={money(data.today.net_profit_cents)}
            tone={data.today.net_profit_cents >= 0 ? 'accent' : 'danger'}
          />
          <TodayItem label="今日订单" value={`${data.today.order_count} 单`} />
        </div>
      </div>

      {/* 商品维度 */}
      <div className="mz-biz-subsection">
        <h3>商品盈亏</h3>
        <table className="mz-biz-table">
          <thead>
            <tr>
              <th>商品</th>
              <th className="mz-num">销售</th>
              <th className="mz-num">退款</th>
              <th className="mz-num">净销售</th>
              <th className="mz-num">成本</th>
              <th className="mz-num">毛利</th>
              <th className="mz-num">毛利率</th>
            </tr>
          </thead>
          <tbody>
            {data.products.map(p => (
              <tr key={p.product_id}>
                <td>{p.brand} / {p.product_name}</td>
                <td className="mz-num">{money(p.sales_cents)}</td>
                <td className="mz-num">{money(p.refund_cents)}</td>
                <td className="mz-num">{money(p.net_sales_cents)}</td>
                <td className="mz-num">{money(p.cost_cents)}</td>
                <td className={`mz-num${p.gross_profit_cents < 0 ? ' is-neg' : ''}`}>{money(p.gross_profit_cents)}</td>
                <td className="mz-num">{percent(p.gross_margin)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {/* 渠道维度 */}
      <div className="mz-biz-subsection">
        <h3>渠道收支</h3>
        {data.channels.length === 0 ? (
          <div className="mz-biz-empty">暂无渠道数据</div>
        ) : (
          <table className="mz-biz-table">
            <thead>
              <tr>
                <th>渠道</th>
                <th>方向</th>
                <th className="mz-num">金额</th>
                <th className="mz-num">笔数</th>
              </tr>
            </thead>
            <tbody>
              {data.channels.map((c, i) => (
                <tr key={`${c.kind}-${c.channel}-${i}`}>
                  <td>{c.channel}</td>
                  <td>
                    <span className={`mz-biz-tag ${c.kind === 'income' ? 'is-income' : 'is-expense'}`}>
                      {c.kind === 'income' ? '收入' : '支出'}
                    </span>
                  </td>
                  <td className={`mz-num ${c.kind === 'income' ? 'is-income' : 'is-expense'}`}>{money(c.amount_cents)}</td>
                  <td className="mz-num">{c.count}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  )
}

function KpiCard({ label, value, sub, tone }: {
  label: string
  value: string
  sub?: string
  tone?: 'accent' | 'danger'
}): ReactElement {
  return (
    <div className={`mz-biz-kpi${tone ? ` is-${tone}` : ''}`}>
      <div className="mz-biz-kpi-label">{label}</div>
      <div className="mz-biz-kpi-value mz-num">{value}</div>
      {sub && <div className="mz-biz-kpi-sub">{sub}</div>}
    </div>
  )
}

function DetailItem({ label, value, tone }: { label: string; value: string; tone?: 'income' | 'expense' }): ReactElement {
  return (
    <div className="mz-biz-detail-item">
      <span className="mz-biz-detail-label">{label}</span>
      <span className={`mz-biz-detail-value mz-num${tone ? ` is-${tone}` : ''}`}>{value}</span>
    </div>
  )
}

function TodayItem({ label, value, tone }: { label: string; value: string; tone?: 'accent' | 'expense' | 'danger' }): ReactElement {
  return (
    <div className={`mz-biz-today-item${tone ? ` is-${tone}` : ''}`}>
      <span className="mz-biz-today-label">{label}</span>
      <b className="mz-biz-today-value mz-num">{value}</b>
    </div>
  )
}
