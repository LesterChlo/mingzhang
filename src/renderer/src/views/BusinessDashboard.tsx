// 首页经营仪表盘（第六阶段 · 第十一阶段奶油风重构）：
//   ⓪ 欢迎区（问候 + 日期 + 今日状态 + 克制装饰）
//   ① 今日 / 本月关键指标（数字递增动画 + 趋势箭头 + 悬停上浮）
//   ② 近 6 月盈亏趋势折线
//   ③ 商品卡片网格（库存/净销售/毛利/毛利率）
//   ④ 快捷记账入口（圆润图标 + 真实跳转）
// 数据全部来自后端 getBusinessOverview + getTrend，前端只做展示，不编造任何数字。

import { useCallback, useEffect, useState } from 'react'
import type { ReactElement } from 'react'
import type { BusinessOverviewDTO, TrendPointDTO } from '../../../shared/types'
import {
  getBusinessOverview, getTrend, money, moneyCompact, percent, humanError,
  monthStartISO, currentMonth, monthLabel,
} from '../lib/business'
import { LineChart } from './charts'
import { Skeleton } from './Skeleton'
import { CountUpMoney, DeltaBadge } from './CountUp'

export interface BusinessDashboardProps {
  /** 记账成功后 +1，触发重算。 */
  refreshToken?: number
  onError: (msg: string) => void
  /** 快捷入口：跳到某个记账 Tab。 */
  onGoTab: (tab: 'sale' | 'purchase' | 'refund' | 'cs' | 'expense' | 'products' | 'templates') => void
}

/** 按时段给一句问候（本地时间，不依赖网络）。 */
function greeting(): string {
  const h = new Date().getHours()
  if (h < 6) return '夜里也在忙'
  if (h < 11) return '早上好'
  if (h < 14) return '中午好'
  if (h < 18) return '下午好'
  return '晚上好'
}

/** 今天的中文日期，如「11 月 26 日 星期四」。 */
function todayText(): string {
  const d = new Date()
  const week = ['星期日', '星期一', '星期二', '星期三', '星期四', '星期五', '星期六'][d.getDay()]
  return `${d.getMonth() + 1} 月 ${d.getDate()} 日 ${week}`
}

/** 环比变化率：上月为 0 时返回 null（不编造百分比）。 */
function ratioVs(prev: number, cur: number): number | null {
  if (prev === 0) return null
  return (cur - prev) / Math.abs(prev)
}

