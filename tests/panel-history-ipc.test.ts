// IPC/preload wire contract; Electron mocked, JSONL reads are real and synthetic.
import { expect, it, vi } from 'vitest'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
const { handlers, invokes, exposed } = vi.hoisted(() => ({ handlers: new Map<string, (...args: any[]) => any>(), invokes: vi.fn(), exposed: vi.fn() }))
vi.mock('electron', () => ({ ipcMain: { handle: (name: string, fn: (...args: any[]) => any) => handlers.set(name, fn) }, nativeTheme: {}, ipcRenderer: { invoke: invokes, on: vi.fn(), removeListener: vi.fn() }, contextBridge: { exposeInMainWorld: exposed } }))
import { registerIpc } from '../src/main/ipc'
import { createEngineRegistry } from '../src/main/engine/registry'
import { parseSessionHistory } from '../src/main/history'

it('getPanelHistory同步拍当前引擎状态+JSONL；无引擎空快照；严格错误透出且动态重绑', () => {
  const engines = createEngineRegistry<any>()
  const fail = vi.fn(() => { throw new Error('read-only API must not request a model') })
  registerIpc({ engines, getDb: () => null, restartEngine: fail } as never, { dataDir: 'synthetic', dbFile: 'synthetic' })
  expect(handlers.has('mz:getPanelHistory')).toBe(true)
  const read = () => handlers.get('mz:getPanelHistory')!({})
  expect(read()).toEqual({ sessionId: null, streamId: null, eventCursor: 0, busy: false, messages: [] })
  const dir = mkdtempSync(join(tmpdir(), 'mz-history-ipc-'))
  const file = join(dir, 'synthetic.jsonl')
  writeFileSync(file, JSON.stringify({ type: 'message', id: 'u', message: { role: 'user', content: '合成消息', timestamp: 100 } }) + '\n')
  const state = { sessionId: 's-1', streamId: 'stream-1', eventCursor: 7, busy: false }
  engines.set({ panelHistoryState: state, sessionFile: file, sendChat: fail, start: fail })
  expect(read()).toEqual({ ...state, messages: parseSessionHistory(file) })
  expect(read()).not.toBeInstanceOf(Promise)
  expect(handlers.get('mz:loadHistory')!({})).toEqual(parseSessionHistory(file))
  engines.set({ panelHistoryState: { ...state, sessionId: 's-2', streamId: 'stream-2', eventCursor: 1, busy: true }, sessionFile: join(dir, 'missing.jsonl') })
  expect(read()).toEqual({ sessionId: 's-2', streamId: 'stream-2', eventCursor: 1, busy: true, messages: [] })
  engines.set({ panelHistoryState: state, sessionFile: dir })
  expect(() => read()).toThrow()
  expect(fail).not.toHaveBeenCalled()
})

it('preload精确转发getPanelHistory，不加模型请求或异步副作用', async () => {
  await import('../src/preload/index')
  const api = exposed.mock.calls[0][1]
  expect(typeof api.getPanelHistory).toBe('function')
  api.getPanelHistory()
  expect(invokes).toHaveBeenLastCalledWith('mz:getPanelHistory')
})
