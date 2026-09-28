// 设置相关 IPC：预算、数据目录信息、附件清理、快照、跨机口令包、新开对话。
// 与账务 IPC（ipc.ts）分开装配，避免单文件膨胀。
// 「重新配置模型」不经过这里：纯渲染层状态切换，向导完成后走已有的 completeOnboarding。

import { ipcMain, dialog, app } from 'electron'
import { readdirSync, statSync, rmSync, existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Database } from 'better-sqlite3-multiple-ciphers'
import type { SettingsInfoDTO } from '../shared/types'
import { getSetting, setSetting } from './domain/ledger'
import {
  lastSnapshotInfo,
  snapshot,
  restoreSnapshot,
  rollbackRestore,
  validateRollbackCandidate,
  listSnapshots,
  exportPassphraseBackup,
  importPassphraseBackupToPlain,
  reencryptPlainToEncrypted,
  cleanupImportPlain,
  validatePlainCandidate,
  validateSnapshotCandidate,
} from './domain/backup'
import type { RestoreGate } from './domain/restore-gate'
import { runRestoreWithReconnect } from './domain/restore-gate'
import type { ConfigStore } from './config/store'
import { uiFallbackWaitMs } from './engine/engine'
import { visionCheck } from './wizard/providers'
import { parseSessionHistory } from './history'

export interface SettingsIpcContext {
  getDb: () => Database | null
  listArchivedSessions: () => ReturnType<import('./engine/engine').Engine['listArchivedSessions']>
  sessionsDir: string
  config: ConfigStore
  restartEngine: () => Promise<void>
  secrets: { get(name: string): string | null; set(name: string, v: string): void; requireAvailable(): void }
  dataDir: string
  dbFile: string
  backupsDir: string
  attachmentsDir: string
  portable: boolean
  newConversation: () => Promise<boolean>
  /** 续接一条已归档会话（引擎切到该会话文件）。path 已在 handler 内做目录白名单校验。 */
  resumeSession: (path: string) => Promise<void>
  /** 普通 IPC 动态解析的 Engine 代理（恢复重开后自动命中新 Engine）。 */
  engines?: { get(): { listArchivedSessions(): unknown; newConversation(): Promise<boolean>; resumeSession(path: string): Promise<void> } }
  /** Agent 轮次与恢复的互斥门（恢复不能与正在跑的轮次并发替换账本）。 */
  restoreGate?: Pick<RestoreGate, 'runRestore'>
  /** 候选通过验证并准备替换时关闭当前连接；失败路径可重新打开原库。 */
  closeDbForRestore: () => Promise<void>
  /** 替换失败时恢复原连接。 */
  restartEngineForRestore: () => Promise<void>
  appDataDir: string
}

