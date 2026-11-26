// 商品经营管理中心（第四阶段 · 多规格版）。
// 设计要点：
//   - 每个商品下挂多个规格（如 1kg 装 / 2kg 装 / 5kg 装），每个规格独立定价、独立成本、独立库存。
//   - LM100币 这类固定价商品只有一个规格（规格名 = 商品名）。
//   - 子 Tab：商品规格、销售、进货、退款、客服收入、其他收支、经营支出。
//   - 一笔录入全表联动：提交后刷新商品+规格，展示返回结果（含规格名、成本快照、毛利等）。
//   - 金额一律元输入、分存储，yuanToCents/centsToYuan 转换在提交时完成。

import { useCallback, useEffect, useMemo, useState } from 'react'
import type { ReactElement } from 'react'
import type {
  ProductWithVariantsDTO,
  ProductProfileDTO,
  VariantDTO,
  SaleResultDTO,
  PurchaseResultDTO,
  RefundResultDTO,
  QuickTemplateDTO,
} from '../../../shared/types'
import {
  listProductsWithVariants, getProductProfile,
  createVariant, updateVariant, deleteVariant,
  recordSale, recordPurchase, recordRefund, recordCSIncome, recordOther, recordExpense,
  listChannels, money, yuanToCents, centsToYuan, datetimeLocalToISO, isoToDatetimeLocal, percent, humanError,
  listTemplates,
} from '../lib/business'
import { BusinessOverview } from './BusinessOverview'
import { BusinessDashboard } from './BusinessDashboard'
import { MonthlyReportView } from './MonthlyReport'
import { ProfitCalculator } from './ProfitCalculator'
import { BackupManager } from './BackupManager'
import { TemplateManager } from './TemplateManager'
import { TemplateBar } from './TemplateBar'
import { NumberField } from './NumberField'
import '../styles/business.css'

type BizTab =
  | 'home' | 'overview' | 'monthly' | 'calc'
  | 'sale' | 'purchase' | 'refund' | 'cs' | 'other' | 'expense'
  | 'products' | 'templates' | 'backup'

/**
 * 库存输入解析：空串按 0 处理（用户清空 = 没库存），负数/非数字返回 null 让调用方报错。
 * 保留 3 位小数——支持 0.5 件、1.25kg 这类非整数库存。
 */
function parseStockInput(raw: string): number | null {
  const t = raw.trim()
  if (!t) return 0
  const n = Number(t)
  if (!Number.isFinite(n) || n < 0) return null
  return Math.round(n * 1000) / 1000
}

/** 一级分组：把 13 个二级 Tab 收进 4 组，避免横向平铺拥挤。 */
interface TabGroup {
  id: string
  label: string
  tabs: { id: BizTab; label: string }[]
}

const GROUPS: TabGroup[] = [
  {
    id: 'board',
    label: '看板',
    tabs: [
      { id: 'home', label: '首页' },
      { id: 'overview', label: '经营概览' },
      { id: 'monthly', label: '月度报表' },
      { id: 'calc', label: '盈亏测算' },
    ],
  },
  {
    id: 'book',
    label: '记账',
    tabs: [
      { id: 'sale', label: '销售' },
      { id: 'purchase', label: '进货' },
      { id: 'refund', label: '退款' },
      { id: 'cs', label: '客服收入' },
      { id: 'other', label: '其他收支' },
      { id: 'expense', label: '经营支出' },
    ],
  },
  {
    id: 'goods',
    label: '商品',
    tabs: [
      { id: 'products', label: '商品规格' },
      { id: 'templates', label: '快捷模板' },
    ],
  },
  {
    id: 'data',
    label: '数据',
    tabs: [{ id: 'backup', label: '备份导出' }],
  },
]

/** 某 Tab 属于哪个分组。 */
function groupOfTab(tab: BizTab): TabGroup {
  return GROUPS.find((g) => g.tabs.some((t) => t.id === tab)) ?? GROUPS[0]
}

type Channels = {
  income: readonly string[]
  expense: readonly string[]
  refund: readonly string[]
  expenseCategories: readonly string[]
}

