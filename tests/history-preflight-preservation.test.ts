// Real Engine + pi 0.84.4, isolated synthetic profile; no external model or credentials.
import { expect, it, vi } from 'vitest'
import http from 'node:http'
import type { AddressInfo } from 'node:net'
import { existsSync, mkdtempSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { SessionManager, type AgentSession } from '@earendil-works/pi-coding-agent'
import { Engine } from '../src/main/engine/engine'
import { ConfigStore, CONFIG_VERSION } from '../src/main/config/store'
import { openSchemaDb } from './helpers'
import { seed } from '../src/main/db/seed'
import { parseSessionHistory } from '../src/main/history'
import type { ChatEvent } from '../src/shared/types'

function fixture(baseUrl = 'http://127.0.0.1:1/v1', key: string | null = null) {
  const dir = mkdtempSync(join(tmpdir(), 'mz-preflight-preservation-'))
  const paths = { dataDir: dir, dbFile: join(dir, 'synthetic.db'), sessionsDir: join(dir, 'sessions'), attachmentsDir: join(dir, 'attachments'), secretsDir: join(dir, 'secrets'), piDir: join(dir, 'pi'), backupsDir: join(dir, 'backups'), configFile: join(dir, 'config.json'), portable: false }
  for (const d of [paths.sessionsDir, paths.attachmentsDir, paths.secretsDir, paths.piDir, paths.backupsDir]) mkdirSync(d)
  writeFileSync(paths.configFile, JSON.stringify({ version: CONFIG_VERSION, onboarded: true, providers: [{ id: 'synthetic-preflight-preservation', name: 'synthetic', baseUrl, model: 'synthetic-model', visionCapable: true }], activeProviderId: 'synthetic-preflight-preservation' }))
  const db = openSchemaDb(paths.dbFile); seed(db)
  const events: ChatEvent[] = []
  const secrets = { get: () => key }
  const config = new ConfigStore(paths.configFile)
  const engine = new Engine(db, paths, config, secrets as never, e => events.push(e))
  return { paths, db, events, secrets, config, engine }
}

function entries(file: string): any[] {
  return readFileSync(file, 'utf8').trim().split('\n').map(l => JSON.parse(l))
}

function sdkSession(engine: Engine): AgentSession {
  return (engine as unknown as { session: AgentSession }).session
}

async function loopback() {
  let mode: 'ok' | 'http-error' | 'hang' = 'ok'
  const requests: { messages: { role: string; content: unknown }[] }[] = []
  const server = http.createServer((req, res) => {
    let body = ''
    req.on('data', c => { body += String(c) })
    req.on('end', () => {
      requests.push(JSON.parse(body))
      if (mode === 'hang') return
      if (mode === 'http-error') {
        res.writeHead(400, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ error: { message: 'synthetic HTTP failure', type: 'invalid_request_error' } }))
        return
      }
      res.writeHead(200, { 'content-type': 'text/event-stream' })
      const chunk = (delta: unknown, finish: string | null = null) => res.write(`data: ${JSON.stringify({ id: 'synthetic', object: 'chat.completion.chunk', created: 1, model: 'synthetic-model', choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`)
      chunk({ role: 'assistant', content: '' })
      chunk({ content: '合成正常答复' })
      chunk({}, 'stop')
      res.end('data: [DONE]\n\n')
    })
  })
  await new Promise<void>(r => server.listen(0, '127.0.0.1', r))
  return {
    url: `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`, requests,
    mode: (value: typeof mode) => { mode = value },
    close: async () => { server.closeAllConnections(); await new Promise<void>(r => server.close(() => r())) },
  }
}

