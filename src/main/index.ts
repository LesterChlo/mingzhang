// Electron 主进程入口：生命周期、窗口、单实例锁、模块装配。
// 启动顺序（决定记录 §6 / 硬约束 4）：safeStorage 可用性硬检查 → 数据目录 → 加密账本 → 引擎。

import { app, BrowserWindow, ipcMain, nativeTheme } from 'electron'
import { join } from 'node:path'
import { resolvePaths } from './paths'
import { SecretsStore, migrateLegacyProviderKey } from './secrets/store'
import { ConfigStore, normalizeTheme } from './config/store'
import { openLedger, initSchemaIfEmpty } from './db/connection'
import { seed } from './db/seed'
import { Engine } from './engine/engine'
import { registerIpc } from './ipc'
import { registerSettingsIpc } from './ipc-settings'
import { autoSnapshotIfNeeded, sweepPlainResidues, recoverInterruptedRestore } from './domain/backup'
import { createEngineRegistry } from './engine/registry'
import { globalRestoreGate } from './domain/restore-gate'
import type { ChatEvent } from '../shared/types'

app.setName('mingzhang')

// C·测试硬化：记录全部 IPC handler 通道，供巡检做“preload invoke ⊆ handler”对账（防静默丢 handler）
const registeredChannels = new Set<string>()
const rawHandle = ipcMain.handle.bind(ipcMain)
ipcMain.handle = ((channel: string, listener: unknown) => {
  registeredChannels.add(channel)
  return rawHandle(channel, listener as never)
}) as typeof ipcMain.handle
globalThis.__mzIpcChannels = registeredChannels

let win: BrowserWindow | null = null
const engines = createEngineRegistry<Engine>()
let db: ReturnType<typeof openLedger> | null = null
let paths: ReturnType<typeof resolvePaths> | null = null
let secrets: SecretsStore | null = null
let config: ConfigStore | null = null

function broadcast(evt: ChatEvent): void {
  if (win && !win.isDestroyed()) win.webContents.send('mz:chat-event', evt)
}

async function startEngine(): Promise<void> {
  const engine = engines.tryGet()
  if (!engine || !config || !secrets || !db || !paths) return
  await engine.dispose()
  const cfg = config.load()
  if (!cfg.mock && !cfg.activeProviderId) return // 未配置且未开 mock：主界面空态可浏览，引擎不起
  try {
    await engine.start()
  } catch (err) {
    // 引擎启动失败不阻塞应用（设置页可修）；如实上报
    broadcast({ type: 'error', payload: { message: `引擎启动失败：${(err as Error).message}` } })
  }
}

function createWindow(): void {
  win = new BrowserWindow({
    width: 1200,
    height: 820,
    title: '明账',
    backgroundColor: '#DCEFE4',
    autoHideMenuBar: true,
    webPreferences: {
      preload: join(import.meta.dirname, '../preload/index.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  })

  if (process.env.ELECTRON_RENDERER_URL) {
    win.loadURL(process.env.ELECTRON_RENDERER_URL)
  } else {
    win.loadFile(join(import.meta.dirname, '../renderer/index.html'))
  }
  win.on('closed', () => {
    win = null
  })
}

const gotLock = app.requestSingleInstanceLock()
if (!gotLock) {
  app.quit()
} else {
  app.on('second-instance', () => {
    if (win) {
      if (win.isMinimized()) win.restore()
      win.focus()
    }
  })

  app.whenReady().then(async () => {
    paths = resolvePaths()
    secrets = new SecretsStore(paths.secretsDir)
    // 密钥三条硬规矩的前提：safeStorage 可用，否则拒绝启动（不降级明文）
    secrets.requireAvailable()
    config = new ConfigStore(paths.configFile)
    // 原生标题栏跟随应用主题：Windows 深色系统 + 应用浅色主题时，默认的 system 口径会把
    // 标题栏画成黑条，与浅色界面割裂（用户实测反馈）。themeSource 合法值 system|light|dark，
    // 与应用主题枚举同口径，直接透传；须在 createWindow 之前设好，首帧才是对的。
    nativeTheme.themeSource = normalizeTheme(config.load().theme)
    // v1→v2 迁移落地 + 密钥按 provider 改名（安全序：set 新名 → 读回校验 → 才删旧名；失败保旧）
    {
      const migrated = config.load()
      if (migrated.onboarded) {
        config.save(migrated)
        migrateLegacyProviderKey(secrets, migrated.activeProviderId)
      }
    }

    // 崩溃窗口守门：openLedger 之前必须先完成中断恢复（恢复原库或候选），绝不静默新建空账本。
    // B1：只有启动恢复确认收敛后，才允许 openLedger；openLedger 已存在异常库直接拒绝。
    // 收敛后 openLedger 仍做生产 schema 校验；校验通过（新库为空则建表）后才 seed。
    {
      const dek = secrets.get('db.key')
      recoverInterruptedRestore(paths.dbFile, dek ? { dekHex: dek } : undefined)
    }
    db = openLedger(paths.dbFile, secrets)
    // 收敛确认后才允许初始化：已存在库先完整校验；纯新库才建表/seed。
    initSchemaIfEmpty(db)
    seed(db)

    engines.set(new Engine(db, paths, config, secrets, broadcast))

    registerIpc(
      {
        config,
        secrets,
        engines,
        get engine(): Engine {
          return engines.get()
        },
        getWindowContents: () => (win && !win.isDestroyed() ? win.webContents : null),
        restartEngine: startEngine,
        getAttachmentsDir: () => paths?.attachmentsDir ?? null,
        getDb: () => db,
      },
      { dataDir: paths.dataDir, dbFile: paths.dbFile },
    )

    createWindow()
    await startEngine()
    // A7 启动检查：上月月报没生成过则补一次（只记 agent_runs，不打扰）
    engines.tryGet()?.startupReport()
    // 本机快照：超过 24h 自动补一份（决定记录 §6 备份①，防误操作）
    autoSnapshotIfNeeded(db, paths.backupsDir)
    // 清扫历次导出/恢复中断留下的临时明文库（*.plain）
    sweepPlainResidues(paths.backupsDir)

    registerSettingsIpc(
      {
        config,
        restartEngine: startEngine,
        getDb: () => db,
        dataDir: paths.dataDir,
        dbFile: paths.dbFile,
        backupsDir: paths.backupsDir,
        attachmentsDir: paths.attachmentsDir,
        portable: paths.portable,
        newConversation: () => engines.get().newConversation(),
        resumeSession: (path) => engines.get().resumeSession(path),
        closeDbForRestore: async () => {
          await engines.tryGet()?.dispose()
          db?.close()
          db = null
        },
        restartEngineForRestore: async () => {
          if (!db) {
            db = openLedger(paths!.dbFile, secrets!)
            initSchemaIfEmpty(db)
            seed(db)
            engines.set(new Engine(db, paths!, config!, secrets!, broadcast))
          }
          await startEngine()
        },
        secrets,
        appDataDir: app.getPath('appData'),
        sessionsDir: paths.sessionsDir,
        listArchivedSessions: () => engines.get().listArchivedSessions(),
        restoreGate: globalRestoreGate,
      },
    )

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow()
    })
  })

  app.on('window-all-closed', () => {
    app.quit()
  })

  app.on('before-quit', () => {
    engines.tryGet()?.dispose()
    db?.close()
  })
}