export function BusinessView(): ReactElement {
  const [tab, setTab] = useState<BizTab>('home')
  const [products, setProducts] = useState<ProductWithVariantsDTO[]>([])
  const [templates, setTemplates] = useState<QuickTemplateDTO[]>([])
  const [channels, setChannels] = useState<Channels>({ income: [], expense: [], refund: [], expenseCategories: [] })
  const [error, setError] = useState<string | null>(null)
  const [toast, setToast] = useState<string | null>(null)
  // 全局联动：任何记账成功后 +1，概览面板监听它自动重算
  const [syncToken, setSyncToken] = useState(0)

  const refreshProducts = useCallback(async () => {
    try {
      setProducts(await listProductsWithVariants())
    } catch (e) {
      setError(humanError(e))
    }
  }, [])

  const refreshTemplates = useCallback(async () => {
    try {
      setTemplates(await listTemplates())
    } catch (e) {
      setError(humanError(e))
    }
  }, [])

  const refreshChannels = useCallback(async () => {
    try {
      setChannels(await listChannels())
    } catch (e) {
      setError(humanError(e))
    }
  }, [])

  useEffect(() => {
    void refreshProducts()
    void refreshTemplates()
    void refreshChannels()
  }, [refreshProducts, refreshTemplates, refreshChannels])

  const showToast = useCallback((msg: string) => {
    setToast(msg)
    setTimeout(() => setToast(null), 4000)
  }, [])

  // 全局联动入口：记账/改价/规格变更后统一走这里——刷新商品 + 触发概览重算
  const handleSuccess = useCallback((msg: string) => {
    showToast(msg)
    setError(null)
    void refreshProducts()
    setSyncToken(t => t + 1)
  }, [showToast, refreshProducts])

  const handleError = useCallback((msg: string) => {
    setError(msg)
    setToast(null)
  }, [])

  const activeGroup = groupOfTab(tab)

  // 记住上次停留的 Tab（第八阶段：启动体验打磨）
  useEffect(() => {
    try {
      const saved = window.localStorage.getItem('mz.biz.tab')
      if (saved && GROUPS.some((g) => g.tabs.some((t) => t.id === saved))) {
        setTab(saved as BizTab)
      }
    } catch { /* localStorage 不可用则忽略 */ }
  }, [])

  useEffect(() => {
    try { window.localStorage.setItem('mz.biz.tab', tab) } catch { /* 忽略 */ }
  }, [tab])

  return (
    <div className="mz-biz">
      <div className="mz-biz-header">
        <h2>商品经营管理</h2>

        {/* 一级分组条 */}
        <div className="mz-biz-groups" role="tablist" aria-label="功能分组">
          {GROUPS.map((g) => {
            const isActive = g.id === activeGroup.id
            return (
              <button
                key={g.id}
                type="button"
                role="tab"
                aria-selected={isActive}
                className={`mz-biz-group${isActive ? ' is-active' : ''}`}
                onClick={() => {
                  // 切分组时落到该组第一个 Tab
                  if (!isActive) { setTab(g.tabs[0].id); setError(null) }
                }}
              >
                {g.label}
              </button>
            )
          })}
        </div>

        {/* 二级 Tab（只显示当前分组的） */}
        <div className="mz-biz-tabs">
          {activeGroup.tabs.map((t) => (
            <button
              key={t.id}
              type="button"
              className={`mz-biz-tab${tab === t.id ? ' is-active' : ''}`}
              onClick={() => { setTab(t.id); setError(null) }}
            >
              {t.label}
            </button>
          ))}
        </div>
      </div>

      {error && <div className="mz-biz-error" role="alert">{error}</div>}
      {toast && <div className="mz-biz-toast" role="status">{toast}</div>}

      <div className="mz-biz-body">
        {tab === 'home' && (
          <BusinessDashboard
            refreshToken={syncToken}
            onError={handleError}
            onGoTab={(next) => setTab(next)}
          />
        )}
        {tab === 'overview' && <BusinessOverview refreshToken={syncToken} onError={handleError} />}
        {tab === 'monthly' && <MonthlyReportView refreshToken={syncToken} onError={handleError} onToast={showToast} />}
        {tab === 'calc' && <ProfitCalculator products={products} onError={handleError} />}
        {tab === 'backup' && <BackupManager onError={handleError} onToast={showToast} />}
        {tab === 'templates' && (
          <TemplateManager
            products={products}
            templates={templates}
            onRefresh={refreshTemplates}
            onToast={showToast}
            onError={handleError}
          />
        )}
        {tab === 'products' && (
          <ProductSpecManager
            products={products}
            onRefresh={refreshProducts}
            onToast={showToast}
            onError={handleError}
            onChanged={() => setSyncToken(t => t + 1)}
          />
        )}
        {tab === 'sale' && (
          <SaleForm products={products} channels={channels.income} templates={templates} onSuccess={handleSuccess} onError={handleError} />
        )}
        {tab === 'purchase' && (
          <PurchaseForm products={products} channels={channels.expense} templates={templates} onSuccess={handleSuccess} onError={handleError} />
        )}
        {tab === 'refund' && (
          <RefundForm products={products} channels={channels.refund} onSuccess={handleSuccess} onError={handleError} />
        )}
        {tab === 'cs' && (
          <CSIncomeForm channels={channels.income} onSuccess={handleSuccess} onError={handleError} />
        )}
        {tab === 'other' && (
          <OtherForm channels={channels} onSuccess={handleSuccess} onError={handleError} />
        )}
        {tab === 'expense' && (
          <ExpenseForm products={products} channels={channels} onSuccess={handleSuccess} onError={handleError} />
        )}
      </div>
    </div>
  )
}

// === 商品 + 规格管理 ===