it('首条真实认证前置失败保存同一canonical JSONL；同profile重启稳定恢复原文/图片和诚实本地失败', async () => {
  const f = fixture()
  const text = '  合成失败消息\n逐字保留  '
  const image = { fileName: 'synthetic.png', mediaType: 'image/png', dataBase64: 'c3ludGhldGljLWltYWdl' }
  let other: Engine | undefined
  try {
    await f.engine.start()
    const sessionId = f.engine.sessionId, file = f.engine.sessionFile!
    expect(existsSync(file)).toBe(false)
    await expect(f.engine.sendChat(text, [image])).rejects.toThrow(/API key/)
    expect(existsSync(file)).toBe(true)
    const raw = entries(file)
    expect(raw[0]).toMatchObject({ type: 'session', id: sessionId })
    expect(raw.filter(e => e.type === 'message')).toEqual([])
    expect(raw.filter(e => e.type === 'custom')).toEqual([expect.objectContaining({ customType: 'mingzhang.failed-send', data: { version: 1, displayOnly: true, text, images: [image], error: expect.stringMatching(/API key/) } })])
    const history = parseSessionHistory(file, 300, { strict: true })
    expect(history).toHaveLength(2)
    expect(history[0]).toMatchObject({ role: 'user', text, timestamp: expect.any(Number), images: [{ previewUrl: `data:image/png;base64,${image.dataBase64}`, fileName: image.fileName }] })
    expect(history[1]).toMatchObject({ isError: true, text: expect.stringMatching(/本地发送失败.*API key/), streaming: false })
    expect(new Set(history.map(m => m.id)).size).toBe(2)
    expect(SessionManager.open(file, f.paths.sessionsDir).buildSessionContext().messages).toEqual([])
    expect(f.events.map(e => e.type)).toEqual(['session-changed', 'user-message', 'error', 'turn-end'])
    expect(f.engine.panelHistoryState).toMatchObject({ busy: false, eventCursor: 4, sessionId })
    const bytes = readFileSync(file)
    await f.engine.dispose()
    other = new Engine(f.db, f.paths, f.config, f.secrets as never, () => {})
    await other.start()
    expect(other.sessionId).toBe(sessionId)
    expect(other.sessionFile).toBe(file)
    expect(parseSessionHistory(other.sessionFile!, 300, { strict: true })).toEqual(history)
    // SDK 空模型上下文重启会原生追加 model/thinking 元数据；原字节前缀必须保全。
    expect(readFileSync(file).subarray(0, bytes.length).equals(bytes)).toBe(true)
    expect(entries(file).filter(e => e.type === 'custom')).toHaveLength(1)
    expect(entries(file).filter(e => e.type === 'message')).toEqual([])
    console.log('[first preflight restart]', JSON.stringify({ sessionId, file, rows: history.length, customEntries: 1, sdkMessages: 0, cursor: 4 }))
  } finally { await other?.dispose(); await f.engine.dispose(); f.db.close() }
})

it('同text两次真实认证前置失败各保留；第二次原生append保全原JSONL前缀', async () => {
  const f = fixture()
  try {
    await f.engine.start()
    const file = f.engine.sessionFile!, text = '合成重复失败原文'
    await expect(f.engine.sendChat(text, [])).rejects.toThrow(/API key/)
    const prefix = readFileSync(file), first = parseSessionHistory(file)
    await expect(f.engine.sendChat(text, [])).rejects.toThrow(/API key/)
    const history = parseSessionHistory(file)
    expect(readFileSync(file).subarray(0, prefix.length).equals(prefix)).toBe(true)
    expect(history.slice(0, 2)).toEqual(first)
    expect(history.filter(m => m.role === 'user').map(m => m.text)).toEqual([text, text])
    expect(history.filter(m => m.isError)).toHaveLength(2)
    expect(new Set(history.map(m => m.id)).size).toBe(4)
    expect(entries(file).filter(e => e.type === 'custom')).toHaveLength(2)
    expect(entries(file).filter(e => e.type === 'message')).toEqual([])
    expect(sdkSession(f.engine).sessionManager.buildSessionContext().messages).toEqual([])
    console.log('[repeated preflight]', JSON.stringify({ attempts: 2, displayRows: history.length, prefixBytes: prefix.length, sdkMessages: 0 }))
  } finally { await f.engine.dispose(); f.db.close() }
})

it('认证前置失败custom及原文/图片不进入重启后的下一真实provider请求', async () => {
  const provider = await loopback(), f = fixture(provider.url)
  const failedText = '仅本地的合成失败内容'
  try {
    await f.engine.start()
    const file = f.engine.sessionFile!
    await expect(f.engine.sendChat(failedText, [{ dataBase64: 'c3ludGhldGljLWltYWdl', mediaType: 'image/png' }])).rejects.toThrow(/API key/)
    expect(provider.requests).toEqual([])
    const prefix = readFileSync(file)
    await f.engine.dispose()
    f.secrets.get = () => 'synthetic-test-key'
    await f.engine.start()
    expect(f.engine.sessionFile).toBe(file)
    await f.engine.sendChat('下一轮合成正常消息', [])
    expect(provider.requests).toHaveLength(1)
    expect(provider.requests[0].messages.filter(m => m.role === 'user').map(m => m.content)).toEqual([[{ type: 'text', text: '下一轮合成正常消息' }]])
    expect(JSON.stringify(provider.requests[0])).not.toContain(failedText)
    expect(JSON.stringify(provider.requests[0])).not.toContain('c3ludGhldGljLWltYWdl')
    expect(JSON.stringify(provider.requests[0])).not.toContain('mingzhang.failed-send')
    expect(readFileSync(file).subarray(0, prefix.length).equals(prefix)).toBe(true)
    expect(entries(file).filter(e => e.type === 'custom')).toHaveLength(1)
    expect(parseSessionHistory(file).filter(m => m.role === 'user').map(m => m.text)).toEqual([failedText, '下一轮合成正常消息'])
    console.log('[provider context isolation]', JSON.stringify({ requests: provider.requests.length, userContext: provider.requests[0].messages.filter(m => m.role === 'user'), customEntries: 1 }))
  } finally { await f.engine.dispose(); await provider.close(); f.db.close() }
})

