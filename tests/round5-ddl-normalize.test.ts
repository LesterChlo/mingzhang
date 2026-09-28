// T0924-1418 round5：schema DDL 归一化对「纯排版差异」不得判漂移。
//
// 第四轮复核提出三个反例（括号前空格 / 列对齐空格 / 去 IF NOT EXISTS）被 REJECTED。
// 本轮独立裁定（.scratch/r5probe-adjudicate.test.ts，日志 T0924-1418-r5-norm-adjudicate.log）确认：
//   - 「括号前空格」「闭合括号前空格」「运算符两侧空格」是**真误判**（原实现只折叠连续空白，
//     不抹平标点毗邻空白），语义等价的排版差异被当成 CHECK/约束漂移 → 拒启动；
//   - 「列对齐空格」与「去 IF NOT EXISTS」本来就已被接受（原实现折叠空白 + 删 IF NOT EXISTS）。
// 结论：问题属实，范围是「标点毗邻空白」。修复方式：normalizeSchemaDdl 改为字面量安全的
// 单趟扫描，字面量之外抹平标点毗邻空白；字面量内部空白**原样保留**（那是数据）。
//
// 本文件同时锁住反面（真漂移必须仍被拒），防止「放宽排版」被误用成「放宽 schema」：
//   A 排版变体（括号/对齐/IF NOT EXISTS/单行重写/视图缩进）→ 必须 ACCEPTED；
//   B 真漂移（改类型/改默认值/去 NOT NULL/改 CHECK 枚举/改索引定义/删索引）→ 必须 REJECTED；
//   C 字面量安全：'x y' ≠ 'xy'，DEFAULT -1 不得被空白归一化吃掉。
// 全部用 mkdtempSync 合成库，绝不指向 %APPDATA% 真实数据。
import { describe, expect, it } from 'vitest'
import DatabaseCtor from 'better-sqlite3-multiple-ciphers'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { normalizeSchemaDdl, validateLedgerDatabase } from '../src/main/domain/backup'
import { runMigrations } from '../src/main/db/migrations'
import { schemaSql } from './helpers'

/** 生产 schema.sql 里的 settings 表（CRLF 归一后）。 */
const PROD_SETTINGS =
  'CREATE TABLE IF NOT EXISTS settings (\n' +
  '    key        TEXT PRIMARY KEY,\n' +
  '    value      TEXT NOT NULL,\n' +
  '    updated_at TEXT NOT NULL\n' +
  ');'

/** 生产 schema.sql 里的 idx_txn_reportable 索引（含 WHERE 子句 + 字面量）。 */
const PROD_INDEX_REPORTABLE =
  "CREATE INDEX IF NOT EXISTS idx_txn_reportable ON transactions(type, occurred_at)\n" +
  "    WHERE state = 'confirmed' AND type IN ('expense', 'income');"

/** 生产 schema.sql 里的 v_reportable_transactions 视图。 */
const PROD_VIEW = `CREATE VIEW IF NOT EXISTS v_reportable_transactions AS
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
  AND t.type IN ('expense', 'income');`

function normalized(src: string): string {
  return src.replace(/\r\n/g, '\n')
}

/** 用合成库跑一次生产 schema（可替换其中的 DDL 段），返回 validateLedgerDatabase 的裁定。 */
function verdictWith(replacements: readonly (readonly [string, string])[]): {
  rejected: boolean
  msg: string
} {
  let src = normalized(schemaSql())
  for (const [from, to] of replacements) {
    if (!src.includes(from)) throw new Error(`探针基线与生产 schema.sql 不一致：${from.slice(0, 60)}`)
    src = src.replace(from, to)
  }
  const dir = mkdtempSync(join(tmpdir(), 'mz-r5ddl-'))
  const file = join(dir, 'probe.db')
  const db = new DatabaseCtor(file)
  try {
    db.exec(src)
    runMigrations(db)
    try {
      validateLedgerDatabase(db, '排版变体')
      return { rejected: false, msg: '' }
    } catch (err) {
      return { rejected: true, msg: (err as Error).message }
    }
  } finally {
    db.close()
    rmSync(dir, { recursive: true, force: true })
  }
}

