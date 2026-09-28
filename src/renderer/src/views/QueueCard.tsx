// 待决卡片（§2.2 统一骨架 + §3.1 五种类型）。
//
// 骨架固定五段：类型色圆点 / 头部 12px（类型 · 相对时间 · 状态徽标）/ 主体 / **依据行** / 动作区。
// 「依据」行永远存在（解析类卡片引用原话或来源附件），这是信任机制的具象。
//
// 动作通道映射（只用既有 IPC，不新增）：
//   confirm_record → confirmRecord(txId[, category]) · answerPending（补分类即入账）· editTx（改内联分类）
//   delete_confirm  → confirmGate / cancelGate
//   batch_confirm   → confirmGate / cancelGate（明细逐行来自 card.items）
//   batch_item      → answerPending（补金额）
//   其他字段        → cancelGate（忽略；transfer_account 后端拒绝作答，不给假按钮）
// 每个动作执行后由 store 统一 refresh —— 界面不会「点了不动」。

import { useState } from 'react'
import type { ReactElement } from 'react'
import type { BatchGateCardData, DeleteGateCardData, PendingItemDTO } from '../../../shared/types'
import { useInbox } from '../shell/inboxStore'
import { money, relTime, txTypeLabel } from '../lib/shellFormat'

type Tone = 'green' | 'yellow' | 'blue' | 'red' | 'gray'

interface CardMeta {
  tone: Tone
  label: string
  tag: { text: string; tone: Tone } | null
}

function metaOf(field: string): CardMeta {
  switch (field) {
    case 'confirm_record':
      // C 单：合并重复信息 —— "已解析 · 待入账" 与角标「等你确认」同义，留一句（状态行），撤角标
      return { tone: 'green', label: '已解析 · 待入账', tag: null }
    case 'delete_confirm':
      return { tone: 'red', label: '删除确认', tag: { text: '可撤回', tone: 'red' } }
    case 'batch_confirm':
      return { tone: 'blue', label: '批量确认', tag: { text: '批量', tone: 'blue' } }
    case 'batch_item':
      return { tone: 'yellow', label: '待核对 · 缺金额', tag: null }
    case 'transfer_account':
      return { tone: 'yellow', label: '待补账户', tag: null }
    default:
      return { tone: 'gray', label: '待办', tag: null }
  }
}

/** 依据行：只写真实来源，缺来源就写来源类型，不编造。 */
function basisOf(item: PendingItemDTO, note: string | null | undefined): string {
  if (item.attachmentRef) return `来源附件：${item.attachmentRef}`
  if (note && note.trim()) return `原始输入：${note.trim()}`
  if (item.field === 'delete_confirm') return '账本里点删除 · 软删除，确认后仍可撤回'
  if (item.field === 'batch_confirm') return item.groupLabel
  return `速记行 · ${relTime(item.createdAt)}`
}

/**
 * 待办事项的 question 原文是域层原因串（"分类未定" / "置信度 0.5 低于阈值 0.7" …）。
 * 卡片上读成一句人话，原文一字不改地跟在括号里——不替 AI 改口，也不丢信息。
 */
function askLine(question: string): string {
  return question.includes('分类') ? `这笔算哪类？（${question}）` : question
}

