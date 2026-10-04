import { expect, it } from 'vitest'
import { openSchemaDb } from './helpers'
import { seed } from '../src/main/db/seed'
import { createTransaction, requestReview, getTransaction, updateFields } from '../src/main/domain/ledger'
import { createRule } from '../src/main/domain/rules'
import { buildClassifyProposal, prepareClassify, applyClassify } from '../src/main/domain/classify'
it('建议冲突不得回退内置分类', () => {
 const db = openSchemaDb(':memory:'); seed(db)
 const id = createTransaction(db, { amountCents: 100, txType: 'expense', merchant: '星巴克' }); requestReview(db, id, { reason: '测试' })
 createRule(db, { match: 'merchant', op: 'contains', value: '星巴克' }, { set_category: '咖啡' })
 createRule(db, { match: 'merchant', op: 'equals', value: '星巴克' }, { set_category: '餐饮' })
 expect(buildClassifyProposal(db).groups[0].suggestedCategory).toBeNull()
 db.close()
})
it('null 选择不是全选，旧方案缺少交易快照不能执行', () => {
 const db=openSchemaDb(':memory:');seed(db)
 const tx=createTransaction(db,{amountCents:100,txType:'expense',merchant:'合成严格边界'});requestReview(db,tx,{reason:'test'})
 expect(()=>prepareClassify(db,{sessionId:'ui',assignments:[{groupKey:'expense::合成严格边界',categoryName:'餐饮',txIds:null as never}]})).toThrow()
 const gate=prepareClassify(db,{sessionId:'ui',assignments:[{groupKey:'expense::合成严格边界',categoryName:'餐饮'}]})
 const row=db.prepare('SELECT payload FROM pending_clarifications WHERE id=?').get(gate.gateId) as {payload:string}
 const payload=JSON.parse(row.payload);delete payload.snapshots
 db.prepare('UPDATE pending_clarifications SET payload=? WHERE id=?').run(JSON.stringify(payload),gate.gateId)
 expect(()=>applyClassify(db,gate.gateId)).toThrow(/过期|快照/)
 expect(getTransaction(db,tx)?.category_id).toBeNull()
 db.close()
})
it('内置建议不能提供不存在的分类，预览不新建分类', () => {
 const db=openSchemaDb(':memory:');seed(db)
 const tx=createTransaction(db,{amountCents:100,txType:'expense',merchant:'合成医院'});requestReview(db,tx,{reason:'test'})
 const count=(db.prepare('SELECT COUNT(*) n FROM categories').get() as {n:number}).n
 expect(buildClassifyProposal(db).groups[0].suggestedCategory).toBeNull()
 expect((db.prepare('SELECT COUNT(*) n FROM categories').get() as {n:number}).n).toBe(count)
 db.close()
})
it('严格分类/覆盖校验，方案和结果提供真实选择及剩余数', () => {
 const db = openSchemaDb(':memory:'); seed(db)
 const ids = [100, 200].map(amountCents => { const id = createTransaction(db, { amountCents, txType: 'expense', merchant: '合成严格', sourceMessageId: 'strict' }); requestReview(db, id, { reason: '测试' }); return id })
 const p = buildClassifyProposal(db, { batchId: 'strict' }); const groupKey = p.groups[0].groupKey
 expect(() => prepareClassify(db, { sessionId: 'ui', batchId: 'strict', assignments: [{ groupKey, categoryName: '红包' }] })).toThrow(/分类/)
 expect(() => prepareClassify(db, { sessionId: 'ui', assignments: [{ groupKey, categoryName: '不存在' }] })).toThrow(/分类/)
 expect(() => prepareClassify(db, { sessionId: 'ui', assignments: [{ groupKey, categoryName: '餐饮', categoryId: 99999 }] })).toThrow(/分类/)
 const gate = prepareClassify(db, { sessionId: 'ui', batchId: 'strict', assignments: [{ groupKey, categoryName: '餐饮', txIds: [ids[0]] }] })
 expect(gate.selectedCount).toBe(1); expect(gate.remainingCount).toBe(1)
 expect(p.groups[0].details.map(x => x.txId)).toEqual(ids)
 expect(() => applyClassify(db, gate.gateId, [{ groupKey: 'bogus', categoryName: '餐饮' }])).toThrow()
 expect(() => applyClassify(db, gate.gateId, [{ groupKey, categoryName: '餐饮', txIds: [ids[1]] }])).toThrow()
 expect(() => applyClassify(db, gate.gateId, [{ groupKey, categoryName: '餐饮' }, { groupKey, categoryName: '咖啡' }])).toThrow()
 const result = applyClassify(db, gate.gateId)!
 expect(result.selectedCount).toBe(1); expect(result.remainingCount).toBe(1); expect(result.appliedCount).toBe(1)
 expect(applyClassify(db, gate.gateId)).toBeNull()
 db.close()
})
it('损坏的已存方案不能静默跳过交易后关闭确认门', () => {
 const db=openSchemaDb(':memory:');seed(db)
 try {
  const tx=createTransaction(db,{amountCents:100,txType:'expense',merchant:'合成损坏方案'});requestReview(db,tx,{reason:'test'})
  const gate=prepareClassify(db,{sessionId:'ui',assignments:[{groupKey:'expense::合成损坏方案',categoryName:'餐饮'}]})
  const row=db.prepare('SELECT payload FROM pending_clarifications WHERE id=?').get(gate.gateId) as {payload:string}
  const payload=JSON.parse(row.payload);payload.groups[0].categoryName=''
  db.prepare('UPDATE pending_clarifications SET payload=? WHERE id=?').run(JSON.stringify(payload),gate.gateId)
  expect(()=>applyClassify(db,gate.gateId)).toThrow(/分类|方案/)
  expect(db.prepare('SELECT status FROM pending_clarifications WHERE id=?').get(gate.gateId)).toEqual({status:'open'})
  expect(getTransaction(db,tx)?.category_id).toBeNull()
  payload.groups[0].categoryName='餐饮';payload.groups[0].txIds=[]
  db.prepare('UPDATE pending_clarifications SET payload=? WHERE id=?').run(JSON.stringify(payload),gate.gateId)
  expect(()=>applyClassify(db,gate.gateId)).toThrow(/范围|方案/)
 } finally {db.close()}
})
it('组内排除准确计数；过期方案拒绝并全回滚', () => {
 const db = openSchemaDb(':memory:'); seed(db)
 const ids = [100, 200].map(amountCents => {
  const id = createTransaction(db, { amountCents, txType: 'expense', merchant: '合成商户', sourceMessageId: 'batch-A' }); requestReview(db, id, { reason: '合成测试' }); return id
 })
 const p = buildClassifyProposal(db, { batchId: 'batch-A' })
 const gate = prepareClassify(db, { batchId: 'batch-A', sessionId: 'ui', assignments: [{ groupKey: p.groups[0].groupKey, categoryName: '餐饮', txIds: [ids[0]] }] })
 expect(gate.plan.groups[0].count).toBe(1)
 expect(gate.plan.groups[0].totalCents).toBe(100)
 expect(applyClassify(db, gate.gateId)?.appliedCount).toBe(1)
 expect(getTransaction(db, ids[1])?.category_id).toBeNull()
 const other = prepareClassify(db, { batchId: 'batch-A', sessionId: 'ui', assignments: [{ groupKey: p.groups[0].groupKey, categoryName: '餐饮' }] })
 updateFields(db, ids[1], { merchant: '已人工修改' })
 expect(() => applyClassify(db, other.gateId)).toThrow(/过期/)
 expect(getTransaction(db, ids[1])?.category_id).toBeNull()
 db.close()
})
