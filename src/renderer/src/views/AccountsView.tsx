import { useCallback, useEffect, useRef, useState } from 'react'
import type { FormEvent, ReactElement } from 'react'
import type { AccountOption } from '../../../shared/types'
import { humanError, money } from '../lib/ledgerFilter'
import { localMonth } from '../lib/shellFormat'
import { LEDGER_CHANGED_EVENT, notifyLedgerChanged } from '../shell/panelStore'
import './accounts.css'

type AccountType = 'cash' | 'bank' | 'alipay' | 'wechat'
type Direction = 'expense' | 'income'
type Category = { id: number; name: string; kind: string }
type Summary = { month: string; accounts: (AccountOption & { expenseCents: number; incomeCents: number; count: number })[] }
type Editor =
  | { kind: 'account'; id?: number; oldName?: string; name: string; type: AccountType }
  | { kind: 'category'; id?: number; oldName?: string; name: string; direction: Direction }
const ACCOUNT_LABELS: Record<string, string> = { cash: '现金', bank: '银行卡', alipay: '支付宝', wechat: '微信' }
const ACCOUNT_MARKS: Record<string, string> = { cash: '¥', bank: '卡', alipay: '支', wechat: '微' }

export interface AccountsViewProps {
  onGoLedger?: (filter: { month: string; account: string }) => void
  onGoBudget?: () => void
}

