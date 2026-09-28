// 收件箱右栏三卡（§3.1 末节）：
//   ① 本月速览 → **本月**口径走 listLedger({month: 本月, state:'confirmed'}).agg
//                （真·本月已确认收支 + 分类 top3 + 预算剩余；预算额取 getSettingsInfo）
//                上月对照走 latestReport()——注意这条通道返回的是**上一个自然月**月报
//                （src/main/ipc.ts 用 previousMonth()），所以只当"上月"用，绝不冒充本月。
//   ② 本地数据 → getSettingsInfo() + listSnapshots()（锁标放大版 + 立即快照）
//   ③ AI 记忆  → 后端无此能力（规格 §6 第 4 条），做禁用占位，**不编造任何数字**
//
// 视觉数值全部走 tokens.css 的 var()，不新增自由配色。

import type { ReactElement } from 'react'
import type { ReportCardData } from '../../../shared/types'
import { useInbox } from '../shell/inboxStore'
import { money, shortPath, snapshotFreshness } from '../lib/shellFormat'

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
}: {
  agg: MonthAgg | null
  month: string
  lastReport: ReportCardData | null
  reportError: string | null
}): ReactElement {
  const { settings, snapshots, pendingCount, busy, runSnapshot } = useInbox()
  const lastSnap = snapshots[0]?.mtime ?? settings?.lastSnapshot?.mtime ?? null
  const fresh = snapshotFreshness(lastSnap)
  const topCats = (agg?.byCategory ?? []).slice(0, 3)
  const maxCat = topCats.reduce((m, c) => Math.max(m, c.cents), 0)
  // 预算：当月预算（设置）− 本月已确认支出。没有预算就整行不显示，不编。
  const budget = settings?.budgetCents ?? 0
  const remaining = agg && budget > 0 ? budget - agg.expenseCents : null

  return (
    <aside className="mz-aside" data-testid="inbox-aside">
      {/* ① 本地数据（§2.3 锁标的放大版） */}
      <section className="mz-panel" data-testid="aside-local">
        <h3 className="mz-panel-title">
          <span className="mz-lock-ico">{LOCK_ICON}</span>
          本地数据
        </h3>
        <div className="mz-safe-row">
          <span className="mz-lock-ico mz-lock-green">{LOCK_ICON}</span>
          <span>已加密 · 仅存在本机</span>
        </div>
        <div className="mz-kv">
          <span>数据目录</span>
          <span className="mz-v" title={settings?.dataDir ?? ''}>
            {shortPath(settings?.dataDir ?? '')}
          </span>
        </div>
        <div className="mz-kv">
          <span>上次快照</span>
          <span className={`mz-v mz-num${fresh.stale ? ' mz-stale' : ''}`} data-testid="aside-snapshot">
            {fresh.text}
          </span>
        </div>
        <div className="mz-actions">
          <button
            type="button"
            className="mz-btn mz-btn-ghost mz-btn-block"
            data-testid="aside-snapshot-btn"
            disabled={busy !== null}
            onClick={() => {
              void runSnapshot()
            }}
          >
            立即快照
          </button>
        </div>
      </section>

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

      {/* ③ AI 记忆：后端无此通道（规格 §6 第 4 条），如实占位，不填假数字 */}
      <section className="mz-panel mz-panel-disabled" data-testid="aside-memory">
        <h3 className="mz-panel-title">AI 记忆</h3>
        <div className="mz-panel-empty">待后端支持</div>
        <div className="mz-panel-hint">
          记忆条目读取 / 删除接口尚未提供（规格 §6 第 4 条），这里先留位置——不编造「已记住 N 条」。
        </div>
      </section>
    </aside>
  )
}
