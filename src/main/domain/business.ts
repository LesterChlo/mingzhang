// 商品经营核心域逻辑（第三/四阶段）。
// 设计要点：
//   - 多规格独立核算：每个商品下挂多个规格（如 1kg 装 / 2kg 装），每规格独立售价/成本/库存/累计。
//   - 商品层字段 = 各规格之和（recomputeProductFromVariants 统一汇总，不增量累加，避免漂移）。
//   - 加权平均成本：进货时按 (原库存成本 + 本次进货金额) / (原库存数量 + 本次进货数量) 更新，规格级计算。
//   - 成本快照：每笔销售订单保存成交时的规格平均成本，未来进货成本变化不改历史订单利润。
//   - 退款关联原订单：支持全额/部分/多次，禁止累计退款超过原订单可退金额；手动退款标记 linked=0。
//   - 一笔录入全表联动：销售/进货/退款在事务内同步更新规格 + 商品汇总，无需手动刷新。
//   - 金额一律整数分（amount_cents），避免浮点误差。
//   - 渠道为固定枚举（收入/支出/退款三套），代码常量定义。

import type { Database } from 'better-sqlite3-multiple-ciphers'
import { nowIso } from '../db/time'

// === 固定渠道（需求第六节） ===
export const INCOME_CHANNELS = ['微信收入', '支付宝收入', '小红书千帆收入'] as const
export const EXPENSE_CHANNELS = ['微信支出', '支付宝支出'] as const
export const REFUND_CHANNELS = ['微信退款', '支付宝退款', '小红书退款'] as const
export const EXPENSE_CATEGORIES = ['商品采购', '平台费用', '运营费用', '人工费用', '其他费用'] as const

// === 商品（商品层汇总字段 = 各规格之和） ===
export interface Product {
  id: number
  name: string
  brand: string
  standard_price_cents: number
  avg_cost_cents: number
  stock_qty: number
  stock_cost_cents: number
  cumulative_purchase_qty: number
  cumulative_purchase_cents: number
  cumulative_sales_qty: number
  cumulative_sales_cents: number
  cumulative_sales_cost_cents: number
  cumulative_refund_qty: number
  cumulative_refund_cents: number
  sales_order_count: number
}

export interface ProductWithVariants extends Product {
  variants: ProductVariant[]
}

// === 规格（独立核算单元） ===
export interface ProductVariant {
  id: number
  product_id: number
  spec_name: string
  standard_price_cents: number
  avg_cost_cents: number
  stock_qty: number
  stock_cost_cents: number
  cumulative_purchase_qty: number
  cumulative_purchase_cents: number
  cumulative_sales_qty: number
  cumulative_sales_cents: number
  cumulative_sales_cost_cents: number
  cumulative_refund_qty: number
  cumulative_refund_cents: number
  sales_order_count: number
  sort_order: number
  locked: number
}

/** 商品列表（不含规格明细，列表页够用）。 */
export function listProducts(db: Database): Product[] {
  return db.prepare('SELECT * FROM products ORDER BY id').all() as unknown as Product[]
}

/** 商品列表 + 各自规格明细（经营首页用）。 */
export function listProductsWithVariants(db: Database): ProductWithVariants[] {
  const products = listProducts(db)
  return products.map((p) => ({ ...p, variants: listVariants(db, p.id) }))
}

export function getProduct(db: Database, id: number): Product | null {
  return ((db.prepare('SELECT * FROM products WHERE id = ?').get(id) as Product | undefined) ?? null)
}

// === 规格 CRUD ===

/** 某商品的规格列表（按 sort_order, id 排序）。 */
export function listVariants(db: Database, productId: number): ProductVariant[] {
  return db
    .prepare('SELECT * FROM product_variants WHERE product_id = ? ORDER BY sort_order, id')
    .all(productId) as unknown as ProductVariant[]
}

export function getVariant(db: Database, id: number): ProductVariant | null {
  return ((db.prepare('SELECT * FROM product_variants WHERE id = ?').get(id) as ProductVariant | undefined) ?? null)
}

export interface CreateVariantInput {
  product_id: number
  spec_name: string
  standard_price_cents?: number
  sort_order?: number
  /** 建规格时顺带录入期初库存（≥0，允许小数）。 */
  stock_qty?: number
  /** 建规格时顺带录入单件成本（分，≥0）。 */
  avg_cost_cents?: number
}

/** 库存数量规范化：拒绝 NaN/Infinity，保留 3 位小数（支持 0.5 件、1.25kg）。 */
function normalizeStockQty(raw: number): number {
  const q = Number(raw)
  if (!Number.isFinite(q)) throw new Error('库存数量无效')
  if (q < 0) throw new Error('库存数量不能为负')
  return Math.round(q * 1000) / 1000
}

/** 单件成本规范化：整数分，拒绝 NaN/Infinity 与负数。 */
function normalizeUnitCost(raw: number): number {
  const c = Number(raw)
  if (!Number.isFinite(c)) throw new Error('单件成本无效')
  if (c < 0) throw new Error('单件成本不能为负')
  return Math.round(c)
}

/** 新增规格。同一商品下规格名不可重复。 */
export function createVariant(db: Database, input: CreateVariantInput): number {
  const ts = nowIso()
  const name = input.spec_name.trim()
  if (!name) throw new Error('规格名称不能为空')
  const p = getProduct(db, input.product_id)
  if (!p) throw new Error(`商品 #${input.product_id} 不存在`)
  const initQty = input.stock_qty === undefined ? 0 : normalizeStockQty(input.stock_qty)
  const initCost = input.avg_cost_cents === undefined ? 0 : normalizeUnitCost(input.avg_cost_cents)
  const dup = db
    .prepare('SELECT id FROM product_variants WHERE product_id = ? AND spec_name = ?')
    .get(input.product_id, name) as { id: number } | undefined
  if (dup) throw new Error(`规格「${name}」已存在`)
  let order = input.sort_order
  if (order == null) {
    const maxRow = db
      .prepare('SELECT COALESCE(MAX(sort_order), -1) AS m FROM product_variants WHERE product_id = ?')
      .get(input.product_id) as { m: number }
    order = maxRow.m + 1
  }
  const r = db
    .prepare(
      'INSERT INTO product_variants (product_id, spec_name, standard_price_cents, sort_order,' +
        ' stock_qty, avg_cost_cents, stock_cost_cents, created_at, updated_at)' +
        ' VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
    )
    .run(
      input.product_id, name, input.standard_price_cents ?? 0, order,
      initQty, initCost, Math.round(initQty * initCost), ts, ts,
    )
  // 带期初库存/成本时商品层汇总要跟着变；不带的话新规格全零，汇总无变化，省一次写。
  if (initQty !== 0 || initCost !== 0) recomputeProductFromVariants(db, input.product_id)
  return Number(r.lastInsertRowid)
}

export interface UpdateVariantInput {
  id: number
  spec_name?: string
  standard_price_cents?: number
  sort_order?: number
  /** 手工校准库存（≥0，允许小数）。不传 = 不改。 */
  stock_qty?: number
  /** 手工校准单件成本（分，≥0）。不传 = 不改。 */
  avg_cost_cents?: number
}