function ProductSpecManager({ products, onRefresh, onToast, onError, onChanged }: {
  products: ProductWithVariantsDTO[]
  onRefresh: () => Promise<void>
  onToast: (msg: string) => void
  onError: (msg: string) => void
  onChanged: () => void
}): ReactElement {
  const [expandedId, setExpandedId] = useState<number | null>(null)
  const [profileId, setProfileId] = useState<number | null>(null)
  const [profile, setProfile] = useState<ProductProfileDTO | null>(null)

  // 规格行内编辑状态
  const [editingVariantId, setEditingVariantId] = useState<number | null>(null)
  const [editName, setEditName] = useState('')
  const [editPrice, setEditPrice] = useState('')
  const [editCost, setEditCost] = useState('')
  const [editStock, setEditStock] = useState('')
  // 新增规格表单
  const [addingFor, setAddingFor] = useState<number | null>(null)
  const [newSpecName, setNewSpecName] = useState('')
  const [newSpecPrice, setNewSpecPrice] = useState('')
  const [newSpecCost, setNewSpecCost] = useState('')
  const [newSpecStock, setNewSpecStock] = useState('')

  const openProfile = useCallback(async (id: number) => {
    try {
      setProfile(await getProductProfile(id))
      setProfileId(id)
    } catch (e) {
      onError(humanError(e))
    }
  }, [onError])

  const startEditVariant = useCallback((v: VariantDTO) => {
    setEditingVariantId(v.id)
    setEditName(v.spec_name)
    setEditPrice(centsToYuan(v.standard_price_cents))
    setEditCost(centsToYuan(v.avg_cost_cents))
    // 与输入框的 3 位小数上限对齐，避免显示 4 位小数、保存时又被悄悄截掉
    setEditStock(String(Math.round(v.stock_qty * 1000) / 1000))
  }, [])

  const saveVariant = useCallback(async (v: VariantDTO) => {
    try {
      const name = editName.trim()
      if (!name) { onError('规格名称不能为空'); return }
      const cents = yuanToCents(editPrice)
      if (cents < 0) { onError('售价不能为负'); return }
      const cost = yuanToCents(editCost)
      if (cost < 0) { onError('单件成本不能为负'); return }
      const stock = parseStockInput(editStock)
      if (stock === null) { onError('库存数量请填不小于 0 的数字（可带小数）'); return }
      // 名称变了才改名称，避免触发唯一约束误报
      await updateVariant({
        id: v.id,
        ...(name !== v.spec_name ? { spec_name: name } : {}),
        standard_price_cents: cents,
        avg_cost_cents: cost,
        stock_qty: stock,
      })
      onToast(`已保存「${name}」：售价 ${centsToYuan(cents)} 元 · 单件成本 ${centsToYuan(cost)} 元 · 库存 ${stock}`)
      setEditingVariantId(null)
      await onRefresh()
      onChanged()
    } catch (e) {
      onError(humanError(e))
    }
  }, [editName, editPrice, editCost, editStock, onToast, onError, onRefresh, onChanged])

  const addSpec = useCallback(async (productId: number) => {
    try {
      const name = newSpecName.trim()
      if (!name) { onError('请填写规格名称'); return }
      const cents = yuanToCents(newSpecPrice)
      if (cents < 0) { onError('售价不能为负'); return }
      const cost = yuanToCents(newSpecCost)
      if (cost < 0) { onError('单件成本不能为负'); return }
      const stock = parseStockInput(newSpecStock)
      if (stock === null) { onError('库存数量请填不小于 0 的数字（可带小数）'); return }
      await createVariant({
        product_id: productId,
        spec_name: name,
        standard_price_cents: cents,
        avg_cost_cents: cost,
        stock_qty: stock,
      })
      onToast(`已新增规格「${name}」（库存 ${stock} · 单件成本 ${centsToYuan(cost)} 元）`)
      setAddingFor(null)
      setNewSpecName('')
      setNewSpecPrice('')
      setNewSpecCost('')
      setNewSpecStock('')
      await onRefresh()
      onChanged()
    } catch (e) {
      onError(humanError(e))
    }
  }, [newSpecName, newSpecPrice, newSpecCost, newSpecStock, onToast, onError, onRefresh, onChanged])

  const removeSpec = useCallback(async (v: VariantDTO) => {
    if (!window.confirm(`确定删除规格「${v.spec_name}」？已有历史记录的规格不能删除。`)) return
    try {
      await deleteVariant(v.id)
      onToast(`规格「${v.spec_name}」已删除`)
      await onRefresh()
      onChanged()
    } catch (e) {
      onError(humanError(e))
    }
  }, [onToast, onError, onRefresh, onChanged])

  return (
    <div className="mz-biz-products">
      <div className="mz-biz-toolbar">
        <button type="button" className="mz-biz-btn" onClick={() => void onRefresh()}>刷新</button>
        <span className="mz-biz-toolbar-hint">
          点商品名展开规格；售价、单件成本、库存都点「编辑」直接改。走「进货」记账则会自动累加库存并重算加权平均成本。
        </span>
      </div>

      {products.map(p => {
        const expanded = expandedId === p.id
        return (
          <div className="mz-biz-group" key={p.id}>
            {/* 商品行 */}
            <div className={`mz-biz-prod-row${expanded ? ' is-expanded' : ''}`}>
              <button
                type="button"
                className="mz-biz-prod-main"
                onClick={() => setExpandedId(expanded ? null : p.id)}
              >
                <span className="mz-biz-caret">{expanded ? '▾' : '▸'}</span>
                <span className="mz-biz-prod-name">{p.brand} / {p.name}</span>
                <span className="mz-biz-prod-meta">{p.variants.length} 个规格</span>
              </button>
              <span className="mz-biz-prod-stat">
                <span>库存 <b className="mz-num">{p.stock_qty}</b></span>
                <span>销售 <b className="mz-num">{money(p.cumulative_sales_cents)}</b></span>
                <span>退款 <b className="mz-num">{money(p.cumulative_refund_cents)}</b></span>
              </span>
              <button type="button" className="mz-biz-btn-sm" onClick={() => void openProfile(p.id)}>档案</button>
            </div>

            {/* 规格表 */}
            {expanded && (
              <div className="mz-biz-variants">
                <table className="mz-biz-table">
                  <thead>
                    <tr>
                      <th>规格</th>
                      <th className="mz-num">售价</th>
                      <th className="mz-num" title="进货时按加权平均自动更新；也可点「编辑」直接改">单件成本</th>
                      <th className="mz-num" title="进货自动加、销售自动减；也可点「编辑」直接改">库存</th>
                      <th className="mz-num">累计销售</th>
                      <th className="mz-num">累计退款</th>
                      <th>操作</th>
                    </tr>
                  </thead>
                  <tbody>
                    {p.variants.map(v => {
                      const editing = editingVariantId === v.id
                      return (
                        <tr key={v.id}>
                          <td>
                            {editing ? (
                              <input
                                className="mz-biz-edit-input"
                                type="text"
                                value={editName}
                                onChange={e => setEditName(e.target.value)}
                                autoFocus
                              />
                            ) : v.spec_name}
                          </td>
                          <td className="mz-num">
                            {editing ? (
                              <NumberField
                                className="mz-biz-edit-input mz-num"
                                value={editPrice}
                                onChange={setEditPrice}
                                ariaLabel="规格售价（元）"
                                onEnter={() => void saveVariant(v)}
                                onEscape={() => setEditingVariantId(null)}
                              />
                            ) : money(v.standard_price_cents)}
                          </td>
                          <td className="mz-num">
                            {editing ? (
                              <NumberField
                                className="mz-biz-edit-input mz-num"
                                value={editCost}
                                onChange={setEditCost}
                                placeholder="成本（元）"
                                ariaLabel="单件成本（元）"
                                onEnter={() => void saveVariant(v)}
                                onEscape={() => setEditingVariantId(null)}
                              />
                            ) : money(v.avg_cost_cents)}
                          </td>
                          <td className="mz-num">
                            {editing ? (
                              <NumberField
                                className="mz-biz-edit-input mz-num"
                                value={editStock}
                                onChange={setEditStock}
                                placeholder="数量"
                                ariaLabel="库存数量"
                                maxDecimals={3}
                                onEnter={() => void saveVariant(v)}
                                onEscape={() => setEditingVariantId(null)}
                              />
                            ) : v.stock_qty}
                          </td>
                          <td className="mz-num">{money(v.cumulative_sales_cents)}</td>
                          <td className="mz-num">{money(v.cumulative_refund_cents)}</td>
                          <td className="mz-biz-ops">
                            {editing ? (
                              <>
                                <button type="button" className="mz-biz-btn-sm is-primary" onClick={() => void saveVariant(v)}>保存</button>
                                <button type="button" className="mz-biz-btn-sm" onClick={() => setEditingVariantId(null)}>取消</button>
                              </>
                            ) : (
                              <>
                                <button type="button" className="mz-biz-btn-sm" onClick={() => startEditVariant(v)}>编辑</button>
                                <button type="button" className="mz-biz-btn-sm is-danger" onClick={() => void removeSpec(v)}>删除</button>
                              </>
                            )}
                          </td>
                        </tr>
                      )
                    })}
                  </tbody>
                </table>

                {/* 新增规格 */}
                {addingFor === p.id ? (
                  <div className="mz-biz-add-spec">
                    <input
                      type="text"
                      className="mz-biz-add-spec-name"
                      placeholder="规格名（如 15kg 装）"
                      value={newSpecName}
                      onChange={e => setNewSpecName(e.target.value)}
                      autoFocus
                    />
                    <NumberField
                      className="mz-biz-add-spec-price"
                      placeholder="售价（元）"
                      ariaLabel="新规格售价（元）"
                      value={newSpecPrice}
                      onChange={setNewSpecPrice}
                      onEnter={() => void addSpec(p.id)}
                    />
                    <NumberField
                      className="mz-biz-add-spec-price"
                      placeholder="单件成本（元）"
                      ariaLabel="新规格单件成本（元）"
                      value={newSpecCost}
                      onChange={setNewSpecCost}
                      onEnter={() => void addSpec(p.id)}
                    />
                    <NumberField
                      className="mz-biz-add-spec-price"
                      placeholder="期初库存"
                      ariaLabel="新规格期初库存"
                      value={newSpecStock}
                      onChange={setNewSpecStock}
                      maxDecimals={3}
                      onEnter={() => void addSpec(p.id)}
                    />
                    <button type="button" className="mz-biz-btn-sm is-primary" onClick={() => void addSpec(p.id)}>添加</button>
                    <button
                      type="button"
                      className="mz-biz-btn-sm"
                      onClick={() => {
                        setAddingFor(null)
                        setNewSpecName('')
                        setNewSpecPrice('')
                        setNewSpecCost('')
                        setNewSpecStock('')
                      }}
                    >
                      取消
                    </button>
                  </div>
                ) : (
                  <button type="button" className="mz-biz-btn mz-biz-add-spec-btn" onClick={() => setAddingFor(p.id)}>
                    + 新增规格
                  </button>
                )}
              </div>
            )}
          </div>
        )
      })}

      {/* 商品档案弹窗 */}
      {profile && profileId != null && (
        <div className="mz-biz-profile" onClick={() => { setProfile(null); setProfileId(null) }}>
          <div className="mz-biz-profile-card" onClick={e => e.stopPropagation()}>
            <h3>{profile.brand} / {profile.name}</h3>
            <div className="mz-biz-profile-grid">
              <div><span>平均成本</span><b className="mz-num">{money(profile.avg_cost_cents)}</b></div>
              <div><span>库存数量</span><b className="mz-num">{profile.stock_qty}</b></div>
              <div><span>库存成本</span><b className="mz-num">{money(profile.stock_cost_cents)}</b></div>
              <div><span>累计进货</span><b className="mz-num">{profile.cumulative_purchase_qty} 件 / {money(profile.cumulative_purchase_cents)}</b></div>
              <div><span>累计销售</span><b className="mz-num">{profile.cumulative_sales_qty} 件 / {money(profile.cumulative_sales_cents)}</b></div>
              <div><span>累计退款</span><b className="mz-num">{profile.cumulative_refund_qty} 件 / {money(profile.cumulative_refund_cents)}</b></div>
              <div><span>销售成本</span><b className="mz-num">{money(profile.cumulative_sales_cost_cents)}</b></div>
              <div><span>净销售额</span><b className="mz-num">{money(profile.net_sales_cents)}</b></div>
              <div><span>毛利润</span><b className="mz-num">{money(profile.gross_profit_cents)}</b></div>
              <div><span>退款率</span><b className="mz-num">{percent(profile.refund_amount_rate)}</b></div>
              <div><span>订单数</span><b className="mz-num">{profile.sales_order_count}</b></div>
            </div>

            {/* 各规格档案 */}
            <h4 className="mz-biz-profile-sub">各规格明细</h4>
            <table className="mz-biz-table mz-biz-profile-table">
              <thead>
                <tr>
                  <th>规格</th>
                  <th className="mz-num">售价</th>
                  <th className="mz-num">成本</th>
                  <th className="mz-num">库存</th>
                  <th className="mz-num">净销售</th>
                  <th className="mz-num">毛利</th>
                  <th className="mz-num">退款率</th>
                </tr>
              </thead>
              <tbody>
                {profile.variants.map(v => (
                  <tr key={v.id}>
                    <td>{v.spec_name}</td>
                    <td className="mz-num">{money(v.standard_price_cents)}</td>
                    <td className="mz-num">{money(v.avg_cost_cents)}</td>
                    <td className="mz-num">{v.stock_qty}</td>
                    <td className="mz-num">{money(v.net_sales_cents)}</td>
                    <td className="mz-num">{money(v.gross_profit_cents)}</td>
                    <td className="mz-num">{percent(v.refund_amount_rate)}</td>
                  </tr>
                ))}
              </tbody>
            </table>

            <button type="button" className="mz-biz-btn" onClick={() => { setProfile(null); setProfileId(null) }}>关闭</button>
          </div>
        </div>
      )}
    </div>
  )
}

