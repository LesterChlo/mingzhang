// 备份两类（决定记录 §6）：
//   ① 本机快照：自动、无感、防误操作 —— VACUUM INTO backups/，保留最近 N 份；
//   ② 跨机口令包：手动、低频 —— 用户口令 + Argon2id 派生 + AES-256-GCM 加密整个库快照。
// 无后门：口令不存盘；忘口令 = 不可恢复（文档如实写明）。密钥/配置/会话绝不进备份。

import DatabaseCtor, { type Database } from 'better-sqlite3-multiple-ciphers'
import { randomBytes, createCipheriv, createDecipheriv } from 'node:crypto'
import { isDeepStrictEqual } from 'node:util'
import {
  readdirSync,
  readFileSync,
  writeFileSync as fsWriteFileSync,
  openSync as fsOpenSync,
  closeSync as fsCloseSync,
  fsyncSync as fsFsyncSync,
  openSync,
  statSync,
  existsSync,
  lstatSync,
  realpathSync,
  unlinkSync,
  rmSync as fsRmSync,
  mkdirSync,
  mkdtempSync,
  copyFileSync as fsCopyFileSync,
  renameSync as fsRenameSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join, basename, dirname, resolve, sep, isAbsolute } from 'node:path'
import { argon2id } from 'hash-wasm'
import { runMigrations } from '../db/migrations'
import schemaSqlText from '../db/schema.sql?raw'

const SNAPSHOT_KEEP = 7
const SNAPSHOT_INTERVAL_MS = 24 * 60 * 60 * 1000
const CIPHER = 'chacha20'
const BACKUP_MAGIC = 'MZBK'
const BACKUP_VERSION = 1
const ARGON_MEMORY_KIB = 64 * 1024 // 64 MiB
const ARGON_ITERATIONS = 3
/** 语义无关的标点/运算符：其毗邻空白不承载语义，折叠时直接抹平。 */
const PUNCT_ADJACENT = /[(),;=<>!+\-*/%|&.]/

function isSpaceCh(ch: string): boolean {
  return ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r' || ch === '\f' || ch === '\v'
}

function isWordCh(ch: string | undefined): boolean {
  return ch !== undefined && /[A-Za-z0-9_$]/.test(ch)
}

/** 从 i 处尝试匹配独立的 `IF NOT EXISTS`（大小写不敏感），返回结束下标或不匹配。 */
function matchIfNotExists(sql: string, i: number): number | null {
  const kw = sql.slice(i, i + 2)
  if (kw.toLowerCase() !== 'if') return null
  if (isWordCh(sql[i - 1]) || isWordCh(sql[i + 2])) return null
  let j = i + 2
  const skipWs = (): void => {
    while (j < sql.length && isSpaceCh(sql[j])) j += 1
  }
  skipWs()
  if (sql.slice(j, j + 3).toLowerCase() !== 'not') return null
  if (isWordCh(sql[j - 1]) || isWordCh(sql[j + 3])) return null
  j += 3
  skipWs()
  if (sql.slice(j, j + 6).toLowerCase() !== 'exists') return null
  if (isWordCh(sql[j - 1]) || isWordCh(sql[j + 6])) return null
  return j + 6
}

/**
 * 生产 DDL 归一化：契约侧与被检侧共用同一函数，保证口径一致。
 *
 * 第五轮裁定修复：原实现只做「折叠连续空白」，于是**纯排版差异**仍被判成漂移 ——
 *   `settings ( key` vs `settings(key`、`CHECK (x = 1)` vs `CHECK(x=1)`、换行/对齐空格。
 *   这些在 SQLite 语义上完全等价（schema.sql 与 sqlite_master 都原样保留排版），
 *   却让「同库重建、仅排版不同」的合法账本被 openLedger 拒启动。
 * 现在**字面量之外**的空白统一折叠，且紧贴 PUNCT_ADJACENT 标点的空白直接抹平。
 * 这类空白不承载任何语义，抹平它不可能掩盖真漂移：真漂移必然改动标识符或字面量本身，
 * 而标识符/字面量的差异在这里仍然逐字保留。
 *
 * 单趟扫描，字面量安全（关键约束）：
 *  - `'...'` 内部原样保留（含大小写与空白）—— `'x y'` 与 `'xy'` 语义不同，绝不能折叠；
 *  - 去注释（`--` / `/* *\/`）时不动字面量；
 *  - `IF NOT EXISTS` 关键字删除（沿用既有口径，两侧一致）。
 * 去注释必须在折叠空白之前：schema.sql 的列尾注释含换行，先折叠会让注释吞掉后半条 DDL。
 */
export function normalizeSchemaDdl(sql: string): string {
  const out: string[] = []
  const n = sql.length
  let i = 0
  /** 见到下一个实字符时才决定是否补一个空格（折叠）。 */
  let pendingSpace = false
  const pushWord = (text: string): void => {
    if (text === '') return
    const last = out[out.length - 1]
    if (pendingSpace && out.length > 0 && last !== undefined && !PUNCT_ADJACENT.test(last)) {
      out.push(' ')
    }
    pendingSpace = false
    out.push(text)
  }
  while (i < n) {
    const ch = sql[i]
    // 注释（字面量之外）
    if (ch === '-' && sql[i + 1] === '-') {
      while (i < n && sql[i] !== '\n') i += 1
      continue
    }
    if (ch === '/' && sql[i + 1] === '*') {
      i += 2
      while (i < n && !(sql[i] === '*' && sql[i + 1] === '/')) i += 1
      i = Math.min(n, i + 2)
      continue
    }
    // 字符串字面量：整体原样保留（内部空白/大小写是数据）
    if (ch === "'") {
      let j = i + 1
      while (j < n) {
        if (sql[j] === "'") {
          if (sql[j + 1] === "'") {
            j += 2
            continue
          }
          j += 1
          break
        }
        j += 1
      }
      pushWord(sql.slice(i, j))
      i = j
      continue
    }
    // 标识符引号：只删包裹引号，保留被引标识符本身
    if (ch === '"' || ch === '`') {
      i += sql[i + 1] === ch ? 2 : 1
      continue
    }
    if (ch === '[') {
      const close = sql.indexOf(']', i + 1)
      i = close === -1 ? n : close + 1
      continue
    }
    // 空白：折叠为一个待定空格
    if (isSpaceCh(ch)) {
      pendingSpace = true
      i += 1
      continue
    }
    // IF NOT EXISTS：删除关键字
    const ifEnd = matchIfNotExists(sql, i)
    if (ifEnd !== null) {
      pendingSpace = true
      i = ifEnd
      continue
    }
    // 标点/运算符：两侧不留空白
    if (PUNCT_ADJACENT.test(ch)) {
      pendingSpace = false
      out.push(ch)
      i += 1
      continue
    }
    // 标识符 / 数字 / 其它：按整词推进（逐字也可，但整词更易读）
    let j = i
    while (
      j < n &&
      !isSpaceCh(sql[j]) &&
      !PUNCT_ADJACENT.test(sql[j]) &&
      sql[j] !== "'" &&
      sql[j] !== '"' &&
      sql[j] !== '`' &&
      sql[j] !== '['
    ) {
      j += 1
    }
    pushWord(sql.slice(i, j).toLowerCase())
    i = j
  }
  return out.join('')
}

/** 列级契约元组：仅比列名会漏掉 NOT NULL / DEFAULT / 主键 / 类型漂移。 */
export interface ProductionColumnContract {
  name: string
  type: string
  notnull: number
  dflt: string | null
  pk: number
}

export interface ProductionTableContract {
  name: string
  /** AUTOINCREMENT 是高水位复制的硬前提，只比列名完全看不出漂移。 */
  autoincrement: boolean
  columns: ProductionColumnContract[]
  /** 归一化 CREATE TABLE 全文：覆盖 CHECK / UNIQUE / 表级约束。 */
  sql: string
}

export interface ProductionSchemaContract {
  /** 兼容字段：表名集合（既有调用方依赖）。 */
  tables: string[]
  /** 兼容字段：表 → 列名（既有调用方依赖）。 */
  columns: Record<string, string[]>
  detail: { tables: Record<string, ProductionTableContract> }
  indexes: Record<string, string>
  views: Record<string, string>
  triggers: Record<string, string>
}