export function BusinessDashboard({ refreshToken, onError, onGoTab }: BusinessDashboardProps): ReactElement {
  const [all, setAll] = useState<BusinessOverviewDTO | null>(null)
  const [month, setMonth] = useState<BusinessOverviewDTO | null>(null)
  const [trend, setTrend] = useState<TrendPointDTO[]>([])

  const load = useCallback(async () => {
    try {
      const [a, m, t] = await Promise.all([
        getBusinessOverview(),
        getBusinessOverview({ from: monthStartISO(), to: null }),
        getTrend(6),
      ])
      setAll(a)
      setMonth(m)
      setTrend(t)
    } catch (e) {
      onError(humanError(e))
    }
  }, [onError])

  useEffect(() => { void load() }, [load, refreshToken])

  if (!all || !month) return <Skeleton rows={3} tall />

  // 商品卡片按净销售额降序，同额按毛利降序
  const productCards = [...all.products].sort(
    (a, b) => b.net_sales_cents - a.net_sales_cents || b.gross_profit_cents - a.gross_profit_cents,
  )

  // 本月 vs 上月（趋势最后一格是本月，倒数第二格是上月）
  const cur = trend[trend.length - 1]
  const prev = trend[trend.length - 2]
  const monthDelta = prev ? ratioVs(prev.net_profit_cents, cur?.net_profit_cents ?? 0) : null

  const todayProfit = all.today.net_profit_cents

  return (
    <div className="mz-biz-dash">
      {/* ⓪ 欢迎区：克制的一句话 + 日期 + 今日状态，右侧只放两个抽象装饰圆 */}
      <header className="mz-dash-hero">
        <div className="mz-dash-hero-text">
          <h2 className="mz-dash-hero-title">{greeting()}</h2>
          <p className="mz-dash-hero-sub">
            {todayText()}
            <span className="mz-dash-hero-dot" aria-hidden="true">·</span>
            <span className={todayProfit >= 0 ? 'is-good' : 'is-bad'}>
              今日净利 {money(todayProfit)}
            </span>
          </p>
        </div>
        <div className="mz-dash-hero-art" aria-hidden="true">
          <span className="mz-dash-orb is-sage" />
          <span className="mz-dash-orb is-clay" />
          <span className="mz-dash-orb is-oat" />
        </div>
      </header>

      {/* ① 关键指标：今日 4 格 + 本月 4 格，数字递增、语义色区分 */}
      <section className="mz-biz-dash-section">
        <div className="mz-biz-dash-cols">
          <div className="mz-biz-dash-col">
            <div className="mz-dash-col-head">
              <h3 className="mz-biz-dash-title">今日</h3>
              <span className="mz-dash-col-meta">{all.today.order_count} 单</span>
            </div>
            <div className="mz-biz-dash-mini-grid">
              <MiniStat label="销售额" cents={all.today.sales_cents} tone="income" />
              <MiniStat label="毛利润" cents={all.today.gross_profit_cents} tone={all.today.gross_profit_cents >= 0 ? 'profit' : 'loss'} />
              <MiniStat label="支出" cents={all.today.expense_cents} tone="expense" />
              <MiniStat label="净利" cents={all.today.net_profit_cents} tone={all.today.net_profit_cents >= 0 ? 'profit' : 'loss'} />
            </div>
            <div className="mz-biz-dash-foot">退款 {money(all.today.refund_cents)}</div>
          </div>

          <div className="mz-biz-dash-col">
            <div className="mz-dash-col-head">
              <h3 className="mz-biz-dash-title">{monthLabel(currentMonth())}</h3>
              <span className="mz-dash-col-meta">{month.order_count} 单 · {month.sales_qty} 件</span>
            </div>
            <div className="mz-biz-dash-mini-grid">
              <MiniStat label="净销售额" cents={month.net_sales_cents} tone="income" />
              <MiniStat label="毛利润" cents={month.gross_profit_cents} tone={month.gross_profit_cents >= 0 ? 'profit' : 'loss'} />
              <MiniStat
                label="净利润"
                cents={month.net_profit_cents}
                tone={month.net_profit_cents >= 0 ? 'profit' : 'loss'}
                delta={monthDelta}
                deltaSuffix="较上月"
                goodWhenUp
              />
              <MiniStat label="毛利率" text={percent(month.gross_margin)} />
            </div>
            <div className="mz-biz-dash-foot">
              今日 {all.today.order_count} 单 · 本月累计 {month.order_count} 单
            </div>
          </div>
        </div>
      </section>

      {/* ② 趋势 */}
      <section className="mz-biz-dash-section">
        <div className="mz-dash-col-head">
          <h3 className="mz-biz-dash-title">近 6 月净利润趋势</h3>
          <span className="mz-dash-col-meta">单位：元</span>
        </div>
        <div className="mz-dash-chart-card">
          <LineChart
            points={trend.map((t) => ({
              label: t.month.slice(5),
              value: t.net_profit_cents,
              title: `${monthLabel(t.month)}：净利 ${money(t.net_profit_cents)}｜毛利 ${money(t.gross_profit_cents)}`,
            }))}
            format={money}
            height={160}
            color="var(--accent)"
          />
        </div>
        <div className="mz-biz-dash-trend-legend">
          {trend.map((t) => (
            <span key={t.month} className="mz-num">
              {t.month.slice(5)} 月 <b className={t.net_profit_cents >= 0 ? 'is-pos' : 'is-neg'}>{moneyCompact(t.net_profit_cents)}</b>
            </span>
          ))}
        </div>
      </section>

      {/* ③ 商品卡片 */}
      <section className="mz-biz-dash-section">
        <div className="mz-dash-col-head">
          <h3 className="mz-biz-dash-title">商品表现</h3>
          <span className="mz-dash-col-meta">{productCards.length} 个商品 · 全部时间</span>
        </div>
        <div className="mz-biz-dash-cards">
          {productCards.map((p) => (
            <div className="mz-biz-prod-card" key={p.product_id}>
              <div className="mz-biz-prod-card-head">
                <span className="mz-biz-prod-card-brand">{p.brand}</span>
                <span className="mz-biz-prod-card-name">{p.product_name}</span>
              </div>
              <div className="mz-biz-prod-card-main mz-num">{money(p.net_sales_cents)}</div>
              <div className="mz-biz-prod-card-sub">净销售额</div>
              <div className="mz-biz-prod-card-rows">
                <div>
                  <span>毛利</span>
                  <b className={`mz-num${p.gross_profit_cents < 0 ? ' is-neg' : ' is-pos'}`}>{money(p.gross_profit_cents)}</b>
                </div>
                <div>
                  <span>毛利率</span>
                  <b className="mz-num">{percent(p.gross_margin)}</b>
                </div>
                <div>
                  <span>销量</span>
                  <b className="mz-num">{p.sales_qty} 件</b>
                </div>
                <div>
                  <span>退款</span>
                  <b className="mz-num">{money(p.refund_cents)}</b>
                </div>
              </div>
            </div>
          ))}
        </div>
      </section>

      {/* ④ 快捷入口 */}
      <section className="mz-biz-dash-section">
        <div className="mz-dash-col-head">
          <h3 className="mz-biz-dash-title">快捷记账</h3>
          <span className="mz-dash-col-meta">点一下直接去记</span>
        </div>
        <div className="mz-biz-dash-quick">
          <QuickBtn label="销售记账" desc="按规格卖出一笔" icon={<IconSale />} tone="sage" onClick={() => onGoTab('sale')} />
          <QuickBtn label="进货记账" desc="补库存、算加权成本" icon={<IconCart />} tone="coffee" onClick={() => onGoTab('purchase')} />
          <QuickBtn label="退款记账" desc="关联订单或手动退" icon={<IconRefund />} tone="clay" onClick={() => onGoTab('refund')} />
          <QuickBtn label="客服收入" desc="独立于商品销售" icon={<IconChat />} tone="sage" onClick={() => onGoTab('cs')} />
          <QuickBtn label="经营支出" desc="平台/运营/人工" icon={<IconWallet />} tone="amber" onClick={() => onGoTab('expense')} />
          <QuickBtn label="商品规格" desc="改价、增删规格" icon={<IconBox />} tone="oat" onClick={() => onGoTab('products')} />
          <QuickBtn label="快捷模板" desc="常用记账存起来" icon={<IconBolt />} tone="sage" onClick={() => onGoTab('templates')} />
        </div>
      </section>
    </div>
  )
}

