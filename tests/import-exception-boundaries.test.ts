import { afterEach, expect, it, vi } from 'vitest'
const { uiHandlers } = vi.hoisted(() => ({uiHandlers:new Map<string,(...args:any[])=>any>()}))
vi.mock('electron',()=>({ipcMain:{handle:(name:string,fn:(...args:any[])=>any)=>uiHandlers.set(name,fn)},nativeTheme:{}}))
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openSchemaDb } from './helpers'
import { seed } from '../src/main/db/seed'
import { prepareBatch, executeBatch, batchFollowUpSummary } from '../src/main/domain/batch'
import { stageBill, applyBillPlan, parseOccurredAt } from '../src/main/domain/bill'
import { describeImportException, resolveImportException } from '../src/main/domain/import-exceptions'
import { getBatchSummary } from '../src/main/domain/batch-summary'
import { answerPending } from '../src/main/domain/pending-answer'
import { createPending, getPending } from '../src/main/domain/pending'
import { createImport, createTransaction, getTransaction } from '../src/main/domain/ledger'

const dbs: ReturnType<typeof openSchemaDb>[] = []
function fixture() {
  const db = openSchemaDb(join(mkdtempSync(join(tmpdir(), 'mz-exception-boundary-')), 'synthetic.db'))
  seed(db); dbs.push(db); return db
}
afterEach(() => { for (const db of dbs.splice(0)) db.close() })
function state(db: ReturnType<typeof fixture>) {
  const tables = (db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all() as {name:string}[]).map(r => r.name)
  return Object.fromEntries([...tables, 'sqlite_sequence'].map(name => [name, db.prepare(`SELECT * FROM ${name} ORDER BY rowid`).all()]))
}
function ids(db: ReturnType<typeof fixture>) {
  return {
    from: (db.prepare("SELECT id FROM accounts WHERE name='银行卡'").get() as {id:number}).id,
    to: (db.prepare("SELECT id FROM accounts WHERE name='微信'").get() as {id:number}).id,
    income: (db.prepare("SELECT id FROM categories WHERE name='其他' AND kind='income'").get() as {id:number}).id,
  }
}
function pending(db: ReturnType<typeof fixture>, overrides: Record<string, unknown> = {}) {
  const batch = prepareBatch(db, {sourceType:'csv', sessionId:'synthetic', channel:'synthetic', attachments:['synthetic.png'], items:[{amount_cents:null, tx_type:'income', occurred_at:'2026-10-08T09:15:00+08:00', account_name:'银行卡', merchant:'合成边界行', reliable_id:'row-a', row_no:1, source_text:'合成原文', ...overrides}]})
  const result = executeBatch(db, batch.gateId)!
  const gate = (db.prepare("SELECT id FROM pending_clarifications WHERE field IN ('batch_item','transfer_account') AND status='open' ORDER BY id DESC LIMIT 1").get() as {id:number}).id
  return {...batch, result, gate}
}
function resolve(db: ReturnType<typeof fixture>, gate: number, fields: Record<string, unknown>, version = describeImportException(db, gate)!.version) {
  return resolveImportException(db, {gateId:gate, expectedVersion:version, fields} as never, {sessionId:'synthetic', via:'panel'})
}

it('异常DTO在SQLite query_only下稳定读取，不建分类、账户、规则或修改任何表', () => {
  const db = fixture(), x = pending(db), before = state(db)
  db.pragma('query_only = ON')
  const first = describeImportException(db, x.gate)!
  expect(describeImportException(db, x.gate)).toEqual(first)
  expect(first.missingFields).toEqual(['amountCents'])
  expect(first.values.occurredAt).toBe('2026-10-08T09:15:00+08:00')
  expect(state(db)).toEqual(before)
  db.pragma('query_only = OFF')
})