// === 规格选择器（销售/进货/退款公用） ===

function VariantPicker({ products, productId, variantId, onChange }: {
  products: ProductWithVariantsDTO[]
  productId: string
  variantId: string
  onChange: (next: { productId: string; variantId: string }) => void
}): ReactElement {
  const selected = useMemo(() => products.find(p => String(p.id) === productId), [products, productId])
  return (
    <>
      <FormField label="商品">
        <select
          value={productId}
          onChange={e => {
            const nextProduct = products.find(p => String(p.id) === e.target.value)
            // 换商品后自动落到该商品首个规格，避免残留旧规格
            const firstVariant = nextProduct?.variants[0]
            onChange({ productId: e.target.value, variantId: firstVariant ? String(firstVariant.id) : '' })
          }}
        >
          <option value="">请选择…</option>
          {products.map(p => <option key={p.id} value={p.id}>{p.brand} / {p.name}</option>)}
        </select>
      </FormField>
      <FormField label="规格">
        <select
          value={variantId}
          onChange={e => onChange({ productId, variantId: e.target.value })}
          disabled={!selected || selected.variants.length === 0}
        >
          {!selected && <option value="">先选商品</option>}
          {selected && selected.variants.length === 0 && <option value="">该商品还没有规格</option>}
          {selected?.variants.map(v => (
            <option key={v.id} value={v.id}>
              {v.spec_name}（售 {centsToYuan(v.standard_price_cents)} 元 / 成本 {centsToYuan(v.avg_cost_cents)} 元 / 库存 {v.stock_qty}）
            </option>
          ))}
        </select>
      </FormField>
      {selected && selected.variants.length === 0 && (
        <p className="mz-biz-hint is-warn">
          「{selected.brand} / {selected.name}」还没有规格。请先到「商品 → 商品规格」里给它添加规格（名称 + 售价），
          录入进价后成本会自动按加权平均算出来。
        </p>
      )}
    </>
  )
}

/** 取当前选中的规格对象。 */
function useVariant(products: ProductWithVariantsDTO[], productId: string, variantId: string): VariantDTO | undefined {
  return useMemo(() => {
    const p = products.find(x => String(x.id) === productId)
    return p?.variants.find(v => String(v.id) === variantId)
  }, [products, productId, variantId])
}

