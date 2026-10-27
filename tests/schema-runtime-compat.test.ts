// Case-compatible validation must imply real domain usability, not only successful open.
import { describe, expect, it } from 'vitest'
import Database from 'better-sqlite3-multiple-ciphers'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { schemaSql, openLedger, initSchemaIfEmpty } from '../src/main/db/connection'
import { runMigrations } from '../src/main/db/migrations'
import { seed } from '../src/main/db/seed'
import { recoverInterruptedRestore, normalizeSchemaDdl } from '../src/main/domain/backup'
import { createTransaction, getSetting, getTransaction, listAccounts, resolveAccountId, setSetting, snapshot } from '../src/main/domain/ledger'
import { queryLedgerPage } from '../src/main/domain/ledger-page'
import { createPending, getPending, listOpen } from '../src/main/domain/pending'
import { createRule, listRules, matchRule } from '../src/main/domain/rules'
const KEY = '98'.repeat(32)
function identifiersUpper(sql: string): string {
  // All keywords/identifiers outside data literals and comments. No enum values are transformed.
  return sql.replace(/'(?:[^']|'')*'|--[^\n]*|\b[A-Za-z_][A-Za-z0-9_]*\b/g, token => token.startsWith("'") || token.startsWith('--') ? token : token.toUpperCase())
}
function fixture(kind: 'canonical' | 'settings' | 'accounts' | 'transactions' | 'all' | 'bracket' | 'double' | 'backtick') {
  const dir = mkdtempSync(join(tmpdir(), 'mz-schema-runtime-')), file = join(dir, 'ledger.db')
  let ddl = schemaSql
  if (kind === 'all') ddl = identifiersUpper(ddl)
  else if (['settings', 'accounts', 'transactions'].includes(kind)) {
    const pattern = new RegExp('CREATE TABLE IF NOT EXISTS ' + kind + '\\s*\\([\\s\\S]*?\\);')
    ddl = ddl.replace(pattern, identifiersUpper)
  } else if (['bracket', 'double', 'backtick'].includes(kind)) {
    const quotes = kind === 'bracket' ? ['[', ']'] : kind === 'double' ? ['"', '"'] : ['`', '`']
    const q = (text: string) => quotes[0] + text + quotes[1]
    ddl = ddl.replace(/CREATE TABLE IF NOT EXISTS settings\s*\([\s\S]*?\);/,
      `CREATE TABLE ${q('settings')}(${q('key')}TEXT PRIMARY KEY,${q('value')}TEXT NOT NULL,${q('updated_at')}TEXT NOT NULL);`)
  }
  const made = new Database(file)
  try {
    made.pragma(`key = "x'${KEY}'"`); made.pragma("cipher='chacha20'")
    made.exec(ddl); runMigrations(made); seed(made)
    made.prepare('INSERT INTO settings(key,value,updated_at) VALUES(?,?,?)').run('runtime-marker', 'Ab C', '2001-01-02T03:04:05Z')
  } finally { made.close() }
  const original = readFileSync(file)
  writeFileSync(file + '.restore-candidate-runtime', 'SYNTHETIC ORPHAN')
  recoverInterruptedRestore(file, { dekHex: KEY })
  expect(readFileSync(file)).toEqual(original) // recovery must not edit the live database to "fix" case.
  const db = openLedger(file, { get: () => KEY, set: () => { throw new Error('unexpected key write') } } as never)
  try { initSchemaIfEmpty(db); seed(db); return db } catch (err) { db.close(); throw err }
}
describe('equivalent schema must serve actual application domains', () => {
  it.each(['canonical', 'settings', 'accounts', 'transactions', 'all'] as const)('%s identifiers: settings, ledger DTO, confirmation and audit remain usable', kind => {
    const db = fixture(kind)
    try {
      expect(getSetting(db, 'runtime-marker')).toBe('Ab C')
      expect(listAccounts(db)[0]).toEqual({ id: 1, name: '现金', type: 'cash' })
      expect(resolveAccountId(db)).toBe(1)
      setSetting(db, 'runtime-marker', 'changed C')
      expect(getSetting(db, 'runtime-marker')).toBe('changed C')
      const tx = createTransaction(db, { amountCents: 947, txType: 'expense', merchant: 'SYNTHETIC-SHOP', occurredAt: '2001-02-03T04:05:06Z', changedBy: 'user' })
      expect(getTransaction(db, tx)).toMatchObject({ id: tx, amount_cents: 947, state: 'raw_input' })
      expect(snapshot(db, tx)).toMatchObject({ id: tx, amount_cents: 947, state: 'raw_input', occurred_at: '2001-02-03T04:05:06Z' })
      const audit = db.prepare("SELECT after_value AS snapshot FROM audit_log WHERE entity_type='transaction' AND entity_id=? AND change_type='create'").get(tx) as { snapshot: string }
      expect(JSON.parse(audit.snapshot)).toMatchObject({ id: tx, amount_cents: 947, state: 'raw_input' })
      expect(queryLedgerPage(db, {}).items[0]).toMatchObject({ id: tx, amountCents: 947, state: 'raw_input', occurredAt: '2001-02-03T04:05:06Z', accountName: '现金' })
      const pending = createPending(db, { txId: tx, sessionId: 'synthetic', field: 'confirm_record', question: 'synthetic confirmation' })
      expect(getPending(db, pending)).toMatchObject({ id: pending, tx_id: tx, status: 'open' })
      expect(listOpen(db)[0]).toMatchObject({ id: pending, field: 'confirm_record' })
      const rule = createRule(db, { match: 'merchant', op: 'equals', value: 'SYNTHETIC-SHOP' }, { set_category: '其他' })
      expect(listRules(db)[0]).toMatchObject({ id: rule, active: 1, hit_count: 0 })
      expect(matchRule(db, 'SYNTHETIC-SHOP', 'expense')?.id).toBe(rule)
      // The explicit public DTO aliases remain case-sensitive, not blindly lowercased.
      expect(db.prepare('SELECT id AS accountId, name AS MixedCase FROM accounts WHERE id=1').get()).toEqual({ accountId: 1, MixedCase: '现金' })
    } finally { db.close() }
  })
  it.each(['bracket', 'double', 'backtick'] as const)('legal adjacent %s tokens pass recovery and full startup', kind => {
    const db = fixture(kind)
    try { expect(getSetting(db, 'runtime-marker')).toBe('Ab C') } finally { db.close() }
  })
  it.each([
    ['[key]TEXT', 'key TEXT'], ['"key"TEXT', 'key TEXT'], ['`key`TEXT', 'key TEXT'],
    ['[key]/* boundary */TEXT', 'key TEXT'], ['key/* boundary */TEXT', 'key TEXT'],
  ])('token delimiters carry boundaries: %s', (left, right) => {
    expect(normalizeSchemaDdl(`CREATE TABLE t(${left})`)).toBe(normalizeSchemaDdl(`CREATE TABLE t(${right})`))
    expect(normalizeSchemaDdl(`CREATE TABLE t(${left})`)).not.toBe(normalizeSchemaDdl('CREATE TABLE t(keytext)'))
  })
  it('literal delimiters and literal case remain data', () => {
    expect(normalizeSchemaDdl("CREATE TABLE t(key TEXT DEFAULT '[Ab] C')")).not.toBe(normalizeSchemaDdl("CREATE TABLE t(key TEXT DEFAULT '[ab] C')"))
    expect(normalizeSchemaDdl("CREATE TABLE t(key TEXT DEFAULT 'Ab C')")).not.toBe(normalizeSchemaDdl("CREATE TABLE t(key TEXT DEFAULT 'AbC')"))
  })
})
