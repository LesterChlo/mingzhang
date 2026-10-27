import { beforeEach, expect, it, vi } from 'vitest'
const { handlers, invokes } = vi.hoisted(() => ({
  handlers: new Map<string, (...args: any[]) => any>(),
  invokes: vi.fn(),
}))
vi.mock('electron', () => ({
  ipcMain: { handle: (name: string, fn: (...args: any[]) => any) => handlers.set(name, fn) },
  nativeTheme: {},
  ipcRenderer: { invoke: invokes, on: vi.fn(), removeListener: vi.fn() },
  contextBridge: { exposeInMainWorld: vi.fn() },
}))
import { registerIpc } from '../src/main/ipc'
import { openSchemaDb } from './helpers'
import { seed } from '../src/main/db/seed'
import { createTransaction } from '../src/main/domain/ledger'

beforeEach(() => {
  handlers.clear()
  invokes.mockClear()
})

it('preload只读表单桥接精确调用冻结通道', async () => {
  const { contextBridge } = await import('electron')
  const expose = vi.mocked(contextBridge.exposeInMainWorld)
  expose.mockClear()
  await import('../src/preload/index')
  const api = expose.mock.calls[0][1]
  api.getTransactionEditForm(17)
  expect(invokes).toHaveBeenLastCalledWith('mz:getTransactionEditForm', 17)
})

it('IPC动态读取当前数据库并返回表单，不在query_only下写入', () => {
  let current = openSchemaDb(':memory:')
  seed(current)
  const tx1 = createTransaction(current, { amountCents: 310, txType: 'expense', merchant: '首个合成数据库' })
  const before1 = current.prepare('SELECT * FROM audit_log ORDER BY id').all()
  registerIpc({ getDb: () => current } as never, { dataDir: 'synthetic', dbFile: ':memory:' })
  const handler = handlers.get('mz:getTransactionEditForm')
  expect(handler).toBeTypeOf('function')
  current.pragma('query_only=ON')
  expect(handler!({}, tx1)).toMatchObject({ txId: tx1, occurredAt: expect.any(String), txType: 'expense' })
  expect(current.prepare('SELECT * FROM audit_log ORDER BY id').all()).toEqual(before1)
  current.pragma('query_only=OFF')
  current.close()

  const second = openSchemaDb(':memory:')
  seed(second)
  const tx2 = createTransaction(second, { amountCents: 420, txType: 'income', merchant: '第二个合成数据库' })
  current = second
  expect(handler!({}, tx2)).toMatchObject({ txId: tx2, txType: 'income' })
  current.close()
})

it('无账本返回null，非法ID由主进程拒绝', () => {
  registerIpc({ getDb: () => null } as never, { dataDir: 'synthetic', dbFile: 'none' })
  expect(handlers.get('mz:getTransactionEditForm')!({}, 1)).toBeNull()

  const db = openSchemaDb(':memory:')
  seed(db)
  registerIpc({ getDb: () => db } as never, { dataDir: 'synthetic', dbFile: ':memory:' })
  const handler = handlers.get('mz:getTransactionEditForm')!
  expect(() => handler!({}, 1.25)).toThrow()
  expect(() => handler!({}, Number.MAX_SAFE_INTEGER + 1)).toThrow()
  db.close()
})
