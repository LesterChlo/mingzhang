// 故障注入用的假 provider（OpenAI 兼容 /chat/completions），node http server。
//
// 为什么需要它：真机缺陷是"模型请求卡住时整轮永远不结束"——这种失效在正常
// provider 上复现不了（要么成功要么报错），必须能精确制造六种坏法：
//   hang      接受连接、读完请求体，然后一个字节都不回（真机同款：连接在、无数据）
//   truncate  返回 200 + 部分 SSE 后突然 destroy socket（对端中途断流）
//   drip      每 120ms 吐一个字 delta、永不结束（整轮总时长失控，但事件一直在来）
//   thinking  只吐**思考增量**（delta.reasoning_content）：模型"想很久"但不出正文，
//             到点后正常给一句回复（真机同款：159 行账单那轮 thinking 了 2m05s）
//   stall     吐两口思考增量后彻底静默、连接不断（真机最坏形态：既没进展也没报错）
//   ok        正常：一句话文本回复后 [DONE]
//
// 引擎侧用例（tests/turn-timeout.test.ts）与 UI 巡检（tests/ui/shell-smoke.spec.ts）
// 共用这一个实现——两边的失效模型必须一致，否则 UI 用例证明不了引擎用例证明的东西。

import http from 'node:http'
import type { AddressInfo } from 'node:net'

export type FakeMode = 'hang' | 'truncate' | 'drip' | 'thinking' | 'stall' | 'ok'

export interface FakeThinkingPlan {
  /** 思考增量条数（默认 20） */
  count?: number
  /** 思考增量间隔毫秒（默认 200） */
  intervalMs?: number
}

export interface FakeProvider {
  /** 形如 http://127.0.0.1:<port>/v1（引擎会往 baseUrl + /chat/completions 发） */
  url: string
  setMode(m: FakeMode): void
  mode(): FakeMode
  requests(): number
  close(): Promise<void>
}

function sse(res: http.ServerResponse, obj: unknown): void {
  res.write(`data: ${JSON.stringify(obj)}\n\n`)
}

function chunk(delta: Record<string, unknown>, finish: string | null): Record<string, unknown> {
  return {
    id: 'chatcmpl-fake',
    object: 'chat.completion.chunk',
    created: Math.floor(Date.now() / 1000),
    model: 'fake-model',
    choices: [{ index: 0, delta, finish_reason: finish }],
  }
}

/** 非流式应答（T0928 §1：向导「测试连接」stream:false 走这条路——非流式一律回一句 ok）。 */
function nonStreamJson(res: http.ServerResponse): void {
  res.writeHead(200, { 'content-type': 'application/json' })
  res.end(
    JSON.stringify({
      id: 'chatcmpl-fake',
      object: 'chat.completion',
      created: Math.floor(Date.now() / 1000),
      model: 'fake-model',
      choices: [{ index: 0, message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }],
    }),
  )
}

export async function startFakeProvider(
  initial: FakeMode,
  opts: FakeThinkingPlan = {},
): Promise<FakeProvider> {
  let mode: FakeMode = initial
  let requests = 0
  const thinkingCount = Number.isFinite(opts.count) && (opts.count ?? 0) > 0 ? Math.floor(opts.count as number) : 20
  const thinkingIntervalMs =
    Number.isFinite(opts.intervalMs) && (opts.intervalMs ?? 0) > 0 ? Math.floor(opts.intervalMs as number) : 200
  const timers = new Set<NodeJS.Timeout>()
  const server = http.createServer((req, res) => {
    requests += 1
    // 读请求体：非流式请求（stream:false，如向导的测试连接）需要知道要不要走 SSE
    let body = ''
    req.on('data', (c) => {
      body += String(c)
    })
    req.on('end', () => {
      let wantStream = true
      try {
        const parsed = JSON.parse(body || '{}') as { stream?: boolean }
        wantStream = parsed.stream !== false
      } catch {
        // 请求体不是 JSON 也照流式处理（与旧行为一致）
      }
      const current = mode
      if (!wantStream) {
        // 非流式（向导的测试连接走这条）：hang 语义与流式一致——连接保持、零字节响应；
        // 其余模式一律回一句 ok 的非流式 JSON。
        if (current === 'hang') return
        nonStreamJson(res)
        return
      }
      if (current === 'hang') return // 故意什么都不做：连接保持、零字节响应
      if (current === 'truncate') {
        res.writeHead(200, { 'content-type': 'text/event-stream' })
        sse(res, chunk({ role: 'assistant', content: '' }, null))
        setTimeout(() => res.socket?.destroy(), 60)
        return
      }
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' })

      const finish = (): void => {
        sse(res, chunk({ role: 'assistant', content: '好' }, null))
        sse(res, chunk({ content: '的' }, null))
        sse(res, chunk({}, 'stop'))
        res.write('data: [DONE]\n\n')
        res.end()
      }

      // 思考增量：走 reasoning_content（pi-ai 的 openai-completions 认这个字段，
      // 映射成 assistantMessageEvent.type = 'thinking_delta'）。正文一个字节都不给。
      const startThinking = (n: number, interval: number, thenFinish: boolean): void => {
        sse(res, chunk({ role: 'assistant', content: '' }, null))
        if (n <= 0) {
          if (thenFinish) finish()
          return
        }
        let sent = 0
        const t = setInterval(() => {
          if (res.writableEnded || res.destroyed) {
            clearInterval(t)
            timers.delete(t)
            return
          }
          sent += 1
          sse(res, chunk({ reasoning_content: `思考第 ${sent} 步：先看列含义…` }, null))
          if (sent >= n) {
            clearInterval(t)
            timers.delete(t)
            if (thenFinish) finish()
          }
        }, interval)
        timers.add(t)
        res.on('close', () => {
          clearInterval(t)
          timers.delete(t)
        })
      }

      if (current === 'drip') {
        sse(res, chunk({ role: 'assistant', content: '' }, null))
        const t = setInterval(() => sse(res, chunk({ content: '字' }, null)), 120)
        timers.add(t)
        res.on('close', () => {
          clearInterval(t)
          timers.delete(t)
        })
        return
      }
      if (current === 'thinking') {
        startThinking(thinkingCount, thinkingIntervalMs, true)
        return
      }
      if (current === 'stall') {
        // 吐两口就不吭声了：连接保持、没有 [DONE]、没有任何后续字节。
        startThinking(2, 100, false)
        return
      }
      finish()
    })
  })
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', () => done()))
  const port = (server.address() as AddressInfo).port
  return {
    url: `http://127.0.0.1:${port}/v1`,
    setMode: (m) => {
      mode = m
    },
    mode: () => mode,
    requests: () => requests,
    close: () =>
      new Promise<void>((done) => {
        for (const t of timers) clearInterval(t)
        timers.clear()
        server.closeAllConnections?.()
        server.close(() => done())
      }),
  }
}