it('summary按当前本批待办计异常，补原行后减一且不含另批或excluded来源', () => {
  const db=fixture(), a=ids(db), x=pending(db)
  const y=pending(db,{reliable_id:'row-b'})
  const before=state(db)
  expect(getBatchSummary(db,x.gateId)!.counts.unparsed).toBe(1)
  expect(state(db)).toEqual(before)
  resolve(db,x.gate,{amountCents:1234,categoryId:a.income})
  const after=state(db)
  expect(getBatchSummary(db,x.gateId)).toMatchObject({counts:{unparsed:0,booked:1},excludedRows:null})
  expect(getBatchSummary(db,y.gateId)!.counts.unparsed).toBe(1)
  expect(state(db)).toEqual(after)
  expect(getPending(db,y.gate)?.status).toBe('open')
  expect(db.prepare('SELECT status FROM imports WHERE id=?').get(x.plan.importId)).toEqual({status:'confirmed'})
  expect(db.prepare('SELECT status FROM imports WHERE id=?').get(y.plan.importId)).toEqual({status:'pending'})
})

it('非法转账同账户原值标缺转入账户，允许纠正无效原值而不覆盖其他有效字段', () => {
  const db=fixture(), a=ids(db), x=pending(db,{amount_cents:2300,tx_type:'transfer',to_account_name:'银行卡'})
  const d=describeImportException(db,x.gate)!
  expect(d.missingFields).toEqual(['toAccountId'])
  expect(d.values.toAccountId).toBeNull()
  const r=resolve(db,x.gate,{toAccountId:a.to})
  expect(getTransaction(db,r.txId)).toMatchObject({type:'transfer',amount_cents:2300,account_id:a.from,to_account_id:a.to,state:'confirmed'})
})

it('少数日期失败原表行保留收入、金额、账户、可靠ID及原表身份', () => {
  const db=fixture(), a=ids(db)
  const t=stageBill(db,{sourceType:'csv',channel:'synthetic-table',cells:[['时间','方向','金额','账户','对方','编号'],['坏时间','收入','12.34','银行卡','合成日期异常','r-bad'],['2026-10-08 09:15:00','收入','5.00','银行卡','合成正常','r-ok-1'],['2026-10-08 09:16:00','收入','6.00','银行卡','合成正常','r-ok-2']]})
  const p=applyBillPlan(db,{table_id:t.id,columns:{amount:'金额',time:'时间',direction:'方向',account:'账户',merchant:'对方',id:'编号'},account_column_values:[{contains:'银行卡',account_name:'银行卡'}],categories:[{match:'合成正常',category_name:'其他'}]},{sessionId:'synthetic'})
  executeBatch(db,p.gateId!)
  const gate=(db.prepare("SELECT id FROM pending_clarifications WHERE field='batch_item' AND status='open'").get() as {id:number}).id
  const d=describeImportException(db,gate)!
  expect(d.values).toMatchObject({amountCents:1234,txType:'income',accountId:a.from,occurredAt:null})
  expect(d.source).toMatchObject({tableId:t.id,rowNo:1})
  const r=resolve(db,gate,{occurredAt:'2026-10-08T09:17:00+08:00',categoryId:a.income})
  expect(db.prepare('SELECT dedup_key FROM transactions WHERE id=?').get(r.txId)).toEqual({dedup_key:'synthetic-table:r-bad'})
})

it('补齐未定分类只转needs_review与linked确认门，不假confirmed也不让模型关闭', () => {
  const db=fixture(), x=pending(db)
  const r=resolve(db,x.gate,{amountCents:1800})
  expect(r.card.tx.state).toBe('needs_review')
  expect(r.card.gateId).toBeGreaterThan(0)
  expect(r.text).toContain('尚未确认入账')
  expect(db.prepare('SELECT status FROM imports WHERE id=?').get(x.plan.importId)).toEqual({status:'pending'})
  const before=state(db)
  expect(()=>answerPending(db,r.card.gateId!,'其他',{sessionId:'synthetic',via:'chat'})).toThrow()
  expect(state(db)).toEqual(before)
  expect(getPending(db,x.gate)).toMatchObject({tx_id:r.txId,status:'resolved'})
  expect(()=>resolve(db,x.gate,{amountCents:1800})).toThrow()
})