describe('A · 排版变体必须 ACCEPTED（字面量之外的排版差异不是漂移）', () => {
  it('A0 对照组：生产 schema.sql 原样必须通过（防止整条用例空转）', () => {
    expect(verdictWith([])).toEqual({ rejected: false, msg: '' })
  })

  const TABLE_LAYOUTS: readonly (readonly [string, string, string])[] = [
    [
      '括号前有空格 → 紧贴左括号',
      PROD_SETTINGS,
      'CREATE TABLE IF NOT EXISTS settings(\n' +
        '    key        TEXT PRIMARY KEY,\n' +
        '    value      TEXT NOT NULL,\n' +
        '    updated_at TEXT NOT NULL\n' +
        ');',
    ],
    [
      '闭合括号前换行 → 紧贴右括号',
      PROD_SETTINGS,
      'CREATE TABLE IF NOT EXISTS settings (\n' +
        '    key        TEXT PRIMARY KEY,\n' +
        '    value      TEXT NOT NULL,\n' +
        '    updated_at TEXT NOT NULL);',
    ],
    [
      '整表单行重写（无任何换行/对齐）',
      PROD_SETTINGS,
      'CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at TEXT NOT NULL);',
    ],
    [
      '单行重写 + 去 IF NOT EXISTS',
      PROD_SETTINGS,
      'CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at TEXT NOT NULL);',
    ],
    [
      '去 IF NOT EXISTS（多行保持）',
      PROD_SETTINGS,
      'CREATE TABLE settings (\n' +
        '    key        TEXT PRIMARY KEY,\n' +
        '    value      TEXT NOT NULL,\n' +
        '    updated_at TEXT NOT NULL\n' +
        ');',
    ],
    [
      '列对齐空格 + 括号毗邻空白同时变化',
      PROD_SETTINGS,
      'CREATE TABLE settings(key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at TEXT NOT NULL);',
    ],
  ]

  for (const [name, from, to] of TABLE_LAYOUTS) {
    it(`A1 表 DDL 排版：${name}`, () => {
      const r = verdictWith([[from, to]])
      expect(r.rejected, `排版变体被误判为漂移：${r.msg}`).toBe(false)
    })
  }

  const INDEX_LAYOUTS: readonly (readonly [string, string, string])[] = [
    [
      '索引去 IF NOT EXISTS + 括号毗邻空白',
      PROD_INDEX_REPORTABLE,
      "CREATE INDEX idx_txn_reportable ON transactions(type,occurred_at)\n" +
        "    WHERE state='confirmed' AND type IN ('expense','income');",
    ],
    [
      '索引整行压平（字面量内空白保留）',
      PROD_INDEX_REPORTABLE,
      "CREATE INDEX IF NOT EXISTS idx_txn_reportable ON transactions(type, occurred_at) WHERE state = 'confirmed' AND type IN ('expense', 'income');",
    ],
  ]

  for (const [name, from, to] of INDEX_LAYOUTS) {
    it(`A2 索引 DDL 排版：${name}`, () => {
      const r = verdictWith([[from, to]])
      expect(r.rejected, `索引排版变体被误判为漂移：${r.msg}`).toBe(false)
    })
  }

  const VIEW_LAYOUTS: readonly (readonly [string, string, string])[] = [
    [
      '视图整体缩进改为 2 空格 + 去 IF NOT EXISTS',
      PROD_VIEW,
      'CREATE VIEW v_reportable_transactions AS\n' +
        '  SELECT t.id,\n' +
        '         t.account_id,\n' +
        '         t.category_id,\n' +
        '         t.amount_cents,\n' +
        '         t.type,\n' +
        '         t.occurred_at,\n' +
        '         t.merchant,\n' +
        '         t.note\n' +
        '  FROM transactions t\n' +
        "  WHERE t.state = 'confirmed'\n" +
        "    AND t.type IN ('expense', 'income');",
    ],
    [
      '视图压成单行（字面量与列清单不变）',
      PROD_VIEW,
      'CREATE VIEW IF NOT EXISTS v_reportable_transactions AS SELECT t.id, t.account_id, t.category_id, t.amount_cents, t.type, t.occurred_at, t.merchant, t.note FROM transactions t WHERE t.state = \'confirmed\' AND t.type IN (\'expense\', \'income\');',
    ],
  ]

  for (const [name, from, to] of VIEW_LAYOUTS) {
    it(`A3 视图 DDL 排版：${name}`, () => {
      const r = verdictWith([[from, to]])
      expect(r.rejected, `视图排版变体被误判为漂移：${r.msg}`).toBe(false)
    })
  }
})

