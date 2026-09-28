// 账本屏（规格 §3.2）：筛选条 + 汇总行 + 流水表 + 行详情 + 三态。
//
// 铁律（本单硬约束）：
//   ① **筛选与分页一律走服务端**（listLedger 的 month/type/category/account/金额区间/state/q + limit/offset）——
//      前端绝不「先取一页再自己过滤」：那样 total 与 agg 都会撒谎。
//   ② **汇总数字只读 agg**（口径与筛选同源，由服务端算好）：N 笔 · 支出 / 收入 / 待确认。
//   ③ 不编数据：附件列只认 LedgerRow.attachmentRef（后端真字段）。
//   ④ 三态（§2.4 / §3.2 末节）：空账本 = 去记一笔；筛选无结果 = 清除筛选；加载 = 10 行骨架；出错 = 重试 + 快照提示。

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { ReactElement } from 'react'
import type { AccountOption, LedgerPageDTO, LedgerRow } from '../../../shared/types'
import { useInbox } from '../shell/inboxStore'
import {
  DEFAULT_FILTERS,
  PAGE_SIZE,
  STATE_LABELS,
  TYPE_LABELS,
  activeChips,
  amountClass,
  dateOf,
  humanError,
  money,
  removeChip,
  stateTone,
  toLedgerFilter,
  type FilterChip,
  type LedgerFilterState,
} from '../lib/ledgerFilter'
import { LedgerDetail } from './LedgerDetail'

const CLIP_ICON = (
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
    <path d="M21.44 11.05l-9.19 9.19a6 6 0 01-8.49-8.49l9.19-9.19a4 4 0 015.66 5.66l-9.2 9.19a2 2 0 01-2.83-2.83l8.49-8.48" />
  </svg>
)

/** 空态图标（§2.4：48px 线性，30% 透明度由 .mz-empty svg 统一施加）。 */
const LEDGER_ICON = (
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
    <path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20" />
    <path d="M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2z" />
  </svg>
)

/**
 * initialFilter：进入本屏时**先**落下的筛选条件（可选项，默认 undefined = 默认视图）。
 * 唯一用途：批次结果条的主按钮带 needs_review 跳过来，让用户一落地就看见那批待分类的账。
 * 落进初始状态后与用户手动筛选完全同源——筛选条、分页、agg 口径一概不动。
 */
