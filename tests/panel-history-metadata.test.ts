// Synthetic JSONL only: persisted metadata must survive read-only recovery.
import { expect, it } from 'vitest'
import { appendFileSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { parseSessionHistory } from '../src/main/history'

it('保留真实timestamp、thinking和toolCallId；追加及最后300截取不重编历史ID', () => {
  const file = join(mkdtempSync(join(tmpdir(), 'mz-history-meta-')), 'synthetic.jsonl')
  const entries = [
    ...Array.from({ length: 302 }, (_, i) => ({ type: 'message', message: { role: 'user', content: '相同合成正文', timestamp: i + 1000 } })),
    { type: 'message', id: 'a', message: { role: 'assistant', timestamp: 2000, content: [{ type: 'thinking', thinking: '合成思考' }, { type: 'text', text: '合成答复' }, { type: 'toolCall', id: 'call-1', name: 'query' }] } },
    { type: 'message', id: 'b', message: { role: 'toolResult', toolCallId: 'call-1', toolName: 'query', content: [{ type: 'text', text: '合成结果' }], isError: true, details: { card: { kind: 'batch-result', completed: [], duplicates: [], unparsedKept: 1 } } } },
    { type: 'message', id: 'c', timestamp: '2020-01-02T00:00:00.000Z', message: { role: 'assistant', content: [{ type: 'thinking', thinking: '只有真实思考' }] } },
  ]
  writeFileSync(file, entries.map(e => JSON.stringify(e)).join('\n') + '\n')
  const full = parseSessionHistory(file, 1000)
  expect(full[0]).toMatchObject({ timestamp: 1000 })
  expect(new Set(full.slice(0, 302).map(m => m.id)).size).toBe(302)
  expect(full.find(m => m.role === 'tool')).toMatchObject({ toolCallId: 'call-1', timestamp: 2000, text: '合成结果', isError: true, card: { kind: 'batch-result' } })
  expect(full.find(m => m.text === '合成答复')).toMatchObject({ timestamp: 2000, thinkingText: '合成思考' })
  expect(full.at(-1)).toMatchObject({ role: 'assistant', text: '', thinkingText: '只有真实思考', timestamp: Date.parse('2020-01-02T00:00:00.000Z') })
  expect(full.every(m => !('thinkingDurationMs' in m))).toBe(true)
  expect(parseSessionHistory(file)).toEqual(full.slice(-300))
  appendFileSync(file, JSON.stringify({ type: 'message', message: { role: 'user', content: '新合成消息' } }) + '\n')
  expect(parseSessionHistory(file, 1000).slice(0, -1)).toEqual(full)
})