type MiniTone = 'income' | 'expense' | 'profit' | 'loss' | 'neutral'

function MiniStat({
  label, cents, text, tone = 'neutral', delta, deltaSuffix, goodWhenUp,
}: {
  label: string
  /** 金额（分）。与 text 二选一。 */
  cents?: number
  /** 非金额文本（如毛利率）。 */
  text?: string
  tone?: MiniTone
  /** 环比变化率（null = 不显示）。 */
  delta?: number | null
  deltaSuffix?: string
  goodWhenUp?: boolean
}): ReactElement {
  return (
    <div className={`mz-biz-mini is-${tone}`}>
      <span className="mz-biz-mini-label">{label}</span>
      <b className="mz-biz-mini-value mz-num">
        {cents !== undefined ? <CountUpMoney cents={cents} /> : text}
      </b>
      {delta !== undefined && (
        <DeltaBadge ratio={delta} goodWhenUp={goodWhenUp ?? true} suffix={deltaSuffix} />
      )}
    </div>
  )
}

function QuickBtn({ label, desc, icon, tone, onClick }: {
  label: string
  desc: string
  icon: ReactElement
  tone: 'sage' | 'coffee' | 'clay' | 'amber' | 'oat'
  onClick: () => void
}): ReactElement {
  return (
    <button type="button" className="mz-biz-quick-btn" data-tone={tone} onClick={onClick}>
      <span className="mz-biz-quick-icon" aria-hidden="true">{icon}</span>
      <span className="mz-biz-quick-text">
        <span className="mz-biz-quick-label">{label}</span>
        <span className="mz-biz-quick-desc">{desc}</span>
      </span>
    </button>
  )
}

/* ---------- 快捷入口线性图标（24×24，手写，风格统一） ---------- */
const ICON_BASE = {
  width: 20, height: 20, viewBox: '0 0 24 24', fill: 'none',
  stroke: 'currentColor', strokeWidth: 1.6,
  strokeLinecap: 'round' as const, strokeLinejoin: 'round' as const,
  'aria-hidden': true as const,
}

function IconSale(): ReactElement {
  return (
    <svg {...ICON_BASE}>
      <path d="M3 3v18h18" />
      <path d="M7 15l4-5 3 3 4-6" />
    </svg>
  )
}
function IconCart(): ReactElement {
  return (
    <svg {...ICON_BASE}>
      <circle cx="9" cy="20" r="1.4" />
      <circle cx="18" cy="20" r="1.4" />
      <path d="M2 3h3l2.4 12.1a2 2 0 0 0 2 1.6h8.2a2 2 0 0 0 2-1.6L21 7H6" />
    </svg>
  )
}
function IconRefund(): ReactElement {
  return (
    <svg {...ICON_BASE}>
      <path d="M3 12a9 9 0 1 0 3-6.7L3 8" />
      <path d="M3 3v5h5" />
    </svg>
  )
}
function IconChat(): ReactElement {
  return (
    <svg {...ICON_BASE}>
      <path d="M21 11.5a8.4 8.4 0 0 1-9 8.4 9 9 0 0 1-3.9-.9L3 21l1.9-4.6A8.4 8.4 0 0 1 12 3a8.4 8.4 0 0 1 9 8.5z" />
    </svg>
  )
}
function IconWallet(): ReactElement {
  return (
    <svg {...ICON_BASE}>
      <path d="M20 7H5a2 2 0 0 1 0-4h13v4" />
      <path d="M3 5v14a2 2 0 0 0 2 2h15v-5" />
      <path d="M18 12a2 2 0 0 0 0 4h4v-4Z" />
    </svg>
  )
}
function IconBox(): ReactElement {
  return (
    <svg {...ICON_BASE}>
      <path d="M21 8 12 3 3 8v8l9 5 9-5z" />
      <path d="M3 8l9 5 9-5" />
      <path d="M12 13v8" />
    </svg>
  )
}
function IconBolt(): ReactElement {
  return (
    <svg {...ICON_BASE}>
      <path d="M13 2 4.5 13.5H11l-1 8.5L19.5 10H13z" />
    </svg>
  )
}
