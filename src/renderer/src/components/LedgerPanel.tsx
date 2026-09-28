// 账本页（第 3 单：对照 legacy/frontend/src/components/LedgerView.tsx 还原——直接对照，不重画）。
// 顶部汇总卡 + 分类构成条 + 复盘面板 + 页内待收尾区块 + 搜索/分页表格 + 审计抽屉（人话化 diff）。
// 数据全部走现有 IPC；筛选、审计时间线等既有行为保留。

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type {
  LedgerAgg,
  LedgerFilter,
  LedgerPageDTO,
  LedgerRow,
  PendingItemDTO,
  SessionArchiveDTO,
  TxDetailDTO,
  TxEditOp,
} from '../../../shared/types'

function yuan(cents: number): string {
  return (cents / 100).toFixed(2)
}

const STATE_LABEL: Record<string, string> = {
  raw_input: '待解析',
  parsed: '已解析',
  needs_review: '待确认',
  confirmed: '已确认',
  deleted: '已删除',
}

const TYPE_LABEL: Record<string, string> = {
  expense: '支出',
  income: '收入',
  transfer: '转账',
  adjustment: '调整',
}

const CHANGE_LABEL: Record<string, string> = {
  create: '创建',
  parse: '解析',
  auto_confirm: '自动确认',
  request_review: '转待确认',
  confirm: '确认',
  update: '更新',
  delete: '删除',
  restore: '恢复',
}

const BY_LABEL: Record<string, string> = {
  user: '用户',
  llm: 'AI',
  rule_engine: '规则引擎',
  import: '导入',
}

const AUDIT_FIELD: Record<string, string> = {
  amount_cents: '金额',
  state: '状态',
  category_id: '分类',
  type: '类型',
  merchant: '商户',
  occurred_at: '发生时间',
  account_id: '账户',
  to_account_id: '转入账户',
  note: '备注',
}

/** 分类色板：按名字稳定取色（同一分类在哪一页都同色），12 色缓解撞色（legacy 口径） */
const CATEGORY_COLORS = [
  '#3DA57F', '#4F8CFF', '#D99413', '#E05C5C', '#8B6FF0', '#14B8A6',
  '#2F7FD0', '#2FA36B', '#C2701D', '#D4697A', '#6B8AF0', '#0EA5B7',
]

function colorFor(name?: string | null): string {
  if (!name) return '#9AA5A0'
  let h = 0
  for (const ch of name) h = (h * 31 + ch.charCodeAt(0)) >>> 0
  return CATEGORY_COLORS[h % CATEGORY_COLORS.length]
}

type ShareRow = { name: string; cents: number; count: number }

/** 分类占比条 + 图例（月报复盘与"当前筛选构成"共用，legacy CategoryShare） */
function CategoryShare({ rows, total, caption }: { rows: ShareRow[]; total: number; caption?: string }) {
  if (rows.length === 0) return null
  return (
    <div className="share">
      {caption && <div className="metric-label">{caption}</div>}
      <div className="bar" role="img" aria-label="分类占比">
        {rows.map((r) => (
          <span
            key={r.name}
            className="bar-seg"
            style={{
              width: `${Math.max(2, (r.cents / Math.max(total, 1)) * 100)}%`,
              background: colorFor(r.name),
            }}
            title={`${r.name} ¥${yuan(r.cents)}`}
          />
        ))}
      </div>
      <ul className="legend">
        {rows.map((r) => (
          <li key={r.name}>
            <span className="dot" style={{ background: colorFor(r.name) }} />
            {r.name}
            <span className="num">¥{yuan(r.cents)}</span>
            <span className="muted">
              {Math.round((r.cents / Math.max(total, 1)) * 100)}%
              {r.count ? ` · ${r.count} 笔` : ''}
            </span>
          </li>
        ))}
      </ul>
    </div>
  )
}

