import { useMemo, useState } from 'react'
import './import-review-workspace.css'

export interface ReviewGroupView {
  key: string
  merchant: string
  direction: 'income' | 'expense'
  count: number
  amountCents: number
  suggestedCategory: string | null
  source: string
  details: { txId: number; occurredAt: string | null; amountCents: number; description: string | null }[]
}
export interface ReviewSelection { key: string; category: string; txIds: number[] }
export interface ImportReviewWorkspaceProps {
  groups: ReviewGroupView[]
  categories: string[]
  busy: boolean
  error?: string | null
  onConfirm: (selection: ReviewSelection[]) => void
  onClose: () => void
}
/** Presentation-only: callers supply authoritative batch data and perform gate validation. */
export function ImportReviewWorkspace({ groups, categories, busy, error, onConfirm, onClose }: ImportReviewWorkspaceProps) {
  const [choices, setChoices] = useState<Record<string, string>>({})
  const [selected, setSelected] = useState<Record<string, boolean>>({})
  const [excluded, setExcluded] = useState<Record<number, boolean>>({})
  const ids = (g: ReviewGroupView) => g.details.filter(d => !excluded[d.txId]).map(d => d.txId)
  const [query, setQuery] = useState('')
  const [validation, setValidation] = useState('')
  const amount = (cents: number) => (cents / 100).toLocaleString('zh-CN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
  const category = (g: ReviewGroupView) => choices[g.key] ?? g.suggestedCategory ?? ''
  const picked = (g: ReviewGroupView) => selected[g.key] ?? Boolean(g.suggestedCategory)
  const visible = groups.filter(g => g.merchant.includes(query.trim()))
  const totals = useMemo(() => groups.reduce((a, g) => ({ count: a.count + g.count, income: a.income + (g.direction === 'income' ? g.amountCents : 0), expense: a.expense + (g.direction === 'expense' ? g.amountCents : 0) }), { count: 0, income: 0, expense: 0 }), [groups])
  const chosen = groups.filter(g => picked(g) && ids(g).length > 0)
  const submit = () => {
    if (chosen.some(g => !category(g))) { setValidation('请为选中商户指定分类，或取消选择。'); return }
    setValidation('')
    onConfirm(chosen.map(g => ({ key: g.key, category: category(g), txIds: ids(g) })))
  }
  return <section className="mz-review" data-testid="import-review-workspace" aria-label="本批分类复核">
    <header className="mz-review-heading"><div><h2>检查分类</h2><p>先勾选要处理的商户，再为它选择分类，最后确认所选记录。只修改分类，不会重复记账。</p></div><button type="button" disabled={busy} onClick={onClose} aria-label="关闭分类复核">关闭</button></header>
    <div className="mz-review-layout"><div className="mz-review-list">
      <div className="mz-review-toolbar"><span>{groups.length} 组商户</span><input aria-label="搜索待分类商户" placeholder="搜索商户" value={query} onChange={e => setQuery(e.target.value)} /></div>
      {visible.length === 0 && <p className="mz-review-empty">{groups.length ? '没有匹配的商户' : '本批没有待分类记录'}</p>}
      {visible.map(g => <div key={g.key}><div className="mz-review-row">
        <input type="checkbox" disabled={busy} aria-label={`选择 ${g.merchant}`} checked={picked(g) && ids(g).length > 0} ref={el => { if (el) el.indeterminate = picked(g) && ids(g).length > 0 && ids(g).length < g.details.length }} onChange={e => { const checked = e.target.checked; setSelected(v => ({ ...v, [g.key]: checked })); if (checked) setExcluded(v => { const next = { ...v }; g.details.forEach(d => { delete next[d.txId] }); return next }) }} />
        <span className="mz-review-avatar" aria-hidden="true">{g.merchant.slice(0, 1)}</span>
        <div className="mz-review-merchant"><strong>{g.merchant}</strong><small>{g.count} 笔 · {g.direction === 'income' ? '收入' : '支出'} · {g.source}</small></div>
        <span className="mz-review-amount">{g.direction === 'income' ? '+' : '−'}{amount(g.amountCents)}</span>
        <select disabled={busy} aria-label={`${g.merchant}分类`} value={category(g)} onChange={e => setChoices(v => ({ ...v, [g.key]: e.target.value }))}><option value="">请选择分类</option>{Array.from(new Set([...categories, ...(g.suggestedCategory ? [g.suggestedCategory] : [])])).map(c => <option key={c} value={c}>{c}</option>)}</select>
      </div><details><summary>查看明细 / 排除个别记录</summary>{g.details.map(d => <label key={d.txId} style={{ display: 'flex', gap: 12, padding: '8px 16px' }}><input type="checkbox" aria-label={`包含交易${d.txId}`} disabled={busy} checked={!excluded[d.txId]} onChange={e => setExcluded(v => ({ ...v, [d.txId]: !e.target.checked }))} /><span>{d.occurredAt?.slice(0, 10) || '日期未知'} · {d.description || '无备注'}</span><span>¥{amount(d.amountCents)}</span></label>)}</details></div>)}
      {(error || validation) && <p role="alert" className="mz-review-error">{error || validation}</p>}
      <footer className="mz-review-actions"><span>已选 {chosen.reduce((n, g) => n + ids(g).length, 0)} 笔</span><button type="button" disabled={busy || !chosen.length} onClick={submit}>{busy ? '正在确认…' : `确认所选 ${chosen.reduce((n, g) => n + ids(g).length, 0)} 笔`}</button></footer>
    </div><aside className="mz-review-summary"><h3>本批待分类</h3><strong className="mz-review-total">{totals.count}<small> 笔</small></strong><dl><div><dt>支出合计</dt><dd>¥{amount(totals.expense)}</dd></div><div><dt>收入合计</dt><dd>¥{amount(totals.income)}</dd></div></dl><p>仅统计本次复核范围，不代表整个批次或整月收支。</p><div className="mz-review-assurance">只修改分类，不改变原始金额。<br />长期规则需要另行确认保存。</div></aside></div>
  </section>
}
