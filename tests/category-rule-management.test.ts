import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { createRule, resolveRuleMatch } from '../src/main/domain/rules'
import { undoClassify } from '../src/main/domain/classify'
import { expect, it } from 'vitest'
import { openSchemaDb } from './helpers'
import { seed } from '../src/main/db/seed'
import { createTransaction, requestReview } from '../src/main/domain/ledger'
import { prepareClassify, applyClassify } from '../src/main/domain/classify'
import * as rules from '../src/main/domain/category-rules'

it('重开文件库保留规则及幂等回执，撤销分类不删除规则', () => {
 const dir=mkdtempSync(join(tmpdir(),'mz-rule-synthetic-')); const file=join(dir,'synthetic.db'); let db=openSchemaDb(file); seed(db)
 try {
  const tx=createTransaction(db,{amountCents:100,txType:'expense',merchant:'合成持久店'}); requestReview(db,tx,{reason:'test'})
  const gate=prepareClassify(db,{sessionId:'ui',assignments:[{groupKey:'expense::合成持久店',categoryName:'餐饮'}]});applyClassify(db,gate.gateId)
  const categoryId=(db.prepare("SELECT id FROM categories WHERE name='餐饮'").get() as {id:number}).id
  const input={requestId:'restart-save',gateId:gate.gateId,groupKey:'expense::合成持久店',categoryId,expectedRules:[],replaceConflicts:false}
  const saved=rules.saveCategoryRule(db,input); db.close(); db=openSchemaDb(file)
  expect(rules.saveCategoryRule(db,input)).toEqual(saved)
  expect(resolveRuleMatch(db,'合成持久店','expense').status).toBe('matched')
  expect(resolveRuleMatch(db,'合成持久店','income').status).toBe('none')
  expect(resolveRuleMatch(db,'合成持久店分店','expense').status).toBe('none')
  undoClassify(db,gate.classifyId)
  expect(rules.listCategoryRules(db)[0].active).toBe(true)
 } finally {db.close();rmSync(dir,{recursive:true,force:true})}
})
it('修改 contains 规则时检测其匹配范围内的精确规则冲突', () => {
 const db=openSchemaDb(':memory:');seed(db)
 try{
  const broad=createRule(db,{match:'merchant',op:'contains',value:'合成',direction:'expense'},{set_category:'餐饮'})
  createRule(db,{match:'merchant',op:'equals',value:'合成分店',direction:'expense'},{set_category:'餐饮'})
  const rows=rules.listCategoryRules(db);const categoryId=(db.prepare("SELECT id FROM categories WHERE name='咖啡'").get() as {id:number}).id
  const result=rules.updateCategoryRule(db,{ruleId:broad,expectedVersion:rows.find(r=>r.id===broad)!.version,categoryId,expectedRules:rows.map(({id,version})=>({id,version})),replaceConflicts:false})
  expect(result.status).toBe('conflict')
  expect(rules.listCategoryRules(db).every(r=>r.categoryName==='餐饮')).toBe(true)
 }finally{db.close()}
})
it('显式来源保存幂等，方向限定，冲突必须确认，修改停用有版本门', () => {
 const db = openSchemaDb(':memory:'); seed(db)
 try {
  const tx = createTransaction(db, {amountCents:100, txType:'expense',merchant:'合成规则店', sourceMessageId:'batch-r'})
  requestReview(db,tx,{reason:'测试'})
  const gate = prepareClassify(db,{sessionId:'ui',batchId:'batch-r', assignments:[{groupKey:'expense::合成规则店',categoryName:'餐饮'}]})
  const categoryId = (db.prepare("SELECT id FROM categories WHERE name='餐饮'").get() as {id:number}).id
  const coffee = (db.prepare("SELECT id FROM categories WHERE name='咖啡'").get() as {id:number}).id
  const input = {requestId:'save-1',gateId:gate.gateId,groupKey:'expense::合成规则店',categoryId,expectedRules:[],replaceConflicts:false}
  expect(() => rules.saveCategoryRule(db,input)).toThrow(/来源/)
  applyClassify(db,gate.gateId)
  expect(rules.listCategoryRules(db)).toEqual([])
  const saved = rules.saveCategoryRule(db,input)
  expect(saved.status).toBe('saved'); expect(saved.rule?.direction).toBe('expense'); expect(saved.rule?.op).toBe('equals')
  expect(rules.saveCategoryRule(db,input)).toEqual(saved)
  expect(() => rules.saveCategoryRule(db,{...input, categoryId:coffee})).toThrow(/请求/)
  const state = rules.listCategoryRules(db); expect(state).toHaveLength(1)
  const expectedRules = state.map(({id,version})=>({id,version}))
  expect(rules.saveCategoryRule(db,{...input,requestId:'save-2',expectedRules}).status).toBe('reused')
  expect(() => rules.updateCategoryRule(db,{ruleId:saved.rule!.id,expectedVersion:'stale',categoryId:coffee,expectedRules,replaceConflicts:false})).toThrow(/版本/)
  const changed=rules.updateCategoryRule(db,{ruleId:saved.rule!.id,expectedVersion:saved.rule!.version,categoryId:coffee,expectedRules,replaceConflicts:false})
  expect(changed.rule?.categoryName).toBe('咖啡')
  expect(() => rules.deactivateCategoryRule(db,{ruleId:saved.rule!.id,expectedVersion:saved.rule!.version})).toThrow(/版本/)
  const current=rules.listCategoryRules(db); const currentVersions=current.filter(r=>r.active).map(({id,version})=>({id,version}))
  const conflict=rules.saveCategoryRule(db,{...input,requestId:'save-3',expectedRules:currentVersions})
  expect(conflict.status).toBe('conflict'); expect(conflict.conflicts).toHaveLength(1)
  const replaced=rules.saveCategoryRule(db,{...input,requestId:'save-3',expectedRules:currentVersions,replaceConflicts:true})
  expect(replaced.status).toBe('saved')
  expect(rules.listCategoryRules(db).filter(r=>r.active)).toHaveLength(1)
  expect(rules.deactivateCategoryRule(db,{ruleId:replaced.rule!.id,expectedVersion:replaced.rule!.version}).active).toBe(false)
 } finally {db.close()}
})
