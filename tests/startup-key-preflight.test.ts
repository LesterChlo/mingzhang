// 密钥预检必须走真实 index 启动序；Electron 仅隔离 GUI/DPAPI，磁盘与恢复实现均真实。
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import Database from 'better-sqlite3-multiple-ciphers'
import { schemaSql } from './helpers'
import { runMigrations } from '../src/main/db/migrations'
import { seed } from '../src/main/db/seed'

const state = vi.hoisted(() => ({
  data: '', startup: null as Promise<unknown> | null, db: null as any, ipc: null as any,
  windows: [] as any[], handlers: new Map<string, (() => void)[]>(), recover: vi.fn(),
}))
vi.mock('electron', () => ({
  app: {
    isPackaged: false, setName: vi.fn(), requestSingleInstanceLock: () => true,
    getPath: () => join(state.data, 'synthetic-profile'), quit: vi.fn(),
    on: (event: string, fn: () => void) => { const list = state.handlers.get(event) ?? []; list.push(fn); state.handlers.set(event, list) },
    whenReady: () => ({ then: (ready: () => unknown) => {
      const pending = Promise.resolve().then(ready); void pending.catch(() => {})
      return { catch: (failed: (error: unknown) => unknown) => { state.startup = pending.catch(failed); return state.startup } }
    } }),
  },
  BrowserWindow: class {
    destroyed = false; html = ''; webContents = { send: vi.fn(), on: vi.fn(), setWindowOpenHandler: vi.fn() }
    constructor(readonly options: any) { state.windows.push(this) }
    on() { return this } loadFile() {} loadURL(url: string) { this.html = decodeURIComponent(url.split(',', 2)[1] ?? ''); return Promise.resolve() }
    isDestroyed() { return this.destroyed } destroy() { this.destroyed = true }
    static getAllWindows() { return state.windows.filter(w => !w.destroyed) }
  },
  ipcMain: { handle: vi.fn() }, nativeTheme: { themeSource: 'system', shouldUseDarkColors: false }, shell: { openPath: vi.fn() },
  safeStorage: { isEncryptionAvailable: () => true,
    encryptString: (value: string) => Buffer.from(`PREFLIGHT:${value}`),
    decryptString: (bytes: Buffer) => { const value = bytes.toString(); if (!value.startsWith('PREFLIGHT:')) throw Error('SYNTHETIC UNREADABLE KEY'); return value.slice(10) },
  },
}))
vi.mock('../src/main/engine/engine', () => ({ Engine: class { async dispose() {} async start() {} startupReport() {} } }))
vi.mock('../src/main/ipc', () => ({ registerIpc: (context: unknown) => { state.ipc = context } }))
vi.mock('../src/main/ipc-settings', () => ({ registerSettingsIpc: vi.fn() }))
vi.mock('../src/main/db/connection', async () => {
  const actual = await vi.importActual<any>('../src/main/db/connection')
  return { ...actual, openLedger: (...args: any[]) => { state.db = actual.openLedger(...args); return state.db } }
})
vi.mock('../src/main/domain/backup', async () => {
  const actual = await vi.importActual<any>('../src/main/domain/backup')
  return { ...actual, recoverInterruptedRestore: (...args: any[]) => { state.recover(...args); return actual.recoverInterruptedRestore(...args) } }
})
beforeEach(() => {
  vi.resetModules(); state.windows.length = 0; state.handlers.clear(); state.startup = null; state.db = null; state.ipc = null; state.recover.mockClear()
  state.data = mkdtempSync(join(tmpdir(), 'mz-startup-preflight-')); mkdirSync(join(state.data, 'secrets'))
  vi.stubEnv('MZ_DATA_DIR', state.data)
})
afterEach(() => { state.db?.close(); vi.unstubAllEnvs() })
const KEY = 'bc'.repeat(32)
function encrypted(file: string) {
  const db = new Database(file)
  try {
    db.pragma(`key = "x'${KEY}'"`); db.pragma("cipher='chacha20'")
    db.exec(schemaSql()); runMigrations(db); seed(db)
    db.prepare('INSERT INTO settings(key,value,updated_at) VALUES (?,?,?)').run('synthetic-startup-marker', 'PRESERVED', '2001-02-03T04:05:06Z')
  } finally { db.close() }
}
function snapshotFiles() {
  const files = readdirSync(state.data).filter(name => name.startsWith('mingzhang.db')).map(name => join(state.data, name))
  const key = join(state.data, 'secrets', 'db.key')
  if (existsSync(key)) files.push(key)
  return files.map(file => ({ file, bytes: readFileSync(file) }))
}
async function startup() { await import('../src/main/index'); await state.startup }
function failure() { return state.windows.find(w => !w.options.webPreferences.preload) }
describe('real startup key preflight evidence and positive controls', () => {
  it.each([
    '', '-wal', '-shm', '-journal', '.restore-rollback', '.restore-forward',
    '.restore-candidate-orphan', '.restore-journal.json', '.restore-journal.json.tmp-synthetic', '.restore-residues.json',
  ])('missing key with %s evidence never enters recovery or creates a key/ledger', async suffix => {
    const target = join(state.data, 'mingzhang.db')
    writeFileSync(target + suffix, 'SYNTHETIC EVIDENCE')
    const before = snapshotFiles()
    await startup()
    expect(failure()).toBeDefined(); expect(failure().html).toContain('密钥')
    expect(state.recover).not.toHaveBeenCalled(); expect(state.db).toBeNull()
    expect(snapshotFiles()).toEqual(before); expect(existsSync(join(state.data, 'secrets', 'db.key'))).toBe(false)
    if (suffix) expect(existsSync(target)).toBe(false)
  })
  it.each(['UNREADABLE', 'PREFLIGHT:not-a-64-hex-dek', 'PREFLIGHT:' + 'a'.repeat(63)])('invalid existing key %s refuses before any recovery call, even in an otherwise empty directory', async value => {
    writeFileSync(join(state.data, 'secrets', 'db.key'), value)
    const before = snapshotFiles()
    await startup()
    expect(failure()).toBeDefined(); expect(failure().html).toContain('密钥')
    expect(state.recover).not.toHaveBeenCalled(); expect(state.db).toBeNull(); expect(snapshotFiles()).toEqual(before)
    expect(existsSync(join(state.data, 'mingzhang.db'))).toBe(false)
  })
  it('key rejection still uses the saved application theme before opening the failure window', async () => {
    writeFileSync(join(state.data, 'config.json'), JSON.stringify({ version: 2, onboarded: false, theme: 'dark', mock: false, activeProviderId: null, providers: [] }))
    writeFileSync(join(state.data, 'mingzhang.db'), 'SYNTHETIC EVIDENCE')
    await startup()
    expect(failure()).toBeDefined(); expect(state.recover).not.toHaveBeenCalled()
    expect((await import('electron')).nativeTheme.themeSource).toBe('dark')
  })
  it('pure first startup creates a valid DEK and keeps it byte-identical on restart', async () => {
    await startup(); expect(failure()).toBeUndefined(); expect(state.db.open).toBe(true)
    const key = readFileSync(join(state.data, 'secrets', 'db.key'))
    expect(key.toString()).toMatch(/^PREFLIGHT:[0-9a-f]{64}$/)
    state.db.close(); state.db = null; vi.resetModules(); state.windows.length = 0
    await startup(); expect(failure()).toBeUndefined(); expect(state.db.open).toBe(true)
    expect(readFileSync(join(state.data, 'secrets', 'db.key'))).toEqual(key)
  })
  it.each([['replacing', true], ['replacing', false], ['rolling-back', true], ['rolling-back', false]] as const)('correct DEK permits real %s recovery, target=%s, and another startup', async (phase, present) => {
    const target = join(state.data, 'mingzhang.db'), rollback = target + '.restore-rollback', forward = target + '.restore-forward', candidate = target + '.restore-candidate-synthetic'
    encrypted(rollback)
    if (present) writeFileSync(target, readFileSync(rollback))
    if (phase === 'rolling-back') writeFileSync(forward, readFileSync(rollback))
    writeFileSync(candidate, 'SYNTHETIC CANDIDATE')
    writeFileSync(target + '.restore-journal.json', JSON.stringify({ phase, target, candidate, rollback, forward, createdAt: '2001-02-03T04:05:06Z', pid: 424242 }))
    const key = Buffer.from(`PREFLIGHT:${KEY}`); writeFileSync(join(state.data, 'secrets', 'db.key'), key)
    await startup(); expect(failure()).toBeUndefined(); expect(state.db.open).toBe(true)
    expect(state.recover).toHaveBeenCalledExactlyOnceWith(target, { dekHex: KEY })
    expect(state.db.prepare('SELECT value FROM settings WHERE key=?').get('synthetic-startup-marker')).toEqual({ value: 'PRESERVED' })
    expect(existsSync(candidate)).toBe(false); expect(existsSync(target + '.restore-journal.json')).toBe(false)
    expect(readFileSync(join(state.data, 'secrets', 'db.key'))).toEqual(key)
    state.db.close(); state.db = null; vi.resetModules(); state.windows.length = 0
    await startup(); expect(failure()).toBeUndefined(); expect(state.db.open).toBe(true)
    expect(state.db.prepare('SELECT value FROM settings WHERE key=?').get('synthetic-startup-marker')).toEqual({ value: 'PRESERVED' })
    expect(readFileSync(join(state.data, 'secrets', 'db.key'))).toEqual(key)
  })
})
