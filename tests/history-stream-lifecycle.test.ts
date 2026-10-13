// Real Engine + pi lifecycle. A local scripted provider never calls an external model.
import { expect, it, vi } from 'vitest'
import http from 'node:http'
import type { AddressInfo } from 'node:net'
import { existsSync, mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
const { handlers } = vi.hoisted(() => ({ handlers: new Map<string, (...args: any[]) => any>() }))
vi.mock('electron', () => ({ ipcMain: { handle: (name: string, fn: (...args: any[]) => any) => handlers.set(name, fn) }, nativeTheme: {} }))
import { Engine } from '../src/main/engine/engine'
import { ConfigStore, CONFIG_VERSION } from '../src/main/config/store'
import { registerIpc } from '../src/main/ipc'
import { createEngineRegistry } from '../src/main/engine/registry'
import { openSchemaDb } from './helpers'
import { seed } from '../src/main/db/seed'
import { parseSessionHistory } from '../src/main/history'
import type { ChatEvent, PanelHistorySnapshotDTO } from '../src/shared/types'

it('真实pi轮在turn-end前完成JSONL flush；身份游标/busy、新开/继续和只读快照零请求', async () => {
  const root = mkdtempSync(join(tmpdir(), 'mz-history-stream-'))
  const paths = { dataDir: root, dbFile: join(root, 'synthetic.db'), sessionsDir: join(root, 'sessions'), attachmentsDir: join(root, 'attachments'), secretsDir: join(root, 'secrets'), piDir: join(root, 'pi'), backupsDir: join(root, 'backups'), configFile: join(root, 'config.json'), portable: false }
  for (const dir of [paths.sessionsDir, paths.attachmentsDir, paths.secretsDir, paths.piDir, paths.backupsDir]) mkdirSync(dir)
  let requests = 0
  let release: (() => void) | undefined
  let enteredResolve: () => void = () => {}
  const entered = new Promise<void>(r => { enteredResolve = r })
  const server = http.createServer((req, res) => {
    req.resume()
    req.on('end', () => {
      requests++
      const send = () => {
        if (res.writableEnded || res.destroyed) return
        res.writeHead(200, { 'content-type': 'text/event-stream' })
        const chunk = (delta: unknown, finish: string | null = null) => res.write(`data: ${JSON.stringify({ id: 'synthetic', object: 'chat.completion.chunk', created: 1, model: 'synthetic', choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`)
        chunk({ role: 'assistant', content: '' })
        chunk({ content: '合成完整答复' })
        chunk({}, 'stop')
        res.end('data: [DONE]\n\n')
      }
      release = send
      enteredResolve()
    })
  })
  await new Promise<void>(r => server.listen(0, '127.0.0.1', r))
  writeFileSync(paths.configFile, JSON.stringify({ version: CONFIG_VERSION, onboarded: true, providers: [{ id: 'synthetic', name: 'synthetic', baseUrl: `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`, model: 'synthetic', visionCapable: false, selfCheckAt: null }], activeProviderId: 'synthetic' }))
  const db = openSchemaDb(paths.dbFile); seed(db)
  const secrets = { get: () => 'synthetic-key' }
  const events: ChatEvent[] = []
  const live: { event: ChatEvent; snapshot: PanelHistorySnapshotDTO; fileExists: boolean }[] = []
  const engines = createEngineRegistry<Engine>()
  const read = (): PanelHistorySnapshotDTO => handlers.get('mz:getPanelHistory')!({})
  const engine = new Engine(db, paths, new ConfigStore(paths.configFile), secrets as never, event => {
    events.push(event)
    live.push({ event, snapshot: read(), fileExists: Boolean(engine.sessionFile && existsSync(engine.sessionFile)) })
  })
  engines.set(engine)
  registerIpc({ engines, getDb: () => db } as never, { dataDir: root, dbFile: paths.dbFile })
  try {
    await engine.start()
    expect(events[0]).toMatchObject({ type: 'session-changed', sessionId: engine.sessionId, eventSeq: 1 })
    const initial = read()
    expect(initial).toMatchObject({ sessionId: engine.sessionId, streamId: expect.stringMatching(/^[0-9a-f-]{36}$/), eventCursor: 1, busy: false, messages: [] })
    expect(requests).toBe(0)
    const work = engine.sendChat('合成用户消息', [])
    await entered
    const busy = read()
    expect(busy.busy).toBe(true)
    expect(live.find(l => l.event.type === 'user-message')?.snapshot.busy).toBe(true)
    expect(live.find(l => l.event.type === 'user-message')?.fileExists).toBe(false)
    for (let i = 0; i < 3; i++) expect(read()).toEqual(busy)
    expect(requests).toBe(1)
    release!(); await work
    const done = read()
    expect(done.busy).toBe(false)
    expect(done.messages.map(m => m.text)).toEqual(['合成用户消息', '合成完整答复'])
    expect(done.messages.every(m => typeof m.timestamp === 'number')).toBe(true)
    expect(live.find(l => l.event.type === 'turn-end')?.snapshot).toEqual(done)
    expect(events.map(e => e.eventSeq)).toEqual(events.map((_, i) => i + 1))
    expect(events.every(e => e.sessionId === initial.sessionId && e.streamId === initial.streamId)).toBe(true)
    expect(done.eventCursor).toBe(events.at(-1)?.eventSeq)
    expect(events.at(-1)?.type).toBe('turn-end')
    const oldFile = engine.sessionFile!, bytes = readFileSync(oldFile, 'utf8')
    const tables = ['transactions', 'audit_log', 'agent_runs', 'pending_clarifications', 'imports', 'settings']
    const before = tables.map(t => db.prepare(`SELECT * FROM ${t}`).all())
    for (let i = 0; i < 3; i++) expect(read()).toEqual(done)
    expect(tables.map(t => db.prepare(`SELECT * FROM ${t}`).all())).toEqual(before)
    expect(readFileSync(oldFile, 'utf8')).toBe(bytes)
    expect(requests).toBe(1)
    expect(await engine.newConversation()).toBe(true)
    const fresh = read()
    expect(fresh.sessionId).not.toBe(done.sessionId)
    expect(fresh.streamId).toBe(done.streamId)
    expect(fresh.eventCursor).toBeGreaterThan(done.eventCursor)
    expect(fresh.messages).toEqual([])
    expect(events.at(-1)).toMatchObject({ type: 'session-changed', sessionId: fresh.sessionId })
    expect(await engine.newConversation()).toBe(false)
    expect(read()).toEqual(fresh)
    await engine.resumeSession(oldFile)
    const resumed = read()
    expect(resumed.sessionId).toBe(done.sessionId)
    expect(resumed.messages).toEqual(done.messages)
    expect(resumed.eventCursor).toBeGreaterThan(fresh.eventCursor)
    expect(readFileSync(oldFile, 'utf8')).toBe(bytes)
    expect(requests).toBe(1)
    await engine.dispose()
    const other = new Engine(db, paths, new ConfigStore(paths.configFile), secrets as never, e => events.push(e))
    try {
      engines.set(other); await other.start()
      expect(read().sessionId).toBe(done.sessionId)
      expect(read().streamId).not.toBe(done.streamId)
      expect(read().eventCursor).toBe(1)
      expect(read().messages).toEqual(parseSessionHistory(oldFile))
      expect(requests).toBe(1)
      console.log('[pi lifecycle]', JSON.stringify({ initial, busyCursor: busy.eventCursor, completedCursor: done.eventCursor, freshCursor: fresh.eventCursor, resumedCursor: resumed.eventCursor, completedMessages: done.messages.length, requests, events: events.map(e => ({ type: e.type, sessionId: e.sessionId, streamId: e.streamId, eventSeq: e.eventSeq })) }))
    } finally { await other.dispose() }
  } finally {
    release?.()
    await engine.dispose()
    server.closeAllConnections()
    await new Promise<void>(r => server.close(() => r()))
    db.close()
  }
})