describe('B · 真漂移必须仍被 REJECTED（放宽排版不得放宽 schema 契约）', () => {
  it('B1 改列类型 TEXT → BLOB', () => {
    const r = verdictWith([
      [
        PROD_SETTINGS,
        'CREATE TABLE IF NOT EXISTS settings (\n' +
          '    key        TEXT PRIMARY KEY,\n' +
          '    value      BLOB NOT NULL,\n' +
          '    updated_at TEXT NOT NULL\n' +
          ');',
      ],
    ])
    expect(r.rejected, '改列类型未被拒').toBe(true)
  })

  it('B2 改默认值（DEFAULT \'CNY\' → \'USD\'）', () => {
    const from = "currency   TEXT    NOT NULL DEFAULT 'CNY' CHECK (currency = 'CNY'),"
    const to = "currency   TEXT    NOT NULL DEFAULT 'USD' CHECK (currency = 'USD'),"
    const r = verdictWith([[from, to]])
    expect(r.rejected, '改默认值未被拒').toBe(true)
  })

  it('B3 去 NOT NULL（排版同时变化，仍必须拒）', () => {
    const r = verdictWith([
      [
        PROD_SETTINGS,
        'CREATE TABLE settings(key TEXT PRIMARY KEY, value TEXT, updated_at TEXT NOT NULL);',
      ],
    ])
    expect(r.rejected, '去 NOT NULL 未被拒').toBe(true)
  })

  it('B4 改 CHECK 枚举（accounts.type 少一个枚举值）', () => {
    const from = "    type       TEXT    NOT NULL CHECK (type IN ('cash', 'bank', 'alipay', 'wechat')),"
    const to = "    type       TEXT    NOT NULL CHECK (type IN ('cash', 'bank', 'alipay')),"
    const r = verdictWith([[from, to]])
    expect(r.rejected, '改 CHECK 枚举未被拒').toBe(true)
  })

  it('B4b 改 CHECK 枚举为「排版也一起动」（双变量，仍必须拒）', () => {
    const from = "    type       TEXT    NOT NULL CHECK (type IN ('cash', 'bank', 'alipay', 'wechat')),"
    const to = "    type       TEXT    NOT NULL CHECK(type IN('cash','bank','alipay')),"
    const r = verdictWith([[from, to]])
    expect(r.rejected, '改 CHECK 枚举（连带排版变化）未被拒').toBe(true)
  })

  it('B5 改索引定义（多一个列 → 索引语义变化）', () => {
    const r = verdictWith([
      [
        'CREATE INDEX IF NOT EXISTS idx_txn_state            ON transactions(state);',
        'CREATE INDEX IF NOT EXISTS idx_txn_state            ON transactions(state, type);',
      ],
    ])
    expect(r.rejected, '改索引定义未被拒').toBe(true)
  })

  it('B5b 改索引 WHERE 子句（字面量内容变化，不是排版）', () => {
    const r = verdictWith([
      [
        PROD_INDEX_REPORTABLE,
        "CREATE INDEX IF NOT EXISTS idx_txn_reportable ON transactions(type, occurred_at)\n" +
          "    WHERE state = 'raw_input' AND type IN ('expense', 'income');",
      ],
    ])
    expect(r.rejected, '改索引 WHERE 子句未被拒').toBe(true)
  })

  it('B6 删索引', () => {
    const r = verdictWith([['CREATE INDEX IF NOT EXISTS idx_txn_state            ON transactions(state);\n', '']])
    expect(r.rejected, '删索引未被拒').toBe(true)
  })
})

