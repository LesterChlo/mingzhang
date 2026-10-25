// Synthetic registered IPC / preload lifecycle; no app profile, keys or network.
import { afterEach, expect, it, vi } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, existsSync, symlinkSync, utimesSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openSchemaDb } from './helpers'
import { seed } from '../src/main/db/seed'
import { createImport, createTransaction } from '../src/main/domain/ledger'
import { createLedgerTools } from '../src/main/engine/tools'
import { executeBatch, prepareBatch } from '../src/main/domain/batch'
const { handlers, invokes, decode, expose } = vi.hoisted(() => ({
  handlers: new Map<string, (...args: any[]) => any>(), invokes: vi.fn(),
  decode: vi.fn(() => ({ isEmpty: () => false })), expose: vi.fn(),
}))
vi.mock('electron', () => ({
  ipcMain: { handle: (name: string, fn: (...args: any[]) => any) => handlers.set(name, fn) },
  nativeTheme: {}, nativeImage: { createFromBuffer: decode }, dialog: {}, app: {},
  ipcRenderer: { invoke: invokes, on: vi.fn(), removeListener: vi.fn() }, contextBridge: { exposeInMainWorld: expose },
}))
import { registerIpc } from '../src/main/ipc'
import { registerSettingsIpc } from '../src/main/ipc-settings'
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGNoCtD9DwAEVgH/dFWU5AAAAABJRU5ErkJggg==', 'base64')
const dbs: ReturnType<typeof openSchemaDb>[] = []
afterEach(() => { for (const db of dbs.splice(0)) db.close(); decode.mockImplementation(() => ({ isEmpty: () => false })) })
function fixture() {
  const dir = join(mkdtempSync(join(tmpdir(), 'mz-attachment-ipc-')), 'attachments'); mkdirSync(dir)
  const db = openSchemaDb(':memory:'); seed(db); dbs.push(db)
  const tx = createTransaction(db, { amountCents: 123, txType: 'expense', sourceMessageId: 'synthetic-source' })
  return { db, dir, tx }
}
const invoke = (name: string, ...args: unknown[]) => handlers.get('mz:' + name)!({}, ...args)
const image = { fileName: 'synthetic.png', mediaType: 'image/png', dataBase64: png.toString('base64') }

it('preload三个附件方法精确转发，主进程注册动态db/目录且真的调用decoder、不调用模型', async () => {
  await import('../src/preload/index')
  const api = expose.mock.calls[0][1]
  api.listTransactionAttachments(1); expect(invokes).toHaveBeenLastCalledWith('mz:listTransactionAttachments', 1)
  for (const name of ['addTransactionAttachments', 'removeTransactionAttachment']) {
    const input = { txId: 1, expectedVersion: 'opaque', files: [image], ref: 'synthetic.png' }
    api[name](input); expect(invokes).toHaveBeenLastCalledWith('mz:' + name, input)
  }
  const one = fixture(), two = fixture(); let current = one
  registerIpc({ getDb: () => current.db, getAttachmentsDir: () => current.dir, engines: { get: () => { throw Error('MODEL-MUST-NOT-RUN') } } } as never, { dataDir: 'synthetic', dbFile: ':memory:' })
  const before = invoke('listTransactionAttachments', one.tx)
  decode.mockImplementationOnce(() => ({ isEmpty: () => true }))
  expect(() => invoke('addTransactionAttachments', { txId: one.tx, expectedVersion: before.version, files: [image] })).toThrow()
  expect(invoke('listTransactionAttachments', one.tx).items).toEqual([])
  const added = invoke('addTransactionAttachments', { txId: one.tx, expectedVersion: before.version, files: [image] })
  expect(decode).toHaveBeenCalledWith(png); expect(added.items).toHaveLength(1)
  expect(readFileSync(join(one.dir, added.items[0].ref))).toEqual(png)
  expect(invoke('txDetail', one.tx).attachmentRef).toBe(added.items[0].ref)
  expect(invoke('listLedger', {}).items.find((r: any) => r.id === one.tx).attachmentRef).toBe(added.items[0].ref)
  current = two; expect(invoke('listTransactionAttachments', two.tx).items).toEqual([])
  current = one; invoke('removeTransactionAttachment', { txId: one.tx, expectedVersion: added.version, ref: added.items[0].ref })
  expect(invoke('txDetail', one.tx).attachmentRef).toBeNull()
  expect(invoke('listLedger', {}).items.find((r: any) => r.id === one.tx).attachmentRef).toBeNull()
})