/**
 * 修改规格（名称/售价/排序/库存/单件成本）。历史订单走 variant_name 与 cost_per_unit 快照，改名改价改成本都不改历史。
 *
 * 关于库存与单件成本（第十阶段用户反馈后开放）：
 *   - 这两个字段平时由「进货」按加权平均自动维护，但用户也需要能直接填自己的库存与成本
 *     （私域手工发货、期初建账、盘点对不上号等场景，走一遍进货流程反而别扭）。
 *   - 手工校准直接覆盖 stock_qty / avg_cost_cents，并把 stock_cost_cents 重算为 qty × cost，
 *     保证「库存成本 = 库存数量 × 单件成本」这条恒等式不被破坏。
 *   - 不动 cumulative_* 系列字段：那些是历史事实的累计，校准不是进货也不是销售。
 *   - 已成交订单的成本快照在 sales_orders 里，因此改成本不会回头篡改旧利润。
 */
export function updateVariant(db: Database, input: UpdateVariantInput): void {
  const v = getVariant(db, input.id)
  if (!v) throw new Error(`规格 #${input.id} 不存在`)
  const ts = nowIso()
  const sets: string[] = []
  const args: unknown[] = []
  if (input.spec_name !== undefined) {
    const name = input.spec_name.trim()
    if (!name) throw new Error('规格名称不能为空')
    const dup = db
      .prepare('SELECT id FROM product_variants WHERE product_id = ? AND spec_name = ? AND id <> ?')
      .get(v.product_id, name, v.id) as { id: number } | undefined
    if (dup) throw new Error(`规格「${name}」已存在`)
    sets.push('spec_name = ?')
    args.push(name)
  }
  if (input.standard_price_cents !== undefined) {
    if (input.standard_price_cents < 0) throw new Error('售价不能为负')
    sets.push('standard_price_cents = ?')
    args.push(input.standard_price_cents)
  }
  if (input.sort_order !== undefined) {
    sets.push('sort_order = ?')
    args.push(input.sort_order)
  }
  // 库存 / 单件成本：任一被传就一起写，库存成本跟着重算，避免三者互相打架
  const touchesStock = input.stock_qty !== undefined || input.avg_cost_cents !== undefined
  if (touchesStock) {
    const nextQty = input.stock_qty === undefined ? v.stock_qty : normalizeStockQty(input.stock_qty)
    const nextCost = input.avg_cost_cents === undefined ? v.avg_cost_cents : normalizeUnitCost(input.avg_cost_cents)
    sets.push('stock_qty = ?', 'avg_cost_cents = ?', 'stock_cost_cents = ?')
    args.push(nextQty, nextCost, Math.round(nextQty * nextCost))
  }
  if (sets.length === 0) return
  sets.push('updated_at = ?')
  args.push(ts, input.id)
  db.prepare(`UPDATE product_variants SET ${sets.join(', ')} WHERE id = ?`).run(...args)
  // 商品层汇总 = 各规格之和，库存/成本动了必须重算，否则商品行与经营概览会滞后
  if (touchesStock) recomputeProductFromVariants(db, v.product_id)
}

/** 删除规格。已有任何销售/进货/退款记录的规格不允许删除（保全历史账）。 */
export function deleteVariant(db: Database, id: number): void {
  const v = getVariant(db, id)
  if (!v) throw new Error(`规格 #${id} 不存在`)
  if (v.sales_order_count > 0 || v.cumulative_purchase_qty !== 0 || v.cumulative_refund_qty !== 0) {
    throw new Error('该规格已有历史记录，不能删除（可改名或停用）')
  }
  db.prepare('DELETE FROM product_variants WHERE id = ?').run(id)
}

/** 修改规格标准售价（不影响历史订单）。 */
export function updateVariantPrice(db: Database, id: number, standardPriceCents: number): void {
  updateVariant(db, { id, standard_price_cents: standardPriceCents })
}

/** 兼容旧接口：改商品售价 = 改其首个规格售价。 */
export function updateProductPrice(db: Database, id: number, standardPriceCents: number): void {
  const variants = listVariants(db, id)
  if (variants.length === 0) throw new Error('该商品还没有规格')
  updateVariantPrice(db, variants[0].id, standardPriceCents)
}

/** 取规格：显式给 variant_id 则校验归属；未给则回落到商品首个规格（兼容旧调用）。 */
function resolveVariant(db: Database, productId: number, variantId?: number | null): ProductVariant {
  if (variantId != null) {
    const v = getVariant(db, variantId)
    if (!v) throw new Error(`规格 #${variantId} 不存在`)
    if (v.product_id !== productId) throw new Error('规格与商品不匹配')
    return v
  }
  const list = listVariants(db, productId)
  if (list.length === 0) throw new Error('该商品还没有规格，请先在商品列表添加规格')
  return list[0]
}

/** 把商品层汇总字段重算为「各规格之和」。不增量累加，杜绝漂移。 */
function recomputeProductFromVariants(db: Database, productId: number): void {
  const ts = nowIso()
  const s = db
    .prepare(
      'SELECT' +
        ' COALESCE(SUM(stock_qty),0) AS stock_qty,' +
        ' COALESCE(SUM(stock_cost_cents),0) AS stock_cost_cents,' +
        ' COALESCE(SUM(cumulative_purchase_qty),0) AS cumulative_purchase_qty,' +
        ' COALESCE(SUM(cumulative_purchase_cents),0) AS cumulative_purchase_cents,' +
        ' COALESCE(SUM(cumulative_sales_qty),0) AS cumulative_sales_qty,' +
        ' COALESCE(SUM(cumulative_sales_cents),0) AS cumulative_sales_cents,' +
        ' COALESCE(SUM(cumulative_sales_cost_cents),0) AS cumulative_sales_cost_cents,' +
        ' COALESCE(SUM(cumulative_refund_qty),0) AS cumulative_refund_qty,' +
        ' COALESCE(SUM(cumulative_refund_cents),0) AS cumulative_refund_cents,' +
        ' COALESCE(SUM(sales_order_count),0) AS sales_order_count,' +
        ' COALESCE(MAX(standard_price_cents),0) AS standard_price_cents' +
        ' FROM product_variants WHERE product_id = ?',
    )
    .get(productId) as Record<string, number>
  const avg = s.stock_qty > 0 ? Math.round(s.stock_cost_cents / s.stock_qty) : 0
  db.prepare(
    'UPDATE products SET' +
      ' standard_price_cents = ?, avg_cost_cents = ?, stock_qty = ?, stock_cost_cents = ?,' +
      ' cumulative_purchase_qty = ?, cumulative_purchase_cents = ?,' +
      ' cumulative_sales_qty = ?, cumulative_sales_cents = ?, cumulative_sales_cost_cents = ?,' +
      ' cumulative_refund_qty = ?, cumulative_refund_cents = ?, sales_order_count = ?,' +
      ' updated_at = ? WHERE id = ?',
  ).run(
    s.standard_price_cents, avg, s.stock_qty, s.stock_cost_cents,
    s.cumulative_purchase_qty, s.cumulative_purchase_cents,
    s.cumulative_sales_qty, s.cumulative_sales_cents, s.cumulative_sales_cost_cents,
    s.cumulative_refund_qty, s.cumulative_refund_cents, s.sales_order_count,
    ts, productId,
  )
}

// === 销售记账（成本快照） ===
export interface SaleInput {
  product_id: number
  /** 规格 id。缺省 = 商品首个规格（UI 一律显式传）。 */
  variant_id?: number | null
  occurred_at: string
  qty: number
  unit_price_cents: number
  channel: string
  order_no?: string | null
  note?: string | null
}

