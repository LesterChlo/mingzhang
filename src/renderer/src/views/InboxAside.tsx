// 收件箱右栏：本月速览与轻量安全状态，详情和快照/备份经真实设置分页可达。

import type { ReactElement } from 'react'
import type { ReportCardData } from '../../../shared/types'
import { useInbox } from '../shell/inboxStore'
import { money, snapshotFreshness } from '../lib/shellFormat'
import '../styles/inbox-aside.css'

/** 本月聚合（来自 listLedger 的 agg，由 InboxView 传进来；右栏自己不重复打 IPC）。 */
export interface MonthAgg {
  expenseCents: number
  count: number
  byCategory: { category: string; cents: number; count: number }[]
}

const LOCK_ICON = (
  <svg
    width="14"
    height="14"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="1.5"
    strokeLinecap="round"
    strokeLinejoin="round"
    aria-hidden="true"
  >
    <rect x="3" y="11" width="18" height="11" rx="2" />
    <path d="M7 11V7a5 5 0 0 1 10 0v4" />
  </svg>
)

export function InboxAside({
  agg,
  month,
  lastReport,
  reportError,
  onOpenSettings,
}: {
  agg: MonthAgg | null
  month: string
  lastReport: ReportCardData | null
  reportError: string | null
  onOpenSettings: (tab: 'storage' | 'billing') => void
}): ReactElement {
  const { settings, snapshots, pendingCount } = useInbox()
  const lastSnap = snapshots[0]?.mtime ?? settings?.lastSnapshot?.mtime ?? null
  const fresh = snapshotFreshness(lastSnap)
  const topCats = (agg?.byCategory ?? []).slice(0, 3)
  const maxCat = topCats.reduce((m, c) => Math.max(m, c.cents), 0)
  // 预算：当月预算（设置）− 本月已确认支出。没有预算就整行不显示，不编。
  const budget = settings?.budgetCents ?? 0
  const remaining = agg && budget > 0 ? budget - agg.expenseCents : null

  return (
    <aside className="mz-aside" data-testid="inbox-aside">

      {/* ① 本月速览（本月口径 = listLedger 的 agg，与「今天已记」同一次查询，不额外打 IPC） */}
      <section className="mz-panel" data-testid="aside-report">
        <h3 className="mz-panel-title">本月速览</h3>
        <div className="mz-panel-month">{month}</div>
        <div className="mz-big mz-num" data-testid="aside-expense">
          {money(agg?.expenseCents ?? 0)}
        </div>
        <div className="mz-kv">
          <span>入账</span>
          <span className="mz-v mz-num">{agg?.count ?? 0} 笔</span>
        </div>
        <div className="mz-kv">
          <span>待决</span>
          <span className="mz-v mz-num" data-testid="aside-pending">
            {pendingCount} 项
          </span>
        </div>
        {remaining !== null && (
          <div className="mz-kv">
            <span>预算剩余</span>
            <span className={`mz-v mz-num${remaining < 0 ? ' mz-stale' : ''}`}>
              {money(remaining)}
            </span>
          </div>
        )}
        {topCats.length > 0 && (
          <div className="mz-mini-bars">
            {topCats.map((c) => {
              const pct = maxCat > 0 ? Math.round((c.cents / maxCat) * 100) : 0
              return (
                <div key={c.category} className="mz-mini-bar">
                  <span className="mz-mini-nm">{c.category}</span>
                  <span className="mz-mini-tr">
                    <span className="mz-mini-fl" style={{ width: `${pct}%` }} />
                  </span>
                  <span className="mz-mini-pc mz-num">{pct}%</span>
                </div>
              )
            })}
          </div>
        )}
        {/* 上月对照：latestReport() 天然是"上一个自然月"的月报，标题按它自己的 month 字段写，不冒充本月 */}
        <div className="mz-kv mz-kv-last">
          <span>{reportError ? '上月对照读取失败' : (lastReport?.month ?? '上月')}</span>
          <span className="mz-v mz-num" data-testid="aside-last-month">
            {reportError ? '—' : lastReport ? money(lastReport.totalExpenseCents) : '无数据'}
          </span>
        </div>
      </section>

      <section className="mz-aside-security" data-testid="aside-security">
        <div className="mz-aside-security-head">
          <span className="mz-lock-ico">{LOCK_ICON}</span>
          <span>账本本地加密</span>
          <span className={fresh.stale ? 'mz-stale' : 'mz-text-3'} data-testid="aside-snapshot">{fresh.text}</span>
        </div>
        <div className="mz-aside-links">
          <button type="button" data-testid="aside-data-settings" onClick={() => onOpenSettings('storage')}>数据与隐私 <span aria-hidden="true">↗</span></button>
          <button type="button" data-testid="aside-backup-settings" onClick={() => onOpenSettings('billing')}>快照与备份 <span aria-hidden="true">↗</span></button>
        </div>
      </section>
    </aside>
  )
}
