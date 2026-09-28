// 会话历史加载（试用反馈 #1）：读当前 pi 会话 JSONL，重建渲染层消息（含工具卡片与图片）。
// 只读；条目类型按 pi session-format：type='message' 内 message.role = user/assistant/toolResult。

import { readFileSync, existsSync } from 'node:fs'
import type { ChatMessageDTO } from '../shared/types'

interface ContentPart {
  type: string
  text?: string
  data?: string
  mimeType?: string
  image_url?: { url?: string }
}

interface SessionEntry {
  type: string
  message?: {
    role: string
    content?: string | ContentPart[]
    stopReason?: string
    toolName?: string
    isError?: boolean
    details?: Record<string, unknown>
  }
}

let seq = 0

function partText(parts: ContentPart[]): string {
  return parts
    .filter((p) => p.type === 'text' && !/^\(image omitted/.test(p.text ?? ''))
    .map((p) => p.text ?? '')
    .join('')
}

/** 解析会话文件为渲染层消息。上限 maxEntries 防超长会话卡顿（取最近的）。 */
export function parseSessionHistory(sessionFile: string, maxMessages = 300): ChatMessageDTO[] {
  if (!existsSync(sessionFile)) return []
  const out: ChatMessageDTO[] = []
  let lines: string[]
  try {
    lines = readFileSync(sessionFile, 'utf8').split('\n')
  } catch {
    return []
  }
  for (const line of lines) {
    if (!line.trim()) continue
    let entry: SessionEntry
    try {
      entry = JSON.parse(line) as SessionEntry
    } catch {
      continue
    }
    if (entry.type !== 'message' || !entry.message) continue
    const m = entry.message
    const content: ContentPart[] = Array.isArray(m.content)
      ? m.content
      : typeof m.content === 'string'
        ? [{ type: 'text', text: m.content }]
        : []

    if (m.role === 'user') {
      const text = partText(content)
      const images = content
        .filter((p) => p.type === 'image' && p.data)
        .map((p) => ({ previewUrl: `data:${p.mimeType ?? 'image/png'};base64,${p.data}`, fileName: '截图' }))
      if (text || images.length > 0) {
        out.push({
          id: `h-${++seq}`,
          role: 'user',
          text: text || `（发来了 ${images.length} 张图片）`,
          images: images.length > 0 ? images : undefined,
        })
      }
      continue
    }

    if (m.role === 'assistant') {
      const toolCalls = content.filter((p) => p.type === 'toolCall')
      for (const tc of toolCalls) {
        out.push({ id: `h-${++seq}`, role: 'tool', toolName: String((tc as { name?: string }).name ?? ''), text: '…' })
      }
      const text = partText(content)
      if (text) {
        out.push({ id: `h-${++seq}`, role: 'assistant', text, streaming: false })
      }
      continue
    }

    if (m.role === 'toolResult') {
      const last = out[out.length - 1]
      const text = partText(content)
      if (last && last.role === 'tool' && last.text === '…') {
        last.text = text
        last.isError = Boolean(m.isError)
        const card = (m.details as { card?: unknown } | undefined)?.card
        if (card) last.card = card as ChatMessageDTO['card']
      } else {
        out.push({
          id: `h-${++seq}`,
          role: 'tool',
          toolName: String(m.toolName ?? ''),
          text,
          isError: Boolean(m.isError),
          card: (m.details as { card?: ChatMessageDTO['card'] } | undefined)?.card,
        })
      }
      continue
    }
  }
  return out.slice(-maxMessages).map((m) => ({ ...m, id: `h-${++seq}` }))
}
