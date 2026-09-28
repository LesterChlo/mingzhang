// 待办面板（第 6 单 段3）：唯一办理入口。按来源分组 + 进度；批量填值 / 批量确认 / 整批忽略；
// 每条常驻「原交易」跳转；新事项置顶（倒序）+ 差值提示。gate 类维持按钮执行、只认 UI 信号。
import { useEffect, useMemo, useRef, useState } from 'react'
import type { CardData, PendingGateCardDTO, PendingItemDTO } from '../../../shared/types'
import { CardView } from './Cards'
import { txSummary, groupSameMerchant } from '../lib/pendingBatch'

const FIELD_LABEL: Record<string, string> = {
  confirm_record: '入账待确认',
  delete_confirm: '删除待确认',
  batch_confirm: '批次待确认',
  batch_item: '批次缺金额',
  transfer_account: '转账缺账户',
  note: '备忘',
}

const PER_GROUP_CAP = 8

export function PendingPanel({
  items,
  gateCards,
  categories,
  onExecuted,
  onRefresh,
  onOpenTx,
}: {
  items: PendingItemDTO[]
  /** open 的 delete/batch gate 就地重建卡片——执行不依赖对话里的卡片。 */
  gateCards: PendingGateCardDTO[]
  categories: { id: number; name: string; kind: string }[]
  onExecuted: () => void
  onRefresh: () => void
  /** 段3-2：「原交易」跳账本具体那一笔（开抽屉）。 */
  onOpenTx?: (txId: number) => void
}) {
  const [expandedGroups, setExpandedGroups] = useState<Record<string, boolean>>({})
  const [answering, setAnswering] = useState<number | null>(null)
  const [answer, setAnswer] = useState('')
  const [busyId, setBusyId] = useState<number | null>(null)
  const [msg, setMsg] = useState<string | null>(null)
  const [batchFill, setBatchFill] = useState<Record<string, string>>({})
  const [attaching, setAttaching] = useState(false)
  const [attachmentUrls, setAttachmentUrls] = useState<Record<number, string>>({})
  const [zoomUrl, setZoomUrl] = useState<string | null>(null)

  // 段3-3 差值提示：与上一次的开放集合比，办结 / 新增各几条
  const prevIds = useRef<Set<number> | null>(null)
  const [delta, setDelta] = useState<{ done: number; added: number } | null>(null)
  useEffect(() => {
    const now = new Set(items.map((i) => i.gateId))
    if (prevIds.current) {
      let done = 0
      let added = 0
      for (const id of prevIds.current) if (!now.has(id)) done++
      for (const id of now) if (!prevIds.current.has(id)) added++
      setDelta(done || added ? { done, added } : null)
    }
    prevIds.current = now
  }, [items])

  useEffect(() => {
    for (const it of items) {
      if (!it.attachmentRef || attachmentUrls[it.gateId]) continue
      window.mz
        .readAttachment(it.attachmentRef)
        .then((url) => {
          if (url) setAttachmentUrls((prev) => ({ ...prev, [it.gateId]: url }))
        })
        .catch(() => {}) // 缺附件/读取失败：静默不显示
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [items])

  // 按来源分组，保留 items 的倒序（组内新在前、组间新在前）
  const groups = useMemo(() => {
    const map = new Map<string, { id: string; label: string; items: PendingItemDTO[] }>()
    for (const it of items) {
      const g = map.get(it.groupId) ?? { id: it.groupId, label: it.groupLabel, items: [] }
      g.items.push(it)
      map.set(it.groupId, g)
    }
    return [...map.values()]
  }, [items])

  async function ignoreGroup(gateIds: number[]): Promise<void> {
    setMsg(null)
    setAttaching(true)
    try {
      for (const id of gateIds) await window.mz.cancelGate(id)
      setMsg(`✓ 已忽略 ${gateIds.length} 条`)
      onExecuted()
    } catch (e) {
      setMsg(`✗ 忽略失败：${(e as Error).message}`)
    } finally {
      setAttaching(false)
    }
  }

  // 组内批量补金额（batch_item）：整批用同一金额续办（原逐条 56 次操作的止血）
  // 同商户一键同类（confirm_record）：输入一次分类，逐条 answerPending，结果回执沿用 setMsg
  async function batchFillGroup(groupId: string, gateIds: number[]): Promise<void> {
    const v = (batchFill[groupId] ?? '').trim()
    if (!v) return
    setMsg(null)
    setAttaching(true)
    let ok = 0
    let fail = 0
    try {
      for (const id of gateIds) {
        try {
          await window.mz.answerPending(id, v)
          ok++
        } catch {
          fail++
        }
      }
      setMsg(`✓ 批量补录 ${ok} 条${fail ? `，${fail} 条需单独处理` : ''}`)
      setBatchFill((m) => ({ ...m, [groupId]: '' }))
      onExecuted()
    } finally {
      setAttaching(false)
    }
  }

  // 同商户批量条专用 key：groupId + 商户，避免与整批补金额的 batchFill 串值
  function merchantBatchKey(groupId: string, merchant: string): string {
    return `${groupId}｜${merchant}`
  }

  if (items.length === 0) {
    return (
      <div className="ledger">
        <div className="ledger-bar">
          <span className="muted">待办保存在账本数据库中，关掉应用也不丢；答复后更新原交易，不会重复记账</span>
          <span className="grow" />
          <button className="ghost" onClick={onRefresh}>
            刷新待办
          </button>
        </div>
        <div className="muted center" style={{ marginTop: 40 }}>
          没有待办事项。
        </div>
      </div>
    )
  }

  function renderItem(it: PendingItemDTO) {
    const gateCard = gateCards.find((g) => g.gateId === it.gateId)
    const card: CardData | undefined = gateCard?.card ?? undefined
    return (
      <div key={it.gateId} className={`pending-item ${it.field.endsWith('_confirm') ? 'warn' : ''}`}>
        <div className="pending-head">
          <span className={`badge ${it.field === 'transfer_account' ? 'warn' : it.field.endsWith('_confirm') ? 'warn' : ''}`}>
            {FIELD_LABEL[it.field] ?? it.field}
          </span>
          <span className="muted small">#{it.gateId}</span>
          {it.txId && <span className="muted small">交易 #{it.txId}</span>}
          <span className="grow" />
          {it.txId && onOpenTx && (
            <button className="ghost small-btn" onClick={() => onOpenTx(it.txId as number)}>
              原交易
            </button>
          )}
          {(it.field === 'transfer_account' || it.field === 'note') && (
            <button className="ghost small-btn" disabled={attaching} onClick={() => void ignoreGroup([it.gateId])}>
              忽略
            </button>
          )}
          <span className="muted small">{it.createdAt.slice(0, 16)}</span>
        </div>
        <div className="pending-q">{it.question}</div>
        {txSummary(it) && <div className="muted small">{txSummary(it)}</div>}
        {attachmentUrls[it.gateId] && (
          // biome-ignore lint/a11y/noStaticElementInteractions: 缩略图点击放大
          <img
            src={attachmentUrls[it.gateId]}
            alt="来源附件"
            className="msg-thumb"
            onClick={() => setZoomUrl(attachmentUrls[it.gateId])}
          />
        )}
        {gateCard && gateCard.card.kind === 'transaction' && (
          <div className="pending-card">
            <CardView
              card={gateCard.card}
              categories={categories}
              onConfirmRecord={async () => {
                const txCard = gateCard.card
                if (txCard.kind !== 'transaction') return
                try {
                  const r = await window.mz.confirmRecord(txCard.tx.id)
                  if (r.status === 'ok') onExecuted()
                  else setMsg(`✗ ${r.message}`)
                } catch (err) {
                  setMsg(`✗ 执行失败：${(err as Error).message}`)
                }
              }}
              onConfirmGate={() => Promise.resolve()}
              onCancelGate={() => Promise.resolve()}
            />
          </div>
        )}
        {card && (card.kind === 'delete-gate' || card.kind === 'batch-gate') && (
          <div className="pending-card">
            <CardView
              card={card}
              categories={categories}
              onConfirmRecord={() => Promise.resolve()}
              onConfirmGate={async (gateId) => {
                try {
                  const r = await window.mz.confirmGate(gateId)
                  if (r.status === 'ok') onExecuted()
                  else setMsg(`✗ ${r.message}`)
                } catch (err) {
                  setMsg(`✗ 执行失败：${(err as Error).message}（未入账，可重试）`)
                }
              }}
              onCancelGate={async (gateId) => {
                try {
                  const r = await window.mz.cancelGate(gateId)
                  if (r.status === 'ok') onExecuted()
                  else setMsg(`✗ ${r.message}`)
                } catch (err) {
                  setMsg(`✗ 取消失败：${(err as Error).message}`)
                }
              }}
            />
          </div>
        )}
        {(it.field === 'confirm_record' || it.field === 'batch_item') &&
          (answering === it.gateId ? (
            <form
              className="pending-answer"
              onSubmit={(e) => {
                e.preventDefault()
                if (!answer.trim()) return
                setBusyId(it.gateId)
                setMsg(null)
                window.mz
                  .answerPending(it.gateId, answer)
                  .then((r) => {
                    setMsg(`✓ ${r.text}`)
                    setAnswering(null)
                    setAnswer('')
                    onExecuted()
                  })
                  .catch((err) => setMsg(`✗ ${(err as Error).message}`))
                  .finally(() => setBusyId(null))
              }}
            >
              <input
                aria-label={`续办答案 #${it.gateId}`}
                value={answer}
                disabled={busyId === it.gateId}
                onChange={(e) => setAnswer(e.target.value)}
                placeholder={it.field === 'batch_item' ? '金额（可带分类），如 15 餐饮' : '回答，如「餐饮」或「确认」'}
              />
              <button className="primary" disabled={busyId === it.gateId || !answer.trim()} type="submit">
                {busyId === it.gateId ? '处理中…' : '提交答案'}
              </button>
            </form>
          ) : (
            <div className="tx-review">
              <span className="muted small">
                {it.field === 'confirm_record'
                  ? '就地回答分类即可入账'
                  : '就地补充金额（可带分类），如「15 餐饮」'}
              </span>
              <span className="grow" />
              <button
                className="primary small-btn"
                onClick={() => {
                  setAnswering(it.gateId)
                  setAnswer('')
                  setMsg(null)
                }}
              >
                {it.field === 'confirm_record' ? '回答' : '补金额'}
              </button>
            </div>
          ))}
      </div>
    )
  }

  return (
    <div className="ledger">
      <div className="ledger-bar">
        <span className="muted">待办 {items.length} 条，保存在账本数据库中不会丢失；按来源分组，可批量处理</span>
        {delta && (
          <span className="badge" role="status">
            较上次 办结 {delta.done} · 新增 {delta.added}
          </span>
        )}
        <span className="grow" />
        <button className="ghost" onClick={onRefresh}>
          刷新待办
        </button>
      </div>
      {groups.map((g) => {
        const overflow = !expandedGroups[g.id] && g.items.length > PER_GROUP_CAP
        const shown = overflow ? g.items.slice(0, PER_GROUP_CAP) : g.items
        const batchItemIds = g.items.filter((i) => i.field === 'batch_item').map((i) => i.gateId)
        const sameMerchantBatches = groupSameMerchant(g.items)
        return (
          <section key={g.id} className="pending-group">
            <div className="pending-group-head">
              <span className="group-title">{g.label}</span>
              <span className="muted small">{g.items.length} 项待处理</span>
              <span className="grow" />
              {batchItemIds.length > 1 && (
                <span className="batch-fill">
                  <input
                    aria-label={`整批补金额 ${g.label}`}
                    placeholder="整批金额，如 15 餐饮"
                    value={batchFill[g.id] ?? ''}
                    onChange={(e) => setBatchFill((m) => ({ ...m, [g.id]: e.target.value }))}
                  />
                  <button
                    className="ghost small-btn"
                    disabled={attaching || !(batchFill[g.id] ?? '').trim()}
                    onClick={() => void batchFillGroup(g.id, batchItemIds)}
                  >
                    批量补录 {batchItemIds.length} 条
                  </button>
                </span>
              )}
              <button className="ghost small-btn" disabled={attaching} onClick={() => void ignoreGroup(g.items.map((i) => i.gateId))}>
                整批忽略
              </button>
            </div>
            {sameMerchantBatches.map((b) => {
              const key = merchantBatchKey(g.id, b.merchant)
              return (
                <div key={key} className="pending-group-head">
                  <span className="muted small">
                    {b.merchant} · {b.gateIds.length} 笔同商户
                  </span>
                  <span className="grow" />
                  <span className="batch-fill">
                    <input
                      aria-label={`同商户填同类 ${b.merchant}`}
                      placeholder="输入分类，如 餐饮"
                      value={batchFill[key] ?? ''}
                      onChange={(e) => setBatchFill((m) => ({ ...m, [key]: e.target.value }))}
                    />
                    <button
                      className="ghost small-btn"
                      disabled={attaching || !(batchFill[key] ?? '').trim()}
                      onClick={() => void batchFillGroup(key, b.gateIds)}
                    >
                      同商户填同类 {b.gateIds.length} 条
                    </button>
                  </span>
                </div>
              )
            })}
            <div className="pending-list">{shown.map(renderItem)}</div>
            {overflow && (
              <button className="ghost more-btn" onClick={() => setExpandedGroups((m) => ({ ...m, [g.id]: true }))}>
                展开其余 {g.items.length - PER_GROUP_CAP} 条
              </button>
            )}
          </section>
        )
      })}
      {msg && (
        <p className={msg.startsWith('✗') ? 'err' : 'ok'} role="status">
          {msg}
        </p>
      )}
      {zoomUrl && (
        // biome-ignore lint/a11y/noStaticElementInteractions: 点击关闭大图
        <div className="zoom-overlay" onClick={() => setZoomUrl(null)}>
          <img src={zoomUrl} alt="来源附件大图" />
        </div>
      )}
    </div>
  )
}
