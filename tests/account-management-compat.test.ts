import { expect, it, vi } from 'vitest'
import type { MingZhangApi } from '../src/shared/types'
import { createCategory, renameCategory } from '../src/main/domain/categories'
import { createAccount, renameAccountById } from '../src/main/domain/accounts'
import { createRule } from '../src/main/domain/rules'
import { listCategoryRules, deactivateCategoryRule } from '../src/main/domain/category-rules'
import { openSchemaDb } from './helpers'
import { seed } from '../src/main/db/seed'

const { handlers, exposed, invoke } = vi.hoisted(() => ({
  handlers: new Map<string, (...args: any[]) => any>(),
  exposed: vi.fn(),
  invoke: vi.fn(),
}))
vi.mock('electron', () => ({
  ipcMain: { handle: (name: string, fn: (...args: any[]) => any) => handlers.set(name, fn) },
  nativeTheme: {},
  ipcRenderer: { invoke, on: vi.fn(), removeListener: vi.fn() },
  contextBridge: { exposeInMainWorld: exposed },
}))
import { registerIpc } from '../src/main/ipc'

function fixture() { const db = openSchemaDb(':memory:'); seed(db); return db }
function state(db: ReturnType<typeof fixture>) {
  return ['accounts', 'categories', 'rules', 'transactions', 'audit_log', 'settings', 'sqlite_sequence'].map(table => db.prepare(`SELECT * FROM ${table}`).all())
}

it('分类改名使既有习惯编辑版本失效，同方向停用接口仍可用', () => {
  const db = fixture()
  try {
    const id = createCategory(db, { name: '合成版本类', kind: 'income' })
    const ruleId = createRule(db, { match: 'merchant', op: 'equals', value: '合成版本店', direction: 'income' }, { set_category: '合成版本类' })
    const old = listCategoryRules(db).find(r => r.id === ruleId)!
    renameCategory(db, { categoryId: id, expectedName: '合成版本类', newName: '合成版本新类' })
    const current = listCategoryRules(db).find(r => r.id === ruleId)!
    expect(current).toMatchObject({ id: ruleId, categoryId: id, categoryName: '合成版本新类', direction: 'income', valid: true })
    expect(current.version).not.toBe(old.version)
    const before = state(db)
    expect(() => deactivateCategoryRule(db, { ruleId, expectedVersion: old.version })).toThrow(/版本/)
    expect(state(db)).toEqual(before)
    expect(deactivateCategoryRule(db, { ruleId, expectedVersion: current.version }).active).toBe(false)
  } finally { db.close() }
})
it('100字符与单字符名称可创建；账户同名rename为零写入', () => {
  const db = fixture()
  try {
    for (const name of ['甲', '字'.repeat(100), '😀'.repeat(100)]) {
      const id = createAccount(db, { name, type: 'cash' })
      expect(db.prepare('SELECT name FROM accounts WHERE id=?').get(id)).toEqual({ name })
      const before = state(db)
      renameAccountById(db, { accountId: id, expectedName: name, newName: ` ${name} ` })
      expect(state(db)).toEqual(before)
    }
    for (const name of ['乙', '类'.repeat(100), '😀'.repeat(100)]) {
      const id = createCategory(db, { name, kind: 'expense' })
      expect(db.prepare('SELECT name FROM categories WHERE id=?').get(id)).toEqual({ name })
    }
  } finally { db.close() }
})
it('嵌套外层事务失败时新账户/分类、改名/规则及全部审计仍一起回滚', () => {
  const db = fixture()
  try {
    createRule(db, { match: 'merchant', op: 'equals', value: '合成嵌套店', direction: 'expense' }, { set_category: '餐饮' })
    const before = state(db)
    expect(() => db.transaction(() => {
      createAccount(db, { name: '合成嵌套卡', type: 'bank' })
      createCategory(db, { name: '合成嵌套类', kind: 'income' })
      renameAccountById(db, { accountId: 1, expectedName: '现金', newName: '合成嵌套现金' })
      renameCategory(db, { categoryId: 1, expectedName: '餐饮', newName: '合成嵌套餐饮' })
      throw new Error('synthetic-outer-rollback')
    })()).toThrow('synthetic-outer-rollback')
    expect(state(db)).toEqual(before)
  } finally { db.close() }
})
it('连接 preload invoke → 主进程handler → 真实SQLite，成功返回后回读；失败promise保全库', async () => {
  const db = fixture()
  try {
    registerIpc({ getDb: () => db } as never, { dataDir: 'synthetic', dbFile: ':memory:' })
    invoke.mockImplementation(async (channel: string, ...args: unknown[]) => {
      const fn = handlers.get(channel)
      if (!fn) throw new Error(`unregistered ${channel}`)
      return fn({}, ...args)
    })
    await import('../src/preload/index')
    const api = exposed.mock.calls[0][1] as MingZhangApi
    const accountId = await api.createAccount({ name: '合成往返卡', type: 'alipay' })
    const categoryId = await api.createCategory({ name: '合成往返类', kind: 'expense' })
    await api.renameAccount({ accountId, expectedName: '合成往返卡', newName: '合成往返新卡' })
    await api.renameCategory({ categoryId, expectedName: '合成往返类', newName: '合成往返新类' })
    expect((await api.getAccountSummary('2026-02')).accounts.find(a => a.id === accountId)).toMatchObject({ name: '合成往返新卡', expenseCents: 0, incomeCents: 0, count: 0 })
    expect(db.prepare('SELECT name FROM categories WHERE id=?').get(categoryId)).toEqual({ name: '合成往返新类' })
    const before = state(db)
    await expect(api.renameAccount({ accountId, expectedName: '合成往返卡', newName: '合成失败新名' })).rejects.toThrow(/过期|变更/)
    expect(state(db)).toEqual(before)
  } finally { db.close() }
})
