import { describe, expect, it } from 'vitest'
import Database from 'better-sqlite3-multiple-ciphers'
import { normalizeSchemaDdl, validateLedgerDatabase } from '../src/main/domain/backup'
import { schemaSql } from '../src/main/db/connection'
import { runMigrations } from '../src/main/db/migrations'

const norm = normalizeSchemaDdl

describe('DDL token boundaries and opaque data', () => {
  it.each(['[key]TEXT', '"key"TEXT', '`key`TEXT', 'key/**/TEXT', 'key-- boundary\nTEXT', '[key]/**/TEXT'])
    ('keeps lexical boundary %s', column => {
      expect(norm(`CREATE TABLE t(${column})`)).toBe(norm('CREATE TABLE t(key TEXT)'))
      expect(norm(`CREATE TABLE t(${column})`)).not.toBe(norm('CREATE TABLE t(keytext)'))
    })

  it.each(['"a  b"', '`a  b`', '[a  b]', '"a /* b */"', '`a -- b`', '[a -- b]', '"IF NOT EXISTS"', '`a"b`', '"a""b"', '`a``b`'])
    ('preserves quoted identifier content %s', name => {
      const compact = name.replace(/  /g, ' ').replace(/\/\* b \*\//g, '').replace(/-- b/g, '').replace(/IF NOT EXISTS/g, '')
      if (compact !== name) expect(norm(`CREATE TABLE t(${name} TEXT)`)).not.toBe(norm(`CREATE TABLE t(${compact} TEXT)`))
      expect(norm(`CREATE TABLE t(${name}TEXT)`)).toBe(norm(`CREATE TABLE t(${name} TEXT)`))
    })

  it('does not confuse quoted keywords or embedded delimiter characters with SQL syntax', () => {
    expect(norm('CREATE TABLE t("if not exists" TEXT)')).not.toBe(norm('CREATE TABLE t(TEXT)'))
    expect(norm('CREATE TABLE t("a""b" TEXT)')).not.toBe(norm('CREATE TABLE t("ab" TEXT)'))
    expect(norm('CREATE TABLE t([a.b] TEXT)')).not.toBe(norm('CREATE TABLE t(a.b TEXT)'))
    expect(norm('CREATE TABLE t([a b] TEXT)')).not.toBe(norm('CREATE TABLE t(a b TEXT)'))
    expect(norm('CREATE TABLE t([a] [b])')).not.toBe(norm('CREATE TABLE t([a b])'))
  })

  it('comments separate words and IF NOT EXISTS consists of unquoted tokens only', () => {
    expect(norm('CREATE TABLE IF/**/NOT-- comment\nEXISTS t(a TEXT)')).toBe(norm('CREATE TABLE t(a TEXT)'))
    expect(norm('CREATE TABLE t(a TEXT CHECK(a IS/**/NOT NULL))')).toBe(norm('CREATE TABLE t(a TEXT CHECK(a IS NOT NULL))'))
    expect(norm('CREATE TABLE t(a TEXT CHECK(a IS/**/NOT NULL))')).not.toBe(norm('CREATE TABLE t(a TEXT CHECK(a ISNOT NULL))'))
  })

  it.each(["'[Ab]  C'", "'it''s -- /* quoted */ X'", "'a\nb'", "'IF NOT EXISTS'"])
    ('keeps literal bytes %s', literal => {
      const sql = `CREATE TABLE t(key TEXT DEFAULT ${literal})`
      expect(norm(sql)).toContain(literal)
      expect(norm(sql)).not.toBe(norm(sql.replace(literal, "'different data'")))
    })

  it.each(['[', '"', '`'] as const)('accepts adjacent %s production DDL but still rejects real drift', quote => {
    const q = (s: string) => quote + s + (quote === '[' ? ']' : quote)
    const settings = `CREATE TABLE ${q('settings')}(${q('key')}/**/TEXT PRIMARY KEY,${q('value')}TEXT NOT NULL,${q('updated_at')}TEXT NOT NULL);`
    const db = new Database(':memory:')
    try {
      db.exec(schemaSql.replace(/CREATE TABLE IF NOT EXISTS settings\s*\([\s\S]*?\);/, settings))
      runMigrations(db)
      expect(() => validateLedgerDatabase(db, 'synthetic adjacent')).not.toThrow()
      db.exec(`DROP TABLE settings; ${settings.replace(`${q('value')}TEXT`, `${q('value')}INTEGER`)}`)
      expect(() => validateLedgerDatabase(db, 'synthetic drift')).toThrow(/定义|结构/)
    } finally { db.close() }
  })
})
