// 执行真实 index.ts 的启动链；Electron/初始化依赖必须 mock，禁止启动真实 GUI 或 profile。
// 账本路径全部来自 os.tmpdir() 下的合成目录；视觉模块只 mock 接口，不修改页面。
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

const state = vi.hoisted(() => ({
  handlers: new Map<string, Array<() => void>>(),
  windows: [] as Array<ReturnType<typeof makeWindow>>,
  events: [] as string[],
  startup: null as Promise<unknown> | null,
  paths: null as Record<string, string | boolean> | null,
  quit: vi.fn(),
  mainConstructed: vi.fn(),
  resolvePaths: vi.fn(),
  requireAvailable: vi.fn(),
  openLedger: vi.fn(),
  initSchema: vi.fn(),
  seed: vi.fn(),
  registerIpc: vi.fn(),
  registerSettingsIpc: vi.fn(),
  recover: vi.fn(),
  snapshot: vi.fn(),
  sweep: vi.fn(),
  dispose: vi.fn(),
  dbClose: vi.fn(),
  showFailure: vi.fn(),
}))

function emitApp(event: string): void {
  for (const listener of state.handlers.get(event) ?? []) listener()
}

function makeWindow(kind: 'main' | 'failure') {
  const handlers = new Map<string, Array<() => void>>()
  const window = {
    kind,
    destroyed: false,
    webContents: { send: vi.fn() },
    loadURL: vi.fn(),
    loadFile: vi.fn(),
    isDestroyed: () => window.destroyed,
    isMinimized: vi.fn(() => true),
    restore: vi.fn(),
    focus: vi.fn(),
    on: (event: string, listener: () => void) => {
      const listeners = handlers.get(event) ?? []
      listeners.push(listener)
      handlers.set(event, listeners)
      return window
    },
    destroy: vi.fn(() => {
      state.events.push(`destroy-${kind}`)
      window.destroyed = true
      for (const listener of handlers.get('closed') ?? []) listener()
      if (state.windows.every((item) => item.destroyed)) emitApp('window-all-closed')
    }),
    close: vi.fn(() => window.destroy()),
  }
  state.windows.push(window)
  return window
}

vi.mock('electron', () => ({
  app: {
    setName: vi.fn(),
    requestSingleInstanceLock: () => true,
    quit: state.quit,
    getPath: () => join(state.paths!.dataDir as string, 'synthetic-appdata'),
    on: (event: string, listener: () => void) => {
      const listeners = state.handlers.get(event) ?? []
      listeners.push(listener)
      state.handlers.set(event, listeners)
    },
    whenReady: () => ({
      then: (ready: () => unknown) => {
        const pending = Promise.resolve().then(ready)
        state.startup = pending
        // 基线缺少 catch 时仅观察 rejection，避免 RED 本身产生 unhandled rejection。
        void pending.catch(() => {})
        return {
          catch: (failed: (error: unknown) => unknown) => {
            state.startup = pending.catch(failed)
            return state.startup
          },
        }
      },
    }),
  },
  BrowserWindow: class {
    constructor(options: unknown) {
      state.mainConstructed(options)
      return makeWindow('main')
    }
    static getAllWindows() { return state.windows.filter((window) => !window.destroyed) }
  },
  ipcMain: { handle: vi.fn() },
  nativeTheme: { themeSource: 'system' },
}))
vi.mock('../src/main/paths', () => ({ resolvePaths: state.resolvePaths }))
vi.mock('../src/main/secrets/store', () => ({
  SecretsStore: class {
    requireAvailable = state.requireAvailable
    get = () => 'ef'.repeat(32)
  },
  migrateLegacyProviderKey: vi.fn(),
}))
vi.mock('../src/main/config/store', () => ({
  ConfigStore: class {
    load() { return { theme: 'light', onboarded: false, mock: false, activeProviderId: null } }
    save = vi.fn()
  },
  normalizeTheme: () => 'light',
}))
vi.mock('../src/main/db/connection', () => ({ openLedger: state.openLedger, initSchemaIfEmpty: state.initSchema }))
vi.mock('../src/main/db/seed', () => ({ seed: state.seed }))
vi.mock('../src/main/engine/engine', () => ({
  Engine: class {
    dispose = state.dispose
    start = vi.fn()
    startupReport = vi.fn()
  },
}))
vi.mock('../src/main/ipc', () => ({ registerIpc: state.registerIpc }))
vi.mock('../src/main/ipc-settings', () => ({ registerSettingsIpc: state.registerSettingsIpc }))
vi.mock('../src/main/domain/backup', () => ({
  recoverInterruptedRestore: state.recover,
  autoSnapshotIfNeeded: state.snapshot,
  sweepPlainResidues: state.sweep,
}))
vi.mock('../src/main/domain/restore-gate', () => ({ globalRestoreGate: {} }))
vi.mock('../src/main/startup-failure', () => ({ showStartupFailure: state.showFailure }))

