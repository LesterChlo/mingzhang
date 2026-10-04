import { humanError } from '../lib/ledgerFilter'
import { useEffect, useState } from 'react'
import type { CategoryRuleDTO } from '../../../shared/types'

/** Explicit user actions only; no model-triggered preference writes. */
export function CategoryRulesManager({ onClose, returnLabel = '返回这批账单' }: { onClose: () => void; returnLabel?: string }) {
  const [rules, setRules] = useState<CategoryRuleDTO[]>([])
  const [categories, setCategories] = useState<{ id: number; name: string; kind: string }[]>([])
  const [busy, setBusy] = useState(true)
  const [error, setError] = useState('')
  const [choices, setChoices] = useState<Record<number, number>>({})
  const load = async () => {
    const [r, c] = await Promise.all([window.mz.listCategoryRules(), window.mz.listCategories()])
    setRules(r); setCategories(c)
  }
  useEffect(() => { let active = true; Promise.all([window.mz.listCategoryRules(), window.mz.listCategories()]).then(([r,c]) => { if (active) { setRules(r); setCategories(c) } }).catch(e => { if (active) setError(humanError(e)) }).finally(() => { if (active) setBusy(false) }); return () => { active = false } }, [])
  const act = async (rule: CategoryRuleDTO, disable: boolean) => {
    if (busy) return
    setBusy(true); setError('')
    try {
      if (disable) await window.mz.deactivateCategoryRule({ ruleId: rule.id, expectedVersion: rule.version })
      else {
        const categoryId = choices[rule.id]
        if (!categoryId) throw new Error('请先选择新的分类。')
        const result = await window.mz.updateCategoryRule({ ruleId: rule.id, expectedVersion: rule.version, categoryId, expectedRules: rules.filter(r => r.active).map(r => ({ id: r.id, version: r.version })), replaceConflicts: false })
        if (result.status === 'conflict') throw new Error('存在冲突规则，未保存。请先核对并停用冲突规则，再修改。')
      }
      await load(); setChoices({})
    } catch (e) { setError(humanError(e)) }
    finally { setBusy(false) }
  }
  return <section className="mz-review mz-review-scroll" data-testid="category-rules-manager"><header className="mz-review-heading"><div><h2>分类习惯</h2><p>这是你明确保存的商户分类，只影响下次建议，不追改历史账目。</p></div><button disabled={busy} onClick={onClose}>{returnLabel}</button></header>
    {error && <p role="alert" className="mz-review-error">{error}</p>}
    {busy && <p role="status">正在读取或保存…</p>}
    {!busy && !rules.length && <div className="mz-habits-empty"><h3>还没有保存分类习惯</h3><p>处理账单后，选择“下次也这样分”，这里就会出现对应商户。<br />不保存也能正常记账。</p></div>}
    {rules.map(r => <div className="mz-review-row" key={r.id}><div className="mz-review-merchant"><strong>{r.merchant || '损坏的规则'}</strong><small>{r.op === 'contains' ? '包含匹配' : '精确匹配'} · {r.direction === 'income' ? '收入' : r.direction === 'expense' ? '支出' : '所有方向（旧规则）'} · {r.active ? '生效中' : '已停用'}</small>{!r.direction && <small>旧规则请停用后，从复核结果重新保存。</small>}</div><span>{r.categoryName || '无效分类'}</span>
      {r.active && r.valid && r.direction && <><select aria-label={`规则${r.id}的新分类`} disabled={busy} value={choices[r.id] || ''} onChange={e => setChoices(v => ({ ...v, [r.id]: Number(e.target.value) }))}><option value="">改为…</option>{categories.filter(c => c.kind === r.direction).map(c => <option key={c.id} value={c.id}>{c.name}</option>)}</select><button disabled={busy || !choices[r.id]} onClick={() => void act(r, false)}>保存修改</button></>}
      {r.active && <button disabled={busy} onClick={() => void act(r, true)}>停用规则</button>}
    </div>)}
  </section>
}
