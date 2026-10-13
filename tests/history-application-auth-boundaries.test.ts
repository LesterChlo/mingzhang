// Real SDK + synthetic loopback only. No host credential files or external model requests.
import { expect, it, vi } from 'vitest'
import http from 'node:http'
import type { AddressInfo } from 'node:net'
import { existsSync, mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { AgentSession } from '@earendil-works/pi-coding-agent'
import type { AuthContext } from '@earendil-works/pi-ai'
import { Engine } from '../src/main/engine/engine'
import { ConfigStore, CONFIG_VERSION } from '../src/main/config/store'
import { parseSessionHistory } from '../src/main/history'
import type { ChatEvent } from '../src/shared/types'
import { openSchemaDb } from './helpers'
import { seed } from '../src/main/db/seed'

const ambientKey = 'synthetic-boundary-host-key'
const applicationKey = 'synthetic-boundary-application-key'

async function fixture(providerId: string, initialKey: string | null = null, mock = false, toolFirst = false) {
  const requests: { authorization?: string; body: { model: string; messages: unknown[] } }[] = []
  const server = http.createServer((req, res) => {
    let body = ''
    req.on('data', chunk => { body += String(chunk) })
    req.on('end', () => {
      requests.push({ authorization: req.headers.authorization, body: JSON.parse(body) })
      res.writeHead(200, { 'content-type': 'text/event-stream' })
      const emit = (delta: unknown, finish: string | null = null) => res.write(`data: ${JSON.stringify({ id: 'synthetic-boundary', object: 'chat.completion.chunk', created: 1, model: 'custom-model-r1', choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`)
      emit({ role: 'assistant', content: '' })
      if (toolFirst && requests.length === 1) {
        emit({ tool_calls: [{ index: 0, id: 'synthetic-auth-boundary-query', type: 'function', function: { name: 'query', arguments: '{"metric":"total_expense"}' } }] })
        emit({}, 'tool_calls')
      } else {
        emit({ content: '合成边界正控答复' })
        emit({}, 'stop')
      }
      res.end('data: [DONE]\n\n')
    })
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const dataDir = mkdtempSync(join(tmpdir(), 'mz-auth-boundaries-r1-'))
  const paths = { dataDir, dbFile: join(dataDir, 'synthetic.db'), sessionsDir: join(dataDir, 'sessions'), attachmentsDir: join(dataDir, 'attachments'), secretsDir: join(dataDir, 'secrets'), piDir: join(dataDir, 'pi'), backupsDir: join(dataDir, 'backups'), configFile: join(dataDir, 'config.json'), portable: false }
  for (const dir of [paths.sessionsDir, paths.attachmentsDir, paths.secretsDir, paths.piDir, paths.backupsDir]) mkdirSync(dir)
  const provider = { id: providerId, name: '合成自定义名称不改', model: 'custom-model-r1', baseUrl: `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`, visionCapable: false }
  writeFileSync(paths.configFile, JSON.stringify({ version: CONFIG_VERSION, onboarded: true, mock, providers: [provider], activeProviderId: providerId }))
  const configBytes = readFileSync(paths.configFile)
  const db = openSchemaDb(paths.dbFile)
  seed(db)
  const events: ChatEvent[] = []
  let key = initialKey
  const secrets = { get: vi.fn((name: string) => name === `provider-key:${providerId}` ? key : null) }
  const engine = new Engine(db, paths, new ConfigStore(paths.configFile), secrets as never, event => events.push(event))
  return {
    engine, paths, db, events, requests, secrets, provider, configBytes,
    setKey: (value: string | null) => { key = value },
    close: async () => { await engine.dispose(); db.close(); server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())) },
  }
}

function sdkSession(engine: Engine): AgentSession {
  return (engine as unknown as { session: AgentSession }).session
}

function entries(file: string): { type: string; customType?: string }[] {
  return readFileSync(file, 'utf8').trim().split('\n').map(line => JSON.parse(line))
}

it.each([{ id: 'deepseek', env: 'DEEPSEEK_API_KEY' }, { id: 'openai', env: 'OPENAI_API_KEY' }])('晚到环境凭据与反复refresh不能激活$id；真实SDK preflight=false、display-only失败不进入模型上下文', async ({ id, env }) => {
  vi.stubEnv(env, '')
  const f = await fixture(id)
  try {
    await f.engine.start()
    expect(f.engine.ready).toBe(true)
    const session = sdkSession(f.engine), runtime = session.modelRuntime
    expect(runtime.hasConfiguredAuth(id)).toBe(false)
    vi.stubEnv(env, ambientKey)
    for (let i = 0; i < 3; i++) {
      const result = await runtime.refresh({ allowNetwork: false, providers: [id] })
      expect(result.aborted).toBe(false)
      expect(result.errors.size).toBe(0)
      expect(runtime.hasConfiguredAuth(id)).toBe(false)
      expect(await runtime.checkAuth(id)).toBeUndefined()
      expect(await runtime.getAuth(id)).toBeUndefined()
      expect(await runtime.getAvailable(id)).toEqual([])
      expect(runtime.getAvailableSnapshot().filter(model => model.provider === id)).toEqual([])
    }
    let preflight: boolean | undefined
    await expect(session.prompt('合成直接SDK前置拒绝', { preflightResult: result => { preflight = result } })).rejects.toThrow(/API key/)
    expect(preflight).toBe(false)
    expect(session.sessionManager.buildSessionContext().messages).toEqual([])
    const text = '  合成晚到环境失败原文\n保留空白  '
    await expect(f.engine.sendChat(text, [])).rejects.toThrow(/API key/)
    const file = f.engine.sessionFile!
    expect(entries(file).filter(entry => entry.type === 'message')).toEqual([])
    expect(entries(file).filter(entry => entry.customType === 'mingzhang.failed-send')).toHaveLength(1)
    expect(parseSessionHistory(file).filter(message => message.role === 'user').map(message => message.text)).toEqual([text])
    expect(session.sessionManager.buildSessionContext().messages).toEqual([])
    expect(f.events.map(event => event.type)).toEqual(['session-changed', 'user-message', 'error', 'turn-end'])
    expect(f.engine.panelHistoryState.busy).toBe(false)
    expect(f.db.prepare('SELECT status, llm_provider FROM agent_runs').get()).toEqual({ status: 'failed', llm_provider: id })
    const response = await runtime.completeSimple(session.model!, { messages: [{ role: 'user', content: [{ type: 'text', text: '合成直接runtime后续请求也不得继承' }], timestamp: 1 }] })
    expect(response.stopReason).toBe('error')
    expect(response.errorMessage).toMatch(/not configured/)
    expect(f.requests).toHaveLength(0)
    expect(process.env[env]).toBe(ambientKey)
    expect(readFileSync(f.paths.configFile)).toEqual(f.configBytes)
  } finally { await f.close(); vi.unstubAllEnvs() }
})

it.each([{ id: 'deepseek', env: 'DEEPSEEK_API_KEY' }, { id: 'openai', env: 'OPENAI_API_KEY' }, { id: 'custom-r1-provider', env: 'OPENAI_API_KEY' }])('$id应用key优先、provider/model/协议不改、不落明文；移除、重启、resume仍拒绝环境', async ({ id, env }) => {
  vi.stubEnv(env, ambientKey)
  const f = await fixture(id, applicationKey)
  try {
    await f.engine.start()
    const session = sdkSession(f.engine), runtime = session.modelRuntime
    expect(runtime.hasConfiguredAuth(id)).toBe(true)
    expect(await runtime.checkAuth(id)).toMatchObject({ type: 'api_key' })
    expect(await runtime.getAuth(id)).toMatchObject({ auth: { apiKey: applicationKey } })
    expect(session.model).toMatchObject({ provider: id, id: f.provider.model, api: 'openai-completions', baseUrl: f.provider.baseUrl, contextWindow: 128000, maxTokens: 8192 })
    const ids = runtime.getModels(id).map(model => model.id)
    expect(new Set(ids).size).toBe(ids.length)
    expect(ids.filter(modelId => modelId === f.provider.model)).toHaveLength(1)
    expect(f.secrets.get.mock.calls).toEqual([[`provider-key:${id}`]])
    await f.engine.sendChat('合成显式应用凭据正控', [])
    expect(f.requests).toHaveLength(1)
    expect(f.requests[0].authorization).toBe(`Bearer ${applicationKey}`)
    expect(f.requests[0].body.model).toBe(f.provider.model)
    const file = f.engine.sessionFile!, prefix = readFileSync(file), sessionId = f.engine.sessionId
    await runtime.removeRuntimeApiKey(id)
    await runtime.refresh({ allowNetwork: false, providers: [id] })
    expect(runtime.hasConfiguredAuth(id)).toBe(false)
    expect(await runtime.checkAuth(id)).toBeUndefined()
    expect(await runtime.getAuth(id)).toBeUndefined()
    await expect(f.engine.sendChat('合成runtime移除后失败', [])).rejects.toThrow(/API key/)
    expect(readFileSync(file).subarray(0, prefix.length)).toEqual(prefix)
    f.setKey(null)
    await f.engine.dispose()
    await f.engine.start()
    expect(f.engine.sessionId).toBe(sessionId)
    expect(f.engine.sessionFile).toBe(file)
    expect(sdkSession(f.engine).modelRuntime.hasConfiguredAuth(id)).toBe(false)
    await expect(f.engine.sendChat('合成重启后失败', [])).rejects.toThrow(/API key/)
    await f.engine.resumeSession(file)
    expect(f.engine.sessionId).toBe(sessionId)
    await expect(f.engine.sendChat('合成resume后失败', [])).rejects.toThrow(/API key/)
    expect(f.requests).toHaveLength(1)
    expect(entries(file).filter(entry => entry.customType === 'mingzhang.failed-send')).toHaveLength(3)
    expect(sdkSession(f.engine).sessionManager.buildSessionContext().messages.filter(message => message.role === 'user')).toHaveLength(1)
    expect(parseSessionHistory(file).filter(message => message.role === 'user').map(message => message.text)).toEqual(['合成显式应用凭据正控', '合成runtime移除后失败', '合成重启后失败', '合成resume后失败'])
    expect(readFileSync(f.paths.configFile)).toEqual(f.configBytes)
    const models = JSON.parse(readFileSync(join(f.paths.piDir, 'models.json'), 'utf8'))
    expect(Object.keys(models.providers)).toEqual([id])
    expect(models.providers[id]).toMatchObject({ baseUrl: f.provider.baseUrl, api: 'openai-completions', models: [{ id: f.provider.model, name: f.provider.model }] })
    for (const path of [f.paths.configFile, file, join(f.paths.piDir, 'models.json'), join(f.paths.piDir, 'auth.json'), join(f.paths.piDir, 'models-store.json')]) {
      if (!existsSync(path)) continue
      const bytes = readFileSync(path, 'utf8')
      expect(bytes).not.toContain(applicationKey)
      expect(bytes).not.toContain(ambientKey)
    }
    expect(JSON.stringify(f.events)).not.toContain(applicationKey)
    expect(JSON.stringify(f.events)).not.toContain(ambientKey)
    expect(process.env[env]).toBe(ambientKey)
  } finally { await f.close(); vi.unstubAllEnvs() }
})

it.each(['google-vertex', 'openai-codex'])('%s应用预设不保留builtin OAuth或ambient file认证；真实auth handler只认传入credential', async id => {
  const f = await fixture(id)
  try {
    // This file is synthetic and app-scoped. InMemoryCredentialStore must ignore it.
    writeFileSync(join(f.paths.piDir, 'auth.json'), JSON.stringify({ [id]: { type: 'oauth', access: 'synthetic-access', refresh: 'synthetic-refresh', expires: Date.now() + 3_600_000 } }))
    await f.engine.start()
    const session = sdkSession(f.engine), runtime = session.modelRuntime
    const provider = runtime.getProvider(id)!
    expect(provider.auth.oauth).toBeUndefined()
    expect(runtime.isUsingOAuth(id)).toBe(false)
    expect(runtime.hasConfiguredAuth(id)).toBe(false)
    expect(await runtime.getAuth(id)).toBeUndefined()
    const env = vi.fn(async () => { throw new Error('active auth must not read host env') })
    const fileExists = vi.fn(async () => { throw new Error('active auth must not inspect ambient files') })
    const ctx: AuthContext = { env, fileExists }
    const signal = new AbortController().signal
    expect(await provider.auth.apiKey!.check!({ ctx, signal })).toBeUndefined()
    expect(await provider.auth.apiKey!.resolve({ ctx, signal })).toBeUndefined()
    expect(await provider.auth.apiKey!.resolve({ ctx, signal, credential: { type: 'api_key' } })).toBeUndefined()
    expect(await provider.auth.apiKey!.resolve({ ctx, signal, credential: { type: 'api_key', key: applicationKey } })).toMatchObject({ auth: { apiKey: applicationKey } })
    expect(env).not.toHaveBeenCalled()
    expect(fileExists).not.toHaveBeenCalled()
    let preflight: boolean | undefined
    await expect(session.prompt('合成内置认证不继承', { preflightResult: result => { preflight = result } })).rejects.toThrow(/API key/)
    expect(preflight).toBe(false)
    await expect(f.engine.sendChat('合成内置认证缺钥失败', [])).rejects.toThrow(/API key/)
    expect(f.requests).toHaveLength(0)
    expect(session.sessionManager.buildSessionContext().messages).toEqual([])
    await runtime.setRuntimeApiKey(id, applicationKey)
    expect(runtime.hasConfiguredAuth(id)).toBe(true)
    await f.engine.sendChat('合成内置ID兼容传输正控', [])
    expect(f.requests).toHaveLength(1)
    expect(f.requests[0].authorization).toBe(`Bearer ${applicationKey}`)
    expect(session.model).toMatchObject({ provider: id, id: f.provider.model, api: 'openai-completions', baseUrl: f.provider.baseUrl })
  } finally { await f.close() }
})

it.each([{ id: 'deepseek', env: 'DEEPSEEK_API_KEY' }, { id: 'openai', env: 'OPENAI_API_KEY' }])('$id真实工具轮中移除应用key：SDK后续request和compaction不准回退环境', async ({ id, env }) => {
  vi.stubEnv(env, ambientKey)
  const f = await fixture(id, applicationKey, false, true)
  try {
    await f.engine.start()
    const session = sdkSession(f.engine), afterToolCall = session.agent.afterToolCall
    let removals = 0
    session.agent.afterToolCall = async (context, signal) => {
      const result = await afterToolCall?.(context, signal)
      await session.modelRuntime.removeRuntimeApiKey(id)
      removals++
      return result
    }
    await f.engine.sendChat('合成工具轮后续不得继承环境', [])
    expect(removals).toBe(1)
    expect(f.requests).toHaveLength(1)
    expect(f.requests[0].authorization).toBe(`Bearer ${applicationKey}`)
    expect(f.events.filter(event => event.type === 'tool-end')).toHaveLength(1)
    expect(session.agent.state.messages.some(message => message.role === 'assistant' && message.stopReason === 'error' && /not configured/.test(message.errorMessage ?? ''))).toBe(true)
    expect(session.modelRuntime.hasConfiguredAuth(id)).toBe(false)
    session.settingsManager.applyOverrides({ compaction: { enabled: true, reserveTokens: 100, keepRecentTokens: 1 } })
    await expect(session.compact()).rejects.toThrow(/not configured/)
    expect(f.requests).toHaveLength(1)
    expect(await session.modelRuntime.getAuth(id)).toBeUndefined()
    expect(f.engine.panelHistoryState.busy).toBe(false)
    expect(process.env[env]).toBe(ambientKey)
  } finally { await f.close(); vi.unstubAllEnvs() }
})

it('离线mock继续显式mock-key，不读SecretsStore、不重写原预设identity，真实工具轮正常', async () => {
  vi.stubEnv('DEEPSEEK_API_KEY', ambientKey)
  const f = await fixture('deepseek', null, true)
  try {
    await f.engine.start()
    const session = sdkSession(f.engine)
    expect(f.secrets.get).not.toHaveBeenCalled()
    expect(session.model).toMatchObject({ provider: 'mock-local', id: 'mock-mingzhang', api: 'openai-completions' })
    expect(await session.modelRuntime.getAuth('mock-local')).toMatchObject({ auth: { apiKey: 'mock-key' } })
    await f.engine.sendChat('麦当劳 26', [])
    expect(f.db.prepare('SELECT amount_cents, state, merchant FROM transactions').get()).toEqual({ amount_cents: 2600, state: 'needs_review', merchant: '麦当劳' })
    expect(f.events.some(event => event.type === 'tool-end')).toBe(true)
    expect(f.events.at(-1)?.type).toBe('turn-end')
    expect(f.engine.panelHistoryState.busy).toBe(false)
    expect(f.requests).toHaveLength(0)
    expect(readFileSync(f.paths.configFile)).toEqual(f.configBytes)
    expect(process.env.DEEPSEEK_API_KEY).toBe(ambientKey)
  } finally { await f.close(); vi.unstubAllEnvs() }
})
