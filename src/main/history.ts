// 会话历史加载（试用反馈 #1）：读当前 pi 会话 JSONL，重建渲染层消息（含工具卡片与图片）。
// 只读；条目类型按 pi session-format：type='message' 内 message.role = user/assistant/toolResult。

import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import type { SessionManager } from '@earendil-works/pi-coding-agent'
import type { ChatMessageDTO } from '../shared/types'

const FAILED_SEND_TYPE = 'mingzhang.failed-send'
interface FailedSendData {
  version: 1
  displayOnly: true
  text: string
  images: { fileName?: string; dataBase64: string; mediaType: string }[]
  error: string
}

/** 只记录真实前置拒绝；custom entry 不进入 pi 的模型上下文。 */
export function preserveFailedSend(manager: SessionManager, text: string, images: FailedSendData['images'], error: string): void {
  const file = manager.getSessionFile()
  const header = manager.getHeader()
  if (!manager.isPersisted() || !file || !header) throw new Error('会话没有可持久化的本地文件')
  // 已有消息/失败尝试意味着此前已落盘；缺文件时停止，防 native append 建出缺 header 残片。
  if (!existsSync(file) && manager.getEntries().some(entry => entry.type === 'message'
    || (entry.type === 'custom' && entry.customType === FAILED_SEND_TYPE))) throw new Error('已有会话文件缺失，拒绝新建失败记录残片')
  const data: FailedSendData = { version: 1, displayOnly: true, text, images: images.map(image => ({ ...image })), error }
  const entryId = manager.appendCustomEntry(FAILED_SEND_TYPE, data)
  // pi 首 assistant 前延迟 flush。只创建原 canonical 文件，wx 拒绝覆盖/并发抢占。
  if (!existsSync(file)) {
    const jsonl = [header, ...manager.getEntries()].map(entry => JSON.stringify(entry)).join('\n') + '\n'
    writeFileSync(file, jsonl, { encoding: 'utf8', flag: 'wx' })
    // 写入已关闭 fd；公开 API 重新索引，后续由 pi 原生 append，绝不改 private 状态。
    manager.setSessionFile(file)
  }
  // native append 或首文件写入后都读回目标；不可读/条目未落盘不能假称已保存。
  const saved = readFileSync(file, 'utf8').split('\n').some(line => {
    try {
      const entry = JSON.parse(line)
      return entry.type === 'custom' && entry.customType === FAILED_SEND_TYPE && entry.id === entryId
        && JSON.stringify(entry.data) === JSON.stringify(data)
    } catch { return false }
  })
  if (!saved) throw new Error('本地会话未写入此次失败记录')
}

function failedSendData(value: unknown): FailedSendData | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined
  const data = value as Record<string, unknown>
  if (Object.keys(data).some(key => !['version', 'displayOnly', 'text', 'images', 'error'].includes(key))
    || data.version !== 1 || data.displayOnly !== true || typeof data.text !== 'string'
    || typeof data.error !== 'string' || !data.error || !Array.isArray(data.images)) return undefined
  for (const image of data.images) {
    if (!image || typeof image !== 'object' || Array.isArray(image)
      || Object.keys(image).some(key => !['fileName', 'dataBase64', 'mediaType'].includes(key))
      || (image.fileName !== undefined && typeof image.fileName !== 'string')
      || typeof image.dataBase64 !== 'string' || !image.dataBase64
      || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(image.dataBase64)
      || !['image/png', 'image/jpeg', 'image/webp', 'image/gif'].includes(image.mediaType)) return undefined
  }
  return data as unknown as FailedSendData
}

interface ContentPart {
  type: string
  id?: string
  name?: string
  text?: string
  thinking?: string
  data?: string
  mimeType?: string
  image_url?: { url?: string }
}

interface SessionEntry {
  type: string
  id?: string
  timestamp?: string
  customType?: string
  data?: unknown
  message?: {
    role: string
    timestamp?: number
    content?: string | ContentPart[]
    stopReason?: string
    toolName?: string
    toolCallId?: string
    isError?: boolean
    details?: Record<string, unknown>
  }
}

