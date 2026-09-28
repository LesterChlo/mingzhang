// 首启向导：供应商预设 + 测试连接 + 视觉自检（决定记录 §4）。
// 预设只管端点 URL，模型名由用户按服务商文档填写（沿老版口径）。
// 测试/自检直接打 OpenAI 兼容端点（与老版 llm/test 同构）；引擎侧的 pi 链路在保存后由对话验证。

import type { ProviderPreset, TestConnectionResult } from '../../shared/types'
import { makeSolidColorPngBase64 } from './png'

export const PROVIDER_PRESETS: ProviderPreset[] = [
  { id: 'deepseek', name: 'DeepSeek', baseUrl: 'https://api.deepseek.com', hint: '模型 ID 按 DeepSeek 文档填（如 deepseek-chat）' },
  { id: 'zhipu', name: '智谱 GLM', baseUrl: 'https://open.bigmodel.cn/api/paas/v4', hint: '模型 ID 按 docs.bigmodel.cn 填' },
  { id: 'qwen', name: '通义千问（百炼）', baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1', hint: '模型 ID 按百炼「支持的模型」填' },
  { id: 'local', name: '本地 OpenAI 兼容端点', baseUrl: 'http://127.0.0.1:8080/v1', hint: '本地 llama.cpp / vLLM 等，需已启动' },
  { id: 'custom', name: '自定义端点', baseUrl: '', hint: '填完整 OpenAI 兼容 Base URL' },
]

function withTimeout(ms: number): { signal: AbortSignal; done: () => void } {
  const controller = new AbortController()
  const t = setTimeout(() => controller.abort(), ms)
  return { signal: controller.signal, done: () => clearTimeout(t) }
}

async function chatCompletion(
  baseUrl: string,
  model: string,
  apiKey: string,
  body: Record<string, unknown>,
): Promise<{ ok: true; content: string; reasoning: string } | { ok: false; detail: string }> {
  const url = `${baseUrl.replace(/\/+$/, '')}/chat/completions`
  const { signal, done } = withTimeout(45_000)
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${apiKey}` },
      body: JSON.stringify(body),
      signal,
    })
    if (!res.ok) {
      const text = await res.text().catch(() => '')
      return { ok: false, detail: `HTTP ${res.status}：${text.slice(0, 300) || res.statusText}` }
    }
    const json = (await res.json()) as {
      choices?: { message?: { content?: string; reasoning?: string; reasoning_content?: string } }[]
    }
    const msg = json.choices?.[0]?.message ?? {}
    // 思考字段名有两套：OpenAI 官方 reasoning / 国内供应商（DeepSeek 等）reasoning_content。
    // 只读 reasoning 会让 reasoning_content 的思考整段丢失（缺陷②：把能看图的模型误报成"不支持视觉"）。
    const reasoning = msg.reasoning ?? msg.reasoning_content ?? ''
    return { ok: true, content: msg.content ?? '', reasoning }
  } catch (err) {
    const e = err as Error
    const detail = e.name === 'AbortError' ? '连接超时（45s）' : `连接失败：${e.message}`
    return { ok: false, detail }
  } finally {
    done()
  }
}

/**
 * 测试连接 / 视觉自检的入参。
 *
 * 编辑模式下向导的输入框里是**空**的（Key 只存在本机密钥库里），老实现直接拿空串
 * 打端点 → 必然 401，而 401 对用户毫无信息量。所以除明文 apiKey 外再给
 * providerId + getSavedKey：主进程把 secrets.get('provider-key:'+id) 包成回调传进来，
 * 由本模块在 apiKey 为空时回落取已存 Key；取不到就报明确文案（不拿空 Key 去换一个 401）。
 */
export interface ProviderProbeInput {
  baseUrl: string
  model: string
  /** 明文 Key（新建预设时用户刚粘的）。编辑模式留空即可，会按 providerId 回落。 */
  apiKey?: string
  /** 预设 id：给了才允许回落取已存 Key。 */
  providerId?: string
  /** 取该预设已保存的 Key（主进程注入 secrets 读取口；单测注入假实现）。 */
  getSavedKey?: (providerId: string) => string | null
}

/** 取不到 Key 时的统一文案：告诉用户回上一步重粘，而不是甩一个 401。 */
const NO_SAVED_KEY = '未找到该预设已保存的 Key，请回到上一步重新粘贴'

/** 解析本次探测要用的 Key：明文优先 → 回落已存 → 都没有就别打端点。 */
function resolveApiKey(input: ProviderProbeInput): { ok: true; apiKey: string } | { ok: false; detail: string } {
  const typed = (input.apiKey ?? '').trim()
  if (typed) return { ok: true, apiKey: typed }
  if (!input.providerId) return { ok: false, detail: '请先填写 API Key' }
  const saved = input.getSavedKey?.(input.providerId) ?? null
  if (saved) return { ok: true, apiKey: saved }
  return { ok: false, detail: NO_SAVED_KEY }
}

/** 测试连接：最小文本请求。 */
export async function testConnection(input: {
  providerId?: string
  getSavedKey?: (providerId: string) => string | null
  baseUrl: string
  model: string
  apiKey?: string
}): Promise<TestConnectionResult> {
  if (!input.baseUrl || !input.model) return { ok: false, detail: 'Base URL 与模型名必填' }
  const key = resolveApiKey(input)
  if (!key.ok) return key
  const res = await chatCompletion(input.baseUrl, input.model, key.apiKey, {
    model: input.model,
    messages: [{ role: 'user', content: '回复"ok"两个字即可' }],
    max_tokens: 256, // 思考型模型：预算太小会被 reasoning 吃光（2026-09-19 实测修）
    stream: false,
  })
  return res.ok
    ? { ok: true, detail: `连接成功，模型已应答（${res.content.slice(0, 40) || '空响应'}）` }
    : { ok: false, detail: res.detail }
}

/**
 * 视觉自检：内置纯红色小图，要求模型报颜色；回答含「红/red」即通过。
 * 通过 = 模型确实能吃图（而非仅声明）。
 */
export async function visionCheck(input: {
  providerId?: string
  getSavedKey?: (providerId: string) => string | null
  baseUrl: string
  model: string
  apiKey?: string
}): Promise<TestConnectionResult> {
  if (!input.baseUrl || !input.model) return { ok: false, detail: 'Base URL 与模型名必填' }
  const key = resolveApiKey(input)
  if (!key.ok) return key
  const pngBase64 = makeSolidColorPngBase64(64, 64, [220, 38, 38])
  const res = await chatCompletion(input.baseUrl, input.model, key.apiKey, {
    model: input.model,
    messages: [
      {
        role: 'user',
        content: [
          { type: 'text', text: '这张图片的主色调是什么？只回答颜色名。' },
          { type: 'image_url', image_url: { url: `data:image/png;base64,${pngBase64}` } },
        ],
      },
    ],
    max_tokens: 512, // 思考型模型：16 的预算全被 reasoning 吃掉 → 空正文（finish_reason=length）；512 留足思考+答案
    stream: false,
  })
  if (!res.ok) return { ok: false, detail: res.detail }
  // 命中判定：正文与思考任一提到颜色即算识别成功（思考型模型常把预算吃光、正文为空）
  const hit = /红|red/i.test(res.content) || /红|red/i.test(res.reasoning)
  if (hit) return { ok: true, detail: '视觉自检通过：模型正确识别了测试图的颜色' }
  // 结论分层（缺陷②）：分清"模型什么都没说"与"模型说了但没说颜色"。
  // 老文案一律甩"可能不支持视觉"——那是断言式结论：没答对颜色 ≠ 模型看不见图
  // （思考超预算、正文被截断、模型答非所问都会走到这里）。
  const reply = (res.content || res.reasoning).trim()
  if (!reply) return { ok: false, detail: '模型没给出颜色答案（正文与思考都是空的，可能思考超预算），可再试一次' }
  return { ok: false, detail: `模型有响应但没提颜色（${reply.slice(0, 60)}），这次没能确认它的视觉能力，可再试一次` }
}
