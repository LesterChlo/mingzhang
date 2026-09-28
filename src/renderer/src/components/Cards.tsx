import { useState } from 'react'
import type {
  BatchGateCardData,
  BatchResultCardData,
  CardData,
  DeleteGateCardData,
  QueryResultCardData,
  RuleCardData,
  SplitCardData,
  TransactionCardData,
} from '../../../shared/types'

function yuan(cents: number): string {
  return (cents / 100).toFixed(2)
}

/** 第 6 单 段1：对话历史里的卡片是"当时的快照"——渲染前用当前态收敛。
 *  live = 此刻仍开放的确认门 id / 待确认交易 id。不在其中 = 已办结/已取消，卡片不得再出现"可点但静默"的按钮。 */
export interface LiveCardRefs {
  gates: Set<number>
  pendingTxs: Set<number>
}

/** 卡片动作区三态：live=可执行（待办/抽屉）；readonly=对话里未决（去待办处理）；stale=已办结（灰条）。 */
type CardMode = 'live' | 'readonly' | 'stale'

function ResolvedBar({ text }: { text: string }): JSX.Element {
  return <div className="card-resolved">· {text} ·</div>
}

function ViewTx({ id, onOpenTx }: { id: number; onOpenTx?: (n: number) => void }): JSX.Element | null {
  if (!onOpenTx) return null
  return (
    <button className="ghost small-btn" onClick={() => onOpenTx(id)}>
      查看这笔
    </button>
  )
}

const TYPE_LABEL: Record<string, string> = {
  expense: '支出',
  income: '收入',
  transfer: '转账',
  adjustment: '调整',
}

const STATE_LABEL: Record<string, string> = {
  confirmed: '已入账',
  needs_review: '待确认',
  parsed: '已解析',
  raw_input: '原始记录',
  deleted: '已删除',
}

export function CardView({
  card,
  categories,
  onConfirmRecord,
  onConfirmGate,
  onCancelGate,
  live,
  chatContext = false,
  onOpenTx,
}: {
  card: CardData
  categories: { id: number; name: string; kind: string }[]
  onConfirmRecord: (txId: number, categoryName?: string) => Promise<void>
  onConfirmGate: (gateId: number) => Promise<void>
  onCancelGate: (gateId: number) => Promise<void>
  live?: LiveCardRefs
  /** 第 6 单 段4-1：对话里一律只读——执行入口只在待办/抽屉；已办结显示"已处理"。 */
  chatContext?: boolean
  /** "查看这笔"跳转（对话卡片/待办原交易 → 账本抽屉）。 */
  onOpenTx?: (txId: number) => void
}) {
  // live=可执行（待办/抽屉）；readonly=对话里未决事项（去待办处理）；stale=已办结（只读灰条）。
  const gateMode = (gateId: number): CardMode =>
    !live ? 'live' : live.gates.has(gateId) ? (chatContext ? 'readonly' : 'live') : 'stale'
  switch (card.kind) {
    case 'transaction': {
      const review = Boolean(card.reviewReason) && card.tx.state !== 'confirmed' && card.tx.state !== 'deleted'
      const mode: CardMode = !review ? 'live' : !live ? 'live' : live.pendingTxs.has(card.tx.id) ? (chatContext ? 'readonly' : 'live') : 'stale'
      return (
        <TransactionCard card={card} categories={categories} onConfirm={onConfirmRecord} mode={mode} onOpenTx={onOpenTx} />
      )
    }
    case 'delete-gate':
      return (
        <DeleteGateCard
          card={card}
          onConfirm={onConfirmGate}
          onCancel={onCancelGate}
          mode={gateMode(card.gateId)}
          onOpenTx={onOpenTx}
        />
      )
    case 'query':
      return <QueryCard card={card} />
    case 'rule':
      return <RuleCard card={card} />
    case 'split':
      return <SplitCardView card={card} onOpenTx={onOpenTx} />
    case 'batch-gate':
      return (
        <BatchGateCard
          card={card}
          onConfirm={onConfirmGate}
          onCancel={onCancelGate}
          mode={gateMode(card.gateId)}
        />
      )
    case 'batch-result':
      return <BatchResultCard card={card} onOpenTx={onOpenTx} />
    default:
      return null
  }
}