it('原gate关联现有交易复用同一ID而非新增交易', () => {
  const db=fixture(), a=ids(db)
  const importId=createImport(db,{sourceType:'csv',sourceMessageId:'synthetic-reuse',status:'pending'})
  const txId=createTransaction(db,{amountCents:3200,txType:'income',accountId:a.from,occurredAt:'2026-10-08 09:15:00',sourceMessageId:'synthetic-reuse'})
  const gate=createPending(db,{txId,sessionId:'synthetic',field:'batch_item',question:'合成复用',payload:{batchId:'synthetic-reuse',importId}})
  const r=resolve(db,gate,{categoryId:a.income})
  expect(r.txId).toBe(txId)
  expect(db.prepare('SELECT COUNT(*) n FROM transactions').get()).toEqual({n:1})
  expect(getTransaction(db,txId)?.state).toBe('confirmed')
})

it('runtime精确shape、未知key与不安全金额/日期/分类/账户/chat都拒绝零写', () => {
  const db=fixture(), x=pending(db), d=describeImportException(db,x.gate)!, base={gateId:x.gate,expectedVersion:d.version,fields:{amountCents:1800}}
  const bad=[null,[],{}, {...base,extra:true},{...base,fields:{amountCents:1800,unknown:true}},{...base,fields:{amountCents:'1800'}},{...base,fields:{amountCents:1.5}},{...base,fields:{amountCents:Number.MAX_SAFE_INTEGER+1}},{...base,fields:{amountCents:NaN}},{...base,fields:{amountCents:0}},{...base,fields:{amountCents:-1}},{...base,fields:{amountCents:1800,categoryId:999999}},{...base,fields:{amountCents:1800,toAccountId:1}},{...base,fields:{amountCents:1800,occurredAt:'2026-02-30T09:10:00+08:00'}}]
  for(const input of bad) { const before=state(db);expect(()=>resolveImportException(db,input as never,{sessionId:'synthetic',via:'panel'})).toThrow();expect(state(db)).toEqual(before) }
  const before=state(db);expect(()=>resolveImportException(db,base,{sessionId:'synthetic',via:'chat'})).toThrow();expect(state(db)).toEqual(before)
})

for (const mutation of ['payload','account','source','linkedTx'] as const) it(`版本覆盖${mutation}变化，旧授权拒绝且无写入`, () => {
  const db=fixture(), x=pending(db), d=describeImportException(db,x.gate)!, a=ids(db)
  if(mutation==='payload') db.prepare("UPDATE pending_clarifications SET payload=json_set(payload,'$.merchant','合成变化') WHERE id=?").run(x.gate)
  if(mutation==='account') db.prepare("UPDATE accounts SET name='合成改名' WHERE id=?").run(a.from)
  if(mutation==='source') db.prepare("UPDATE imports SET source_ref='synthetic-new.png' WHERE id=?").run(x.plan.importId)
  if(mutation==='linkedTx') { const tx=createTransaction(db,{amountCents:123,txType:'income',accountId:a.from,occurredAt:'2026-10-08 09:15:00',sourceMessageId:x.plan.batchId});db.prepare('UPDATE pending_clarifications SET tx_id=? WHERE id=?').run(tx,x.gate) }
  const before=state(db);expect(()=>resolve(db,x.gate,{amountCents:1800,categoryId:a.income},d.version)).toThrow(/版本/);expect(state(db)).toEqual(before)
})

