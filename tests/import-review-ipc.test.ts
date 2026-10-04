import { expect, it, vi } from 'vitest'
const { handlers, invokes } = vi.hoisted(()=>({handlers:new Map<string, (...args:any[])=>any>(), invokes:vi.fn()}))
vi.mock('electron',()=>({ipcMain:{handle:(name:string,fn:(...args:any[])=>any)=>handlers.set(name,fn)},nativeTheme:{},ipcRenderer:{invoke:invokes,on:vi.fn(),removeListener:vi.fn()},contextBridge:{exposeInMainWorld:vi.fn()}}))
import { registerIpc } from '../src/main/ipc'
import { openSchemaDb } from './helpers'
import { seed } from '../src/main/db/seed'
import { createTransaction, requestReview, updateFields } from '../src/main/domain/ledger'
it('preload桥接精确转发新接口，不允许渲染层自行写库', async () => {
 const { contextBridge }=await import('electron')
 await import('../src/preload/index')
 const api=vi.mocked(contextBridge.exposeInMainWorld).mock.calls[0][1]
 const input={batchId:'synthetic',assignments:[],expectedProposalVersion:'opaque-main-token'}
 api.getClassifyResults('synthetic');expect(invokes).toHaveBeenLastCalledWith('mz:getClassifyResults','synthetic')
 api.prepareClassify(input);expect(invokes).toHaveBeenLastCalledWith('mz:prepareClassify',input)
 api.listCategoryRules();expect(invokes).toHaveBeenLastCalledWith('mz:listCategoryRules')
 for(const name of ['saveCategoryRule','updateCategoryRule','deactivateCategoryRule']) { api[name](input);expect(invokes).toHaveBeenLastCalledWith('mz:'+name,input) }
})
it('UI直连方案/规则IPC走真实领域路径，非法参数主进程拒绝',()=>{
 const db=openSchemaDb(':memory:');seed(db)
 try{
  registerIpc({getDb:()=>db} as never,{dataDir:'synthetic',dbFile:':memory:'})
  for(const name of ['prepareClassify','listCategoryRules','saveCategoryRule','updateCategoryRule','deactivateCategoryRule']) expect(handlers.has('mz:'+name)).toBe(true)
  const tx=createTransaction(db,{amountCents:123,txType:'expense',merchant:'合成IPC',sourceMessageId:'ipc-batch'});requestReview(db,tx,{reason:'test'})
  const prepare=handlers.get('mz:prepareClassify')!
  expect(()=>prepare({}, {batchId:42,assignments:[]})).toThrow()
  const proposal=handlers.get('mz:getClassifyProposal')!({},'ipc-batch')
  const input={batchId:'ipc-batch',assignments:[{groupKey:'expense::合成IPC',categoryName:'餐饮'}]}
  expect(()=>prepare({},input)).toThrow(/版本缺失/)
  expect(()=>prepare({}, {...input,expectedProposalVersion:'fake'})).toThrow(/过期/)
  updateFields(db,tx,{amount_cents:999})
  expect(()=>prepare({}, {...input,expectedProposalVersion:proposal.proposalVersion})).toThrow(/过期/)
  const refreshed=handlers.get('mz:getClassifyProposal')!({},'ipc-batch')
  const gate=prepare({}, {...input,expectedProposalVersion:refreshed.proposalVersion})
  expect(gate.plan.groups[0].totalCents).toBe(999)
  expect(gate.selectedCount).toBe(1)
  expect(()=>handlers.get('mz:applyClassify')!({},String(gate.gateId))).toThrow()
  expect(handlers.get('mz:applyClassify')!({},gate.gateId).appliedCount).toBe(1)
  expect(()=>handlers.get('mz:getClassifyResults')!({},42)).toThrow(/批次/)
  expect(handlers.get('mz:getClassifyResults')!({},'ipc-batch')[0]).toMatchObject({gateId:gate.gateId,classifyId:gate.classifyId,appliedCount:1})
  const categoryId=(db.prepare("SELECT id FROM categories WHERE name='餐饮'").get() as {id:number}).id
  const saved=handlers.get('mz:saveCategoryRule')!({}, {requestId:'ipc-save',gateId:gate.gateId,groupKey:'expense::合成IPC',categoryId,expectedRules:[],replaceConflicts:false})
  expect(saved.status).toBe('saved')
  expect(handlers.get('mz:listCategoryRules')!({})).toHaveLength(1)
 } finally {db.close()}
})
