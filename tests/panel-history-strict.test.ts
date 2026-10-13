// Strict snapshot recovery distinguishes missing history from unreadable history.
import { expect, it, vi } from 'vitest'
import * as fs from 'node:fs'
vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>()
  return { ...actual, readFileSync: vi.fn(actual.readFileSync) }
})
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { parseSessionHistory } from '../src/main/history'

it('strict读取仅ENOENT为空；目录/I/O错误可见；旧签名仍容错', () => {
  const dir = fs.mkdtempSync(join(tmpdir(), 'mz-history-strict-'))
  const strict = (file: string) => parseSessionHistory(file, 300, { strict: true })
  expect(strict(join(dir, 'missing.jsonl'))).toEqual([])
  expect(() => strict(dir)).toThrow()
  expect(parseSessionHistory(dir)).toEqual([])
  const file = join(dir, 'synthetic.jsonl')
  fs.writeFileSync(file, '{broken\nnull\n' + JSON.stringify({ type: 'message', id: 'u', message: { role: 'user', content: '合成消息' } }) + '\n')
  expect(strict(file).map(m => m.text)).toEqual(['合成消息'])
  const denied = Object.assign(new Error('synthetic EACCES'), { code: 'EACCES' })
  const original = fs.readFileSync
  const spy = vi.spyOn(fs, 'readFileSync').mockImplementation((...args: Parameters<typeof fs.readFileSync>) => {
    if (args[0] === file) throw denied
    return original(...args)
  })
  try {
    expect(() => strict(file)).toThrow(denied)
    expect(parseSessionHistory(file)).toEqual([])
    const io = Object.assign(new Error('synthetic EIO'), { code: 'EIO' })
    spy.mockImplementation((...args: Parameters<typeof fs.readFileSync>) => {
      if (args[0] === file) throw io
      return original(...args)
    })
    expect(() => strict(file)).toThrow(io)
    expect(parseSessionHistory(file)).toEqual([])
  } finally { spy.mockRestore() }
})
