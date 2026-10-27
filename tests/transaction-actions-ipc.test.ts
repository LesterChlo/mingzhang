import { expect, it, vi } from 'vitest'
const { handlers, invokes, expose } = vi.hoisted(() => ({
  handlers: new Map<string, (...args: any[]) => any>(),
  invokes: vi.fn(),
  expose: vi.fn(),
}))
vi.mock('electron', () => ({
  ipcMain: { handle: (name: string, fn: (...args: any[]) => any) => handlers.set(name, fn) },
  nativeTheme: {},
  ipcRenderer: { invoke: invokes, on: vi.fn(), removeListener: vi.fn() },
  contextBridge: { exposeInMainWorld: expose },
}))
import { registerIpc } from '../src/main/ipc'
import { openSchemaDb } from './helpers'
import { seed } from '../src/main/db/seed'
import { confirm, createTransaction, recordParse } from '../src/main/domain/ledger'
import { executeTransactionSplit } from '../src/main/domain/transaction-actions'

it('preload 与主进程精确注册并透传拆账版本，写入由主进程固定走panel', async () => {
  const { contextBridge } = await import('electron')
  await import('../src/preload/index')
  const api = vi.mocked(contextBridge.exposeInMainWorld).mock.calls[0][1] as any
  const input = { txId: 41, expectedVersion: 'opaque-version', items: [] }
  api.getTransactionActions(41)
  expect(invokes).toHaveBeenLastCalledWith('mz:getTransactionActions', 41)
  api.getTransactionSplitPlan(9)
  expect(invokes).toHaveBeenLastCalledWith('mz:getTransactionSplitPlan', 9)
  api.prepareTransactionSplit(input)
  expect(invokes).toHaveBeenLastCalledWith('mz:prepareTransactionSplit', input)
  api.undoTransactionSplit({ gateId: 9, expectedVersion: 'undo-token' })
  expect(invokes).toHaveBeenLastCalledWith('mz:undoTransactionSplit', { gateId: 9, expectedVersion: 'undo-token' })
  api.setTransactionExcluded({ txId: 41, expectedVersion: 'v', excluded: true })
  expect(invokes).toHaveBeenLastCalledWith('mz:setTransactionExcluded', { txId: 41, expectedVersion: 'v', excluded: true })
  api.confirmGate(9, 'split-plan-version')
  expect(invokes).toHaveBeenLastCalledWith('mz:confirmGate', 9, 'split-plan-version')

  const db = openSchemaDb(':memory:')
  seed(db)
  const categoryId = (db.prepare("SELECT id FROM categories WHERE name='餐饮' AND kind='expense'").get() as { id: number }).id
  const txId = createTransaction(db, { amountCents: 10000, txType: 'expense', accountId: 2, sourceMessageId: 'synthetic-ipc' })
  recordParse(db, txId, { categoryId })
  confirm(db, txId)
  const engine = { confirmGate: vi.fn(async (gateId: number, version?: string) => {
    const split = executeTransactionSplit(db, { gateId, expectedVersion: version ?? '' }, { via: 'panel' })
    return { status: 'ok', message: 'synthetic confirmed', split }
  }) }
  try {
    registerIpc({ getDb: () => db, engines: { get: () => engine } } as never, { dataDir: 'synthetic', dbFile: ':memory:' })
    for (const name of ['getTransactionActions', 'getTransactionSplitPlan', 'prepareTransactionSplit', 'undoTransactionSplit', 'setTransactionExcluded']) {
      expect(handlers.has(`mz:${name}`)).toBe(true)
    }
    const actions = handlers.get('mz:getTransactionActions')!({}, txId)
    const plan = handlers.get('mz:prepareTransactionSplit')!({}, {
      txId,
      expectedVersion: actions.version,
      items: [{ amountCents: 6000, categoryId }, { amountCents: 4000, categoryId }],
    })
    expect(plan.gateId).toBeGreaterThan(0)
    expect(handlers.get('mz:getTransactionSplitPlan')!({}, plan.gateId)).toEqual(plan)
    expect(db.prepare("SELECT field,status FROM pending_clarifications WHERE id=?").get(plan.gateId)).toEqual({ field: 'split_confirm', status: 'open' })
    const execution = await handlers.get('mz:confirmGate')!({}, plan.gateId, plan.version)
    expect(engine.confirmGate).toHaveBeenCalledWith(plan.gateId, plan.version)
    const childId = execution.split.childIds[0]
    const childActions = handlers.get('mz:getTransactionActions')!({}, childId)
    expect(childActions.undoSplit.canUndo).toBe(true)
    handlers.get('mz:undoTransactionSplit')!({}, { gateId: plan.gateId, expectedVersion: childActions.undoSplit.version })
    expect(db.prepare('SELECT state FROM transactions WHERE id=?').get(txId)).toEqual({ state: 'confirmed' })

    const secondTxId = createTransaction(db, { amountCents: 3000, txType: 'income', accountId: 2, sourceMessageId: 'synthetic-ipc-exclude' })
    const incomeCategory = (db.prepare("SELECT id FROM categories WHERE kind='income' ORDER BY id LIMIT 1").get() as { id: number }).id
    recordParse(db, secondTxId, { categoryId: incomeCategory })
    confirm(db, secondTxId)
    const beforeExclude = handlers.get('mz:getTransactionActions')!({}, secondTxId)
    const excluded = handlers.get('mz:setTransactionExcluded')!({}, { txId: secondTxId, expectedVersion: beforeExclude.version, excluded: true })
    expect(excluded).toMatchObject({ txId: secondTxId, excluded: true })
    const restored = handlers.get('mz:setTransactionExcluded')!({}, { txId: secondTxId, expectedVersion: excluded.version, excluded: false })
    expect(restored).toMatchObject({ txId: secondTxId, excluded: false, canExclude: true })
  } finally {
    db.close()
  }
})
