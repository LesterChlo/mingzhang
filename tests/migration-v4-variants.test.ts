// v3 → v4 增量迁移测试：已有 v3 库（无规格表、无 variant 列）升级后
// 规格表建好、订单表加列、历史订单数据完好、种子补齐规格。
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import DatabaseCtor from 'better-sqlite3-multiple-ciphers'
import type { Database } from 'better-sqlite3-multiple-ciphers'
import schemaSql from '../src/main/db/schema.sql?raw'
import { runMigrations } from '../src/main/db/migrations'
import { seedBusiness } from '../src/main/db/seed-business'
import { createVariant, listVariants, getVariant, listProductsWithVariants } from '../src/main/domain/business'

/** 造一个 v3 状态的库：只有 v3 的表，没有 product_variants / variant_id 列。 */
function makeV3Db(): Database {
  const db = new DatabaseCtor(':memory:')
  db.exec(schemaSql as string)
  db.exec(`
CREATE TABLE products (
  id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, brand TEXT NOT NULL,
  standard_price_cents INTEGER NOT NULL DEFAULT 0, avg_cost_cents INTEGER NOT NULL DEFAULT 0,
  stock_qty REAL NOT NULL DEFAULT 0, stock_cost_cents INTEGER NOT NULL DEFAULT 0,
  cumulative_purchase_qty REAL NOT NULL DEFAULT 0, cumulative_purchase_cents INTEGER NOT NULL DEFAULT 0,
  cumulative_sales_qty REAL NOT NULL DEFAULT 0, cumulative_sales_cents INTEGER NOT NULL DEFAULT 0,
  cumulative_sales_cost_cents INTEGER NOT NULL DEFAULT 0, cumulative_refund_qty REAL NOT NULL DEFAULT 0,
  cumulative_refund_cents INTEGER NOT NULL DEFAULT 0, sales_order_count INTEGER NOT NULL DEFAULT 0,
  locked INTEGER NOT NULL DEFAULT 1, created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
  UNIQUE(brand, name));
CREATE TABLE sales_orders (
  id INTEGER PRIMARY KEY AUTOINCREMENT, order_no TEXT, product_id INTEGER NOT NULL,
  occurred_at TEXT NOT NULL, qty REAL NOT NULL CHECK(qty > 0),
  unit_price_cents INTEGER NOT NULL, amount_cents INTEGER NOT NULL,
  cost_per_unit_cents INTEGER NOT NULL DEFAULT 0, total_cost_cents INTEGER NOT NULL DEFAULT 0,
  gross_profit_cents INTEGER NOT NULL DEFAULT 0, channel TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'confirmed', refunded_cents INTEGER NOT NULL DEFAULT 0,
  refunded_qty REAL NOT NULL DEFAULT 0, note TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
CREATE TABLE purchase_records (
  id INTEGER PRIMARY KEY AUTOINCREMENT, product_id INTEGER NOT NULL, occurred_at TEXT NOT NULL,
  qty REAL NOT NULL CHECK(qty > 0), total_cents INTEGER NOT NULL,
  unit_cost_cents INTEGER NOT NULL DEFAULT 0, channel TEXT NOT NULL,
  prev_avg_cost_cents INTEGER NOT NULL DEFAULT 0, prev_stock_qty REAL NOT NULL DEFAULT 0,
  new_avg_cost_cents INTEGER NOT NULL DEFAULT 0, note TEXT,
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
CREATE TABLE refunds (
  id INTEGER PRIMARY KEY AUTOINCREMENT, refund_no TEXT, sales_order_id INTEGER, product_id INTEGER NOT NULL,
  occurred_at TEXT NOT NULL, refund_cents INTEGER NOT NULL, refund_qty REAL NOT NULL DEFAULT 0,
  channel TEXT NOT NULL, original_channel TEXT, reason TEXT, linked INTEGER NOT NULL DEFAULT 0,
  restore_stock INTEGER NOT NULL DEFAULT 0, note TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
`)
  db.pragma('user_version = 3')
  // 预置 v3 商品 + 一笔 v3 历史订单
  const ts = '2026-11-20T00:00:00Z'
  db.prepare(
    'INSERT INTO products (name,brand,standard_price_cents,created_at,updated_at) VALUES (?,?,?,?,?)',
  ).run('猫粮', 'MUFY', 1000, ts, ts)
  db.prepare(
    'INSERT INTO sales_orders (product_id,occurred_at,qty,unit_price_cents,amount_cents,cost_per_unit_cents,total_cost_cents,gross_profit_cents,channel,created_at,updated_at)' +
      ' VALUES (1,?,1,1000,1000,500,500,500,?,?,?)',
  ).run('2026-11-20', '微信收入', ts, ts)
  return db
}

describe('v3 → v4 增量迁移', () => {
  let db: Database
  beforeEach(() => { db = makeV3Db() })
  afterEach(() => { db.close() })

  it('旧库升级后：规格表建好、订单加列、历史订单数据完好', () => {
    expect(db.pragma('user_version', { simple: true })).toBe(3)
    // v3 时没有规格表
    expect(
      db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='product_variants'").get(),
    ).toBeUndefined()

    runMigrations(db)
    expect(db.pragma('user_version', { simple: true })).toBe(6)

    // 规格表已建
    expect(
      db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='product_variants'").get(),
    ).toBeDefined()

    // 三张记录表都加了 variant_id / variant_name
    for (const t of ['sales_orders', 'purchase_records', 'refunds']) {
      const cols = db.prepare(`PRAGMA table_info('${t}')`).all() as unknown as { name: string }[]
      expect(cols.some((c) => c.name === 'variant_id'), `${t}.variant_id`).toBe(true)
      expect(cols.some((c) => c.name === 'variant_name'), `${t}.variant_name`).toBe(true)
    }

    // 历史订单数据完好（金额/成本快照不变，variant 列默认 NULL）
    const order = db.prepare('SELECT * FROM sales_orders WHERE id = 1').get() as Record<string, unknown>
    expect(order.amount_cents).toBe(1000)
    expect(order.cost_per_unit_cents).toBe(500)
    expect(order.variant_id).toBeNull()
    expect(order.variant_name).toBeNull()
  })

  it('升级后 seedBusiness 只补商品、不补规格（第十阶段起规格由用户自建）', () => {
    runMigrations(db)
    const r = seedBusiness(db)
    // 该合成库只有猫粮一个商品，其余 5 个商品会被补齐
    expect(r.products).toBeGreaterThan(0)
    // 规格不再预置
    expect(r.variants).toBe(0)

    const ps = listProductsWithVariants(db)
    const cat = ps.find((p) => p.name === '猫粮')!
    expect(cat.variants).toHaveLength(0)
    // 6 个商品齐全
    expect(ps).toHaveLength(6)
    // 用户自建规格后可正常记账
    const id = createVariant(db, { product_id: cat.id, spec_name: '自建装', standard_price_cents: 1000 })
    expect(listVariants(db, cat.id)).toHaveLength(1)
    expect(getVariant(db, id)!.spec_name).toBe('自建装')
  })

  it('迁移幂等：重复执行不报错、版本保持最新', () => {
    runMigrations(db)
    const v = db.pragma('user_version', { simple: true }) as number
    expect(() => runMigrations(db)).not.toThrow()
    expect(db.pragma('user_version', { simple: true })).toBe(v)
  })
})