export function QueueCard({ item }: { item: PendingItemDTO }): ReactElement {
  const { gateCards, details, busy, runExec, runAnswer } = useInbox()
  const [answer, setAnswer] = useState('')
  const [showBatchItems, setShowBatchItems] = useState(false)
  const meta = metaOf(item.field)
  const gate = gateCards.find((g) => g.gateId === item.gateId)
  const card = gate?.card
  const detail = item.txId != null ? details[item.txId] : undefined
  const disabled = busy !== null
  const gateId = item.gateId
  // C 单：依据长文本折叠成一行，title 兜底给全文（悬停也会展开，见 .mz-basis:hover）
  const basis = basisOf(item, detail?.tx.note)

  const primary = (): ReactElement | null => {
    if (item.field === 'confirm_record' && detail) {
      return (
        <button
          type="button"
          className="mz-btn mz-btn-primary"
          data-testid="inbox-confirm"
          disabled={disabled}
          onClick={() => {
            void runExec(gateId, () => window.mz.confirmRecord(detail.tx.id, detail.tx.categoryName ?? undefined))
          }}
        >
          ✓ 入账
        </button>
      )
    }
    if (card?.kind === 'delete-gate') {
      return (
        <button
          type="button"
          className="mz-btn mz-btn-danger"
          data-testid="inbox-confirm"
          disabled={disabled}
          onClick={() => {
            void runExec(card.gateId, () => window.mz.confirmGate(card.gateId))
          }}
        >
          确认删除
        </button>
      )
    }
    if (card?.kind === 'batch-gate') {
      return (
        <button
          type="button"
          className="mz-btn mz-btn-primary"
          data-testid="inbox-confirm"
          disabled={disabled}
          onClick={() => {
            void runExec(card.gateId, () => window.mz.confirmGate(card.gateId))
          }}
        >
          入账所选（{card.newCount}）
        </button>
      )
    }
    return null
  }

  return (
    <article className="mz-card" data-testid="inbox-card" data-kind={item.field} data-gate={gateId}>
      <div className="mz-card-head">
        <span className={`mz-dot mz-dot-${meta.tone}`} />
        <span className="mz-card-kind">{meta.label}</span>
        <time>{relTime(item.createdAt)}</time>
        {meta.tag && <span className={`mz-tag mz-tag-${meta.tag.tone}`}>{meta.tag.text}</span>}
      </div>

      {card?.kind === 'delete-gate' && <DeleteBody card={card} />}
      {card?.kind === 'batch-gate' && (
        <BatchBody
          card={card}
          showItems={showBatchItems}
          onToggle={() => setShowBatchItems((v) => !v)}
        />
      )}

      {item.field === 'confirm_record' &&
        (detail ? (
          <>
            <div className="mz-title-row">
              <span className="mz-num mz-amount">{money(detail.tx.amountCents)}</span>
              {detail.tx.merchant && <span className="mz-merchant">{detail.tx.merchant}</span>}
              <span className="mz-meta-inline">
                {[
                  detail.tx.accountName,
                  detail.tx.occurredAt ? detail.tx.occurredAt.slice(5, 10) : null,
                  txTypeLabel(detail.tx.type),
                ]
                  .filter(Boolean)
                  .join(' · ')}
              </span>
            </div>
            {/* §3.1 第 2 类：AI 反问以正文行呈现（非气泡） */}
            {item.question && <div className="mz-meta-line">{askLine(item.question)}</div>}
            <div className="mz-field-row">
              <CategoryField
                item={item}
                current={detail.tx.categoryName}
                txType={detail.tx.type}
                disabled={disabled}
              />
              {/* C 单（pill 一致性）：分类是可点控件（盒形+下拉箭头）；账户/日期是纯展示，
                  不再套同一个盒形误导"也能点"（testid 不动、文案不动） */}
              <span className="mz-field-static">
                <span className="mz-field-lb">账户</span>
                {detail.tx.accountName ?? '未指定'}
              </span>
              <span className="mz-field-static">
                <span className="mz-field-lb">日期</span>
                {detail.tx.occurredAt.slice(0, 10)}
              </span>
            </div>
          </>
        ) : (
          <div className="mz-meta-line">{item.question}</div>
        ))}

      {item.field === 'batch_item' && (
        <>
          <div className="mz-meta-line">{item.question}</div>
          {item.merchant && <div className="mz-meta-line">{item.merchant}</div>}
          <div className="mz-field-row">
            <input
              className="mz-input"
              aria-label={`补金额 #${gateId}`}
              placeholder="金额（可带分类），如 15 餐饮"
              value={answer}
              disabled={disabled}
              onChange={(e) => setAnswer(e.target.value)}
            />
            <button
              type="button"
              className="mz-btn mz-btn-primary"
              disabled={disabled || !answer.trim()}
              onClick={() => {
                void runAnswer(gateId, answer).then((ok) => {
                  if (ok) setAnswer('')
                })
              }}
            >
              补录
            </button>
          </div>
        </>
      )}

      {(item.field === 'transfer_account' || item.field === 'note' || item.field === 'other') && (
        <div className="mz-meta-line">{item.question}</div>
      )}

      <div className="mz-basis" data-testid="inbox-basis" title={basis}>
        依据：{basis}
      </div>

      <div className="mz-actions">
        {primary()}
        {/* 搁置＝关闭这条待办（cancelGate）。后端对 delete/batch 门拒绝「对话作答」，
            所以这里的语义是忽略/撤销，不是"回答问题"。 */}
        <button
          type="button"
          className="mz-btn mz-btn-ghost"
          data-testid="inbox-cancel"
          disabled={disabled}
          onClick={() => {
            void runExec(gateId, () => window.mz.cancelGate(gateId))
          }}
        >
          {item.field === 'delete_confirm' ? '撤销' : '忽略'}
        </button>
      </div>
    </article>
  )
}