for(const target of ['pending_clarifications','imports'] as const) it(`${target}写入故障整体回滚全部表含序号，原版本输入可重试`, () => {
  const db=fixture(), x=pending(db), a=ids(db), d=describeImportException(db,x.gate)!
  db.exec(`CREATE TRIGGER synthetic_fail BEFORE UPDATE ON ${target} BEGIN SELECT RAISE(ABORT,'SYNTHETIC-WRITE-FAIL'); END`)
  const before=state(db);expect(()=>resolve(db,x.gate,{amountCents:1800,categoryId:a.income},d.version)).toThrow(/SYNTHETIC-WRITE-FAIL/);expect(state(db)).toEqual(before)
  db.exec('DROP TRIGGER synthetic_fail')
  expect(resolve(db,x.gate,{amountCents:1800,categoryId:a.income},d.version).card.tx.state).toBe('confirmed')
})

it('source可靠去重键已被其他交易使用时不得再创造交易', () => {
  const db=fixture(), x=pending(db), a=ids(db)
  const tx=createTransaction(db,{amountCents:321,txType:'income',accountId:a.from,occurredAt:'2026-10-08 09:15:00',sourceMessageId:'synthetic-other'})
  db.prepare('UPDATE transactions SET dedup_key=? WHERE id=?').run('synthetic:row-a',tx)
  const before=state(db);expect(()=>resolve(db,x.gate,{amountCents:1800,categoryId:a.income})).toThrow(/交易号|重复/);expect(state(db)).toEqual(before)
})

it('transfer回执只引导原待办字段，金额不改且不指令record另记', () => {
  const db=fixture(), x=pending(db,{amount_cents:2300,tx_type:'transfer'})
  const summary=batchFollowUpSummary(x.result)
  expect(summary).toContain('¥23.00')
  expect(summary).toContain('转出账户');expect(summary).toContain('转入账户');expect(summary).toContain('原待办')
  expect(summary).not.toContain('record 工具')
})

it('严格时间拒绝无效闰日/时区，保留有效offset原文', () => {
  expect(parseOccurredAt('2026-02-30 10:00:00')).toBeNull()
  expect(parseOccurredAt('2026-02-29 10:00:00')).toBeNull()
  expect(parseOccurredAt('2024-02-29T10:00:00+08:00')).toBe('2024-02-29T10:00:00+08:00')
  expect(parseOccurredAt('2024-02-29T10:00:00+25:00')).toBeNull()
})

it('金额或日期异常缺方向时不承接正常批次默认支出', () => {
  const db=fixture(), a=ids(db), x=pending(db,{tx_type:undefined})
  expect(describeImportException(db,x.gate)!.missingFields).toEqual(['amountCents','txType'])
  const r=resolve(db,x.gate,{amountCents:1234,txType:'income',categoryId:a.income})
  expect(r.card.tx.type).toBe('income')
})

it('实际表日期异常无方向列/默认方向时不保留推测支出', () => {
  const db=fixture()
  const t=stageBill(db,{sourceType:'csv',cells:[['时间','金额','账户'],['坏时间','12.34','银行卡'],['2026-10-08 09:15:00','5.00','银行卡'],['2026-10-08 09:16:00','6.00','银行卡']]})
  const p=applyBillPlan(db,{table_id:t.id,columns:{amount:'金额',time:'时间',account:'账户'},account_column_values:[{contains:'银行卡',account_name:'银行卡'}]},{sessionId:'synthetic'})
  executeBatch(db,p.gateId!)
  const gate=(db.prepare("SELECT id FROM pending_clarifications WHERE field='batch_item'").get() as {id:number}).id
  expect(describeImportException(db,gate)!.missingFields).toEqual(['txType','occurredAt'])
  expect(describeImportException(db,gate)!.values.txType).toBeNull()
})

