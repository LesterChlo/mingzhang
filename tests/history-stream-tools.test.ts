// Real pi tool/thinking path against a local scripted SSE provider; all data synthetic.
import { expect, it } from 'vitest'
import http from 'node:http'
import type { AddressInfo } from 'node:net'
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Engine } from '../src/main/engine/engine'
import { ConfigStore, CONFIG_VERSION } from '../src/main/config/store'
import { openSchemaDb } from './helpers'
import { seed } from '../src/main/db/seed'
import { parseSessionHistory } from '../src/main/history'
import type { ChatEvent } from '../src/shared/types'

it('真实pi thinking/tool/正文/结束全部带同一流身份，历史call配对与card/error保留', async () => {
  const root = mkdtempSync(join(tmpdir(), 'mz-history-tools-'))
  const paths = { dataDir: root, dbFile: join(root, 'synthetic.db'), sessionsDir: join(root, 'sessions'), attachmentsDir: join(root, 'attachments'), secretsDir: join(root, 'secrets'), piDir: join(root, 'pi'), backupsDir: join(root, 'backups'), configFile: join(root, 'config.json'), portable: false }
  for (const dir of [paths.sessionsDir, paths.attachmentsDir, paths.secretsDir, paths.piDir, paths.backupsDir]) mkdirSync(dir)
  let requests = 0
  const server = http.createServer((req, res) => {
    req.resume()
    req.on('end', () => {
      requests++
      res.writeHead(200, { 'content-type': 'text/event-stream' })
      const chunk = (delta: unknown, finish: string | null = null) => res.write(`data: ${JSON.stringify({ id: 'synthetic', object: 'chat.completion.chunk', created: 1, model: 'synthetic', choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`)
      chunk({ role: 'assistant', content: '' })
      if (requests === 1) {
        chunk({ reasoning_content: '合成思考正文' })
        chunk({ tool_calls: [
          { index: 0, id: 'call-ok', type: 'function', function: { name: 'query', arguments: '{"metric":"total_expense"}' } },
          { index: 1, id: 'call-error', type: 'function', function: { name: 'query', arguments: '{"mode":"single","tx_id":999999}' } },
        ] })
        chunk({}, 'tool_calls')
      } else { chunk({ content: '合成查询完成' }); chunk({}, 'stop') }
      res.end('data: [DONE]\n\n')
    })
  })
  await new Promise<void>(r => server.listen(0, '127.0.0.1', r))
  writeFileSync(paths.configFile, JSON.stringify({ version: CONFIG_VERSION, onboarded: true, providers: [{ id: 'synthetic-tools', name: 'synthetic', baseUrl: `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`, model: 'synthetic', visionCapable: true }], activeProviderId: 'synthetic-tools' }))
  const db = openSchemaDb(paths.dbFile); seed(db)
  const events: ChatEvent[] = []
  const atEnd: ReturnType<typeof parseSessionHistory>[] = []
  const engine = new Engine(db, paths, new ConfigStore(paths.configFile), { get: () => 'synthetic-key' } as never, event => {
    events.push(event)
    if (event.type === 'turn-end') {
      expect(engine.panelHistoryState.busy).toBe(false)
      atEnd.push(parseSessionHistory(engine.sessionFile!, 300, { strict: true }))
    }
  })
  try {
    await engine.start()
    const initial = engine.panelHistoryState
    const tables = ['transactions', 'audit_log', 'pending_clarifications', 'imports', 'settings']
    const before = tables.map(t => db.prepare(`SELECT * FROM ${t}`).all())
    await engine.sendChat('合成查询消息', [{ fileName: 'synthetic.png', dataBase64: 'QUJD', mediaType: 'image/png' }])
    const rows = parseSessionHistory(engine.sessionFile!, 300, { strict: true })
    expect(atEnd[0]).toEqual(rows)
    expect(requests).toBe(2)
    for (const type of ['thinking-delta', 'progress', 'tool-start', 'tool-end', 'text-delta', 'agent-end', 'turn-end']) expect(events.some(e => e.type === type)).toBe(true)
    expect(events.every(e => e.sessionId === initial.sessionId && e.streamId === initial.streamId)).toBe(true)
    expect(events.map(e => e.eventSeq)).toEqual(events.map((_, i) => i + 1))
    expect(rows.find(m => m.toolCallId === 'call-ok')).toMatchObject({ role: 'tool', toolName: 'query', isError: false, card: { kind: 'query', totalCents: 0 } })
    expect(rows.find(m => m.toolCallId === 'call-error')).toMatchObject({ role: 'tool', toolName: 'query', isError: true })
    expect(rows.filter(m => m.role === 'tool')).toHaveLength(2)
    expect(rows.every(m => m.text !== '…')).toBe(true)
    expect(rows.find(m => m.thinkingText)?.thinkingText).toBe('合成思考正文')
    expect(rows[0].images).toEqual([{ previewUrl: 'data:image/png;base64,QUJD', fileName: '截图' }])
    expect(rows.at(-1)?.text).toBe('合成查询完成')
    for (let i = 0; i < 3; i++) { engine.panelHistoryState; parseSessionHistory(engine.sessionFile!) }
    expect(requests).toBe(2)
    expect(tables.map(t => db.prepare(`SELECT * FROM ${t}`).all())).toEqual(before)
    console.log('[pi tools persistence]', JSON.stringify({ eventCursor: engine.panelHistoryState.eventCursor, requests, events: events.map(e => ({ type: e.type, eventSeq: e.eventSeq })), rows: rows.map(m => ({ role: m.role, toolCallId: m.toolCallId, isError: m.isError, thinkingText: m.thinkingText, cardKind: m.card?.kind })) }))
  } finally {
    await engine.dispose(); server.closeAllConnections(); await new Promise<void>(r => server.close(() => r())); db.close()
  }
})