/** 审计 before/after 人话化（legacy AuditDiff；此前是裸 JSON，最难读的一块） */
function AuditDiff({
  before,
  after,
  categories,
}: {
  before: Record<string, unknown> | null
  after: Record<string, unknown> | null
  categories: Record<number, string>
}) {
  const keys = Array.from(new Set([...Object.keys(before ?? {}), ...Object.keys(after ?? {})]))
  const changed = keys.filter((k) => JSON.stringify(before?.[k]) !== JSON.stringify(after?.[k]))
  if (changed.length === 0) return null
  const fmt = (k: string, v: unknown): string => {
    if (v === null || v === undefined) return '—'
    if (k === 'amount_cents') return `¥${(Number(v) / 100).toFixed(2)}`
    if (k === 'state') return STATE_LABEL[String(v)] ?? String(v)
    if (k === 'type') return TYPE_LABEL[String(v)] ?? String(v)
    if (k === 'category_id') return categories[Number(v)] ?? `#${v}`
    return String(v)
  }
  return (
    <div className="diff">
      {changed.map((k) => (
        <div className="diff-row" key={k}>
          <span className="diff-key">{AUDIT_FIELD[k] ?? k}</span>
          <span className="diff-before">{fmt(k, before?.[k])}</span>
          <span className="arrow">→</span>
          <span className="diff-after">{fmt(k, after?.[k])}</span>
        </div>
      ))}
    </div>
  )
}

/** 复盘面板（legacy ReportPanel）：数据全部来自后端聚合，取不到就整块不显示——不编造 */
function ReportPanel({ report }: { report: NonNullable<Awaited<ReturnType<typeof window.mz.latestReport>>> }) {
  if (report.empty) return null
  const top = report.topCategories
  const total = report.totalExpenseCents
  const cmp = report.compare
  return (
    <section className="report">
      <div className="report-head">
        <h3>月报 · {report.month}</h3>
        <span className="muted">最近一份月报（后端聚合，只含已确认收支）；想看某个月就在对话里说「X 月月报」</span>
      </div>
      <div className="report-figures">
        <div>
          <div className="metric-label">支出</div>
          <div className="metric-value expense">¥{yuan(total)}</div>
        </div>
        <div>
          <div className="metric-label">收入</div>
          <div className="metric-value income">¥{yuan(report.totalIncomeCents)}</div>
        </div>
        <div>
          <div className="metric-label">笔数（支出 / 收入）</div>
          <div className="metric-value">
            {report.countExpense} / {report.countIncome}
          </div>
        </div>
        <div>
          <div className="metric-label">环比 {cmp.hasData ? cmp.month : '—'}</div>
          <div className={`metric-value ${cmp.hasData ? (cmp.deltaCents > 0 ? 'income' : 'expense') : ''}`}>
            {cmp.hasData
              ? `${cmp.deltaCents > 0 ? '多' : '少'} ¥${yuan(Math.abs(cmp.deltaCents))}`
              : '上月无数据'}
          </div>
        </div>
      </div>
      <CategoryShare rows={top.map((c) => ({ name: c.category, cents: c.totalCents, count: c.count }))} total={total} />
      {report.budgetCents !== null && report.budgetRemainingCents !== null && (
        <p className="muted">
          预算 ¥{yuan(report.budgetCents)} · 剩余{' '}
          <span className={report.budgetRemainingCents < 0 ? 'over' : ''}>¥{yuan(report.budgetRemainingCents)}</span>
        </p>
      )}
    </section>
  )
}

function currentMonth(): string {
  const now = new Date()
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`
}

function shiftMonth(month: string, delta: number): string {
  const [y, m] = month.split('-').map(Number)
  if (!y || !m) return currentMonth()
  const d = new Date(y, m - 1 + delta, 1)
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`
}

const PAGE_SIZE = 50

const EMPTY_AGG: LedgerAgg = {
  month: null,
  count: 0,
  expenseCents: 0,
  incomeCents: 0,
  reviewCount: 0,
  reviewExpenseCents: 0,
  byCategory: [],
}

