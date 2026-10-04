import { expect, it } from 'vitest'
import { mkdtempSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { openSchemaDb, openPlainDb } from './helpers'
import { seed } from '../src/main/db/seed'
import { createTransaction, requestReview, updateFields } from '../src/main/domain/ledger'
import { closePending } from '../src/main/domain/pending'
import { saveCategoryRule, listCategoryRules, deactivateCategoryRule } from '../src/main/domain/category-rules'
import { prepareClassify, applyClassify, undoClassify, getClassifyResults } from '../src/main/domain/classify'

it('重启后按批次恢复分次执行来源和真实候选，查询不写任何表', () => {
  const file = join(mkdtempSync(join(tmpdir(), 'mz-synthetic-recovery-')), 'ledger.db')
  let db = openSchemaDb(file); seed(db)
  const gates: number[] = []
  for (const merchant of ['合成恢复甲', '合成恢复乙']) {
    const id = createTransaction(db, { amountCents: 123, txType: 'expense', merchant, sourceMessageId: 'recovery-batch' })
    requestReview(db, id, { reason: 'synthetic' })
    const gate = prepareClassify(db, { sessionId: 'synthetic', batchId: 'recovery-batch', assignments: [{ groupKey: `expense::${merchant}`, categoryName: '餐饮' }] })
    gates.push(gate.gateId); applyClassify(db, gate.gateId)
  }
  db.close(); db = openPlainDb(file)
  try {
    const before = db.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all() as {name:string}[]
    const dump = () => before.map(({name}) => [name, db.prepare(`SELECT * FROM "${name}" ORDER BY rowid`).all()])
    const state = dump()
    db.pragma('query_only = ON')
    const results = getClassifyResults(db, 'recovery-batch')
    expect(results.map(r => r.gateId)).toEqual([...gates].reverse())
    expect(results.every(r => r.classifyId.startsWith('cls-') && r.appliedCount === 1 && r.undo.status === 'available' && r.undo.revertibleCount === 1)).toBe(true)
    expect(results.flatMap(r => r.candidates).map(c => c.merchant).sort()).toEqual(['合成恢复乙', '合成恢复甲'].sort())
    expect(results[0].candidates[0]).toMatchObject({groupKey:'expense::合成恢复乙',txType:'expense',categoryName:'餐饮',count:1})
    expect(getClassifyResults(db, 'missing')).toEqual([])
    expect(getClassifyResults(db, 'recovery-batch')).toEqual(results)
    expect(dump()).toEqual(state)
  } finally { db.close() }
})

function fixture(merchant: string | null = '合成生命周期', count = 2) {
  const db = openSchemaDb(':memory:'); seed(db)
  const ids = Array.from({length:count}, () => {
    const id = createTransaction(db, {amountCents:100,txType:'expense',merchant,sourceMessageId:'lifecycle'})
    requestReview(db,id,{reason:'synthetic'}); return id
  })
  const groupKey = `expense::${merchant ?? '__unlabeled__'}`
  const gate = prepareClassify(db,{sessionId:'synthetic',batchId:'lifecycle',assignments:[{groupKey,categoryName:'餐饮'}]})
  return {db,ids,groupKey,gate}
}

it('执行覆盖分类以确认审计为准，保存后不再重复提示，停用后可显式重新保存', () => {
  const {db,gate,groupKey} = fixture()
  try {
    applyClassify(db,gate.gateId,[{groupKey,categoryName:'咖啡'}])
    const candidate = getClassifyResults(db,'lifecycle')[0].candidates[0]
    expect(candidate.categoryName).toBe('咖啡')
    const saved = saveCategoryRule(db,{requestId:'recovery-save',gateId:gate.gateId,groupKey,categoryId:candidate.categoryId,expectedRules:[],replaceConflicts:false}).rule!
    expect(getClassifyResults(db,'lifecycle')[0].candidates).toEqual([])
    deactivateCategoryRule(db,{ruleId:saved.id,expectedVersion:saved.version})
    expect(getClassifyResults(db,'lifecycle')[0].candidates).toHaveLength(1)
  } finally {db.close()}
})
it('撤销状态与后续修改跳过数真实可恢复，ABA不恢复旧规则来源', () => {
  const {db,gate,ids} = fixture()
  try {
    applyClassify(db,gate.gateId)
    updateFields(db,ids[0],{merchant:'合成改动'})
    updateFields(db,ids[0],{merchant:'合成生命周期'})
    expect(getClassifyResults(db,'lifecycle')[0]).toMatchObject({candidates:[],undo:{status:'partial',revertibleCount:1,revertedCount:0,skipped:[{txId:ids[0]}]}})
    expect(undoClassify(db,gate.classifyId).revertedCount).toBe(1)
    expect(getClassifyResults(db,'lifecycle')[0]).toMatchObject({candidates:[],undo:{status:'unavailable',revertibleCount:0,revertedCount:1}})
    expect(listCategoryRules(db)).toEqual([])
  } finally {db.close()}
})
it('全部撤销后不恢复候选且不会再启用撤销按钮', () => {
  const {db,gate} = fixture()
  try {
    applyClassify(db,gate.gateId); undoClassify(db,gate.classifyId)
    expect(getClassifyResults(db,'lifecycle')[0]).toMatchObject({appliedCount:2,candidates:[],undo:{status:'reverted',revertibleCount:0,revertedCount:2}})
  } finally {db.close()}
})
it('未执行、仅关闭、损坏门与其他批次无审计来源不伪造结果', () => {
  const {db,gate} = fixture()
  try {
    expect(getClassifyResults(db,'lifecycle')).toEqual([])
    closePending(db,gate.gateId,'resolved')
    expect(getClassifyResults(db,'lifecycle')).toEqual([])
    db.prepare('UPDATE pending_clarifications SET payload=? WHERE id=?').run('{broken',gate.gateId)
    expect(getClassifyResults(db)).toEqual([])
    expect(()=>getClassifyResults(db,'' )).toThrow(/批次/)
    expect(()=>getClassifyResults(db,42 as never)).toThrow(/批次/)
  } finally {db.close()}
})
it('无商户真实执行可恢复撤销但不能编造保存候选', () => {
  const {db,gate} = fixture(null,1)
  try {
    applyClassify(db,gate.gateId)
    expect(getClassifyResults(db,'lifecycle')[0]).toMatchObject({appliedCount:1,candidates:[],undo:{status:'available',revertibleCount:1}})
  } finally {db.close()}
})
