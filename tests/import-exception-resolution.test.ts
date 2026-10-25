// Parent acceptance for issue24. Synthetic DB only; all rejected or faulted writes must preserve full state.
import { afterEach, expect, it } from 'vitest'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openSchemaDb } from './helpers'
import { seed } from '../src/main/db/seed'
import { prepareBatch, executeBatch } from '../src/main/domain/batch'
import { stageBill, applyBillPlan } from '../src/main/domain/bill'
import { createPending, getPending } from '../src/main/domain/pending'
import { createImport, getTransaction } from '../src/main/domain/ledger'
import { answerPending } from '../src/main/domain/pending-answer'
import * as exceptions from '../src/main/domain/import-exceptions'

const dbs: ReturnType<typeof openSchemaDb>[] = []
function fixture() { const db = openSchemaDb(join(mkdtempSync(join(tmpdir(), 'mz-exception-parent-')), 'synthetic.db')); seed(db); dbs.push(db); return db }
afterEach(() => { for (const db of dbs.splice(0)) db.close() })
function state(db: ReturnType<typeof fixture>) {
  return Object.fromEntries(['transactions','imports','pending_clarifications','audit_log','accounts','categories','rules','settings','bill_tables','bill_rows','sqlite_sequence'].map(name => [name, db.prepare(`SELECT * FROM ${name} ORDER BY rowid`).all()]))
}
function ids(db: ReturnType<typeof fixture>) {
  const account = (name: string) => (db.prepare('SELECT id FROM accounts WHERE name=?').get(name) as {id:number}).id
  const category = (kind: string) => (db.prepare('SELECT id FROM categories WHERE name=? AND kind=?').get('其他',kind) as {id:number}).id
  return { from: account('银行卡'), to: account('微信'), income: category('income'), expense: category('expense') }
}
function pending(db: ReturnType<typeof fixture>, fields: Record<string, unknown> = {}) {
  const {gateId,plan} = prepareBatch(db,{sourceType:'csv',sessionId:'synthetic-session',channel:'synthetic-channel',items:[{amount_cents:null,tx_type:'income',occurred_at:'2026-10-08 09:15:00',account_name:'银行卡',merchant:'合成收入异常',source_text:'2026-10-08 金额空',reliable_id:'synthetic-row-01',row_no:1,...fields}]})
  executeBatch(db,gateId)
  // Parent fixture correction: scope to THIS batch, never reuse an older open gate.
  const row = db.prepare("SELECT id FROM pending_clarifications WHERE status='open' AND field IN ('batch_item','transfer_account') AND json_extract(payload,'$.batchId')=? ORDER BY id LIMIT 1").get(plan.batchId) as {id:number}
  return {gate:row.id,plan,batchGate:gateId}
}
function describe(db: ReturnType<typeof fixture>, gate: number) { return exceptions.describeImportException(db,gate)! }
function resolve(db: ReturnType<typeof fixture>, gate: number, fields: Record<string,unknown>, version = describe(db,gate).version) {
  return exceptions.resolveImportException(db,{gateId:gate,expectedVersion:version,fields} as never,{sessionId:'synthetic-session',via:'panel'})
}

it('未知账户异常保留收入、有效金额日期及来源，不把日期当金额或静默现金', () => {
  const db=fixture(),a=ids(db),x=pending(db,{amount_cents:8750,account_name:'未知合成账户'})
  const before=state(db),d=describe(db,x.gate)
  expect(d.missingFields).toEqual(['accountId'])
  expect(d.values).toMatchObject({amountCents:8750,txType:'income',occurredAt:'2026-10-08 09:15:00',accountId:null})
  expect(d.source).toMatchObject({batchId:x.plan.batchId,importId:x.plan.importId,rowNo:1,sourceText:'2026-10-08 金额空'})
  expect(state(db)).toEqual(before)
  const result=resolve(db,x.gate,{accountId:a.from,categoryId:a.income})
  expect(getTransaction(db,result.txId)).toMatchObject({amount_cents:8750,type:'income',account_id:a.from,occurred_at:'2026-10-08 09:15:00',source_message_id:x.plan.batchId,state:'confirmed'})
  expect(getPending(db,x.gate)?.status).toBe('resolved')
  expect((db.prepare('SELECT status FROM imports WHERE id=?').get(x.plan.importId) as {status:string}).status).toBe('confirmed')
  const once=state(db); expect(() => resolve(db,x.gate,{accountId:a.from},d.version)).toThrow(); expect(state(db)).toEqual(once)
})