/** 管理账户与分类；金额只展示后端返回的已确认流水，不推算真实余额。 */
export function AccountsView({ onGoLedger, onGoBudget }: AccountsViewProps = {}): ReactElement {
  const [month, setMonth] = useState(localMonth)
  const [summary, setSummary] = useState<Summary | null>(null)
  const [categories, setCategories] = useState<Category[]>([])
  const [budget, setBudget] = useState<number | null>(null)
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [budgetError, setBudgetError] = useState<string | null>(null)
  const [editor, setEditor] = useState<Editor | null>(null)
  const [busy, setBusy] = useState(false)
  const [editError, setEditError] = useState<string | null>(null)
  const [notice, setNotice] = useState('')
  const generation = useRef(0)
  const saving = useRef(false)
  const nameInput = useRef<HTMLInputElement>(null)
  const load = useCallback(async () => {
    const turn = ++generation.current
    setLoading(true)
    try {
      const [accounts, cats] = await Promise.all([window.mz.getAccountSummary(month), window.mz.listCategories()])
      if (turn !== generation.current) return
      setSummary(accounts)
      setCategories(cats)
      setLoadError(null)
    } catch (e) {
      if (turn === generation.current) setLoadError(humanError(e))
    } finally {
      if (turn === generation.current) setLoading(false)
    }
  }, [month])
  useEffect(() => {
    void load()
    return () => { generation.current += 1 }
  }, [load])
  useEffect(() => {
    let gone = false
    void window.mz.getSettingsInfo().then(info => {
      if (!gone) { setBudget(info.budgetCents); setBudgetError(null) }
    }).catch(e => { if (!gone) setBudgetError(humanError(e)) })
    return () => { gone = true }
  }, [])
  useEffect(() => {
    const changed = (): void => { void load() }
    const off = window.mz.onChatEvent(evt => {
      if (['record-confirmed', 'gate-executed', 'tx-deleted', 'tx-restored', 'turn-end'].includes(evt.type)) changed()
    })
    window.addEventListener(LEDGER_CHANGED_EVENT, changed)
    return () => { off(); window.removeEventListener(LEDGER_CHANGED_EVENT, changed) }
  }, [load])
  useEffect(() => { if (editor) nameInput.current?.focus() }, [editor?.kind, editor?.id])
  const open = (next: Editor): void => { setEditor(next); setEditError(null); setNotice('') }
  const save = async (event: FormEvent): Promise<void> => {
    event.preventDefault()
    if (!editor || saving.current) return
    if (!editor.name.trim()) { setEditError('名称不能为空'); nameInput.current?.focus(); return }
    saving.current = true
    setBusy(true)
    setEditError(null)
    try {
      if (editor.kind === 'account') {
        if (editor.id === undefined) await window.mz.createAccount({ name: editor.name, type: editor.type })
        else await window.mz.renameAccount({ accountId: editor.id, expectedName: editor.oldName!, newName: editor.name })
      } else {
        if (editor.id === undefined) await window.mz.createCategory({ name: editor.name, kind: editor.direction })
        else await window.mz.renameCategory({ categoryId: editor.id, expectedName: editor.oldName!, newName: editor.name })
      }
      setNotice(editor.id === undefined ? '已添加' : '已保存名称')
      setEditor(null)
      notifyLedgerChanged()
      await load()
    } catch (e) { setEditError(humanError(e)) }
    finally { saving.current = false; setBusy(false) }
  }

  return (
    <section className="mz-accounts" data-testid="accounts-view">
      <header className="mz-accounts-head">
        <div><h1>账户与分类</h1><p>整理记账的去向，不把流水当余额。</p></div>
        <label className="mz-accounts-month">流水月份<input aria-label="账户流水月份" type="month" value={month} onChange={e => { if (e.target.value) setMonth(e.target.value) }} /></label>
      </header>
      <div className="mz-accounts-layout">
        <div className="mz-accounts-content" data-testid="accounts-scroll">
          <section className="mz-accounts-section">
            <div className="mz-accounts-section-head"><div><h2>账户</h2><span>仅统计 {month} 已确认的收支</span></div><button className="mz-btn" data-testid="account-add" onClick={() => open({ kind: 'account', name: '', type: 'bank' })}>＋ 添加账户</button></div>
            {loading && <div className="mz-accounts-loading" data-testid="accounts-loading" role="status">正在读取已记流水…</div>}
            {loadError && <div className="mz-error-card" data-testid="accounts-error" role="alert"><p>账户读取失败：{loadError}</p><button className="mz-btn" data-testid="accounts-retry" onClick={() => void load()}>重试</button></div>}
            {!loading && !loadError && summary && (summary.accounts.length === 0 ? <div className="mz-accounts-empty" data-testid="accounts-empty">还没有账户。添加一个后，就能选择账目记在哪里。</div> :
              <div className="mz-account-list">{summary.accounts.map(a => <article className="mz-account-card" data-testid="account-card" key={a.id}>
                <div className={`mz-account-mark is-${a.kind}`} aria-hidden="true">{ACCOUNT_MARKS[a.kind] ?? '账'}</div>
                <div className="mz-account-name"><h3>{a.name}</h3><span>{ACCOUNT_LABELS[a.kind] ?? a.kind} · {a.currency}</span></div>
                <button className="mz-account-rename" aria-label={`修改账户名称 ${a.name}`} onClick={() => open({ kind: 'account', id: a.id, oldName: a.name, name: a.name, type: a.kind as AccountType })}>改名</button>
                <div className="mz-account-flows"><div><span>已记支出</span><strong data-testid="account-expense">{money(a.expenseCents)}</strong></div><div><span>已记收入</span><strong data-testid="account-income">{money(a.incomeCents)}</strong></div></div>
                <div className="mz-account-footer"><span data-testid="account-count">{a.count} 笔已确认收支</span><button data-testid="account-ledger" disabled={!onGoLedger} onClick={() => onGoLedger?.({ month: summary.month, account: a.name })}>查看流水 <span aria-hidden="true">↗</span></button></div>
              </article>)}</div>)}
          </section>
          <section className="mz-accounts-section" data-testid="category-management">
            <div className="mz-accounts-section-head"><div><h2>分类</h2><span>改名不会改变历史金额和收支方向</span></div><button className="mz-btn" data-testid="category-add" onClick={() => open({ kind: 'category', name: '', direction: 'expense' })}>＋ 添加分类</button></div>
            {(['expense', 'income'] as const).map(direction => <div className="mz-category-group" key={direction}><h3>{direction === 'expense' ? '支出分类' : '收入分类'}</h3><div className="mz-category-tags">{categories.filter(c => c.kind === direction).map(c => <button key={c.id} data-testid="category-item" aria-label={`修改${direction === 'expense' ? '支出' : '收入'}分类 ${c.name}`} onClick={() => open({ kind: 'category', id: c.id, oldName: c.name, name: c.name, direction })}>{c.name}<span aria-hidden="true">↗</span></button>)}{!loading && !loadError && categories.filter(c => c.kind === direction).length === 0 && <span className="mz-accounts-muted">还没有这类分类</span>}</div></div>)}
          </section>
        </div>
        <aside className="mz-accounts-aside">
          {editor ? <form className="mz-account-editor" data-testid="account-editor" onSubmit={e => void save(e)}>
            <span className="mz-accounts-eyebrow">{editor.id === undefined ? '新增' : '改名'}</span><h2>{editor.kind === 'account' ? '账户' : '分类'}</h2>
            <label>名称<input ref={nameInput} data-testid="management-name" aria-label={editor.kind === 'account' ? '账户名称' : '分类名称'} maxLength={100} value={editor.name} disabled={busy} onChange={e => setEditor({ ...editor, name: e.target.value })} /></label>
            {editor.kind === 'account' && editor.id === undefined && <label>账户类型<select aria-label="账户类型" value={editor.type} disabled={busy} onChange={e => setEditor({ ...editor, type: e.target.value as AccountType })}>{Object.entries(ACCOUNT_LABELS).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label>}
            {editor.kind === 'category' && <label>收支方向<select aria-label="分类方向" disabled={busy || editor.id !== undefined} value={editor.direction} onChange={e => setEditor({ ...editor, direction: e.target.value as Direction })}><option value="expense">支出</option><option value="income">收入</option></select></label>}
            <p>{editor.id === undefined ? '这个操作只修改本地账本，不调用模型。' : '保留原有引用；关联账目不会被重新记账。'}</p>
            {editError && <div className="mz-accounts-edit-error" data-testid="management-error" role="alert">{editError}</div>}
            <div className="mz-account-editor-actions"><button className="mz-btn" type="button" disabled={busy} onClick={() => setEditor(null)}>取消</button><button className="mz-btn mz-btn-primary" data-testid="management-save" type="submit" disabled={busy}>{busy ? '保存中…' : editor.id === undefined ? '确认添加' : '保存名称'}</button></div>
          </form> : <>
            {notice && <p className="mz-accounts-notice" data-testid="management-notice" role="status">✓ {notice}</p>}
            <div className="mz-accounts-budget"><span className="mz-accounts-eyebrow">每月预算</span><strong>{budgetError ? '暂时无法读取' : budget === null ? '读取中…' : budget > 0 ? money(budget) : '尚未设置'}</strong><p>预算是支出计划，不是账户余额。</p><button className="mz-btn" data-testid="accounts-budget" disabled={!onGoBudget} onClick={onGoBudget}>到设置修改预算 <span aria-hidden="true">↗</span></button>{budgetError && <span className="mz-accounts-edit-error">{budgetError}</span>}</div>
            <div className="mz-accounts-scope"><h2>这里展示什么？</h2><p>只展示已经记入账本、并由你确认的收支。</p><p>待确认、已删除、转账和不计收支不计入这两项合计。</p><div className="mz-accounts-scope-note">没有期初余额与完整历史，就不能据此算出银行卡的真实余额。</div></div>
          </>}
        </aside>
      </div>
    </section>
  )
}
