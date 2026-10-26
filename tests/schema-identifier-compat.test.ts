import { describe, it, expect } from 'vitest'
import Database from 'better-sqlite3-multiple-ciphers'
import { schemaSql } from './helpers'
import { runMigrations } from '../src/main/db/migrations'
import { normalizeSchemaDdl, validateLedgerDatabase, recoverInterruptedRestore } from '../src/main/domain/backup'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openLedger, initSchemaIfEmpty } from '../src/main/db/connection'
import { seed } from '../src/main/db/seed'

function transformedSettings(ddl: string) {
  const source=schemaSql().replace(/CREATE TABLE IF NOT EXISTS settings\s*\([\s\S]*?\);/, ddl)
  const db=new Database(':memory:')
  try { db.exec(source); runMigrations(db); validateLedgerDatabase(db,'合成等价库') }
  finally {db.close()}
}

describe('结构标识符等价与真漂移分界', () => {
  it('方括号只去定界符，不丢标识符内容', () => {
    expect(normalizeSchemaDdl('CREATE TABLE [t]([a] TEXT)')).toBe(normalizeSchemaDdl('CREATE TABLE t(a TEXT)'))
    expect(normalizeSchemaDdl('CREATE TABLE [t]([a] TEXT)')).not.toBe(normalizeSchemaDdl('CREATE TABLE [t]([b] TEXT)'))
  })
  it('生产 settings 表与列采用方括号重建仍接受', () => {
    expect(()=>transformedSettings('CREATE TABLE [settings]([key] TEXT PRIMARY KEY,[value] TEXT NOT NULL,[updated_at] TEXT NOT NULL);')).not.toThrow()
  })
  it('表与列标识符大写的等价重建仍接受', () => {
    expect(()=>transformedSettings('CREATE TABLE SETTINGS(KEY TEXT PRIMARY KEY,VALUE TEXT NOT NULL,UPDATED_AT TEXT NOT NULL);')).not.toThrow()
  })
  it('方括号不掩盖真实列定义漂移', () => {
    expect(()=>transformedSettings('CREATE TABLE [settings]([key] TEXT PRIMARY KEY,[value] INTEGER NOT NULL,[updated_at] TEXT NOT NULL);')).toThrow(/定义|结构/)
  })
  it('字面量中的空白和大小写是数据，不归一', () => {
    expect(normalizeSchemaDdl("CREATE TABLE t(a TEXT DEFAULT 'x y')")).not.toBe(normalizeSchemaDdl("CREATE TABLE t(a TEXT DEFAULT 'xy')"))
    expect(normalizeSchemaDdl("CREATE TABLE t(a TEXT DEFAULT 'Ab')")).not.toBe(normalizeSchemaDdl("CREATE TABLE t(a TEXT DEFAULT 'ab')"))
  })

  it('大写索引与视图对象名沿用同一标识符口径（生产启动链）', () => {
    const dir = mkdtempSync(join(tmpdir(), 'mz-ident-objects-'))
    const file = join(dir, 'ledger.db')
    const dek = 'ad'.repeat(32)
    const db = new Database(file)
    try {
      db.pragma(`key = "x'${dek}'"`)
      db.pragma("cipher='chacha20'")
      db.exec(schemaSql().replace(/\b(idx_[a-z_]+|v_reportable_transactions)\b/g, (name) => name.toUpperCase()))
      runMigrations(db)
      seed(db)
    } finally { db.close() }
    try {
      recoverInterruptedRestore(file, { dekHex: dek })
      const opened = openLedger(file, { get: () => dek, set: () => { throw new Error('never set') } } as never)
      try {
        initSchemaIfEmpty(opened)
        expect(seed(opened)).toEqual({ accounts: 0, categories: 0, settings: 0 })
        expect((opened.prepare('SELECT COUNT(*) n FROM v_reportable_transactions').get() as { n: number }).n).toBe(0)
      } finally { opened.close() }
    } finally { rmSync(dir, { recursive: true, force: true, maxRetries: 3 }) }
  })

  it.each([
    'CREATE TABLE [settings]([key] TEXT PRIMARY KEY,[value] TEXT NOT NULL,[updated_at] TEXT NOT NULL);',
    'CREATE TABLE SETTINGS(KEY TEXT PRIMARY KEY,VALUE TEXT NOT NULL,UPDATED_AT TEXT NOT NULL);',
  ])('合法 settings 标识符变体走完整生产启动链：%s', (ddl) => {
    const dir = mkdtempSync(join(tmpdir(), 'mz-ident-startup-'))
    const file = join(dir, 'ledger.db')
    const dek = 'af'.repeat(32)
    const made = new Database(file)
    try {
      made.pragma(`key = "x'${dek}'"`); made.pragma("cipher='chacha20'")
      made.exec(schemaSql().replace(/CREATE TABLE IF NOT EXISTS settings\s*\([\s\S]*?\);/, ddl))
      runMigrations(made); seed(made)
      made.prepare('INSERT INTO settings(key,value,updated_at) VALUES(?,?,?)').run('synthetic-case', 'PRESERVED', '2026-01-01T00:00:00Z')
    } finally { made.close() }
    try {
      recoverInterruptedRestore(file, { dekHex: dek })
      const opened = openLedger(file, { get: () => dek, set: () => { throw new Error('never set') } } as never)
      try {
        initSchemaIfEmpty(opened); seed(opened)
        expect(opened.prepare('SELECT value AS preserved FROM settings WHERE key=?').get('synthetic-case')).toMatchObject({ preserved: 'PRESERVED' })
      } finally { opened.close() }
    } finally { rmSync(dir, { recursive: true, force: true, maxRetries: 3 }) }
  })

  it('CHECK 中的方括号标识符差异仍保留，字面量内方括号不改', () => {
    expect(normalizeSchemaDdl('CREATE TABLE t(value TEXT, updated_at TEXT, CHECK([value] IS NOT NULL))'))
      .not.toBe(normalizeSchemaDdl('CREATE TABLE t(value TEXT, updated_at TEXT, CHECK([updated_at] IS NOT NULL))'))
    expect(normalizeSchemaDdl("CREATE TABLE [T]([A] TEXT DEFAULT '[Ab  C]')")).toContain("'[Ab  C]'")
  })
})