export function registerSettingsIpc(ctx: SettingsIpcContext): void {
  ipcMain.handle('mz:getSettingsInfo', (): SettingsInfoDTO => {
    const db = ctx.getDb()
    const budget = db ? Number.parseInt(getSetting(db, 'monthly_budget_cents', '0') ?? '0', 10) || 0 : 0
    let attachmentCount = 0
    try {
      attachmentCount = readdirSync(ctx.attachmentsDir).length
    } catch {
      attachmentCount = 0
    }
    return {
      dataDir: ctx.dataDir,
      dbFile: ctx.dbFile,
      portable: ctx.portable,
      budgetCents: budget,
      lastSnapshot: lastSnapshotInfo(ctx.backupsDir),
      attachmentCount,
      // 保险丝阈值由主进程给：界面不再自己写死"90 秒"（那条盲定时器谎报过"引擎没有回应"）
      uiFallbackWaitMs: uiFallbackWaitMs(),
    }
  })

  ipcMain.handle('mz:setBudget', (_e, cents: number) => {
    const db = ctx.getDb()
    if (!db) throw new Error('账本未就绪')
    if (!Number.isInteger(cents) || cents < 0) throw new Error('预算数字无效')
    setSetting(db, 'monthly_budget_cents', String(cents), { audit: true })
  })

  ipcMain.handle('mz:cleanupAttachments', (_e, keepDays: number) => {
    const cutoff = Date.now() - Math.max(1, keepDays) * 24 * 60 * 60 * 1000
    let removed = 0
    try {
      for (const f of readdirSync(ctx.attachmentsDir)) {
        const p = join(ctx.attachmentsDir, f)
        if (statSync(p).mtimeMs < cutoff) {
          rmSync(p, { force: true })
          removed += 1
        }
      }
    } catch {
      // 目录异常时返回已删除数
    }
    return removed
  })

  ipcMain.handle('mz:createSnapshotNow', () => {
    const db = ctx.getDb()
    if (!db) throw new Error('账本未就绪')
    return snapshot(db, ctx.backupsDir)
  })

  ipcMain.handle('mz:listSnapshots', () => listSnapshots(ctx.backupsDir).map((s) => ({ name: s.name, size: s.size, mtime: s.mtime })))

  ipcMain.handle('mz:restoreSnapshot', async (_e, name: string) => {
    ctx.secrets.requireAvailable()
    const dek = ctx.secrets.get('db.key')
    if (!dek) throw new Error('本机账本密钥不可用')
    const steps = {
      validate: async () => validateSnapshotCandidate(ctx.backupsDir, name, dek),
      close: async () => ctx.closeDbForRestore(),
      commit: async () => restoreSnapshot(ctx.backupsDir, name, ctx.dbFile, dek),
    }
    const run = ctx.restoreGate
      ? (s: typeof steps) => runRestoreWithReconnect(ctx.restoreGate!, s, () => ctx.restartEngineForRestore())
      : async (s: typeof steps) => {
          await s.validate()
          await s.close()
          await s.commit()
        }
    await run(steps)
    app.relaunch()
    app.exit(0)
    return true
  })

  // 成功恢复后的真实回滚：把 .restore-rollback 旧库换回目标并验证，可测试往返。
  // B5：走同一 RestoreGate（恢复进行中拒绝并发回滚）；关闭前先 validate；
  // 已 close 后失败才重开，保留原错误。
  ipcMain.handle('mz:rollbackRestore', async () => {
    ctx.secrets.requireAvailable()
    const dek = ctx.secrets.get('db.key')
    if (!dek) throw new Error('本机账本密钥不可用')
    const steps = {
      validate: async () => validateRollbackCandidate(ctx.dbFile, dek),
      close: async () => ctx.closeDbForRestore(),
      commit: async () => rollbackRestore(ctx.dbFile, dek),
    }
    if (ctx.restoreGate) {
      await runRestoreWithReconnect(ctx.restoreGate, steps, () => ctx.restartEngineForRestore())
    } else {
      await steps.validate()
      await steps.close()
      try {
        await steps.commit()
      } catch (err) {
        await ctx.restartEngineForRestore()
        throw err
      }
    }
    app.relaunch()
    app.exit(0)
    return true
  })

  ipcMain.handle('mz:setMock', async (_e, enabled: boolean) => {
    const cfg = ctx.config.load()
    cfg.mock = Boolean(enabled)
    ctx.config.save(cfg)
    await ctx.restartEngine()
  })

  ipcMain.handle('mz:runVisionCheck', async (_e, providerId: string) => {
    const cfg = ctx.config.load()
    const provider = cfg.providers.find((p) => p.id === providerId)
    if (!provider) throw new Error('预设不存在')
    // 该预设已保存的 Key 就是这里唯一的来源（行内自检没有输入框）；取不到时
    // 走 visionCheck 的统一文案（"请回到上一步重新粘贴"），不用另一套措辞。
    const result = await visionCheck({
      baseUrl: provider.baseUrl,
      model: provider.model,
      providerId,
      getSavedKey: (id: string) => ctx.secrets.get(`provider-key:${id}`),
    })
    if (result.ok) {
      provider.visionCapable = true
      provider.selfCheckAt = new Date().toISOString()
      cfg.providers = cfg.providers.map((p) => (p.id === providerId ? provider : p))
      ctx.config.save(cfg)
      await ctx.restartEngine() // models.json 的 input 声明随 visionCapable 变化
    }
    // 失败写回状态（缺陷②）：清掉 visionCapable + 记失败时间，
    // 免得"自检没通过"这件事只活在一次 toast 里、账目却仍按支持视觉处理。
    else {
      provider.visionCapable = false
      provider.selfCheckAt = new Date().toISOString()
      cfg.providers = cfg.providers.map((p) => (p.id === providerId ? provider : p))
      ctx.config.save(cfg)
    }
    return result
  })

  ipcMain.handle('mz:readAttachment', (_e, relPath: string) => {
    // 安全：只允许读 attachmentsDir 内的文件（参考 readArchive 的校验做法）
    const norm = relPath.replaceAll('\\', '/')
    if (norm.includes('..') || norm.startsWith('/')) return null
    const base = ctx.attachmentsDir.replaceAll('\\', '/') + '/'
    const full = join(ctx.attachmentsDir, norm)
    if (!existsSync(full) || !statSync(full).isFile()) return null
    if (!full.replaceAll('\\', '/').startsWith(base)) return null
    const ext = norm.split('.').pop()?.toLowerCase() ?? ''
    const mime = ext === 'png' ? 'image/png' : ext === 'jpg' || ext === 'jpeg' ? 'image/jpeg' : ext === 'webp' ? 'image/webp' : ext === 'gif' ? 'image/gif' : null
    if (!mime) return null
    return `data:${mime};base64,${readFileSync(full).toString('base64')}`
  })

  ipcMain.handle('mz:listSessions', () => (ctx.engines ? ctx.engines.get().listArchivedSessions() : ctx.listArchivedSessions()))

  // 安全：会话文件读取/续接只允许 sessionsDir 内的 .jsonl
  const assertSessionPath = (path: string): void => {
    const norm = path.replaceAll('\\', '/')
    const base = ctx.sessionsDir.replaceAll('\\', '/') + '/'
    if (!norm.startsWith(base) || !norm.endsWith('.jsonl') || norm.includes('..')) {
      throw new Error('非法的会话文件路径')
    }
  }

  ipcMain.handle('mz:readArchive', (_e, path: string) => {
    assertSessionPath(path)
    return parseSessionHistory(path)
  })

  ipcMain.handle('mz:continueSession', async (_e, path: string) => {
    assertSessionPath(path)
    if (ctx.engines) await ctx.engines.get().resumeSession(path)
    else await ctx.resumeSession(path)
    return true
  })

  ipcMain.handle('mz:newConversation', async () => (ctx.engines ? ctx.engines.get().newConversation() : ctx.newConversation()))

  ipcMain.handle('mz:exportBackup', async (_e, passphrase: string): Promise<string | null> => {
    const db = ctx.getDb()
    if (!db) throw new Error('账本未就绪')
    if (!passphrase || passphrase.length < 8) throw new Error('口令至少 8 位；忘口令不可恢复，请务必记牢')
    const r = await dialog.showSaveDialog({
      title: '保存跨机备份包',
      defaultPath: `mingzhang-backup-${new Date().toISOString().slice(0, 10)}.mzbackup`,
      filters: [{ name: '明账备份包', extensions: ['mzbackup'] }],
    })
    if (r.canceled || !r.filePath) return null
    await exportPassphraseBackup(db, ctx.backupsDir, passphrase, r.filePath)
    return r.filePath
  })

  ipcMain.handle('mz:importBackup', async (_e, passphrase: string): Promise<boolean> => {
    if (!passphrase) throw new Error('需要口令')
    const r = await dialog.showOpenDialog({
      title: '选择备份包',
      filters: [{ name: '明账备份包', extensions: ['mzbackup'] }],
      properties: ['openFile'],
    })
    if (r.canceled || r.filePaths.length === 0) return false
    // 两步恢复：① 解密到临时明文库（连接还开着，先做只读/迁移预检）② 关闭连接后重加密落位
    // B4：decrypt 之后 secret/safeStorage、预验证、二次验证、门拒绝、close、commit 各失败路径
    // 统一 finally 清理 plain；reencrypt 自身 finally 不重复抛（cleanupImportPlain 永不抛）。
    const tmpPlain = join(ctx.backupsDir, `.restore-${Date.now()}.plain`)
    let decrypted = false
    try {
      await importPassphraseBackupToPlain(r.filePaths[0], passphrase, tmpPlain)
      decrypted = true
      try {
        validatePlainCandidate(tmpPlain)
      } catch (err) {
        cleanupImportPlain(tmpPlain)
        throw err
      }
      ctx.secrets.requireAvailable()
      const dek = ctx.secrets.get('db.key') ?? (() => {
        const generated = require('node:crypto').randomBytes(32).toString('hex')
        ctx.secrets.set('db.key', generated)
        return generated
      })()
      const run = ctx.restoreGate
        ? (s: { validate(): Promise<unknown>; close(): Promise<void>; commit(): Promise<void> }) =>
            runRestoreWithReconnect(ctx.restoreGate!, s, () => ctx.restartEngineForRestore())
        : async (s: { validate(): Promise<unknown>; close(): Promise<void>; commit(): Promise<void> }) => {
            await s.validate()
            await s.close()
            await s.commit()
          }
      try {
        await run({
          validate: async () => validatePlainCandidate(tmpPlain),
          close: async () => ctx.closeDbForRestore(),
          commit: async () => reencryptPlainToEncrypted(tmpPlain, ctx.dbFile, dek),
        })
      } catch (err) {
        // helper 负责只在该 close 已发生后重开；此处不吞、不覆盖原错误。
        throw err
      }
    } finally {
      if (decrypted) cleanupImportPlain(tmpPlain)
    }
    app.relaunch()
    app.exit(0)
    return true
  })
}
