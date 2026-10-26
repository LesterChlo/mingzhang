// Read-only identity state across real pi failure and timeout paths, no external service.
import { expect, it, vi } from 'vitest'
import { existsSync, mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Engine } from '../src/main/engine/engine'
import { ConfigStore, CONFIG_VERSION } from '../src/main/config/store'
import { openSchemaDb } from './helpers'
import { seed } from '../src/main/db/seed'
import { startFakeProvider } from './fake-provider'
import { parseSessionHistory } from '../src/main/history'
import type { ChatEvent } from '../src/shared/types'

it('真实pi超时/错误收尾busy=false、单调身份完整；读状态不调模型，下一轮可恢复', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'mz-stream-errors-'))
  const paths = { dataDir: dir, dbFile: join(dir, 'synthetic.db'), sessionsDir: join(dir, 'sessions'), attachmentsDir: join(dir, 'attachments'), secretsDir: join(dir, 'secrets'), piDir: join(dir, 'pi'), backupsDir: join(dir, 'backups'), configFile: join(dir, 'config.json'), portable: false }
  for (const d of [paths.sessionsDir, paths.attachmentsDir, paths.secretsDir, paths.piDir, paths.backupsDir]) mkdirSync(d)
  const provider = await startFakeProvider('hang')
  writeFileSync(paths.configFile, JSON.stringify({ version: CONFIG_VERSION, onboarded: true, providers: [{ id: 'synthetic-fault', name: 'synthetic', baseUrl: provider.url, model: 'fake-model', visionCapable: false }], activeProviderId: 'synthetic-fault' }))
  const db = openSchemaDb(paths.dbFile); seed(db)
  const events: ChatEvent[] = []
  const atEnd: { state: Engine['panelHistoryState']; rows: ReturnType<typeof parseSessionHistory> }[] = []
  const engine = new Engine(db, paths, new ConfigStore(paths.configFile), { get: () => 'synthetic-key' } as never, e => {
    events.push(e)
    if (e.type === 'turn-end') atEnd.push({ state: engine.panelHistoryState, rows: engine.sessionFile ? parseSessionHistory(engine.sessionFile, 300, { strict: true }) : [] })
  })
  vi.stubEnv('MZ_TURN_IDLE_TIMEOUT_MS', '300')
  vi.stubEnv('MZ_TURN_TOTAL_BUDGET_MS', '5000')
  try {
    await engine.start()
    const initial = engine.panelHistoryState
    const mutable = engine.panelHistoryState; mutable.eventCursor = 999; mutable.busy = true
    expect(engine.panelHistoryState).toEqual(initial)
    expect(provider.requests()).toBe(0)
    await expect(engine.sendChat('合成超时消息', [])).rejects.toMatchObject({ code: 'TURN_TIMEOUT' })
    expect(engine.panelHistoryState.busy).toBe(false)
    expect(atEnd[0].state.busy).toBe(false)
    expect(events.filter(e => e.type === 'turn-end')).toHaveLength(1)
    expect(events.find(e => e.type === 'error')?.payload.message).toMatch(/超时/)
    expect(events.every(e => e.streamId === initial.streamId && e.sessionId === initial.sessionId)).toBe(true)
    expect(events.map(e => e.eventSeq)).toEqual(events.map((_, i) => i + 1))
    expect(atEnd[0].rows.find(m => m.role === 'user')?.text).toBe('合成超时消息')
    const reads = provider.requests()
    for (let i = 0; i < 3; i++) { engine.panelHistoryState; parseSessionHistory(engine.sessionFile!, 300, { strict: true }) }
    expect(provider.requests()).toBe(reads)
    provider.setMode('ok')
    await engine.sendChat('合成恢复消息', [])
    expect(engine.panelHistoryState.busy).toBe(false)
    expect(atEnd[1].rows.at(-1)?.text).toBe('好的')
    provider.setMode('hang')
    const originalSession = engine.sessionId
    const startIndex = events.length
    const switchingWork = engine.sendChat('合成切换中消息', [])
    // Dispose aborts the pending old pi run; collect the result immediately to avoid rejection leaks.
    const settled = switchingWork.then(() => 'resolved', () => 'rejected')
    await expect.poll(() => provider.requests()).toBeGreaterThan(reads + 1)
    expect(await engine.newConversation()).toBe(true)
    await settled
    expect(engine.sessionId).not.toBe(originalSession)
    const oldEnd = events.slice(startIndex).find(e => e.type === 'turn-end')
    expect(oldEnd?.sessionId).toBe(originalSession)
    expect(engine.panelHistoryState.busy).toBe(false)
    console.log('[pi fault lifecycle]', JSON.stringify({ events: events.map(e => ({ type: e.type, eventSeq: e.eventSeq })), atEnd: atEnd.map(e => ({ state: e.state, rows: e.rows.map(r => ({ role: r.role, text: r.text })) })), requests: provider.requests() }))
  } finally { await engine.dispose(); await provider.close(); db.close(); vi.unstubAllEnvs() }
})