// === 销售记账表单 ===

function SaleForm({ products, channels, templates, onSuccess, onError }: {
  products: ProductWithVariantsDTO[]
  channels: readonly string[]
  templates: QuickTemplateDTO[]
  onSuccess: (msg: string) => void
  onError: (msg: string) => void
}): ReactElement {
  const [productId, setProductId] = useState('')
  const [variantId, setVariantId] = useState('')
  const [qty, setQty] = useState('1')
  const [unitPrice, setUnitPrice] = useState('')
  const [channel, setChannel] = useState('')
  const [occurredAt, setOccurredAt] = useState(isoToDatetimeLocal(new Date().toISOString()))
  const [orderNo, setOrderNo] = useState('')
  const [note, setNote] = useState('')
  const [result, setResult] = useState<SaleResultDTO | null>(null)
  const [submitting, setSubmitting] = useState(false)

  const variant = useVariant(products, productId, variantId)

  useEffect(() => {
    if (channels.length > 0 && !channel) setChannel(channels[0])
  }, [channels, channel])

  // 选中规格后自动带出该规格的标准售价
  useEffect(() => {
    if (variant) setUnitPrice(centsToYuan(variant.standard_price_cents))
  }, [variant?.id])

  // 套用快捷模板：把模板字段写进表单
  const applyTemplate = useCallback((t: QuickTemplateDTO) => {
    if (t.product_id != null) setProductId(String(t.product_id))
    if (t.variant_id != null) setVariantId(String(t.variant_id))
    if (t.default_qty != null) setQty(String(t.default_qty))
    if (t.default_price_cents != null) setUnitPrice(centsToYuan(t.default_price_cents))
    if (t.channel) setChannel(t.channel)
    setResult(null)
  }, [])

  const handleSubmit = useCallback(async () => {
    const pid = parseInt(productId, 10)
    const vid = parseInt(variantId, 10)
    if (!pid) { onError('请选择商品'); return }
    if (!vid) { onError('请选择规格'); return }
    const q = parseFloat(qty)
    if (!q || q <= 0) { onError('数量必须大于 0'); return }
    const up = yuanToCents(unitPrice)
    if (up <= 0) { onError('单价必须大于 0'); return }
    setSubmitting(true)
    try {
      const r = await recordSale({
        product_id: pid,
        variant_id: vid,
        occurred_at: datetimeLocalToISO(occurredAt),
        qty: q,
        unit_price_cents: up,
        channel: channel || channels[0] || '微信收入',
        order_no: orderNo || null,
        note: note || null,
      })
      setResult(r)
      onSuccess(`销售成功：订单 #${r.orderId}（${r.variant_name}），金额 ${money(r.amount_cents)}，毛利 ${money(r.gross_profit_cents)}`)
    } catch (e) {
      onError(humanError(e))
    } finally {
      setSubmitting(false)
    }
  }, [productId, variantId, qty, unitPrice, channel, channels, occurredAt, orderNo, note, onError, onSuccess])

  const preview = variant && unitPrice && parseFloat(qty) > 0
    ? {
        amount: yuanToCents(unitPrice) * parseFloat(qty),
        cost: variant.avg_cost_cents * parseFloat(qty),
      }
    : null

  return (
    <div className="mz-biz-form">
      <h3>销售记账</h3>
      <TemplateBar kind="sale" templates={templates} onApply={applyTemplate} onError={onError} />
      <p className="mz-biz-hint">按规格成交，规格的当前平均成本冻结为成本快照，后续进货不改历史订单利润。</p>
      <VariantPicker
        products={products}
        productId={productId}
        variantId={variantId}
        onChange={n => { setProductId(n.productId); setVariantId(n.variantId); setResult(null) }}
      />
      <div className="mz-biz-row">
        <FormField label="数量">
          <NumberField value={qty} onChange={setQty} ariaLabel="数量" />
        </FormField>
        <FormField label="单价（元）">
          <NumberField value={unitPrice} onChange={setUnitPrice} ariaLabel="单价（元）" />
        </FormField>
      </div>
      <div className="mz-biz-row">
        <FormField label="渠道">
          <select value={channel} onChange={e => setChannel(e.target.value)}>
            {channels.map(ch => <option key={ch} value={ch}>{ch}</option>)}
          </select>
        </FormField>
        <FormField label="时间">
          <input type="datetime-local" value={occurredAt} onChange={e => setOccurredAt(e.target.value)} />
        </FormField>
      </div>
      <FormField label="订单号（可选）">
        <input type="text" value={orderNo} onChange={e => setOrderNo(e.target.value)} placeholder="平台订单号" />
      </FormField>
      <FormField label="备注（可选）">
        <input type="text" value={note} onChange={e => setNote(e.target.value)} />
      </FormField>
      {preview && (
        <div className="mz-biz-preview">
          预估：金额 {money(preview.amount)}，成本 {money(preview.cost)}，毛利 {money(preview.amount - preview.cost)}
        </div>
      )}
      <button type="button" className="mz-biz-submit" disabled={submitting} onClick={() => void handleSubmit()}>
        {submitting ? '提交中…' : '提交销售'}
      </button>
      {result && (
        <div className="mz-biz-result">
          <h4>记账结果</h4>
          <div>订单号：#{result.orderId}　规格：{result.variant_name}</div>
          <div>金额：<b className="mz-num">{money(result.amount_cents)}</b></div>
          <div>成本快照：<b className="mz-num">{money(result.cost_per_unit_cents)}</b> / 件 × {parseFloat(qty)} 件 = <b className="mz-num">{money(result.total_cost_cents)}</b></div>
          <div>毛利润：<b className="mz-num">{money(result.gross_profit_cents)}</b></div>
        </div>
      )}
    </div>
  )
}

// === 进货记账表单 ===

