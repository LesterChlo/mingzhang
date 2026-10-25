import { afterEach, beforeEach, expect, it } from 'vitest'
import type { Database } from 'better-sqlite3-multiple-ciphers'
import { openSchemaDb } from './helpers'
import { seed } from '../src/main/db/seed'
import { createPending, getPending } from '../src/main/domain/pending'
import { answerPending } from '../src/main/domain/pending-answer'
import { confirm, createImport, createTransaction, recordParse, updateFields, updateImportStatus } from '../src/main/domain/ledger'
import { renameAccount } from '../src/main/domain/accounts'
import { executeTransactionSplit, getTransactionActions, prepareTransactionSplit, setTransactionExcluded, undoTransactionSplit } from '../src/main/domain/transaction-actions'
import { buildOpenGateCards } from '../src/main/domain/gates'
import { Engine } from '../src/main/engine/engine'

let db: Database
let gateId: number

beforeEach(() => {
  db = openSchemaDb(':memory:')
  seed(db)
  gateId = createPending(db, {
    txId: null,
    sessionId: 'synthetic-split-boundary',
    field: 'split_confirm',
    question: '合成拆账确认',
    payload: { synthetic: true },
  })
})

afterEach(() => db.close())

it('split_confirm 在对话与待收尾回答中都不能关闭或确认', () => {
  const before = getPending(db, gateId)
  for (const answer of ['确认', '忽略']) {
    for (const via of ['chat', 'panel'] as const) {
      expect(() => answerPending(db, gateId, answer, { sessionId: 'synthetic', via })).toThrow()
      expect(getPending(db, gateId)).toEqual(before)
    }
  }
})

function confirmedExpense(): { txId: number; categoryId: number; incomeCategoryId: number } {
  const categoryId = (db.prepare("SELECT id FROM categories WHERE kind='expense' ORDER BY id LIMIT 1").get() as { id: number }).id
  const incomeCategoryId = (db.prepare("SELECT id FROM categories WHERE kind='income' ORDER BY id LIMIT 1").get() as { id: number }).id
  const txId = createTransaction(db, { amountCents: 10000, txType: 'expense', accountId: 2, sourceMessageId: 'synthetic-boundary' })
  recordParse(db, txId, { categoryId })
  confirm(db, txId)
  return { txId, categoryId, incomeCategoryId }
}

function tables(): Record<string, unknown[]> {
  return Object.fromEntries((db.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all() as { name: string }[])
    .map(({ name }) => [name, db.prepare(`SELECT * FROM "${name.replaceAll('"', '""')}" ORDER BY rowid`).all()]))
}

it('actions 纯读且受 query_only 约束，不为预览写账或审计', () => {
  const { txId } = confirmedExpense()
  const before = tables()
  db.pragma('query_only=ON')
  expect(getTransactionActions(db, txId)).toMatchObject({ txId, txType: 'expense', state: 'confirmed', canSplit: true, canExclude: true, excluded: false })
  db.pragma('query_only=OFF')
  expect(tables()).toEqual(before)
})

it('open split_confirm 在刷新后从同一持久待办重建拆账门卡', () => {
  const { txId, categoryId } = confirmedExpense()
  const actions = getTransactionActions(db, txId)!
  const plan = prepareTransactionSplit(db, {
    txId, expectedVersion: actions.version,
    items: [{ amountCents: 6000, categoryId }, { amountCents: 4000, categoryId }],
  }, { via: 'panel', sessionId: 'synthetic' })
  expect(buildOpenGateCards(db)).toContainEqual({ gateId: plan.gateId, field: 'split_confirm', card: { kind: 'split-gate', plan } })
})

it('同来源相同方案重试复用原门，不改gate或序列；不同方案不覆盖旧门', () => {
  const { txId, categoryId } = confirmedExpense()
  const actions = getTransactionActions(db, txId)!
  const items = [{ amountCents: 6000, categoryId }, { amountCents: 4000, categoryId }]
  const plan = prepareTransactionSplit(db, { txId, expectedVersion: actions.version, items }, { via: 'panel', sessionId: 'synthetic' })
  const beforeRetry = tables()
  expect(prepareTransactionSplit(db, { txId, expectedVersion: actions.version, items }, { via: 'chat', sessionId: 'synthetic-chat' })).toEqual(plan)
  expect(tables()).toEqual(beforeRetry)
  expect(() => prepareTransactionSplit(db, {
    txId, expectedVersion: actions.version,
    items: [{ amountCents: 7000, categoryId }, { amountCents: 3000, categoryId }],
  }, { via: 'panel', sessionId: 'synthetic' })).toThrow(/另一拆账方案/)
  expect(tables()).toEqual(beforeRetry)
})