export interface SaleResult {
  orderId: number
  variant_id: number
  variant_name: string
  amount_cents: number
  cost_per_unit_cents: number
  total_cost_cents: number
  gross_profit_cents: number
}

/** 销售记账：创建订单（含规格成本快照）+ 更新规格累计/库存 + 商品汇总。事务原子。 */
export const recordSale = (db: Database, input: SaleInput): SaleResult => {
  const ts = nowIso()
  const tx = db.transaction((): SaleResult => {
    const p = getProduct(db, input.product_id)
    if (!p) throw new Error(`商品 #${input.product_id} 不存在`)
    if (input.qty <= 0) throw new Error('销售数量必须大于 0')
    const v = resolveVariant(db, input.product_id, input.variant_id)
    const amount = Math.round(input.qty * input.unit_price_cents)
    // 成本快照：成交时该规格的加权平均成本
    const costPerUnit = v.avg_cost_cents
    const totalCost = Math.round(input.qty * costPerUnit)
    const grossProfit = amount - totalCost
    const r = db.prepare(
      'INSERT INTO sales_orders' +
        ' (order_no, product_id, variant_id, variant_name, occurred_at, qty, unit_price_cents, amount_cents,' +
        '  cost_per_unit_cents, total_cost_cents, gross_profit_cents, channel, status,' +
        '  refunded_cents, refunded_qty, note, created_at, updated_at)' +
        " VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'confirmed', 0, 0, ?, ?, ?)",
    ).run(
      input.order_no ?? null, input.product_id, v.id, v.spec_name, input.occurred_at, input.qty,
      input.unit_price_cents, amount, costPerUnit, totalCost, grossProfit,
      input.channel, input.note ?? null, ts, ts,
    )
    const orderId = Number(r.lastInsertRowid)
    // 联动：规格累计 + 库存
    db.prepare(
      'UPDATE product_variants SET' +
        ' cumulative_sales_qty = cumulative_sales_qty + ?,' +
        ' cumulative_sales_cents = cumulative_sales_cents + ?,' +
        ' cumulative_sales_cost_cents = cumulative_sales_cost_cents + ?,' +
        ' sales_order_count = sales_order_count + 1,' +
        ' stock_qty = stock_qty - ?,' +
        ' stock_cost_cents = stock_cost_cents - ?,' +
        ' updated_at = ? WHERE id = ?',
    ).run(input.qty, amount, totalCost, input.qty, totalCost, ts, v.id)
    recomputeProductFromVariants(db, input.product_id)
    return {
      orderId, variant_id: v.id, variant_name: v.spec_name,
      amount_cents: amount, cost_per_unit_cents: costPerUnit,
      total_cost_cents: totalCost, gross_profit_cents: grossProfit,
    }
  })
  return tx() as unknown as SaleResult
}

// === 进货记账（加权平均成本） ===
export interface PurchaseInput {
  product_id: number
  /** 规格 id。缺省 = 商品首个规格。 */
  variant_id?: number | null
  occurred_at: string
  qty: number
  total_cents: number
  channel: string
  note?: string | null
}

export interface PurchaseResult {
  purchaseId: number
  variant_id: number
  variant_name: string
  unit_cost_cents: number
  prev_avg_cost_cents: number
  prev_stock_qty: number
  new_avg_cost_cents: number
}

/** 进货记账：更新规格加权平均成本 + 规格累计/库存 + 商品汇总。事务原子。 */
export const recordPurchase = (db: Database, input: PurchaseInput): PurchaseResult => {
  const ts = nowIso()
  const tx = db.transaction((): PurchaseResult => {
    const p = getProduct(db, input.product_id)
    if (!p) throw new Error(`商品 #${input.product_id} 不存在`)
    if (input.qty <= 0) throw new Error('进货数量必须大于 0')
    if (input.total_cents < 0) throw new Error('进货金额不能为负')
    const v = resolveVariant(db, input.product_id, input.variant_id)
    const unitCost = Math.round(input.total_cents / input.qty)
    const prevAvg = v.avg_cost_cents
    const prevQty = v.stock_qty
    const prevCost = v.stock_cost_cents
    const newQty = prevQty + input.qty
    const newCost = prevCost + input.total_cents
    // 加权平均成本 = (原库存成本 + 本次进货金额) / (原库存数量 + 本次进货数量)
    const newAvg = newQty > 0 ? Math.round(newCost / newQty) : unitCost
    const r = db.prepare(
      'INSERT INTO purchase_records' +
        ' (product_id, variant_id, variant_name, occurred_at, qty, total_cents, unit_cost_cents, channel,' +
        '  prev_avg_cost_cents, prev_stock_qty, new_avg_cost_cents, note, created_at, updated_at)' +
        ' VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
    ).run(
      input.product_id, v.id, v.spec_name, input.occurred_at, input.qty, input.total_cents, unitCost,
      input.channel, prevAvg, prevQty, newAvg, input.note ?? null, ts, ts,
    )
    const purchaseId = Number(r.lastInsertRowid)
    db.prepare(
      'UPDATE product_variants SET' +
        ' avg_cost_cents = ?, stock_qty = ?, stock_cost_cents = ?,' +
        ' cumulative_purchase_qty = cumulative_purchase_qty + ?,' +
        ' cumulative_purchase_cents = cumulative_purchase_cents + ?,' +
        ' updated_at = ? WHERE id = ?',
    ).run(newAvg, newQty, newCost, input.qty, input.total_cents, ts, v.id)
    recomputeProductFromVariants(db, input.product_id)
    return {
      purchaseId, variant_id: v.id, variant_name: v.spec_name,
      unit_cost_cents: unitCost, prev_avg_cost_cents: prevAvg,
      prev_stock_qty: prevQty, new_avg_cost_cents: newAvg,
    }
  })
  return tx() as unknown as PurchaseResult
}

// === 退款记账 ===
export interface RefundInput {
  sales_order_id?: number | null // null = 手动退款（未关联原订单）
  product_id: number
  /** 规格 id。关联原订单时以订单规格为准；手动退款需显式给。 */
  variant_id?: number | null
  occurred_at: string
  refund_cents: number
  refund_qty?: number
  channel: string
  reason?: string | null
  restore_stock?: boolean // 退款是否恢复库存（按实际处理决定）
  note?: string | null
}

export interface RefundResult {
  refundId: number
  linked: boolean
  variant_id: number
  variant_name: string
  original_channel?: string | null
}

