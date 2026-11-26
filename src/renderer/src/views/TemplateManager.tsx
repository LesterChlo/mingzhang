// 快捷记账模板管理（第八阶段）。
// 用途：把一次常用记账存成模板（商品/规格/渠道/数量/单价/备注），下次一键带出。
// 排序由后端负责（常用优先），前端提供增/删/改名与类型筛选。

import { useCallback, useState } from 'react'
import type { ReactElement } from 'react'
import type { ProductWithVariantsDTO, QuickTemplateDTO, TemplateKindDTO } from '../../../shared/types'
import {
  createTemplate, updateTemplate, deleteTemplate,
  money, yuanToCents, humanError, TEMPLATE_KIND_LABEL,
} from '../lib/business'
import { NumberField } from './NumberField'

export interface TemplateManagerProps {
  products: ProductWithVariantsDTO[]
  templates: QuickTemplateDTO[]
  onRefresh: () => Promise<void>
  onToast: (msg: string) => void
  onError: (msg: string) => void
}

const KINDS: TemplateKindDTO[] = ['sale', 'purchase', 'refund', 'expense', 'cs_income', 'other']

export function TemplateManager({ products, templates, onRefresh, onToast, onError }: TemplateManagerProps): ReactElement {
  const [filter, setFilter] = useState<'all' | TemplateKindDTO>('all')
  const [adding, setAdding] = useState(false)
  const [editingId, setEditingId] = useState<number | null>(null)
  const [editName, setEditName] = useState('')

  // 新建表单
  const [kind, setKind] = useState<TemplateKindDTO>('sale')
  const [name, setName] = useState('')
  const [productId, setProductId] = useState('')
  const [variantId, setVariantId] = useState('')
  const [channel, setChannel] = useState('')
  const [qty, setQty] = useState('1')
  const [price, setPrice] = useState('')

  const selectedProduct = products.find((p) => String(p.id) === productId)

  const resetForm = useCallback(() => {
    setName(''); setProductId(''); setVariantId(''); setChannel(''); setQty('1'); setPrice('')
    setKind('sale'); setAdding(false)
  }, [])

  const submit = useCallback(async () => {
    const trimmed = name.trim()
    if (!trimmed) { onError('请填写模板名称'); return }
    try {
      await createTemplate({
        name: trimmed,
        kind,
        product_id: productId ? parseInt(productId, 10) : null,
        variant_id: variantId ? parseInt(variantId, 10) : null,
        channel: channel.trim() || null,
        default_qty: qty ? parseFloat(qty) : null,
        default_price_cents: price ? yuanToCents(price) : null,
        note: null,
      })
      onToast(`模板「${trimmed}」已保存`)
      resetForm()
      await onRefresh()
    } catch (e) {
      onError(humanError(e))
    }
  }, [name, kind, productId, variantId, channel, qty, price, onToast, onError, onRefresh, resetForm])

  const saveName = useCallback(async (t: QuickTemplateDTO) => {
    const trimmed = editName.trim()
    if (!trimmed) { onError('模板名称不能为空'); return }
    try {
      await updateTemplate({ id: t.id, name: trimmed })
      onToast('已重命名')
      setEditingId(null)
      await onRefresh()
    } catch (e) {
      onError(humanError(e))
    }
  }, [editName, onToast, onError, onRefresh])

  const remove = useCallback(async (t: QuickTemplateDTO) => {
    if (!window.confirm(`确定删除模板「${t.name}」？`)) return
    try {
      await deleteTemplate(t.id)
      onToast('已删除')
      await onRefresh()
    } catch (e) {
      onError(humanError(e))
    }
  }, [onToast, onError, onRefresh])

  const shown = filter === 'all' ? templates : templates.filter((t) => t.kind === filter)

  return (
    <div className="mz-biz-tpl">
      <div className="mz-biz-toolbar">
        <div className="mz-biz-range">
          <button
            type="button"
            className={`mz-biz-range-btn${filter === 'all' ? ' is-active' : ''}`}
            onClick={() => setFilter('all')}
          >
            全部（{templates.length}）
          </button>
          {KINDS.map((k) => {
            const n = templates.filter((t) => t.kind === k).length
            return (
              <button
                key={k}
                type="button"
                className={`mz-biz-range-btn${filter === k ? ' is-active' : ''}`}
                onClick={() => setFilter(k)}
              >
                {TEMPLATE_KIND_LABEL[k]}（{n}）
              </button>
            )
          })}
        </div>
        {!adding && (
          <button type="button" className="mz-biz-btn is-primary" onClick={() => setAdding(true)}>
            + 新建模板
          </button>
        )}
      </div>

      {/* 新建表单 */}
      {adding && (
        <div className="mz-biz-tpl-form">
          <h3>新建快捷模板</h3>
          <p className="mz-biz-hint">存好后在对应记账页顶部可一键套用，常用的会自动排前面。</p>
          <div className="mz-biz-row">
            <div className="mz-biz-field">
              <label className="mz-biz-label">模板名称</label>
              <div className="mz-biz-input">
                <input type="text" value={name} onChange={(e) => setName(e.target.value)} placeholder="如：猫粮1kg常卖" autoFocus />
              </div>
            </div>
            <div className="mz-biz-field">
              <label className="mz-biz-label">记账类型</label>
              <div className="mz-biz-input">
                <select value={kind} onChange={(e) => setKind(e.target.value as TemplateKindDTO)}>
                  {KINDS.map((k) => <option key={k} value={k}>{TEMPLATE_KIND_LABEL[k]}</option>)}
                </select>
              </div>
            </div>
          </div>

          {(kind === 'sale' || kind === 'purchase' || kind === 'refund') && (
            <div className="mz-biz-row">
              <div className="mz-biz-field">
                <label className="mz-biz-label">商品</label>
                <div className="mz-biz-input">
                  <select
                    value={productId}
                    onChange={(e) => {
                      const next = products.find((p) => String(p.id) === e.target.value)
                      setProductId(e.target.value)
                      setVariantId(next?.variants[0] ? String(next.variants[0].id) : '')
                    }}
                  >
                    <option value="">不限</option>
                    {products.map((p) => <option key={p.id} value={p.id}>{p.brand} / {p.name}</option>)}
                  </select>
                </div>
              </div>
              <div className="mz-biz-field">
                <label className="mz-biz-label">规格</label>
                <div className="mz-biz-input">
                  <select value={variantId} onChange={(e) => setVariantId(e.target.value)} disabled={!selectedProduct}>
                    {!selectedProduct && <option value="">先选商品</option>}
                    {selectedProduct?.variants.map((v) => (
                      <option key={v.id} value={v.id}>{v.spec_name}</option>
                    ))}
                  </select>
                </div>
              </div>
            </div>
          )}

          <div className="mz-biz-row">
            <div className="mz-biz-field">
              <label className="mz-biz-label">渠道</label>
              <div className="mz-biz-input">
                <input type="text" value={channel} onChange={(e) => setChannel(e.target.value)} placeholder="如：微信收入" />
              </div>
            </div>
            <div className="mz-biz-field">
              <label className="mz-biz-label">默认数量</label>
              <div className="mz-biz-input">
                <NumberField value={qty} onChange={setQty} ariaLabel="默认数量" />
              </div>
            </div>
            <div className="mz-biz-field">
              <label className="mz-biz-label">默认单价（元）</label>
              <div className="mz-biz-input">
                <NumberField value={price} onChange={setPrice} ariaLabel="默认单价（元）" />
              </div>
            </div>
          </div>

          <div className="mz-biz-tpl-actions">
            <button type="button" className="mz-biz-btn is-primary" onClick={() => void submit()}>保存模板</button>
            <button type="button" className="mz-biz-btn" onClick={resetForm}>取消</button>
          </div>
        </div>
      )}

      {/* 模板列表 */}
      {shown.length === 0 ? (
        <div className="mz-biz-empty">
          {templates.length === 0 ? '还没有模板，点「新建模板」把常用记账存起来' : '该类型下暂无模板'}
        </div>
      ) : (
        <table className="mz-biz-table">
          <thead>
            <tr>
              <th>模板名</th>
              <th>类型</th>
              <th>商品 / 规格</th>
              <th>渠道</th>
              <th className="mz-num">数量</th>
              <th className="mz-num">单价</th>
              <th className="mz-num">用过</th>
              <th>操作</th>
            </tr>
          </thead>
          <tbody>
            {shown.map((t) => (
              <tr key={t.id}>
                <td>
                  {editingId === t.id ? (
                    <span className="mz-biz-inline-edit">
                      <input type="text" value={editName} onChange={(e) => setEditName(e.target.value)} autoFocus />
                      <button type="button" onClick={() => void saveName(t)}>保存</button>
                      <button type="button" onClick={() => setEditingId(null)}>取消</button>
                    </span>
                  ) : t.name}
                </td>
                <td><span className="mz-biz-tag">{TEMPLATE_KIND_LABEL[t.kind]}</span></td>
                <td>
                  {t.product_name
                    ? `${t.brand ?? ''} / ${t.product_name}${t.variant_name ? ` · ${t.variant_name}` : ''}`
                    : <span className="mz-biz-td-empty">不限</span>}
                </td>
                <td>{t.channel ?? <span className="mz-biz-td-empty">—</span>}</td>
                <td className="mz-num">{t.default_qty ?? '—'}</td>
                <td className="mz-num">{t.default_price_cents != null ? money(t.default_price_cents) : '—'}</td>
                <td className="mz-num">{t.use_count}</td>
                <td className="mz-biz-ops">
                  <button
                    type="button"
                    className="mz-biz-btn-sm"
                    onClick={() => { setEditingId(t.id); setEditName(t.name) }}
                  >
                    改名
                  </button>
                  <button type="button" className="mz-biz-btn-sm is-danger" onClick={() => void remove(t)}>删除</button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      {/* 说明 */}
      <div className="mz-biz-backup-note">
        提示：模板只在本地保存，不上云。套用模板会把商品、规格、渠道、数量、单价一键填进记账表单，
        已填的部分仍可修改后再提交。
      </div>
    </div>
  )
}