it('confirmGate 只接受显式版本并广播真实拆账完成卡', async () => {
  const { txId, categoryId } = confirmedExpense()
  const actions = getTransactionActions(db, txId)!
  const plan = prepareTransactionSplit(db, {
    txId, expectedVersion: actions.version,
    items: [{ amountCents: 6500, categoryId }, { amountCents: 3500, categoryId }],
  }, { via: 'panel', sessionId: 'synthetic' })
  const events: any[] = []
  const engine = new Engine(db, {} as never, {} as never, {} as never, (event) => events.push(event))
  const missingVersion = await engine.confirmGate(plan.gateId)
  expect(missingVersion.status).toBe('error')
  expect(getPending(db, plan.gateId)?.status).toBe('open')
  const result = await engine.confirmGate(plan.gateId, plan.version)
  expect(result.status).toBe('ok')
  expect(events).toContainEqual(expect.objectContaining({
    type: 'gate-executed',
    payload: expect.objectContaining({ kind: 'split', gateId: plan.gateId, card: expect.objectContaining({ kind: 'split', originalId: txId, cards: expect.arrayContaining([expect.objectContaining({ kind: 'transaction' })]) }) }),
  }))
})

it('拆账拒绝零金额、错误方向分类与51项方案，且每次均零写', () => {
  const { txId, categoryId, incomeCategoryId } = confirmedExpense()
  const version = getTransactionActions(db, txId)!.version
  const before = tables()
  const badPlans = [
    [{ amountCents: 0, categoryId }, { amountCents: 10000, categoryId }],
    [{ amountCents: 5000, categoryId: incomeCategoryId }, { amountCents: 5000, categoryId }],
    Array.from({ length: 51 }, (_, index) => ({ amountCents: index === 0 ? 5000 : index === 1 ? 5000 : 1, categoryId })),
  ]
  for (const items of badPlans) {
    expect(() => prepareTransactionSplit(db, { txId, expectedVersion: version, items }, { via: 'panel', sessionId: 'synthetic' })).toThrow()
    expect(tables()).toEqual(before)
  }
})

it('准备后引用分类或附件来源变化会使预览失效，执行零写', () => {
  for (const change of ['category', 'attachment'] as const) {
    const { txId, categoryId } = confirmedExpense()
    const actions = getTransactionActions(db, txId)!
    const plan = prepareTransactionSplit(db, {
      txId, expectedVersion: actions.version,
      items: [{ amountCents: 5000, categoryId }, { amountCents: 5000, categoryId }],
    }, { via: 'panel', sessionId: 'synthetic' })
    if (change === 'category') db.prepare('UPDATE categories SET name=? WHERE id=?').run('合成改名分类', categoryId)
    else db.prepare("INSERT INTO settings(key,value,updated_at) VALUES(?,?, 'synthetic')").run(`tx.attachments:${txId}`, JSON.stringify({ version: 1, items: [] }))
    const beforeExecute = tables()
    expect(() => executeTransactionSplit(db, { gateId: plan.gateId, expectedVersion: plan.version }, { via: 'panel' })).toThrow()
    expect(tables()).toEqual(beforeExecute)
  }
})

it('账户引用在同秒改名后还原原行值仍使预览失效', () => {
  const { txId, categoryId } = confirmedExpense()
  const actions = getTransactionActions(db, txId)!
  const plan = prepareTransactionSplit(db, {
    txId, expectedVersion: actions.version,
    items: [{ amountCents: 5000, categoryId }, { amountCents: 5000, categoryId }],
  }, { via: 'panel', sessionId: 'synthetic' })
  const account = db.prepare('SELECT * FROM accounts WHERE id=2').get() as Record<string, unknown>
  renameAccount(db, String(account.name), '合成账户')
  renameAccount(db, '合成账户', String(account.name))
  db.prepare('UPDATE accounts SET updated_at=? WHERE id=?').run(account.updated_at, account.id)
  const beforeExecute = tables()
  expect(() => executeTransactionSplit(db, { gateId: plan.gateId, expectedVersion: plan.version }, { via: 'panel' })).toThrow()
  expect(tables()).toEqual(beforeExecute)
})