function PurchaseForm({ products, channels, templates, onSuccess, onError }: {
  products: ProductWithVariantsDTO[]
  channels: readonly string[]
  templates: QuickTemplateDTO[]
  onSuccess: (msg: string) => void
  onError: (msg: string) => void
}): ReactElement {
  const [productId, setProductId] = useState('')
  const [variantId, setVariantId] = useState('')
  const [qty, setQty] = useState('1')
  const [totalAmount, setTotalAmount] = useState('')
  const [channel, setChannel] = useState('')
  const [occurredAt, setOccurredAt] = useState(isoToDatetimeLocal(new Date().toISOString()))
  const [note, setNote] = useState('')
  const [result, setResult] = useState<PurchaseResultDTO | null>(null)
  const [submitting, setSubmitting] = useState(false)

  const variant = useVariant(products, productId, variantId)

  useEffect(() => {
    if (channels.length > 0 && !channel) setChannel(channels[0])
  }, [channels, channel])

  // 套用快捷模板
  const applyTemplate = useCallback((t: QuickTemplateDTO) => {
    if (t.product_id != null) setProductId(String(t.product_id))
    if (t.variant_id != null) setVariantId(String(t.variant_id))
    if (t.default_qty != null) setQty(String(t.default_qty))
    if (t.default_price_cents != null) setTotalAmount(centsToYuan(t.default_price_cents))
    if (t.channel) setChannel(t.channel)
    setResult(null)
  }, [])

  const handleSubmit = useCallback(async () => {
    const pid = parseInt(productId, 10)
    const vid = parseInt(variantId, 10)
    if (!pid) { onError('请选择商品'); return }
    if (!vid) { onError('请选择规格'); return }
    const q = parseFloat(qty)
    if (!q || q <= 0) { onError('数量必须大于 0'); return }
    const tc = yuanToCents(totalAmount)
    if (tc < 0) { onError('金额不能为负'); return }
    setSubmitting(true)
    try {
      const r = await recordPurchase({
        product_id: pid,
        variant_id: vid,
        occurred_at: datetimeLocalToISO(occurredAt),
        qty: q,
        total_cents: tc,
        channel: channel || channels[0] || '微信支出',
        note: note || null,
      })
      setResult(r)
      onSuccess(`进货成功：记录 #${r.purchaseId}（${r.variant_name}），新平均成本 ${centsToYuan(r.new_avg_cost_cents)} 元/件`)
    } catch (e) {
      onError(humanError(e))
    } finally {
      setSubmitting(false)
    }
  }, [productId, variantId, qty, totalAmount, channel, channels, occurredAt, note, onError, onSuccess])

  const preview = variant && totalAmount && parseFloat(qty) > 0
    ? Math.round((variant.stock_cost_cents + yuanToCents(totalAmount)) / (variant.stock_qty + parseFloat(qty)))
    : null

  return (
    <div className="mz-biz-form">
      <h3>进货记账</h3>
      <TemplateBar kind="purchase" templates={templates} onApply={applyTemplate} onError={onError} />
      <p className="mz-biz-hint">按规格进货，加权平均成本 = (该规格原库存成本 + 本次进货金额) / (原库存数量 + 本次进货数量)。</p>
      <VariantPicker
        products={products}
        productId={productId}
        variantId={variantId}
        onChange={n => { setProductId(n.productId); setVariantId(n.variantId); setResult(null) }}
      />
      <div className="mz-biz-row">
        <FormField label="数量">
          <NumberField value={qty} onChange={setQty} ariaLabel="数量" />
        </FormField>
        <FormField label="总金额（元）">
          <NumberField value={totalAmount} onChange={setTotalAmount} ariaLabel="进货总金额（元）" />
        </FormField>
      </div>
      <div className="mz-biz-row">
        <FormField label="渠道">
          <select value={channel} onChange={e => setChannel(e.target.value)}>
            {channels.map(ch => <option key={ch} value={ch}>{ch}</option>)}
          </select>
        </FormField>
        <FormField label="时间">
          <input type="datetime-local" value={occurredAt} onChange={e => setOccurredAt(e.target.value)} />
        </FormField>
      </div>
      <FormField label="备注（可选）">
        <input type="text" value={note} onChange={e => setNote(e.target.value)} />
      </FormField>
      {variant && totalAmount && parseFloat(qty) > 0 && (
        <div className="mz-biz-preview">
          本次单价 {centsToYuan(yuanToCents(totalAmount) / parseFloat(qty))} 元/件，
          原平均成本 {centsToYuan(variant.avg_cost_cents)} 元/件（库存 {variant.stock_qty}），
          新平均成本 ≈ {centsToYuan(preview ?? 0)} 元/件
        </div>
      )}
      <button type="button" className="mz-biz-submit" disabled={submitting} onClick={() => void handleSubmit()}>
        {submitting ? '提交中…' : '提交进货'}
      </button>
      {result && (
        <div className="mz-biz-result">
          <h4>记账结果</h4>
          <div>记录号：#{result.purchaseId}　规格：{result.variant_name}</div>
          <div>本次单价：<b className="mz-num">{centsToYuan(result.unit_cost_cents)}</b> 元/件</div>
          <div>原平均成本：{centsToYuan(result.prev_avg_cost_cents)} 元/件（原库存 {result.prev_stock_qty}）</div>
          <div>新平均成本：<b className="mz-num">{centsToYuan(result.new_avg_cost_cents)}</b> 元/件</div>
        </div>
      )}
    </div>
  )
}

// === 退款记账表单 ===

