import { humanError } from '../lib/ledgerFilter'
import { useRef, useState } from 'react'
import type { SaveCategoryRuleInput } from '../../../shared/types'
export interface ReviewedRuleCandidate { groupKey: string; merchant: string; categoryId: number; categoryName: string; direction: string }
export function SaveReviewedRules({ gateId, candidates }: { gateId: number; candidates: ReviewedRuleCandidate[] }) {
  const [busy, setBusy] = useState(false)
  const [messages, setMessages] = useState<Record<string, string>>({})
  const [saved, setSaved] = useState<Record<string, boolean>>({})
  const requests = useRef<Record<string, SaveCategoryRuleInput>>({})
  const save = async (candidate: ReviewedRuleCandidate) => {
    if (busy) return
    setBusy(true)
    try {
      let input = requests.current[candidate.groupKey]
      if (!input) {
        const rules = await window.mz.listCategoryRules()
        input = { requestId: crypto.randomUUID(), gateId, groupKey: candidate.groupKey, categoryId: candidate.categoryId, expectedRules: rules.filter(r => r.active).map(r => ({ id: r.id, version: r.version })), replaceConflicts: false }
        requests.current[candidate.groupKey] = input
      }
      const result = await window.mz.saveCategoryRule(input)
      if (result.status === 'conflict') {
        setMessages(v => ({ ...v, [candidate.groupKey]: `未保存，与这些规则冲突：${result.conflicts.map(r => `${r.merchant}（${r.op === 'contains' ? '包含' : '精确'}，${r.direction || '所有方向'}）→ ${r.categoryName}`).join('；')}。请在规则管理中核对，停用后重新准备。` }))
      } else {
        setSaved(v => ({ ...v, [candidate.groupKey]: true }))
        setMessages(v => ({ ...v, [candidate.groupKey]: '规则已保存，下次将提供分类建议。' }))
      }
    } catch (e) { setMessages(v => ({ ...v, [candidate.groupKey]: humanError(e) })) }
    finally { setBusy(false) }
  }
  return <section className="mz-review" data-testid="save-reviewed-rules"><h3>要记住的商户</h3><p>只有在这里点保存的商户才会变成习惯；不会改历史账目。</p>{candidates.map(c => <div key={c.groupKey}><div className="mz-review-row"><div className="mz-review-merchant"><strong>{c.merchant} → {c.categoryName}</strong><small>精确商户匹配 · {c.direction === 'income' ? '收入' : '支出'}</small></div><button disabled={busy || saved[c.groupKey]} onClick={() => void save(c)}>{saved[c.groupKey] ? '已保存' : '保存这条规则'}</button>{messages[c.groupKey] && !saved[c.groupKey] && <button disabled={busy} onClick={() => { delete requests.current[c.groupKey]; setMessages(v => ({ ...v, [c.groupKey]: '已清除旧请求；再次点击保存将重新读取规则状态。' })) }}>重新准备</button>}</div>{messages[c.groupKey] && <p role="status">{messages[c.groupKey]}</p>}</div>)}</section>
}
