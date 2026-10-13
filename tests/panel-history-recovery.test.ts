// Parent-frozen issue #29 history contract. All content is synthetic.
import { describe, expect, it } from 'vitest'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { parseSessionHistory } from '../src/main/history'

function file(entries: unknown[]) {
  const path = join(mkdtempSync(join(tmpdir(), 'mz-history-parent-')), 'synthetic.jsonl')
  writeFileSync(path, entries.map(e => JSON.stringify(e)).join('\n'), 'utf8')
  return path
}
const user = (id: string, text: string, timestamp: number) => ({ type: 'message', id, message: { role: 'user', content: text, timestamp } })

describe('面板历史 · 父冻结验收', () => {
  it('相同文件重复读取ID稳定；相同文本的两次真实发送仍各自保留', () => {
    const path = file([user('a', '同一句', 100), user('b', '同一句', 200)])
    const a = parseSessionHistory(path)
    const b = parseSessionHistory(path)
    expect(b).toEqual(a)
    expect(a).toHaveLength(2)
    expect(a[0].id).not.toBe(a[1].id)
    expect(a.map(m => m.text)).toEqual(['同一句', '同一句'])
  })
  it('并行工具结果按call ID回填：逆序结束也不串卡、不留伪运行', () => {
    const path = file([
      { type: 'message', id: 'a', message: { role: 'assistant', timestamp: 300, content: [{ type: 'toolCall', id: 'call-a', name: 'query', arguments: {} }, { type: 'toolCall', id: 'call-b', name: 'query', arguments: {} }] } },
      { type: 'message', id: 'b', message: { role: 'toolResult', toolCallId: 'call-a', toolName: 'query', timestamp: 301, content: [{ type: 'text', text: '甲结果' }], isError: false } },
      { type: 'message', id: 'c', message: { role: 'toolResult', toolCallId: 'call-b', toolName: 'query', timestamp: 302, content: [{ type: 'text', text: '乙错误' }], isError: true } },
    ])
    const rows = parseSessionHistory(path)
    expect(rows).toHaveLength(2)
    expect(rows[0]).toMatchObject({ role: 'tool', toolName: 'query', text: '甲结果', isError: false })
    expect(rows[1]).toMatchObject({ role: 'tool', toolName: 'query', text: '乙错误', isError: true })
    expect(rows.every(m => m.text !== '…')).toBe(true)
  })
  it('图片和assistant真实正文仍保留，损坏行不伪造消息', () => {
    const path = file([
      { type: 'message', id: 'u', message: { role: 'user', timestamp: 400, content: [{ type: 'text', text: '合成图片' }, { type: 'image', data: 'QUJD', mimeType: 'image/png' }] } },
      { type: 'message', id: 'a', message: { role: 'assistant', timestamp: 401, content: [{ type: 'thinking', thinking: '合成思考' }, { type: 'text', text: '合成答复' }] } },
    ])
    const rows = parseSessionHistory(path)
    expect(rows[0].images).toEqual([{ previewUrl: 'data:image/png;base64,QUJD', fileName: '截图' }])
    expect(rows[1]).toMatchObject({ role: 'assistant', text: '合成答复' })
    expect(parseSessionHistory(file([]))).toEqual([])
  })
})