it('生产添加必须接受真实GIF/WebP，不能把nativeImage不支持格式误报为损坏', async () => {
  const f = fixture()
  registerIpc({ getDb: () => f.db, getAttachmentsDir: () => f.dir } as never, { dataDir: 'synthetic', dbFile: ':memory:' })
  const files = [
    { fileName: 'synthetic.gif', mediaType: 'image/gif', dataBase64: 'R0lGODdhAgACAIEAAAwiOAAAAAAAAAAAACwAAAAAAgACAAAIBgABCAQQEAA7' },
    { fileName: 'synthetic.webp', mediaType: 'image/webp', dataBase64: 'UklGRjAAAABXRUJQVlA4ICQAAABQAQCdASoCAAIAAUAmJQBOgC6gAP77LkvF3YjjJ4dVU9ffoAA=' },
  ]
  // Simulate the observed Electron44 PNG/JPEG-only decoder, not arbitrary acceptance.
  decode.mockImplementation((bytes: Buffer) => ({ isEmpty: () => bytes[0] !== 137 }))
  const result = await invoke('addTransactionAttachments', { txId: f.tx, expectedVersion: invoke('listTransactionAttachments', f.tx).version, files })
  expect(result.items.map((r: any) => r.mediaType)).toEqual(['image/gif', 'image/webp'])
  expect(result.items.every((r: any) => r.available)).toBe(true)
})

it('GIF/WebP解码yield后重新核版本/动态数据库，不能把过期意图写入旧账本', async () => {
  const f = fixture(), other = fixture(); let current = f
  registerIpc({ getDb: () => current.db, getAttachmentsDir: () => current.dir } as never, { dataDir: 'synthetic', dbFile: ':memory:' })
  const files = [{ fileName: 'synthetic.gif', mediaType: 'image/gif', dataBase64: 'R0lGODdhAgACAIEAAAwiOAAAAAAAAAAAACwAAAAAAgACAAAIBgABCAQQEAA7' }]
  const pending = invoke('addTransactionAttachments', { txId: f.tx, expectedVersion: invoke('listTransactionAttachments', f.tx).version, files })
  current = other
  await expect(pending).rejects.toThrow(/切换/)
  expect(readdirSync(f.dir)).toEqual([]); expect(readdirSync(other.dir)).toEqual([])
  current = f
  const stale = invoke('addTransactionAttachments', { txId: f.tx, expectedVersion: invoke('listTransactionAttachments', f.tx).version, files })
  f.db.prepare("UPDATE transactions SET merchant='合成并发变更' WHERE id=?").run(f.tx)
  await expect(stale).rejects.toThrow(/过期/)
  expect(readdirSync(f.dir)).toEqual([])
})

it('registered读取拒绝穿越/ADS/UNC/junction以及root junction，正常图片仍可读', () => {
  const f = fixture(), outside = mkdtempSync(join(tmpdir(), 'mz-attachment-outside-'))
  writeFileSync(join(outside, 'synthetic.png'), png); writeFileSync(join(f.dir, 'synthetic.png'), png)
  symlinkSync(outside, join(f.dir, 'link'), 'junction')
  registerSettingsIpc({ attachmentsDir: f.dir } as never)
  expect(invoke('readAttachment', 'synthetic.png')).toBe('data:image/png;base64,' + png.toString('base64'))
  for (const ref of ['../synthetic.png', 'link/synthetic.png', 'synthetic.png:stream', 'C:/synthetic.png', '\\\\synthetic\\share.png', 'sub/../synthetic.png', null]) expect(invoke('readAttachment', ref)).toBeNull()
  const rootLink = join(outside, 'root-link'); symlinkSync(f.dir, rootLink, 'junction')
  registerSettingsIpc({ attachmentsDir: rootLink } as never)
  expect(invoke('readAttachment', 'synthetic.png')).toBeNull()
})

it('旧清理只删无引用旧文件：共享import/pending/source/override与junction全部保全；坏payload零删除', () => {
  const f = fixture()
  for (const name of ['legacy.png', 'pending.png', 'source.png', 'override.png', 'orphan.png']) { writeFileSync(join(f.dir, name), png); utimesSync(join(f.dir, name), 1, 1) }
  createImport(f.db, { sourceType: 'screenshot', sourceMessageId: 'synthetic-source', sourceRef: 'legacy.png' })
  f.db.prepare("INSERT INTO pending_clarifications (session_id,field,question,payload,created_at,updated_at) VALUES ('synthetic','batch_confirm','synthetic',?,'synthetic','synthetic')").run(JSON.stringify({ plan: { attachments: ['pending.png'] } }))
  f.db.prepare("INSERT INTO settings (key,value,updated_at) VALUES (?,?, 'synthetic')").run('source.attachments:other', JSON.stringify({ version: 1, refs: ['source.png'] }))
  f.db.prepare("INSERT INTO settings (key,value,updated_at) VALUES (?,?, 'synthetic')").run('tx.attachments:' + f.tx, JSON.stringify({ version: 1, items: [{ ref: 'override.png', fileName: 'override.png', mediaType: 'image/png', byteLength: png.length }] }))
  const outside = mkdtempSync(join(tmpdir(), 'mz-cleanup-outside-')); writeFileSync(join(outside, 'never.png'), png); utimesSync(join(outside, 'never.png'), 1, 1)
  symlinkSync(outside, join(f.dir, 'link'), 'junction')
  registerSettingsIpc({ attachmentsDir: f.dir, getDb: () => f.db } as never)
  expect(invoke('cleanupAttachments', 1)).toBe(1)
  for (const name of ['legacy.png', 'pending.png', 'source.png', 'override.png']) expect(existsSync(join(f.dir, name))).toBe(true)
  expect(existsSync(join(outside, 'never.png'))).toBe(true)
  writeFileSync(join(f.dir, 'new-orphan.png'), png); utimesSync(join(f.dir, 'new-orphan.png'), 1, 1)
  f.db.prepare("UPDATE settings SET value='broken' WHERE key=?").run('tx.attachments:' + f.tx)
  expect(() => invoke('cleanupAttachments', 1)).toThrow()
  expect(existsSync(join(f.dir, 'new-orphan.png'))).toBe(true)
})

