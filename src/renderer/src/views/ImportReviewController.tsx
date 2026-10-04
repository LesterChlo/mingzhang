import { humanError } from '../lib/ledgerFilter'
import { useEffect, useState } from 'react'
import type { ClassifyProposalDTO } from '../../../shared/types'
import { ImportReviewWorkspace, type ReviewSelection } from './ImportReviewWorkspace'
import { CategoryRulesManager } from './CategoryRulesManager'
import { SaveReviewedRules, type ReviewedRuleCandidate } from './SaveReviewedRules'

export function ImportReviewController({ batchId, onClose, onApplied }: { batchId: string; onClose: () => void; onApplied: () => Promise<void> }) {
  const [proposal, setProposal] = useState<ClassifyProposalDTO | null>(null)
  const [categories, setCategories] = useState<{ id: number; name: string; kind: string }[]>([])
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [ruleCandidates, setRuleCandidates] = useState<{ gateId: number; classifyId: string; candidates: ReviewedRuleCandidate[] }[]>([])
  const safeClose = () => {
    if (ruleCandidates.length && !window.confirm('已执行的分类结果可重新打开恢复。尚未提交的选择和本地提示可能不保留；关闭不会撤销账目或自动保存规则。确定关闭？')) return
    onClose()
  }
  const undo = async (classifyId: string) => {
    if (busy) return
    setBusy(true); setError(null)
    try {
      const result = await window.mz.undoClassify(classifyId)
      setRuleCandidates(v => v.filter(r => r.classifyId !== classifyId))
      setProposal(await window.mz.getClassifyProposal(batchId))
      await onApplied()
      window.alert('分类撤销结果：' + JSON.stringify(result) + '。独立保存的规则仍保留，可在规则管理中停用。')
    } catch (e) { setError(humanError(e)) } finally { setBusy(false) }
  }
  const [manageRules, setManageRules] = useState(false)
  const [step, setStep] = useState<'check' | 'result'>('check')
  const [remember, setRemember] = useState(false)
  const [reload, setReload] = useState(0)
  const restoreResults = async () => {
    const results = await window.mz.getClassifyResults(batchId)
    setRuleCandidates(results.filter(r => r.candidates.length || r.undo.revertibleCount > 0).map(r => ({ gateId: r.gateId, classifyId: r.classifyId, candidates: r.candidates.map(c => ({ groupKey: c.groupKey, merchant: c.merchant, categoryId: c.categoryId, categoryName: c.categoryName, direction: c.txType })) })))
  }
  useEffect(() => {
    void restoreResults().catch(e => setError(humanError(e)))
    let active = true
    setProposal(null)
    setError(null)
    Promise.all([window.mz.getClassifyProposal(batchId), window.mz.listCategories()]).then(([p, c]) => {
      if (active) { setProposal(p); setCategories(c) }
    }).catch(e => { if (active) setError(humanError(e)) })
    return () => { active = false }
  }, [batchId, reload])
  const confirm = async (selection: ReviewSelection[]) => {
    if (busy || !proposal) return
    setBusy(true); setError(null)
    try {
      const assignments = selection.map(s => {
        const group = proposal.groups.find(g => g.groupKey === s.key)
        if (!group) throw new Error('分组已变化，请重新打开复核。')
        const cat = categories.find(c => c.name === s.category && c.kind === group.txType)
        if (!cat) throw new Error(`分类「${s.category}」与交易方向不符，请重新选择。`)
        return { groupKey: s.key, categoryName: cat.name, categoryId: cat.id, txIds: s.txIds }
      })
      const prepared = await window.mz.prepareClassify({ batchId, assignments, expectedProposalVersion: proposal.proposalVersion })
      const result = await window.mz.applyClassify(prepared.gateId)
      if (!result) throw new Error('确认门已失效或已执行，请刷新后核对。')
      setRuleCandidates(v => [...v, { gateId: prepared.gateId, classifyId: prepared.classifyId, candidates: assignments.flatMap(a => { const g = proposal.groups.find(g => g.groupKey === a.groupKey); return g?.merchant ? [{ groupKey: a.groupKey, merchant: g.merchant, categoryId: a.categoryId, categoryName: a.categoryName, direction: g.txType }] : [] }) }])
      setProposal(await window.mz.getClassifyProposal(batchId))
      await onApplied()
      setStep('result'); setRemember(false)
    } catch (e) { setError(humanError(e)) }
    finally { setBusy(false) }
  }
  if (manageRules) return <CategoryRulesManager onClose={() => { setManageRules(false); setReload(v => v + 1) }} />
  if (proposal && step === 'result') return <section className="mz-review mz-review-scroll" data-testid="review-complete"><div className="mz-complete-check">✓</div><h2>{proposal.pendingCount ? '这次分类已确认' : '这批账处理好了'}</h2><p>{proposal.pendingCount ? `还有 ${proposal.pendingCount} 笔待检查，可以稍后继续。` : '本批待分类记录已处理完成。'} 分类确认不会自动保存长期习惯。</p>{error && <p role="alert" className="mz-review-error">{error}</p>}<div className="mz-complete-actions"><button onClick={onClose}>返回这批账单</button>{proposal.pendingCount > 0 && <button disabled={busy} onClick={() => setStep('check')}>继续检查剩余记录</button>}</div><section className="mz-remember-card"><h3>下次也这样分？</h3><p>可选。你明确保存的商户，下次会沿用分类建议。不保存也能正常记账。</p><button onClick={() => setRemember(v => !v)}>{remember ? '收起商户选择' : '选择要记住的商户'}</button><button onClick={onClose}>这次就好</button>{remember && ruleCandidates.map(r => <SaveReviewedRules key={r.gateId} gateId={r.gateId} candidates={r.candidates} />)}</section><details><summary>本次结果与撤销</summary>{ruleCandidates.map(r => <div key={r.gateId}><button disabled={busy} onClick={() => void undo(r.classifyId)}>撤销这次分类</button><small>独立保存的分类习惯不会删除。</small></div>)}</details></section>
  if (!proposal) return <section className="mz-review" aria-busy={!error}><p role={error ? 'alert' : undefined}>{error || '正在读取本批待分类记录…'}</p>{error && <button onClick={() => setReload(v => v + 1)}>重试</button>}<button onClick={onClose}>关闭</button></section>
  return <div className="mz-review-scroll" data-testid="review-scroll"><div className="mz-review-breadcrumb">本批账单 / 检查分类</div><ImportReviewWorkspace key={`${batchId}:${proposal.generatedAt}`} groups={proposal.groups.map(g => ({ key: g.groupKey, merchant: g.merchant || '未命名商户', direction: g.txType, count: g.count, amountCents: g.totalCents, details: g.details, suggestedCategory: g.suggestedCategory, source: g.suggestionSource === 'rule' ? '用户规则' : g.suggestionSource === 'builtin' ? '内置建议' : g.ruleStatus === 'conflict' ? `规则冲突（${g.ruleIds.join('、')}），请管理规则` : g.ruleStatus === 'invalid' ? '规则损坏，请管理规则' : '待人工决定' }))} categories={categories.map(c => c.name)} busy={busy} error={error} onConfirm={s => void confirm(s)} onClose={safeClose} />{ruleCandidates.length > 0 && <button onClick={() => { setStep('result'); setRemember(false) }}>查看已确认结果 / 撤销</button>}</div>
}