it('缺金额保存收入/日期/账户及去重键；补录只写所选原行并留用户审计', () => {
  const db=fixture(),a=ids(db),x=pending(db),d=describe(db,x.gate)
  expect(d.missingFields).toEqual(['amountCents'])
  expect(d.values).toMatchObject({txType:'income',occurredAt:'2026-10-08 09:15:00',accountId:a.from})
  const r=resolve(db,x.gate,{amountCents:1588,categoryId:a.income})
  expect(getTransaction(db,r.txId)).toMatchObject({amount_cents:1588,type:'income',account_id:a.from,occurred_at:'2026-10-08 09:15:00',state:'confirmed'})
  expect(db.prepare('SELECT dedup_key FROM transactions WHERE id=?').get(r.txId)).toEqual({dedup_key:'synthetic-channel:synthetic-row-01'})
  expect(db.prepare("SELECT changed_by FROM audit_log WHERE entity_type='transaction' AND entity_id=? AND change_type='confirm' ORDER BY id DESC LIMIT 1").get(r.txId)).toEqual({changed_by:'user'})
})

it('旧payload不足不默认今天/支出/现金，必须显式补齐；严格文本不得从日期抽数', () => {
  const db=fixture(),a=ids(db),importId=createImport(db,{sourceType:'csv',sourceMessageId:'synthetic-legacy'})
  const gate=createPending(db,{sessionId:'synthetic-session',field:'batch_item',question:'旧合成金额待补',payload:{importId,batchId:'synthetic-legacy',sourceText:'2026-10-08 来源',merchant:'合成旧行'}})
  const d=describe(db,gate);expect(new Set(d.missingFields)).toEqual(new Set(['amountCents','txType','occurredAt','accountId']))
  const before=state(db)
  expect(() => answerPending(db,gate,'2026-10-08',{sessionId:'synthetic-session',via:'panel'})).toThrow()
  expect(() => resolve(db,gate,{amountCents:2000})).toThrow()
  expect(state(db)).toEqual(before)
  const r=resolve(db,gate,{amountCents:2000,txType:'income',occurredAt:'2026-10-02T10:20:00+08:00',accountId:a.to,categoryId:a.income})
  expect(getTransaction(db,r.txId)).toMatchObject({type:'income',amount_cents:2000,account_id:a.to,occurred_at:'2026-10-02T10:20:00+08:00'})
})

it('转账补双真实不同账户仅生成一笔，不计收支，未补录时批次不假称完成', () => {
  const db=fixture(),a=ids(db),x=pending(db,{amount_cents:6300,tx_type:'transfer',account_name:'银行卡'}),d=describe(db,x.gate)
  expect(d.values.txType).toBe('transfer');expect(d.missingFields).toEqual(['toAccountId'])
  expect(db.prepare('SELECT status FROM imports WHERE id=?').get(x.plan.importId)).toEqual({status:'pending'})
  const before=state(db);expect(() => resolve(db,x.gate,{toAccountId:a.from})).toThrow();expect(state(db)).toEqual(before)
  const r=resolve(db,x.gate,{toAccountId:a.to})
  expect(getTransaction(db,r.txId)).toMatchObject({type:'transfer',account_id:a.from,to_account_id:a.to,amount_cents:6300,state:'confirmed'})
  expect(db.prepare('SELECT COUNT(*) n FROM v_reportable_transactions').get()).toEqual({n:0})
  expect(db.prepare('SELECT COUNT(*) n FROM transactions').get()).toEqual({n:1})
})

