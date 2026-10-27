import { useCallback, useEffect, useRef, useState } from 'react'
import type { ReactElement } from 'react'
import type { ExecResult, TransactionSplitPlanDTO } from '../../../shared/types'
import { humanError, money } from '../lib/ledgerFilter'
import { LEDGER_CHANGED_EVENT, notifyLedgerChanged } from '../shell/panelStore'
import '../styles/transaction-actions.css'

/** Keep the displayed snapshot's version until an explicit refresh; never replay a stale confirmation. */
export function SplitPlanCard({ plan, onDone, readOnly = false }: {
  plan: TransactionSplitPlanDTO
  onDone?: (result: ExecResult) => void
  readOnly?: boolean
}): ReactElement {
  const [snapshot, setSnapshot] = useState(plan)
  const [busy, setBusy] = useState(false)
  const [stale, setStale] = useState(false)
  const [closed, setClosed] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const lock = useRef(false)
  const epoch = useRef(0)

  useEffect(() => {
    let alive = true
    const check = (): void => {
      if (lock.current) return
      const id = ++epoch.current
      void window.mz.getTransactionSplitPlan(snapshot.gateId).then(current => {
        if (!alive || id !== epoch.current) return
        setClosed(current === null)
        setStale(current !== null && current.version !== snapshot.version)
      }).catch(e => { if (alive && id === epoch.current) { setError(humanError(e)); setStale(true) } })
    }
    check()
    window.addEventListener(LEDGER_CHANGED_EVENT, check)
    return () => { alive = false; ++epoch.current; window.removeEventListener(LEDGER_CHANGED_EVENT, check) }
  }, [snapshot.gateId, snapshot.version, plan.version])

  const refresh = useCallback(async (): Promise<void> => {
    if (lock.current) return
    lock.current = true; setBusy(true)
    const id = ++epoch.current
    try {
      const current = await window.mz.getTransactionSplitPlan(snapshot.gateId)
      if (id !== epoch.current) return
      setError(null); setClosed(current === null); setStale(false)
      if (current) setSnapshot(current)
    } catch (e) { if (id === epoch.current) setError(humanError(e)) }
    finally { lock.current = false; if (id === epoch.current) setBusy(false) }
  }, [snapshot.gateId])

  const act = async (cancel: boolean): Promise<void> => {
    if (lock.current || readOnly || closed || (!cancel && stale)) return
    lock.current = true; setBusy(true); setError(null)
    try {
      const result = cancel
        ? await window.mz.cancelGate(snapshot.gateId)
        : await window.mz.confirmGate(snapshot.gateId, snapshot.version)
      if (result.status !== 'ok') { setError(result.message); return }
      setClosed(true); setNotice(result.message)
      onDone?.(result)
      notifyLedgerChanged()
    } catch (e) { setError(humanError(e)) }
    finally { lock.current = false; setBusy(false) }
  }

  return <section className="mz-sp" data-testid="split-plan" data-gate={snapshot.gateId} aria-busy={busy}>
    <header className="mz-ta-heading">
      <div><span className="mz-ta-eyebrow">拆账方案 · {closed ? '已处理' : '待你确认'}</span><h3>{snapshot.original.merchant ?? '这笔记录'}</h3></div>
      <strong className="mz-num">{money(snapshot.totalCents)}</strong>
    </header>
    <p className="mz-ta-note" data-testid="split-original">原笔 {money(snapshot.original.amountCents)} · {snapshot.original.occurredAt?.slice(0, 10)} · {snapshot.original.accountName ?? '未指定账户'}</p>
    <div className="mz-sp-items" data-testid="split-plan-items">
      {snapshot.items.map((item, i) => <div className="mz-sp-row" key={i}>
        <span><span className="mz-ta-index">{String(i + 1).padStart(2, '0')}</span>{item.categoryName}<small>{item.merchant ?? snapshot.original.merchant ?? '未命名'}</small></span>
        <strong className="mz-num">{money(item.amountCents)}</strong>
      </div>)}
    </div>
    <p className="mz-ta-note">确认后原笔保留为已删除记录，分项合计不变；账户、发生时间和来源沿用原笔。不新建分类或规则。</p>
    {stale && !closed && <p className="mz-ta-error" role="alert">方案已变化，请重新读取后核对；不会自动确认新版本。</p>}
    {error && <p className="mz-ta-error" data-testid="split-plan-error" role="alert">{error}</p>}
    {(notice || closed) && <p className="mz-ta-notice" data-testid="split-plan-notice">{notice ?? '此方案已处理或已取消，请以账本当前记录为准。'}</p>}
    {!closed && <div className="mz-ta-actions">
      {!readOnly && <><button type="button" className="mz-btn mz-btn-primary" data-testid="split-confirm" disabled={busy || stale} onClick={() => void act(false)}>确认拆成 {snapshot.items.length} 笔</button>
        <button type="button" className="mz-btn mz-btn-ghost" data-testid="split-cancel" disabled={busy} onClick={() => void act(true)}>取消方案</button></>}
      <button type="button" className="mz-btn mz-btn-ghost" data-testid="split-plan-refresh" disabled={busy} onClick={() => void refresh()}>重新读取</button>
      {readOnly && <span className="mz-ta-note">请在收件箱或账本中确认。</span>}
    </div>}
  </section>
}
