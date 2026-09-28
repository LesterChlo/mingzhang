// T0924-1418 round3 RED: B2 生产 schema 契约必须机械比较生产 DDL。
// 上一版契约只比「表名 + 列名」，删生产索引/视图、去掉 CHECK、去掉 AUTOINCREMENT
// 全都会被 ACCEPTED。本文件锁定这些场景必须被拒。
// 全部只用 mkdtempSync 合成库，不触真实账本 / %APPDATA%。
import { describe, expect, it } from 'vitest'
import DatabaseCtor from 'better-sqlite3-multiple-ciphers'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { validateLedgerDatabase, getProductionSchemaContract } from '../src/main/domain/backup'
import { schemaSql } from './helpers'
import { runMigrations } from '../src/main/db/migrations'

type Db = InstanceType<typeof DatabaseCtor>

/** 用（可被篡改的）schema 文本 + 迁移造一个明文合成库。 */
function buildFromSchema(file: string, sql: string): Db {
  const db = new DatabaseCtor(file)
  db.pragma('foreign_keys = OFF')
  db.exec(sql)
  runMigrations(db)
  return db
}

const ACCOUNTS_PRODUCTION_BLOCK = `CREATE TABLE IF NOT EXISTS accounts (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    name       TEXT    NOT NULL UNIQUE,
    type       TEXT    NOT NULL CHECK (type IN ('cash', 'bank', 'alipay', 'wechat')),
    currency   TEXT    NOT NULL DEFAULT 'CNY' CHECK (currency = 'CNY'),  -- R5：MVP 单币种，字段仅预留
    created_at TEXT    NOT NULL,
    updated_at TEXT    NOT NULL
);`

/** accounts 去掉 AUTOINCREMENT、去掉 type/currency 的 CHECK：列名/列类型/notnull/default 全同。 */
const ACCOUNTS_NO_AUTOINC_NO_CHECK = `CREATE TABLE IF NOT EXISTS accounts (
    id         INTEGER PRIMARY KEY,
    name       TEXT    NOT NULL UNIQUE,
    type       TEXT    NOT NULL,
    currency   TEXT    NOT NULL DEFAULT 'CNY',
    created_at TEXT    NOT NULL,
    updated_at TEXT    NOT NULL
);`

/** name 去掉 NOT NULL、currency 的 DEFAULT 从 'CNY' 漂到 'USD'：仅约束层漂移。 */
const ACCOUNTS_DRIFTED_CONSTRAINTS = `CREATE TABLE IF NOT EXISTS accounts (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    name       TEXT    UNIQUE,
    type       TEXT    NOT NULL CHECK (type IN ('cash', 'bank', 'alipay', 'wechat')),
    currency   TEXT    NOT NULL DEFAULT 'USD' CHECK (currency = 'CNY'),
    created_at TEXT    NOT NULL,
    updated_at TEXT    NOT NULL
);`

/** 拿生产 schema 文本，把 accounts 段整段替换掉（其余 DDL 与生产完全同源）。
 *  先统一行尾：仓库里 schema.sql 为 CRLF，契约侧归一化会折叠空白，两侧口径一致。 */
function schemaWithAccounts(block: string): string {
  const src = schemaSql().replace(/\r\n/g, '\n')
  if (!src.includes(ACCOUNTS_PRODUCTION_BLOCK)) {
    throw new Error('schema.sql 的 accounts 段与测试期望不一致（生产 DDL 已变，请同步本用例）')
  }
  return src.replace(ACCOUNTS_PRODUCTION_BLOCK, block)
}

