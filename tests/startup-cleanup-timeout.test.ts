// 合成启动环境；执行真实 index catch，不启动 GUI 或接触真实数据。
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createServer, type Server } from 'node:http'
import { connect, type Socket } from 'node:net'

const state = vi.hoisted(() => ({
  startup: null as Promise<unknown> | null, handlers: new Map<string, (() => void)[]>(),
  windows: [] as any[], dataDir: '', ipc: null as any, quit: vi.fn(),
  original: new Error('SYNTHETIC ORIGINAL STARTUP FAILURE'), close: vi.fn(),
  cleanup: vi.fn<() => Promise<void>>(),
}))
function emit(event: string) { for (const fn of state.handlers.get(event) ?? []) fn() }
function makeWindow(kind: 'main' | 'failure', error?: unknown) {
  const listeners = new Map<string, (() => void)[]>()
  const window = {
    kind, error, destroyed: false, focus: vi.fn(), restore: vi.fn(), isMinimized: () => false,
    webContents: { send: vi.fn() }, loadFile: vi.fn(), loadURL: vi.fn(),
    isDestroyed: () => window.destroyed,
    on: (event: string, fn: () => void) => { const list = listeners.get(event) ?? []; list.push(fn); listeners.set(event, list); return window },
    destroy: () => { window.destroyed = true; for (const fn of listeners.get('closed') ?? []) fn(); if (state.windows.every(w => w.destroyed)) emit('window-all-closed') },
    close: () => window.destroy(),
  }
  state.windows.push(window)
  return window
}
vi.mock('electron', () => ({
  app: {
    setName: vi.fn(), requestSingleInstanceLock: () => true, getPath: () => join(state.dataDir, 'synthetic-appdata'),
    on: (event: string, fn: () => void) => { const list = state.handlers.get(event) ?? []; list.push(fn); state.handlers.set(event, list) },
    quit: () => { state.quit(); emit('before-quit') },
    whenReady: () => ({ then: (ready: () => unknown) => {
      const pending = Promise.resolve().then(ready); void pending.catch(() => {})
      return { catch: (failed: (error: unknown) => unknown) => { state.startup = pending.catch(failed); return state.startup } }
    } }),
  },
  BrowserWindow: class { constructor() { return makeWindow('main') } static getAllWindows() { return state.windows.filter(w => !w.destroyed) } },
  ipcMain: { handle: vi.fn() }, nativeTheme: { themeSource: 'system' },
}))
vi.mock('../src/main/paths', () => ({ resolvePaths: () => ({ dataDir: state.dataDir, dbFile: join(state.dataDir, 'ledger.db'), configFile: join(state.dataDir, 'config.json'), secretsDir: join(state.dataDir, 'secrets') }) }))
vi.mock('../src/main/secrets/store', () => ({ SecretsStore: class { requireAvailable() {} get() { return 'ab'.repeat(32) } }, migrateLegacyProviderKey: vi.fn() }))
vi.mock('../src/main/config/store', () => ({ ConfigStore: class { load() { return { theme: 'light', onboarded: false, mock: true } } }, normalizeTheme: () => 'light' }))
vi.mock('../src/main/db/connection', async () => ({ ...(await vi.importActual<any>('../src/main/db/connection')), openLedger: () => ({ close: state.close }), initSchemaIfEmpty: vi.fn() }))
vi.mock('../src/main/db/seed', () => ({ seed: vi.fn() }))
vi.mock('../src/main/engine/engine', () => ({ Engine: class {
  started = false
  async start() { this.started = true }
  dispose() { return this.started ? state.cleanup() : Promise.resolve() }
  startupReport() {}
} }))
vi.mock('../src/main/ipc', () => ({ registerIpc: (context: unknown) => { state.ipc = context } }))
vi.mock('../src/main/ipc-settings', () => ({ registerSettingsIpc: () => { throw state.original } }))
vi.mock('../src/main/domain/backup', () => ({ recoverInterruptedRestore: vi.fn(), autoSnapshotIfNeeded: vi.fn(), sweepPlainResidues: vi.fn() }))
vi.mock('../src/main/startup-failure', () => ({ showStartupFailure: (error: unknown) => makeWindow('failure', error) }))
beforeEach(() => {
  vi.resetModules(); state.handlers.clear(); state.windows.length = 0; state.startup = null; state.ipc = null
  state.dataDir = mkdtempSync(join(tmpdir(), 'mz-startup-cleanup-'))
  state.quit.mockReset(); state.close.mockReset(); state.cleanup.mockReset().mockImplementation(() => new Promise<void>(() => {}))
})
afterEach(() => { vi.useRealTimers() })
function failure() { return state.windows.find(w => w.kind === 'failure') }
async function launch() {
  await import('../src/main/index')
  await vi.waitFor(() => expect(state.cleanup).toHaveBeenCalledTimes(1))
}
async function exhaustBudget() { await vi.advanceTimersByTimeAsync(1000) }
function verifyExit() {
  expect(failure().error).toBe(state.original)
  expect(state.ipc.engines.tryGet()).toBeNull(); expect(state.ipc.getDb()).toBeNull()
  expect(() => state.ipc.engine).toThrow('引擎未就绪')
  expect(state.windows.filter(w => w.kind === 'main').every(w => w.destroyed)).toBe(true)
  emit('second-instance'); expect(failure().focus).toHaveBeenCalledTimes(1)
  failure().close(); expect(state.quit).toHaveBeenCalledTimes(1)
  emit('before-quit')
  expect(state.cleanup).toHaveBeenCalledTimes(1); expect(state.close).toHaveBeenCalledTimes(1)
}
describe('fatal startup cleanup has a bounded independent exit', () => {
  it('detaches both Engine and DB before awaiting disposal', async () => {
    vi.useFakeTimers(); await launch()
    try { expect(state.ipc.engines.tryGet()).toBeNull(); expect(state.ipc.getDb()).toBeNull() }
    finally { await exhaustBudget() }
  })
  it('never-settling disposal cannot consume more than the 1000ms budget', async () => {
    vi.useFakeTimers(); await launch(); await exhaustBudget()
    expect(failure()).toBeDefined(); verifyExit()
    await expect(state.startup).resolves.toBeUndefined(); expect(vi.getTimerCount()).toBe(0)
  })
  it.each(['resolve', 'reject'] as const)('late %s is consumed without reviving failed resources or an unhandled rejection', async kind => {
    let resolve!: () => void, reject!: (error: Error) => void
    state.cleanup.mockImplementation(() => new Promise<void>((yes, no) => { resolve = yes; reject = no }))
    const unhandled = vi.fn(); process.on('unhandledRejection', unhandled)
    vi.useFakeTimers()
    try {
      await launch(); await exhaustBudget(); expect(failure()).toBeDefined(); verifyExit()
      if (kind === 'resolve') resolve(); else reject(new Error('SYNTHETIC LATE DISPOSAL REJECTION'))
      await vi.advanceTimersByTimeAsync(1)
      await expect(state.startup).resolves.toBeUndefined()
      expect(unhandled).not.toHaveBeenCalled(); expect(failure().error).toBe(state.original)
      expect(state.ipc.engines.tryGet()).toBeNull(); expect(state.ipc.getDb()).toBeNull()
      expect(state.cleanup).toHaveBeenCalledTimes(1); expect(state.close).toHaveBeenCalledTimes(1)
      expect(vi.getTimerCount()).toBe(0)
    } finally { process.off('unhandledRejection', unhandled) }
  })
  it('normal disposal clears its deadline timer and closes DB once', async () => {
    state.cleanup.mockResolvedValue(undefined); vi.useFakeTimers()
    await launch(); await vi.advanceTimersByTimeAsync(0)
    await expect(state.startup).resolves.toBeUndefined(); verifyExit(); expect(vi.getTimerCount()).toBe(0)
  })
  it('disposal and independent DB-close exceptions do not replace the original reason', async () => {
    state.cleanup.mockRejectedValue(new Error('SYNTHETIC DISPOSAL FAILURE'))
    state.close.mockImplementation(() => { throw new Error('SYNTHETIC CLOSE FAILURE') })
    vi.useFakeTimers(); await launch(); await vi.advanceTimersByTimeAsync(0)
    await expect(state.startup).resolves.toBeUndefined(); verifyExit(); expect(vi.getTimerCount()).toBe(0)
  })
  it('real incomplete HTTP connection keeps server.close pending but not the error exit', async () => {
    const server: Server = createServer(); let socket: Socket | undefined
    const accepted = new Promise<void>(resolve => server.once('connection', () => resolve()))
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
    let cleanupSettled = false
    try {
      const address = server.address(); if (!address || typeof address === 'string') throw new Error('missing test server address')
      socket = connect(address.port, '127.0.0.1'); await accepted
      socket.write('POST /synthetic HTTP/1.1\r\nHost: localhost\r\nContent-Length: 1000\r\n\r\nx')
      state.cleanup.mockImplementation(() => new Promise<void>((resolve, reject) => server.close(error => {
        cleanupSettled = true; if (error) reject(error); else resolve()
      })))
      await launch(); await vi.waitFor(() => expect(failure()).toBeDefined(), { timeout: 1300 })
      expect(cleanupSettled).toBe(false); verifyExit(); await expect(state.startup).resolves.toBeUndefined()
    } finally {
      socket?.destroy(); server.closeAllConnections()
      if (server.listening) await new Promise<void>(resolve => server.close(() => resolve()))
    }
  })
})