/**
 * 内联分类字段（§3.1 第 1 类）：AI 预填，点击即改，改完即生效——
 * 走 editTx（既有域层，changed_by='user' + 审计），改完 store 统一刷新。
 * 候选来自 listCategories，按交易类型（支出/收入）过滤。
 */
function CategoryField({
  item,
  current,
  txType,
  disabled,
}: {
  item: PendingItemDTO
  current: string | null
  txType: string
  disabled: boolean
}): ReactElement {
  const { categories, runExec } = useInbox()
  if (item.txId == null) return <span className="mz-field">未关联交易</span>
  const kind = txType === 'income' ? 'income' : 'expense'
  const options = categories.filter((c) => c.kind === kind)
  return (
    <span className="mz-field">
      <span className="mz-field-lb">分类</span>
      <select
        className="mz-select"
        aria-label={`分类 #${item.gateId}`}
        value={current ?? ''}
        disabled={disabled}
        onChange={(e) => {
          const v = e.target.value
          if (!v || v === current) return
          void runExec(item.gateId, () =>
            window.mz.editTx(item.txId as number, { op: 'set', fields: { categoryName: v } }),
          )
        }}
      >
        <option value="">{current ?? '未分类'}</option>
        {options.map((c) => (
          <option key={c.id} value={c.name}>
            {c.name}
          </option>
        ))}
      </select>
    </span>
  )
}

function DeleteBody({ card }: { card: DeleteGateCardData }): ReactElement {
  const tx = card.tx
  return (
    <div className="mz-meta-line mz-meta-strong">
      将删除「{tx.merchant ?? '未命名'} <span className="mz-num">{money(tx.amountCents)}</span>
      {tx.occurredAt ? ` · ${tx.occurredAt.slice(5, 10)}` : ''}」
    </div>
  )
}

function BatchBody({
  card,
  showItems,
  onToggle,
}: {
  card: BatchGateCardData
  showItems: boolean
  onToggle: () => void
}): ReactElement {
  const total = card.items
    .filter((it) => it.status === 'new' && it.amountCents != null)
    .reduce((s, it) => s + (it.amountCents as number), 0)
  return (
    <>
      <div className="mz-title-row">
        <span className="mz-merchant">{card.channel ?? '账单材料'}</span>
        <span className={`mz-tag mz-tag-blue mz-num`}>{card.newCount} 笔待入账</span>
      </div>
      <div className="mz-meta-line">
        {card.newCount} 笔待确认
        {card.unparsedCount > 0 ? `（${card.unparsedCount} 笔待核对）` : ''}
        {card.duplicateCount > 0 ? (
          <span className="mz-text-3"> · {card.duplicateCount} 笔重复已跳过</span>
        ) : null}
        {card.skippedCount ? <span className="mz-text-3"> · 已跳过 {card.skippedCount} 笔</span> : null}
        {total > 0 ? (
          <>
            {' · '}合计 <span className="mz-num">{money(total)}</span>
          </>
        ) : null}
      </div>
      <div className="mz-field-row">
        <button type="button" className="mz-btn mz-btn-ghost" onClick={onToggle} data-testid="inbox-batch-toggle">
          {showItems ? '收起明细' : `查看 ${card.items.length} 行明细`}
        </button>
      </div>
      {showItems && (
        <div className="mz-batch-items" data-testid="inbox-batch-items">
          {card.items.map((it, i) => (
            <div key={i} className={`mz-batch-row mz-batch-${it.status}`}>
              <span className="mz-num">{it.rowNo != null ? `第 ${it.rowNo} 行` : `#${i + 1}`}</span>
              <span className="mz-batch-merchant">{it.merchant ?? '—'}</span>
              <span className="mz-num">{it.amountCents != null ? money(it.amountCents) : '—'}</span>
              <span
                className={`mz-tag mz-tag-${
                  it.status === 'new' ? 'green' : it.status === 'duplicate' ? 'gray' : 'yellow'
                }`}
              >
                {it.status === 'new' ? '新增' : it.status === 'duplicate' ? '重复' : '待核对'}
              </span>
              {it.reason && <span className="mz-batch-reason">{it.reason}</span>}
            </div>
          ))}
        </div>
      )}
    </>
  )
}