export function TransactionCard({
  card,
  categories,
  onConfirm,
  mode = 'live',
  onOpenTx,
}: {
  card: TransactionCardData
  categories: { id: number; name: string; kind: string }[]
  onConfirm: (txId: number, categoryName?: string) => Promise<void>
  mode?: CardMode
  onOpenTx?: (txId: number) => void
}) {
  const { tx } = card
  const sign = tx.type === 'expense' ? '−' : tx.type === 'income' ? '+' : ''
  const confirmed = tx.state === 'confirmed'
  const deleted = tx.state === 'deleted'
  const needCategory = !confirmed && tx.categoryName === null && (tx.type === 'expense' || tx.type === 'income')
  const expenseCats = categories.filter((c) => c.kind === (tx.type === 'income' ? 'income' : 'expense'))
  const [picked, setPicked] = useState(tx.categoryName ?? '')
  const [busy, setBusy] = useState(false)

  async function confirm(): Promise<void> {
    if (needCategory && !picked) return
    if (busy) return
    setBusy(true)
    try {
      await onConfirm(tx.id, needCategory ? picked : undefined)
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className={`tx-card ${deleted ? 'dim' : confirmed ? 'ok' : 'warn'}`}>
      <div className="tx-head">
        <span className="tx-amount">
          {sign}¥{yuan(tx.amountCents)}
        </span>
        <span className="badge">{TYPE_LABEL[tx.type] ?? tx.type}</span>
        <span className={`badge ${deleted ? 'dim' : confirmed ? 'ok' : 'warn'}`}>{STATE_LABEL[tx.state] ?? tx.state}</span>
        {tx.confidenceScore !== null && (
          <span className="muted small">置信度 {(tx.confidenceScore * 100).toFixed(0)}%</span>
        )}
      </div>
      <div className="tx-body">
        {tx.merchant && <span>{tx.merchant}</span>}
        {tx.categoryName && <span className="chip">{tx.categoryName}</span>}
        {tx.accountName && <span className="muted small">{tx.accountName}</span>}
        {tx.toAccountName && <span className="muted small">→ {tx.toAccountName}</span>}
        <span className="muted small">#{tx.id}</span>
      </div>
      {card.ruleHit && (
        <div className="muted small rule-hit">命中你教的规则（#{card.ruleHit.ruleId} → {card.ruleHit.categoryName}）</div>
      )}
      {card.reviewReason && !confirmed && !deleted &&
        (mode === 'stale' ? (
          <ResolvedBar text="这笔已处理（历史记录，请到待办/账本查看）" />
        ) : mode === 'readonly' ? (
          <div className="tx-review">
            <span className="muted small">· 这项待你确认——请到「待办」处理 ·</span>
            <span className="grow" />
            <ViewTx id={tx.id} onOpenTx={onOpenTx} />
          </div>
        ) : (
          <div className="tx-review">
            {needCategory ? (
              <select value={picked} onChange={(e) => setPicked(e.target.value)} className="cat-select">
                <option value="" disabled>
                  选择分类…
                </option>
                {expenseCats.map((c) => (
                  <option key={c.id} value={c.name}>
                    {c.name}
                  </option>
                ))}
              </select>
            ) : (
              <span className="muted small">待确认原因：{card.reviewReason}</span>
            )}
            <button className="primary small-btn" disabled={(needCategory && !picked) || busy} onClick={() => void confirm()}>
              {busy ? '处理中…' : '确认入账'}
            </button>
          </div>
        ))}
    </div>
  )
}

function DeleteGateCard({
  card,
  onConfirm,
  onCancel,
  mode = 'live',
  onOpenTx,
}: {
  card: DeleteGateCardData
  onConfirm: (gateId: number) => Promise<void>
  onCancel: (gateId: number) => Promise<void>
  mode?: CardMode
  onOpenTx?: (txId: number) => void
}) {
  const { tx } = card
  const [busy, setBusy] = useState(false)
  const run = async (fn: () => Promise<void>): Promise<void> => {
    if (busy) return
    setBusy(true)
    try {
      await fn()
    } finally {
      setBusy(false)
    }
  }
  const resolved = mode === 'stale'
  return (
    <div className={`tx-card ${resolved ? 'dim' : 'warn'}`}>
      <div className="tx-head">
        <span className="tx-amount">¥{yuan(tx.amountCents)}</span>
        <span className="badge">{TYPE_LABEL[tx.type] ?? tx.type}</span>
        <span className={`badge ${resolved ? 'dim' : 'warn'}`}>{resolved ? '已处理' : '待确认删除'}</span>
        <span className="muted small">#{tx.id}</span>
      </div>
      <div className="tx-body">
        {tx.merchant && <span>{tx.merchant}</span>}
        {tx.categoryName && <span className="chip">{tx.categoryName}</span>}
      </div>
      {resolved ? (
        <ResolvedBar text="这道删除确认门已处理（已删除或已取消）" />
      ) : mode === 'readonly' ? (
        <div className="tx-review">
          <span className="muted small">· 这项待你确认删除——请到「待办」处理 ·</span>
          <span className="grow" />
          <ViewTx id={tx.id} onOpenTx={onOpenTx} />
        </div>
      ) : (
        <div className="tx-review">
          <span className="muted small">删除是软删，可随时恢复</span>
          <span className="grow" />
          <button className="ghost small-btn" disabled={busy} onClick={() => void run(() => onCancel(card.gateId))}>
            取消
          </button>
          <button className="primary small-btn danger" disabled={busy} onClick={() => void run(() => onConfirm(card.gateId))}>
            {busy ? '处理中…' : '确认删除'}
          </button>
        </div>
      )}
    </div>
  )
}

function BatchGateCard({
  card,
  onConfirm,
  onCancel,
  mode = 'live',
}: {
  card: BatchGateCardData
  onConfirm: (gateId: number) => Promise<void>
  onCancel: (gateId: number) => Promise<void>
  mode?: CardMode
}) {
  const [busy, setBusy] = useState(false)
  const run = async (fn: () => Promise<void>): Promise<void> => {
    if (busy) return
    setBusy(true)
    try {
      await fn()
    } finally {
      setBusy(false)
    }
  }
  return (
    <div className={`tx-card ${mode === 'stale' ? 'dim' : 'warn'}`}>
      <div className="tx-head">
        <span className={`badge ${mode === 'stale' ? 'dim' : 'warn'}`}>{mode === 'stale' ? '批次已处理' : '批次待确认'}</span>
        {card.channel && <span className="chip">{card.channel}</span>}
        <span className="muted small">
          将入账 {card.newCount} 笔 · 重复跳过 {card.duplicateCount} 笔 · 缺金额 {card.unparsedCount} 笔
        </span>
      </div>
      <div className="batch-items">
        {card.items.map((it, i) => (
          <div key={i} className={`batch-item ${it.status}`}>
            <span className={`badge ${it.status === 'new' ? 'ok' : it.status === 'duplicate' ? 'dim' : 'warn'}`}>
              {it.status === 'new' ? '入账' : it.status === 'duplicate' ? '重复' : '缺金额'}
            </span>
            <span>{it.merchant ?? '—'}</span>
            {it.amountCents !== null && <span className="muted small">¥{yuan(it.amountCents)}</span>}
            {it.reason && <span className="muted small">{it.reason}</span>}
          </div>
        ))}
      </div>
      <div className="tx-review">
        {mode === 'stale' ? (
          <ResolvedBar text="这道批次确认门已处理（已入账或已取消）" />
        ) : mode === 'readonly' ? (
          <span className="muted small">· 这批待确认——请到「待办」处理 ·</span>
        ) : (
          <>
            <span className="muted small">确认后按清单入账；重复项自动跳过；缺金额项转入待收尾</span>
            <span className="grow" />
            <button className="ghost small-btn" disabled={busy} onClick={() => void run(() => onCancel(card.gateId))}>
              取消
            </button>
            <button
              className="primary small-btn"
              disabled={card.newCount === 0 || busy}
              onClick={() => void run(() => onConfirm(card.gateId))}
            >
              {busy ? '处理中…' : '确认入账'}
            </button>
          </>
        )}
      </div>
    </div>
  )
}

function BatchResultCard({ card, onOpenTx }: { card: BatchResultCardData; onOpenTx?: (n: number) => void }) {
  return (
    <div className="tx-card ok">
      <div className="tx-head">
        <span className="badge ok">批次已入账</span>
        <span className="muted small">
          完成 {card.completed.length} · 重复 {card.duplicates.length} · 待核对 {card.unparsedKept}
        </span>
      </div>
      <div className="batch-items">
        {card.completed.map((c) => (
          <div key={c.txId} className="batch-item new">
            <span className="badge ok">{c.state === 'confirmed' ? '已入账' : '待确认'}</span>
            <span>{c.merchant ?? '—'}</span>
            <span className="muted small">¥{yuan(c.amountCents)}</span>
            <span className="muted small">#{c.txId}</span>
            {onOpenTx && (
              <button className="ghost small-btn" onClick={() => onOpenTx(c.txId)}>
                查看
              </button>
            )}
          </div>
        ))}
        {card.duplicates.map((d, i) => (
          <div key={`d${i}`} className="batch-item duplicate">
            <span className="badge dim">重复</span>
            <span>{d.merchant ?? '—'}</span>
            {d.amountCents !== null && <span className="muted small">¥{yuan(d.amountCents)}</span>}
            <span className="muted small">{d.reason}</span>
          </div>
        ))}
        {card.unparsedKept > 0 && (
          <div className="batch-item unparsed">
            <span className="badge warn">待核对</span>
            <span className="muted small">{card.unparsedKept} 笔缺金额，已转入待收尾，补充后可继续</span>
          </div>
        )}
      </div>
    </div>
  )
}

function RuleCard({ card }: { card: RuleCardData }) {
  if (card.undone) {
    return (
      <div className="rule-card">
        <span className="chip">规则 #{card.ruleId}</span> <span className="muted">已撤销，之后的记账不再套用</span>
      </div>
    )
  }
  return (
    <div className="rule-card">
      <span className="chip">规则 #{card.ruleId}</span>
      <span>
        「{card.merchant}」({card.op}) → <b>{card.categoryName}</b>
      </span>
      {card.conflict ? (
        <span className="muted small">已存在同条件规则，等待用户裁定是否覆盖</span>
      ) : (
        <span className="muted small">{card.provenance === 'manual' ? '你教的' : '从纠正学来'} · 已命中 {card.hitCount} 次</span>
      )}
    </div>
  )
}

function SplitCardView({ card, onOpenTx }: { card: SplitCardData; onOpenTx?: (n: number) => void }) {
  return (
    <div className="split-card">
      <div className="muted small">#{card.originalId} 拆成 {card.cards.length} 笔：</div>
      {card.cards.map((c) => (
        <div key={c.tx.id} className="split-item">
          <TransactionCard card={c} categories={[]} onConfirm={() => Promise.resolve()} onOpenTx={onOpenTx} />
        </div>
      ))}
    </div>
  )
}

export function QueryCard({ card }: { card: QueryResultCardData }) {
  return (
    <div className="query-card">
      <div className="tx-head">
        <span className="tx-amount">¥{yuan(card.totalCents)}</span>
        <span className="badge">{card.txType === 'expense' ? '支出' : '收入'}</span>
        <span className="muted small">
          {card.range[0]} ~ {card.range[1]} · {card.count} 笔
          {card.categoryName ? ` · ${card.categoryName}` : ''}
        </span>
      </div>
      {card.byCategory.length > 0 && (
        <div className="cat-bars">
          {card.byCategory.slice(0, 6).map((c) => {
            const max = card.byCategory[0].totalCents || 1
            return (
              <div key={c.category} className="cat-row">
                <span className="cat-name">{c.category}</span>
                <div className="bar">
                  <div className="bar-fill" style={{ width: `${(c.totalCents / max) * 100}%` }} />
                </div>
                <span className="cat-val">¥{yuan(c.totalCents)}</span>
              </div>
            )
          })}
        </div>
      )}
      {card.previous && (
        <div className="muted small">
          上期 ¥{yuan(card.previous.totalCents)} · 本期{card.previous.deltaCents >= 0 ? '多' : '少'} ¥
          {yuan(Math.abs(card.previous.deltaCents))}
        </div>
      )}
      <div className="muted small">
        {card.budgetCents
          ? `预算 ¥${yuan(card.budgetCents)} · 剩余 ¥${yuan(card.budgetRemainingCents ?? 0)}`
          : '未设置月度预算'}
      </div>
    </div>
  )
}