it('record保存全部TurnContext来源且source写失败回滚创建交易/import/audit/sequence', async () => {
  const f = fixture()
  const record = createLedgerTools({ db: f.db, getTurnContext: () => ({ sessionId: 'synthetic', sourceMessageId: 'synthetic-record-all', hasImage: true, visionUnverified: false, attachments: ['one.png', 'two.png'] }) }).find(t => t.name === 'record')!
  const run = () => (record.execute as any)('synthetic', { amount_cents: 100, tx_type: 'expense', category_name: '餐饮', confidence: 1 })
  const before = Object.fromEntries(['transactions', 'imports', 'audit_log', 'settings', 'sqlite_sequence'].map(t => [t, f.db.prepare('SELECT * FROM ' + t).all()]))
  f.db.exec("CREATE TRIGGER synthetic_source_fail BEFORE INSERT ON settings WHEN NEW.key LIKE 'source.attachments:%' BEGIN SELECT RAISE(ABORT,'SYNTHETIC-SOURCE'); END")
  await expect(run()).rejects.toThrow(/SYNTHETIC-SOURCE/)
  for (const [table, rows] of Object.entries(before)) expect(f.db.prepare('SELECT * FROM ' + table).all()).toEqual(rows)
  f.db.exec('DROP TRIGGER synthetic_source_fail'); const result = await run()
  registerIpc({ getDb: () => f.db, getAttachmentsDir: () => f.dir } as never, { dataDir: 'synthetic', dbFile: ':memory:' })
  expect(invoke('listTransactionAttachments', result.details.card.tx.id).items.map((r: any) => r.ref)).toEqual(['one.png', 'two.png'])
})

it('损坏pending附件列表清理必须零删除，不能把非法refs过滤为空后删光旧图', () => {
  const f = fixture(); writeFileSync(join(f.dir, 'keep.png'), png); utimesSync(join(f.dir, 'keep.png'), 1, 1)
  f.db.prepare("INSERT INTO pending_clarifications (session_id,field,question,payload,created_at,updated_at) VALUES ('synthetic','batch_item','synthetic',?,'synthetic','synthetic')").run(JSON.stringify({ attachments: ['../synthetic-outside.png'] }))
  registerSettingsIpc({ attachmentsDir: f.dir, getDb: () => f.db } as never)
  expect(() => invoke('cleanupAttachments', 1)).toThrow()
  expect(existsSync(join(f.dir, 'keep.png'))).toBe(true)
})

it('真实executeBatch在同期创建每笔交易保存所有plan来源，不依赖pending幸存', () => {
  const f = fixture(), gate = prepareBatch(f.db, { sourceType: 'screenshot', sessionId: 'synthetic', attachments: ['one.png', 'two.png'], items: [{ amount_cents: 100, category_name: '餐饮' }, { amount_cents: 200, category_name: '餐饮' }] })
  const state = () => Object.fromEntries(['transactions','imports','audit_log','pending_clarifications','settings','accounts','categories','rules','sqlite_sequence'].map(table => [table, f.db.prepare('SELECT * FROM ' + table + ' ORDER BY rowid').all()]))
  const before = state()
  f.db.exec("CREATE TRIGGER synthetic_batch_source_fail BEFORE INSERT ON settings WHEN NEW.key LIKE 'source.attachments:%' BEGIN SELECT RAISE(ABORT,'SYNTHETIC-BATCH-SOURCE'); END")
  expect(() => executeBatch(f.db, gate.gateId)).toThrow(/SYNTHETIC-BATCH-SOURCE/); expect(state()).toEqual(before)
  f.db.exec('DROP TRIGGER synthetic_batch_source_fail')
  const result = executeBatch(f.db, gate.gateId)!
  f.db.prepare('DELETE FROM pending_clarifications WHERE id=?').run(gate.gateId)
  registerIpc({ getDb: () => f.db, getAttachmentsDir: () => f.dir } as never, { dataDir: 'synthetic', dbFile: ':memory:' })
  for (const row of result.completed) expect(invoke('listTransactionAttachments', row.txId).items.map((r: any) => r.ref)).toEqual(['one.png', 'two.png'])
})