export function LedgerView({ initialFilter }: { initialFilter?: Partial<LedgerFilterState> } = {}): ReactElement {
  const { categories, notify } = useInbox()
  const [filters, setFilters] = useState<LedgerFilterState>(() => ({ ...DEFAULT_FILTERS, ...initialFilter }))
  const [page, setPage] = useState(1)
  const [data, setData] = useState<LedgerPageDTO | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  /** 全库（不加筛选）总笔数：用来区分「空账本」（真没有账目）与「筛选无结果」。 */
  const [allTotal, setAllTotal] = useState<number | null>(null)
  const [selectedId, setSelectedId] = useState<number | null>(null)
  /** 关键词 / 金额输入的本地态（防抖后再进 filters，避免每个字符打一次 IPC）。 */
  const [qDraft, setQDraft] = useState('')
  const [minDraft, setMinDraft] = useState('')
  const [maxDraft, setMaxDraft] = useState('')
  const [accounts, setAccounts] = useState<AccountOption[]>([])
  const [reloadKey, setReloadKey] = useState(0)
  const debounce = useRef<{ q: number | null; amount: number | null }>({ q: null, amount: null })

  const reload = useCallback(() => setReloadKey((k) => k + 1), [])

  /** 筛选变化 → 回第 1 页。 */
  const patch = useCallback((p: Partial<LedgerFilterState>) => {
    setFilters((f) => ({ ...f, ...p }))
    setPage(1)
  }, [])

  const clearAll = useCallback(() => {
    setFilters(DEFAULT_FILTERS)
    setQDraft('')
    setMinDraft('')
    setMaxDraft('')
    setPage(1)
  }, [])

  const onRemoveChip = useCallback((key: FilterChip['key']) => {
    setFilters((f) => removeChip(f, key))
    if (key === 'q') setQDraft('')
    if (key === 'amount') {
      setMinDraft('')
      setMaxDraft('')
    }
    setPage(1)
  }, [])

  // 服务端查询：筛选 + 分页原样交给 listLedger
  useEffect(() => {
    let cancelled = false
    setLoading(true)
    void window.mz
      .listLedger(toLedgerFilter(filters, page))
      .then((r) => {
        if (cancelled) return
        setData(r)
        setError(null)
      })
      .catch((e) => {
        if (cancelled) return
        setError(humanError(e))
        setData(null)
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [filters, page, reloadKey])

  // 全库总笔数（无筛选探针）：区分空账本与筛选无结果；也随任何改动刷新
  useEffect(() => {
    let cancelled = false
    void window.mz
      .listLedger({ limit: 1 })
      .then((r) => {
        if (!cancelled) setAllTotal(r.total)
      })
      .catch(() => {
        if (!cancelled) setAllTotal(null)
      })
    return () => {
      cancelled = true
    }
  }, [reloadKey, filters, page])

  // 账户下拉：listAccounts（真实通道；不含余额——accounts 表无期初余额列）
  useEffect(() => {
    void window.mz
      .listAccounts()
      .then(setAccounts)
      .catch(() => setAccounts([]))
  }, [reloadKey])

  // 其他屏/对话改动了账本 → 表格跟上（与收件箱同一套事件源）
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

  // 关键词 / 金额区间：300ms 防抖（其余筛选即时生效）
  useEffect(() => {
    if (debounce.current.q) window.clearTimeout(debounce.current.q)
    debounce.current.q = window.setTimeout(() => {
      setFilters((f) => (f.q === qDraft.trim() ? f : { ...f, q: qDraft }))
    }, 300)
    return () => {
      if (debounce.current.q) window.clearTimeout(debounce.current.q)
    }
  }, [qDraft])

  useEffect(() => {
    if (debounce.current.amount) window.clearTimeout(debounce.current.amount)
    debounce.current.amount = window.setTimeout(() => {
      setFilters((f) =>
        f.amountMin === minDraft && f.amountMax === maxDraft ? f : { ...f, amountMin: minDraft, amountMax: maxDraft },
      )
      setPage(1)
    }, 300)
    return () => {
      if (debounce.current.amount) window.clearTimeout(debounce.current.amount)
    }
  }, [minDraft, maxDraft])

  const items = data?.items ?? []
  const total = data?.total ?? 0
  const pageCount = Math.max(1, Math.ceil(total / PAGE_SIZE))

  // 删除/恢复后当前页被抽空 → 退回最后一页（不留空页）
  useEffect(() => {
    if (!loading && page > pageCount) setPage(pageCount)
  }, [loading, page, pageCount])

  const chips = useMemo(() => activeChips(filters), [filters])
  const agg = data?.agg ?? null
  const selected = selectedId != null ? (items.find((r) => r.id === selectedId) ?? null) : null

  const focusCapture = useCallback(() => {
    const el = document.querySelector('input[aria-label="速记行"]')
    if (el instanceof HTMLInputElement) el.focus()
  }, [])

  const showSkeleton = loading && !data
  const isEmptyLedger = !loading && !error && total === 0 && allTotal === 0 && chips.length === 0
  const isNoResult = !loading && !error && total === 0 && !isEmptyLedger

  return (
    <div className="mz-ledger" data-testid="ledger-view">
      <section className="mz-ledger-main">
        {/* ---------- 筛选条（§3.2）：全部条件走服务端 ---------- */}
        <div className="mz-filterbar" data-testid="ledger-filterbar">
          <label className="mz-filter">
            <span className="mz-field-lb">时间</span>
            <select
              className="mz-select"
              aria-label="时间范围"
              data-testid="ledger-f-month"
              value={filters.range}
              onChange={(e) => patch({ range: e.target.value as LedgerFilterState['range'] })}
            >
              <option value="all">全部</option>
              <option value="thisMonth">本月</option>
              <option value="lastMonth">上月</option>
              <option value="custom">自定义月份</option>
            </select>
          </label>

          {filters.range === 'custom' && (
            <label className="mz-filter">
              <span className="mz-field-lb">月份</span>
              <input
                className="mz-input mz-input-sm mz-num"
                aria-label="自定义月份"
                data-testid="ledger-f-month-custom"
                placeholder="2026-09"
                value={filters.customMonth}
                onChange={(e) => patch({ customMonth: e.target.value })}
              />
            </label>
          )}

          <label className="mz-filter">
            <span className="mz-field-lb">类型</span>
            <select
              className="mz-select"
              aria-label="类型"
              data-testid="ledger-f-type"
              value={filters.type}
              onChange={(e) => patch({ type: e.target.value })}
            >
              <option value="">全部</option>
              {Object.entries(TYPE_LABELS).map(([v, label]) => (
                <option key={v} value={v}>
                  {label}
                </option>
              ))}
            </select>
          </label>

          <label className="mz-filter">
            <span className="mz-field-lb">分类</span>
            <select
              className="mz-select"
              aria-label="分类"
              data-testid="ledger-f-category"
              value={filters.category}
              onChange={(e) => patch({ category: e.target.value })}
            >
              <option value="">全部</option>
              {[...new Set(categories.map((c) => c.name))].map((name) => (
                <option key={name} value={name}>
                  {name}
                </option>
              ))}
            </select>
          </label>

          <label className="mz-filter">
            <span className="mz-field-lb">账户</span>
            <select
              className="mz-select"
              aria-label="账户"
              data-testid="ledger-f-account"
              value={filters.account}
              onChange={(e) => patch({ account: e.target.value })}
            >
              <option value="">全部</option>
              {accounts.map((a) => (
                <option key={a.id} value={a.name}>
                  {a.name}
                </option>
              ))}
            </select>
          </label>

          <label className="mz-filter">
            <span className="mz-field-lb">金额</span>
            <span className="mz-range">
              <input
                className="mz-input mz-input-sm mz-num"
                aria-label="金额下限"
                data-testid="ledger-f-amount-min"
                placeholder="下限"
                value={minDraft}
                onChange={(e) => setMinDraft(e.target.value)}
              />
              <span className="mz-text-3">~</span>
              <input
                className="mz-input mz-input-sm mz-num"
                aria-label="金额上限"
                data-testid="ledger-f-amount-max"
                placeholder="上限"
                value={maxDraft}
                onChange={(e) => setMaxDraft(e.target.value)}
              />
            </span>
          </label>

          <label className="mz-filter">
            <span className="mz-field-lb">状态</span>
            <select
              className="mz-select"
              aria-label="状态"
              data-testid="ledger-f-state"
              value={filters.state}
              onChange={(e) => patch({ state: e.target.value })}
            >
              <option value="">全部</option>
              <option value="confirmed">{STATE_LABELS.confirmed}</option>
              <option value="needs_review">{STATE_LABELS.needs_review}</option>
              <option value="deleted">{STATE_LABELS.deleted}</option>
            </select>
          </label>

          <label className="mz-filter mz-filter-grow">
            <span className="mz-field-lb">关键词</span>
            <input
              className="mz-input mz-input-sm"
              aria-label="关键词"
              data-testid="ledger-f-q"
              placeholder="商户 / 备注 / 分类"
              value={qDraft}
              onChange={(e) => setQDraft(e.target.value)}
            />
          </label>
        </div>

        {/* ---------- 生效筛选 chips（可单个移除 / 清除全部） ---------- */}
        <div className="mz-chips" data-testid="ledger-chips">
          {chips.length === 0 ? (
            <span className="mz-text-3 mz-chips-empty">默认视图：状态=正常 · 无其他筛选</span>
          ) : (
            <>
              {chips.map((c) => (
                <span key={c.key} className="mz-chip" data-testid={`ledger-chip-${c.key}`}>
                  <span className="mz-num">{c.label}</span>
                  <button
                    type="button"
                    className="mz-chip-x"
                    aria-label={`移除筛选：${c.label}`}
                    data-testid={`ledger-chip-x-${c.key}`}
                    onClick={() => onRemoveChip(c.key)}
                  >
                    ✕
                  </button>
                </span>
              ))}
              <button
                type="button"
                className="mz-btn mz-btn-ghost mz-btn-sm"
                data-testid="ledger-clear-all"
                onClick={clearAll}
              >
                清除全部
              </button>
            </>
          )}
        </div>

        {/* ---------- 汇总行：数值只来自 agg ---------- */}
        <div className="mz-aggbar" data-testid="ledger-agg">
          <span className="mz-num" data-testid="ledger-agg-count">
            {agg?.count ?? 0} 笔
          </span>
          <span className="mz-agg-sep">·</span>
          支出{' '}
          <span className="mz-num" data-testid="ledger-agg-expense">
            {money(agg?.expenseCents ?? 0)}
          </span>
          <span className="mz-agg-sep">·</span>
          收入{' '}
          <span className="mz-num mz-amt-income" data-testid="ledger-agg-income">
            {money(agg?.incomeCents ?? 0)}
          </span>
          <span className="mz-agg-sep">·</span>
          待确认{' '}
          <span className="mz-num" data-testid="ledger-agg-review">
            {agg?.reviewCount ?? 0} 笔
          </span>
          {agg?.month && <span className="mz-text-3">（口径：{agg.month}）</span>}
          <span className="mz-text-3">
            （口径不含已删除
            {filters.state ? '；且服务端 agg 暂不跟随「状态」筛选，故可能大于下方行数' : ''}）
          </span>
        </div>

        {error && (
          <div className="mz-error-card" data-testid="ledger-error" role="alert">
            <div className="mz-error-title">账本读取失败：{error}</div>
            <div className="mz-error-sub">数据不受影响，可从快照恢复</div>
            <div className="mz-actions">
              <button type="button" className="mz-btn mz-btn-primary" data-testid="ledger-retry" onClick={reload}>
                重试
              </button>
            </div>
          </div>
        )}

        {showSkeleton && (
          <div className="mz-rows mz-rows-skel" data-testid="ledger-loading" aria-busy="true" aria-label="正在读取账本">
            {Array.from({ length: 10 }).map((_, i) => (
              <div key={i} className="mz-row-skel">
                <div className="mz-skel" style={{ width: 76, height: 12 }} />
                <div className="mz-skel" style={{ flex: 1, height: 12 }} />
                <div className="mz-skel" style={{ width: 64, height: 12 }} />
                <div className="mz-skel" style={{ width: 72, height: 12 }} />
                <div className="mz-skel" style={{ width: 88, height: 12 }} />
              </div>
            ))}
          </div>
        )}

        {isEmptyLedger && (
          <div className="mz-empty" data-testid="ledger-empty">
            {LEDGER_ICON}
            <div className="mz-empty-title">还没有账目</div>
            <div className="mz-empty-hint">记第一笔吧 —— 说一句，或把截图拖进上面的输入行</div>
            <button
              type="button"
              className="mz-btn mz-btn-primary"
              data-testid="ledger-empty-cta"
              onClick={focusCapture}
            >
              记一笔
            </button>
          </div>
        )}

        {isNoResult && (
          <div className="mz-empty" data-testid="ledger-noresult">
            {LEDGER_ICON}
            <div className="mz-empty-title">没有符合条件的账目</div>
            <div className="mz-empty-hint">
              {chips.length > 0 ? `当前有 ${chips.length} 个筛选条件` : '换个条件再试'}
            </div>
            <button
              type="button"
              className="mz-btn mz-btn-primary"
              data-testid="ledger-noresult-clear"
              onClick={clearAll}
            >
              清除筛选
            </button>
          </div>
        )}

        {!showSkeleton && !error && items.length > 0 && (
          <div className="mz-tablewrap">
            <table className="mz-table" data-testid="ledger-table">
              <thead>
                <tr>
                  <th className="mz-th-date">日期</th>
                  <th>说明</th>
                  <th className="mz-th-cat">分类</th>
                  <th className="mz-th-acc">账户</th>
                  <th className="mz-th-amount">金额</th>
                  <th className="mz-th-state">状态</th>
                  <th className="mz-th-clip" title="来源附件">
                    <span className="mz-clip">{CLIP_ICON}</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {items.map((row) => (
                  <LedgerTableRow
                    key={row.id}
                    row={row}
                    selected={row.id === selectedId}
                    onSelect={() => setSelectedId(row.id)}
                  />
                ))}
              </tbody>
            </table>
          </div>
        )}

        {!showSkeleton && !error && total > 0 && (
          <div className="mz-pager" data-testid="ledger-pager">
            <span className="mz-text-3 mz-num" data-testid="ledger-page-info">
              共 {total} 笔 · 第 {page} / {pageCount} 页（每页 {PAGE_SIZE}）
            </span>
            <span className="mz-pager-btns">
              <button
                type="button"
                className="mz-btn mz-btn-ghost mz-btn-sm"
                data-testid="ledger-prev"
                disabled={page <= 1}
                onClick={() => setPage((p) => Math.max(1, p - 1))}
              >
                上一页
              </button>
              <button
                type="button"
                className="mz-btn mz-btn-ghost mz-btn-sm"
                data-testid="ledger-next"
                disabled={page >= pageCount}
                onClick={() => setPage((p) => Math.min(pageCount, p + 1))}
              >
                下一页
              </button>
            </span>
          </div>
        )}
      </section>

      {selected && (
        <LedgerDetail
          txId={selected.id}
          onChanged={reload}
          onClose={() => setSelectedId(null)}
          onNotice={(text, tone) => notify({ text, tone })}
        />
      )}
    </div>
  )
}

/** 单行：整行可选中（右栏详情跟着走）；📎 只认后端 attachmentRef。 */
function LedgerTableRow({
  row,
  selected,
  onSelect,
}: {
  row: LedgerRow
  selected: boolean
  onSelect: () => void
}): ReactElement {
  const hasAttachment = Boolean(row.attachmentRef)
  return (
    <tr
      className={`mz-tr${selected ? ' is-selected' : ''}`}
      data-testid="ledger-row"
      data-id={row.id}
      data-state={row.state}
      data-type={row.type}
      aria-selected={selected}
      tabIndex={0}
      onClick={onSelect}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault()
          onSelect()
        }
      }}
    >
      <td className="mz-td-date mz-num">{dateOf(row.occurredAt)}</td>
      <td className="mz-td-note" title={row.merchant ?? ''}>
        {row.merchant ?? <span className="mz-text-3">未命名</span>}
      </td>
      <td className="mz-td-cat">{row.categoryName ?? <span className="mz-text-3">未分类</span>}</td>
      <td className="mz-td-acc">{row.accountName ?? <span className="mz-text-3">—</span>}</td>
      <td className={`mz-td-amount mz-num ${amountClass(row.type)}`} data-testid="ledger-cell-amount">
        {row.type === 'transfer' && <span className="mz-transfer-mark">⇄ </span>}
        {money(row.amountCents)}
      </td>
      <td className="mz-td-state">
        <span className={`mz-tag mz-tag-${stateTone(row.state)}`} data-testid="ledger-cell-state">
          {STATE_LABELS[row.state] ?? row.state}
        </span>
      </td>
      <td className="mz-td-clip" data-testid="ledger-cell-clip">
        {hasAttachment ? (
          <span className="mz-clip mz-clip-on" title={row.attachmentRef ?? ''}>
            {CLIP_ICON}
          </span>
        ) : null}
      </td>
    </tr>
  )
}