describe('C · 字面量安全：归一化绝不能折叠字符串字面量内部的空白', () => {
  it("C1 'x y' 与 'xy' 归一化后必须不同（否则 CHECK 语义漂移会被放过）", () => {
    const a = normalizeSchemaDdl("CREATE TABLE t (a TEXT NOT NULL CHECK(a = 'x y'))")
    const b = normalizeSchemaDdl("CREATE TABLE t (a TEXT NOT NULL CHECK(a = 'xy'))")
    expect(a).not.toBe(b)
    expect(a).toContain("'x y'")
  })

  it('C2 字面量内多空格/换行原样保留（不被折叠成一个空格）', () => {
    const n = normalizeSchemaDdl("CREATE TABLE t (a TEXT NOT NULL DEFAULT 'x   y')")
    expect(n).toContain("'x   y'")
  })

  it('C3 负数默认值 DEFAULT -1 不得因空白归一化被改写', () => {
    const a = normalizeSchemaDdl('CREATE TABLE t (c REAL DEFAULT -1, d INTEGER)')
    const b = normalizeSchemaDdl('CREATE TABLE t (c REAL DEFAULT - 1, d INTEGER)')
    // 排版差异（-1 vs - 1）应被接受，但 -1 本身必须逐字保留。
    expect(a).toBe(b)
    expect(a).toContain('default-1')
  })

  it('C4 标识符/字面量区分大小写：ABC 与 abc 在字面量里必须不同', () => {
    expect(normalizeSchemaDdl("CREATE TABLE t (a TEXT NOT NULL DEFAULT 'ABC')")).not.toBe(
      normalizeSchemaDdl("CREATE TABLE t (a TEXT NOT NULL DEFAULT 'abc')"),
    )
  })

  it("C5 转义单引号（两个连续单引号）不破坏字面量边界", () => {
    const n = normalizeSchemaDdl("CREATE TABLE t (a TEXT NOT NULL DEFAULT 'it''s a b')")
    expect(n).toContain("'it''s a b'")
  })

  it('C6 字面量里的 -- 不是注释', () => {
    const n = normalizeSchemaDdl("CREATE TABLE t (a TEXT NOT NULL DEFAULT 'x -- y')")
    expect(n).toContain("'x -- y'")
  })

  it('C7 -- 注释确实被去掉（不是把注释留下靠别的规则蒙混过关）', () => {
    expect(normalizeSchemaDdl('CREATE TABLE t (a TEXT) -- 尾注释\n')).toBe(
      normalizeSchemaDdl('CREATE TABLE t (a TEXT)'),
    )
  })

  it('C8 括号/逗号/运算符两侧空白被抹平（本次修复的核心行为）', () => {
    expect(normalizeSchemaDdl('CREATE TABLE t (a TEXT)')).toBe(
      normalizeSchemaDdl('CREATE TABLE t(a TEXT)'),
    )
    expect(normalizeSchemaDdl('CREATE TABLE t (a TEXT, b REAL)')).toBe(
      normalizeSchemaDdl('CREATE TABLE t(a TEXT,b REAL)'),
    )
    expect(normalizeSchemaDdl('CREATE TABLE t (a REAL CHECK (a >= 0 AND a <= 1))')).toBe(
      normalizeSchemaDdl('CREATE TABLE t(a REAL CHECK(a>=0 AND a<=1))'),
    )
  })

  it('C9 排版归一化不得吞掉标识符差异（no drift stays drift）', () => {
    expect(normalizeSchemaDdl('CREATE TABLE t (aa TEXT)')).not.toBe(
      normalizeSchemaDdl('CREATE TABLE t (a TEXT)'),
    )
  })
})