type SqliteObjectType = 'table' | 'index' | 'view' | 'trigger'

/** 从 sqlite_master 机械读一类对象：name → 归一化 DDL（排除 sqlite_autoindex_*）。 */
function readSchemaObjects(db: Database, type: SqliteObjectType): Record<string, string> {
  const rows = db
    .prepare(
      "SELECT name, sql FROM sqlite_master WHERE type = ? AND sql IS NOT NULL" +
        " AND name NOT LIKE 'sqlite_autoindex%' ORDER BY name",
    )
    .all(type) as { name: string; sql: string }[]
  const out: Record<string, string> = {}
  for (const r of rows) out[r.name] = normalizeSchemaDdl(r.sql)
  return out
}

/** 从 sqlite_master + PRAGMA table_info 机械读全部表的契约。 */
function readTableContracts(db: Database): Record<string, ProductionTableContract> {
  const rows = db
    .prepare("SELECT name, sql FROM sqlite_master WHERE type = 'table' AND sql IS NOT NULL ORDER BY name")
    .all() as { name: string; sql: string }[]
  const out: Record<string, ProductionTableContract> = {}
  for (const r of rows) {
    const cols = db
      .prepare(`PRAGMA table_info("${r.name.replace(/"/g, '""')}")`)
      .all() as { name: string; type: string; notnull: number; dflt_value: string | null; pk: number }[]
    out[r.name] = {
      name: r.name,
      autoincrement: /\bautoincrement\b/i.test(r.sql),
      columns: cols.map((c) => ({ name: c.name, type: c.type, notnull: c.notnull, dflt: c.dflt_value, pk: c.pk })),
      sql: normalizeSchemaDdl(r.sql),
    }
  }
  return out
}

/** 生产 schema 契约（防漂移）：表集合直接解析自 schema.sql 的 CREATE TABLE；
 * 列级元组 / AUTOINCREMENT / 归一化表 DDL / 索引 / 视图 / 触发器全部从
 * 「内存库 exec(schema.sql)+runMigrations()」的 sqlite_master 机械导出（非手写子集）。
 * connection.ts 的启动守门与恢复路径复用同一校验，保证生产/恢复同一口径。 */
