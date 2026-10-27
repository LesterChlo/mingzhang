// Regression for review findings: real startup order, synthetic disk only.
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import Database from 'better-sqlite3-multiple-ciphers'
import { schemaSql } from './helpers'
import { runMigrations } from '../src/main/db/migrations'
import { seed } from '../src/main/db/seed'

const state = vi.hoisted(() => ({
  data: '', profile: '', startup: null as Promise<unknown> | null,
  handlers: new Map<string, (() => void)[]>(), windows: [] as any[],
  failSettings: false, blockCleanup: false, disposalError: false, disposals: 0,
  engineStarted: false, quitCalls: 0, db: null as any,
}))
function emit(event: string) { for (const fn of state.handlers.get(event) ?? []) fn() }
function windowOf(options: any) {
  const listeners = new Map<string, (() => void)[]>()
  const window = {
    kind: options.webPreferences.preload ? 'main' : 'failure', html: '', destroyed: false, focused: 0,
    webContents: { send: vi.fn(), on: vi.fn(), setWindowOpenHandler: vi.fn() },
    loadFile: vi.fn(), loadURL: (url: string) => { window.html = decodeURIComponent(url.split(',', 2)[1] ?? ''); return Promise.resolve() },
    isDestroyed: () => window.destroyed, isMinimized: () => false,
    restore: vi.fn(), focus: () => { window.focused++ },
    on: (event: string, fn: () => void) => { const list = listeners.get(event) ?? []; list.push(fn); listeners.set(event, list); return window },
    destroy: () => { window.destroyed = true; for (const fn of listeners.get('closed') ?? []) fn(); if (state.windows.every(w => w.destroyed)) emit('window-all-closed') },
    close: () => window.destroy(),
  }
  state.windows.push(window); return window
}
vi.mock('electron', () => ({
  app: {
    isPackaged: false, setName: vi.fn(), requestSingleInstanceLock: () => true,
    getPath: (name: string) => name === 'userData' ? state.profile : join(state.profile, 'synthetic-appdata'),
    on: (event: string, fn: () => void) => { const list = state.handlers.get(event) ?? []; list.push(fn); state.handlers.set(event, list) },
    quit: () => { state.quitCalls++; emit('before-quit') },
    whenReady: () => ({ then: (ready: () => unknown) => {
      const pending = Promise.resolve().then(ready); state.startup = pending; void pending.catch(() => {})
      return { catch: (failed: (error: unknown) => unknown) => { state.startup = pending.catch(failed); return state.startup } }
    } }),
  },
  BrowserWindow: class { constructor(options: any) { return windowOf(options) } static getAllWindows() { return state.windows.filter(w => !w.destroyed) } },
  ipcMain: { handle: vi.fn() }, nativeTheme: { themeSource: 'system', shouldUseDarkColors: false },
  shell: { openPath: vi.fn(async () => '') },
  safeStorage: {
    isEncryptionAvailable: () => true,
    encryptString: (text: string) => Buffer.from(`STARTUP-TEST:${text}`),
    decryptString: (buffer: Buffer) => { const text = buffer.toString(); if (!text.startsWith('STARTUP-TEST:')) throw new Error('synthetic inaccessible key'); return text.slice(13) },
  },
}))
vi.mock('../src/main/engine/engine', () => ({ Engine: class {
  async start() { state.engineStarted = true }
  async dispose() {
    state.disposals++
    if (state.failSettings && state.engineStarted) {
      if (state.disposalError) throw new Error('SYNTHETIC DISPOSAL ERROR')
      if (state.blockCleanup) await new Promise<void>(() => {})
    }
  }
  startupReport() {}
} }))
vi.mock('../src/main/ipc', () => ({ registerIpc: vi.fn() }))
vi.mock('../src/main/ipc-settings', () => ({ registerSettingsIpc: () => { if (state.failSettings) throw new Error('SYNTHETIC ORIGINAL STARTUP REASON') } }))
vi.mock('../src/main/db/connection', async () => {
  const actual = await vi.importActual<any>('../src/main/db/connection')
  return { ...actual, openLedger: (...args: any[]) => { state.db = actual.openLedger(...args); return state.db } }
})
beforeEach(() => {
  vi.resetModules(); state.handlers.clear(); state.windows.length = 0; state.startup = null
  const root = mkdtempSync(join(tmpdir(), 'mz-startup-preservation-'))
  state.data = join(root, 'data'); state.profile = join(root, 'profile')
  mkdirSync(state.data); mkdirSync(state.profile); mkdirSync(join(state.data, 'secrets'))
  process.env.MZ_DATA_DIR = state.data
  state.failSettings = false; state.blockCleanup = false; state.disposalError = false
  state.disposals = 0; state.engineStarted = false; state.quitCalls = 0; state.db = null
})
const KEY = '91'.repeat(32)
function encrypted(file: string) {
  const db = new Database(file)
  try { db.pragma(`key = "x'${KEY}'"`); db.pragma("cipher='chacha20'"); db.exec(schemaSql()); runMigrations(db); seed(db) }
  finally { db.close() }
}
async function runStartup() { await import('../src/main/index'); await state.startup }
function failure() { return state.windows.find(w => w.kind === 'failure') }
function recoveryScene(phase: 'replacing' | 'rolling-back', targetPresent: boolean, badKey: boolean) {
  const target = join(state.data, 'mingzhang.db'), candidate = target + '.restore-candidate-synthetic', rollback = target + '.restore-rollback', forward = target + '.restore-forward'
  encrypted(rollback)
  if (targetPresent) writeFileSync(target, readFileSync(rollback))
  writeFileSync(candidate, 'SYNTHETIC RECOVERY CANDIDATE')
  if (phase === 'rolling-back') writeFileSync(forward, readFileSync(rollback))
  const journal = target + '.restore-journal.json'
  writeFileSync(journal, JSON.stringify({ phase, candidate, target, rollback, forward, createdAt: '2001-02-03T04:05:06Z', pid: 424242 }))
  const key = join(state.data, 'secrets', 'db.key')
  if (badKey) writeFileSync(key, 'SYNTHETIC UNREADABLE KEY')
  const files = [target, candidate, rollback, forward, journal, key]
  return files.map(file => ({ file, bytes: existsSync(file) ? readFileSync(file) : null }))
}
function preserved(snapshots: ReturnType<typeof recoveryScene>) {
  for (const { file, bytes } of snapshots) {
    expect(existsSync(file), file).toBe(bytes !== null)
    if (bytes) expect(readFileSync(file), file).toEqual(bytes)
  }
  expect(state.db).toBeNull()
}
describe('startup key check precedes every recovery mutation', () => {
  it.each([
    ['replacing', true, false], ['replacing', true, true],
    ['replacing', false, false], ['replacing', false, true],
    ['rolling-back', true, false], ['rolling-back', true, true],
    ['rolling-back', false, false], ['rolling-back', false, true],
  ] as const)('%s target=%s unreadable=%s refuses without touching any artifact', async (phase, targetPresent, badKey) => {
    const before = recoveryScene(phase, targetPresent, badKey)
    await runStartup()
    expect(failure()).toBeDefined(); expect(failure().html).toContain('密钥')
    preserved(before); emit('second-instance'); expect(failure().focused).toBe(1)
    failure().close(); expect(state.quitCalls).toBeGreaterThan(0); preserved(before)
  })
  it('readable key still permits real first startup and existing encrypted ledger', async () => {
    const file = join(state.data, 'mingzhang.db'); encrypted(file)
    writeFileSync(join(state.data, 'secrets', 'db.key'), `STARTUP-TEST:${KEY}`)
    try { await runStartup(); expect(failure()).toBeUndefined(); expect(state.db.open).toBe(true) }
    finally { state.db?.close() }
  })
})
describe('fatal startup output cannot depend on async disposal', () => {
  it.each(['pending', 'reject'] as const)('original reason and safe close remain reachable with %s disposal', async kind => {
    state.failSettings = true; state.blockCleanup = kind === 'pending'; state.disposalError = kind === 'reject'
    writeFileSync(join(state.data, 'config.json'), JSON.stringify({ version: 2, onboarded: false, theme: 'light', mock: true, activeProviderId: null, providers: [] }))
    await import('../src/main/index')
    // Observe the original error UI before releasing any stalled cleanup promise.
    await vi.waitFor(() => expect(failure()).toBeDefined(), { timeout: 1500 })
    expect(failure().html).toContain('SYNTHETIC ORIGINAL STARTUP REASON')
    expect(state.windows.filter(w => w.kind === 'main').every(w => w.destroyed)).toBe(true)
    emit('second-instance'); expect(failure().focused).toBe(1)
    const disposals = state.disposals
    failure().close(); expect(state.quitCalls).toBeGreaterThan(0)
    expect(state.disposals).toBe(disposals) // detached engine must not be disposed again by before-quit.
    await vi.waitFor(() => expect(state.db.open).toBe(false), { timeout: 3500 })
    await expect(state.startup).resolves.toBeUndefined()
  })
})
