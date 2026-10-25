import { useCallback, useEffect, useRef, useState } from 'react'
import type { ReactElement } from 'react'
import type { TransactionActionsDTO, TransactionSplitItemInput, TransactionSplitPlanDTO } from '../../../shared/types'
import { useInbox } from '../shell/inboxStore'
import { LEDGER_CHANGED_EVENT, notifyLedgerChanged } from '../shell/panelStore'
import { humanError, money } from '../lib/ledgerFilter'
import { SplitPlanCard } from './SplitPlanCard'
import '../styles/transaction-actions.css'

export function TransactionActions({ txId, onChanged, onNotice }: {
  txId: number
  onChanged: () => void
  onNotice: (text: string, tone: 'ok' | 'err' | 'info') => void
}): ReactElement {
  const { categories } = useInbox()
  const [actions, setActions] = useState<TransactionActionsDTO | null>(null)
  const [plan, setPlan] = useState<TransactionSplitPlanDTO | null>(null)
  const [draftSource, setDraftSource] = useState<TransactionActionsDTO | null>(null)
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const epoch = useRef(0)
  const lock = useRef(false)

  const load = useCallback(async (): Promise<void> => {
    const id = ++epoch.current
    setLoading(true)
    try {
      const value = await window.mz.getTransactionActions(txId)
      const pending = value?.openSplitGateId == null ? null : await window.mz.getTransactionSplitPlan(value.openSplitGateId)
      if (id !== epoch.current) return
      setActions(value); setPlan(pending)
      if (!value) setError('这笔记录已不存在，请重新选择。')
    } catch (e) { if (id === epoch.current) setError(humanError(e)) }
    finally { if (id === epoch.current) setLoading(false) }
  }, [txId])

  useEffect(() => {
    void load()
    const changed = (): void => { if (!lock.current) void load() }
    window.addEventListener(LEDGER_CHANGED_EVENT, changed)
    return () => { ++epoch.current; window.removeEventListener(LEDGER_CHANGED_EVENT, changed) }
  }, [load])

  const refresh = (): void => { if (lock.current) return; setDraftSource(null); setError(null); void load() }
  const updated = async (text: string): Promise<void> => {
    setNotice(text); onNotice(text, 'ok'); await load(); onChanged(); notifyLedgerChanged()
  }
  const prepare = async (source: TransactionActionsDTO, items: TransactionSplitItemInput[]): Promise<void> => {
    if (lock.current) return
    lock.current = true; setBusy(true); setError(null); setNotice(null)
    try {
      const pending = await window.mz.prepareTransactionSplit({ txId: source.txId, expectedVersion: source.version, items })
      setPlan(pending); setDraftSource(null); await load(); notifyLedgerChanged()
    } catch (e) { setError(humanError(e)) }
    finally { lock.current = false; setBusy(false) }
  }
  const exclude = async (): Promise<void> => {
    if (lock.current || !actions?.canExclude) return
    const intent = { txId: actions.txId, expectedVersion: actions.version, excluded: !actions.excluded }
    lock.current = true; setBusy(true); setError(null); setNotice(null)
    try {
      await window.mz.setTransactionExcluded(intent)
      await updated(intent.excluded ? '已标记不计收支，保留记录并从收支统计中排除。' : '已恢复原方向和分类，重新计入收支。')
    } catch (e) { setError(humanError(e)) }
    finally { lock.current = false; setBusy(false) }
  }
  const undo = async (): Promise<void> => {
    const group = actions?.undoSplit
    if (lock.current || !group?.canUndo) return
    lock.current = true; setBusy(true); setError(null); setNotice(null)
    try {
      await window.mz.undoTransactionSplit({ gateId: group.gateId, expectedVersion: group.version })
      await updated('已撤销整组拆账，原笔恢复，分项保留为已删除记录。')
    } catch (e) { setError(humanError(e)) }
    finally { lock.current = false; setBusy(false) }
  }

  return <section className="mz-ta" data-testid="ledger-actions" aria-busy={loading || busy}>
    <header className="mz-ta-heading"><div><span className="mz-ta-eyebrow">记录调整</span><h3>拆账与收支归属</h3></div>
      <button type="button" className="mz-btn mz-btn-ghost" data-testid="ledger-actions-refresh" disabled={loading || busy} title="重新读取当前记录，清空未提交的拆账草稿" onClick={refresh}>重新读取</button>
    </header>
    <p className="mz-ta-note">拆账保留原笔与来源；不计收支保留记录，但不纳入收入、支出统计。只有你明确操作才会修改。</p>
    {loading && !actions && <p className="mz-ta-note">正在读取可用操作…</p>}
    {actions && <>
      <div className="mz-ta-actions">
        <button type="button" className="mz-btn" data-testid="ledger-split-open" disabled={loading || busy || !actions.canSplit || draftSource !== null} title={actions.canSplit ? undefined : actions.reason ?? undefined} onClick={() => { setDraftSource(actions); setError(null); setNotice(null) }}>拆成多笔</button>
        <button type="button" className="mz-btn mz-btn-ghost" data-testid="ledger-exclude-toggle" disabled={loading || busy || !actions.canExclude || draftSource !== null} title={actions.canExclude ? undefined : actions.reason ?? undefined} onClick={() => void exclude()}>{actions.excluded ? '恢复计入收支' : '标记不计收支'}</button>
      </div>
      {actions.reason && <p className="mz-ta-note" data-testid="ledger-actions-reason">{actions.reason}</p>}
      {draftSource && !plan && <SplitDraft source={draftSource} categories={categories} busy={busy} onPrepare={prepare} onCancel={() => setDraftSource(null)} />}
      {plan && <SplitPlanCard key={plan.gateId} plan={plan} onDone={result => { void updated(result.message) }} />}
      {actions.undoSplit && <div className="mz-ta-group" data-testid="ledger-split-group">
        <p className="mz-ta-note">这笔属于一组拆账。撤销会恢复原笔，并将整组分项标为已删除，不重复计账。</p>
        <button type="button" className="mz-btn" data-testid="ledger-split-undo" disabled={loading || busy || !actions.undoSplit.canUndo} onClick={() => void undo()}>撤销整组拆账</button>
        {actions.undoSplit.reason && <p className="mz-ta-note" data-testid="ledger-split-undo-reason">{actions.undoSplit.reason}</p>}
      </div>}
    </>}
    {error && <p className="mz-ta-error" data-testid="ledger-actions-error" role="alert">{error}</p>}
    {notice && <p className="mz-ta-notice" data-testid="ledger-actions-notice">{notice}</p>}
  </section>
}

