-- ============================================================================
-- 明账 MingZhang · Phase 1 数据架构 DDL
-- 依据：明账数据架构规格「表 1 规则」——本文件是它的 DDL 逐条落地。
--
-- 硬规则（对应 brief 第二节「表 1 规则」，验收项 5 要求其在 DDL 或规格中可见）：
--   R1 金额整数分：amount_cents INTEGER，禁 float，禁 REAL 存金额。
--   R2 时间语义分离：occurred_at（交易发生时间，可回填）
--                  vs created_at / updated_at（入库时间，系统生成，不可编辑）。
--   R3 审计必写：任何账务写操作同步写 audit_log（before/after + changed_by + changed_at）。
--   R4 统计口径：仅 type IN ('expense','income') 且 state='confirmed' 计入收支统计；
--                转账、调整不计入（见文件末尾 v_reportable_transactions 视图）。
--   R5 单币种：MVP 只支持 CNY，currency 字段为预留位，用 CHECK 锁死防止"字段存在=已支持"。
-- ============================================================================

PRAGMA foreign_keys = ON;

-- ---------------------------------------------------------------------------
-- 1. accounts 账户
--    预置：现金 / 银行卡 / 支付宝 / 微信（计划书 §5.6）
--    🔶 待定：零钱 / 零钱通 的账户粒度（场景⑥），脚手架按单账户起步。
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS accounts (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    name       TEXT    NOT NULL UNIQUE,
    type       TEXT    NOT NULL CHECK (type IN ('cash', 'bank', 'alipay', 'wechat')),
    currency   TEXT    NOT NULL DEFAULT 'CNY' CHECK (currency = 'CNY'),  -- R5：MVP 单币种，字段仅预留
    created_at TEXT    NOT NULL,
    updated_at TEXT    NOT NULL
);

-- ---------------------------------------------------------------------------
-- 2. categories 分类
--    kind 区分支出 / 收入，两组各自独立（定案 #9）。
--    预置：支出 = 餐饮 / 购物 / 其他；收入 = 生活费 / 红包 / 其他；不预置二级（§5.6）。
--    parent_id 保留能力，MVP 不用。
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS categories (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    name       TEXT    NOT NULL,
    kind       TEXT    NOT NULL CHECK (kind IN ('expense', 'income')),
    parent_id  INTEGER NULL REFERENCES categories(id) ON DELETE RESTRICT,
    created_at TEXT    NOT NULL,
    updated_at TEXT    NOT NULL,
    UNIQUE (kind, name)   -- 支出与收入可各有一个"其他"；启用二级分类时需改此约束（见规格文档 Q8）
);

-- ---------------------------------------------------------------------------
-- 3. transactions 交易主表
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS transactions (
    id                INTEGER PRIMARY KEY AUTOINCREMENT,
    account_id        INTEGER NOT NULL REFERENCES accounts(id)   ON DELETE RESTRICT,
    category_id       INTEGER NULL     REFERENCES categories(id) ON DELETE RESTRICT,
    amount_cents      INTEGER NOT NULL,                       -- R1 整数分
    type              TEXT    NOT NULL CHECK (type IN ('expense', 'income', 'transfer', 'adjustment')),
    to_account_id     INTEGER NULL     REFERENCES accounts(id) ON DELETE RESTRICT,  -- 仅 type='transfer'
    occurred_at       TEXT    NOT NULL,                       -- R2 交易发生时间（用户可回填）
    state             TEXT    NOT NULL CHECK (state IN ('raw_input', 'parsed', 'needs_review', 'confirmed', 'deleted')),
    confidence_score  REAL    NULL,                           -- 解析置信度 0.0~1.0
    merchant          TEXT    NULL,
    note              TEXT    NULL,
    source_message_id TEXT    NULL,                           -- 产生该笔的对话消息/批次 id（指代消解、批次归属）
    created_at        TEXT    NOT NULL,                       -- R2 入库时间，系统生成
    updated_at        TEXT    NOT NULL,                       -- R2 入库时间，系统生成

    -- 金额恒正（§8.4 归一化）：支出/收入/转账必须为正；
    -- adjustment 允许正负：+ = 调增该账户余额，- = 调减（2026-09-14 终审裁定，见规格文档 §7-Q1）
    CHECK (CASE WHEN type IN ('expense', 'income', 'transfer') THEN amount_cents > 0
                ELSE amount_cents <> 0 END),

    -- 转账完整性（2026-09-15 终审放宽，配合 §5.5「支出 vs 转账」歧义态）：
    --   - 非转账：to_account_id 必须为 NULL；
    --   - 转账且未确认（raw_input/parsed/needs_review）：允许目标账户暂缺；
    --   - 转账且已确认（confirmed）：必须有目标账户，且不能转给自己。
    CHECK (   (type <> 'transfer' AND to_account_id IS NULL)
           OR (type =  'transfer' AND to_account_id IS NULL AND state <> 'confirmed')
           OR (type =  'transfer' AND to_account_id IS NOT NULL AND to_account_id <> account_id)),

    CHECK (confidence_score IS NULL OR (confidence_score >= 0.0 AND confidence_score <= 1.0)),

    -- §5.5：confirmed 意味着"分类/支出转账类型均无歧义"；转账与调整不参与收支统计，不强求分类
    CHECK (state <> 'confirmed' OR type IN ('transfer', 'adjustment') OR category_id IS NOT NULL)
);

