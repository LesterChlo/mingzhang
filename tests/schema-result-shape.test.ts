import { describe, expect, it } from 'vitest'
import NativeDatabase from 'better-sqlite3-multiple-ciphers'
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { initSchemaIfEmpty, openLedger, schemaSql } from '../src/main/db/connection'
import { runMigrations } from '../src/main/db/migrations'
import { seed } from '../src/main/db/seed'

const KEY = '65'.repeat(32)
function fixture() {
  const file = join(mkdtempSync(join(tmpdir(), 'mz-result-shape-')), 'ledger.db')
  const native = new NativeDatabase(file)
  try {
    native.pragma(`key = "x'${KEY}'"`); native.pragma("cipher='chacha20'")
    native.exec(schemaSql.replace(/CREATE TABLE IF NOT EXISTS (accounts|settings)\s*\([\s\S]*?\);/g,
      sql => sql.replace(/'(?:[^']|'')*'|--[^\n]*|\b[A-Za-z_][A-Za-z0-9_]*\b/g,
        token => token.startsWith("'") || token.startsWith('--') ? token : token.toUpperCase())))
    runMigrations(native); seed(native)
  } finally { native.close() }
  const db = openLedger(file, { get: () => KEY, set: () => { throw Error('no key write') } } as never)
  initSchemaIfEmpty(db)
  return { db, file }
}
// Local declaration for real driver APIs not included in the application's minimal .d.ts.
type Row = Record<string, unknown>
type Statement = {
  get(...args: unknown[]): unknown; all(...args: unknown[]): unknown[]
  iterate(...args: unknown[]): IterableIterator<unknown>; bind(...args: unknown[]): Statement
  raw(value?: boolean): Statement; pluck(value?: boolean): Statement; expand(value?: boolean): Statement
  safeIntegers(value?: boolean): Statement; columns(): unknown[]; database: unknown; busy: boolean
}
const statement = (db: ReturnType<typeof openLedger>, sql: string) => db.prepare(sql) as unknown as Statement