/** 退款记账：关联原订单（全额/部分/多次，禁止超退）或手动退款；更新规格+商品累计。事务原子。 */
export const recordRefund = (db: Database, input: RefundInput): RefundResult => {
  const ts = nowIso()
  const tx = db.transaction((): RefundResult => {
    const p = getProduct(db, input.product_id)
    if (!p) throw new Error(`商品 #${input.product_id} 不存在`)
    if (input.refund_cents <= 0) throw new Error('退款金额必须大于 0')
    const restoreStock = input.restore_stock ? 1 : 0
    const refundQty = input.refund_qty ?? 0
    let originalChannel: string | null = null
    let orderVariantId: number | null = null
    let orderVariantName: string | null = null

    if (input.sales_order_id != null) {
      const order = db.prepare('SELECT * FROM sales_orders WHERE id = ?').get(input.sales_order_id) as
        | {
            id: number
            amount_cents: number
            refunded_cents: number
            channel: string
            cost_per_unit_cents: number
            product_id: number
            variant_id: number | null
            variant_name: string | null
          }
        | undefined
      if (!order) throw new Error(`销售订单 #${input.sales_order_id} 不存在`)
      if (order.product_id !== input.product_id) throw new Error('退款商品与原订单商品不匹配')
      // 禁止累计退款超过原订单可退金额
      if (order.refunded_cents + input.refund_cents > order.amount_cents) {
        throw new Error(
          `退款金额超出可退额度：原订单 ${order.amount_cents} 分，已退 ${order.refunded_cents} 分，本次 ${input.refund_cents} 分`,
        )
      }
      originalChannel = order.channel
      orderVariantId = order.variant_id
      orderVariantName = order.variant_name
      const newRefunded = order.refunded_cents + input.refund_cents
      const status = newRefunded >= order.amount_cents ? 'refunded' : 'partial_refunded'
      db.prepare(
        'UPDATE sales_orders SET refunded_cents = ?, refunded_qty = refunded_qty + ?, status = ?, updated_at = ? WHERE id = ?',
      ).run(newRefunded, refundQty, status, ts, input.sales_order_id)
    }

    // 关联退款用订单规格；手动退款用显式规格或首规格
    const v = resolveVariant(db, input.product_id, orderVariantId ?? input.variant_id)
    const variantName = orderVariantName ?? v.spec_name

    const r = db.prepare(
      'INSERT INTO refunds' +
        ' (refund_no, sales_order_id, product_id, variant_id, variant_name, occurred_at, refund_cents, refund_qty,' +
        '  channel, original_channel, reason, linked, restore_stock, note, created_at, updated_at)' +
        ' VALUES (NULL, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
    ).run(
      input.sales_order_id ?? null, input.product_id, v.id, variantName, input.occurred_at,
      input.refund_cents, refundQty, input.channel, originalChannel,
      input.reason ?? null, input.sales_order_id != null ? 1 : 0, restoreStock,
      input.note ?? null, ts, ts,
    )
    const refundId = Number(r.lastInsertRowid)

    // 联动：规格累计退款
    db.prepare(
      'UPDATE product_variants SET' +
        ' cumulative_refund_qty = cumulative_refund_qty + ?,' +
        ' cumulative_refund_cents = cumulative_refund_cents + ?,' +
        ' updated_at = ? WHERE id = ?',
    ).run(refundQty, input.refund_cents, ts, v.id)

    // 退款恢复库存（仅关联退款 + 用户选择恢复时）
    if (restoreStock && refundQty > 0 && input.sales_order_id != null) {
      const order = db.prepare('SELECT cost_per_unit_cents FROM sales_orders WHERE id = ?')
        .get(input.sales_order_id) as { cost_per_unit_cents: number }
      const restoreCost = Math.round(refundQty * order.cost_per_unit_cents)
      db.prepare(
        'UPDATE product_variants SET stock_qty = stock_qty + ?, stock_cost_cents = stock_cost_cents + ?, updated_at = ? WHERE id = ?',
      ).run(refundQty, restoreCost, ts, v.id)
    }

    recomputeProductFromVariants(db, input.product_id)
    return {
      refundId, linked: input.sales_order_id != null,
      variant_id: v.id, variant_name: variantName, original_channel: originalChannel,
    }
  })
  return tx() as unknown as RefundResult
}

// === 客服收入（独立，不计入商品销售） ===
export interface CSIncomeInput {
  occurred_at: string
  amount_cents: number
  channel: string
  description?: string | null
  note?: string | null
}
export function recordCSIncome(db: Database, input: CSIncomeInput): number {
  const ts = nowIso()
  const r = db.prepare(
    'INSERT INTO customer_service_income (occurred_at, amount_cents, channel, description, note, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
  ).run(input.occurred_at, input.amount_cents, input.channel, input.description ?? null, input.note ?? null, ts, ts)
  return Number(r.lastInsertRowid)
}

// === 其他收支 ===
export interface OtherInput {
  kind: 'income' | 'expense'
  occurred_at: string
  amount_cents: number
  channel: string
  item_name: string
  note?: string | null
}
export function recordOther(db: Database, input: OtherInput): number {
  const ts = nowIso()
  const r = db.prepare(
    'INSERT INTO other_income_expense (kind, occurred_at, amount_cents, channel, item_name, note, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
  ).run(input.kind, input.occurred_at, input.amount_cents, input.channel, input.item_name, input.note ?? null, ts, ts)
  return Number(r.lastInsertRowid)
}

// === 经营支出 ===
export interface ExpenseInput {
  occurred_at: string
  amount_cents: number
  channel: string
  category: string
  product_id?: number | null
  purchase_id?: number | null
  purpose?: string | null
  note?: string | null
}
export function recordExpense(db: Database, input: ExpenseInput): number {
  const ts = nowIso()
  const r = db.prepare(
    'INSERT INTO expense_records (occurred_at, amount_cents, channel, category, product_id, purchase_id, purpose, note, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
  ).run(
    input.occurred_at, input.amount_cents, input.channel, input.category,
    input.product_id ?? null, input.purchase_id ?? null, input.purpose ?? null,
    input.note ?? null, ts, ts,
  )
  return Number(r.lastInsertRowid)
}

// === 商品/规格档案（含计算字段） ===
export interface ProfileCalc {
  net_sales_cents: number // 净销售额 = 累计销售 - 累计退款
  gross_profit_cents: number // 毛利润 = 净销售额 - 累计销售成本
  refund_amount_rate: number // 退款金额率 = 退款金额 / 累计销售金额
}

export interface ProductProfile extends Product, ProfileCalc {
  variants: ProductVariantProfile[]
}
export type ProductVariantProfile = ProductVariant & ProfileCalc

function calcProfile(row: {
  cumulative_sales_cents: number
  cumulative_refund_cents: number
  cumulative_sales_cost_cents: number
}): ProfileCalc {
  const netSales = row.cumulative_sales_cents - row.cumulative_refund_cents
  const grossProfit = netSales - row.cumulative_sales_cost_cents
  const rate = row.cumulative_sales_cents > 0 ? row.cumulative_refund_cents / row.cumulative_sales_cents : 0
  return { net_sales_cents: netSales, gross_profit_cents: grossProfit, refund_amount_rate: rate }
}

/** 商品档案：商品级计算字段 + 各规格档案。 */
export function getProductProfile(db: Database, id: number): ProductProfile | null {
  const p = getProduct(db, id)
  if (!p) return null
  const variants = listVariants(db, id).map((v) => ({ ...v, ...calcProfile(v) }))
  return { ...p, ...calcProfile(p), variants }
}

/** 规格档案（单规格计算字段）。 */
export function getVariantProfile(db: Database, id: number): ProductVariantProfile | null {
  const v = getVariant(db, id)
  if (!v) return null
  return { ...v, ...calcProfile(v) }
}

// === 实时盈亏测算（第五阶段） ===
// 口径：
//   净销售额 = 销售金额 - 退款金额
//   销售成本 = 成交时冻结的成本快照之和（不随进货变化）
//   毛利润   = 净销售额 - 销售成本
//   净利润   = 毛利润 + 客服收入 + 其他收入 - 经营支出 - 其他支出
// 金额一律整数分；比率返回 0-1 的小数，前端负责格式化。

/** 单个商品的盈亏汇总。 */
export interface ProductProfit {
  product_id: number
  product_name: string
  brand: string
  sales_cents: number // 销售金额
  refund_cents: number // 退款金额
  net_sales_cents: number // 净销售额
  cost_cents: number // 销售成本（成本快照之和）
  gross_profit_cents: number // 毛利润
  gross_margin: number // 毛利率 = 毛利润 / 净销售额
  sales_qty: number
  refund_qty: number
  order_count: number
}

