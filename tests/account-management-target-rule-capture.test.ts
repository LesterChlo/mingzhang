import { expect, it, vi } from 'vitest'
import { openSchemaDb } from './helpers'
import { seed } from '../src/main/db/seed'
import { createRule, deactivateRule } from '../src/main/domain/rules'
import { createTransaction, recordParse, requestReview } from '../src/main/domain/ledger'

const { handlers } = vi.hoisted(() => ({ handlers: new Map<string, (...args: any[]) => any>() }))
vi.mock('electron', () => ({ ipcMain: { handle: (name: string, fn: (...args: any[]) => any) => handlers.set(name, fn) }, nativeTheme: {} }))
import { registerIpc } from '../src/main/ipc'

function setup(kind: 'expense' | 'income', direction?: 'expense' | 'income', active = true) {
  const db = openSchemaDb(':memory:'); seed(db)
  registerIpc({ getDb: () => db } as never, { dataDir: 'synthetic', dbFile: 'synthetic' })
  const other = kind === 'expense' ? 'income' : 'expense'
  const invoke = (name: string, ...args: any[]) => handlers.get(`mz:${name}`)!({}, ...args)
  const original = '合成原有方向类', target = '合成已引用目标类', merchant = '合成捕获商户'
  const id = invoke('createCategory', { name: original, kind })
  const opposite = invoke('createCategory', { name: target, kind: other })
  const rule = createRule(db, { match: 'merchant', op: 'equals', value: merchant, ...(direction ? { direction } : {}) }, { set_category: target })
  if (!active) deactivateRule(db, rule)
  const tx = createTransaction(db, { amountCents: 1703, txType: kind, merchant, occurredAt: '2026-05-11T09:00:00+08:00' })
  recordParse(db, tx, { txType: kind, confidenceScore: 0.5 }); requestReview(db, tx, { reason: 'synthetic-review' })
  const proposal = () => invoke('getClassifyProposal').groups.find((g: { txIds: number[] }) => g.txIds.includes(tx))!
  const facts = () => ['categories', 'rules', 'transactions', 'audit_log', 'settings', 'sqlite_sequence'].map(t => db.prepare(`SELECT * FROM ${t}`).all())
  return { db, invoke, id, opposite, rule, original, target, tx, proposal, facts }
}

it.each(['expense', 'income'] as const)('改名%s不得让目标名已有的active无方向习惯静默捕获新的收支方向', kind => {
  const f = setup(kind)
  try {
    expect(f.proposal()).toMatchObject({ suggestedCategory: null, ruleStatus: 'invalid' })
    const before = f.facts()
    expect(() => f.invoke('renameCategory', { categoryId: f.id, expectedName: f.original, newName: f.target })).toThrow(/旧.*习惯|歧义|方向/)
    expect(f.facts()).toEqual(before)
    expect(f.proposal()).toMatchObject({ suggestedCategory: null, ruleStatus: 'invalid' })
  } finally { f.db.close() }
})

it.each(['expense', 'income'] as const)('方向明确的反向习惯允许%s改名且不扩大覆盖，不改历史金额/规则', kind => {
  const f = setup(kind, kind === 'expense' ? 'income' : 'expense')
  try {
    expect(f.proposal()).toMatchObject({ suggestedCategory: null, ruleStatus: 'none' })
    const beforeRule = f.db.prepare('SELECT * FROM rules WHERE id=?').get(f.rule)
    const beforeTx = f.db.prepare('SELECT * FROM transactions WHERE id=?').get(f.tx)
    f.invoke('renameCategory', { categoryId: f.id, expectedName: f.original, newName: f.target })
    expect(f.proposal()).toMatchObject({ suggestedCategory: null, ruleStatus: 'none' })
    expect(f.db.prepare('SELECT * FROM rules WHERE id=?').get(f.rule)).toEqual(beforeRule)
    expect(f.db.prepare('SELECT * FROM transactions WHERE id=?').get(f.tx)).toEqual(beforeTx)
    expect(f.db.prepare('SELECT id,name,kind FROM categories WHERE id=?').get(f.id)).toEqual({ id: f.id, name: f.target, kind })
  } finally { f.db.close() }
})

it.each(['expense', 'income'] as const)('停用无方向目标名习惯允许%s改名；停用规则和历史原样保全', kind => {
  const f = setup(kind, undefined, false)
  try {
    const beforeRule = f.db.prepare('SELECT * FROM rules WHERE id=?').get(f.rule)
    f.invoke('renameCategory', { categoryId: f.id, expectedName: f.original, newName: f.target })
    expect(f.proposal()).toMatchObject({ suggestedCategory: null, ruleStatus: 'none' })
    expect(f.db.prepare('SELECT * FROM rules WHERE id=?').get(f.rule)).toEqual(beforeRule)
  } finally { f.db.close() }
})