/** 月份输入规范化：'2026-9'→'2026-09'（补 0）；''=全部月份；其余为非法（红边提示，不发查询伪装成 0）。 */
function normalizeMonth(input: string): { month: string; valid: boolean } {
  const v = input.trim()
  if (v === '') return { month: '', valid: true }
  const m = /^(\d{4})-(\d{1,2})$/.exec(v)
  if (!m) return { month: v, valid: false }
  const mm = Number(m[2])
  if (mm < 1 || mm > 12) return { month: v, valid: false }
  return { month: `${m[1]}-${String(mm).padStart(2, '0')}`, valid: true }
}

export function LedgerPanel({
  pendingItems,
  categories,
  onExecuted,
  onOpenPending,
  focusMonth,
  onFocusHandled,
  focusTxId,
  onFocusTxHandled,
  dataEpoch = 0,
  highlightIds,
}: {
  pendingItems: PendingItemDTO[]
  categories: { id: number; name: string; kind: string }[]
  onExecuted: () => void
  /** 第 6 单 段3-1：账本区块降级为摘要，"去处理"跳到唯一待办视图。 */
  onOpenPending?: () => void
  /** 第 5 单 C2：外部请求把账本切到某个入账月份（跨月记账后一键查看）。 */
  focusMonth?: string | null
  onFocusHandled?: () => void
  /** 第 6 单 段3-2：外部（待办「原交易」）请求打开某一笔详情抽屉。 */
  focusTxId?: number | null
  onFocusTxHandled?: () => void
  /** 第 6 单 段2-2：任何写操作后自增，触发账本重取数（把老版 onChanged→load() 的因果链还回来）。 */
  dataEpoch?: number
  /** 第 6 单 段2-1：本次入账的新行 id 集合，表格里高亮。 */
  highlightIds?: Set<number>
}) {
  const [monthInput, setMonthInput] = useState(currentMonth())
  const [month, setMonth] = useState(currentMonth())
  const monthValid = normalizeMonth(monthInput).valid
  const [state, setState] = useState('')
  const [type, setType] = useState('')
  const [q, setQ] = useState('')
  const [qInput, setQInput] = useState('')
  const [page, setPage] = useState(0)
  const [data, setData] = useState<LedgerPageDTO>({ items: [], total: 0, agg: EMPTY_AGG })
  // 三态（段2-3）：加载中 / 取数错误(保留旧数据 + 红条重试) / 就绪（有数据或真无数据）
  const [status, setStatus] = useState<'loading' | 'ready' | 'error'>('loading')
  const [detail, setDetail] = useState<TxDetailDTO | null>(null)
  const [report, setReport] = useState<Awaited<ReturnType<typeof window.mz.latestReport>>>(null)

  const catMap = useMemo(() => {
    const map: Record<number, string> = {}
    for (const c of categories) map[c.id] = c.name
    return map
  }, [categories])

  const load = useCallback((f: LedgerFilter, keepOnError: boolean) => {
    setStatus('loading')
    window.mz
      .listLedger(f)
      .then((r) => {
        setData(r)
        setStatus('ready')
      })
      .catch(() => {
        // 取数失败：保留上一次数据（不伪装成 0/空态），显示错误条 + 重试
        setStatus('error')
        if (!keepOnError) setData({ items: [], total: 0, agg: EMPTY_AGG })
      })
  }, [])

  useEffect(() => {
    load({ month, state, type, q, limit: PAGE_SIZE, offset: page * PAGE_SIZE }, true)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [month, state, type, q, page, dataEpoch])

  useEffect(() => {
    window.mz.latestReport().then(setReport).catch(() => setReport(null))
  }, [])

  // C2：外部（跨月记账提示 / 本次入账条）请求切月——落到该月并复位分页，随后通知父组件消费掉
  useEffect(() => {
    if (!focusMonth) return
    setMonthInput(focusMonth)
    setMonth(focusMonth)
    setPage(0)
    onFocusHandled?.()
  }, [focusMonth, onFocusHandled])

  // 段3-2：待办「原交易」跳来——直接打开该笔详情抽屉（抽屉对任意 id 可开，不受当前月份筛选影响）
  useEffect(() => {
    if (focusTxId == null) return
    void window.mz
      .txDetail(focusTxId)
      .then((d) => setDetail(d))
      .catch(() => {})
    onFocusTxHandled?.()
  }, [focusTxId, onFocusTxHandled])

  const agg = data.agg ?? EMPTY_AGG
  // 口径标签：月份为唯一世界坐标，写进标签里（"2026-09 支出合计"），不再是"当前筛选/当前页"
  const scopeLabel = agg.month ? agg.month : '全部月份'

  // 分类构成来自聚合（整口径，不随分页漂移）
  const share = useMemo<ShareRow[]>(
    () => agg.byCategory.map((c) => ({ name: c.category, cents: c.cents, count: c.count })),
    [agg],
  )

  // 月份输入规范化 + 手输复位分页（S3/S4）
  const commitMonth = (raw: string): void => {
    setMonthInput(raw)
    const n = normalizeMonth(raw)
    if (n.valid) {
      setMonth(n.month)
      setPage(0)
    }
  }

  const gotoMonth = (next: string): void => {
    setMonthInput(next)
    setMonth(next)
    setPage(0)
  }

  async function openDetail(id: number): Promise<void> {
    setDetail(await window.mz.txDetail(id))
  }

  // 段4-2：抽屉动作组——改字段 / 删除 / 恢复 / 补转账账户 + 看原图；撤销=反向 update（留审计）。
  // Electron 不实现 window.prompt，字段编辑走行内输入框；删除/恢复用 window.confirm（原生，可测）。
  const [edit, setEdit] = useState<{ note: string; undo: TxEditOp | null } | null>(null)
  const [fEdit, setFEdit] = useState<null | 'category' | 'amount' | 'merchant' | 'transfer'>(null)
  const [fVal, setFVal] = useState('')
  const [attUrl, setAttUrl] = useState<string | null>(null)
  const [zoomAtt, setZoomAtt] = useState(false)
  const detailRef = useRef<TxDetailDTO | null>(null)
  detailRef.current = detail
  const lastDetailId = useRef<number | null>(null)

  useEffect(() => {
    setAttUrl(null)
    if (!detail) {
      setEdit(null)
      lastDetailId.current = null
      return
    }
    const ref = detail.attachmentRef
    if (ref) void window.mz.readAttachment(ref).then((u) => setAttUrl(u)).catch(() => {})
    // 只在切换到"另一笔"时清回执；同笔编辑后回填不清（否则"已改 · 撤销"闪现即消）
    if (detail.tx.id !== lastDetailId.current) {
      setEdit(null)
      lastDetailId.current = detail.tx.id
    }
  }, [detail])

  async function applyEdit(op: TxEditOp): Promise<void> {
    const cur = detailRef.current
    if (!cur) return
    const r = await window.mz.editTx(cur.tx.id, op)
    if (r.status === 'ok') {
      const prior: TxEditOp =
        op.op === 'set'
          ? { op: 'set', fields: { categoryName: cur.tx.categoryName ?? undefined, amountCents: cur.tx.amountCents, merchant: cur.tx.merchant ?? undefined } }
          : op.op === 'delete'
            ? { op: 'restore' }
            : op.op === 'restore'
              ? { op: 'delete' }
              : { op: 'set', fields: {} }
      setDetail(await window.mz.txDetail(cur.tx.id))
      onExecuted()
      setFEdit(null)
      setEdit({ note: `✓ ${r.message}`, undo: op.op === 'transferAccounts' ? null : prior })
    } else {
      setEdit({ note: `✗ ${r.message}`, undo: null })
    }
  }

  async function saveFieldEdit(): Promise<void> {
    if (!detail) return
    if (fEdit === 'category') {
      if (!fVal.trim()) return
      await applyEdit({ op: 'set', fields: { categoryName: fVal.trim() } })
    } else if (fEdit === 'amount') {
      const cents = Math.round(Number(fVal) * 100)
      if (!Number.isFinite(cents) || cents <= 0) {
        setEdit({ note: '✗ 金额无效', undo: null })
        return
      }
      await applyEdit({ op: 'set', fields: { amountCents: cents } })
    } else if (fEdit === 'merchant') {
      await applyEdit({ op: 'set', fields: { merchant: fVal } })
    } else if (fEdit === 'transfer') {
      if (!fVal.trim()) return
      await applyEdit({ op: 'transferAccounts', toAccountName: fVal.trim() })
    }
  }

  return (
    <div className="ledger">
      {report && <ReportPanel report={report} />}

      <div className="metrics">
        <div className="metric">
          <div className="metric-label">{scopeLabel} 支出合计</div>
          <div className="metric-value expense">¥{yuan(agg.expenseCents)}</div>
        </div>
        <div className="metric">
          <div className="metric-label">{scopeLabel} 收入合计</div>
          <div className="metric-value income">¥{yuan(agg.incomeCents)}</div>
        </div>
        <div className="metric">
          <div className="metric-label">笔数 / 待办</div>
          <div className="metric-value">
            {agg.count} / {pendingItems.length}
          </div>
        </div>
      </div>
      {agg.reviewCount > 0 && (
        <div className="review-note muted small">
          另有 {agg.reviewCount} 笔待确认 · 支出合计里未计入 ¥{yuan(agg.reviewExpenseCents)}
          <button className="ghost small-btn" onClick={() => onExecuted()}>
            刷新
          </button>
        </div>
      )}

      <CategoryShare
        rows={share}
        total={agg.expenseCents}
        caption={`分类构成（${scopeLabel} 已确认支出 ¥${yuan(agg.expenseCents)}，共 ${agg.count} 笔口径内）`}
      />

      {pendingItems.length > 0 ? (
        <div className="pending-summary">
          <span className="badge warn">待办 {pendingItems.length} 条</span>
          <span className="muted small">有事项要补金额/补分类/确认——办理只在「待办」页，这里不再重复一份清单</span>
          <span className="grow" />
          {onOpenPending && (
            <button className="primary small-btn" onClick={onOpenPending}>
              去处理 →
            </button>
          )}
        </div>
      ) : (
        <div className="pending-summary muted small">待办已清空 · 事项保存在账本数据库中，关掉应用也不丢</div>
      )}

      <div className="filters">
        <div className="month-nav">
          <button onClick={() => gotoMonth(shiftMonth(month || currentMonth(), -1))} aria-label="上一月">
            ‹
          </button>
          <input
            value={monthInput}
            onChange={(e) => commitMonth(e.target.value)}
            placeholder="YYYY-MM"
            aria-label="月份"
            className={monthValid ? '' : 'invalid'}
          />
          <button onClick={() => gotoMonth(shiftMonth(month || currentMonth(), 1))} aria-label="下一月">
            ›
          </button>
          <button onClick={() => gotoMonth(currentMonth())}>本月</button>
          <button onClick={() => gotoMonth('')} className={month === '' ? 'active' : ''} title="不限月份，查看全部">
            全部月份
          </button>
        </div>
        {!monthValid && <span className="err small">月份格式应为 YYYY-MM</span>}
        {monthValid && month === '' && <span className="badge">全部月份</span>}
        <select
          className="cat-select"
          value={state}
          onChange={(e) => {
            setState(e.target.value)
            setPage(0)
          }}
          aria-label="状态"
        >
          <option value="">全部状态</option>
          {Object.entries(STATE_LABEL).map(([k, v]) => (
            <option key={k} value={k}>
              {v}
            </option>
          ))}
        </select>
        <select
          className="cat-select"
          value={type}
          onChange={(e) => {
            setType(e.target.value)
            setPage(0)
          }}
          aria-label="类型"
        >
          <option value="">全部类型</option>
          {Object.entries(TYPE_LABEL).map(([k, v]) => (
            <option key={k} value={k}>
              {v}
            </option>
          ))}
        </select>
        <input
          value={qInput}
          onChange={(e) => setQInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              setPage(0)
              setQ(qInput.trim())
            }
          }}
          placeholder="搜商户 / 备注 / 分类"
          aria-label="搜索"
        />
        <button
          onClick={() => {
            setPage(0)
            setQ(qInput.trim())
          }}
        >
          搜索
        </button>
        {q && (
          <button
            onClick={() => {
              setQInput('')
              setQ('')
              setPage(0)
            }}
          >
            清除
          </button>
        )}
        <span className="muted">
          {scopeLabel} 共 {agg.count} 笔
        </span>
      </div>

      {status === 'error' && (
        <div className="error-bar" role="alert">
          <span>✗ 读取账本失败，显示的是上一次的数据</span>
          <button
            className="ghost small-btn"
            onClick={() => load({ month, state, type, q, limit: PAGE_SIZE, offset: page * PAGE_SIZE }, true)}
          >
            重试
          </button>
        </div>
      )}

      <table className="tx-table">
        <thead>
          <tr>
            <th>时间</th>
            <th className="num">金额</th>
            <th>商户</th>
            <th>分类</th>
            <th className="col-account">账户</th>
            <th className="col-type">类型</th>
            <th>状态</th>
          </tr>
        </thead>
        <tbody>
          {data.items.map((t) => {
            const kind = t.type === 'income' ? 'income' : t.type === 'expense' ? 'expense' : ''
            const sign = t.type === 'income' ? '+' : t.type === 'expense' ? '−' : ''
            const occurred = (t.occurredAt ?? '').replace('T', ' ')
            return (
              <tr
                key={t.id}
                onClick={() => void openDetail(t.id)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' || e.key === ' ') {
                    e.preventDefault()
                    void openDetail(t.id)
                  }
                }}
                tabIndex={0}
                role="button"
                aria-label={`查看交易 ${t.merchant ?? '未命名'} ¥${yuan(t.amountCents)} 详情`}
                className={`${t.state === 'deleted' ? 'struck' : ''} ${highlightIds?.has(t.id) ? 'row-new' : ''}`}
              >
                <td>
                  <span className="cell-date">
                    <span>{occurred.slice(0, 10) || '-'}</span>
                    <span className="time">{occurred.slice(11, 16) || ''}</span>
                  </span>
                </td>
                <td className={`cell-amount ${kind}`}>
                  <span className="unit">¥</span>
                  {sign}
                  {yuan(t.amountCents)}
                </td>
                <td>{t.merchant ?? '-'}</td>
                <td>
                  <span className="cell-category">
                    <span className="dot" style={{ background: colorFor(t.categoryName) }} />
                    {t.categoryName ?? '-'}
                  </span>
                </td>
                <td className="col-account">{t.accountName ?? '-'}</td>
                <td className="col-type">
                  {TYPE_LABEL[t.type] ?? t.type}
                  {t.type === 'transfer' && <span className="badge">不计入收支</span>}
                </td>
                <td>
                  <span className={`badge state-${t.state}`}>{STATE_LABEL[t.state] ?? t.state}</span>
                </td>
              </tr>
            )
          })}
          {status === 'loading' && data.items.length === 0 && (
            <>
              {[0, 1, 2].map((i) => (
                <tr key={`sk-${i}`} className="skeleton-row" aria-hidden>
                  {Array.from({ length: 7 }).map((_, j) => (
                    <td key={j}>
                      <span className="skeleton" />
                    </td>
                  ))}
                </tr>
              ))}
            </>
          )}
          {status === 'ready' && data.items.length === 0 && (
            <tr>
              <td colSpan={7}>
                <div className="empty-inline">
                  {q ? (
                    <>
                      {month ? `「${month}」里没搜到「${q}」。` : `没搜到「${q}」。`}
                      {month && (
                        <button
                          onClick={() => {
                            setMonthInput('')
                            setMonth('')
                            setPage(0)
                          }}
                        >
                          在全部月份里搜
                        </button>
                      )}
                      <button
                        onClick={() => {
                          setQInput('')
                          setQ('')
                        }}
                      >
                        清除搜索
                      </button>
                    </>
                  ) : (
                    <>
                      {month ? (
                        <>
                          {month} 还没有记录。
                          <button
                            onClick={() => {
                              setMonthInput('')
                              setMonth('')
                              setPage(0)
                            }}
                          >
                            查看全部月份
                          </button>
                        </>
                      ) : (
                        '还没有记录。把截图或 CSV 直接拖进对话，就能一次性记一批。'
                      )}
                    </>
                  )}
                </div>
              </td>
            </tr>
          )}
        </tbody>
      </table>

      {data.total > PAGE_SIZE && (
        <div className="pager">
          <button disabled={page === 0} onClick={() => setPage((p) => Math.max(0, p - 1))}>
            上一页
          </button>
          <span className="muted">
            第 {page * PAGE_SIZE + 1}–{Math.min(data.total, (page + 1) * PAGE_SIZE)} 笔 / 共 {data.total} 笔
          </span>
          <button disabled={(page + 1) * PAGE_SIZE >= data.total} onClick={() => setPage((p) => p + 1)}>
            下一页
          </button>
        </div>
      )}

      {detail && (
        <div
          className="drawer"
          onClick={() => setDetail(null)}
          role="dialog"
          aria-label="交易详情"
        >
          <div className="drawer-body" onClick={(e) => e.stopPropagation()}>
            <div className="drawer-head">
              <strong>
                交易 #{detail.tx.id} {detail.tx.merchant ?? ''}
              </strong>
              <button onClick={() => setDetail(null)}>关闭</button>
            </div>
            <div className="drawer-meta">
              <div>金额：¥{yuan(detail.tx.amountCents)}</div>
              <div>商户：{detail.tx.merchant ?? '-'}</div>
              <div>分类：{detail.tx.categoryName ?? '-'}</div>
              <div>状态：{STATE_LABEL[detail.tx.state] ?? detail.tx.state}</div>
              <div>发生时间：{detail.tx.occurredAt}</div>
              <div>账户：{detail.tx.accountName ?? '-'}</div>
              {detail.tx.type === 'transfer' && <div>转入账户：{detail.tx.toAccountName ?? '（未填）'}</div>}
            </div>
            {attUrl && (
              // biome-ignore lint/a11y/noStaticElementInteractions: 点开放大原图
              <img src={attUrl} alt="来源原图" className="msg-thumb drawer-att" onClick={() => setZoomAtt(true)} />
            )}
            {detail.tx.state === 'deleted' ? (
              <div className="drawer-actions">
                <button className="primary small-btn" onClick={() => void applyEdit({ op: 'restore' })}>
                  恢复这笔
                </button>
              </div>
            ) : (
              <div className="drawer-actions-wrap">
                <div className="drawer-actions">
                  <button className="ghost small-btn" onClick={() => { setFEdit(fEdit === 'category' ? null : 'category'); setFVal('') }}>
                    改分类
                  </button>
                  <button
                    className="ghost small-btn"
                    onClick={() => {
                      setFEdit(fEdit === 'amount' ? null : 'amount')
                      setFVal((detail.tx.amountCents / 100).toFixed(2))
                    }}
                  >
                    改金额
                  </button>
                  <button className="ghost small-btn" onClick={() => { setFEdit(fEdit === 'merchant' ? null : 'merchant'); setFVal(detail.tx.merchant ?? '') }}>
                    改商户
                  </button>
                  {detail.tx.type === 'transfer' && !detail.tx.toAccountName && (
                    <button className="primary small-btn" onClick={() => { setFEdit('transfer'); setFVal('') }}>
                      补转入账户
                    </button>
                  )}
                  <button
                    className="ghost small-btn danger-text"
                    onClick={() => {
                      if (window.confirm(`删除这笔（${detail.tx.merchant ?? ''} ¥${yuan(detail.tx.amountCents)}）？软删可随时恢复。`))
                        void applyEdit({ op: 'delete' })
                    }}
                  >
                    删除
                  </button>
                </div>
                {fEdit && (
                  <div className="drawer-edit">
                    {fEdit === 'category' ? (
                      <select
                        aria-label="新分类"
                        className="cat-select"
                        value={fVal}
                        onChange={(e) => setFVal(e.target.value)}
                      >
                        <option value="" disabled>
                          选择分类…
                        </option>
                        {categories
                          .filter((c) => c.kind === (detail.tx.type === 'income' ? 'income' : 'expense'))
                          .map((c) => (
                            <option key={c.id} value={c.name}>
                              {c.name}
                            </option>
                          ))}
                      </select>
                    ) : (
                      <input
                        aria-label={fEdit === 'transfer' ? '新转入账户' : fEdit === 'amount' ? '新金额' : '新商户'}
                        type={fEdit === 'amount' ? 'number' : 'text'}
                        step={fEdit === 'amount' ? '0.01' : undefined}
                        value={fVal}
                        placeholder={fEdit === 'transfer' ? '转入账户名' : fEdit === 'amount' ? '金额（元）' : '商户名'}
                        onChange={(e) => setFVal(e.target.value)}
                      />
                    )}
                    <button className="primary small-btn" onClick={() => void saveFieldEdit()}>
                      保存
                    </button>
                    <button className="ghost small-btn" onClick={() => setFEdit(null)}>
                      取消
                    </button>
                  </div>
                )}
              </div>
            )}
            {edit && (
              <p className={edit.note.startsWith('✗') ? 'err small' : 'ok small'} role="status">
                {edit.note}
                {edit.undo && (
                  <button className="ghost small-btn" onClick={() => void applyEdit(edit.undo as TxEditOp)}>
                    撤销
                  </button>
                )}
              </p>
            )}
            {detail.tx.type === 'transfer' && !detail.tx.toAccountName && (
              <p className="muted small">这笔转账缺转入账户、尚未入账——用上方「补转入账户」，或在对话里说「把 #{detail.tx.id} 转到〈账户名〉」。</p>
            )}
            <h4>审计时间线（为什么这笔这么记）</h4>
            <ol className="timeline">
              {detail.audit.map((a, i) => (
                <li key={i}>
                  <div className="tl-head">
                    <span className="badge">{CHANGE_LABEL[a.changeType] ?? a.changeType}</span>
                    <span className="muted">
                      {BY_LABEL[a.changedBy] ?? a.changedBy} · {a.changedAt}
                    </span>
                  </div>
                  {a.reasoning && <div className="tl-reason">{a.reasoning}</div>}
                  <AuditDiff before={a.beforeRaw ?? null} after={a.afterRaw ?? null} categories={catMap} />
                </li>
              ))}
            </ol>
            {zoomAtt && attUrl && (
              // biome-ignore lint/a11y/noStaticElementInteractions: 点击关闭大图
              <div className="zoom-overlay" onClick={() => setZoomAtt(false)}>
                <img src={attUrl} alt="来源原图大图" />
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  )
}

// 供 ChatApp 传参使用（保持会话归档类型引用收敛）
export type { SessionArchiveDTO }