function partText(parts: ContentPart[]): string {
  return parts
    .filter((p) => p.type === 'text' && typeof p.text === 'string' && !/^\(image omitted/.test(p.text))
    .map((p) => p.text ?? '')
    .join('')
}

/** 解析会话文件为渲染层消息。上限 maxMessages 防超长会话卡顿（取最近的）。 */
export function parseSessionHistory(sessionFile: string, maxMessages = 300, options: { strict?: boolean } = {}): ChatMessageDTO[] {
  const out: ChatMessageDTO[] = []
  let lines: string[]
  try {
    lines = readFileSync(sessionFile, 'utf8').split('\n')
  } catch (error) {
    // 缺文件确实是空历史；存在但不可读则由快照通道把真实错误交给 UI。
    if (options.strict && (error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    return []
  }
  // 文件身份 + 持久化行/条目身份 + 内容槽位：重读、截取、追加都不重编 ID。
  const fileId = createHash('sha256').update(sessionFile).digest('hex').slice(0, 16)
  const pending: { message: ChatMessageDTO; callId?: string; completed: boolean }[] = []
  for (const [lineIndex, line] of lines.entries()) {
    if (!line.trim()) continue
    let entry: SessionEntry
    try {
      entry = JSON.parse(line) as SessionEntry
    } catch {
      continue
    }
    if (!entry || typeof entry !== 'object') continue
    const id = `h-${fileId}-${lineIndex}-${entry.id ?? 'entry'}`
    if (entry.type === 'custom' && entry.customType === FAILED_SEND_TYPE) {
      const data = failedSendData(entry.data)
      if (!data || typeof entry.id !== 'string' || !entry.id
        || typeof entry.timestamp !== 'string' || !Number.isFinite(Date.parse(entry.timestamp))) continue
      const timestamp = Date.parse(entry.timestamp)
      const images = data.images.map(image => ({ previewUrl: `data:${image.mediaType};base64,${image.dataBase64}`, fileName: image.fileName ?? '截图' }))
      out.push({ id: `${id}-user`, role: 'user', text: data.text, timestamp, images: images.length > 0 ? images : undefined })
      // DTO 无独立本地错误角色；显式标记错误、逐字说明未送模型，不合成 SDK assistant。
      out.push({ id: `${id}-failed-send`, role: 'assistant', text: `本地发送失败（未送达模型）：${data.error}`, timestamp, isError: true, streaming: false })
      continue
    }
    if (entry.type !== 'message' || !entry.message) continue
    const m = entry.message
    const timestamp = typeof m.timestamp === 'number' && Number.isFinite(m.timestamp)
      ? m.timestamp
      : typeof entry.timestamp === 'string' && Number.isFinite(Date.parse(entry.timestamp))
        ? Date.parse(entry.timestamp)
        : undefined
    const content: ContentPart[] = Array.isArray(m.content)
      ? m.content.filter((p) => p && typeof p === 'object')
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
          id: `${id}-user`,
          role: 'user',
          timestamp,
          text: text || `（发来了 ${images.length} 张图片）`,
          images: images.length > 0 ? images : undefined,
        })
      }
      continue
    }

    if (m.role === 'assistant') {
      for (const [partIndex, tc] of content.entries()) {
        if (tc.type !== 'toolCall') continue
        const message: ChatMessageDTO = { id: `${id}-tool-${partIndex}`, role: 'tool', toolName: String(tc.name ?? ''), toolCallId: tc.id, timestamp, text: '…' }
        out.push(message)
        pending.push({ message, callId: tc.id, completed: false })
      }
      const text = partText(content)
      const thinkingText = content.filter(p => p.type === 'thinking' && typeof p.thinking === 'string').map(p => p.thinking).join('') || undefined
      if (text || thinkingText) out.push({ id: `${id}-assistant`, role: 'assistant', text, thinkingText, timestamp, streaming: false })
      continue
    }

    if (m.role === 'toolResult') {
      const text = partText(content)
      // 已知 ID 绝不退回按名称猜配；老记录缺 ID 时仅回填最近未完成的同名槽。
      const slot = m.toolCallId
        ? pending.findLast((p) => !p.completed && p.callId === m.toolCallId)
        : pending.findLast((p) => !p.completed && p.message.toolName === String(m.toolName ?? ''))
      const result = {
        text,
        isError: Boolean(m.isError),
        card: (m.details as { card?: ChatMessageDTO['card'] } | undefined)?.card,
      }
      if (slot) {
        Object.assign(slot.message, result)
        slot.completed = true
      } else {
        out.push({ id: `${id}-result`, role: 'tool', toolName: String(m.toolName ?? ''), toolCallId: m.toolCallId, timestamp, ...result })
      }
    }
  }
  return out.slice(-maxMessages)
}