function RefundForm({ products, channels, onSuccess, onError }: {
  products: ProductWithVariantsDTO[]
  channels: readonly string[]
  onSuccess: (msg: string) => void
  onError: (msg: string) => void
}): ReactElement {
  const [mode, setMode] = useState<'linked' | 'manual'>('linked')
  const [productId, setProductId] = useState('')
  const [variantId, setVariantId] = useState('')
  const [orderId, setOrderId] = useState('')
  const [refundAmount, setRefundAmount] = useState('')
  const [refundQty, setRefundQty] = useState('')
  const [channel, setChannel] = useState('')
  const [occurredAt, setOccurredAt] = useState(isoToDatetimeLocal(new Date().toISOString()))
  const [restoreStock, setRestoreStock] = useState(false)
  const [reason, setReason] = useState('')
  const [result, setResult] = useState<RefundResultDTO | null>(null)
  const [submitting, setSubmitting] = useState(false)

  useEffect(() => {
    if (channels.length > 0 && !channel) setChannel(channels[0])
  }, [channels, channel])

  const handleSubmit = useCallback(async () => {
    const pid = parseInt(productId, 10)
    if (!pid) { onError('请选择商品'); return }
    const vid = parseInt(variantId, 10)
    if (mode === 'manual' && !vid) { onError('请选择规格'); return }
    const rc = yuanToCents(refundAmount)
    if (rc <= 0) { onError('退款金额必须大于 0'); return }
    const oid = mode === 'linked' ? parseInt(orderId, 10) : null
    if (mode === 'linked' && !oid) { onError('请输入关联的订单号'); return }
    setSubmitting(true)
    try {
      const r = await recordRefund({
        sales_order_id: oid,
        product_id: pid,
        // 关联退款以原订单规格为准，这里传了也会被后端覆盖
        variant_id: vid || null,
        occurred_at: datetimeLocalToISO(occurredAt),
        refund_cents: rc,
        refund_qty: refundQty ? parseFloat(refundQty) : undefined,
        channel: channel || channels[0] || '微信退款',
        reason: reason || null,
        restore_stock: restoreStock,
      })
      setResult(r)
      const linkedText = r.linked ? `关联订单 #${oid}` : '手动退款'
      onSuccess(`退款成功：${linkedText}（${r.variant_name}），记录 #${r.refundId}`)
    } catch (e) {
      onError(humanError(e))
    } finally {
      setSubmitting(false)
    }
  }, [mode, productId, variantId, orderId, refundAmount, refundQty, channel, channels, occurredAt, reason, restoreStock, onError, onSuccess])

  return (
    <div className="mz-biz-form">
      <h3>退款记账</h3>
      <p className="mz-biz-hint">关联退款禁止累计超退；手动退款不关联原订单，需指定规格。</p>
      <FormField label="退款类型">
        <div className="mz-biz-radio">
          <label><input type="radio" checked={mode === 'linked'} onChange={() => setMode('linked')} /> 关联订单退款</label>
          <label><input type="radio" checked={mode === 'manual'} onChange={() => setMode('manual')} /> 手动退款</label>
        </div>
      </FormField>
      <VariantPicker
        products={products}
        productId={productId}
        variantId={variantId}
        onChange={n => { setProductId(n.productId); setVariantId(n.variantId); setResult(null) }}
      />
      {mode === 'linked' && (
        <FormField label="关联订单号">
          <NumberField value={orderId} onChange={setOrderId} decimal={false} placeholder="销售订单 #" />
        </FormField>
      )}
      <div className="mz-biz-row">
        <FormField label="退款金额（元）">
          <NumberField value={refundAmount} onChange={setRefundAmount} ariaLabel="退款金额（元）" />
        </FormField>
        <FormField label="退款数量（可选）">
          <NumberField value={refundQty} onChange={setRefundQty} ariaLabel="退款数量" />
        </FormField>
      </div>
      <div className="mz-biz-row">
        <FormField label="渠道">
          <select value={channel} onChange={e => setChannel(e.target.value)}>
            {channels.map(ch => <option key={ch} value={ch}>{ch}</option>)}
          </select>
        </FormField>
        <FormField label="时间">
          <input type="datetime-local" value={occurredAt} onChange={e => setOccurredAt(e.target.value)} />
        </FormField>
      </div>
      {mode === 'linked' && (
        <FormField label="恢复库存">
          <label className="mz-biz-check">
            <input type="checkbox" checked={restoreStock} onChange={e => setRestoreStock(e.target.checked)} />
            退款商品恢复到库存
          </label>
        </FormField>
      )}
      <FormField label="退款原因（可选）">
        <input type="text" value={reason} onChange={e => setReason(e.target.value)} />
      </FormField>
      <button type="button" className="mz-biz-submit" disabled={submitting} onClick={() => void handleSubmit()}>
        {submitting ? '提交中…' : '提交退款'}
      </button>
      {result && (
        <div className="mz-biz-result">
          <h4>记账结果</h4>
          <div>退款记录：#{result.refundId}　规格：{result.variant_name}</div>
          <div>类型：{result.linked ? '关联订单退款' : '手动退款'}</div>
          {result.original_channel && <div>原订单渠道：{result.original_channel}</div>}
        </div>
      )}
    </div>
  )
}

// === 客服收入表单 ===

function CSIncomeForm({ channels, onSuccess, onError }: {
  channels: readonly string[]
  onSuccess: (msg: string) => void
  onError: (msg: string) => void
}): ReactElement {
  const [amount, setAmount] = useState('')
  const [channel, setChannel] = useState('')
  const [occurredAt, setOccurredAt] = useState(isoToDatetimeLocal(new Date().toISOString()))
  const [description, setDescription] = useState('')
  const [note, setNote] = useState('')
  const [submitting, setSubmitting] = useState(false)

  useEffect(() => {
    if (channels.length > 0 && !channel) setChannel(channels[0])
  }, [channels, channel])

  const handleSubmit = useCallback(async () => {
    const ac = yuanToCents(amount)
    if (ac <= 0) { onError('金额必须大于 0'); return }
    setSubmitting(true)
    try {
      const id = await recordCSIncome({
        occurred_at: datetimeLocalToISO(occurredAt),
        amount_cents: ac,
        channel: channel || channels[0] || '微信收入',
        description: description || null,
        note: note || null,
      })
      onSuccess(`客服收入成功：记录 #${id}，金额 ${money(ac)}`)
      setAmount(''); setDescription(''); setNote('')
    } catch (e) {
      onError(humanError(e))
    } finally {
      setSubmitting(false)
    }
  }, [amount, channel, channels, occurredAt, description, note, onError, onSuccess])

  return (
    <div className="mz-biz-form">
      <h3>客服收入记账</h3>
      <p className="mz-biz-hint">独立记录，不计入商品销售。</p>
      <div className="mz-biz-row">
        <FormField label="金额（元）">
          <NumberField value={amount} onChange={setAmount} ariaLabel="金额（元）" />
        </FormField>
        <FormField label="渠道">
          <select value={channel} onChange={e => setChannel(e.target.value)}>
            {channels.map(ch => <option key={ch} value={ch}>{ch}</option>)}
          </select>
        </FormField>
      </div>
      <FormField label="时间">
        <input type="datetime-local" value={occurredAt} onChange={e => setOccurredAt(e.target.value)} />
      </FormField>
      <FormField label="描述">
        <input type="text" value={description} onChange={e => setDescription(e.target.value)} placeholder="如：代客下单服务费" />
      </FormField>
      <FormField label="备注（可选）">
        <input type="text" value={note} onChange={e => setNote(e.target.value)} />
      </FormField>
      <button type="button" className="mz-biz-submit" disabled={submitting} onClick={() => void handleSubmit()}>
        {submitting ? '提交中…' : '提交客服收入'}
      </button>
    </div>
  )
}

// === 其他收支表单 ===

