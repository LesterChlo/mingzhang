// Known contract gap requiring parent-approved exception outside identity/busy-only Engine edits.
// Keep the RED assertion intact: preflight user echoes cannot disappear behind an idle cursor.
import { expect, it, vi } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
const { handlers } = vi.hoisted(() => ({ handlers: new Map<string, (...args: any[]) => any>() }))
vi.mock('electron', () => ({ ipcMain: { handle: (name: string, fn: (...args: any[]) => any) => handlers.set(name, fn) }, nativeTheme: {} }))
import { Engine } from '../src/main/engine/engine'
import { ConfigStore, CONFIG_VERSION } from '../src/main/config/store'
import { openSchemaDb } from './helpers'
import { seed } from '../src/main/db/seed'
import { registerIpc } from '../src/main/ipc'
import { createEngineRegistry } from '../src/main/engine/registry'

it('冻结idle契约：pi认证前置失败后游标前的用户回显也必须可持久化恢复', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'mz-stream-preflight-contract-'))
  const paths = { dataDir: dir, dbFile: join(dir, 'synthetic.db'), sessionsDir: join(dir, 'sessions'), attachmentsDir: join(dir, 'attachments'), secretsDir: join(dir, 'secrets'), piDir: join(dir, 'pi'), backupsDir: join(dir, 'backups'), configFile: join(dir, 'config.json'), portable: false }
  for (const d of [paths.sessionsDir, paths.attachmentsDir, paths.secretsDir, paths.piDir, paths.backupsDir]) mkdirSync(d)
  writeFileSync(paths.configFile, JSON.stringify({ version: CONFIG_VERSION, onboarded: true, providers: [{ id: 'synthetic-no-key-contract', name: 'synthetic', baseUrl: 'http://127.0.0.1:1/v1', model: 'synthetic', visionCapable: false }], activeProviderId: 'synthetic-no-key-contract' }))
  const db = openSchemaDb(paths.dbFile); seed(db)
  const engine = new Engine(db, paths, new ConfigStore(paths.configFile), { get: () => null } as never, () => {})
  const engines = createEngineRegistry<Engine>(); engines.set(engine)
  registerIpc({ engines, getDb: () => db } as never, { dataDir: dir, dbFile: paths.dbFile })
  try {
    await engine.start()
    await expect(engine.sendChat('认证前置失败合成消息', [])).rejects.toThrow(/API key/)
    const snapshot = handlers.get('mz:getPanelHistory')!({})
    expect(snapshot).toMatchObject({ busy: false, eventCursor: 4 })
    expect(snapshot.messages.find((m: { role: string }) => m.role === 'user')?.text).toBe('认证前置失败合成消息')
  } finally { await engine.dispose(); db.close() }
})