export function getProductionSchemaContract(): ProductionSchemaContract {
  const names = new Set<string>()
  const re = /CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?["'`\[]?([A-Za-z_][A-Za-z0-9_]*)["'`\]]?/gi
  let m: RegExpExecArray | null
  while ((m = re.exec(schemaSqlText)) !== null) names.add(m[1])
  const tables = [...names]
  const mem = new DatabaseCtor(':memory:')
  try {
    mem.exec(schemaSqlText)
    runMigrations(mem)
    // 表集合 = schema.sql 解析 ∪ 迁移后实际表（迁移新增表如 bill_* 也纳入契约）。
    for (const t of Object.keys(readTableContracts(mem))) if (!names.has(t)) tables.push(t)
    const detail = { tables: readTableContracts(mem) }
    const columns: Record<string, string[]> = {}
    for (const t of tables) columns[t] = (detail.tables[t]?.columns ?? []).map((c) => c.name)
    return {
      tables,
      columns,
      detail,
      indexes: readSchemaObjects(mem, 'index'),
      views: readSchemaObjects(mem, 'view'),
      triggers: readSchemaObjects(mem, 'trigger'),
    }
  } finally {
    mem.close()
  }
}

/**
 * 恢复路径的文件操作 seam（生产级可注入）：
 * 生产默认直通 node:fs；测试可注入 EBUSY/Windows 锁及 journal 四阶段失败，验证提交后清理语义。
 * 注意：只覆盖恢复替换/清理路径，不影响快照与导出路径。
 *
 * journal 持久化契约（B6）：同目录临时文件 → 写完 → 文件 fsync → 原子 rename → 尽力 fsync 父目录。
 */
export interface RestoreFileOps {
  rmSync: (path: string, opts?: { force?: boolean; recursive?: boolean }) => void
  renameSync: (oldPath: string, newPath: string) => void
  copyFileSync: (src: string, dst: string) => void
  writeFileSync: (file: string, data: string | Buffer) => void
  /** 文件级 fsync（journal 持久化用；默认直通 fs.fsyncSync）。 */
  fsyncFile: (file: string) => void
  /** 父目录 fsync（journal rename 持久化用；失败只记残留，不翻转结论）。 */
  fsyncDir: (dir: string) => void
  /** 原子 JSON 写（tmp→fsync→rename→dir-fsync 一体；测试可整体/分阶段注入）。 */
  atomicWriteJson: (file: string, data: string) => void
}

function defaultFsyncFile(file: string): void {
  try {
    const fd = fsOpenSync(file, 'r')
    try {
      fsFsyncSync(fd)
    } finally {
      fsCloseSync(fd)
    }
  } catch {
    // Windows 只读句柄 fsync 可能 EPERM：降级为尽力而为，不翻转恢复结论
    // （journal 内容已落盘 write；rename 原子性不受影响）
  }
}

function defaultFsyncDir(dir: string): void {
  try {
    const fd = openSync(dir, 'r')
    try {
      fsFsyncSync(fd)
    } finally {
      fsCloseSync(fd)
    }
  } catch {
    // Windows 等不支持目录 fsync：尽力而为，不翻转恢复结论
  }
}

/**
 * journal 读回确认（B3）：rename 之后必须把正式 journal 读回来验证，否则
 * 「写盘成功」只代表字节落盘，不代表内容可信。截断/乱码/字段缺失的 journal
 * 绝不能被当作已持久化而继续提交 —— 否则多步 rename 之间崩溃将无法收敛，
 * 而损坏的 journal 又会在「成功」后被清掉，等于把不可恢复的中间态伪装成成功。
 */
const JOURNAL_REQUIRED_FIELDS = ['candidate', 'target', 'rollback', 'forward'] as const

function journalFileSuffixOf(file: string): string | null {
  return file.endsWith('.restore-journal.json') ? '.restore-journal.json' : null
}

function readbackJournal(file: string, data: string): void {
  let raw: string
  let parsed: unknown
  try {
    raw = readFileSync(file, 'utf8')
  } catch (err) {
    throw new Error(`恢复日志（journal）读回失败：无法读回落盘内容（${(err as Error)?.message ?? String(err)}）`)
  }
  try {
    parsed = JSON.parse(raw)
  } catch (err) {
    throw new Error(`恢复日志（journal）读回失败：落盘内容不是合法 JSON（${(err as Error)?.message ?? String(err)}）`)
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('恢复日志（journal）读回失败：落盘内容不是 JSON 对象')
  }
  const obj = parsed as Record<string, unknown>
  if (obj.phase !== 'replacing' && obj.phase !== 'rolling-back') {
    throw new Error(`恢复日志（journal）读回失败：phase 字段非法（${String(obj.phase)}）`)
  }
  for (const field of JOURNAL_REQUIRED_FIELDS) {
    if (typeof obj[field] !== 'string' || obj[field] === '') {
      throw new Error(`恢复日志（journal）读回失败：字段 ${field} 缺失或类型错误`)
    }
  }
  // 深比较：字段齐全但内容与预期不一致（例如被换成别的 JSON）同样不可信。
  let expected: unknown
  try {
    expected = JSON.parse(data)
  } catch (err) {
    throw new Error(`恢复日志（journal）读回失败：预期内容不是合法 JSON（${(err as Error)?.message ?? String(err)}）`)
  }
  if (!isDeepStrictEqual(parsed, expected)) {
    throw new Error('恢复日志（journal）读回失败：落盘内容与预期不一致')
  }
}

function defaultAtomicWriteJson(file: string, data: string): void {
  // 四阶段经 restoreFileOps 路由，测试可注入 write/fsync/rename/dir-fsync 各阶段；
  // 目录 fsync 为尽力而为：失败不翻转恢复结论（rename 原子性不受影响）。
  const dir = dirname(file)
  const tmp = `${file}.tmp-${process.pid}-${Date.now()}`
  try {
    restoreFileOps.writeFileSync(tmp, data)
    restoreFileOps.fsyncFile(tmp)
    restoreFileOps.renameSync(tmp, file)
  } catch (err) {
    try {
      restoreFileOps.rmSync(tmp, { force: true })
    } catch {
      // tmp 残留由下次恢复覆盖；不得掩盖原始错误
    }
    throw err
  }
  // 读回确认发生在任何 rename/move target 之前：journal 不可信 → 直接中止，当前库未动。
  try {
    readbackJournal(file, data)
  } catch (err) {
    // 已落盘的正式 journal 内容不可信：尽力安全删除；删不掉则保留并记残留，
    // 绝不覆盖读回失败的原始错误。
    try {
      restoreFileOps.rmSync(file, { force: true })
    } catch (cleanupErr) {
      const suffix = journalFileSuffixOf(file)
      if (suffix) recordResidue(file.slice(0, -suffix.length), file, cleanupErr)
    }
    throw err
  }
  try {
    restoreFileOps.fsyncDir(dir)
  } catch {
    // 尽力而为，不翻转结论
  }
}

const defaultRestoreFileOps: RestoreFileOps = {
  rmSync: (p, o) => fsRmSync(p, o as { force?: boolean }),
  renameSync: (a, b) => fsRenameSync(a, b),
  copyFileSync: (s, d) => fsCopyFileSync(s, d),
  writeFileSync: (f, d) => fsWriteFileSync(f, d),
  fsyncFile: defaultFsyncFile,
  fsyncDir: defaultFsyncDir,
  atomicWriteJson: defaultAtomicWriteJson,
}

export const restoreFileOps: RestoreFileOps = { ...defaultRestoreFileOps }

/** 测试专用：注入部分 fs 失败（例如 EBUSY）。生产代码永不调用。 */
export function __setRestoreFileOps(patch: Partial<RestoreFileOps>): void {
  Object.assign(restoreFileOps, patch)
}

/** 测试专用：恢复直通实现。生产代码永不调用。 */
export function __resetRestoreFileOps(): void {
  Object.assign(restoreFileOps, defaultRestoreFileOps)
}

const SIDECARS = ['', '-wal', '-shm'] as const
const journalFileOf = (targetDbFile: string): string => `${targetDbFile}.restore-journal.json`
const rollbackFileOf = (targetDbFile: string): string => `${targetDbFile}.restore-rollback`
const residuesFileOf = (targetDbFile: string): string => `${targetDbFile}.restore-residues.json`

/** 测试专用崩溃注入点：模拟多步替换中指定阶段进程死亡。生产永不传参。 */
export type RestoreCrashStage = 'after-move-current' | 'after-commit' | 'after-restore' | 'after-refill'
export interface ReplaceOptions {
  crashAt?: RestoreCrashStage
}

export type RollbackCrashStage = 'after-move-current' | 'after-restore' | 'after-refill'
export interface RollbackOptions {
  crashAt?: RollbackCrashStage
}

interface RestoreJournal {
  phase: 'replacing' | 'rolling-back'
  candidate: string
  target: string
  rollback: string
  forward: string
  createdAt: string
  pid: number
}

export function validateLedgerDatabase(db: Database, label: string): void {
  let integrity: unknown[]
  try {
    integrity = db.pragma('integrity_check') as unknown[]
  } catch {
    throw new Error(`${label}未通过 SQLite 完整性检查`)
  }
  if (!Array.isArray(integrity) || integrity.length !== 1 || String(Object.values(integrity[0] ?? {})[0]) !== 'ok') {
    throw new Error(`${label}未通过 SQLite 完整性检查`)
  }
  const contract = getProductionSchemaContract()
  const expected = new Set(contract.tables)
  const actualDetail = readTableContracts(db)
  const tables = new Set(Object.keys(actualDetail))
  const missing = [...expected].filter((name) => !tables.has(name))
  if (missing.length > 0) throw new Error(`${label}缺少预期账务表：${missing.join('、')}`)
  for (const table of expected) {
    const actualCols = new Set((actualDetail[table]?.columns ?? []).map((c) => c.name))
    // 生产契约是 schema.sql + 迁移后的完整列集合；同名表少一列也不能通过。
    const missingCols = (contract.columns[table] ?? []).filter((c) => !actualCols.has(c))
    if (missingCols.length > 0) {
      throw new Error(`${label}表 ${table} 缺少生产契约列（结构不符）：${missingCols.join('、')}`)
    }
    const expectedTable = contract.detail.tables[table]
    const actualTable = actualDetail[table]
    if (!expectedTable || !actualTable) continue
    // 1) 列级元组漂移：仅比列名会放过 NOT NULL / DEFAULT / 主键 / 类型被改写。
    for (const want of expectedTable.columns) {
      const got = actualTable.columns.find((c) => c.name === want.name)
      if (!got) continue
      if (
        got.type !== want.type ||
        got.notnull !== want.notnull ||
        got.pk !== want.pk ||
        (got.dflt ?? null) !== (want.dflt ?? null)
      ) {
        throw new Error(
          `${label}表 ${table} 列 ${want.name} 定义与生产契约不符：` +
            `期望 type=${want.type} notnull=${want.notnull} default=${want.dflt ?? 'NULL'} pk=${want.pk}，` +
            `实际 type=${got.type} notnull=${got.notnull} default=${got.dflt ?? 'NULL'} pk=${got.pk}`,
        )
      }
    }
    // 2) AUTOINCREMENT 漂移：删掉它 sqlite_sequence 高水位复制语义即失效。
    if (actualTable.autoincrement !== expectedTable.autoincrement) {
      throw new Error(
        `${label}表 ${table} 的 AUTOINCREMENT 与生产契约不符：期望 ${expectedTable.autoincrement}，实际 ${actualTable.autoincrement}`,
      )
    }
    // 3) 表结构文本漂移：CHECK / UNIQUE / 表级约束都只在这段文本里。
    if (actualTable.sql !== expectedTable.sql) {
      throw new Error(`${label}表 ${table} 的表结构定义与生产契约不符（CHECK/约束/默认值漂移）`)
    }
  }
  // 4) 索引 / 视图 / 触发器：名 + 归一化 DDL 逐项比对（生产有、候选缺即拒）。
  //    多余对象暂不拒绝（生产库可能含历史遗留），保持最小改动。
  for (const [type, expectedObjects, cn] of [
    ['index', contract.indexes, '索引'],
    ['view', contract.views, '视图'],
    ['trigger', contract.triggers, '触发器'],
  ] as const) {
    const actualObjects = readSchemaObjects(db, type)
    const missingNames = Object.keys(expectedObjects).filter((name) => !(name in actualObjects))
    if (missingNames.length > 0) {
      throw new Error(`${label}缺少生产契约${cn}：${missingNames.join('、')}`)
    }
    for (const [name, wantSql] of Object.entries(expectedObjects)) {
      const gotSql = actualObjects[name]
      if (gotSql !== wantSql) {
        throw new Error(`${label}${cn} ${name} 的定义与生产契约不符（索引/视图/触发器漂移）`)
      }
    }
  }
  const fkErrors = db.pragma('foreign_key_check') as unknown[]
  if (fkErrors.length > 0) throw new Error(`${label}未通过外键一致性检查`)
}

/** 统一恢复工件白名单：journal/candidate/rollback/forward/target 必须同目录；
 * 拒绝越界、绝对路径逃逸、符号链接。
 * candidate 仅允许目标同目录的恢复候选：`*.restore-candidate-*`（含 sidecar），
 * 不接受任意 `*.db` / `*.plain`，避免把普通备份文件误当恢复工件。 */
export function assertRestoreArtifact(targetDbFile: string, artifactPath: string, kind: string): void {
  const dir = resolve(dirname(targetDbFile))
  const full = resolve(dir, artifactPath)
  if (isAbsolute(artifactPath) ? full !== join(dir, basename(artifactPath)) : dirname(full) !== dir) {
    throw new Error(`${kind}路径越界（必须与目标同目录）：${artifactPath}`)
  }
  const base = basename(full)
  const targetBase = basename(targetDbFile)
  const allowed =
    base === targetBase ||
    base === `${targetBase}.restore-rollback` ||
    base === `${targetBase}.restore-forward` ||
    base === `${targetBase}.restore-journal.json` ||
    base === `${targetBase}.restore-residues.json` ||
    base.startsWith(`${targetBase}.restore-candidate-`)
  if (!allowed) throw new Error(`${kind}不在恢复工件白名单：${artifactPath}`)
  const artifactBase = base.replace(/-(?:wal|shm)$/i, '')
  if (artifactBase !== base && !artifactBase.startsWith(`${targetBase}.restore-candidate-`)) {
    throw new Error(`${kind}sidecar 不在恢复工件白名单：${artifactPath}`)
  }
  try {
    if (existsSync(full) && lstatSync(full).isSymbolicLink()) {
      throw new Error(`${kind}为符号链接，拒绝恢复：${artifactPath}`)
    }
    if (existsSync(full) && dirname(realpathSync(full)) !== dir) {
      throw new Error(`${kind}路径越界（解析后不在目标目录）：${artifactPath}`)
    }
  } catch (err) {
    throw err instanceof Error ? err : new Error(String(err))
  }
}

function slotHasAnyFile(path: string): boolean {
  return SIDECARS.some((suffix) => existsSync(`${path}${suffix}`))
}

function slotHasSidecarWithoutMain(path: string): boolean {
  return !existsSync(path) && SIDECARS.slice(1).some((suffix) => existsSync(`${path}${suffix}`))
}

function isUsableSlot(path: string): boolean {
  return existsSync(path) && !slotHasSidecarWithoutMain(path)
}

function isRestoreConverged(targetDbFile: string, journal: RestoreJournal): boolean {
  const targetUsable = isUsableSlot(targetDbFile)
  const rollbackUsable = isUsableSlot(journal.rollback)
  const forwardEmpty = !slotHasAnyFile(journal.forward)
  const candidateEmpty = !slotHasAnyFile(journal.candidate)

  if (journal.phase === 'rolling-back') {
    // 回滚完成态必须是：target=旧库、rollback=新库、forward/candidate 均清空。
    // 不能只检查主文件；残留 sidecar 也代表尚未收敛。
    return targetUsable && rollbackUsable && forwardEmpty && candidateEmpty
  }
  // 正向替换：candidate 是临时输入，可由启动恢复删除；forward 或任何 sidecar 残留都不能算成功。
  if (!targetUsable || !forwardEmpty) return false
  return rollbackUsable || !slotHasAnyFile(journal.rollback)
}

/**
 * 启动守卫：列出**尚未收敛**的恢复工件（只列真正阻断启动的）。
 *
 * 口径完全复用上面的槽位判定（slotHasAnyFile / isUsableSlot），不另写一套语义：
 *  - 目标缺失（不是可用槽）时，目录里任何 `*.restore-*` 都代表「不能新建空账本」→ 全部阻断；
 *  - 目标可用时，只有 journal / forward / candidate 三类未完成工件才阻断；
 *  - `.restore-rollback` 是 replaceWithRollback / rollbackRestore **按设计保留**的回滚能力
 *    （isRestoreConverged 也认它是收敛后的正常态），不得当作未完成工件；
 *  - `.restore-residues.json` 是清理失败记录（不是未完成工件），不阻断启动。
 */
export function listPendingRestoreArtifacts(targetDbFile: string): string[] {
  const dir = dirname(targetDbFile)
  const base = basename(targetDbFile)
  const artifacts = existsSync(dir)
    ? readdirSync(dir).filter((name) => name.startsWith(`${base}.restore-`))
    : []
  if (artifacts.length === 0) return []
  // 目标缺失：任何恢复工件都不得被当成「首次启动」（与既有 B1/R6 行为一致，保持保守）。
  if (!isUsableSlot(targetDbFile)) return artifacts

  const residues = residuesFileOf(targetDbFile)
  const forward = `${targetDbFile}.restore-forward`
  const pending = artifacts.filter((name) => {
    // 残留清单：记录，不是未完成工件。
    if (name === residues || name === basename(residues)) return false
    // 回滚槽（主文件或 sidecar）：按设计保留的能力，不是未完成工件。
    if (name === basename(rollbackFileOf(targetDbFile)) || name.startsWith(`${basename(rollbackFileOf(targetDbFile))}-`)) {
      return false
    }
    // 其余（journal / journal 临时文件 / forward / candidate）都必须先收敛。
    // forward 与 candidate 用同一套槽位判定（含各自 sidecar），不留孤儿 sidecar 蒙混过关。
    if (name === basename(forward) || name.startsWith(`${basename(forward)}-`)) return true
    if (name.startsWith(`${base}.restore-candidate-`) || name.startsWith(`${base}.restore-journal`)) return true
    // 未知工件名：保守阻断。
    return true
  })
  return pending
}

/** 只读探针：验证文件能用给定 DEK 解密打开（不改任何 PRAGMA，不写库）。 */
function probeLedger(file: string, dekHex: string, label: string): void {
  const db = new DatabaseCtor(file)
  try {
    db.pragma(`key = "x'${dekHex}'"`)
    db.pragma(`cipher='${CIPHER}'`)
    db.prepare('SELECT count(*) AS n FROM sqlite_master').get()
  } catch (err) {
    throw new Error(`${label}无法解密或已损坏：${(err as Error).message}`)
  } finally {
    db.close()
  }
}

/** 清理失败只留可追踪残留：记入 .restore-residues.json；自身永不抛（不得把成功误报为失败）。 */
function recordResidue(targetDbFile: string, leftoverPath: string, err: unknown): void {
  const manifest = residuesFileOf(targetDbFile)
  const entry = {
    path: leftoverPath,
    reason: (err as Error)?.message ?? String(err),
    at: new Date().toISOString(),
  }
  try {
    let list: unknown[] = []
    if (existsSync(manifest)) {
      try {
        const parsed: unknown = JSON.parse(readFileSync(manifest, 'utf8'))
        if (Array.isArray(parsed)) list = parsed
      } catch {
        list = []
      }
    }
    list.push(entry)
    restoreFileOps.writeFileSync(manifest, JSON.stringify(list, null, 2))
  } catch {
    // 清单写失败也不得影响恢复结果判定
  }
}

/**
 * 原子替换：先写恢复日志（journal），再把当前库及 sidecar 移入回滚槽，最后候选落位。
 * - 替换前 journal 已持久化：多步 rename 之间崩溃，重启可凭 journal 恢复原库或候选；
 * - 唯一回滚槽 `.restore-rollback`：清空旧槽失败则直接中止（当前库未动），绝不带病覆盖；
 * - 成功后清 journal；journal 清理失败只记残留，不翻转成功结论。
 */
export function replaceWithRollback(candidateDbFile: string, targetDbFile: string, opts?: ReplaceOptions): void {
  mkdirSync(dirname(targetDbFile), { recursive: true })
  const rollback = rollbackFileOf(targetDbFile)
  const journalFile = journalFileOf(targetDbFile)
  // B6：候选必须经统一工件白名单（同目录、规定 basename/后缀；拒绝越界、符号链接）
  assertRestoreArtifact(targetDbFile, candidateDbFile, '恢复候选')
  if (existsSync(journalFile)) {
    throw new Error('存在未完成的账本恢复（.restore-journal.json），请先完成 recoverInterruptedRestore 再替换')
  }
  try {
    for (const suffix of SIDECARS) {
      const file = `${rollback}${suffix}`
      if (existsSync(file)) restoreFileOps.rmSync(file, { force: true })
    }
  } catch (err) {
    throw new Error(`清空旧回滚槽失败（${(err as Error)?.message ?? String(err)}），已中止替换：当前库未动`)
  }
  const journal: RestoreJournal = {
    phase: 'replacing',
    candidate: candidateDbFile,
    target: targetDbFile,
    rollback,
    forward: `${targetDbFile}.restore-forward`,
    createdAt: new Date().toISOString(),
    pid: process.pid,
  }
  // B6：同目录临时文件 → 写完 → 文件 fsync → 原子 rename → 尽力 fsync 父目录（可注入四阶段）
  restoreFileOps.atomicWriteJson(journalFile, JSON.stringify(journal))
  try {
    // 先把当前库及其 sidecar 移到回滚槽；候选验证通过后才落目标名。
    for (const suffix of SIDECARS) {
      const current = `${targetDbFile}${suffix}`
      if (existsSync(current)) restoreFileOps.renameSync(current, `${rollback}${suffix}`)
    }
    if (opts?.crashAt === 'after-move-current') throw new Error('SIMULATED-CRASH(after-move-current)：仅测试注入')
    restoreFileOps.renameSync(candidateDbFile, targetDbFile)
    if (opts?.crashAt === 'after-commit') throw new Error('SIMULATED-CRASH(after-commit)：仅测试注入')
  } catch (err) {
    if ((err as Error)?.message?.startsWith('SIMULATED-CRASH')) throw err
    // B6 违规要求：正向替换异常时先尝试内部恢复；只要内部恢复 rename 也失败
    // （target 仍缺失、无法确认收敛），就绝不能删 journal，必须保留供下次启动收敛。
    let converged = existsSync(targetDbFile)
    // 任何一步失败都尽量把当前库放回；回滚槽本身仍保留供人工兜底。
    for (const suffix of SIDECARS) {
      const backup = `${rollback}${suffix}`
      const current = `${targetDbFile}${suffix}`
      if (existsSync(backup) && !existsSync(current)) {
        try {
          restoreFileOps.renameSync(backup, current)
        } catch {
          // 保持回滚槽，不能因回滚失败而覆盖原始异常。
          converged = false
        }
      }
    }
    if (!existsSync(targetDbFile)) converged = false
    if (isRestoreConverged(targetDbFile, journal)) {
      try {
        restoreFileOps.rmSync(journalFile, { force: true })
      } catch {
        // journal 保留供人工核对
      }
    }
    // 未收敛：journal 必须保留（绝不删除），下次 recoverInterruptedRestore 收敛。
    throw err
  }
  try {
    restoreFileOps.rmSync(journalFile, { force: true })
  } catch (err) {
    recordResidue(targetDbFile, journalFile, err)
  }
}

export type InterruptedRestoreOutcome = 'no-op' | 'recovered-original' | 'recovered-candidate' | 'recovered-rollback'

/**
 * 启动恢复：必须在 openLedger 之前调用。
 * - journal 存在且目标缺失 → 把回滚槽移回目标（恢复原库）；
 * - journal 存在且目标已落位 → 探针确认目标可解密打开，保留候选结果；
 * - 无 journal 但目标缺失、回滚槽仍在 → 拒绝（绝不新建空账本），抛错由调用方拒启；
 * - 无 journal 且状态一致 → 'no-op'。
 */
export function recoverInterruptedRestore(
  targetDbFile: string,
  opts?: { dekHex?: string },
): InterruptedRestoreOutcome {
  const journalFile = journalFileOf(targetDbFile)
  const rollback = rollbackFileOf(targetDbFile)
  let journal: RestoreJournal | null = null
  if (existsSync(journalFile)) {
    try {
      journal = JSON.parse(readFileSync(journalFile, 'utf8')) as RestoreJournal
    } catch {
      journal = null
    }
    if (!journal || (journal.phase !== 'replacing' && journal.phase !== 'rolling-back') || journal.target !== targetDbFile) {
      throw new Error('恢复日志损坏或与目标不匹配，拒绝自动恢复（请人工核对 .restore-rollback 后再启动）')
    }
  }
  // B6：journal 内的全部工件路径必须经统一白名单校验
  if (journal) {
    assertRestoreArtifact(targetDbFile, journal.candidate, '恢复日志候选')
    assertRestoreArtifact(targetDbFile, journal.rollback, '恢复日志回滚槽')
    assertRestoreArtifact(targetDbFile, journal.forward, '恢复日志前向槽')
  }
  const targetExists = existsSync(targetDbFile)
  if (!journal) {
    if (!targetExists && (existsSync(rollback) || existsSync(`${rollback}-wal`) || existsSync(`${rollback}-shm`))) {
      throw new Error('检测到未完成的账本恢复：目标库缺失但回滚副本仍在，拒绝新建空账本（请先完成恢复）')
    }
    return 'no-op'
  }
  // B5/B6：rollback 与正向恢复共用同一 journal；按 phase 分流收敛。
  // 只有确认 target/forward/rollback 已收敛并验证后，才能清 journal；
  // 清 journal 失败记残留但不改恢复结论。
  if (journal.phase === 'rolling-back') {
    return recoverInterruptedRollback(targetDbFile, journal, opts)
  }
  const dropCandidate = (): void => {
    if (journal.candidate && slotHasAnyFile(journal.candidate)) {
      for (const suffix of SIDECARS) {
        const path = `${journal.candidate}${suffix}`
        if (!existsSync(path)) continue
        try {
          restoreFileOps.rmSync(path, { force: true })
        } catch (err) {
          recordResidue(targetDbFile, path, err)
        }
      }
    }
  }
  // 任何未收敛的 forward/candidate/sidecar 组合都不得被当成 targetExists 即成功；
  // 先让启动恢复按 phase 继续搬回/清理，确认状态收敛后才允许删 journal。
  if (targetExists) {
    if (opts?.dekHex) {
      probeLedger(targetDbFile, opts.dekHex, '中断恢复后的账本')
      const probe = new DatabaseCtor(targetDbFile)
      try {
        probe.pragma(`key = "x'${opts.dekHex}'"`)
        probe.pragma(`cipher='${CIPHER}'`)
        validateLedgerDatabase(probe, '中断恢复后的账本')
      } finally {
        probe.close()
      }
    }
    // 正常正向恢复：candidate 是临时输入，可清理；forward/rollback 状态必须先收敛。
    dropCandidate()
    if (!isRestoreConverged(targetDbFile, journal)) {
      // 不能猜测 forward 的归属，也不能删除仍可能承载恢复材料的槽位；保留 journal。
      throw new Error('账本恢复尚未收敛（forward/rollback/sidecar 状态异常），journal 已保留，请重试或人工介入')
    }
    try {
      restoreFileOps.rmSync(journalFile, { force: true })
    } catch (err) {
      recordResidue(targetDbFile, journalFile, err)
    }
    return 'recovered-candidate'
  }
  if (!existsSync(rollback)) {
    throw new Error('恢复中断且回滚副本缺失，无法自动恢复（请人工介入；拒绝新建空账本）')
  }
  for (const suffix of SIDECARS) {
    const backup = `${rollback}${suffix}`
    const current = `${targetDbFile}${suffix}`
    if (existsSync(backup) && !existsSync(current)) restoreFileOps.renameSync(backup, current)
  }
  if (opts?.dekHex) {
    probeLedger(targetDbFile, opts.dekHex, '回滚恢复后的账本')
    const probe = new DatabaseCtor(targetDbFile)
    try {
      probe.pragma(`key = "x'${opts.dekHex}'"`)
      probe.pragma(`cipher='${CIPHER}'`)
      validateLedgerDatabase(probe, '回滚恢复后的账本')
    } finally {
      probe.close()
    }
  }
  dropCandidate()
  try {
    restoreFileOps.rmSync(journalFile, { force: true })
  } catch (err) {
    recordResidue(targetDbFile, journalFile, err)
  }
  return 'recovered-original'
}

/** rolling-back phase 的收敛：target 缺失时把 forward/rollback 归位，保证三槽收敛。 */
function recoverInterruptedRollback(
  targetDbFile: string,
  journal: RestoreJournal,
  opts?: { dekHex?: string },
): InterruptedRestoreOutcome {
  const journalFile = journalFileOf(targetDbFile)
  const rollback = rollbackFileOf(targetDbFile)
  const forward = `${targetDbFile}.restore-forward`
  // 三槽收敛（rolling-back 语义：目标应为 OLD）：
  //  - after-move-current 崩溃：target 缺失，forward=NEW 前端内容，rollback=OLD；应把 rollback 归位到 target（目标回到 OLD），forward 换回 rollback；
  //  - after-restore 崩溃：target=OLD 已归位，rollback 空，forward=NEW；应把 forward 换回 rollback（三槽回到回滚完成态）；
  //  - after-refill 崩溃：target=OLD，rollback=NEW，forward 空；已收敛，只需验证清 journal。
  // 统一规则：target 缺失 → 用 rollback 补回（rollback 才是 OLD）；target 已存在 → 把 forward（如有）换回 rollback。
  for (const suffix of SIDECARS) {
    const current = `${targetDbFile}${suffix}`
    const fwd = `${forward}${suffix}`
    const back = `${rollback}${suffix}`
    if (!existsSync(current) && existsSync(back)) {
      try {
        restoreFileOps.renameSync(back, current)
      } catch {
        // 保持现场，下次再收敛；journal 绝不删
        throw new Error('回滚中断恢复失败（回滚槽归位失败），journal 已保留，请重试或人工介入')
      }
    }
  }
  for (const suffix of SIDECARS) {
    const fwd = `${forward}${suffix}`
    const back = `${rollback}${suffix}`
    if (existsSync(fwd) && !existsSync(back)) {
      try {
        restoreFileOps.renameSync(fwd, back)
      } catch {
        throw new Error('回滚中断恢复失败（前向槽归位失败），journal 已保留，请重试或人工介入')
      }
    }
  }
  if (!existsSync(targetDbFile) && !existsSync(rollback)) {
    throw new Error('恢复中断且回滚副本缺失，无法自动恢复（请人工介入；拒绝新建空账本）')
  }
  if (existsSync(targetDbFile) && !existsSync(rollback) && !existsSync(forward)) {
    throw new Error('回滚恢复状态未收敛（目标存在但回滚/前向槽均缺失），journal 已保留，请重试或人工介入')
  }
  if (opts?.dekHex) {
    probeLedger(targetDbFile, opts.dekHex, '回滚中断恢复后的账本')
    const probe = new DatabaseCtor(targetDbFile)
    try {
      probe.pragma(`key = "x'${opts.dekHex}'"`)
      probe.pragma(`cipher='${CIPHER}'`)
      validateLedgerDatabase(probe, '回滚中断恢复后的账本')
    } finally {
      probe.close()
    }
  }
  // forward 残留（已收敛后多余的前向槽）尽力清理，失败只记残留。
  for (const suffix of SIDECARS) {
    const fwd = `${forward}${suffix}`
    if (existsSync(fwd)) {
      try {
        restoreFileOps.rmSync(fwd, { force: true })
      } catch (err) {
        recordResidue(targetDbFile, fwd, err)
      }
    }
  }
  if (journal.candidate && existsSync(journal.candidate)) {
    try {
      restoreFileOps.rmSync(journal.candidate, { force: true })
    } catch (err) {
      recordResidue(targetDbFile, journal.candidate, err)
    }
  }
  try {
    restoreFileOps.rmSync(journalFile, { force: true })
  } catch (err) {
    recordResidue(targetDbFile, journalFile, err)
  }
  return 'recovered-rollback'
}

/** 回滚副本预检（关闭当前连接前可做）：副本存在、可用 DEK 解密、通过当前 schema 验证。 */
export function validateRollbackCandidate(targetDbFile: string, dekHex: string): void {
  const rollback = rollbackFileOf(targetDbFile)
  if (!existsSync(rollback)) throw new Error('没有可用的恢复回滚副本（.restore-rollback 不存在），拒绝回滚')
  const probe = new DatabaseCtor(rollback)
  try {
    probe.pragma(`key = "x'${dekHex}'"`)
    probe.pragma(`cipher='${CIPHER}'`)
    validateLedgerDatabase(probe, '回滚副本')
  } finally {
    probe.close()
  }
}

/**
 * 真实回滚往返：当前库 ↔ 回滚槽交换（B5：走同一 journal，三阶段可收敛）。
 * - 关闭前调用方应先 validateRollbackCandidate（IPC 经 gate 的 validate 步）；
 * - 写入与正向恢复同一 journal（phase rolling-back），崩溃后 recoverInterruptedRestore 收敛；
 * - 成功后验证 target，确认收敛才清 journal；清失败记残留不改结论。
 * 交换对称，重复调用安全弹回。
 */
export function rollbackRestore(targetDbFile: string, dekHex: string, opts?: RollbackOptions): void {
  validateRollbackCandidate(targetDbFile, dekHex)
  const rollback = rollbackFileOf(targetDbFile)
  const forward = `${targetDbFile}.restore-forward`
  const journalFile = journalFileOf(targetDbFile)
  if (existsSync(journalFile)) {
    throw new Error('存在未完成的账本恢复（.restore-journal.json），请先完成 recoverInterruptedRestore 再回滚')
  }
  const journal: RestoreJournal = {
    phase: 'rolling-back',
    candidate: `${targetDbFile}.restore-candidate-rollback`,
    target: targetDbFile,
    rollback,
    forward,
    createdAt: new Date().toISOString(),
    pid: process.pid,
  }
  restoreFileOps.atomicWriteJson(journalFile, JSON.stringify(journal))
  for (const suffix of SIDECARS) {
    const f = `${forward}${suffix}`
    if (existsSync(f)) restoreFileOps.rmSync(f, { force: true })
  }
  try {
    for (const suffix of SIDECARS) {
      const current = `${targetDbFile}${suffix}`
      if (existsSync(current)) restoreFileOps.renameSync(current, `${forward}${suffix}`)
    }
    if (opts?.crashAt === 'after-move-current') throw new Error('SIMULATED-CRASH(after-move-current)：仅测试注入')
    for (const suffix of SIDECARS) {
      const backup = `${rollback}${suffix}`
      const current = `${targetDbFile}${suffix}`
      if (existsSync(backup)) restoreFileOps.renameSync(backup, current)
    }
    if (opts?.crashAt === 'after-restore') throw new Error('SIMULATED-CRASH(after-restore)：仅测试注入')
    for (const suffix of SIDECARS) {
      const fwd = `${forward}${suffix}`
      const back = `${rollback}${suffix}`
      if (existsSync(fwd)) restoreFileOps.renameSync(fwd, back)
    }
    if (opts?.crashAt === 'after-refill') throw new Error('SIMULATED-CRASH(after-refill)：仅测试注入')
  } catch (err) {
    if ((err as Error)?.message?.startsWith('SIMULATED-CRASH')) throw err
    // 非注入异常：尽力把 forward 补回 target；补不回则保留 journal（不删），抛原始异常。
    let converged = existsSync(targetDbFile)
    for (const suffix of SIDECARS) {
      const fwd = `${forward}${suffix}`
      const current = `${targetDbFile}${suffix}`
      if (existsSync(fwd) && !existsSync(current)) {
        try {
          restoreFileOps.renameSync(fwd, current)
        } catch {
          converged = false
        }
      }
    }
    if (!existsSync(targetDbFile)) converged = false
    if (converged && isRestoreConverged(targetDbFile, journal)) {
      try {
        restoreFileOps.rmSync(journalFile, { force: true })
      } catch {
        // 保留供人工核对
      }
    }
    throw err
  }
  // 交换后必须先按统一收敛判定检查：forward/candidate/主文件与 sidecar 全部到位，
  // 否则即使主库能打开，也不能删除 journal（留给下一次 recoverInterruptedRestore）。
  if (!isRestoreConverged(targetDbFile, journal)) {
    throw new Error('回滚交换尚未收敛（forward/candidate/sidecar 未归位），journal 已保留，请重试或人工介入')
  }
  probeLedger(targetDbFile, dekHex, '回滚后的账本')
  const probe = new DatabaseCtor(targetDbFile)
  try {
    probe.pragma(`key = "x'${dekHex}'"`)
    probe.pragma(`cipher='${CIPHER}'`)
    validateLedgerDatabase(probe, '回滚后的账本')
  } finally {
    probe.close()
  }
  try {
    restoreFileOps.rmSync(journalFile, { force: true })
  } catch (err) {
    recordResidue(targetDbFile, journalFile, err)
  }
}

/** B4：import 流程统一 plain 清理入口（decrypt 后各失败路径 + 成功路径 finally 调用）。
 * 自身永不抛；reencrypt 内部已删时重复调用安全。 */
export function cleanupImportPlain(plainFile: string): void {
  try {
    restoreFileOps.rmSync(plainFile, { force: true })
  } catch {
    // 启动清扫兜底；自身永不抛，不掩盖原始错误
  }
}

export function snapshot(db: Database, backupsDir: string): string {
  mkdirSync(backupsDir, { recursive: true })
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)
  let target = join(backupsDir, `mingzhang-snapshot-${stamp}.db`)
  let n = 1
  while (existsSync(target)) {
    target = join(backupsDir, `mingzhang-snapshot-${stamp}-${n}.db`)
    n += 1
  }
  db.exec(`VACUUM INTO '${target.replace(/'/g, "''")}'`)
  pruneSnapshots(backupsDir)
  return target
}

