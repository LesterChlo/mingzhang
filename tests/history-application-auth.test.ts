// Parent R1 frozen regression: app-owned presets never inherit host credentials. Synthetic loopback only.
import { it, expect, vi } from 'vitest'
import http from 'node:http'
import type { AddressInfo } from 'node:net'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { AgentSession } from '@earendil-works/pi-coding-agent'
import { Engine } from '../src/main/engine/engine'
import { ConfigStore, CONFIG_VERSION } from '../src/main/config/store'
import { openSchemaDb } from './helpers'
import { seed } from '../src/main/db/seed'
import { parseSessionHistory } from '../src/main/history'

async function fixture(providerId: string, appKey: string | null) {
  const requests: { authorization: string | undefined; body: { messages: unknown[] } }[] = []
  const server = http.createServer((req, res) => {
    let body = ''; req.on('data', data => body += data)
    req.on('end', () => {
      requests.push({ authorization: req.headers.authorization, body: JSON.parse(body) })
      res.writeHead(200, { 'content-type': 'text/event-stream' })
      const emit = (delta: unknown, finish: string | null = null) => res.write(`data: ${JSON.stringify({ id: 'synthetic-auth-boundary', object: 'chat.completion.chunk', model: 'synthetic', created: 1, choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`)
      emit({ role: 'assistant', content: '' }); emit({ content: '合成应用密钥正常控制' }); emit({}, 'stop'); res.end('data: [DONE]\n\n')
    })
  })
  await new Promise<void>(r => server.listen(0, '127.0.0.1', r))
  const dataDir = mkdtempSync(join(tmpdir(), 'mz-app-auth-boundary-'))
  const paths = { dataDir, dbFile: join(dataDir, 'synthetic.db'), sessionsDir: join(dataDir, 'sessions'), attachmentsDir: join(dataDir, 'attachments'), secretsDir: join(dataDir, 'secrets'), piDir: join(dataDir, 'pi'), backupsDir: join(dataDir, 'backups'), configFile: join(dataDir, 'config.json'), portable: false }
  for (const dir of [paths.sessionsDir, paths.attachmentsDir, paths.secretsDir, paths.piDir, paths.backupsDir]) mkdirSync(dir)
  writeFileSync(paths.configFile, JSON.stringify({ version: CONFIG_VERSION, onboarded: true, mock: false, providers: [{ id: providerId, name: '合成应用预设', model: 'synthetic', baseUrl: `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`, visionCapable: false }], activeProviderId: providerId }))
  const db = openSchemaDb(paths.dbFile); seed(db)
  const engine = new Engine(db, paths, new ConfigStore(paths.configFile), { get: () => appKey } as never, () => {})
  const close = async () => { await engine.dispose(); db.close(); server.closeAllConnections(); await new Promise<void>(r => server.close(() => r())) }
  return { engine, paths, db, requests, close }
}

it.each([{ id: 'deepseek', env: 'DEEPSEEK_API_KEY' }, { id: 'openai', env: 'OPENAI_API_KEY' }])('应用未保存$id密钥：环境合成凭据不准用于自定义端点，原失败历史仍可恢复', async ({ id, env }) => {
  const marker = 'synthetic-host-key-never-live'
  vi.stubEnv(env, marker)
  const f = await fixture(id, null)
  try {
    await f.engine.start()
    await expect(f.engine.sendChat('合成私有材料只可失败回显', [])).rejects.toThrow(/API key/)
    expect(f.requests).toHaveLength(0)
    const file = f.engine.sessionFile!
    const history = parseSessionHistory(file)
    expect(history.filter(m => m.role === 'user').map(m => m.text)).toEqual(['合成私有材料只可失败回显'])
    expect(history.filter(m => m.isError)).toHaveLength(1)
    const entries = readFileSync(file, 'utf8').trim().split('\n').map(line => JSON.parse(line))
    expect(entries.filter(e => e.type === 'message')).toEqual([])
    expect(entries.filter(e => e.type === 'custom' && e.customType === 'mingzhang.failed-send')).toHaveLength(1)
    expect(JSON.stringify(entries)).not.toContain(marker)
    expect(f.engine.panelHistoryState.busy).toBe(false)
  } finally { await f.close(); vi.unstubAllEnvs() }
})

it('明确应用密钥优先于环境；移除runtime应用密钥后必须拒绝，不退回主机环境', async () => {
  vi.stubEnv('DEEPSEEK_API_KEY', 'synthetic-ambient-key-never-live')
  const f = await fixture('deepseek', 'synthetic-app-owned-key')
  try {
    await f.engine.start()
    await f.engine.sendChat('合成明确应用密钥正控', [])
    expect(f.requests).toHaveLength(1)
    expect(f.requests[0].authorization).toBe('Bearer synthetic-app-owned-key')
    const file = f.engine.sessionFile!, bytes = readFileSync(file)
    const session = (f.engine as unknown as { session: AgentSession }).session
    await session.modelRuntime.removeRuntimeApiKey('deepseek')
    await expect(f.engine.sendChat('合成移除后不得继承', [])).rejects.toThrow(/API key/)
    expect(f.requests).toHaveLength(1)
    expect(readFileSync(file).subarray(0, bytes.length)).toEqual(bytes)
    expect(session.sessionManager.buildSessionContext().messages.filter(m => m.role === 'user')).toHaveLength(1)
    expect(parseSessionHistory(file).filter(m => m.role === 'user').map(m => m.text)).toEqual(['合成明确应用密钥正控', '合成移除后不得继承'])
  } finally { await f.close(); vi.unstubAllEnvs() }
})