it('pi认证前置错误仍广播同一身份error/turn-end并解除busy，历史不伪造空文件', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'mz-stream-preflight-'))
  const paths = { dataDir: dir, dbFile: join(dir, 'synthetic.db'), sessionsDir: join(dir, 'sessions'), attachmentsDir: join(dir, 'attachments'), secretsDir: join(dir, 'secrets'), piDir: join(dir, 'pi'), backupsDir: join(dir, 'backups'), configFile: join(dir, 'config.json'), portable: false }
  for (const d of [paths.sessionsDir, paths.attachmentsDir, paths.secretsDir, paths.piDir, paths.backupsDir]) mkdirSync(d)
  writeFileSync(paths.configFile, JSON.stringify({ version: CONFIG_VERSION, onboarded: true, providers: [{ id: 'synthetic-no-key', name: 'synthetic', baseUrl: 'http://127.0.0.1:1/v1', model: 'synthetic', visionCapable: false }], activeProviderId: 'synthetic-no-key' }))
  const db = openSchemaDb(paths.dbFile); seed(db)
  const events: ChatEvent[] = []
  const engine = new Engine(db, paths, new ConfigStore(paths.configFile), { get: () => null } as never, e => events.push(e))
  try {
    await engine.start()
    const initial = engine.panelHistoryState
    await expect(engine.sendChat('认证失败合成消息', [])).rejects.toThrow(/API key/)
    expect(engine.panelHistoryState.busy).toBe(false)
    expect(events.map(e => e.type)).toEqual(['session-changed', 'user-message', 'error', 'turn-end'])
    expect(events.every(e => e.sessionId === initial.sessionId && e.streamId === initial.streamId)).toBe(true)
    expect(events.map(e => e.eventSeq)).toEqual([1, 2, 3, 4])
    console.log('[pi preflight persistence]', JSON.stringify({ state: engine.panelHistoryState, fileExists: existsSync(engine.sessionFile!), history: parseSessionHistory(engine.sessionFile!, 300, { strict: true }) }))
  } finally { await engine.dispose(); db.close() }
})

it('准备阶段失败仍在finally收回busy，不改变模型/账务入口', async () => {
  const states: Engine['panelHistoryState'][] = []
  let engine: Engine
  const cfg = { load: () => { states.push(engine.panelHistoryState); throw new Error('synthetic config failed') } }
  engine = new Engine({} as never, {} as never, cfg as never, {} as never, () => {})
  const internal = engine as unknown as { session: unknown }
  internal.session = { sessionId: 'synthetic-prepare' }
  await expect(engine.sendChat('合成准备失败', [])).rejects.toThrow('synthetic config failed')
  expect(states[0].busy).toBe(true)
  expect(engine.panelHistoryState.busy).toBe(false)
})