function OtherForm({ channels, onSuccess, onError }: {
  channels: Channels
  onSuccess: (msg: string) => void
  onError: (msg: string) => void
}): ReactElement {
  const [kind, setKind] = useState<'income' | 'expense'>('income')
  const [amount, setAmount] = useState('')
  const [channel, setChannel] = useState('')
  const [itemName, setItemName] = useState('')
  const [occurredAt, setOccurredAt] = useState(isoToDatetimeLocal(new Date().toISOString()))
  const [note, setNote] = useState('')
  const [submitting, setSubmitting] = useState(false)

  const availableChannels = kind === 'income' ? channels.income : channels.expense

  useEffect(() => {
    if (availableChannels.length > 0) setChannel(availableChannels[0])
  }, [availableChannels])

  const handleSubmit = useCallback(async () => {
    const ac = yuanToCents(amount)
    if (ac <= 0) { onError('金额必须大于 0'); return }
    if (!itemName.trim()) { onError('请填写项目名称'); return }
    setSubmitting(true)
    try {
      const id = await recordOther({
        kind,
        occurred_at: datetimeLocalToISO(occurredAt),
        amount_cents: ac,
        channel: channel || availableChannels[0] || '微信收入',
        item_name: itemName.trim(),
        note: note || null,
      })
      onSuccess(`${kind === 'income' ? '其他收入' : '其他支出'}成功：记录 #${id}，金额 ${money(ac)}`)
      setAmount(''); setItemName(''); setNote('')
    } catch (e) {
      onError(humanError(e))
    } finally {
      setSubmitting(false)
    }
  }, [kind, amount, channel, availableChannels, occurredAt, itemName, note, onError, onSuccess])

  return (
    <div className="mz-biz-form">
      <h3>其他收支记账</h3>
      <FormField label="类型">
        <div className="mz-biz-radio">
          <label><input type="radio" checked={kind === 'income'} onChange={() => setKind('income')} /> 收入</label>
          <label><input type="radio" checked={kind === 'expense'} onChange={() => setKind('expense')} /> 支出</label>
        </div>
      </FormField>
      <div className="mz-biz-row">
        <FormField label="金额（元）">
          <NumberField value={amount} onChange={setAmount} ariaLabel="金额（元）" />
        </FormField>
        <FormField label="渠道">
          <select value={channel} onChange={e => setChannel(e.target.value)}>
            {availableChannels.map(ch => <option key={ch} value={ch}>{ch}</option>)}
          </select>
        </FormField>
      </div>
      <FormField label="项目名称">
        <input type="text" value={itemName} onChange={e => setItemName(e.target.value)} placeholder="如：理财收益 / 手续费" />
      </FormField>
      <FormField label="时间">
        <input type="datetime-local" value={occurredAt} onChange={e => setOccurredAt(e.target.value)} />
      </FormField>
      <FormField label="备注（可选）">
        <input type="text" value={note} onChange={e => setNote(e.target.value)} />
      </FormField>
      <button type="button" className="mz-biz-submit" disabled={submitting} onClick={() => void handleSubmit()}>
        {submitting ? '提交中…' : `提交其他${kind === 'income' ? '收入' : '支出'}`}
      </button>
    </div>
  )
}

// === 经营支出表单 ===

function ExpenseForm({ products, channels, onSuccess, onError }: {
  products: ProductWithVariantsDTO[]
  channels: Channels
  onSuccess: (msg: string) => void
  onError: (msg: string) => void
}): ReactElement {
  const [amount, setAmount] = useState('')
  const [channel, setChannel] = useState('')
  const [category, setCategory] = useState('')
  const [productId, setProductId] = useState('')
  const [occurredAt, setOccurredAt] = useState(isoToDatetimeLocal(new Date().toISOString()))
  const [purpose, setPurpose] = useState('')
  const [note, setNote] = useState('')
  const [submitting, setSubmitting] = useState(false)

  useEffect(() => {
    if (channels.expense.length > 0 && !channel) setChannel(channels.expense[0])
  }, [channels.expense, channel])

  useEffect(() => {
    if (channels.expenseCategories.length > 0 && !category) setCategory(channels.expenseCategories[0])
  }, [channels.expenseCategories, category])

  const handleSubmit = useCallback(async () => {
    const ac = yuanToCents(amount)
    if (ac <= 0) { onError('金额必须大于 0'); return }
    setSubmitting(true)
    try {
      const id = await recordExpense({
        occurred_at: datetimeLocalToISO(occurredAt),
        amount_cents: ac,
        channel: channel || channels.expense[0] || '微信支出',
        category: category || channels.expenseCategories[0] || '其他费用',
        product_id: productId ? parseInt(productId, 10) : null,
        purpose: purpose || null,
        note: note || null,
      })
      onSuccess(`经营支出成功：记录 #${id}，金额 ${money(ac)}`)
      setAmount(''); setPurpose(''); setNote('')
    } catch (e) {
      onError(humanError(e))
    } finally {
      setSubmitting(false)
    }
  }, [amount, channel, category, productId, occurredAt, purpose, note, channels, onError, onSuccess])

  return (
    <div className="mz-biz-form">
      <h3>经营支出记账</h3>
      <p className="mz-biz-hint">平台费用、运营费用等非商品采购支出。</p>
      <div className="mz-biz-row">
        <FormField label="金额（元）">
          <NumberField value={amount} onChange={setAmount} ariaLabel="金额（元）" />
        </FormField>
        <FormField label="渠道">
          <select value={channel} onChange={e => setChannel(e.target.value)}>
            {channels.expense.map(ch => <option key={ch} value={ch}>{ch}</option>)}
          </select>
        </FormField>
      </div>
      <div className="mz-biz-row">
        <FormField label="支出分类">
          <select value={category} onChange={e => setCategory(e.target.value)}>
            {channels.expenseCategories.map(cat => <option key={cat} value={cat}>{cat}</option>)}
          </select>
        </FormField>
        <FormField label="关联商品（可选）">
          <select value={productId} onChange={e => setProductId(e.target.value)}>
            <option value="">无</option>
            {products.map(p => <option key={p.id} value={p.id}>{p.brand} / {p.name}</option>)}
          </select>
        </FormField>
      </div>
      <FormField label="时间">
        <input type="datetime-local" value={occurredAt} onChange={e => setOccurredAt(e.target.value)} />
      </FormField>
      <FormField label="用途">
        <input type="text" value={purpose} onChange={e => setPurpose(e.target.value)} placeholder="如：平台手续费" />
      </FormField>
      <FormField label="备注（可选）">
        <input type="text" value={note} onChange={e => setNote(e.target.value)} />
      </FormField>
      <button type="button" className="mz-biz-submit" disabled={submitting} onClick={() => void handleSubmit()}>
        {submitting ? '提交中…' : '提交经营支出'}
      </button>
    </div>
  )
}

// === 通用表单组件 ===

function FormField({ label, children }: { label: string; children: ReactElement | ReactElement[] }): ReactElement {
  return (
    <div className="mz-biz-field">
      <label className="mz-biz-label">{label}</label>
      <div className="mz-biz-input">{children}</div>
    </div>
  )
}