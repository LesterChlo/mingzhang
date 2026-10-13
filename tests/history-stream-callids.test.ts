// Parent acceptance: real SDK tools must keep stable call IDs in the live event payload, not only JSONL.
import { it, expect } from 'vitest'
import http from 'node:http'
import type { AddressInfo } from 'node:net'
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Engine } from '../src/main/engine/engine'
import { ConfigStore, CONFIG_VERSION } from '../src/main/config/store'
import { openSchemaDb } from './helpers'
import { seed } from '../src/main/db/seed'
import type { ChatEvent } from '../src/shared/types'

it('真实pi同名工具并行：tool-start/end的call-ID逐一对应，结果不能按名称猜配', async () => {
  const root = mkdtempSync(join(tmpdir(), 'mz-live-tool-identity-'))
  const paths = { dataDir: root, dbFile: join(root, 'synthetic.db'), sessionsDir: join(root, 'sessions'), attachmentsDir: join(root, 'attachments'), secretsDir: join(root, 'secrets'), piDir: join(root, 'pi'), backupsDir: join(root, 'backups'), configFile: join(root, 'config.json'), portable: false }
  for (const d of [paths.sessionsDir, paths.attachmentsDir, paths.secretsDir, paths.piDir, paths.backupsDir]) mkdirSync(d)
  let requests = 0
  const server = http.createServer((req, res) => {
    req.resume(); req.on('end', () => {
      requests++
      res.writeHead(200, { 'content-type': 'text/event-stream' })
      const emit = (delta: unknown, finish: string | null = null) => res.write(`data: ${JSON.stringify({ id: 'synthetic', object: 'chat.completion.chunk', created: 1, model: 'synthetic', choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`)
      emit({ role: 'assistant', content: '' })
      if (requests === 1) {
        emit({ tool_calls: [
          { index: 0, id: 'synthetic-call-ok', type: 'function', function: { name: 'query', arguments: '{"metric":"total_expense"}' } },
          { index: 1, id: 'synthetic-call-missing', type: 'function', function: { name: 'query', arguments: '{"mode":"single","tx_id":987654}' } },
        ] }); emit({}, 'tool_calls')
      } else { emit({ content: '合成工具结果锚点' }); emit({}, 'stop') }
      res.end('data: [DONE]\n\n')
    })
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  writeFileSync(paths.configFile, JSON.stringify({ version: CONFIG_VERSION, onboarded: true, providers: [{ id: 'synthetic-live-tools', name: 'synthetic', baseUrl: `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`, model: 'synthetic', visionCapable: false }], activeProviderId: 'synthetic-live-tools' }))
  const db = openSchemaDb(paths.dbFile); seed(db)
  const events: ChatEvent[] = []
  const engine = new Engine(db, paths, new ConfigStore(paths.configFile), { get: () => 'synthetic-key' } as never, e => events.push(e))
  try {
    await engine.start(); await engine.sendChat('合成并行查询', [])
    const starts = events.filter(e => e.type === 'tool-start')
    const ends = events.filter(e => e.type === 'tool-end')
    expect(starts).toHaveLength(2); expect(ends).toHaveLength(2)
    expect(starts.map(e => e.payload.toolCallId).sort()).toEqual(['synthetic-call-missing', 'synthetic-call-ok'])
    expect(ends.map(e => e.payload.toolCallId).sort()).toEqual(['synthetic-call-missing', 'synthetic-call-ok'])
    expect(ends.find(e => e.payload.toolCallId === 'synthetic-call-ok')?.payload).toMatchObject({ toolName: 'query', isError: false, details: { card: { kind: 'query', totalCents: 0 } } })
    expect(ends.find(e => e.payload.toolCallId === 'synthetic-call-missing')?.payload).toMatchObject({ toolName: 'query', isError: true })
    expect(requests).toBe(2)
  } finally { await engine.dispose(); server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); db.close() }
})