it('旧可信payload完整金额token可安全续办，日期与混合日期数字/未知分类不写', () => {
  const db=fixture(), a=ids(db), importId=createImport(db,{sourceType:'csv',status:'pending',sourceMessageId:'synthetic-legacy-safe'})
  const gate=createPending(db,{sessionId:'synthetic',field:'batch_item',question:'合成旧可靠值',payload:{batchId:'synthetic-legacy-safe',importId,txType:'income',occurredAt:'2026-10-08 09:15:00',accountName:'银行卡'}})
  for(const answer of ['2026-10-08','2026-10-08 12.34','12.34 随意新分类']) {const before=state(db);expect(()=>answerPending(db,gate,answer,{sessionId:'synthetic',via:'panel'})).toThrow();expect(state(db)).toEqual(before)}
  const r=answerPending(db,gate,'12.34 其他',{sessionId:'synthetic',via:'panel'})
  expect(r.card!.tx).toMatchObject({amountCents:1234,type:'income',state:'confirmed',accountName:'银行卡'})
})

it('同批两个异常只补选中行仍pending，另一行/原来源有效值不变', () => {
  const db=fixture(), a=ids(db)
  const {gateId,plan}=prepareBatch(db,{sourceType:'csv',sessionId:'synthetic',channel:'synthetic',items:[{amount_cents:null,tx_type:'income',occurred_at:'2026-10-08 09:15:00',account_name:'银行卡',reliable_id:'a',row_no:1},{amount_cents:null,tx_type:'transfer',occurred_at:'2026-10-08 09:16:00',account_name:'银行卡',reliable_id:'b',row_no:2}]})
  executeBatch(db,gateId)
  const gates=db.prepare("SELECT id FROM pending_clarifications WHERE field='batch_item' ORDER BY id").all() as {id:number}[]
  const other=getPending(db,gates[1].id)
  resolve(db,gates[0].id,{amountCents:300,categoryId:a.income})
  expect(getPending(db,gates[1].id)).toEqual(other)
  expect(db.prepare('SELECT status FROM imports WHERE id=?').get(plan.importId)).toEqual({status:'pending'})
  expect(db.prepare('SELECT COUNT(*) n FROM transactions').get()).toEqual({n:1})
})

it('linked确认原行分类后收口（走现有用户confirmRecord生产入口），不再永久pending', async () => {
  const { Engine }=await import('../src/main/engine/engine')
  const { registerIpc }=await import('../src/main/ipc')
  const db=fixture(), x=pending(db), r=resolve(db,x.gate,{amountCents:2500})
  const engine=Object.create(Engine.prototype)
  Object.assign(engine,{db,confirming:new Set(),broadcast:()=>{},session:null})
  registerIpc({getDb:()=>db,engines:{get:()=>engine}} as never,{dataDir:'synthetic',dbFile:'synthetic'})
  expect(await uiHandlers.get('mz:confirmRecord')!({},r.txId,'其他')).toMatchObject({status:'ok'})
  expect(getTransaction(db,r.txId)?.state).toBe('confirmed')
  expect(getPending(db,r.card.gateId!)?.status).toBe('resolved')
  expect(db.prepare('SELECT status FROM imports WHERE id=?').get(x.plan.importId)).toEqual({status:'confirmed'})
})

it('linked用户确认审计故障全回滚包含pending/分类/序号，原IPC重试可收口', async () => {
  const { registerIpc }=await import('../src/main/ipc')
  const db=fixture(), x=pending(db), r=resolve(db,x.gate,{amountCents:2500})
  registerIpc({getDb:()=>db,engines:{get:()=>{throw new Error('NEW-LINKED-MUST-NOT-USE-ENGINE')}}} as never,{dataDir:'synthetic',dbFile:'synthetic'})
  db.exec("CREATE TRIGGER synthetic_linked_audit BEFORE INSERT ON audit_log WHEN NEW.change_type='confirm' BEGIN SELECT RAISE(ABORT,'SYNTHETIC-LINKED-AUDIT'); END")
  const before=state(db)
  await expect(uiHandlers.get('mz:confirmRecord')!({},r.txId,'其他')).rejects.toThrow()
  expect(state(db)).toEqual(before)
  db.exec('DROP TRIGGER synthetic_linked_audit')
  expect(await uiHandlers.get('mz:confirmRecord')!({},r.txId,'其他')).toMatchObject({status:'ok'})
  expect(db.prepare('SELECT status FROM imports WHERE id=?').get(x.plan.importId)).toEqual({status:'confirmed'})
})