type DraftRow = { key: number; amount: string; category: string }
function cents(text: string): number | null {
  const value = text.trim()
  if (value.length > 20 || !/^\d+(?:\.\d{1,2})?$/.test(value)) return null
  const [whole, fraction = ''] = value.split('.')
  const n = BigInt(whole) * 100n + BigInt(fraction.padEnd(2, '0'))
  return n > 0n && n <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(n) : null
}
function SplitDraft({ source, categories, busy, onPrepare, onCancel }: {
  source: TransactionActionsDTO
  categories: { id: number; name: string; kind: string }[]
  busy: boolean
  onPrepare: (source: TransactionActionsDTO, items: TransactionSplitItemInput[]) => Promise<void>
  onCancel: () => void
}): ReactElement {
  const [rows, setRows] = useState<DraftRow[]>([{ key: 0, amount: '', category: '' }, { key: 1, amount: '', category: '' }])
  const next = useRef(2)
  const amounts = rows.map(row => cents(row.amount))
  const sum = amounts.reduce<bigint>((total, value) => total + BigInt(value ?? 0), 0n)
  const total = sum <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(sum) : null
  const complete = amounts.every(value => value !== null)
  const balanced = complete && total === source.amountCents
  const options = categories.filter(c => c.kind === source.txType)
  const change = (key: number, field: 'amount' | 'category', value: string): void => setRows(old => old.map(row => row.key === key ? { ...row, [field]: value } : row))
  const submit = (): void => {
    if (busy || !balanced) return
    const items = rows.map((row, i): TransactionSplitItemInput => ({ amountCents: amounts[i]!, ...(row.category ? { categoryId: Number(row.category) } : {}) }))
    void onPrepare(source, items)
  }
  return <div className="mz-ta-draft" data-testid="split-editor">
    <p className="mz-ta-note">原笔 {money(source.amountCents)}，填写至少两部分。未另选分类时沿用原笔分类，说明、日期、账户与来源不变。</p>
    {rows.map((row, i) => <div className="mz-ta-draft-row" key={row.key}>
      <label>第 {i + 1} 部分金额<input className="mz-input" type="text" inputMode="decimal" maxLength={20} aria-label={`第${i + 1}部分金额`} data-testid="split-item-amount" placeholder="0.00" value={row.amount} disabled={busy} onChange={e => change(row.key, 'amount', e.target.value)} /></label>
      <label>分类<select className="mz-select" aria-label={`第${i + 1}部分分类`} data-testid="split-item-category" value={row.category} disabled={busy} onChange={e => change(row.key, 'category', e.target.value)}><option value="">沿用原分类</option>{options.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}</select></label>
      <button type="button" className="mz-ta-remove" aria-label={`移除第${i + 1}部分`} data-testid="split-item-remove" disabled={busy || rows.length <= 2} onClick={() => setRows(old => old.filter(x => x.key !== row.key))}>×</button>
    </div>)}
    <div className={`mz-ta-total${balanced ? ' is-balanced' : ''}`} data-testid="split-amount-total"><span>已填有效金额</span><strong className="mz-num">{total === null ? '金额超出可用范围' : money(total)}</strong></div>
    <p className="mz-ta-note">{balanced ? '金额核对一致。预览只保存待确认方案，不改账。' : !complete ? '请填写每部分的有效正金额，最多两位小数。' : total === null ? '请减少分项金额。' : total < source.amountCents ? `还差 ${money(source.amountCents - total)}` : `多出 ${money(total - source.amountCents)}`}</p>
    <div className="mz-ta-actions"><button type="button" className="mz-btn mz-btn-ghost" data-testid="split-add-row" disabled={busy || rows.length >= 50} onClick={() => setRows(old => [...old, { key: next.current++, amount: '', category: '' }])}>＋ 添加一部分</button>
      <button type="button" className="mz-btn mz-btn-primary" data-testid="split-preview" disabled={busy || !balanced} onClick={submit}>预览拆账方案</button>
      <button type="button" className="mz-btn mz-btn-ghost" data-testid="split-draft-cancel" disabled={busy} onClick={onCancel}>放弃草稿</button></div>
  </div>
}