/** 单个渠道的收支汇总。 */
export interface ChannelProfit {
  channel: string
  kind: 'income' | 'expense'
  amount_cents: number
  count: number
}

/** 全局经营概览。 */
export interface BusinessOverview {
  // 销售侧
  sales_cents: number // 销售总额
  refund_cents: number // 退款总额
  net_sales_cents: number // 净销售额
  cost_cents: number // 销售成本（快照）
  gross_profit_cents: number // 毛利润
  gross_margin: number // 毛利率
  sales_qty: number
  order_count: number
  // 其他收入
  cs_income_cents: number // 客服收入
  other_income_cents: number // 其他收入
  // 支出
  expense_cents: number // 经营支出
  other_expense_cents: number // 其他支出
  // 净利润 = 毛利润 + 客服收入 + 其他收入 - 经营支出 - 其他支出
  net_profit_cents: number
  net_margin: number // 净利率 = 净利润 / (净销售额 + 客服收入 + 其他收入)
  // 库存
  stock_qty: number
  stock_cost_cents: number // 库存占用成本
  // 商品/渠道维度
  products: ProductProfit[]
  channels: ChannelProfit[]
  // 今日快照（occurred_at 当天）
  today: {
    sales_cents: number
    refund_cents: number
    net_sales_cents: number
    cost_cents: number
    gross_profit_cents: number
    expense_cents: number
    net_profit_cents: number
    order_count: number
  }
}

/** 区间过滤条件：occurred_at（ISO）落在 [from, to) 内。 */
export interface OverviewRange {
  /** 起始时间（含）。ISO 字符串或 null = 不限。 */
  from?: string | null
  /** 结束时间（不含）。ISO 字符串或 null = 不限。 */
  to?: string | null
}

function rangeClause(column: string, range?: OverviewRange): { sql: string; args: string[] } {
  const conds: string[] = []
  const args: string[] = []
  if (range?.from) { conds.push(`${column} >= ?`); args.push(range.from) }
  if (range?.to) { conds.push(`${column} < ?`); args.push(range.to) }
  return { sql: conds.length > 0 ? ` AND ${conds.join(' AND ')}` : '', args }
}

/** 商品维度盈亏（区间内）。 */
function productProfits(db: Database, range?: OverviewRange): ProductProfit[] {
  // 区间条件放在 LEFT JOIN 的 ON 里：保留全部商品，只匹配区间内的订单
  const s = rangeClause('so.occurred_at', range)
  const rows = db.prepare(`
    SELECT p.id AS product_id, p.name AS product_name, p.brand AS brand,
      COALESCE(SUM(so.amount_cents),0) AS sales_cents,
      COALESCE(SUM(so.total_cost_cents),0) AS cost_cents,
      COALESCE(SUM(so.qty),0) AS sales_qty,
      COUNT(so.id) AS order_count
    FROM products p
    LEFT JOIN sales_orders so ON so.product_id = p.id${s.sql}
    GROUP BY p.id ORDER BY p.id
  `).all(...s.args) as unknown as {
    product_id: number; product_name: string; brand: string
    sales_cents: number; cost_cents: number; sales_qty: number; order_count: number
  }[]

  // 退款按商品聚合（区间内）
  const rs = rangeClause('rf.occurred_at', range)
  const refundRows = db.prepare(`
    SELECT rf.product_id AS product_id,
      COALESCE(SUM(rf.refund_cents),0) AS refund_cents,
      COALESCE(SUM(rf.refund_qty),0) AS refund_qty
    FROM refunds rf
    WHERE 1=1${rs.sql}
    GROUP BY rf.product_id
  `).all(...rs.args) as unknown as { product_id: number; refund_cents: number; refund_qty: number }[]
  const refundMap = new Map(refundRows.map((r) => [r.product_id, r]))

  return rows.map((r) => {
    const refund = refundMap.get(r.product_id)
    const refundCents = refund?.refund_cents ?? 0
    const netSales = r.sales_cents - refundCents
    const grossProfit = netSales - r.cost_cents
    return {
      product_id: r.product_id, product_name: r.product_name, brand: r.brand,
      sales_cents: r.sales_cents, refund_cents: refundCents, net_sales_cents: netSales,
      cost_cents: r.cost_cents, gross_profit_cents: grossProfit,
      gross_margin: netSales > 0 ? grossProfit / netSales : 0,
      sales_qty: r.sales_qty, refund_qty: refund?.refund_qty ?? 0, order_count: r.order_count,
    }
  })
}

/** 渠道维度收支（区间内）：销售/退款/客服/其他/支出各渠道汇总。 */
function channelProfits(db: Database, range?: OverviewRange): ChannelProfit[] {
  const out: ChannelProfit[] = []
  const push = (channel: string, kind: 'income' | 'expense', amount: number, count: number) => {
    if (count === 0) return
    out.push({ channel, kind, amount_cents: amount, count })
  }

  // 销售（收入）
  const so = rangeClause('occurred_at', range)
  const salesRows = db.prepare(
    `SELECT channel, COALESCE(SUM(amount_cents),0) AS amount, COUNT(*) AS c FROM sales_orders WHERE 1=1${so.sql} GROUP BY channel`,
  ).all(...so.args) as unknown as { channel: string; amount: number; c: number }[]
  salesRows.forEach((r) => push(r.channel, 'income', r.amount, r.c))

  // 客服收入
  const cs = rangeClause('occurred_at', range)
  const csRows = db.prepare(
    `SELECT channel, COALESCE(SUM(amount_cents),0) AS amount, COUNT(*) AS c FROM customer_service_income WHERE 1=1${cs.sql} GROUP BY channel`,
  ).all(...cs.args) as unknown as { channel: string; amount: number; c: number }[]
  csRows.forEach((r) => push(r.channel, 'income', r.amount, r.c))

  // 其他收支
  const oi = rangeClause('occurred_at', range)
  const otherRows = db.prepare(
    `SELECT kind, channel, COALESCE(SUM(amount_cents),0) AS amount, COUNT(*) AS c FROM other_income_expense WHERE 1=1${oi.sql} GROUP BY kind, channel`,
  ).all(...oi.args) as unknown as { kind: 'income' | 'expense'; channel: string; amount: number; c: number }[]
  otherRows.forEach((r) => push(r.channel, r.kind, r.amount, r.c))

  // 经营支出
  const ex = rangeClause('occurred_at', range)
  const expRows = db.prepare(
    `SELECT channel, COALESCE(SUM(amount_cents),0) AS amount, COUNT(*) AS c FROM expense_records WHERE 1=1${ex.sql} GROUP BY channel`,
  ).all(...ex.args) as unknown as { channel: string; amount: number; c: number }[]
  expRows.forEach((r) => push(r.channel, 'expense', r.amount, r.c))

  // 合并同名同向渠道
  const merged = new Map<string, ChannelProfit>()
  for (const item of out) {
    const key = `${item.kind}:${item.channel}`
    const exist = merged.get(key)
    if (exist) {
      exist.amount_cents += item.amount_cents
      exist.count += item.count
    } else {
      merged.set(key, { ...item })
    }
  }
  return [...merged.values()].sort((a, b) => b.amount_cents - a.amount_cents)
}