/** 启动检查：最近快照超过 24h（或没有）→ 自动补一份。 */
export function autoSnapshotIfNeeded(db: Database, backupsDir: string, now = new Date()): string | null {
  try {
    const snaps = listSnapshots(backupsDir)
    if (snaps.length > 0) {
      const newest = statSync(snaps[0].path)
      if (now.getTime() - newest.mtimeMs < SNAPSHOT_INTERVAL_MS) return null
    }
    return snapshot(db, backupsDir)
  } catch {
    return null // 备份失败不阻塞启动，如实记录在案（日志）
  }
}

export function listSnapshots(backupsDir: string): { path: string; name: string; size: number; mtime: number }[] {
  if (!existsSync(backupsDir)) return []
  return readdirSync(backupsDir)
    .filter((f) => /^mingzhang-snapshot-.*\.db$/.test(f))
    .map((f) => {
      const p = join(backupsDir, f)
      const st = statSync(p)
      return { path: p, name: f, size: st.size, mtime: st.mtimeMs }
    })
    .sort((a, b) => b.mtime - a.mtime)
}

function pruneSnapshots(backupsDir: string): void {
  const snaps = listSnapshots(backupsDir)
  for (const s of snaps.slice(SNAPSHOT_KEEP)) {
    try {
      unlinkSync(s.path)
    } catch {
      // 删不掉的下轮再清
    }
  }
}