CREATE INDEX IF NOT EXISTS idx_txn_account_occurred ON transactions(account_id, occurred_at);
CREATE INDEX IF NOT EXISTS idx_txn_occurred         ON transactions(occurred_at);
CREATE INDEX IF NOT EXISTS idx_txn_state            ON transactions(state);
CREATE INDEX IF NOT EXISTS idx_txn_type             ON transactions(type);
CREATE INDEX IF NOT EXISTS idx_txn_category         ON transactions(category_id);
CREATE INDEX IF NOT EXISTS idx_txn_source_message   ON transactions(source_message_id);

-- R4 统计口径索引：只覆盖"计入收支统计"的那部分数据（已确认的支出/收入）
CREATE INDEX IF NOT EXISTS idx_txn_reportable ON transactions(type, occurred_at)
    WHERE state = 'confirmed' AND type IN ('expense', 'income');

-- ---------------------------------------------------------------------------
-- 4. rules 用户教的规则
--    condition / action 为 JSON 文本，具体结构由 Phase 2 定稿；
--    同一 condition 只允许一条规则（冲突则走"是否覆盖"追问，§5.4）。
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS rules (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    condition  TEXT    NOT NULL UNIQUE,   -- JSON
    action     TEXT    NOT NULL,          -- JSON
    provenance TEXT    NOT NULL CHECK (provenance IN ('manual', 'learned_from_correction')),
    active     INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1)),
    hit_count  INTEGER NOT NULL DEFAULT 0 CHECK (hit_count >= 0),
    created_at TEXT    NOT NULL,
    updated_at TEXT    NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_rules_active ON rules(active);