describe('connection-local schema-origin result shape', () => {
  it('maps get/all/iterate without changing metadata or native database references', () => {
    const { db } = fixture()
    try {
      const s = statement(db, 'SELECT id,name FROM accounts WHERE id=?')
      expect(s.get(1)).toEqual({ id: 1, name: '现金' })
      expect(s.all(1)).toEqual([{ id: 1, name: '现金' }])
      expect([...s.iterate(1)]).toEqual([{ id: 1, name: '现金' }])
      expect(s.database).toBe(db)
      expect(s.columns()).toMatchObject([{ name: 'ID', column: 'ID', table: 'ACCOUNTS' }, { name: 'NAME' }])
      expect(s.get(999)).toBeUndefined()
    } finally { db.close() }
  })

  it('preserves AS aliases even when their exact spelling equals a physical source column', () => {
    const { db } = fixture()
    try {
      expect(db.prepare('SELECT id,id AS ID,name AS MixedCase,id AS accountId FROM accounts WHERE id=1').get())
        .toEqual({ id: 1, ID: 1, MixedCase: '现金', accountId: 1 })
      expect(db.prepare('SELECT id, name AS "NAME", id AS `accountId`, name AS [MixedCase] FROM accounts WHERE id=1').get())
        .toEqual({ id: 1, NAME: '现金', accountId: 1, MixedCase: '现金' })
      expect(db.prepare("SELECT id, 'AS ID' AS marker FROM accounts WHERE id=1 /* AS ID */").get())
        .toEqual({ id: 1, marker: 'AS ID' })
    } finally { db.close() }
  })

  it('preserves implicit aliases identical to native names, wildcard DTOs and joined expand keys', () => {
    const { db } = fixture()
    try {
      expect(db.prepare('SELECT id,id ID,name NAME FROM accounts WHERE id=1').get())
        .toEqual({ id: 1, ID: 1, NAME: '现金' })
      expect(db.prepare('SELECT a.*, name AS MixedCase FROM accounts a WHERE id=1').get())
        .toMatchObject({ id: 1, name: '现金', type: 'cash', currency: 'CNY', MixedCase: '现金' })
      const sql = 'SELECT a.id,a.name,c.id,c.name,23 AS MixedCase FROM accounts a JOIN categories c ON c.id=a.id WHERE a.id=1'
      expect(db.prepare(sql).get()).toEqual({ id: 1, name: '餐饮', MixedCase: 23 })
      expect(statement(db, sql).expand().get()).toEqual({
        ACCOUNTS: { id: 1, name: '现金' }, categories: { id: 1, name: '餐饮' }, '$': { MixedCase: 23 },
      })
    } finally { db.close() }
  })

  it('resolves output collisions in projection order rather than lost native object values', () => {
    const { db } = fixture()
    try {
      expect(db.prepare('SELECT id, 9 AS id FROM accounts WHERE id=1').get()).toEqual({ id: 9 })
      expect(db.prepare('SELECT 9 AS id, id FROM accounts WHERE id=1').get()).toEqual({ id: 1 })
      expect(db.prepare('SELECT id AS Same, name AS Same FROM accounts WHERE id=1').get()).toEqual({ Same: '现金' })
      expect(db.prepare('SELECT id, name AS "__proto__" FROM accounts WHERE id=1').get())
        .toEqual({ id: 1, ['__proto__']: '现金' })
    } finally { db.close() }
  })

  it('retains modes, bind/chaining, safe integers and iterator early-return unlock', () => {
    const { db } = fixture()
    try {
      const s = statement(db, 'SELECT id,name FROM accounts WHERE id=@id').bind({ id: 1 })
      expect(s.raw()).toBe(s); expect(s.get()).toEqual([1, '现金'])
      expect(s.pluck()).toBe(s); expect(s.get()).toBe(1)
      expect(s.raw(false)).toBe(s); expect(s.get()).toBe(1) // disabling an inactive mode must not reset pluck
      expect(s.pluck(false).get()).toEqual({ id: 1, name: '现金' })
      expect(s.expand()).toBe(s); expect(s.get()).toEqual({ ACCOUNTS: { id: 1, name: '现金' } })
      expect(s.expand(false).safeIntegers().get()).toEqual({ id: 1n, name: '现金' })
      expect(s.safeIntegers(false).get()).toEqual({ id: 1, name: '现金' })
      expect(() => s.get(1)).toThrow()
      const iter = s.iterate(); expect(s.busy).toBe(true)
      expect(() => s.raw()).toThrow()
      iter.return?.(); expect(s.busy).toBe(false)
      for (const row of s.iterate()) { expect(row).toEqual({ id: 1, name: '现金' }); break }
      expect(s.busy).toBe(false)
      expect(s.all()).toEqual([{ id: 1, name: '现金' }])
    } finally { db.close() }
  })

  it('keeps transactions, rollback, repeated init and close/reopen semantics', () => {
    const { db, file } = fixture()
    try {
      initSchemaIfEmpty(db); initSchemaIfEmpty(db)
      db.transaction(() => {
        expect(db.inTransaction).toBe(true)
        db.prepare('INSERT INTO settings(key,value,updated_at) VALUES(?,?,?)').run('shape', 'SYNTHETIC', '2001-01-01')
        expect(db.prepare('SELECT value FROM settings WHERE key=?').get('shape')).toEqual({ value: 'SYNTHETIC' })
      })()
      expect(() => db.transaction(() => {
        db.prepare('UPDATE settings SET value=? WHERE key=?').run('ROLLBACK', 'shape')
        throw Error('synthetic rollback')
      })()).toThrow('synthetic rollback')
      expect(db.inTransaction).toBe(false)
      expect(db.prepare('SELECT value FROM settings WHERE key=?').get('shape')).toEqual({ value: 'SYNTHETIC' })
    } finally { db.close() }
    const closedBytes = readFileSync(file)
    const reopened = openLedger(file, { get: () => KEY } as never)
    try {
      initSchemaIfEmpty(reopened)
      expect(reopened.prepare('SELECT value FROM settings WHERE key=?').get('shape')).toEqual({ value: 'SYNTHETIC' })
      const retained = statement(reopened, 'SELECT id FROM accounts')
      reopened.close(); expect(reopened.open).toBe(false)
      expect(() => retained.get()).toThrow()
    } finally { if (reopened.open) reopened.close() }
    expect(readFileSync(file)).toEqual(closedBytes)
  })

  it('does not normalize unknown/attached origins or other native connections', () => {
    const { db } = fixture()
    const native = new NativeDatabase(':memory:')
    try {
      native.exec('CREATE TABLE accounts(ID INTEGER); INSERT INTO accounts VALUES(23)')
      expect(native.prepare('SELECT id FROM accounts').get()).toEqual({ ID: 23 })
      db.exec("CREATE TEMP TABLE synthetic(ID INTEGER); INSERT INTO synthetic VALUES(42); ATTACH ':memory:' AS other; CREATE TABLE other.accounts(ID INTEGER); INSERT INTO other.accounts VALUES(43)")
      expect(db.prepare('SELECT id FROM synthetic').get()).toEqual({ ID: 42 })
      expect(db.prepare('SELECT id FROM other.accounts').get()).toEqual({ ID: 43 })
    } finally { native.close(); db.close() }
  })
})