async function deriveKey(passphrase: string, salt: Buffer): Promise<Buffer> {
  return Buffer.from(
    await argon2id({
      password: passphrase,
      salt,
      parallelism: 1,
      iterations: ARGON_ITERATIONS,
      memorySize: ARGON_MEMORY_KIB,
      hashLength: 32,
      outputType: 'binary',
    }),
  )
}

/** 通用整库复制：src → dst（两侧连接都已打开；dst 必须是新建空库）。
 *  先建表 → 搬数据 → 视图/索引 → sqlite_sequence 高水位 → user_version → 外键一致性检查。
 * 高水位：AUTOINCREMENT 表的下个 id 必须延续源库，不得退化为复制后最大 id；
 * 不存在/不相容的表不复制（以源库 sqlite_sequence × 目标表交集为准）。 */
function copyAll(src: Database, dst: Database): void {
  dst.pragma('foreign_keys = OFF')
  const master = src
    .prepare(
      "SELECT name, type, sql FROM sqlite_master WHERE sql IS NOT NULL AND name NOT LIKE 'sqlite_%' ORDER BY rowid",
    )
    .all() as { name: string; type: string; sql: string }[]
  for (const o of master.filter((o) => o.type === 'table')) dst.exec(o.sql)
  for (const o of master.filter((o) => o.type === 'table')) {
    const rows = src.prepare(`SELECT * FROM "${o.name.replace(/"/g, '""')}"`).all() as Record<string, unknown>[]
    if (rows.length === 0) continue
    const cols = Object.keys(rows[0])
    const collist = cols.map((c) => `"${c.replace(/"/g, '""')}"`).join(', ')
    const ph = cols.map(() => '?').join(', ')
    const ins = dst.prepare(`INSERT INTO "${o.name.replace(/"/g, '""')}" (${collist}) VALUES (${ph})`)
    const tx = dst.transaction((rs: Array<Record<string, unknown>>) => {
      for (const r of rs) ins.run(...cols.map((c) => r[c]))
    })
    tx(rows)
  }
  for (const o of master.filter((o) => o.type !== 'table')) dst.exec(o.sql)
  // sqlite_sequence 高水位：逐表恢复源库 seq（仅目标存在且为 AUTOINCREMENT 表）；
  // 不存在/不相容的表不复制。复制后 max(id) 更大时以实际为准（SQLite 语义）。
  try {
    const seqRows = src.prepare('SELECT name, seq FROM sqlite_sequence').all() as { name: string; seq: number }[]
    const dstTables = new Set(
      (dst.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as { name: string }[]).map((r) => r.name),
    )
    for (const row of seqRows) {
      if (!dstTables.has(row.name)) continue
      try {
        const hasSeq = (dst.prepare("SELECT COUNT(*) n FROM sqlite_master WHERE type = 'table' AND name = 'sqlite_sequence'").get() as { n: number }).n
        if (hasSeq === 0) continue
        dst.prepare('UPDATE sqlite_sequence SET seq = ? WHERE name = ?').run(row.seq, row.name)
        // 若目标表实际 max(id) 更大，SQLite 下次会自动推进；若 seq 表无该行但表有 AUTOINCREMENT，插入行补齐。
        const cur = (dst.prepare('SELECT seq FROM sqlite_sequence WHERE name = ?').get(row.name) as { seq: number } | undefined)?.seq
        if (cur === undefined) {
          dst.prepare('INSERT INTO sqlite_sequence (name, seq) VALUES (?, ?)').run(row.name, row.seq)
        } else if (cur < row.seq) {
          dst.prepare('UPDATE sqlite_sequence SET seq = ? WHERE name = ?').run(row.seq, row.name)
        }
      } catch {
        // 单表水位失败不翻转整库复制（外键检查仍兜底）；继续其余表
      }
    }
  } catch {
    // 源库无 sqlite_sequence（无 AUTOINCREMENT）：跳过
  }
  const uv = src.pragma('user_version', { simple: true }) as number
  dst.pragma(`user_version = ${uv}`)
  const fkErrors = dst.pragma('foreign_key_check') as unknown[]
  if (fkErrors.length > 0) throw new Error('复制后的数据未通过外键一致性检查')
  dst.pragma('foreign_keys = ON')
}

