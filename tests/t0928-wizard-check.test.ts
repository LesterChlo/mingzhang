// T0928-1330 缺陷①与缺陷②：向导的测试连接 / 视觉自检。
//
// 缺陷①（治 401）：编辑模式下 Wizard.tsx 传的是输入框里的**空** apiKey，
//   主进程就拿空 Key 打端点 → 必然 401。修法：入参加 providerId?，
//   主进程在 apiKey 为空且给了 providerId 时回落 secrets.get('provider-key:'+id)；
//   取不到要给明确文案（不许裸 401）。
//
// 缺陷②（读错思考字段名 + 结论分层）：wizard/providers.ts 只读 message.reasoning，
//   而该供应商用 **reasoning_content** → 兜底判定永不生效 → 把能看图的模型
//   误报成"可能不支持视觉"（上游实测：content:'' + reasoning_content:'…纯红色…'）。
//   文案分层：正文与思考都为空 = "没给出颜色答案（可能思考超预算）"；
//   有内容但没提颜色 = 不许断言"不支持视觉"。
//
// 本文件用本地 node http server 假扮 OpenAI 兼容端点，逐字段控制响应。

import { describe, expect, it, beforeEach, afterEach } from 'vitest'
import http from 'node:http'
import type { AddressInfo } from 'node:net'

import { testConnection, visionCheck } from '../src/main/wizard/providers'

interface Captured {
  auth: string | undefined
  body: Record<string, unknown>
}

let server: http.Server
let baseUrl: string
let captured: Captured[]
/** 本次请求要回的 choices[0].message。 */
let reply: Record<string, unknown>
/** 非 200 时的状态码（默认 200）。 */
let status = 200

beforeEach(async () => {
  captured = []
  reply = { content: 'ok' }
  status = 200
  server = http.createServer((req, res) => {
    const chunks: Buffer[] = []
    req.on('data', (c: Buffer) => chunks.push(c))
    req.on('end', () => {
      captured.push({
        auth: req.headers.authorization,
        body: JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown>,
      })
      if (status !== 200) {
        res.writeHead(status, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ error: { message: 'nope' } }))
        return
      }
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ choices: [{ message: reply }] }))
    })
  })
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', () => done()))
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`
})

afterEach(async () => {
  server.closeAllConnections?.()
  await new Promise<void>((done) => server.close(() => done()))
})

// ---------------------------------------------------------------- 缺陷①

describe('缺陷①：空 apiKey 回落该预设已保存的 Key（不再裸 401）', () => {
  it('① 已保存过 Key：编辑模式不传 apiKey、只给 providerId → 用存密钥打通，detail 不含 401', async () => {
    const res = await testConnection({
      baseUrl,
      model: 'm',
      apiKey: '',
      providerId: 'zhipu',
      getSavedKey: (id: string) => (id === 'zhipu' ? 'saved-secret-key' : null),
    })
    expect(res.ok).toBe(true)
    expect(res.detail).not.toContain('401')
    // 端点真收到的是存密钥，不是空串
    expect(captured).toHaveLength(1)
    expect(captured[0].auth).toBe('Bearer saved-secret-key')
  })

  it('② 没有任何存密钥：给明确文案（叫用户回上一步重粘），不许把 HTTP 401 端给用户', async () => {
    const res = await testConnection({
      baseUrl,
      model: 'm',
      apiKey: '',
      providerId: 'zhipu',
      getSavedKey: () => null,
    })
    expect(res.ok).toBe(false)
    expect(res.detail).toBe('未找到该预设已保存的 Key，请回到上一步重新粘贴')
    // 关键：**根本没有打端点**（不该拿空 Key 去换一个 401）
    expect(captured).toHaveLength(0)
  })

  it('③ 新建预设（既没传 apiKey 也没 providerId）：如实提示要 Key，不去打端点', async () => {
    const res = await testConnection({ baseUrl, model: 'm', apiKey: '' })
    expect(res.ok).toBe(false)
    expect(res.detail).toMatch(/API Key/)
    expect(captured).toHaveLength(0)
  })

  it('④ 显式传了 apiKey：优先用它，不回落', async () => {
    await testConnection({
      baseUrl,
      model: 'm',
      apiKey: 'typed-key',
      providerId: 'zhipu',
      getSavedKey: () => 'saved-secret-key',
    })
    expect(captured[0].auth).toBe('Bearer typed-key')
  })
})

// ---------------------------------------------------------------- 缺陷②

describe('缺陷②：视觉自检读 reasoning_content + 结论分层', () => {
  it('① 上游实测同款：content 空、reasoning_content 里有"红" → 判通过（不再误报不支持视觉）', async () => {
    reply = { content: '', reasoning_content: '我看到的图片主色调是纯红色。' }
    const res = await visionCheck({ baseUrl, model: 'm', apiKey: 'k' })
    expect(res.ok).toBe(true)
    expect(res.detail).toContain('通过')
  })

  it('② 正文与思考都为空：说"没给出颜色答案"，**不许**断言"不支持视觉"', async () => {
    reply = { content: '', reasoning: '', reasoning_content: '' }
    const res = await visionCheck({ baseUrl, model: 'm', apiKey: 'k' })
    expect(res.ok).toBe(false)
    expect(res.detail).toContain('模型没给出颜色答案')
    expect(res.detail).toContain('可能思考超预算')
    expect(res.detail).not.toContain('不支持视觉')
  })

  it('③ 有内容但没提颜色：文案不甩"可能不支持视觉"这个断言式结论', async () => {
    reply = { content: '这是一张图片。' }
    const res = await visionCheck({ baseUrl, model: 'm', apiKey: 'k' })
    expect(res.ok).toBe(false)
    expect(res.detail).not.toContain('不支持视觉')
  })

  it('④ 正文里命中颜色也算通过（老口径不回归）', async () => {
    reply = { content: '红色' }
    const res = await visionCheck({ baseUrl, model: 'm', apiKey: 'k' })
    expect(res.ok).toBe(true)
  })

  it('⑤ 视觉自检也走同一套空 Key 回落（编辑模式不传 Key 时报明确文案）', async () => {
    const res = await visionCheck({ baseUrl, model: 'm', apiKey: '', providerId: 'qwen', getSavedKey: () => null })
    expect(res.ok).toBe(false)
    expect(res.detail).toBe('未找到该预设已保存的 Key，请回到上一步重新粘贴')
    expect(captured).toHaveLength(0)
  })
})
