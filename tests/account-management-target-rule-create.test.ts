// Same target-name boundary at the other new category constructor; synthetic production IPC.
import { it, expect, vi } from 'vitest'
import { openSchemaDb } from './helpers'
import { seed } from '../src/main/db/seed'
import { createRule, deactivateRule } from '../src/main/domain/rules'
import { createTransaction, recordParse, requestReview } from '../src/main/domain/ledger'
const { handlers } = vi.hoisted(() => ({ handlers: new Map<string, (...args: any[]) => any>() }))
vi.mock('electron', () => ({ ipcMain: { handle: (name: string, fn: (...args: any[]) => any) => handlers.set(name, fn) }, nativeTheme: {} }))
import { registerIpc } from '../src/main/ipc'

it.each(['expense', 'income'] as const)('新增%s同名分类不能让已引用另一方向的active无方向习惯扩张', kind => {
  const db = openSchemaDb(':memory:'); seed(db)
  try {
    registerIpc({ getDb: () => db } as never, { dataDir: 'synthetic', dbFile: 'synthetic' })
    const invoke = (name: string, ...args: any[]) => handlers.get(`mz:${name}`)!({}, ...args)
    const target = '合成新增目标同名', merchant = '合成新增商户'
    invoke('createCategory', { name: target, kind: kind === 'expense' ? 'income' : 'expense' })
    createRule(db, { match: 'merchant', op: 'equals', value: merchant }, { set_category: target })
    const tx = createTransaction(db, { amountCents: 1927, txType: kind, merchant, occurredAt: '2026-05-12T09:00:00+08:00' })
    recordParse(db, tx, { txType: kind, confidenceScore: 0.5 }); requestReview(db, tx, { reason: 'synthetic-review' })
    const proposal = () => invoke('getClassifyProposal').groups.find((g: { txIds: number[] }) => g.txIds.includes(tx))!
    const facts = () => ['categories', 'rules', 'transactions', 'audit_log', 'settings', 'sqlite_sequence'].map(t => db.prepare(`SELECT * FROM ${t}`).all())
    expect(proposal()).toMatchObject({ suggestedCategory: null, ruleStatus: 'invalid' })
    const before = facts()
    expect(() => invoke('createCategory', { name: target, kind })).toThrow(/旧.*习惯|歧义|方向/)
    expect(facts()).toEqual(before)
    expect(proposal()).toMatchObject({ suggestedCategory: null, ruleStatus: 'invalid' })
  } finally { db.close() }
})

it.each(['expense', 'income'] as const)('新增%s同名分类：明确反向或停用目标习惯可建，不改原规则', kind => {
  for (const active of [true, false]) {
    const db = openSchemaDb(':memory:'); seed(db)
    try {
      registerIpc({ getDb: () => db } as never, { dataDir: 'synthetic', dbFile: 'synthetic' })
      const invoke = (name: string, ...args: any[]) => handlers.get(`mz:${name}`)!({}, ...args)
      const other = kind === 'expense' ? 'income' : 'expense'
      const target = '合成新增正常对照'
      invoke('createCategory', { name: target, kind: other })
      const rule = createRule(db, { match: 'merchant', op: 'equals', value: '合成正常商户', ...(active ? { direction: other } : {}) }, { set_category: target })
      if (!active) deactivateRule(db, rule)
      const beforeRule = db.prepare('SELECT * FROM rules WHERE id=?').get(rule)
      const id = invoke('createCategory', { name: target, kind })
      expect(db.prepare('SELECT id,name,kind FROM categories WHERE id=?').get(id)).toEqual({ id, name: target, kind })
      expect(db.prepare('SELECT * FROM rules WHERE id=?').get(rule)).toEqual(beforeRule)
    } finally { db.close() }
  }
})