/** 导出跨机口令包：把加密库表级复制出一份明文临时库（保持一致点），再整文件 Argon2id+AES-256-GCM。 */
export async function exportPassphraseBackup(
  db: Database,
  backupsDir: string,
  passphrase: string,
  outFile: string,
): Promise<void> {
  mkdirSync(backupsDir, { recursive: true })
  const tmpPlain = join(backupsDir, `.export-${Date.now()}.plain`)
  let plaintext: Buffer
  try {
    const dst = new DatabaseCtor(tmpPlain)
    try {
      copyAll(db, dst)
    } finally {
      dst.close()
    }
    plaintext = readFileSync(tmpPlain)
  } finally {
    // 临时明文库无论成败都立即删除（导出失败路径不残留）
    try {
      rmSyncPlain(tmpPlain)
    } catch {
      // 下次启动还会清扫
    }
  }
  if (!plaintext.subarray(0, 15).toString('latin1').startsWith('SQLite format 3')) {
    throw new Error('内部错误：导出中间库不是有效的 SQLite 文件')
  }
  const salt = randomBytes(16)
  const nonce = randomBytes(12)
  const key = await deriveKey(passphrase, salt)
  const cipher = createCipheriv('aes-256-gcm', key, nonce)
  const encrypted = Buffer.concat([cipher.update(plaintext), cipher.final()])
  const tag = cipher.getAuthTag()
  const header = Buffer.alloc(8)
  header.write(BACKUP_MAGIC, 0, 'latin1')
  header.writeUInt32BE(BACKUP_VERSION, 4)
  fsWriteFileSync(outFile, Buffer.concat([header, salt, nonce, tag, encrypted]))
}

