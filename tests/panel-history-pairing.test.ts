import { expect, it } from 'vitest'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { parseSessionHistory } from '../src/main/history'

it('真正逆序结束回填同名并行工具；不同已知ID不得串槽，缺ID只兼容同名未完成call', () => {
  const file = join(mkdtempSync(join(tmpdir(), 'mz-history-pairing-')), 'synthetic.jsonl')
  const call = (id: string, name: string) => ({ type: 'toolCall', id, name })
  const result = (id: string, name: string, text: string, toolCallId?: string) => ({ type: 'message', id, message: { role: 'toolResult', toolName: name, toolCallId, content: [{ type: 'text', text }] } })
  writeFileSync(file, [
    { type: 'message', id: 'a', message: { role: 'assistant', content: [call('call-a', 'query'), call('call-b', 'query'), call('call-c', 'record')] } },
    result('b', 'query', 'B完成', 'call-b'),
    result('c', 'query', 'A完成', 'call-a'),
    result('d', 'query', '未知ID不能填record', 'call-unknown'),
    result('e', 'query', '缺ID也不能填不同名字'),
    result('f', 'record', '兼容C完成'),
    { type: 'message', id: 'g', message: { role: 'assistant', content: [call('call-d', 'query'), call('call-e', 'query')] } },
    result('h', 'query', '兼容E完成'),
    result('i', 'query', '兼容D完成'),
  ].map(e => JSON.stringify(e)).join('\n'))
  const rows = parseSessionHistory(file)
  expect(rows.map(m => m.text)).toEqual(['A完成', 'B完成', '兼容C完成', '未知ID不能填record', '缺ID也不能填不同名字', '兼容D完成', '兼容E完成'])
  expect(rows[0].toolCallId).toBe('call-a')
  expect(rows[1].toolCallId).toBe('call-b')
  expect(rows[3].toolCallId).toBe('call-unknown')
  expect(parseSessionHistory(file)).toEqual(rows)
})