it('不同批次互不阻塞收口，仍有本批异常时保持pending', () => {
  const db=fixture(),a=ids(db),x=pending(db),y=pending(db,{merchant:'其他合成批次',reliable_id:'synthetic-row-02'})
  resolve(db,x.gate,{amountCents:100,categoryId:a.income})
  expect(db.prepare('SELECT status FROM imports WHERE id=?').get(x.plan.importId)).toEqual({status:'confirmed'})
  expect(db.prepare('SELECT status FROM imports WHERE id=?').get(y.plan.importId)).toEqual({status:'pending'})
  expect(getPending(db,y.gate)?.status).toBe('open')
})

it('版本变化/错方向分类/非法日期/越权已知金额都拒绝且全状态不变', () => {
  const db=fixture(),a=ids(db),x=pending(db,{amount_cents:4200,occurred_at:null,review_reason:'合成日期缺失'}),d=describe(db,x.gate)
  const invalid=[{occurredAt:'2026-02-30 10:00:00'},{occurredAt:'2026-10-09 09:00:00',categoryId:a.expense},{occurredAt:'2026-10-09 09:00:00',amountCents:9999},{occurredAt:'2026-10-09 09:00:00',accountId:999999}]
  for (const fields of invalid) {const before=state(db);expect(() => resolve(db,x.gate,fields,d.version)).toThrow();expect(state(db)).toEqual(before)}
  db.prepare('UPDATE pending_clarifications SET revision=revision+1 WHERE id=?').run(x.gate)
  const before=state(db);expect(() => resolve(db,x.gate,{occurredAt:'2026-10-09 09:00:00'},d.version)).toThrow();expect(state(db)).toEqual(before)
})

it('审计中途失败回滚交易/分类/规则/pending/import/序号，移除故障后同原输入可重试', () => {
  const db=fixture(),a=ids(db),x=pending(db),d=describe(db,x.gate)
  db.exec("CREATE TRIGGER synthetic_fail_confirm BEFORE INSERT ON audit_log WHEN NEW.entity_type='transaction' AND NEW.change_type='confirm' BEGIN SELECT RAISE(ABORT,'SYNTHETIC-CONFIRM-AUDIT'); END")
  const before=state(db)
  expect(() => resolve(db,x.gate,{amountCents:1234,categoryId:a.income},d.version)).toThrow(/SYNTHETIC-CONFIRM-AUDIT/)
  expect(state(db)).toEqual(before)
  db.exec('DROP TRIGGER synthetic_fail_confirm')
  const r=resolve(db,x.gate,{amountCents:1234,categoryId:a.income},d.version);expect(getTransaction(db,r.txId)?.amount_cents).toBe(1234)
})

it('实际套表金额失败也保留原收入、有效时间账户、原表行号与完整来源', () => {
  const db=fixture(),a=ids(db)
  const t=stageBill(db,{sourceType:'csv',fileName:'synthetic-income.csv',cells:[['时间','方向','金额','账户','对方','编号'],['2026-10-08 09:15:00','收入','缺失','银行卡','合成收入','synthetic-id']]})
  const p=applyBillPlan(db,{table_id:t.id,columns:{amount:'金额',time:'时间',direction:'方向',account:'账户',merchant:'对方',id:'编号'},account_column_values:[{contains:'银行卡',account_name:'银行卡'}]}, {sessionId:'synthetic-session'})
  executeBatch(db,p.gateId!)
  const row=db.prepare("SELECT id FROM pending_clarifications WHERE field='batch_item' AND status='open'").get() as {id:number}
  const d=describe(db,row.id)
  expect(d.values).toMatchObject({txType:'income',accountId:a.from,occurredAt:'2026-10-08 09:15:00'})
  expect(d.source).toMatchObject({tableId:t.id,rowNo:1})
  const r=resolve(db,row.id,{amountCents:1200,categoryId:a.income})
  expect(getTransaction(db,r.txId)?.type).toBe('income')
  expect(db.prepare('SELECT COUNT(*) n FROM transactions').get()).toEqual({n:1})
})

it('新结构异常不能被模型自由补答关闭或写账，UI不需要伪造确认信号', () => {
  const db=fixture(),x=pending(db),before=state(db)
  expect(() => answerPending(db,x.gate,'1588',{sessionId:'synthetic-session',via:'chat'})).toThrow()
  expect(state(db)).toEqual(before)
  expect(getPending(db,x.gate)?.status).toBe('open')
})