it('已有正常会话的认证失败只原生append；不重写原历史或重放模型', async () => {
  const provider = await loopback(), f = fixture(provider.url, 'synthetic-test-key')
  try {
    await f.engine.start()
    await f.engine.sendChat('合成已有正常用户', [])
    const file = f.engine.sessionFile!, prefix = readFileSync(file), normal = parseSessionHistory(file)
    await sdkSession(f.engine).modelRuntime.removeRuntimeApiKey('synthetic-preflight-preservation')
    await expect(f.engine.sendChat('合成后续认证失败', [])).rejects.toThrow(/API key/)
    expect(provider.requests).toHaveLength(1)
    expect(readFileSync(file).subarray(0, prefix.length).equals(prefix)).toBe(true)
    expect(parseSessionHistory(file).slice(0, normal.length)).toEqual(normal)
    expect(parseSessionHistory(file).filter(m => m.role === 'user').map(m => m.text)).toEqual(['合成已有正常用户', '合成后续认证失败'])
    expect(entries(file).filter(e => e.type === 'custom')).toHaveLength(1)
    expect(sdkSession(f.engine).sessionManager.buildSessionContext().messages.filter(m => m.role === 'user')).toHaveLength(1)
    console.log('[existing file prefix]', JSON.stringify({ prefixBytes: prefix.length, requests: provider.requests.length, customEntries: 1 }))
  } finally { await f.engine.dispose(); await provider.close(); f.db.close() }
})

it('成功/HTTP错误/真实超时已接受用户：零失败custom、每轮恰好一条用户', async () => {
  const provider = await loopback(), f = fixture(provider.url, 'synthetic-test-key')
  vi.stubEnv('MZ_TURN_IDLE_TIMEOUT_MS', '400')
  vi.stubEnv('MZ_TURN_TOTAL_BUDGET_MS', '5000')
  try {
    await f.engine.start()
    const file = f.engine.sessionFile!
    await f.engine.sendChat('合成成功轮', [])
    provider.mode('http-error')
    // pi HTTP 400 折为 stopReason=error 的真实assistant，prompt仍resolve；不改这个旧语义。
    await f.engine.sendChat('合成HTTP错误轮', [])
    expect(entries(file).filter(e => e.type === 'message' && e.message.role === 'assistant').at(-1)?.message.stopReason).toBe('error')
    provider.mode('hang')
    await expect(f.engine.sendChat('合成超时轮', [])).rejects.toMatchObject({ code: 'TURN_TIMEOUT' })
    const raw = entries(file)
    expect(raw.filter(e => e.type === 'custom' && e.customType === 'mingzhang.failed-send')).toEqual([])
    expect(raw.filter(e => e.type === 'message' && e.message.role === 'user').map(e => e.message.content[0].text)).toEqual(['合成成功轮', '合成HTTP错误轮', '合成超时轮'])
    expect(parseSessionHistory(file).filter(m => m.role === 'user').map(m => m.text)).toEqual(['合成成功轮', '合成HTTP错误轮', '合成超时轮'])
    expect(provider.requests).toHaveLength(3)
    expect(f.engine.panelHistoryState.busy).toBe(false)
    console.log('[accepted prompt controls]', JSON.stringify({ requests: provider.requests.length, userEntries: 3, failedSendEntries: 0 }))
  } finally { await f.engine.dispose(); await provider.close(); f.db.close(); vi.unstubAllEnvs() }
})

