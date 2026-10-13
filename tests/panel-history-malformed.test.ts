// Syntactically valid but structurally broken JSONL lines must not abort all recovery.
import { expect, it } from 'vitest'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { parseSessionHistory } from '../src/main/history'
it('坏行中数值thinking/text不崩溃或伪造正文，后续真实消息仍恢复', () => {
  const file = join(mkdtempSync(join(tmpdir(), 'mz-history-bad-lines-')), 'synthetic.jsonl')
  writeFileSync(file, [
    'null', 'true', '[]', '{broken',
    JSON.stringify({ type: 'message', message: { role: 'user', content: [null, { type: 'text', text: { invalid: true } }] } }),
    JSON.stringify({ type: 'message', message: { role: 'assistant', content: [{ type: 'thinking', thinking: 12 }, { type: 'text', text: false }] } }),
    JSON.stringify({ type: 'message', message: { role: 'user', content: '后续合成正文' } }),
  ].join('\n'))
  expect(parseSessionHistory(file, 300, { strict: true }).map(m => m.text)).toEqual(['后续合成正文'])
})
