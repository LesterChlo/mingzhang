// Real index + encrypted synthetic rollback + real SecretsStore; only Electron/Engine/IPC are isolated.
// Uppercase physical-name identity applies to Windows; the lowercase control also runs elsewhere.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import Database from 'better-sqlite3-multiple-ciphers'
import { schemaSql } from './helpers'
import { runMigrations } from '../src/main/db/migrations'
import { seed } from '../src/main/db/seed'

const state = vi.hoisted(() => ({ data: '', startup: null as Promise<unknown> | null, windows: [] as any[], recover: vi.fn() }))
vi.mock('electron', () => ({
  app: {
    isPackaged: false, setName: vi.fn(), requestSingleInstanceLock: () => true,
    getPath: () => join(state.data, 'synthetic-profile'), on: vi.fn(), quit: vi.fn(),
    whenReady: () => ({ then: (ready: () => unknown) => {
      const pending = Promise.resolve().then(ready); void pending.catch(() => {})
      return { catch: (failed: (error: unknown) => unknown) => { state.startup = pending.catch(failed); return state.startup } }
    } }),
  },
  BrowserWindow: class {
    html = ''; destroyed = false
    webContents = { send: vi.fn(), on: vi.fn(), setWindowOpenHandler: vi.fn() }
    constructor(readonly options: any) { state.windows.push(this) }
    on() { return this } loadFile() {} loadURL(url: string) { this.html = decodeURIComponent(url.split(',').slice(1).join(',')); return Promise.resolve() }
    isDestroyed() { return this.destroyed } destroy() { this.destroyed = true }
    static getAllWindows() { return state.windows.filter(w => !w.destroyed) }
  },
  ipcMain: { handle: vi.fn() }, nativeTheme: { themeSource: 'system', shouldUseDarkColors: false }, shell: { openPath: vi.fn() },
  safeStorage: { isEncryptionAvailable: () => true, encryptString: (value: string) => Buffer.from(`CASE:${value}`),
    decryptString: (bytes: Buffer) => { const value = bytes.toString(); if (!value.startsWith('CASE:')) throw Error('SYNTHETIC ONLY'); return value.slice(5) } },
}))
vi.mock('../src/main/engine/engine', () => ({ Engine: class { async dispose() {} async start() {} startupReport() {} } }))
vi.mock('../src/main/ipc', () => ({ registerIpc: vi.fn() }))
vi.mock('../src/main/ipc-settings', () => ({ registerSettingsIpc: vi.fn() }))
vi.mock('../src/main/domain/backup', async () => {
  const actual = await vi.importActual<any>('../src/main/domain/backup')
  return { ...actual, recoverInterruptedRestore: (...args: any[]) => { state.recover(...args); return actual.recoverInterruptedRestore(...args) } }
})
beforeEach(() => {
  vi.resetModules(); state.startup = null; state.windows.length = 0; state.recover.mockClear()
  state.data = mkdtempSync(join(tmpdir(), 'mz-startup-case-')); mkdirSync(join(state.data, 'secrets'))
  vi.stubEnv('MZ_DATA_DIR', state.data)
})
afterEach(() => { vi.unstubAllEnvs() })
function disk() {
  const walk = (dir: string, prefix = ''): { path: string; hash: string }[] =>
    readdirSync(dir, { withFileTypes: true }).flatMap(entry => {
      const path = prefix + entry.name, file = join(dir, entry.name)
      return entry.isDirectory() ? walk(file, path + '/') : [{ path, hash: createHash('sha256').update(readFileSync(file)).digest('hex') }]
    })
  return walk(state.data).sort((a, b) => a.path.localeCompare(b.path))
}
describe('startup physical recovery evidence preserves files before any migration', () => {
  for (const base of ['mingzhang.db', 'MINGZHANG.DB']) {
    it.runIf(base === 'mingzhang.db' || process.platform === 'win32')(`missing key with ${base} recovery slots refuses without mutation`, async () => {
      const target = join(state.data, 'mingzhang.db'), physical = (suffix: string) => join(state.data, base + suffix)
      const db = new Database(physical('.restore-rollback'))
      try {
        db.pragma(`key = "x'${'91'.repeat(32)}'"`); db.pragma("cipher='chacha20'")
        db.exec(schemaSql()); runMigrations(db); seed(db)
      } finally { db.close() }
      expect(readFileSync(physical('.restore-rollback')).subarray(0, 16).toString()).not.toBe('SQLite format 3\0')
      writeFileSync(physical('.restore-forward'), readFileSync(physical('.restore-rollback')))
      writeFileSync(physical('.restore-candidate-case'), 'SYNTHETIC CANDIDATE')
      writeFileSync(physical('.restore-journal.json'), JSON.stringify({ phase: 'rolling-back', target,
        rollback: target + '.restore-rollback', forward: target + '.restore-forward', candidate: target + '.restore-candidate-case',
        createdAt: '2001-02-03T04:05:06Z', pid: 424242 }))
      writeFileSync(join(state.data, 'config.json'), JSON.stringify({ version: 1, theme: 'light', onboarded: true,
        provider: { id: 'case-offline', name: 'synthetic', baseUrl: 'http://127.0.0.1:1/v1', model: 'none' } }))
      writeFileSync(join(state.data, 'secrets', 'provider-key'), 'CASE:SYNTHETIC-NO-LIVE-CREDENTIAL')
      expect(existsSync(target)).toBe(false)
      expect(existsSync(target + '.restore-journal.json')).toBe(true) // Prove real filesystem identity, not a mocked listing.
      expect(existsSync(join(state.data, 'secrets', 'db.key'))).toBe(false)
      const before = disk()
      await import('../src/main/index'); await state.startup
      const failure = state.windows.find(w => !w.options.webPreferences.preload)
      expect(failure).toBeDefined(); expect(failure.html).toContain('密钥')
      expect(state.recover).not.toHaveBeenCalled()
      expect(disk()).toEqual(before) // Includes exact names/bytes of all recovery slots, config and legacy provider key.
      expect(existsSync(target)).toBe(false)
      expect(existsSync(join(state.data, 'secrets', 'db.key'))).toBe(false)
      expect(existsSync(join(state.data, 'secrets', 'provider-key_case-offline'))).toBe(false)
    })
  }
})