it('legacy import附件来源在改回原值后仍因审计锚点失效', () => {
  const { txId, categoryId } = confirmedExpense()
  const importId = createImport(db, { sourceType: 'text', status: 'parsed', sourceRef: 'synthetic-source', sourceMessageId: 'synthetic-boundary' })
  const originalImport = db.prepare('SELECT * FROM imports WHERE id=?').get(importId) as Record<string, unknown>
  const actions = getTransactionActions(db, txId)!
  const plan = prepareTransactionSplit(db, {
    txId, expectedVersion: actions.version,
    items: [{ amountCents: 5000, categoryId }, { amountCents: 5000, categoryId }],
  }, { via: 'panel', sessionId: 'synthetic' })
  updateImportStatus(db, importId, 'failed')
  updateImportStatus(db, importId, 'parsed')
  db.prepare('UPDATE imports SET updated_at=? WHERE id=?').run(originalImport.updated_at, importId)
  const beforeExecute = tables()
  expect(() => executeTransactionSplit(db, { gateId: plan.gateId, expectedVersion: plan.version }, { via: 'panel' })).toThrow()
  expect(tables()).toEqual(beforeExecute)
})

it('transfer本已不计收支但没有虚假排除动作', () => {
  const txId = createTransaction(db, { amountCents: 1200, txType: 'transfer', accountId: 2, toAccountId: 3, sourceMessageId: 'synthetic-transfer' })
  confirm(db, txId)
  const actions = getTransactionActions(db, txId)!
  const before = tables()
  expect(actions).toMatchObject({ txType: 'transfer', canSplit: false, canExclude: false, excluded: false })
  expect(() => setTransactionExcluded(db, { txId, expectedVersion: actions.version, excluded: false }, { via: 'panel' })).toThrow()
  expect(tables()).toEqual(before)
})

it('legacy adjustment 没有来源凭据时不猜原方向，也不提供不计收支动作', () => {
  const txId = createTransaction(db, { amountCents: 700, txType: 'adjustment', accountId: 2, sourceMessageId: 'synthetic-legacy-adjustment' })
  confirm(db, txId)
  const before = tables()
  expect(getTransactionActions(db, txId)).toMatchObject({ txType: 'adjustment', excluded: false, canSplit: false, canExclude: false })
  expect(() => setTransactionExcluded(db, { txId, expectedVersion: getTransactionActions(db, txId)!.version, excluded: true }, { via: 'panel' })).toThrow()
  expect(() => setTransactionExcluded(db, { txId, expectedVersion: getTransactionActions(db, txId)!.version, excluded: false }, { via: 'panel' })).toThrow()
  expect(tables()).toEqual(before)
})

it('不计收支后人工作改使动作DTO明确不可恢复且保留后续版本', () => {
  const { txId } = confirmedExpense()
  const initial = getTransactionActions(db, txId)!
  const marked = setTransactionExcluded(db, { txId, expectedVersion: initial.version, excluded: true }, { via: 'panel' })
  updateFields(db, txId, { merchant: '合成后改备注' })
  const stale = getTransactionActions(db, txId)!
  expect(stale).toMatchObject({ excluded: true, canExclude: false, reason: expect.stringContaining('变化') })
  const before = tables()
  expect(() => setTransactionExcluded(db, { txId, expectedVersion: stale.version, excluded: false }, { via: 'panel' })).toThrow()
  expect(tables()).toEqual(before)
  expect(marked.version).not.toBe(stale.version)
})

it('子项附件来源变化后撤销组不可用，绝不覆盖新附件事实', () => {
  const { txId, categoryId } = confirmedExpense()
  const actions = getTransactionActions(db, txId)!
  const plan = prepareTransactionSplit(db, {
    txId, expectedVersion: actions.version,
    items: [{ amountCents: 5000, categoryId }, { amountCents: 5000, categoryId }],
  }, { via: 'panel', sessionId: 'synthetic' })
  const split = executeTransactionSplit(db, { gateId: plan.gateId, expectedVersion: plan.version }, { via: 'panel' })
  db.prepare("INSERT INTO settings(key,value,updated_at) VALUES(?,?, 'synthetic')").run(`tx.attachments:${split.childIds[0]}`, JSON.stringify({ version: 2, items: ['later-change'] }))
  const child = getTransactionActions(db, split.childIds[0])!
  expect(child.undoSplit).toMatchObject({ canUndo: false, reason: expect.stringContaining('变化') })
  const before = tables()
  expect(() => undoTransactionSplit(db, { gateId: split.gateId, expectedVersion: child.undoSplit!.version }, { via: 'panel' })).toThrow()
  expect(tables()).toEqual(before)
})