/** 全局经营概览（区间可空 = 全部）。一笔录入后调用即可拿到联动后的最新数字。 */
export function getBusinessOverview(db: Database, range?: OverviewRange): BusinessOverview {
  const sc = rangeClause('occurred_at', range)
  const salesAgg = db.prepare(
    `SELECT COALESCE(SUM(amount_cents),0) AS sales, COALESCE(SUM(total_cost_cents),0) AS cost,
      COALESCE(SUM(qty),0) AS qty, COUNT(*) AS c FROM sales_orders WHERE 1=1${sc.sql}`,
  ).get(...sc.args) as { sales: number; cost: number; qty: number; c: number }

  const rc = rangeClause('occurred_at', range)
  const refundAgg = db.prepare(
    `SELECT COALESCE(SUM(refund_cents),0) AS refund FROM refunds WHERE 1=1${rc.sql}`,
  ).get(...rc.args) as { refund: number }

  const csAgg = db.prepare(
    `SELECT COALESCE(SUM(amount_cents),0) AS amount FROM customer_service_income WHERE 1=1${rc.sql}`,
  ).get(...rc.args) as { amount: number }

  const otherIncomeAgg = db.prepare(
    `SELECT COALESCE(SUM(amount_cents),0) AS amount FROM other_income_expense WHERE kind='income'${rc.sql}`,
  ).get(...rc.args) as { amount: number }

  const otherExpenseAgg = db.prepare(
    `SELECT COALESCE(SUM(amount_cents),0) AS amount FROM other_income_expense WHERE kind='expense'${rc.sql}`,
  ).get(...rc.args) as { amount: number }

  const expAgg = db.prepare(
    `SELECT COALESCE(SUM(amount_cents),0) AS amount FROM expense_records WHERE 1=1${rc.sql}`,
  ).get(...rc.args) as { amount: number }

  const stockAgg = db.prepare(
    'SELECT COALESCE(SUM(stock_qty),0) AS qty, COALESCE(SUM(stock_cost_cents),0) AS cost FROM product_variants',
  ).get() as { qty: number; cost: number }

  const salesCents = salesAgg.sales
  const refundCents = refundAgg.refund
  const netSales = salesCents - refundCents
  const costCents = salesAgg.cost
  const grossProfit = netSales - costCents
  const csIncome = csAgg.amount
  const otherIncome = otherIncomeAgg.amount
  const expenseCents = expAgg.amount
  const otherExpense = otherExpenseAgg.amount
  const netProfit = grossProfit + csIncome + otherIncome - expenseCents - otherExpense
  const totalRevenue = netSales + csIncome + otherIncome

  // 今日（本地日界）
  const dayStart = new Date()
  dayStart.setHours(0, 0, 0, 0)
  const dayEnd = new Date(dayStart)
  dayEnd.setDate(dayEnd.getDate() + 1)
  const todayRange: OverviewRange = { from: dayStart.toISOString(), to: dayEnd.toISOString() }
  const tc = rangeClause('occurred_at', todayRange)
  const todaySales = db.prepare(
    `SELECT COALESCE(SUM(amount_cents),0) AS sales, COALESCE(SUM(total_cost_cents),0) AS cost,
      COALESCE(SUM(qty),0) AS qty, COUNT(*) AS c FROM sales_orders WHERE 1=1${tc.sql}`,
  ).get(...tc.args) as { sales: number; cost: number; qty: number; c: number }
  const todayRefund = db.prepare(
    `SELECT COALESCE(SUM(refund_cents),0) AS refund FROM refunds WHERE 1=1${tc.sql}`,
  ).get(...tc.args) as { refund: number }
  const todayExpense = db.prepare(
    `SELECT COALESCE(SUM(amount_cents),0) AS amount FROM expense_records WHERE 1=1${tc.sql}`,
  ).get(...tc.args) as { amount: number }

  const todayNetSales = todaySales.sales - todayRefund.refund
  const todayGross = todayNetSales - todaySales.cost

  return {
    sales_cents: salesCents,
    refund_cents: refundCents,
    net_sales_cents: netSales,
    cost_cents: costCents,
    gross_profit_cents: grossProfit,
    gross_margin: netSales > 0 ? grossProfit / netSales : 0,
    sales_qty: salesAgg.qty,
    order_count: salesAgg.c,
    cs_income_cents: csIncome,
    other_income_cents: otherIncome,
    expense_cents: expenseCents,
    other_expense_cents: otherExpense,
    net_profit_cents: netProfit,
    net_margin: totalRevenue > 0 ? netProfit / totalRevenue : 0,
    stock_qty: stockAgg.qty,
    stock_cost_cents: stockAgg.cost,
    products: productProfits(db, range),
    channels: channelProfits(db, range),
    today: {
      sales_cents: todaySales.sales,
      refund_cents: todayRefund.refund,
      net_sales_cents: todayNetSales,
      cost_cents: todaySales.cost,
      gross_profit_cents: todayGross,
      expense_cents: todayExpense.amount,
      net_profit_cents: todayGross - todayExpense.amount,
      order_count: todaySales.c,
    },
  }
}

// === 实时盈亏测算器 ===

/** 单笔测算输入。 */
export interface ProfitCalcInput {
  product_id: number
  variant_id?: number | null
  qty: number
  /** 售价（分/件）；缺省用规格标准售价。 */
  unit_price_cents?: number | null
  /** 可选：经营支出分摊（分）。 */
  extra_expense_cents?: number | null
}

/** 单笔测算结果。 */
export interface ProfitCalcResult {
  variant_id: number
  variant_name: string
  qty: number
  unit_price_cents: number
  cost_per_unit_cents: number // 当前规格平均成本
  amount_cents: number // 成交金额
  total_cost_cents: number // 总成本
  gross_profit_cents: number // 毛利
  gross_margin: number // 毛利率
  net_profit_cents: number // 净利润（扣分摊支出）
  net_margin: number // 净利率
  break_even_price_cents: number // 保本单价（= 平均成本）
  suggested_price_cents: number // 建议售价（按 30% 目标毛利率）
}

/** 实时盈亏测算：给定商品/规格/数量/售价，返回成本、毛利、毛利率、保本价、建议售价。 */
export function calculateProfit(db: Database, input: ProfitCalcInput): ProfitCalcResult {
  const p = getProduct(db, input.product_id)
  if (!p) throw new Error(`商品 #${input.product_id} 不存在`)
  const v = resolveVariant(db, input.product_id, input.variant_id)
  const qty = input.qty > 0 ? input.qty : 1
  const unitPrice = input.unit_price_cents ?? v.standard_price_cents
  const amount = Math.round(qty * unitPrice)
  const totalCost = Math.round(qty * v.avg_cost_cents)
  const grossProfit = amount - totalCost
  const extra = input.extra_expense_cents ?? 0
  const netProfit = grossProfit - extra
  // 建议售价：目标毛利率 30% → 售价 = 成本 / (1 - 0.3)
  const suggested = Math.round(v.avg_cost_cents / 0.7)
  return {
    variant_id: v.id,
    variant_name: v.spec_name,
    qty,
    unit_price_cents: unitPrice,
    cost_per_unit_cents: v.avg_cost_cents,
    amount_cents: amount,
    total_cost_cents: totalCost,
    gross_profit_cents: grossProfit,
    gross_margin: amount > 0 ? grossProfit / amount : 0,
    net_profit_cents: netProfit,
    net_margin: amount > 0 ? netProfit / amount : 0,
    break_even_price_cents: v.avg_cost_cents,
    suggested_price_cents: suggested,
  }
}

