// SQLite folds only ASCII identifiers, not Unicode text. All fixtures synthetic.
import { describe, expect, it } from 'vitest'
import Database from 'better-sqlite3-multiple-ciphers'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openLedger, initSchemaIfEmpty, schemaSql } from '../src/main/db/connection'
import { runMigrations } from '../src/main/db/migrations'
import { seed } from '../src/main/db/seed'
import { getSetting } from '../src/main/domain/ledger'
import { normalizeSchemaDdl, recoverInterruptedRestore, validateLedgerDatabase } from '../src/main/domain/backup'
import { installResultShape } from '../src/main/db/result-shape'
const KEY = '78'.repeat(32)
function fixture(column: string) {
  const file = join(mkdtempSync(join(tmpdir(), 'mz-ascii-ident-')), 'ledger.db'), db = new Database(file)
  try {
    db.pragma(`key = "x'${KEY}'"`); db.pragma("cipher='chacha20'")
    db.exec(schemaSql); runMigrations(db); seed(db)
    db.prepare('INSERT INTO settings(key,value,updated_at) VALUES(?,?,?)').run('synthetic-ascii', 'PRESERVED', '2001-02-03T04:05:06Z')
    db.exec(`ALTER TABLE settings RENAME COLUMN key TO "${column}"`)
  } finally { db.close() }
  return file
}
describe('ASCII schema identifier equivalence versus real Unicode drift', () => {
  it.each(['[KEY]', '"KEY"', '`KEY`', 'KEY', '"Ä"'])('normalizer retains non-ASCII content %s', identifier => {
    const comparison = identifier === '"Ä"' ? '"ä"' : 'key'
    expect(normalizeSchemaDdl(`CREATE TABLE t(${identifier} TEXT)`)).not.toBe(normalizeSchemaDdl(`CREATE TABLE t(${comparison} TEXT)`))
  })
  it('SQLite ASCII KEY stays admitted and domain-readable', () => {
    const file = fixture('KEY'), db = openLedger(file, { get: () => KEY, set: () => { throw Error('never') } } as never)
    try { initSchemaIfEmpty(db); expect(getSetting(db, 'synthetic-ascii')).toBe('PRESERVED') } finally { db.close() }
  })
  it('Kelvin-sign column is rejected before recovery consumes orphan evidence', () => {
    const file = fixture('KEY'), before = readFileSync(file), orphan = file + '.restore-candidate-synthetic'
    writeFileSync(orphan, 'SYNTHETIC EVIDENCE')
    expect(() => recoverInterruptedRestore(file, { dekHex: KEY })).toThrow(/列|结构|定义/)
    expect(readFileSync(file)).toEqual(before); expect(readFileSync(orphan).toString()).toBe('SYNTHETIC EVIDENCE')
  })
  it('Kelvin-sign column fails actual open/init contract, not only string comparison', () => {
    const file = fixture('KEY')
    let db: ReturnType<typeof openLedger> | undefined
    try { expect(() => { db = openLedger(file, { get: () => KEY, set: () => { throw Error('never') } } as never) }).toThrow(/列|结构|定义/) }
    finally { db?.close() }
  })
  it('result adapter never maps a non-ASCII column into a known ASCII contract', () => {
    const db = new Database(':memory:')
    try {
      db.exec('CREATE TABLE settings("KEY" TEXT); INSERT INTO settings("KEY") VALUES(\'SYNTHETIC\')')
      installResultShape(db, { settings: ['key'] })
      expect(db.prepare('SELECT * FROM settings').get()).toEqual({ ['KEY']: 'SYNTHETIC' })
    } finally { db.close() }
  })
  it('Unicode table names do not become ASCII production tables', () => {
    const db = new Database(':memory:')
    try {
      db.exec(schemaSql); runMigrations(db); db.exec('ALTER TABLE accounts RENAME TO "ÄCCOUNTS"')
      expect(() => validateLedgerDatabase(db, 'synthetic Unicode table')).toThrow(/表|结构/)
    } finally { db.close() }
  })
})
