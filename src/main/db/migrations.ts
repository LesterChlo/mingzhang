// 增量迁移（spec 裁定：新结构采用保留旧数据的升级方式，不允许"备份后重建空库"）。
// 用 PRAGMA user_version 记版本；每步迁移幂等。

import type { Database } from 'better-sqlite3-multiple-ciphers'

export function runMigrations(db: Database): void {
  const version = db.pragma('user_version', { simple: true }) as number
  if (version < 1) {
    // v1：批次账务委托——交易增加可靠交易标识列（跨批去重 + 来源关联）
    // 容错：transactions 表不存在时（残留/损坏库）跳过 ALTER，但不能用 sqlite_master 精确匹配表名
    // ——合法库允许标识符带引号/方括号（如 [transactions]），PRAGMA table_info 能按名找到，
    // sqlite_master 的字面名字却是 '[transactions]'。所以以 PRAGMA 是否返回列为准。
    let cols: { name: string }[] = []
    try {
      cols = db.prepare("PRAGMA table_info('transactions')").all() as unknown as { name: string }[]
    } catch {
      cols = []
    }
    if (cols.length > 0) {
      if (!cols.some((c) => c.name === 'dedup_key')) {
        db.exec('ALTER TABLE transactions ADD COLUMN dedup_key TEXT NULL')
      }
      db.exec(
        'CREATE INDEX IF NOT EXISTS idx_txn_dedup ON transactions(dedup_key) WHERE dedup_key IS NOT NULL',
      )
    }
    db.pragma('user_version = 1')
  }
  if (version < 2) {
    // v2：账单材料入库（staging）——原表逐行留在本机，模型只交"读表方案"，
    // 金额/日期由代码从原表取（数字不再经模型的手）。disposition 记每行归宿，保证一行不重复处理。
    db.exec(
      'CREATE TABLE IF NOT EXISTS bill_tables (' +
        ' id INTEGER PRIMARY KEY AUTOINCREMENT,' +
        ' source_type TEXT NOT NULL CHECK (source_type IN (\'csv\',\'xlsx\')),' +
        ' file_name TEXT NULL,' +
        ' channel TEXT NULL,' +
        ' header TEXT NOT NULL,' + // JSON string[]
        ' row_count INTEGER NOT NULL,' +
        ' created_at TEXT NOT NULL,' +
        ' updated_at TEXT NOT NULL)',
    )
    db.exec(
      'CREATE TABLE IF NOT EXISTS bill_rows (' +
        ' table_id INTEGER NOT NULL REFERENCES bill_tables(id) ON DELETE CASCADE,' +
        ' row_no INTEGER NOT NULL,' + // 1 起，对用户可说"第 N 行"
        ' cells TEXT NOT NULL,' + // JSON string[]
        ' disposition TEXT NOT NULL DEFAULT \'open\' CHECK (disposition IN (\'open\',\'planned\',\'skipped\',\'review\')),' +
        ' gate_id INTEGER NULL,' +
        ' reason TEXT NULL,' +
        ' PRIMARY KEY (table_id, row_no))',
    )
    db.exec('CREATE INDEX IF NOT EXISTS idx_bill_rows_open ON bill_rows(table_id, disposition)')
    db.pragma('user_version = 2')
  }
  if (version < 3) {
    // v3：商品经营管理模块（第三阶段）
    // 6 固定商品 + 销售/进货/退款/客服收入/其他收支/经营支出 + 快捷模板
    // 金额一律整数分；销售订单保存成本快照（成交时平均成本），进货更新加权平均成本。
    db.exec(`
CREATE TABLE IF NOT EXISTS products (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  brand TEXT NOT NULL,
  standard_price_cents INTEGER NOT NULL DEFAULT 0,
  avg_cost_cents INTEGER NOT NULL DEFAULT 0,
  stock_qty REAL NOT NULL DEFAULT 0,
  stock_cost_cents INTEGER NOT NULL DEFAULT 0,
  cumulative_purchase_qty REAL NOT NULL DEFAULT 0,
  cumulative_purchase_cents INTEGER NOT NULL DEFAULT 0,
  cumulative_sales_qty REAL NOT NULL DEFAULT 0,
  cumulative_sales_cents INTEGER NOT NULL DEFAULT 0,
  cumulative_sales_cost_cents INTEGER NOT NULL DEFAULT 0,
  cumulative_refund_qty REAL NOT NULL DEFAULT 0,
  cumulative_refund_cents INTEGER NOT NULL DEFAULT 0,
  sales_order_count INTEGER NOT NULL DEFAULT 0,
  locked INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(brand, name)
);
CREATE INDEX IF NOT EXISTS idx_products_brand_name ON products(brand, name);

CREATE TABLE IF NOT EXISTS sales_orders (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  order_no TEXT,
  product_id INTEGER NOT NULL REFERENCES products(id) ON DELETE RESTRICT,
  occurred_at TEXT NOT NULL,
  qty REAL NOT NULL CHECK(qty > 0),
  unit_price_cents INTEGER NOT NULL CHECK(unit_price_cents >= 0),
  amount_cents INTEGER NOT NULL CHECK(amount_cents >= 0),
  cost_per_unit_cents INTEGER NOT NULL DEFAULT 0,
  total_cost_cents INTEGER NOT NULL DEFAULT 0,
  gross_profit_cents INTEGER NOT NULL DEFAULT 0,
  channel TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'confirmed' CHECK(status IN ('confirmed','refunded','partial_refunded')),
  refunded_cents INTEGER NOT NULL DEFAULT 0,
  refunded_qty REAL NOT NULL DEFAULT 0,
  note TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_sales_product ON sales_orders(product_id);
CREATE INDEX IF NOT EXISTS idx_sales_occurred ON sales_orders(occurred_at);
CREATE INDEX IF NOT EXISTS idx_sales_channel ON sales_orders(channel);

CREATE TABLE IF NOT EXISTS purchase_records (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  product_id INTEGER NOT NULL REFERENCES products(id) ON DELETE RESTRICT,
  occurred_at TEXT NOT NULL,
  qty REAL NOT NULL CHECK(qty > 0),
  total_cents INTEGER NOT NULL CHECK(total_cents >= 0),
  unit_cost_cents INTEGER NOT NULL DEFAULT 0,
  channel TEXT NOT NULL,
  prev_avg_cost_cents INTEGER NOT NULL DEFAULT 0,
  prev_stock_qty REAL NOT NULL DEFAULT 0,
  new_avg_cost_cents INTEGER NOT NULL DEFAULT 0,
  note TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_purchase_product ON purchase_records(product_id);
CREATE INDEX IF NOT EXISTS idx_purchase_occurred ON purchase_records(occurred_at);

CREATE TABLE IF NOT EXISTS refunds (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  refund_no TEXT,
  sales_order_id INTEGER NULL REFERENCES sales_orders(id) ON DELETE RESTRICT,
  product_id INTEGER NOT NULL REFERENCES products(id) ON DELETE RESTRICT,
  occurred_at TEXT NOT NULL,
  refund_cents INTEGER NOT NULL CHECK(refund_cents > 0),
  refund_qty REAL NOT NULL DEFAULT 0,
  channel TEXT NOT NULL,
  original_channel TEXT,
  reason TEXT,
  linked INTEGER NOT NULL DEFAULT 0 CHECK(linked IN (0,1)),
  restore_stock INTEGER NOT NULL DEFAULT 0,
  note TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_refund_order ON refunds(sales_order_id);
CREATE INDEX IF NOT EXISTS idx_refund_product ON refunds(product_id);
CREATE INDEX IF NOT EXISTS idx_refund_occurred ON refunds(occurred_at);

CREATE TABLE IF NOT EXISTS customer_service_income (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  occurred_at TEXT NOT NULL,
  amount_cents INTEGER NOT NULL CHECK(amount_cents > 0),
  channel TEXT NOT NULL,
  description TEXT,
  note TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_csi_occurred ON customer_service_income(occurred_at);

CREATE TABLE IF NOT EXISTS other_income_expense (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  kind TEXT NOT NULL CHECK(kind IN ('income','expense')),
  occurred_at TEXT NOT NULL,
  amount_cents INTEGER NOT NULL CHECK(amount_cents > 0),
  channel TEXT NOT NULL,
  item_name TEXT NOT NULL,
  note TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_oie_kind_occurred ON other_income_expense(kind, occurred_at);

CREATE TABLE IF NOT EXISTS expense_records (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  occurred_at TEXT NOT NULL,
  amount_cents INTEGER NOT NULL CHECK(amount_cents > 0),
  channel TEXT NOT NULL,
  category TEXT NOT NULL CHECK(category IN ('商品采购','平台费用','运营费用','人工费用','其他费用')),
  product_id INTEGER NULL REFERENCES products(id) ON DELETE RESTRICT,
  purchase_id INTEGER NULL REFERENCES purchase_records(id) ON DELETE RESTRICT,
  purpose TEXT,
  note TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_expense_occurred ON expense_records(occurred_at);
CREATE INDEX IF NOT EXISTS idx_expense_category ON expense_records(category);

CREATE TABLE IF NOT EXISTS quick_templates (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  kind TEXT NOT NULL CHECK(kind IN ('sale','purchase','expense','refund','cs_income','other')),
  product_id INTEGER NULL REFERENCES products(id) ON DELETE RESTRICT,
  channel TEXT,
  default_qty REAL,
  default_price_cents INTEGER,
  note TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
`)
    db.pragma('user_version = 3')
  }
  if (version < 4) {
    // v4：商品多规格体系。
    // 一个商品（如 MUFY 猫粮）可挂多个规格（1kg 装 / 2kg 装 / 5kg 装…），每个规格独立核算：
    // 独立售价、独立加权平均成本、独立库存、独立累计销售/退款。
    // 商品层保留汇总字段（= 各规格之和），用于列表快速展示；历史订单快照规格名，改名不改历史。
    // 容错：仅当 products 表存在（= 确实是本应用的业务库）时才建规格表；
    // 否则（如残留 junk 库）跳过，让上层契约校验给出明确的拒启原因。
    const hasProducts = (() => {
      try {
        return (db.prepare("PRAGMA table_info('products')").all() as unknown as unknown[]).length > 0
      } catch {
        return false
      }
    })()
    if (hasProducts) {
      db.exec(`
CREATE TABLE IF NOT EXISTS product_variants (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  product_id INTEGER NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  spec_name TEXT NOT NULL,
  standard_price_cents INTEGER NOT NULL DEFAULT 0,
  avg_cost_cents INTEGER NOT NULL DEFAULT 0,
  stock_qty REAL NOT NULL DEFAULT 0,
  stock_cost_cents INTEGER NOT NULL DEFAULT 0,
  cumulative_purchase_qty REAL NOT NULL DEFAULT 0,
  cumulative_purchase_cents INTEGER NOT NULL DEFAULT 0,
  cumulative_sales_qty REAL NOT NULL DEFAULT 0,
  cumulative_sales_cents INTEGER NOT NULL DEFAULT 0,
  cumulative_sales_cost_cents INTEGER NOT NULL DEFAULT 0,
  cumulative_refund_qty REAL NOT NULL DEFAULT 0,
  cumulative_refund_cents INTEGER NOT NULL DEFAULT 0,
  sales_order_count INTEGER NOT NULL DEFAULT 0,
  sort_order INTEGER NOT NULL DEFAULT 0,
  locked INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(product_id, spec_name)
);
CREATE INDEX IF NOT EXISTS idx_variants_product ON product_variants(product_id, sort_order);
`)
    }
    // 注意：迁移对「表不存在」必须容错——已存在的库可能是任意残留结构（如只有 junk 表），
    // 此时不能在 ALTER/CREATE INDEX 上抛 SQLite 原始错误，否则会顶掉上层契约校验给出的
    // 明确拒启原因（round2-red B1b 依赖这一点）。表不存在时跳过，交给 validateLedgerDatabase 判定。
    // 判存在用 PRAGMA 而非 sqlite_master 精确匹配：合法库允许 [transactions] / "transactions" 写法。
    const tableExists = (table: string): boolean => {
      try {
        const cols = db.prepare(`PRAGMA table_info('${table}')`).all() as unknown as { name: string }[]
        return cols.length > 0
      } catch {
        return false
      }
    }
    const addColumn = (table: string, column: string, declaration: string): void => {
      if (!tableExists(table)) return
      const cols = db.prepare(`PRAGMA table_info('${table}')`).all() as unknown as { name: string }[]
      if (!cols.some((c) => c.name === column)) {
        db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${declaration}`)
      }
    }
    addColumn('sales_orders', 'variant_id', 'INTEGER NULL')
    addColumn('sales_orders', 'variant_name', 'TEXT NULL')
    addColumn('purchase_records', 'variant_id', 'INTEGER NULL')
    addColumn('purchase_records', 'variant_name', 'TEXT NULL')
    addColumn('refunds', 'variant_id', 'INTEGER NULL')
    addColumn('refunds', 'variant_name', 'TEXT NULL')
    // 索引同理：目标表缺失时不建（否则 CREATE INDEX 会抛 no such table）
    const createIndexIfTable = (table: string, indexSql: string): void => {
      if (tableExists(table)) db.exec(indexSql)
    }
    createIndexIfTable('sales_orders', 'CREATE INDEX IF NOT EXISTS idx_sales_variant ON sales_orders(variant_id)')
    createIndexIfTable('purchase_records', 'CREATE INDEX IF NOT EXISTS idx_purchase_variant ON purchase_records(variant_id)')
    createIndexIfTable('refunds', 'CREATE INDEX IF NOT EXISTS idx_refund_variant ON refunds(variant_id)')
    db.pragma('user_version = 4')
  }
  if (version < 5) {
    // v5：快捷记账模板增强。
    // v3 已建 quick_templates（name/kind/product_id/channel/default_qty/default_price_cents/note），
    // 但缺「规格」与「使用次数」。补两列：variant_id 让模板能精确还原到规格，
    // use_count 让常用模板自动排前面（每次套用 +1）。
    // 容错：仅当 products 表存在（= 确实是本应用业务库）才补齐 quick_templates；
    // 残留库（如只有 junk 表）不得被补出业务表，交给上层契约校验拒启。
    // 判存在用 PRAGMA（兼容 [products] / "products" 等合法标识符写法）。
    const tplTableExists = (table: string): boolean => {
      try {
        return (db.prepare(`PRAGMA table_info('${table}')`).all() as unknown as unknown[]).length > 0
      } catch {
        return false
      }
    }
    if (tplTableExists('products')) {
      if (!tplTableExists('quick_templates')) {
        db.exec(`CREATE TABLE IF NOT EXISTS quick_templates (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          name TEXT NOT NULL,
          kind TEXT NOT NULL CHECK(kind IN ('sale','purchase','expense','refund','cs_income','other')),
          product_id INTEGER NULL,
          channel TEXT,
          default_qty REAL,
          default_price_cents INTEGER,
          note TEXT,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL)`)
      }
    }
    if (tplTableExists('quick_templates')) {
      const cols = db.prepare("PRAGMA table_info('quick_templates')").all() as unknown as { name: string }[]
      const has = (name: string): boolean => cols.some((c) => c.name === name)
      if (!has('variant_id')) db.exec('ALTER TABLE quick_templates ADD COLUMN variant_id INTEGER NULL')
      if (!has('use_count')) db.exec('ALTER TABLE quick_templates ADD COLUMN use_count INTEGER NOT NULL DEFAULT 0')
    }
    db.pragma('user_version = 5')
  }
  if (version < 6) {
    // v6：清理早期版本硬编码的「预置规格」。
    // 背景：三/四阶段曾给 6 个固定商品各预置 4-5 个规格（1kg 装 / 2kg 装…），
    // 但用户要求规格、进价、售价全部由自己添加，预置规格是噪音。
    // 策略（保证不伤账）：
    //   * 只删「从未有过任何进货 / 销售 / 退款、且库存与累计数据均为 0」的空规格；
    //   * 任何有历史记录或数据残留的规格一律保留——宁可留噪音也不动账目；
    //   * 用户自己新建的规格若同样是空的，也会一并清掉（它们同样没有数据，可随时重建）；
    //   * 删除后按剩余规格重算商品层汇总，保证商品卡片数字与规格一致；
    //    某商品删空后，商品层汇总归零（不会残留旧数字）。
    // 幂等：反复执行结果一致（第二次已无符合条件的行）。
    const bizExists = (table: string): boolean => {
      try {
        return (db.prepare(`PRAGMA table_info('${table}')`).all() as unknown as unknown[]).length > 0
      } catch {
        return false
      }
    }
    if (bizExists('product_variants') && bizExists('products')) {
      // 找出所有"纯粹空壳"的规格
      const empties = db.prepare(`
        SELECT v.id, v.product_id FROM product_variants v
        WHERE COALESCE(v.sales_order_count, 0) = 0
          AND COALESCE(v.stock_qty, 0) = 0
          AND COALESCE(v.stock_cost_cents, 0) = 0
          AND COALESCE(v.cumulative_purchase_qty, 0) = 0
          AND COALESCE(v.cumulative_purchase_cents, 0) = 0
          AND COALESCE(v.cumulative_sales_qty, 0) = 0
          AND COALESCE(v.cumulative_sales_cents, 0) = 0
          AND COALESCE(v.cumulative_sales_cost_cents, 0) = 0
          AND COALESCE(v.cumulative_refund_qty, 0) = 0
          AND COALESCE(v.cumulative_refund_cents, 0) = 0
          AND NOT EXISTS (SELECT 1 FROM sales_orders so WHERE so.variant_id = v.id)
          AND NOT EXISTS (SELECT 1 FROM purchase_records pr WHERE pr.variant_id = v.id)
          AND NOT EXISTS (SELECT 1 FROM refunds rf WHERE rf.variant_id = v.id)
      `).all() as unknown as { id: number; product_id: number }[]

      if (empties.length > 0) {
        const affectedProducts = new Set<number>()
        const delVariant = db.prepare('DELETE FROM product_variants WHERE id = ?')
        for (const row of empties) {
          // 模板引用该规格时先解绑，避免留下悬空 variant_id
          if (bizExists('quick_templates')) {
            db.prepare('UPDATE quick_templates SET variant_id = NULL WHERE variant_id = ?').run(row.id)
          }
          delVariant.run(row.id)
          affectedProducts.add(row.product_id)
        }

        // 按剩余规格重算受影响商品的汇总（删空则归零，不残留旧数字）
        const recompute = db.prepare(`
          UPDATE products SET
            stock_qty = COALESCE(s.stock_qty, 0),
            stock_cost_cents = COALESCE(s.stock_cost_cents, 0),
            avg_cost_cents = CASE WHEN COALESCE(s.stock_qty, 0) > 0
              THEN CAST(ROUND(COALESCE(s.stock_cost_cents, 0) * 1.0 / s.stock_qty) AS INTEGER) ELSE 0 END,
            standard_price_cents = COALESCE(s.standard_price_cents, 0),
            cumulative_purchase_qty = COALESCE(s.cumulative_purchase_qty, 0),
            cumulative_purchase_cents = COALESCE(s.cumulative_purchase_cents, 0),
            cumulative_sales_qty = COALESCE(s.cumulative_sales_qty, 0),
            cumulative_sales_cents = COALESCE(s.cumulative_sales_cents, 0),
            cumulative_sales_cost_cents = COALESCE(s.cumulative_sales_cost_cents, 0),
            cumulative_refund_qty = COALESCE(s.cumulative_refund_qty, 0),
            cumulative_refund_cents = COALESCE(s.cumulative_refund_cents, 0),
            sales_order_count = COALESCE(s.sales_order_count, 0),
            updated_at = ?
          FROM (SELECT
            COALESCE(SUM(stock_qty), 0) AS stock_qty,
            COALESCE(SUM(stock_cost_cents), 0) AS stock_cost_cents,
            COALESCE(SUM(cumulative_purchase_qty), 0) AS cumulative_purchase_qty,
            COALESCE(SUM(cumulative_purchase_cents), 0) AS cumulative_purchase_cents,
            COALESCE(SUM(cumulative_sales_qty), 0) AS cumulative_sales_qty,
            COALESCE(SUM(cumulative_sales_cents), 0) AS cumulative_sales_cents,
            COALESCE(SUM(cumulative_sales_cost_cents), 0) AS cumulative_sales_cost_cents,
            COALESCE(SUM(cumulative_refund_qty), 0) AS cumulative_refund_qty,
            COALESCE(SUM(cumulative_refund_cents), 0) AS cumulative_refund_cents,
            COALESCE(SUM(sales_order_count), 0) AS sales_order_count,
            COALESCE(MAX(standard_price_cents), 0) AS standard_price_cents
            FROM product_variants WHERE product_id = ?) s
          WHERE id = ?
        `)
        const ts = new Date().toISOString()
        for (const pid of affectedProducts) {
          recompute.run(ts, pid, pid)
        }
      }
    }
    db.pragma('user_version = 6')
  }
}