describe('B2 RED：删生产索引 / 删视图的库必须被拒', () => {
  it('删除 idx_txn_state、idx_txn_reportable 与视图 v_reportable_transactions 后必须拒绝', () => {
    const dir = mkdtempSync(join(tmpdir(), 'mz-r3b2-idx-'))
    const file = join(dir, 'ledger.db')
    const db = buildFromSchema(file, schemaSql())
    try {
      // 未动过的生产同源库必须先被接受（守门本身不能过度严格）
      expect(() => validateLedgerDatabase(db, '契约基线')).not.toThrow()

      db.exec('DROP INDEX idx_txn_state')
      db.exec('DROP INDEX idx_txn_reportable')
      db.exec('DROP VIEW v_reportable_transactions')

      expect(() => validateLedgerDatabase(db, '契约回归')).toThrow(/索引|视图|结构|契约/i)
    } finally {
      db.close()
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe('B2 RED：accounts 去掉 AUTOINCREMENT / CHECK 必须被拒', () => {
  it('accounts 重建为无 AUTOINCREMENT 且无 type/currency CHECK 后必须拒绝', () => {
    const dir = mkdtempSync(join(tmpdir(), 'mz-r3b2-ai-'))
    const file = join(dir, 'ledger.db')
    const db = buildFromSchema(file, schemaWithAccounts(ACCOUNTS_NO_AUTOINC_NO_CHECK))
    try {
      // 契约列元组（name/type/notnull/dflt/pk）与生产完全相同 —— 旧实现必然 ACCEPTED。
      expect(() => validateLedgerDatabase(db, '契约回归')).toThrow(/AUTOINCREMENT|结构|契约|表定义/i)
    } finally {
      db.close()
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe('B2 RED：列 NOT NULL / DEFAULT 漂移必须被拒', () => {
  it('accounts.name 去掉 NOT NULL、currency 默认值漂到 USD 后必须拒绝', () => {
    const dir = mkdtempSync(join(tmpdir(), 'mz-r3b2-col-'))
    const file = join(dir, 'ledger.db')
    const db = buildFromSchema(file, schemaWithAccounts(ACCOUNTS_DRIFTED_CONSTRAINTS))
    try {
      // 列名集合与生产完全相同 —— 旧实现（只比列名）必然 ACCEPTED。
      expect(() => validateLedgerDatabase(db, '契约回归')).toThrow(/列|结构|契约|定义|DEFAULT|NOT NULL/i)
    } finally {
      db.close()
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe('B2 契约本身：必须机械导出（含索引/视图/AUTOINCREMENT）', () => {
  it('契约覆盖生产索引/视图与 AUTOINCREMENT 标志，且从 sqlite_master 机械得出', () => {
    const contract = getProductionSchemaContract() as unknown as {
      tables: string[]
      columns: Record<string, string[]>
      indexes: Record<string, string>
      views: Record<string, string>
      triggers: Record<string, string>
      detail?: { tables: Record<string, { autoincrement: boolean; columns: { name: string; type: string; notnull: number; dflt: string | null; pk: number }[] }> }
    }
    // 旧字段仍在（既有 round2 用例依赖），但不能只有它们
    expect(contract.tables).toContain('transactions')
    expect(contract.columns.transactions).toContain('amount_cents')
    expect(contract.indexes).toBeDefined()
    expect(contract.views).toBeDefined()
    expect(contract.triggers).toBeDefined()
    // 机械内容：生产索引/视图必须逐个在契约里
    for (const idx of ['idx_txn_state', 'idx_txn_reportable', 'idx_txn_dedup', 'idx_bill_rows_open']) {
      expect(Object.keys(contract.indexes)).toContain(idx)
    }
    expect(Object.keys(contract.views)).toContain('v_reportable_transactions')
    // sqlite_autoindex_* 必须排除
    expect(Object.keys(contract.indexes).some((n) => n.startsWith('sqlite_autoindex'))).toBe(false)
    // AUTOINCREMENT 标志与列级元组必须存在
    expect(contract.detail?.tables.accounts.autoincrement).toBe(true)
    const currency = contract.detail?.tables.accounts.columns.find((c) => c.name === 'currency')
    expect(currency).toMatchObject({ name: 'currency', type: 'TEXT', notnull: 1, dflt: "'CNY'", pk: 0 })
  })
})

describe('B2 兼容：v1 旧库升级后仍必须被接受（R5 同源场景）', () => {
  it('user_version=1 旧库经迁移后必须通过严格契约（不得过度严格）', () => {
    const dir = mkdtempSync(join(tmpdir(), 'mz-r3b2-v1-'))
    const file = join(dir, 'v1.db')
    const db = new DatabaseCtor(file)
    db.pragma('foreign_keys = OFF')
    db.exec(schemaSql())
    // 与 tests/restore-safety.test.ts 的 makeV1Ledger 同源：手做 v1 迁移并锁版本 1
    db.exec('ALTER TABLE transactions ADD COLUMN dedup_key TEXT NULL')
    db.exec('CREATE INDEX IF NOT EXISTS idx_txn_dedup ON transactions(dedup_key) WHERE dedup_key IS NOT NULL')
    db.pragma('user_version = 1')
    runMigrations(db)
    try {
      expect(() => validateLedgerDatabase(db, 'v1 迁移后账本')).not.toThrow()
    } finally {
      db.close()
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