it('commit_batch真实工具透传原账户和转入账户，异常不因schema入口丢方向或账户', async () => {
  const { createM3Tools }=await import('../src/main/engine/tools-m3')
  const db=fixture(), a=ids(db)
  const tool=createM3Tools({db,getTurnContext:()=>({sessionId:'synthetic',sourceMessageId:'synthetic',attachments:[]}) as never}).find(t=>t.name==='commit_batch')!
  const parameters=tool.parameters as any
  expect(parameters.properties.items.items.properties.account_name).toBeDefined()
  expect(parameters.properties.items.items.properties.to_account_name).toBeDefined()
  const result=await tool.execute!('synthetic-call',{source_type:'csv',channel:'synthetic',items:[{amount_cents:1400,tx_type:'transfer',occurred_at:'2026-10-08 09:15:00',account_name:'银行卡',to_account_name:'微信',reliable_id:'synthetic-tool-row'}]},undefined,undefined,{} as never) as any
  executeBatch(db,result.details.card.gateId)
  const gate=(db.prepare("SELECT id FROM pending_clarifications WHERE field='transfer_account'").get() as {id:number}).id
  expect(describeImportException(db,gate)!.values).toMatchObject({txType:'transfer',amountCents:1400,accountId:a.from,toAccountId:a.to})
  expect(describeImportException(db,gate)!.missingFields).toEqual([])
})

it('复用原交易已存在分类确认待办时升级为原行显式确认，模型不得借旧门入账', () => {
  const db=fixture(), a=ids(db), importId=createImport(db,{sourceType:'csv',sourceMessageId:'synthetic-reuse-review',status:'pending'})
  const txId=createTransaction(db,{amountCents:3200,txType:'income',accountId:a.from,occurredAt:'2026-10-08 09:15:00',sourceMessageId:'synthetic-reuse-review'})
  const linked=createPending(db,{txId,sessionId:'synthetic',field:'confirm_record',question:'旧分类待定',payload:{txId,reason:'分类未定'}})
  const gate=createPending(db,{txId,sessionId:'synthetic',field:'batch_item',question:'合成复用',payload:{batchId:'synthetic-reuse-review',importId}})
  const r=resolve(db,gate,{})
  expect(r.card.gateId).toBe(linked)
  const before=state(db)
  expect(()=>answerPending(db,linked,'其他',{sessionId:'synthetic',via:'chat'})).toThrow()
  expect(state(db)).toEqual(before)
  expect(JSON.parse(getPending(db,linked)!.payload)).toMatchObject({requiresExplicitConfirm:true,importExceptionGateId:gate,batchId:'synthetic-reuse-review',importId})
})

it('同原表行已由另一批异常补录时拒绝跨批重复创造交易', () => {
  const db=fixture(), a=ids(db)
  const table=stageBill(db,{sourceType:'csv',cells:[['时间','金额','账户'],['2026-10-08 09:15:00','缺失','银行卡']]})
  const apply=applyBillPlan(db,{table_id:table.id,columns:{time:'时间',amount:'金额',account:'账户'},default_type:'income',account_column_values:[{contains:'银行卡',account_name:'银行卡'}]},{sessionId:'synthetic'})
  executeBatch(db,apply.gateId!)
  const gate=(db.prepare("SELECT id FROM pending_clarifications WHERE field='batch_item'").get() as {id:number}).id
  resolve(db,gate,{amountCents:300,categoryId:a.income})
  const importId=createImport(db,{sourceType:'csv',sourceMessageId:'synthetic-other-source',status:'pending'})
  const another=createPending(db,{sessionId:'synthetic',field:'batch_item',question:'同表行另一批',payload:{batchId:'synthetic-other-source',importId,tableId:table.id,rowNo:1,txType:'income',occurredAt:'2026-10-08 09:15:00',accountName:'银行卡'}})
  const before=state(db)
  expect(()=>resolve(db,another,{amountCents:300,categoryId:a.income})).toThrow(/原账单行|来源/)
  expect(state(db)).toEqual(before)
})

