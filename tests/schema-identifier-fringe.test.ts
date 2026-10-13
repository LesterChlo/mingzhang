// Synthetic SQLite identifier neighbors: ASCII folding must not change Unicode identity.
import { describe, expect, it } from 'vitest'
import Database from 'better-sqlite3-multiple-ciphers'
import { normalizeSchemaDdl } from '../src/main/domain/backup'
import { installResultShape } from '../src/main/db/result-shape'

const neighbors = [['ÄKEY', 'äkey'], ['ΣKEY', 'σkey'], ['İKEY', 'i\u0307key']] as const

describe('SQLite ASCII-only identifier fringe', () => {
  it.each(neighbors)('retains bare and quoted Unicode identity %s', (name, different) => {
    for (const quote of [(s: string) => s, (s: string) => `"${s}"`, (s: string) => `[${s}]`]) {
      const ddl = (s: string) => `CREATE TABLE t(${quote(s)} TEXT)`
      expect(normalizeSchemaDdl(ddl(name))).not.toBe(normalizeSchemaDdl(ddl(different)))
      expect(normalizeSchemaDdl(ddl(name))).toBe(normalizeSchemaDdl(ddl(name.replace('KEY', 'key'))))
    }
  })

  it.each(neighbors)('leaves unknown Unicode origin %s and metadata native', (name, different) => {
    const db = new Database(':memory:')
    try {
      db.exec(`CREATE TABLE settings("${name}" TEXT); INSERT INTO settings VALUES('KEY Ä Σ İ')`)
      const sql = 'SELECT * FROM settings'
      const columns = (db.prepare(sql) as unknown as { columns(): unknown }).columns()
      installResultShape(db, { settings: [different] })
      const adapted = db.prepare(sql)
      expect(adapted.get()).toEqual({ [name]: 'KEY Ä Σ İ' })
      expect((adapted as unknown as { columns(): unknown }).columns()).toEqual(columns)
    } finally { db.close() }
  })

  it('does not fold Kelvin-sign table origin into a known ASCII table', () => {
    const db = new Database(':memory:')
    try {
      db.exec('CREATE TABLE "K"(ID INTEGER); INSERT INTO "K" VALUES(23)')
      installResultShape(db, { k: ['id'] })
      expect(db.prepare('SELECT * FROM "K"').get()).toEqual({ ID: 23 })
    } finally { db.close() }
  })

  it('folds ASCII origins but preserves aliases and literal content exactly', () => {
    const db = new Database(':memory:')
    try {
      db.exec('CREATE TABLE SETTINGS(KEY TEXT); INSERT INTO SETTINGS VALUES(\'KEY Ä Σ İ\')')
      installResultShape(db, { settings: ['key'] })
      expect(db.prepare('SELECT KEY, KEY AS "KEY", KEY AS camelCase FROM SETTINGS').get())
        .toEqual({ key: 'KEY Ä Σ İ', ['KEY']: 'KEY Ä Σ İ', camelCase: 'KEY Ä Σ İ' })
      expect(normalizeSchemaDdl("CREATE TABLE t(KEY TEXT DEFAULT 'KEY Ä Σ İ')"))
        .toBe("create table t(key text default 'KEY Ä Σ İ')")
    } finally { db.close() }
  })
})