beforeEach(() => {
  vi.resetModules()
  vi.clearAllMocks()
  state.handlers.clear()
  state.windows.length = 0
  state.events.length = 0
  state.startup = null
  const dataDir = mkdtempSync(join(tmpdir(), 'mz-startup-wiring-'))
  state.paths = {
    dataDir, portable: false,
    secretsDir: join(dataDir, 'secrets'), configFile: join(dataDir, 'config.json'),
    dbFile: join(dataDir, 'ledger.db'), backupsDir: join(dataDir, 'backups'),
    attachmentsDir: join(dataDir, 'attachments'), sessionsDir: join(dataDir, 'sessions'),
  }
  state.resolvePaths.mockReset().mockReturnValue(state.paths)
  state.requireAvailable.mockReset()
  state.registerIpc.mockReset()
  state.registerSettingsIpc.mockReset()
  state.snapshot.mockReset()
  state.dbClose.mockReset().mockImplementation(() => { state.events.push('db-close') })
  state.openLedger.mockReset().mockReturnValue({ close: state.dbClose })
  state.dispose.mockReset().mockImplementation(async () => {
    state.events.push('dispose-begin')
    await Promise.resolve()
    state.events.push('dispose-end')
  })
  state.showFailure.mockReset().mockImplementation(() => {
    state.events.push('show')
    const failure = makeWindow('failure')
    failure.on('closed', state.quit) // 与冻结视觉模块的退出契约一致。
    return failure
  })
})

async function startup(): Promise<void> {
  await import('../src/main/index')
  expect(state.startup).not.toBeNull()
  await state.startup!.catch(() => {})
}

function expectFailure(error: Error, dataDir: string | null) {
  expect(state.showFailure).toHaveBeenCalledExactlyOnceWith(error, dataDir)
  expect(state.showFailure.mock.calls[0][0]).toBe(error)
  expect(state.quit).not.toHaveBeenCalled()
  const failure = state.windows.find((window) => window.kind === 'failure')!
  expect(failure.loadFile).not.toHaveBeenCalled()
  expect(failure.loadURL).not.toHaveBeenCalled()
  emitApp('second-instance')
  expect(failure.restore).toHaveBeenCalledTimes(1)
  expect(failure.focus).toHaveBeenCalledTimes(1)
  return failure
}

describe('启动失败主进程接线', () => {
  it.each(['paths', 'safe-storage'] as const)('%s 提前失败：显示原始原因，第二实例聚焦错误窗而非加载主 renderer', async (stage) => {
    const error = new Error(`synthetic ${stage} startup failure`)
    if (stage === 'paths') state.resolvePaths.mockImplementation(() => { throw error })
    else state.requireAvailable.mockImplementation(() => { throw error })
    await startup()
    expectFailure(error, stage === 'paths' ? null : state.paths!.dataDir as string)
    expect(state.mainConstructed).not.toHaveBeenCalled()
    expect(state.openLedger).not.toHaveBeenCalled()
    expect(state.dispose).not.toHaveBeenCalled()
    expect(state.dbClose).not.toHaveBeenCalled()
    await expect(state.startup).resolves.toBeUndefined()
  })

  it('初始化已建立 Engine 与 db 后失败：先 await dispose 再关闭 db，退出不重复清理', async () => {
    const error = new Error('synthetic IPC registration failure')
    state.registerIpc.mockImplementation(() => { throw error })
    await startup()
    expectFailure(error, state.paths!.dataDir as string)
    expect(state.events).toEqual(['dispose-begin', 'dispose-end', 'db-close', 'show'])
    expect(state.registerIpc.mock.calls[0][0].engines.tryGet()).toBeNull()
    expect(() => emitApp('before-quit')).not.toThrow()
    expect(state.dispose).toHaveBeenCalledTimes(1)
    expect(state.dbClose).toHaveBeenCalledTimes(1)
    expect(state.mainConstructed).not.toHaveBeenCalled()
    await expect(state.startup).resolves.toBeUndefined()
  })

  it('Engine/db 清理均失败仍显示原始启动原因，退出不再调用失败的资源', async () => {
    const error = new Error('synthetic original startup failure')
    state.registerIpc.mockImplementation(() => { throw error })
    state.dispose.mockRejectedValue(new Error('synthetic dispose failure'))
    state.dbClose.mockImplementation(() => { throw new Error('synthetic close failure') })
    await startup()
    expectFailure(error, state.paths!.dataDir as string)
    expect(state.registerIpc.mock.calls[0][0].engines.tryGet()).toBeNull()
    expect(() => emitApp('before-quit')).not.toThrow()
    expect(state.dispose).toHaveBeenCalledTimes(1)
    expect(state.dbClose).toHaveBeenCalledTimes(1)
    await expect(state.startup).resolves.toBeUndefined()
  })

  it('主窗已创建后失败：错误窗替换主窗，旧窗 closed 不清掉错误窗引用或提前退出', async () => {
    const error = new Error('synthetic settings IPC startup failure')
    state.registerSettingsIpc.mockImplementation(() => { throw error })
    await startup()
    const failure = expectFailure(error, state.paths!.dataDir as string)
    const main = state.windows.find((window) => window.kind === 'main')!
    expect(main.destroy).toHaveBeenCalledTimes(1)
    expect(main.focus).not.toHaveBeenCalled()
    expect(state.windows.filter((window) => !window.destroyed)).toEqual([failure])
    expect(state.dispose).toHaveBeenCalledTimes(2) // startEngine 的既有清理 + 失败出口清理。
    expect(state.dbClose).toHaveBeenCalledTimes(1)
    expect(state.events).toEqual(['dispose-begin', 'dispose-end', 'dispose-begin', 'dispose-end', 'db-close', 'show', 'destroy-main'])
    expect(state.quit).not.toHaveBeenCalled()
    await expect(state.startup).resolves.toBeUndefined()
  })
})
