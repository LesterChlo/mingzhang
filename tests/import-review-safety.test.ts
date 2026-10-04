import { expect, it, vi } from 'vitest'
import { openSchemaDb } from './helpers'
import { seed } from '../src/main/db/seed'
import { createTransaction, requestReview } from '../src/main/domain/ledger'
import { createPending } from '../src/main/domain/pending'
import { answerPending } from '../src/main/domain/pending-answer'
import { createLedgerTools } from '../src/main/engine/tools'
import { createRule, resolveRuleMatch, applyRules } from '../src/main/domain/rules'
import { classifyByMerchant } from '../src/main/domain/builtin-categories'

it('补答只修改本笔，不自动学习；模型 teach 即使 overwrite 也不能写规则', async () => {
 const db=openSchemaDb(':memory:'); seed(db)
 try {
  const tx=createTransaction(db,{amountCents:100,txType:'expense',merchant:'合成不学习'})
  requestReview(db,tx,{reason:'测试'})
  const gate=createPending(db,{txId:tx,sessionId:'test',field:'confirm_record',question:'分类？'})
  answerPending(db,gate,'餐饮',{sessionId:'test',via:'panel'})
  expect(db.prepare('SELECT * FROM rules').all()).toEqual([])
  const tools=createLedgerTools({db,getTurnContext:()=>({sessionId:'test',sourceMessageId:'test',hasImage:false,visionUnverified:false,attachments:[]})})
  const teach=tools.find(t=>t.name==='teach')!
  const result=await teach.execute('test',{action:'set_category',match_merchant:'合成不学习',category_name:'餐饮',overwrite:true},undefined,undefined,{} as never)
  expect(JSON.stringify(result)).toContain('界面')
  expect(db.prepare('SELECT * FROM rules').all()).toEqual([])
 } finally{db.close()}
})
it('损坏条件/未知分类/方向不符均阻断内置兜底，无分类或命中写入',()=>{
 const db=openSchemaDb(':memory:');seed(db)
 try {
  const id=createRule(db,{match:'merchant',op:'equals',value:'星巴克'},{set_category:'红包'})
  expect(resolveRuleMatch(db,'星巴克','expense').status).toBe('invalid')
  expect(applyRules(db,{merchant:'星巴克',kind:'expense'}).categoryId).toBeNull()
  db.prepare('UPDATE rules SET action=? WHERE id=?').run(JSON.stringify({set_category:'不存在分类'}),id)
  expect(classifyByMerchant(db,{merchant:'星巴克',kind:'expense'}).categoryId).toBeNull()
  db.prepare('UPDATE rules SET condition=? WHERE id=?').run('{bad',id)
  expect(resolveRuleMatch(db,'星巴克','expense').status).toBe('invalid')
  expect(classifyByMerchant(db,{merchant:'星巴克',kind:'expense'}).categoryId).toBeNull()
  expect(db.prepare('SELECT hit_count FROM rules').get()).toEqual({hit_count:0})
 }finally{db.close()}
})
