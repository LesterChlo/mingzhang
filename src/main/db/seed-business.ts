// 预置 6 固定商品（第三/四阶段）。幂等：INSERT OR IGNORE。
// 商品列表固定，locked=1 防止后期随意新增造成分类混乱。
//
// 重要：**不再预置任何规格**。用户明确要求「规格、进价、售价全部由自己添加」，
// 所以新品种只建商品骨架，规格清空。历史库里的旧预置规格由 v6 迁移一次性清理
// （只删「从未有过进货/销售/退款」的空规格，有历史记录的一律保留，保全账目）。

import type { Database } from 'better-sqlite3-multiple-ciphers'
import { nowIso } from './time'

/** 固定 6 个商品：[品牌, 名称]。规格一律留空，由用户自己添加。 */
const PRODUCTS: [string, string][] = [
  ['MUFY', '猫粮'],
  ['MUFY', '月卡'],
  ['Rubii', '账号'],
  ['Rubii', '300宝石'],
  ['Rubii', '月卡'],
  ['LM', '100币'],
]

export function seedBusiness(db: Database): { products: number; variants: number } {
  const ts = nowIso()
  const insProduct = db.prepare(
    'INSERT OR IGNORE INTO products' +
      ' (name, brand, standard_price_cents, avg_cost_cents, stock_qty, stock_cost_cents,' +
      '  cumulative_purchase_qty, cumulative_purchase_cents, cumulative_sales_qty,' +
      '  cumulative_sales_cents, cumulative_sales_cost_cents, cumulative_refund_qty,' +
      '  cumulative_refund_cents, sales_order_count, locked, created_at, updated_at)' +
      ' VALUES (?, ?, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1, ?, ?)',
  )

  let addedProducts = 0
  for (const [brand, name] of PRODUCTS) {
    addedProducts += insProduct.run(name, brand, ts, ts).changes
  }
  // 规格不再预置：variants 恒为 0，保留字段兼容既有调用方。
  return { products: addedProducts, variants: 0 }
}
