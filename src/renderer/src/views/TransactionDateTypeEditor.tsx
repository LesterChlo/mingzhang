import { useCallback, useEffect, useRef, useState, type ReactElement } from 'react'
import type { TransactionDateTypeEditInput, TransactionEditFormDTO, TxDetailDTO } from '../../../shared/types'
import { useInbox } from '../shell/inboxStore'
import { humanError } from '../lib/ledgerFilter'
import { txTypeLabel } from '../lib/shellFormat'
import '../styles/transaction-date-type.css'

/** Split the stored local clock; never round-trip through Date/UTC or invent a time. */
function occurrenceParts(value: string): { date: string; time: string; separator: string; zone: string } | null {
  const match = /^(\d{4}-\d{2}-\d{2})(?:([ T])(\d{2}:\d{2}(?::\d{2})?)(Z|[+-]\d{2}:\d{2})?)?$/.exec(value)
  return match ? { date: match[1], separator: match[2] ?? '', time: match[3] ?? '', zone: match[4] ?? '' } : null
}

export function TransactionDateTypeEditor({ txId, revision, disabled, onBusyChange, onSaved }: {
  txId: number
  revision: TxDetailDTO
  disabled: boolean
  onBusyChange: (busy: boolean) => void
  onSaved: () => Promise<void>
}): ReactElement {
  const { categories } = useInbox()
  const [form, setForm] = useState<TransactionEditFormDTO | null>(null)
  const [date, setDate] = useState('')
  const [time, setTime] = useState('')
  const [direction, setDirection] = useState('')
  const [category, setCategory] = useState('')
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const generation = useRef(0)
  const savingRef = useRef(false)

  const readForm = useCallback(async (): Promise<void> => {
    const request = ++generation.current
    setLoading(true)
    setError(null)
    try {
      const next = await window.mz.getTransactionEditForm(txId)
      if (generation.current !== request) return
      if (!next) throw new Error('这笔交易不存在，请关闭详情后重新选择。')
      const parts = occurrenceParts(next.occurredAt)
      setForm(next)
      setDate(parts?.date ?? '')
      setTime(parts?.time ?? '')
      setDirection(next.txType)
      setCategory(next.categoryId == null ? '' : String(next.categoryId))
      if (!parts) setError('原发生时间格式暂不支持编辑，原值未改动。')
    } catch (e) {
      if (generation.current === request) {
        setForm(null)
        setError(humanError(e))
      }
    } finally {
      if (generation.current === request) setLoading(false)
    }
  }, [txId])

  useEffect(() => {
    void readForm()
    return () => { generation.current += 1 }
  }, [readForm, revision])

  const original = form ? occurrenceParts(form.occurredAt) : null
  const canChangeType = form?.txType === 'expense' || form?.txType === 'income'
  const typeChanged = Boolean(form && direction !== form.txType)
  const dateChanged = Boolean(original && (date !== original.date || time !== original.time))
  const sameDirectionCategories = categories.filter((c) => c.kind === direction)
  const categoryReady = !typeChanged || sameDirectionCategories.some((c) => String(c.id) === category)
  const locked = disabled || loading || saving || form?.state === 'deleted'
  const canSave = !locked && original && date && (dateChanged || typeChanged) && categoryReady

  const save = async (): Promise<void> => {
    if (!canSave || !form || !original || savingRef.current) return
    const request = generation.current
    const fields: TransactionDateTypeEditInput['fields'] = {}
    if (dateChanged) fields.occurredAt = date + (time ? `${original.separator || 'T'}${time}${original.zone}` : '')
    if (typeChanged && (direction === 'income' || direction === 'expense')) {
      fields.txType = direction
      fields.categoryId = Number(category)
    }
    savingRef.current = true
    setSaving(true)
    onBusyChange(true)
    setError(null)
    setNotice(null)
    try {
      const result = await window.mz.editTx(txId, { op: 'dateType', expectedVersion: form.version, fields })
      if (result.status !== 'ok') throw new Error(result.message)
      if (generation.current === request) setNotice(result.message)
      await onSaved()
    } catch (e) {
      // Keep the draft and its original version. Never refresh/rebase and replay a rejected write.
      if (generation.current === request) setError(humanError(e))
    } finally {
      savingRef.current = false
      setSaving(false)
      onBusyChange(false)
    }
  }

  return (
    <form className="mz-date-edit" data-testid="ledger-date-type" aria-busy={loading} onSubmit={(e) => { e.preventDefault(); void save() }}>
      <div className="mz-date-edit-head">
        <span className="mz-field-lb">日期与收支</span>
        <span className="mz-date-edit-caption">单独保存</span>
      </div>
      <div className="mz-date-edit-grid">
        <label>
          <span>发生日期</span>
          <input className="mz-input mz-num" aria-label="发生日期" data-testid="ledger-edit-date" type="date" required value={date} disabled={locked || !original} onChange={(e) => { setDate(e.target.value); setNotice(null) }} />
        </label>
        <label>
          <span>时间<span className="mz-date-edit-optional"> · 可留空</span></span>
          <input className="mz-input mz-num" aria-label="发生时间" data-testid="ledger-edit-time" type="time" step="1" value={time} disabled={locked || !original} onChange={(e) => { setTime(e.target.value); setNotice(null) }} />
        </label>
      </div>
      {original?.zone && <div className="mz-date-edit-hint">保留原时区 {original.zone === 'Z' ? 'UTC' : `UTC${original.zone}`}</div>}
      <label className="mz-date-edit-direction">
        <span>收支类型</span>
        <select className="mz-select" aria-label="收支类型" data-testid="ledger-edit-direction" value={direction} disabled={locked || !canChangeType} onChange={(e) => { setDirection(e.target.value); setCategory(e.target.value === form?.txType && form.categoryId != null ? String(form.categoryId) : ''); setNotice(null) }}>
          <option value="expense">支出</option>
          <option value="income">收入</option>
          {!canChangeType && form && <option value={form.txType}>{txTypeLabel(form.txType)}</option>}
        </select>
      </label>
      {typeChanged && (
        <label className="mz-date-edit-category">
          <span>新的{direction === 'income' ? '收入' : '支出'}分类</span>
          <select className="mz-select" aria-label="对应收支分类" data-testid="ledger-edit-direction-category" required value={category} disabled={locked} onChange={(e) => setCategory(e.target.value)}>
            <option value="">请明确选择分类</option>
            {sameDirectionCategories.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
          </select>
        </label>
      )}
      {!canChangeType && form && <div className="mz-date-edit-hint">{txTypeLabel(form.txType)}只修改发生时间，不转换为收入或支出。</div>}
      {form?.state === 'deleted' && <div className="mz-date-edit-hint">已删除的记录请先恢复再修改。</div>}
      {error && <div className="mz-date-edit-error" data-testid="ledger-date-type-error" role="alert">未保存：{error}<br />请重新读取并核对后再保存。</div>}
      {notice && <div className="mz-date-edit-notice" data-testid="ledger-date-type-notice" role="status">{notice}</div>}
      <div className="mz-date-edit-actions">
        <button className="mz-btn mz-btn-ghost mz-btn-sm" type="button" data-testid="ledger-refresh-date-type" disabled={disabled || loading || saving} onClick={() => { setNotice(null); void readForm() }}>重新读取</button>
        <button className="mz-btn mz-btn-primary mz-btn-sm" type="submit" data-testid="ledger-save-date-type" disabled={!canSave}>{saving ? '保存中…' : '保存修改'}</button>
      </div>
    </form>
  )
}