// === 月度经营报表（第六阶段） ===
// 口径与 getBusinessOverview 完全一致，只是限定在某个自然月内（occurred_at 前 7 位 = 'YYYY-MM'）。

/** 某月的日报（按天聚合，缺数据的日期补 0）。 */
export interface DailyPoint {
  date: string // 'YYYY-MM-DD'
  sales_cents: number
  refund_cents: number
  net_sales_cents: number
  cost_cents: number
  gross_profit_cents: number
  order_count: number
}

/** 商品排行项。 */
export interface ProductRank {
  product_id: number
  product_name: string
  brand: string
  net_sales_cents: number
  gross_profit_cents: number
  sales_qty: number
  order_count: number
}

/** 占比项（渠道/支出分类通用）。 */
export interface ShareItem {
  label: string
  amount_cents: number
  ratio: number // 0-1
  count: number
}

/** 月度经营报表。 */
export interface MonthlyReport {
  month: string // 'YYYY-MM'
  /** 汇总（与 overview 同口径，只是限月） */
  sales_cents: number
  refund_cents: number
  net_sales_cents: number
  cost_cents: number
  gross_profit_cents: number
  gross_margin: number
  order_count: number
  sales_qty: number
  cs_income_cents: number
  other_income_cents: number
  expense_cents: number
  other_expense_cents: number
  net_profit_cents: number
  net_margin: number
  /** 日趋势（当月每一天，缺数据补 0） */
  daily: DailyPoint[]
  /** 商品排行（按净销售额降序） */
  product_rank: ProductRank[]
  /** 收入渠道占比 */
  income_channels: ShareItem[]
  /** 支出分类占比 */
  expense_categories: ShareItem[]
}

/** 近 N 个月的趋势点。 */
export interface TrendPoint {
  month: string
  net_sales_cents: number
  gross_profit_cents: number
  net_profit_cents: number
  order_count: number
}

/** 'YYYY-MM' 校验。 */
function assertMonth(month: string): string {
  const m = /^(\d{4})-(\d{2})$/.exec(month)
  if (!m) throw new Error(`月份格式应为 YYYY-MM，收到：${month}`)
  return month
}

/** 该月天数（用于日趋势补 0）。 */
function daysInMonth(month: string): number {
  const [y, mo] = month.split('-').map(Number)
  return new Date(y, mo, 0).getDate()
}

/** 有经营数据的月份列表（降序，最多 limit 个）。 */
export function listBusinessMonths(db: Database, limit = 24): string[] {
  const rows = db.prepare(`
    SELECT m FROM (
      SELECT DISTINCT substr(occurred_at,1,7) AS m FROM sales_orders
      UNION SELECT DISTINCT substr(occurred_at,1,7) FROM refunds
      UNION SELECT DISTINCT substr(occurred_at,1,7) FROM purchase_records
      UNION SELECT DISTINCT substr(occurred_at,1,7) FROM expense_records
      UNION SELECT DISTINCT substr(occurred_at,1,7) FROM customer_service_income
      UNION SELECT DISTINCT substr(occurred_at,1,7) FROM other_income_expense
    ) WHERE m IS NOT NULL AND m <> ''
    ORDER BY m DESC LIMIT ?
  `).all(limit) as unknown as { m: string }[]
  return rows.map((r) => r.m)
}