function rmSyncPlain(path: string): void {
  restoreFileOps.rmSync(path, { force: true })
}

/** 导入口令包（第一步）：解密到临时明文库，返回其路径。
 *  第二步必须用本机 DEK 重加密（reencryptPlainToEncrypted）——老机器 DEK 与本机不同。 */
export async function importPassphraseBackupToPlain(
  backupFile: string,
  passphrase: string,
  tmpPlainFile: string,
): Promise<void> {
  const blob = readFileSync(backupFile)
  if (blob.length < 8 + 16 + 12 + 16 || blob.subarray(0, 4).toString('latin1') !== BACKUP_MAGIC) {
    throw new Error('不是有效的明账备份包')
  }
  const version = blob.readUInt32BE(4)
  if (version !== BACKUP_VERSION) throw new Error(`备份包版本不支持（v${version}）`)
  let off = 8
  const salt = blob.subarray(off, off + 16); off += 16
  const nonce = blob.subarray(off, off + 12); off += 12
  const tag = blob.subarray(off, off + 16); off += 16
  const encrypted = blob.subarray(off)

  const key = await deriveKey(passphrase, salt)
  const decipher = createDecipheriv('aes-256-gcm', key, nonce)
  decipher.setAuthTag(tag)
  let plaintext: Buffer
  try {
    plaintext = Buffer.concat([decipher.update(encrypted), decipher.final()])
  } catch {
    throw new Error('口令错误或备份包已损坏（GCM 校验失败）')
  }
  if (!plaintext.subarray(0, 15).toString('latin1').startsWith('SQLite format 3')) {
    throw new Error('备份内容校验失败')
  }
  fsWriteFileSync(tmpPlainFile, plaintext)
}

