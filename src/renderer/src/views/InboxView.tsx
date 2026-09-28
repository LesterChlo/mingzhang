// 收件箱主屏（§3.1）：待决卡片队列 + 右栏三卡 + 今天已记折叠条。
//
// 三态（§2.4 / §3.1 末节）：加载 = 4 张卡片骨架（不用全屏转圈）；
// 出错 = 顶部红边卡 + [重试] + 快照恢复提示；空态 = 图标 + 主文案 + 引导 + [查看本月报告]。
// 数据全部来自 inboxStore（唯一待决源），左栏角标与这里同源。

import { useCallback, useEffect, useState } from 'react'
import type { ReactElement } from 'react'
import type { ReportCardData } from '../../../shared/types'
import { useInbox } from '../shell/inboxStore'
import { localDay, localMonth, money, relTime } from '../lib/shellFormat'
import { QueueCard } from './QueueCard'
import { InboxAside, type MonthAgg } from './InboxAside'
import { BatchResultBar } from './BatchResultBar'

/** 本月口径下的「今天已记」：只取今天这一天的已确认账目。 */
interface TodaySummary {
  count: number
  cents: number
  rows: { text: string; cents: number }[]
}

export function InboxView({
  onGoReport,
  onGoLedger,
  onGoHandle,
}: {
  onGoReport?: () => void
  /** 结果条次级链接：带 needs_review 筛选跳账本（筛选条件由 AppShell 组装）。 */
  onGoLedger?: () => void
  /** 结果条主按钮：开面板并自动发出归类指令（②B G-03）。 */
  onGoHandle?: () => void
}): ReactElement {
  const {
    items,
    pendingCount,
    loading,
    error,
    inflight,
    progress,
    refresh,
    refreshBatchResult,
    batchResult,
    dismissBatchResult,
  } = useInbox()
  const [expanded, setExpanded] = useState(false)
  const [agg, setAgg] = useState<MonthAgg | null>(null)
  const [lastReport, setLastReport] = useState<ReportCardData | null>(null)
  const [reportError, setReportError] = useState<string | null>(null)
  const [today, setToday] = useState<TodaySummary | null>(null)
  const month = localMonth()

  // 右栏① 本月口径 + 底部「今天已记」：一次 listLedger 同时算出两者（不额外打 IPC）。
  // latestReport() 返回的是**上一个自然月**月报，只作"上月对照"用（见 InboxAside 注释）。
  const loadSide = useCallback(async () => {
    const [page, rep] = await Promise.all([
      window.mz.listLedger({ month, state: 'confirmed', limit: 500 }).catch(() => null),
      window.mz.latestReport().catch((e: Error) => {
        setReportError(e.message)
        return null
      }),
    ])
    if (rep) setReportError(null)
    setLastReport(rep)
    if (page) {
      setAgg({
        expenseCents: page.agg.expenseCents,
        count: page.agg.count,
        byCategory: page.agg.byCategory,
      })
      const day = localDay()
      const rows = page.items
        .filter((r) => r.occurredAt.slice(0, 10) === day)
        .map((r) => ({
          text: [r.merchant ?? '未命名', r.categoryName, r.accountName].filter(Boolean).join(' · '),
          cents: r.amountCents,
        }))
      setToday({ count: rows.length, cents: rows.reduce((s, r) => s + r.cents, 0), rows })
    }
  }, [month])

  // items 的引用每次 refresh 都会换 → 任何入账/确认/取消都会带动右栏与今天已记重算
  useEffect(() => {
    void loadSide()
  }, [loadSide, items, pendingCount])

  // 进入收件箱时按批次读回一次（D-03a ①）：切屏往返、应用重载后都靠这条把事实找回来。
  // 账本里改分类那条路径（editTx）不发引擎事件，所以这里必须自己问一次后端。
  useEffect(() => {
    void refreshBatchResult()
  }, [refreshBatchResult])

  const showSkeleton = loading && items.length === 0
  const showEmpty = !loading && !error && items.length === 0 && !inflight

  return (
    <div className="mz-inbox" data-testid="inbox-view">
      <section className="mz-queue">
        {/* K3 G 组事实条：批次入账后驻留在队列之上，把「刚才那批发生了什么」说清楚 */}
        {batchResult && (
          <BatchResultBar
            summary={batchResult}
            onGoLedger={() => onGoLedger?.()}
            onGoHandle={() => onGoHandle?.()}
            onDismiss={dismissBatchResult}
          />
        )}

        {error && (
          <div className="mz-error-card" data-testid="inbox-error" role="alert">
            <div className="mz-error-title">待决列表读取失败：{error}</div>
            <div className="mz-error-sub">数据不受影响，可从快照恢复</div>
            <div className="mz-actions">
              <button type="button" className="mz-btn mz-btn-primary" onClick={() => void refresh()}>
                重试
              </button>
            </div>
          </div>
        )}

        {/* §3.1 第 5 类：解析中（灰点 + 骨架 + 原文），由速记行提交驱动 */}
        {inflight && (
          <div className="mz-card" data-testid="inbox-parsing">
            <div className="mz-card-head">
              <span className="mz-dot mz-dot-gray" />
              <span className="mz-card-kind">待解析</span>
              <time>{relTime(new Date(inflight.at).toISOString())}</time>
            </div>
            <div className="mz-skel mz-skel-block" style={{ width: '45%', height: 16 }} />
            <div className="mz-parsing" data-testid="inbox-parsing-text">
              <span className="mz-spinner" aria-hidden="true" />
              {progress || '解析中…'}
              {inflight.text ? `「${inflight.text}」` : ''}
              {inflight.images > 0 ? ` · ${inflight.images} 张图` : ''}
            </div>
          </div>
        )}

        {showSkeleton && (
          <div data-testid="inbox-loading" aria-busy="true" aria-label="正在读取待决列表">
            {[0, 1, 2, 3].map((i) => (
              <div key={i} className="mz-card">
                <div className="mz-card-head">
                  <div className="mz-skel mz-skel-line" style={{ width: 96, height: 12 }} />
                </div>
                <div className="mz-skel mz-skel-block" style={{ width: '45%', height: 16 }} />
                <div className="mz-skel mz-skel-line" style={{ width: '68%', height: 12, marginTop: 8 }} />
              </div>
            ))}
          </div>
        )}

        {showEmpty && (
          <div className="mz-empty" data-testid="inbox-empty">
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
              <path d="M22 12h-6l-2 3h-4l-2-3H2" />
              <path d="M5.45 5.11 2 12v6a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-6l-3.45-6.89A2 2 0 0 0 16.76 4H7.24a2 2 0 0 0-1.79 1.11z" />
            </svg>
            <div className="mz-empty-title">收件箱是空的</div>
            <div className="mz-empty-hint">说一句，或把截图拖进上面的输入行</div>
            {onGoReport && (
              <button type="button" className="mz-btn mz-btn-primary" onClick={onGoReport}>
                查看本月报告
              </button>
            )}
          </div>
        )}

        {items.map((item) => (
          <QueueCard key={`${item.gateId}-${item.field}`} item={item} />
        ))}

        {/* §3.1 底部「今天已记」折叠条，默认折叠 */}
        {today && (
          <div className="mz-today" data-testid="inbox-today">
            <button
              type="button"
              className="mz-today-bar"
              aria-expanded={expanded}
              onClick={() => setExpanded((v) => !v)}
            >
              <span className={`mz-chev${expanded ? ' is-open' : ''}`} aria-hidden="true">
                ▸
              </span>
              今天已记 {today.count} 笔
              <span className="mz-num mz-today-sum">{money(today.cents)}</span>
            </button>
            {expanded && (
              <div className="mz-today-list" data-testid="inbox-today-list">
                {today.rows.length === 0 ? (
                  <div className="mz-today-row">今天还没有已入账的账目</div>
                ) : (
                  today.rows.map((r, i) => (
                    <div key={i} className="mz-today-row">
                      <span>{r.text}</span>
                      <span className="mz-num">{money(r.cents)}</span>
                    </div>
                  ))
                )}
              </div>
            )}
          </div>
        )}
      </section>

      <InboxAside agg={agg} month={month} lastReport={lastReport} reportError={reportError} />
    </div>
  )
}