it('真实checkAuth等待期间切session：失败记录只落captured旧对象的canonical文件', async () => {
  const f = fixture()
  let release: () => void = () => {}
  let entered: () => void = () => {}
  const gate = new Promise<void>(r => { release = r })
  const checking = new Promise<void>(r => { entered = r })
  try {
    await f.engine.start()
    const original = sdkSession(f.engine), oldFile = f.engine.sessionFile!, oldId = f.engine.sessionId
    const nativeCheck = original.modelRuntime.checkAuth.bind(original.modelRuntime)
    const spy = vi.spyOn(original.modelRuntime, 'checkAuth').mockImplementationOnce(async (...args) => { entered(); await gate; return nativeCheck(...args) })
    const work = f.engine.sendChat('合成切换中的认证失败', []).then(() => undefined, error => error)
    await checking
    await f.engine.dispose()
    await f.engine.start({ fresh: true })
    const newFile = f.engine.sessionFile!, newId = f.engine.sessionId
    release()
    const error = await work
    spy.mockRestore()
    expect(error?.message).toMatch(/API key/)
    expect(newId).not.toBe(oldId)
    expect(entries(oldFile).filter(e => e.type === 'custom')).toHaveLength(1)
    expect(parseSessionHistory(oldFile).filter(m => m.role === 'user').map(m => m.text)).toEqual(['合成切换中的认证失败'])
    expect(existsSync(newFile)).toBe(false)
    expect(sdkSession(f.engine).sessionManager.getEntries().filter(e => e.type === 'custom')).toEqual([])
    expect(f.events.filter(e => e.type === 'error' || e.type === 'turn-end').every(e => e.sessionId === oldId)).toBe(true)
    expect(f.engine.panelHistoryState).toMatchObject({ sessionId: newId, busy: false })
    console.log('[switch during checkAuth]', JSON.stringify({ oldId, newId, oldCustomEntries: 1, newCustomEntries: 0 }))
  } finally { release(); vi.restoreAllMocks(); await f.engine.dispose(); f.db.close() }
})

it('原生首文件写入失败：原API key原因及未确认保存可见，不伪造磁盘历史', async () => {
  const f = fixture()
  try {
    await f.engine.start()
    const file = f.engine.sessionFile!
    renameSync(f.paths.sessionsDir, `${f.paths.sessionsDir}-unavailable`)
    await expect(f.engine.sendChat('合成写入失败', [])).rejects.toThrow(/API key[\s\S]*本地失败记录未能确认保存[\s\S]*ENOENT/)
    expect(existsSync(file)).toBe(false)
    expect(parseSessionHistory(file, 300, { strict: true })).toEqual([])
    expect(f.events.filter(e => e.type === 'error')).toHaveLength(1)
    expect(f.events.find(e => e.type === 'error')?.payload.message).toMatch(/API key[\s\S]*未能确认保存/)
    expect(f.events.at(-1)?.type).toBe('turn-end')
    expect(f.engine.panelHistoryState.busy).toBe(false)
    expect((f.db.prepare('SELECT status FROM agent_runs').get() as { status: string }).status).toBe('failed')
    console.log('[native persistence failure]', JSON.stringify({ fileExists: false, failedRun: true, error: f.events.find(e => e.type === 'error')?.payload.message }))
  } finally { await f.engine.dispose(); f.db.close() }
})

it('不认识custom/非法display-only载荷不编造用户和失败消息', () => {
  const dir = mkdtempSync(join(tmpdir(), 'mz-preflight-malformed-')), file = join(dir, 'synthetic.jsonl')
  const valid = { version: 1, displayOnly: true, text: '合成合法本地原文', images: [], error: '合成失败原因' }
  const entry = { type: 'custom', customType: 'mingzhang.failed-send', id: 'synthetic-valid', timestamp: '2025-01-01T00:00:00.000Z', data: valid }
  const invalid = [
    { ...entry, customType: 'other.custom' },
    { ...entry, data: null },
    { ...entry, data: { ...valid, version: 2 } },
    { ...entry, data: { ...valid, displayOnly: false } },
    { ...entry, data: { ...valid, text: 7 } },
    { ...entry, data: { ...valid, error: '' } },
    { ...entry, data: { ...valid, injected: 'no' } },
    { ...entry, data: { ...valid, images: [{ mediaType: 'text/html', dataBase64: 'c3lu' }] } },
    { ...entry, data: { ...valid, images: [{ mediaType: 'image/png', dataBase64: 'invalid data' }] } },
    { ...entry, data: { ...valid, images: [{ mediaType: 'image/png', dataBase64: 'c3lu', fileName: 7 }] } },
    { ...entry, timestamp: 'invalid' },
    { ...entry, id: 9 },
    { ...entry, data: { ...valid, images: 'invalid' } },
  ]
  writeFileSync(file, invalid.concat(entry).map(e => JSON.stringify(e)).join('\n') + '\n')
  expect(parseSessionHistory(file).map(m => ({ role: m.role, text: m.text, isError: m.isError }))).toEqual([
    { role: 'user', text: valid.text, isError: undefined },
    { role: 'assistant', text: `本地发送失败（未送达模型）：${valid.error}`, isError: true },
  ])
  expect(parseSessionHistory(file)).toEqual(parseSessionHistory(file))
  console.log('[custom validation]', JSON.stringify({ invalidEntries: invalid.length, visibleRows: 2 }))
})
