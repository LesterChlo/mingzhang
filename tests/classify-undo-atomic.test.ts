import { describe,it,expect } from 'vitest'
import { openSchemaDb } from './helpers'
import { seed } from '../src/main/db/seed'
import { createTransaction,requestReview,updateFields } from '../src/main/domain/ledger'
import { createPending } from '../src/main/domain/pending'
import { buildClassifyProposal,prepareClassify,applyClassify,undoClassify } from '../src/main/domain/classify'
import { getClassifyResults } from '../src/main/domain/classify'
import { listCategoryRules, saveCategoryRule } from '../src/main/domain/category-rules'

function prepared() {
 const db=openSchemaDb(':memory:'); seed(db)
 const ids=[1200,2300].map((amountCents,i)=>{
  const id=createTransaction(db,{amountCents,txType:'expense',merchant:`合成商户${i}`,changedBy:'user'})
  requestReview(db,id,{reason:'合成待分类'})
  createPending(db,{txId:id,sessionId:'synthetic',field:'confirm_record',question:'待分类',payload:{txId:id}})
  return id
 })
 const proposal=buildClassifyProposal(db)
 const plan=prepareClassify(db,{sessionId:'synthetic',expectedProposalVersion:proposal.proposalVersion,assignments:proposal.groups.map(g=>({groupKey:g.groupKey,categoryName:'餐饮'}))})
 const result=applyClassify(db,plan.gateId)!
 return {db,ids,result}
}
function state(db:ReturnType<typeof openSchemaDb>) {
 return {
  tx:db.prepare('SELECT * FROM transactions ORDER BY id').all(),
  audits:db.prepare('SELECT * FROM audit_log ORDER BY id').all(),
  pending:db.prepare('SELECT * FROM pending_clarifications ORDER BY id').all(),
  rules:db.prepare('SELECT * FROM rules ORDER BY id').all(),
 }
}

describe('批量分类撤销的整批事务',()=>{
 it('第二笔 UPDATE 失败时第一笔、审计与待办全回滚',()=>{
  const f=prepared()
  try {
   f.db.exec(`CREATE TRIGGER synthetic_abort_tx BEFORE UPDATE ON transactions WHEN NEW.id=${f.ids[1]} AND NEW.state='needs_review' BEGIN SELECT RAISE(ABORT,'synthetic second write failed'); END`)
   const before=state(f.db)
   expect(()=>undoClassify(f.db,f.result.classifyId)).toThrow(/synthetic/)
   expect(state(f.db)).toEqual(before)
  } finally {f.db.close()}
 })
 it('第二笔审计写入失败时账目和第一笔审计也回滚',()=>{
  const f=prepared()
  try {
   f.db.exec(`CREATE TRIGGER synthetic_abort_audit BEFORE INSERT ON audit_log WHEN NEW.entity_id=${f.ids[1]} AND NEW.reasoning='撤销批量归类' BEGIN SELECT RAISE(ABORT,'synthetic audit failed'); END`)
   const before=state(f.db)
   expect(()=>undoClassify(f.db,f.result.classifyId)).toThrow(/synthetic/)
   expect(state(f.db)).toEqual(before)
  } finally {f.db.close()}
 })
 it('待办重建失败时两笔及其审计均保持撤销前',()=>{
  const f=prepared()
  try {
   f.db.exec(`CREATE TRIGGER synthetic_abort_pending BEFORE INSERT ON pending_clarifications WHEN NEW.tx_id=${f.ids[1]} BEGIN SELECT RAISE(ABORT,'synthetic pending failed'); END`)
   const before=state(f.db)
   expect(()=>undoClassify(f.db,f.result.classifyId)).toThrow(/synthetic/)
   expect(state(f.db)).toEqual(before)
  } finally {f.db.close()}
 })
 it('后续人工修改保留且其余撤销，重复调用幂等',()=>{
  const f=prepared()
  try {
   updateFields(f.db,f.ids[1],{merchant:'合成已改'},{changedBy:'user',reasoning:'合成后续改动'})
   const changed=f.db.prepare('SELECT * FROM transactions WHERE id=?').get(f.ids[1])
   const result=undoClassify(f.db,f.result.classifyId)
   expect(result.revertedCount).toBe(1)
   expect(result.skipped).toContainEqual({txId:f.ids[1],reason:'这之后被改过，未撤销'})
   expect(f.db.prepare('SELECT * FROM transactions WHERE id=?').get(f.ids[1])).toEqual(changed)
   expect(undoClassify(f.db,f.result.classifyId).revertedCount).toBe(0)
  } finally {f.db.close()}
 })
})

/** 比较所有业务表与 sqlite_sequence，防回滚后审计/待办高水位残留。 */
function wholeState(db: ReturnType<typeof openSchemaDb>) {
 const tables=db.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all() as {name:string}[]
 return tables.map(({name})=>[name,db.prepare(`SELECT * FROM "${name}" ORDER BY rowid`).all()])
}

function saveSyntheticRule(f: ReturnType<typeof prepared>) {
 const candidate=getClassifyResults(f.db)[0].candidates.find(c=>c.txIds.includes(f.ids[0]))!
 const saved=saveCategoryRule(f.db,{
  requestId:'synthetic-undo-rule',gateId:f.result.gateId,groupKey:candidate.groupKey,
  categoryId:candidate.categoryId,expectedRules:[],replaceConflicts:false,
 })
 expect(saved.status).toBe('saved')
 expect(saved.rule).toMatchObject({active:true,merchant:'合成商户0'})
 return listCategoryRules(f.db)
}

describe('批量分类撤销的事务边界加固',()=>{
 it('第二笔重建待办前的 request_review 审计失败，全部表和序列回滚且可完整重试',()=>{
  const f=prepared()
  try {
   const savedRules=saveSyntheticRule(f)
   const before=wholeState(f.db)
   f.db.exec(`CREATE TRIGGER synthetic_abort_review_audit BEFORE INSERT ON audit_log WHEN NEW.entity_id=${f.ids[1]} AND NEW.change_type='request_review' AND NEW.reasoning='撤销批量归类' BEGIN SELECT RAISE(ABORT,'synthetic review audit failed'); END`)
   expect(()=>undoClassify(f.db,f.result.classifyId)).toThrow(/synthetic review audit failed/)
   expect(wholeState(f.db)).toEqual(before)
   expect(f.db.inTransaction).toBe(false)
   expect(getClassifyResults(f.db)[0].undo).toMatchObject({status:'available',revertibleCount:2,revertedCount:0,skipped:[]})

   f.db.exec('DROP TRIGGER synthetic_abort_review_audit')
   expect(undoClassify(f.db,f.result.classifyId)).toEqual({classifyId:f.result.classifyId,revertedCount:2,skipped:[]})
   expect(listCategoryRules(f.db)).toEqual(savedRules)
   expect(getClassifyResults(f.db)[0].undo).toMatchObject({status:'reverted',revertibleCount:0,revertedCount:2})
   const after=wholeState(f.db)
   expect(undoClassify(f.db,f.result.classifyId)).toEqual({
    classifyId:f.result.classifyId,revertedCount:0,
    skipped:f.ids.map(txId=>({txId,reason:'已撤销过，无需重复'})),
   })
   expect(wholeState(f.db)).toEqual(after)
  } finally {f.db.close()}
 })
})
