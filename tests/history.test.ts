// 试用反馈 #1：会话历史解析单测（JSONL → 渲染层消息，含工具卡片与图片）。

import { describe, expect, it } from 'vitest'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { parseSessionHistory } from '../src/main/history'

function writeSession(lines: unknown[]): string {
  const dir = mkdtempSync(join(tmpdir(), 'mz-hist-'))
  const f = join(dir, 'session.jsonl')
  writeFileSync(f, lines.map((l) => JSON.stringify(l)).join('\n'), 'utf8')
  return f
}

describe('parseSessionHistory', () => {
  it('重建 user/assistant/tool 卡片序列；图片还原为 dataUrl', () => {
    const f = writeSession([
      { type: 'session', version: 1, id: 's1', timestamp: 't', cwd: '.' },
      { type: 'model_change', id: 'a', parentId: null, timestamp: 't', provider: 'p', modelId: 'm' },
      {
        type: 'message',
        id: 'b',
        parentId: 'a',
        timestamp: 't',
        message: {
          role: 'user',
          content: [
            { type: 'text', text: '星巴克 35' },
            { type: 'image', data: 'QUJD', mimeType: 'image/png' },
          ],
        },
      },
      {
        type: 'message',
        id: 'c',
        parentId: 'b',
        timestamp: 't',
        message: {
          role: 'assistant',
          content: [{ type: 'toolCall', id: 'call1', name: 'record', arguments: {} }],
          stopReason: 'toolUse',
        },
      },
      {
        type: 'message',
        id: 'd',
        parentId: 'c',
        timestamp: 't',
        message: {
          role: 'toolResult',
          toolName: 'record',
          isError: false,
          content: [{ type: 'text', text: '已入账：交易 #1，¥35.00 · 星巴克 · 餐饮（confirmed）' }],
          details: { card: { kind: 'transaction', tx: { id: 1, amountCents: 3500, type: 'expense', state: 'confirmed', occurredAt: 't', merchant: '星巴克', categoryName: '餐饮', accountName: '现金', toAccountName: null, confidenceScore: 0.95, note: null } } },
        },
      },
      {
        type: 'message',
        id: 'e',
        parentId: 'd',
        timestamp: 't',
        message: { role: 'assistant', content: [{ type: 'thinking', thinking: '…' }, { type: 'text', text: '记好了。' }], stopReason: 'stop' },
      },
    ])
    const msgs = parseSessionHistory(f)
    // user + tool(调用) + assistant = 3；toolResult 合并进 tool 条目（与实时行为一致）
    expect(msgs).toHaveLength(3)
    expect(msgs[0].role).toBe('user')
    expect(msgs[0].text).toBe('星巴克 35')
    expect(msgs[0].images?.[0].previewUrl).toContain('data:image/png;base64,QUJD')
    expect(msgs[1]).toMatchObject({ role: 'tool', toolName: 'record' })
    expect(msgs[1].text).toContain('已入账')
    expect(msgs[1].card?.tx?.id).toBe(1)
    expect(msgs[2]).toMatchObject({ role: 'assistant', text: '记好了。' })
  })

  it('过滤 "(image omitted" 降级占位；缺文件/坏行容错；空会话 → 空', () => {
    const f = writeSession([
      { type: 'message', id: '1', parentId: null, timestamp: 't', message: { role: 'user', content: [{ type: 'text', text: '瑞幸 12' }, { type: 'text', text: '(image omitted: model does not support images)' }] } },
      { type: 'message', id: '2', parentId: '1', timestamp: 't', message: { role: 'assistant', content: [{ type: 'text', text: '已入账。' }] } },
    ])
    const msgs = parseSessionHistory(f)
    expect(msgs[0].text).toBe('瑞幸 12')
    expect(parseSessionHistory(join(tmpdir(), 'not-exist.jsonl'))).toEqual([])
    const bad = join(tmpdir(), 'bad.jsonl')
    writeFileSync(bad, '{broken\n', 'utf8')
    expect(parseSessionHistory(bad)).toEqual([])
  })
})