/** 月度经营报表：汇总 + 日趋势 + 商品排行 + 渠道/支出占比。 */
export function getMonthlyReport(db: Database, month: string): MonthlyReport {
  const mm = assertMonth(month)

  // 汇总（限月）
  const salesAgg = db.prepare(
    `SELECT COALESCE(SUM(amount_cents),0) AS sales, COALESCE(SUM(total_cost_cents),0) AS cost,
      COALESCE(SUM(qty),0) AS qty, COUNT(*) AS c FROM sales_orders WHERE substr(occurred_at,1,7)=?`,
  ).get(mm) as { sales: number; cost: number; qty: number; c: number }
  const refundAgg = db.prepare(
    'SELECT COALESCE(SUM(refund_cents),0) AS refund FROM refunds WHERE substr(occurred_at,1,7)=?',
  ).get(mm) as { refund: number }
  const csAgg = db.prepare(
    'SELECT COALESCE(SUM(amount_cents),0) AS amount FROM customer_service_income WHERE substr(occurred_at,1,7)=?',
  ).get(mm) as { amount: number }
  const otherInc = db.prepare(
    "SELECT COALESCE(SUM(amount_cents),0) AS amount FROM other_income_expense WHERE kind='income' AND substr(occurred_at,1,7)=?",
  ).get(mm) as { amount: number }
  const otherExp = db.prepare(
    "SELECT COALESCE(SUM(amount_cents),0) AS amount FROM other_income_expense WHERE kind='expense' AND substr(occurred_at,1,7)=?",
  ).get(mm) as { amount: number }
  const expAgg = db.prepare(
    'SELECT COALESCE(SUM(amount_cents),0) AS amount FROM expense_records WHERE substr(occurred_at,1,7)=?',
  ).get(mm) as { amount: number }

  const netSales = salesAgg.sales - refundAgg.refund
  const grossProfit = netSales - salesAgg.cost
  const netProfit = grossProfit + csAgg.amount + otherInc.amount - expAgg.amount - otherExp.amount
  const totalRevenue = netSales + csAgg.amount + otherInc.amount

  // 日趋势：按天聚合，缺数据补 0
  const dayRows = db.prepare(`
    SELECT substr(occurred_at,1,10) AS d,
      COALESCE(SUM(amount_cents),0) AS sales,
      COALESCE(SUM(total_cost_cents),0) AS cost,
      COUNT(*) AS c
    FROM sales_orders WHERE substr(occurred_at,1,7)=? GROUP BY d
  `).all(mm) as unknown as { d: string; sales: number; cost: number; c: number }[]
  const dayRefund = db.prepare(`
    SELECT substr(occurred_at,1,10) AS d, COALESCE(SUM(refund_cents),0) AS refund
    FROM refunds WHERE substr(occurred_at,1,7)=? GROUP BY d
  `).all(mm) as unknown as { d: string; refund: number }[]
  const refundByDay = new Map(dayRefund.map((r) => [r.d, r.refund]))
  const salesByDay = new Map(dayRows.map((r) => [r.d, r]))
  const ndays = daysInMonth(mm)
  const daily: DailyPoint[] = []
  for (let i = 1; i <= ndays; i++) {
    const date = `${mm}-${String(i).padStart(2, '0')}`
    const s = salesByDay.get(date)
    const rf = refundByDay.get(date) ?? 0
    const netS = (s?.sales ?? 0) - rf
    daily.push({
      date,
      sales_cents: s?.sales ?? 0,
      refund_cents: rf,
      net_sales_cents: netS,
      cost_cents: s?.cost ?? 0,
      gross_profit_cents: netS - (s?.cost ?? 0),
      order_count: s?.c ?? 0,
    })
  }

  // 商品排行（限月）
  const rankRows = db.prepare(`
    SELECT p.id AS product_id, p.name AS product_name, p.brand AS brand,
      COALESCE(SUM(so.amount_cents),0) AS sales,
      COALESCE(SUM(so.total_cost_cents),0) AS cost,
      COALESCE(SUM(so.qty),0) AS qty,
      COUNT(so.id) AS c
    FROM sales_orders so JOIN products p ON p.id = so.product_id
    WHERE substr(so.occurred_at,1,7)=?
    GROUP BY p.id ORDER BY sales DESC
  `).all(mm) as unknown as { product_id: number; product_name: string; brand: string; sales: number; cost: number; qty: number; c: number }[]
  const rankRefund = db.prepare(`
    SELECT product_id, COALESCE(SUM(refund_cents),0) AS refund
    FROM refunds WHERE substr(occurred_at,1,7)=? GROUP BY product_id
  `).all(mm) as unknown as { product_id: number; refund: number }[]
  const rankRefundMap = new Map(rankRefund.map((r) => [r.product_id, r.refund]))
  const productRank: ProductRank[] = rankRows.map((r) => {
    const rf = rankRefundMap.get(r.product_id) ?? 0
    const net = r.sales - rf
    return {
      product_id: r.product_id, product_name: r.product_name, brand: r.brand,
      net_sales_cents: net, gross_profit_cents: net - r.cost,
      sales_qty: r.qty, order_count: r.c,
    }
  })

  // 收入渠道占比（销售 + 客服 + 其他收入）
  const incomeParts: { label: string; amount: number; count: number }[] = []
  const saleCh = db.prepare(
    'SELECT channel AS label, COALESCE(SUM(amount_cents),0) AS amount, COUNT(*) AS c FROM sales_orders WHERE substr(occurred_at,1,7)=? GROUP BY channel',
  ).all(mm) as unknown as { label: string; amount: number; c: number }[]
  saleCh.forEach((r) => incomeParts.push({ label: r.label, amount: r.amount, count: r.c }))
  const csCh = db.prepare(
    'SELECT channel AS label, COALESCE(SUM(amount_cents),0) AS amount, COUNT(*) AS c FROM customer_service_income WHERE substr(occurred_at,1,7)=? GROUP BY channel',
  ).all(mm) as unknown as { label: string; amount: number; c: number }[]
  csCh.forEach((r) => incomeParts.push({ label: `${r.label}（客服）`, amount: r.amount, count: r.c }))
  const othIncCh = db.prepare(
    "SELECT channel AS label, COALESCE(SUM(amount_cents),0) AS amount, COUNT(*) AS c FROM other_income_expense WHERE kind='income' AND substr(occurred_at,1,7)=? GROUP BY channel",
  ).all(mm) as unknown as { label: string; amount: number; c: number }[]
  othIncCh.forEach((r) => incomeParts.push({ label: `${r.label}（其他）`, amount: r.amount, count: r.c }))

  const incomeTotal = incomeParts.reduce((s, x) => s + x.amount, 0)
  const incomeChannels: ShareItem[] = incomeParts
    .filter((x) => x.amount > 0)
    .map((x) => ({ label: x.label, amount_cents: x.amount, ratio: incomeTotal > 0 ? x.amount / incomeTotal : 0, count: x.count }))
    .sort((a, b) => b.amount_cents - a.amount_cents)

  // 支出分类占比（经营支出按 category，其他支出单列）
  const expenseParts: { label: string; amount: number; count: number }[] = []
  const expCat = db.prepare(
    'SELECT category AS label, COALESCE(SUM(amount_cents),0) AS amount, COUNT(*) AS c FROM expense_records WHERE substr(occurred_at,1,7)=? GROUP BY category',
  ).all(mm) as unknown as { label: string; amount: number; c: number }[]
  expCat.forEach((r) => expenseParts.push({ label: r.label, amount: r.amount, count: r.c }))
  const othExp = db.prepare(
    "SELECT COALESCE(SUM(amount_cents),0) AS amount, COUNT(*) AS c FROM other_income_expense WHERE kind='expense' AND substr(occurred_at,1,7)=?",
  ).get(mm) as { amount: number; c: number }
  if (othExp.c > 0) expenseParts.push({ label: '其他支出', amount: othExp.amount, count: othExp.c })

  const expenseTotal = expenseParts.reduce((s, x) => s + x.amount, 0)
  const expenseCategories: ShareItem[] = expenseParts
    .filter((x) => x.amount > 0)
    .map((x) => ({ label: x.label, amount_cents: x.amount, ratio: expenseTotal > 0 ? x.amount / expenseTotal : 0, count: x.count }))
    .sort((a, b) => b.amount_cents - a.amount_cents)

  return {
    month: mm,
    sales_cents: salesAgg.sales,
    refund_cents: refundAgg.refund,
    net_sales_cents: netSales,
    cost_cents: salesAgg.cost,
    gross_profit_cents: grossProfit,
    gross_margin: netSales > 0 ? grossProfit / netSales : 0,
    order_count: salesAgg.c,
    sales_qty: salesAgg.qty,
    cs_income_cents: csAgg.amount,
    other_income_cents: otherInc.amount,
    expense_cents: expAgg.amount,
    other_expense_cents: otherExp.amount,
    net_profit_cents: netProfit,
    net_margin: totalRevenue > 0 ? netProfit / totalRevenue : 0,
    daily,
    product_rank: productRank,
    income_channels: incomeChannels,
    expense_categories: expenseCategories,
  }
}

/** 近 N 个月趋势（含空月补 0，月份顺序从旧到新）。 */
export function getTrend(db: Database, months = 6, endMonth?: string): TrendPoint[] {
  const end = endMonth ?? new Date().toISOString().slice(0, 7)
  const [ey, em] = end.split('-').map(Number)
  const list: string[] = []
  for (let i = months - 1; i >= 0; i--) {
    const d = new Date(ey, em - 1 - i, 1)
    list.push(`${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`)
  }
  return list.map((m) => {
    const salesAgg = db.prepare(
      `SELECT COALESCE(SUM(amount_cents),0) AS sales, COALESCE(SUM(total_cost_cents),0) AS cost, COUNT(*) AS c
       FROM sales_orders WHERE substr(occurred_at,1,7)=?`,
    ).get(m) as { sales: number; cost: number; c: number }
    const refundAgg = db.prepare(
      'SELECT COALESCE(SUM(refund_cents),0) AS refund FROM refunds WHERE substr(occurred_at,1,7)=?',
    ).get(m) as { refund: number }
    const csAgg = db.prepare(
      'SELECT COALESCE(SUM(amount_cents),0) AS amount FROM customer_service_income WHERE substr(occurred_at,1,7)=?',
    ).get(m) as { amount: number }
    const othInc = db.prepare(
      "SELECT COALESCE(SUM(amount_cents),0) AS amount FROM other_income_expense WHERE kind='income' AND substr(occurred_at,1,7)=?",
    ).get(m) as { amount: number }
    const othExp = db.prepare(
      "SELECT COALESCE(SUM(amount_cents),0) AS amount FROM other_income_expense WHERE kind='expense' AND substr(occurred_at,1,7)=?",
    ).get(m) as { amount: number }
    const expAgg = db.prepare(
      'SELECT COALESCE(SUM(amount_cents),0) AS amount FROM expense_records WHERE substr(occurred_at,1,7)=?',
    ).get(m) as { amount: number }
    const netSales = salesAgg.sales - refundAgg.refund
    const gross = netSales - salesAgg.cost
    return {
      month: m,
      net_sales_cents: netSales,
      gross_profit_cents: gross,
      net_profit_cents: gross + csAgg.amount + othInc.amount - expAgg.amount - othExp.amount,
      order_count: salesAgg.c,
    }
  })
}