/** 候选迁移：v1 旧库先升级到当前 schema；迁移失败按结构不符拒绝（不得替换当前库）。 */
function migrateCandidate(db: Database, label: string): void {
  try {
    runMigrations(db)
  } catch (err) {
    throw new Error(`${label}迁移失败（结构不符，拒绝恢复）：${(err as Error)?.message ?? String(err)}`)
  }
}

/**
 * 口令包明文候选预检（关闭当前连接前可做）：
 * 在自有临时明文上先跑迁移再验证；失败直接抛，当前库未动、连接未关。
 */
export function validatePlainCandidate(plainFile: string): void {
  const db = new DatabaseCtor(plainFile)
  try {
    migrateCandidate(db, '恢复候选')
    validateLedgerDatabase(db, '恢复候选')
  } finally {
    db.close()
  }
}

/**
 * 快照候选预检（关闭当前连接前可做）：
 * 把快照拷到系统临时目录做 staging，先跑迁移再按当前 schema 验证；
 * backups/ 原文件只读，当前库未动、连接未关。
 */
export function validateSnapshotCandidate(backupsDir: string, snapshotName: string, dekHex: string): void {
  const src = assertSnapshotPath(backupsDir, snapshotName)
  const stagingDir = mkdtempSync(join(tmpdir(), 'mz-restore-validate-'))
  const staging = join(stagingDir, 'candidate.db')
  try {
    fsCopyFileSync(src, staging)
    const db = new DatabaseCtor(staging)
    try {
      db.pragma(`key = "x'${dekHex}'"`)
      db.pragma(`cipher='${CIPHER}'`)
      migrateCandidate(db, '恢复候选')
      validateLedgerDatabase(db, '恢复候选')
    } finally {
      db.close()
    }
  } finally {
    fsRmSync(stagingDir, { recursive: true, force: true })
  }
}

/**
 * 第二步：把明文库复制进本机 DEK 加密的新库。
 * - 明文先原地迁移（v1 旧包升级）再验证，失败不碰当前库；
 * - 提交成功后 plain 清理遇 EBUSY/Windows 锁：只记可追踪残留，不得把成功误报为失败，
 *   更不得覆盖或破坏唯一 .restore-rollback 槽。
 */
export function reencryptPlainToEncrypted(plainFile: string, targetDbFile: string, dekHex: string): void {
  let src: Database | null = null
  const staging = `${targetDbFile}.restore-candidate-${process.pid}-${Date.now()}`
  let committed = false
  try {
    src = new DatabaseCtor(plainFile)
    src.pragma('foreign_keys = OFF')
    // Windows 下 SQLite 可能仍持有刚关闭的明文句柄：先 checkpoint 再验证，避免残留锁导致后继打开失败。
    try {
      src.pragma('wal_checkpoint(TRUNCATE)')
    } catch {
      // 非 WAL 库无 checkpoint 语义，忽略
    }
    migrateCandidate(src, '恢复候选')
    validateLedgerDatabase(src, '恢复候选')
    for (const suffix of SIDECARS) {
      const f = `${staging}${suffix}`
      if (existsSync(f)) restoreFileOps.rmSync(f, { force: true })
    }
    const dst = new DatabaseCtor(staging)
    try {
      dst.pragma(`key = "x'${dekHex}'"`)
      dst.pragma(`cipher='${CIPHER}'`)
      dst.pragma('journal_mode = WAL')
      copyAll(src, dst)
      validateLedgerDatabase(dst, '重加密候选')
      dst.pragma('wal_checkpoint(TRUNCATE)')
    } finally {
      dst.close()
    }
    replaceWithRollback(staging, targetDbFile)
    committed = true
  } catch (err) {
    if (!committed) {
      for (const suffix of SIDECARS) {
        const f = `${staging}${suffix}`
        if (existsSync(f)) {
          try {
            restoreFileOps.rmSync(f, { force: true })
          } catch {
            // staging 残留由下次恢复的预清理覆盖
          }
        }
      }
    }
    throw err
  } finally {
    src?.close()
    // plain 清理必须在源连接关闭之后：Windows 下未关闭的 SQLite 句柄会让 unlink 报 EBUSY。
    // 提交已成功时清理失败只记可追踪残留，不得把成功误报为失败；
    // 未提交时清理失败由启动清扫兜底，且不得掩盖原始错误。
    try {
      restoreFileOps.rmSync(plainFile, { force: true })
    } catch (err) {
      if (committed) recordResidue(targetDbFile, plainFile, err)
    }
  }
}

function assertSnapshotPath(backupsDir: string, snapshotName: string): string {
  if (
    !/^mingzhang-snapshot-[A-Za-z0-9-]+\.db$/.test(snapshotName) ||
    basename(snapshotName) !== snapshotName ||
    isAbsoluteName(snapshotName)
  ) {
    throw new Error('快照文件名不合法')
  }
  const src = join(backupsDir, snapshotName)
  if (!existsSync(src)) throw new Error('快照不存在')
  const st = lstatSync(src)
  if (!st.isFile() || st.isSymbolicLink()) throw new Error('快照不是普通文件')
  const root = resolve(backupsDir)
  const full = resolve(src)
  if (dirname(full) !== root || realpathSync(full) !== realpathSync(root) + sep + snapshotName) {
    throw new Error('快照路径越界')
  }
  return src
}

/**
 * 本机快照恢复（同 DEK）：候选复制到 staging 后先运行迁移，再按当前 schema 验证；
 * 迁移或验证失败不得替换当前库。换文件后由调用方重启应用。
 */
export function restoreSnapshot(backupsDir: string, snapshotName: string, targetDbFile: string, dekHex: string): void {
  const src = assertSnapshotPath(backupsDir, snapshotName)
  const candidate = `${targetDbFile}.restore-candidate-${process.pid}-${Date.now()}`
  try {
    restoreFileOps.copyFileSync(src, candidate)
    const db = new DatabaseCtor(candidate)
    try {
      db.pragma(`key = "x'${dekHex}'"`)
      db.pragma(`cipher='${CIPHER}'`)
      migrateCandidate(db, '恢复候选')
      validateLedgerDatabase(db, '快照候选')
    } finally {
      db.close()
    }
    replaceWithRollback(candidate, targetDbFile)
  } catch (err) {
    try {
      restoreFileOps.rmSync(candidate, { force: true })
    } catch {
      // staging 残留由下次恢复的预清理覆盖；不得掩盖原始错误
    }
    throw err
  }
}

function isAbsoluteName(name: string): boolean {
  return name.startsWith('/') || name.startsWith('\\') || /^[A-Za-z]:/.test(name)
}

/** 启动清扫：历史上导出/恢复中断留下的临时明文库（*.plain），绝不留过夜。 */
export function sweepPlainResidues(backupsDir: string): number {
  let removed = 0
  try {
    for (const f of readdirSync(backupsDir)) {
      if (/^\.(export|restore)-\d+\.plain$/.test(f)) {
        try {
          rmSyncPlain(join(backupsDir, f))
          removed += 1
        } catch {
          // 删不掉的下轮再清
        }
      }
    }
  } catch {
    // 目录不存在 = 没有残留
  }
  return removed
}

export function lastSnapshotInfo(backupsDir: string): { name: string; mtime: number } | null {
  const snaps = listSnapshots(backupsDir)
  if (snaps.length === 0) return null
  return { name: basename(snaps[0].path), mtime: snaps[0].mtime }
}