-- ---------------------------------------------------------------------------
-- 5. imports 导入批次
--    CSV / xlsx 已裁定不进 MVP（§9），枚举值保留为预留位。
--    批次与交易的关联：本批次产生的 transactions 共享同一 source_message_id（Q2）。
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS imports (
    id                INTEGER PRIMARY KEY AUTOINCREMENT,
    source_type       TEXT    NOT NULL CHECK (source_type IN ('screenshot', 'text', 'csv', 'xlsx')),
    status            TEXT    NOT NULL CHECK (status IN ('pending', 'parsed', 'confirmed', 'failed')),
    source_ref        TEXT    NULL,   -- 原文件/截图标识，仅本地记录
    source_message_id TEXT    NULL,   -- 批次标识
    created_at        TEXT    NOT NULL,
    updated_at        TEXT    NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_imports_status         ON imports(status);
CREATE INDEX IF NOT EXISTS idx_imports_source_message ON imports(source_message_id);

-- ---------------------------------------------------------------------------
-- 6. agent_runs 一次 agent 执行 / 对话轮次
--    与 audit_log 的边界：这里记"agent 执行过程"，audit_log 记"账务状态变化"（§13）。
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS agent_runs (
    id             INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id     TEXT    NOT NULL,
    user_input     TEXT    NULL,   -- trigger='scheduled'（月报）时为空
    llm_provider   TEXT    NULL,
    tool_calls     TEXT    NULL,   -- JSON 数组
    output_summary TEXT    NULL,
    trigger        TEXT    NOT NULL CHECK (trigger IN ('user', 'scheduled')),
    status         TEXT    NOT NULL CHECK (status IN ('running', 'success', 'failed', 'aborted')),
    created_at     TEXT    NOT NULL,
    updated_at     TEXT    NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_runs_session        ON agent_runs(session_id, created_at);
CREATE INDEX IF NOT EXISTS idx_runs_trigger_status ON agent_runs(trigger, status);

-- ---------------------------------------------------------------------------
-- 7. audit_log 审计日志（核心差异化）
--    R3：纠错 = transactions 更新当前值 + 同步写一条本表（before/after），
--        不做 append-only 版本行（§5.1）。
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS audit_log (
    id                INTEGER PRIMARY KEY AUTOINCREMENT,
    entity_type       TEXT    NOT NULL CHECK (entity_type IN ('transaction', 'category', 'account', 'rule', 'setting', 'import')),
    entity_id         INTEGER NOT NULL,
    changed_by        TEXT    NOT NULL CHECK (changed_by IN ('user', 'llm', 'rule_engine', 'import')),
    -- Phase 4：A5 恢复删除新增 'restore'（枚举 +1，无新增表/列；旧库需重建）
    change_type       TEXT    NOT NULL CHECK (change_type IN ('create', 'parse', 'auto_confirm', 'request_review', 'confirm', 'update', 'delete', 'restore')),
    before_value      TEXT    NULL,   -- JSON
    after_value       TEXT    NULL,   -- JSON
    source_message_id TEXT    NULL,
    reasoning         TEXT    NULL,
    confidence_score  REAL    NULL,
    changed_at        TEXT    NOT NULL,
    CHECK (confidence_score IS NULL OR (confidence_score >= 0.0 AND confidence_score <= 1.0))
);

CREATE INDEX IF NOT EXISTS idx_audit_entity  ON audit_log(entity_type, entity_id, changed_at);
CREATE INDEX IF NOT EXISTS idx_audit_changed ON audit_log(changed_at);
CREATE INDEX IF NOT EXISTS idx_audit_source  ON audit_log(source_message_id);

-- 待收尾任务：增量建表，旧账本原位保留；上下文不依赖聊天历史。
CREATE TABLE IF NOT EXISTS pending_clarifications (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    tx_id INTEGER NULL REFERENCES transactions(id) ON DELETE RESTRICT,
    session_id TEXT NOT NULL,
    field TEXT NOT NULL,
    question TEXT NOT NULL,
    rounds INTEGER NOT NULL DEFAULT 1,
    payload TEXT NOT NULL DEFAULT '{}',
    reminders INTEGER NOT NULL DEFAULT 0,
    bypassed INTEGER NOT NULL DEFAULT 0,
    revision INTEGER NOT NULL DEFAULT 1,
    status TEXT NOT NULL DEFAULT 'open' CHECK(status IN ('open','resolved','cancelled')),
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_pending_status ON pending_clarifications(status, id);

-- ---------------------------------------------------------------------------
-- 8. settings 极简键值设置

--    已定案键：monthly_budget_cents（月度预算数字，被动参照，非主动提醒）
--              llm_mode（online / local 双模式开关）
--              confidence_threshold（解析直通阈值，默认 0.7；Phase 2 校准后更新，2026-09-14 裁定）
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS settings (
    key        TEXT PRIMARY KEY,
    value      TEXT NOT NULL,
    updated_at TEXT NOT NULL
);

-- ---------------------------------------------------------------------------
-- 视图（非第 9 张表）：把 R4 统计口径固化在一处，避免各处重复写 WHERE
-- state='confirmed' 天然排除软删除（deleted 是独立状态，不是并列标志位）。
-- ---------------------------------------------------------------------------
CREATE VIEW IF NOT EXISTS v_reportable_transactions AS
SELECT t.id,
       t.account_id,
       t.category_id,
       t.amount_cents,
       t.type,
       t.occurred_at,
       t.merchant,
       t.note
FROM transactions t
WHERE t.state = 'confirmed'
  AND t.type IN ('expense', 'income');
