// 账本屏 · 行详情（规格 §3.2「行详情（右栏）」）。
//
// 日期与收支类型：独立版本化 dateType 操作，显式保存并保留原本地时间/时区。
// 其余既有单字段编辑沿用 set；多附件在本机管理，不调用模型，不删除共享原图。

import { useCallback, useEffect, useRef, useState } from 'react'
import type { ReactElement } from 'react'
import type { AccountOption, TxDetailDTO, TxEditOp } from '../../../shared/types'
import { useInbox } from '../shell/inboxStore'
import { STATE_LABELS, humanError, money, stateTone } from '../lib/ledgerFilter'
import {TransactionAttachments} from './TransactionAttachments'
import { TransactionDateTypeEditor } from './TransactionDateTypeEditor'

/** 后端不支持的字段——原因逐条写清，禁用态可见（不做假按钮）。 */
const BACKEND_GAPS: { id: string; label: string; reason: string }[] = [
  { id: 'split', label: '拆账', reason: '拆账需要新的域层通道（规格 §6 未提供），本单不改后端' },
  { id: 'adjust', label: '标记不计收支', reason: '标记不计收支（adjustment）无写入通道，本单不改后端' },
]

export function LedgerDetail({
  txId,
  onChanged,
  onClose,
  onNotice,
}: {
  txId: number
  /** 编辑/删除/恢复成功后通知父级重新拉列表与汇总。 */
  onChanged: () => void
  /** 关闭右栏（点行详情右上角的 ✕）。 */
  onClose: () => void
  /** 操作回执（走 §2.5 toast）。 */
  onNotice: (text: string, tone: 'ok' | 'err' | 'info') => void
}): ReactElement {
  const { categories, refresh } = useInbox()
  const [detail, setDetail] = useState<TxDetailDTO | null>(null)
  const [accounts, setAccounts] = useState<AccountOption[]>([])
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [flash, setFlash] = useState<string | null>(null)
  const [amount, setAmount] = useState('')
  const [merchant, setMerchant] = useState('')
  const [fromAccount, setFromAccount] = useState('')
  const [toAccount, setToAccount] = useState('')
  const flashTimer = useRef<number | null>(null)

  const showFlash = useCallback((text: string) => {
    if (flashTimer.current) window.clearTimeout(flashTimer.current)
    setFlash(text)
    flashTimer.current = window.setTimeout(() => setFlash(null), 1600)
  }, [])

  const load = useCallback(async () => {
    try {
      const d = await window.mz.txDetail(txId)
      setDetail(d)
      setError(d ? null : '这笔交易不存在（可能已被删除或恢复）')
      if (d) {
        setAmount((d.tx.amountCents / 100).toFixed(2))
        setMerchant(d.tx.merchant ?? '')
        setFromAccount(d.tx.accountName ?? '')
        setToAccount(d.tx.toAccountName ?? '')
      }
    } catch (e) {
      setError(humanError(e))
    }
  }, [txId])

  useEffect(() => {
    void load()
  }, [load])

  // 账户下拉（转账的转出/转入）：listAccounts 真实通道，无余额字段
  useEffect(() => {
    void window.mz
      .listAccounts()
      .then(setAccounts)
      .catch(() => setAccounts([]))
  }, [])

  const run = useCallback(
    async (op: TxEditOp, okText: string, mode: 'flash' | 'toast' = 'flash'): Promise<void> => {
      if (busy) return
      setBusy(true)
      try {
        const r = await window.mz.editTx(txId, op)
        if (r.status === 'ok') {
          if (mode === 'toast') onNotice(r.message, 'ok')
          else showFlash(okText)
          await load()
          onChanged()
        } else {
          onNotice(r.message, r.status === 'error' ? 'err' : 'info')
        }
      } catch (e) {
        onNotice(`操作失败：${humanError(e)}`, 'err')
      } finally {
        setBusy(false)
      }
    },
    [busy, txId, load, onChanged, onNotice, showFlash],
  )

  const afterDateSaved = useCallback(async (message: string): Promise<void> => {
    // Filters may unmount this detail after reload; the shell owns the lasting receipt.
    onNotice(message, 'ok')
    await load()
    onChanged()
    void refresh().catch(() => onNotice('已保存，待办刷新失败，请重新读取。', 'info'))
  }, [load, onChanged, refresh, onNotice])

  if (error && !detail) {
    return (
      <aside className="mz-detail" data-testid="ledger-detail">
        <div className="mz-error-card">
          <div className="mz-error-title">这笔读取失败：{error}</div>
          <div className="mz-actions">
            <button type="button" className="mz-btn mz-btn-primary" onClick={() => void load()}>
              重试
            </button>
          </div>
        </div>
      </aside>
    )
  }
  if (!detail) {
    return (
      <aside className="mz-detail" data-testid="ledger-detail" aria-busy="true">
        <div className="mz-panel-title">行详情</div>
        <div className="mz-skel mz-skel-line" style={{ width: '60%', height: 14 }} />
        <div className="mz-skel mz-skel-line" style={{ width: '80%', height: 14 }} />
        <div className="mz-skel mz-skel-line" style={{ width: '45%', height: 14 }} />
      </aside>
    )
  }

  const tx = detail.tx
  const deleted = tx.state === 'deleted'
  const isTransfer = tx.type === 'transfer'
  const catKind = tx.type === 'income' ? 'income' : 'expense'
  const catOptions = categories.filter((c) => c.kind === catKind)

  /** 金额：元 → 整数分；非正数/非数字就地拒绝（不把脏值发给域层）。 */
  const commitAmount = (): void => {
    const raw = amount.trim()
    const n = Number(raw)
    if (!raw || !Number.isFinite(n) || n <= 0) {
      onNotice('金额必须是大于 0 的数字', 'err')
      setAmount((tx.amountCents / 100).toFixed(2))
      return
    }
    const cents = Math.round(n * 100)
    if (cents === tx.amountCents) return
    void run({ op: 'set', fields: { amountCents: cents } }, '已保存')
  }

  const commitMerchant = (): void => {
    const v = merchant.trim()
    if (v === (tx.merchant ?? '')) return
    void run({ op: 'set', fields: { merchant: v } }, '已保存')
  }

  return (
    <aside className="mz-detail" data-testid="ledger-detail" data-tx={tx.id}>
      <div className="mz-detail-head">
        <span className="mz-card-kind">
          行详情 <span className="mz-num mz-text-3">#{tx.id}</span>
        </span>
        <span className={`mz-tag mz-tag-${stateTone(tx.state)}`} data-testid="ledger-detail-state">
          {STATE_LABELS[tx.state] ?? tx.state}
        </span>
        {flash && (
          <span className="mz-saved" data-testid="ledger-saved" role="status">
            {flash}
          </span>
        )}
        <span className="mz-spacer" />
        <button
          type="button"
          className="mz-icon-btn"
          aria-label="关闭行详情"
          data-testid="ledger-detail-close"
          onClick={onClose}
        >
          ✕
        </button>
      </div>

      <div className="mz-detail-body">
        <label className="mz-detail-field">
          <span className="mz-field-lb">金额</span>
          <input
            className="mz-input mz-input-full mz-num"
            aria-label="金额"
            data-testid="ledger-edit-amount"
            value={amount}
            disabled={busy || deleted}
            onChange={(e) => setAmount(e.target.value)}
            onBlur={commitAmount}
            onKeyDown={(e) => {
              if (e.key === 'Enter') (e.target as HTMLInputElement).blur()
            }}
          />
        </label>

        <label className="mz-detail-field">
          <span className="mz-field-lb">说明</span>
          <input
            className="mz-input mz-input-full"
            aria-label="说明"
            data-testid="ledger-edit-merchant"
            value={merchant}
            disabled={busy || deleted}
            placeholder="未命名"
            onChange={(e) => setMerchant(e.target.value)}
            onBlur={commitMerchant}
            onKeyDown={(e) => {
              if (e.key === 'Enter') (e.target as HTMLInputElement).blur()
            }}
          />
        </label>

        <label className="mz-detail-field">
          <span className="mz-field-lb">分类</span>
          <select
            className="mz-select mz-select-full"
            aria-label="分类"
            data-testid="ledger-edit-category"
            value={tx.categoryName ?? ''}
            disabled={busy || deleted || isTransfer}
            onChange={(e) => {
              const v = e.target.value
              if (!v || v === tx.categoryName) return
              void run({ op: 'set', fields: { categoryName: v } }, '已保存')
            }}
          >
            {isTransfer ? (
              <option value="">转账不分类</option>
            ) : (
              <>
                <option value="">{tx.categoryName ?? '未分类'}</option>
                {catOptions.map((c) => (
                  <option key={c.id} value={c.name}>
                    {c.name}
                  </option>
                ))}
              </>
            )}
          </select>
        </label>

        {/* 账户：转账可补/改（transferAccounts）；其余如实禁用 */}
        {isTransfer ? (
          <div className="mz-detail-field">
            <span className="mz-field-lb">账户</span>
            <div className="mz-detail-inline">
              <select
                className="mz-select"
                aria-label="转出账户"
                data-testid="ledger-edit-from"
                value={fromAccount}
                disabled={busy || deleted}
                onChange={(e) => setFromAccount(e.target.value)}
              >
                {accounts.map((a) => (
                  <option key={a.id} value={a.name}>
                    {a.name}
                  </option>
                ))}
              </select>
              <span className="mz-text-3">→</span>
              <select
                className="mz-select"
                aria-label="转入账户"
                data-testid="ledger-edit-to"
                value={toAccount}
                disabled={busy || deleted}
                onChange={(e) => setToAccount(e.target.value)}
              >
                <option value="">未指定</option>
                {accounts.map((a) => (
                  <option key={a.id} value={a.name}>
                    {a.name}
                  </option>
                ))}
              </select>
            </div>
          </div>
        ) : (
          // T0928 §5（契约B）：非转账的账户也能改了——与分类同一个 commit-on-change 通路；
          // 空值不提交（契约是精确匹配账户名，空串只会误清）。当前值即选中值。
          <label className="mz-detail-field">
            <span className="mz-field-lb">账户</span>
            <select
              className="mz-select mz-select-full"
              aria-label="账户"
              data-testid="ledger-edit-account"
              value={tx.accountName ?? ''}
              disabled={busy || deleted}
              onChange={(e) => {
                const v = e.target.value
                if (!v || v === tx.accountName) return
                void run({ op: 'set', fields: { accountName: v } }, '已保存')
              }}
            >
              <option value="">{tx.accountName ?? '未指定'}</option>
              {accounts.map((a) => (
                <option key={a.id} value={a.name}>
                  {a.name}
                </option>
              ))}
            </select>
          </label>
        )}

        <TransactionDateTypeEditor txId={tx.id} revision={detail} disabled={busy || deleted} onBusyChange={setBusy} onSaved={afterDateSaved} />

        <TransactionAttachments key={tx.id} txId={tx.id} deleted={deleted} onChanged={() => {void load();onChanged()}}/>
      </div>

      {/* 动作区：只放后端真正支持的按钮 */}
      <div className="mz-detail-actions">
        <button
          type="button"
          className="mz-btn mz-btn-ghost"
          data-testid="ledger-transfer-accounts"
          disabled={busy || deleted || !isTransfer}
          title={isTransfer ? '补/改这笔记转账的转出与转入账户' : '仅转账记录支持（editTx {op:transferAccounts}）'}
          onClick={() =>
            void run(
              { op: 'transferAccounts', toAccountName: toAccount, fromAccountName: fromAccount },
              '已保存',
            )
          }
        >
          转入转账
        </button>

        {deleted ? (
          <button
            type="button"
            className="mz-btn mz-btn-primary"
            data-testid="ledger-restore"
            disabled={busy}
            onClick={() => void run({ op: 'restore' }, '', 'toast')}
          >
            恢复
          </button>
        ) : (
          <button
            type="button"
            className="mz-btn mz-btn-danger"
            data-testid="ledger-delete"
            disabled={busy}
            onClick={() => void run({ op: 'delete' }, '', 'toast')}
          >
            删除
          </button>
        )}
      </div>

      {/* 删除流程实况（§3.2 的确认门路径后端尚未提供——如实写清，不假装已送入收件箱） */}
      <div className="mz-todo-note" data-testid="ledger-delete-note">
        删除实况：editTx {'{op:delete}'} 在本机直接软删（可恢复），不经收件箱确认门；
        规格 §3.2 的「送入收件箱待确认」路径待后端（AI 发起的删除仍走确认门：收件箱可见删除确认卡）。
      </div>

      {/* 待后端禁用区：四个字段/动作，原因逐条可见 */}
      <div className="mz-todo-list" data-testid="ledger-backend-todo">
        <div className="mz-panel-title">待后端（后端无通道，按钮禁用）</div>
        <div className="mz-actions">
          {BACKEND_GAPS.map((g) => (
            <button
              key={g.id}
              type="button"
              className="mz-btn mz-btn-ghost"
              disabled
              title={g.reason}
              data-testid={`ledger-todo-${g.id}`}
            >
              {g.label}
            </button>
          ))}
        </div>
        <ul className="mz-todo-reasons">
          {BACKEND_GAPS.map((g) => (
            <li key={g.id}>
              <b>{g.label}</b>：{g.reason}
            </li>
          ))}
        </ul>
      </div>

      {/* 审计：真实读取的记录（信任机制） */}
      {detail.audit.length > 0 && (
        <div className="mz-todo-list" data-testid="ledger-audit">
          <div className="mz-panel-title">变更记录（{detail.audit.length}）</div>
          <ul className="mz-todo-reasons">
            {detail.audit.slice(-4).map((a, i) => (
              <li key={`${a.changedAt}-${i}`}>
                {a.changedAt.slice(5, 16).replace('T', ' ')} · {a.changedBy} · {a.changeType}
                {a.reasoning ? ` · ${a.reasoning}` : ''}
              </li>
            ))}
          </ul>
        </div>
      )}

      <div className="mz-todo-note">
        本行合计 <span className="mz-num">{money(tx.amountCents)}</span> · 创建于 {detail.createdAt?.slice(0, 16).replace('T', ' ') ?? '—'}
      </div>
    </aside>
  )
}
