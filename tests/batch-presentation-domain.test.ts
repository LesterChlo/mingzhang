// Synthetic ledgers only; real file-backed connections verify durable UI state.
import { expect, it } from 'vitest'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import DatabaseCtor, { type Database } from 'better-sqlite3-multiple-ciphers'
import { openSchemaDb } from './helpers'
import { getBatchPresentation, setBatchPresentation } from '../src/main/domain/view-state'

const defaults = { dismissed: false, duplicatesOpen: false, excludedOpen: false }
function gate(db: Database, status = 'resolved', field = 'batch_confirm') {
  return Number(db.prepare('INSERT INTO pending_clarifications(session_id,field,question,status,payload,created_at,updated_at) VALUES (?,?,?,?,?,?,?)')
    .run('synthetic', field, '合成批次', status, JSON.stringify({ plan: { batchId: 'synthetic' } }), '2020-01-01', '2020-01-01').lastInsertRowid)
}
function accounting(db: Database) {
  return Object.fromEntries(['transactions', 'pending_clarifications', 'audit_log', 'imports', 'agent_runs', 'categories', 'accounts', 'rules'].map(t => [t, db.prepare(`SELECT * FROM ${t}`).all()]))
}

it('展示状态按gate持久化、跨连接恢复；两批/两账本独立且可撤回', () => {
  const dir = mkdtempSync(join(tmpdir(), 'mz-batch-presentation-'))
  const file = join(dir, 'synthetic.db')
  const db = openSchemaDb(file)
  const other = openSchemaDb(join(dir, 'other.db'))
  let reopened: Database | undefined
  try {
    const a = gate(db), b = gate(db), otherA = gate(other)
    const before = accounting(db)
    expect(getBatchPresentation(db, a)).toEqual(defaults)
    expect(db.prepare("SELECT * FROM settings WHERE key LIKE 'ui.batch-result:%'").all()).toEqual([])
    expect(setBatchPresentation(db, a, { dismissed: true, duplicatesOpen: true })).toEqual({ ...defaults, dismissed: true, duplicatesOpen: true })
    expect(setBatchPresentation(db, b, { excludedOpen: true })).toEqual({ ...defaults, excludedOpen: true })
    expect(accounting(db)).toEqual(before)
    expect(getBatchPresentation(other, otherA)).toEqual(defaults)
    db.close()
    reopened = openSchemaDb(file)
    expect(getBatchPresentation(reopened, a)).toEqual({ ...defaults, dismissed: true, duplicatesOpen: true })
    expect(getBatchPresentation(reopened, b)).toEqual({ ...defaults, excludedOpen: true })
    expect(setBatchPresentation(reopened, a, { dismissed: false, duplicatesOpen: false })).toEqual(defaults)
    expect(getBatchPresentation(reopened, b)).toEqual({ ...defaults, excludedOpen: true })
    const rows = reopened.prepare("SELECT key,value FROM settings WHERE key LIKE 'ui.batch-result:%' ORDER BY key").all() as { key: string; value: string }[]
    expect(rows.map(r => r.key)).toEqual([`ui.batch-result:${a}`, `ui.batch-result:${b}`])
    expect(rows.every(r => Object.keys(JSON.parse(r.value)).sort().join(',') === 'dismissed,duplicatesOpen,excludedOpen')).toBe(true)
    expect(accounting(reopened)).toEqual(before)
  } finally { if (db.open) db.close(); reopened?.close(); other.close() }
})

it('gate必须正整数且为resolved batch门；patch白名单boolean无效整段零写', () => {
  const db = openSchemaDb(':memory:')
  try {
    const good = gate(db), open = gate(db, 'open'), cancelled = gate(db, 'cancelled'), nonBatch = gate(db, 'resolved', 'delete')
    const before = db.prepare('SELECT * FROM settings').all()
    for (const id of [0, -1, 1.5, NaN, Infinity, '1', null, undefined, 99999, open, cancelled, nonBatch]) {
      expect(() => getBatchPresentation(db, id as number)).toThrow()
      expect(() => setBatchPresentation(db, id as number, { dismissed: true })).toThrow()
    }
    for (const patch of [null, undefined, [], true, 'state', { dismissed: 'true' }, { dismissed: 1 }, { excludedOpen: null }, { dismissed: true, budget: true }, JSON.parse('{"__proto__":true}'), { duplicatesOpen: true, constructor: false }, { [Symbol('extra')]: true }, Object.assign(Object.create({ dismissed: true }), { excludedOpen: true }), Object.defineProperty({}, 'hidden', { value: true }), Object.defineProperty({}, 'dismissed', { get: () => true })]) {
      expect(() => setBatchPresentation(db, good, patch as never)).toThrow()
      expect(db.prepare('SELECT * FROM settings').all()).toEqual(before)
    }
    expect(setBatchPresentation(db, good, {})).toEqual(defaults)
    expect(db.prepare('SELECT * FROM settings').all()).toEqual(before)
  } finally { db.close() }
})

it('坏的旧value只读回默认不修库；保存失败抛真实错误且保留原值', () => {
  const db = openSchemaDb(':memory:')
  try {
    const id = gate(db), key = `ui.batch-result:${id}`
    for (const value of ['{broken', 'null', '[]', 'true', '{"dismissed":"yes"}', '{"dismissed":true,"duplicatesOpen":false,"excludedOpen":false,"extra":true}']) {
      db.prepare('INSERT INTO settings(key,value,updated_at) VALUES (?,?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(key, value, 'synthetic')
      expect(getBatchPresentation(db, id)).toEqual(defaults)
      expect(db.prepare('SELECT value FROM settings WHERE key=?').get(key)).toEqual({ value })
    }
    setBatchPresentation(db, id, { dismissed: true })
    const before = db.prepare('SELECT * FROM settings').all()
    db.exec("CREATE TRIGGER synthetic_fail_save BEFORE UPDATE ON settings BEGIN SELECT RAISE(ABORT, 'synthetic save denied'); END")
    expect(() => setBatchPresentation(db, id, { duplicatesOpen: true })).toThrow('synthetic save denied')
    expect(db.prepare('SELECT * FROM settings').all()).toEqual(before)
  } finally { db.close() }
})

it('两个同时打开的真实连接按最新值合并patch，不串两批；只读连接保存失败零变更', () => {
  const file = join(mkdtempSync(join(tmpdir(), 'mz-batch-connections-')), 'synthetic.db')
  const db = openSchemaDb(file)
  const second = openSchemaDb(file)
  const readOnly = new DatabaseCtor(file, { readonly: true, fileMustExist: true })
  try {
    const a = gate(db), b = gate(db)
    setBatchPresentation(db, a, { dismissed: true })
    expect(setBatchPresentation(second, a, { duplicatesOpen: true })).toEqual({ dismissed: true, duplicatesOpen: true, excludedOpen: false })
    setBatchPresentation(second, b, { excludedOpen: true })
    expect(setBatchPresentation(db, a, { dismissed: false })).toEqual({ dismissed: false, duplicatesOpen: true, excludedOpen: false })
    expect(getBatchPresentation(second, b)).toEqual({ ...defaults, excludedOpen: true })
    const before = db.prepare('SELECT * FROM settings').all()
    expect(getBatchPresentation(readOnly, a)).toEqual({ ...defaults, duplicatesOpen: true })
    expect(() => setBatchPresentation(readOnly, a, { excludedOpen: true })).toThrow(/readonly/)
    expect(db.prepare('SELECT * FROM settings').all()).toEqual(before)
  } finally { readOnly.close(); second.close(); db.close() }
})