it('复用原交易显式给分类确认时同步关闭其原分类待办，本批正确收口', () => {
  const db=fixture(), a=ids(db), importId=createImport(db,{sourceType:'csv',sourceMessageId:'synthetic-reuse-categorized',status:'pending'})
  const txId=createTransaction(db,{amountCents:3200,txType:'income',accountId:a.from,occurredAt:'2026-10-08 09:15:00',sourceMessageId:'synthetic-reuse-categorized'})
  const linked=createPending(db,{txId,sessionId:'synthetic',field:'confirm_record',question:'旧分类待定',payload:{txId,reason:'分类未定'}})
  const gate=createPending(db,{txId,sessionId:'synthetic',field:'batch_item',question:'合成复用',payload:{batchId:'synthetic-reuse-categorized',importId}})
  expect(resolve(db,gate,{categoryId:a.income}).txId).toBe(txId)
  expect(getPending(db,linked)?.status).toBe('resolved')
  expect(db.prepare('SELECT status FROM imports WHERE id=?').get(importId)).toEqual({status:'confirmed'})
})

it('原交易关联分类待办并发变化也使补录版本过期，拒绝关闭新关联门', () => {
  const db=fixture(), a=ids(db), importId=createImport(db,{sourceType:'csv',sourceMessageId:'synthetic-related-version',status:'pending'})
  const txId=createTransaction(db,{amountCents:3200,txType:'income',accountId:a.from,occurredAt:'2026-10-08 09:15:00',sourceMessageId:'synthetic-related-version'})
  const gate=createPending(db,{txId,sessionId:'synthetic',field:'batch_item',question:'合成复用',payload:{batchId:'synthetic-related-version',importId}})
  const d=describeImportException(db,gate)!
  createPending(db,{txId,sessionId:'synthetic',field:'confirm_record',question:'并发关联门',payload:{txId,reason:'分类未定'}})
  const before=state(db)
  expect(()=>resolve(db,gate,{categoryId:a.income},d.version)).toThrow(/版本/)
  expect(state(db)).toEqual(before)
})

it('本批普通待分类与异常并存，异常完成不提前收口，普通UI确认最后一行后收口', async () => {
  const { registerIpc }=await import('../src/main/ipc'), { Engine }=await import('../src/main/engine/engine')
  const db=fixture(),a=ids(db)
  const {gateId,plan}=prepareBatch(db,{sourceType:'csv',sessionId:'synthetic',items:[{amount_cents:300,tx_type:'income',occurred_at:'2026-10-08 09:15:00',account_name:'银行卡',merchant:'合成无分类正常行'},{amount_cents:null,tx_type:'income',occurred_at:'2026-10-08 09:16:00',account_name:'银行卡'}]})
  executeBatch(db,gateId)
  const exceptional=(db.prepare("SELECT id FROM pending_clarifications WHERE field='batch_item'").get() as {id:number}).id
  resolve(db,exceptional,{amountCents:400,categoryId:a.income})
  expect(db.prepare('SELECT status FROM imports WHERE id=?').get(plan.importId)).toEqual({status:'pending'})
  const normal=(db.prepare("SELECT id FROM transactions WHERE state='needs_review'").get() as {id:number}).id
  const engine=Object.create(Engine.prototype);Object.assign(engine,{db,confirming:new Set(),broadcast:()=>{},session:null})
  registerIpc({getDb:()=>db,engines:{get:()=>engine}} as never,{dataDir:'synthetic',dbFile:'synthetic'})
  expect(await uiHandlers.get('mz:confirmRecord')!({},normal,'其他')).toMatchObject({status:'ok'})
  expect(db.prepare('SELECT status FROM imports WHERE id=?').get(plan.importId)).toEqual({status:'confirmed'})
})
