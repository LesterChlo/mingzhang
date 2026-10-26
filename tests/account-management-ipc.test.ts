import { describe, expect, it, vi } from 'vitest'
import type { MingZhangApi } from '../src/shared/types'
import { openSchemaDb } from './helpers'
import { seed } from '../src/main/db/seed'
import { createTransaction, recordParse, confirm } from '../src/main/domain/ledger'

const { handlers, exposes, invokes } = vi.hoisted(() => ({
  handlers: new Map<string, (...args: any[]) => any>(),
  exposes: vi.fn(),
  invokes: vi.fn(),
}))
vi.mock('electron', () => ({
  ipcMain: { handle: (name: string, fn: (...args: any[]) => any) => handlers.set(name, fn) },
  nativeTheme: {},
  ipcRenderer: { invoke: invokes, on: vi.fn(), removeListener: vi.fn() },
  contextBridge: { exposeInMainWorld: exposes },
}))
import { registerIpc } from '../src/main/ipc'

const channels = ['getAccountSummary', 'createAccount', 'renameAccount', 'createCategory', 'renameCategory'] as const
function fixture() { const db = openSchemaDb(':memory:'); seed(db); return db }
function state(db: ReturnType<typeof fixture>) {
  return ['accounts', 'categories', 'transactions', 'rules', 'audit_log', 'settings', 'sqlite_sequence'].map(table => db.prepare(`SELECT * FROM ${table}`).all())
}
function handler(name: typeof channels[number]): (...args: any[]) => any {
  expect(handlers.has(`mz:${name}`)).toBe(true)
  return handlers.get(`mz:${name}`)!
}

it('preload 精确暴露五个冻结签名与通道，保留原 listAccounts/listCategories', async () => {
  await import('../src/preload/index')
  expect(exposes).toHaveBeenCalledWith('mz', expect.any(Object))
  const api = exposes.mock.calls[0][1] as MingZhangApi
  for (const name of [...channels, 'listAccounts', 'listCategories']) expect(typeof api[name]).toBe('function')
  api.getAccountSummary('2026-02'); expect(invokes).toHaveBeenLastCalledWith('mz:getAccountSummary', '2026-02')
  api.getAccountSummary(); expect(invokes).toHaveBeenLastCalledWith('mz:getAccountSummary', undefined)
  const account = { name: '合成IPC卡', type: 'bank' as const }
  api.createAccount(account); expect(invokes).toHaveBeenLastCalledWith('mz:createAccount', account)
  const accountRename = { accountId: 1, expectedName: '现金', newName: '合成IPC现金' }
  api.renameAccount(accountRename); expect(invokes).toHaveBeenLastCalledWith('mz:renameAccount', accountRename)
  const category = { name: '合成IPC类', kind: 'expense' as const }
  api.createCategory(category); expect(invokes).toHaveBeenLastCalledWith('mz:createCategory', category)
  const categoryRename = { categoryId: 1, expectedName: '餐饮', newName: '合成IPC餐饮' }
  api.renameCategory(categoryRename); expect(invokes).toHaveBeenLastCalledWith('mz:renameCategory', categoryRename)
})
it('主进程五通道走真实 SQLite 领域，不依赖模型引擎；返回已提交 ID/void/summary', () => {
  const db = fixture()
  try {
    registerIpc({ getDb: () => db, get engine() { throw new Error('synthetic-engine-must-not-run') } } as never, { dataDir: 'synthetic', dbFile: ':memory:' })
    const accountId = handler('createAccount')({}, { name: ' 合成IPC卡 ', type: 'bank' })
    const categoryId = handler('createCategory')({}, { name: ' 合成IPC类 ', kind: 'income' })
    expect(Number.isSafeInteger(accountId)).toBe(true)
    expect(Number.isSafeInteger(categoryId)).toBe(true)
    expect(handler('renameAccount')({}, { accountId, expectedName: '合成IPC卡', newName: '合成IPC新卡' })).toBeUndefined()
    expect(handler('renameCategory')({}, { categoryId, expectedName: '合成IPC类', newName: '合成IPC新类' })).toBeUndefined()
    const tx = createTransaction(db, { amountCents: 978, txType: 'income', accountId, occurredAt: '2026-02-03T11:00:00+08:00' })
    recordParse(db, tx, { categoryId, confidenceScore: 1 }); confirm(db, tx)
    const before = state(db)
    const summary = handler('getAccountSummary')({}, '2026-02')
    expect(summary).toMatchObject({ month: '2026-02' })
    expect(summary.accounts.find((a: { id: number }) => a.id === accountId)).toMatchObject({ name: '合成IPC新卡', kind: 'bank', expenseCents: 0, incomeCents: 978, count: 1 })
    expect(state(db)).toEqual(before)
    expect(db.prepare('SELECT name FROM categories WHERE id=?').get(categoryId)).toEqual({ name: '合成IPC新类' })
  } finally { db.close() }
})
it('切换账本后每次调用 ctx.getDb，不能捕获旧连接', () => {
  const first = fixture()
  const second = fixture()
  let current = first
  try {
    registerIpc({ getDb: () => current } as never, { dataDir: 'synthetic', dbFile: ':memory:' })
    handler('createAccount')({}, { name: '合成首库卡', type: 'cash' })
    const before = state(first)
    current = second
    const id = handler('createAccount')({}, { name: '合成次库卡', type: 'wechat' })
    expect(second.prepare('SELECT name FROM accounts WHERE id=?').get(id)).toEqual({ name: '合成次库卡' })
    expect(state(first)).toEqual(before)
    expect(handler('getAccountSummary')({}, '2026-02').accounts.some((a: { name: string }) => a.name === '合成首库卡')).toBe(false)
  } finally { first.close(); second.close() }
})
it.each(channels)('账本未就绪时 %s 明确抛错，不返回伪空成功', name => {
  registerIpc({ getDb: () => null } as never, { dataDir: 'synthetic', dbFile: ':memory:' })
  expect(() => handler(name)({}, {})).toThrow('账本未就绪')
})
describe('主进程运行时验证', () => {
  it.each([
    ['getAccountSummary', 202602], ['getAccountSummary', '2026-13'], ['getAccountSummary', null],
    ['createAccount', null], ['createAccount', []], ['createAccount', { name: 3, type: 'bank' }], ['createAccount', { name: ' ', type: 'bank' }], ['createAccount', { name: '合成卡', type: 'credit' }],
    ['renameAccount', null], ['renameAccount', { accountId: '1', expectedName: '现金', newName: '合成名' }], ['renameAccount', { accountId: 1, expectedName: '过期', newName: '合成名' }], ['renameAccount', { accountId: 1, expectedName: '现金', newName: '微信' }],
    ['createCategory', null], ['createCategory', []], ['createCategory', { name: '合成类', kind: 'transfer' }], ['createCategory', { name: ' ', kind: 'income' }],
    ['renameCategory', null], ['renameCategory', { categoryId: 0, expectedName: '餐饮', newName: '合成名' }], ['renameCategory', { categoryId: 1, expectedName: '过期', newName: '合成名' }], ['renameCategory', { categoryId: 1, expectedName: '餐饮', newName: '咖啡' }],
  ] as [typeof channels[number], unknown][])('%s 非法输入 %# 不写库', (name, input) => {
    const db = fixture()
    try {
      registerIpc({ getDb: () => db } as never, { dataDir: 'synthetic', dbFile: ':memory:' })
      const before = state(db)
      const call = handler(name)
      expect(() => call({}, input)).toThrow()
      expect(state(db)).toEqual(before)
    } finally { db.close() }
  })
})
