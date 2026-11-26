// 实时盈亏测算器（第五阶段）：选商品+规格+数量+售价，实时显示成本/毛利/毛利率/保本价/建议售价。
// 全部走后端 calculateProfit，前端只做输入与格式化，保证与记账口径一致。

import { useCallback, useEffect, useMemo, useState } from 'react'
import type { ReactElement } from 'react'
import type { ProductWithVariantsDTO, VariantDTO, ProfitCalcResultDTO } from '../../../shared/types'
import { calculateProfit, money, percent, yuanToCents, centsToYuan, humanError } from '../lib/business'
import { NumberField } from './NumberField'

export interface ProfitCalculatorProps {
  products: ProductWithVariantsDTO[]
  onError: (msg: string) => void
}

export function ProfitCalculator({ products, onError }: ProfitCalculatorProps): ReactElement {
  const [productId, setProductId] = useState('')
  const [variantId, setVariantId] = useState('')
  const [qty, setQty] = useState('1')
  const [unitPrice, setUnitPrice] = useState('')
  const [extraExpense, setExtraExpense] = useState('')
  const [result, setResult] = useState<ProfitCalcResultDTO | null>(null)

  const variant: VariantDTO | undefined = useMemo(() => {
    const p = products.find(x => String(x.id) === productId)
    return p?.variants.find(v => String(v.id) === variantId)
  }, [products, productId, variantId])

  // 选中规格后自动带出标准售价
  useEffect(() => {
    if (variant) setUnitPrice(centsToYuan(variant.standard_price_cents))
  }, [variant?.id])

  // 输入变化即实时测算（本地触发后端计算，保证口径一致）
  useEffect(() => {
    const pid = parseInt(productId, 10)
    const vid = parseInt(variantId, 10)
    if (!pid || !vid) { setResult(null); return }
    const q = parseFloat(qty)
    if (!q || q <= 0) { setResult(null); return }
    let cancelled = false
    void (async () => {
      try {
        const r = await calculateProfit({
          product_id: pid,
          variant_id: vid,
          qty: q,
          unit_price_cents: unitPrice ? yuanToCents(unitPrice) : null,
          extra_expense_cents: extraExpense ? yuanToCents(extraExpense) : null,
        })
        if (!cancelled) setResult(r)
      } catch (e) {
        if (!cancelled) onError(humanError(e))
      }
    })()
    return () => { cancelled = true }
  }, [productId, variantId, qty, unitPrice, extraExpense, onError])

  // 反算建议售价：按目标毛利率推售价，可直接写回输入框
  const applySuggested = useCallback(() => {
    if (result) setUnitPrice(centsToYuan(result.suggested_price_cents))
  }, [result])

  const applyBreakEven = useCallback(() => {
    if (result) setUnitPrice(centsToYuan(result.break_even_price_cents))
  }, [result])

  return (
    <div className="mz-biz-form mz-biz-calc">
      <h3>实时盈亏测算</h3>
      <p className="mz-biz-hint">选好规格与售价，实时算出成本、毛利、毛利率；还可反推建议售价与保本价。</p>

      <div className="mz-biz-field">
        <label className="mz-biz-label">商品</label>
        <div className="mz-biz-input">
          <select
            value={productId}
            onChange={e => {
              const next = products.find(p => String(p.id) === e.target.value)
              const first = next?.variants[0]
              setProductId(e.target.value)
              setVariantId(first ? String(first.id) : '')
            }}
          >
            <option value="">请选择…</option>
            {products.map(p => <option key={p.id} value={p.id}>{p.brand} / {p.name}</option>)}
          </select>
        </div>
      </div>

      <div className="mz-biz-field">
        <label className="mz-biz-label">规格</label>
        <div className="mz-biz-input">
          <select value={variantId} onChange={e => setVariantId(e.target.value)} disabled={!productId}>
            {!productId && <option value="">先选商品</option>}
            {products.find(p => String(p.id) === productId)?.variants.map(v => (
              <option key={v.id} value={v.id}>
                {v.spec_name}（成本 {centsToYuan(v.avg_cost_cents)} 元 / 标准售价 {centsToYuan(v.standard_price_cents)} 元）
              </option>
            ))}
          </select>
        </div>
      </div>

      <div className="mz-biz-row">
        <div className="mz-biz-field">
          <label className="mz-biz-label">数量</label>
          <div className="mz-biz-input">
            <NumberField value={qty} onChange={setQty} ariaLabel="数量" />
          </div>
        </div>
        <div className="mz-biz-field">
          <label className="mz-biz-label">售价（元/件）</label>
          <div className="mz-biz-input">
            <NumberField value={unitPrice} onChange={setUnitPrice} ariaLabel="售价（元/件）" />
          </div>
        </div>
      </div>

      <div className="mz-biz-field">
        <label className="mz-biz-label">分摊支出（元，可选）</label>
        <div className="mz-biz-input">
          <NumberField value={extraExpense} onChange={setExtraExpense} placeholder="如平台手续费，扣在净利润里" />
        </div>
      </div>

      {result ? (
        <div className="mz-biz-calc-result">
          <div className="mz-biz-kpi-grid mz-biz-kpi-grid-sm">
            <div className="mz-biz-kpi">
              <div className="mz-biz-kpi-label">单件成本</div>
              <div className="mz-biz-kpi-value mz-num">{money(result.cost_per_unit_cents)}</div>
            </div>
            <div className="mz-biz-kpi">
              <div className="mz-biz-kpi-label">成交金额</div>
              <div className="mz-biz-kpi-value mz-num">{money(result.amount_cents)}</div>
            </div>
            <div className="mz-biz-kpi is-accent">
              <div className="mz-biz-kpi-label">毛利润</div>
              <div className="mz-biz-kpi-value mz-num">{money(result.gross_profit_cents)}</div>
              <div className="mz-biz-kpi-sub">毛利率 {percent(result.gross_margin)}</div>
            </div>
            <div className={`mz-biz-kpi ${result.net_profit_cents >= 0 ? 'is-accent' : 'is-danger'}`}>
              <div className="mz-biz-kpi-label">净利润</div>
              <div className="mz-biz-kpi-value mz-num">{money(result.net_profit_cents)}</div>
              <div className="mz-biz-kpi-sub">净利率 {percent(result.net_margin)}</div>
            </div>
          </div>

          <div className="mz-biz-calc-hints">
            <div className="mz-biz-calc-hint">
              <span>保本价（= 平均成本）</span>
              <b className="mz-num">{money(result.break_even_price_cents)}</b>
              <button type="button" className="mz-biz-btn-sm" onClick={applyBreakEven}>填入</button>
            </div>
            <div className="mz-biz-calc-hint">
              <span>建议售价（按 30% 毛利）</span>
              <b className="mz-num">{money(result.suggested_price_cents)}</b>
              <button type="button" className="mz-biz-btn-sm is-primary" onClick={applySuggested}>填入</button>
            </div>
          </div>
        </div>
      ) : (
        <div className="mz-biz-empty">选择商品与规格后，这里实时显示盈亏</div>
      )}
    </div>
  )
}
