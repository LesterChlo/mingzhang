import { afterEach, expect, it } from 'vitest'
import { openSchemaDb } from './helpers'
import { seed } from '../src/main/db/seed'
import { prepareBatch, executeBatch } from '../src/main/domain/batch'
import { describeImportException } from '../src/main/domain/import-exceptions'
import { stageBill, applyBillPlan } from '../src/main/domain/bill'
import { createM3Tools } from '../src/main/engine/tools-m3'

const dbs: ReturnType<typeof openSchemaDb>[] = []
function fixture() { const db = openSchemaDb(':memory:'); seed(db); dbs.push(db); return db }
afterEach(() => { for (const db of dbs.splice(0)) db.close() })
const valid = {amount_cents:4705,tx_type:'income' as const,occurred_at:'2026-09-30 12:34:56',account_name:'微信',category_name:'其他',merchant:'合成边界',source_text:'合成原行',reliable_id:'r1-boundary'}

for (const [label, change, field] of [
  ['空日期',{occurred_at:''},'occurredAt'],
  ['空白账户',{account_name:'   '},'accountId'],
  ['未知方向',{tx_type:'refund'},'txType'],
] as const) it(`${label}不能走正常批次默认`, () => {
  const db=fixture()
  try {
    const p=prepareBatch(db,{sourceType:'csv',sessionId:'synthetic',items:[{...valid,...change} as never]})
    const r=executeBatch(db,p.gateId)!
    expect(r.completed).toHaveLength(0)
    expect(r.unparsedKept+r.unmatchedAccounts).toBe(1)
    expect(db.prepare('SELECT COUNT(*) n FROM transactions').get()).toEqual({n:0})
    const row=db.prepare("SELECT id FROM pending_clarifications WHERE field='batch_item' AND status='open'").get() as {id:number}
    expect(describeImportException(db,row.id)!.missingFields).toContain(field)
  } finally {db.close()}
})

it('旧持久计划的rawTxType=null压过预填expense并保留为方向待补', () => {
  const db=fixture()
  try {
    const p=prepareBatch(db,{sourceType:'csv',sessionId:'synthetic',items:[valid]})
    const row=db.prepare('SELECT payload FROM pending_clarifications WHERE id=?').get(p.gateId) as {payload:string}
    const payload=JSON.parse(row.payload)
    payload.plan.items[0].txType='expense'
    payload.plan.items[0].rawTxType=null
    db.prepare('UPDATE pending_clarifications SET payload=? WHERE id=?').run(JSON.stringify(payload),p.gateId)
    const r=executeBatch(db,p.gateId)!
    expect(r.completed).toHaveLength(0)
    expect(db.prepare('SELECT COUNT(*) n FROM transactions').get()).toEqual({n:0})
    const gate=db.prepare("SELECT id FROM pending_clarifications WHERE field='batch_item' AND status='open'").get() as {id:number}
    expect(describeImportException(db,gate.id)!.missingFields).toContain('txType')
  } finally {db.close()}
})

it('账单方案无方向列时不猜支出，同行其余明确类型仍执行且计数相加等于来源行数', () => {
  const db=fixture()
  try {
    const table=stageBill(db,{sourceType:'csv',cells:[['时间','金额','账户','商户'],['2026-09-30 12:34:56','12.00','银行卡','合成缺方向'],['2026-09-30 12:35:56','8.00','银行卡','合成正常收入']]})
    const p=applyBillPlan(db,{table_id:table.id,columns:{amount:'金额',time:'时间',account:'账户',merchant:'商户'},account_column_values:[{contains:'银行卡',account_name:'银行卡'}],row_overrides:[{rows:[2],type:'income'}]},{sessionId:'synthetic'})
    expect(p.newCount).toBe(1)
    expect(p.reviewCount).toBe(1)
    expect(p.rowsConsidered).toBe(p.newCount+p.duplicateCount+p.reviewCount+p.skippedCount)
    const r=executeBatch(db,p.gateId!)!
    expect(r.completed).toHaveLength(1)
    expect(db.prepare('SELECT type,merchant FROM transactions').get()).toEqual({type:'income',merchant:'合成正常收入'})
    const gate=db.prepare("SELECT id FROM pending_clarifications WHERE field='batch_item' AND status='open'").get() as {id:number}
    expect(describeImportException(db,gate.id)!.missingFields).toContain('txType')
  } finally {db.close()}
})

it('commit_batch真实工具将缺少的方向日期账户完整透传为同一原行异常', async () => {
  const db=fixture()
  try {
    const tool=createM3Tools({db,getTurnContext:()=>({sessionId:'synthetic',sourceMessageId:'synthetic',attachments:['synthetic.png']}) as never}).find(t=>t.name==='commit_batch')!
    const result=await tool.execute!('synthetic-call',{source_type:'csv',channel:'synthetic',items:[{amount_cents:1400,merchant:'合成工具缺项',source_text:'合成原文',reliable_id:'synthetic-tool-id'}]},undefined,undefined,{} as never) as any
    const gateId=result.details.card.gateId
    const executed=executeBatch(db,gateId)!
    expect(executed.completed).toHaveLength(0)
    expect(executed.unparsedKept+executed.unmatchedAccounts).toBe(1)
    const gate=db.prepare("SELECT id FROM pending_clarifications WHERE field='batch_item' AND status='open'").get() as {id:number}
    const exception=describeImportException(db,gate.id)!
    expect(exception.missingFields).toEqual(expect.arrayContaining(['txType','occurredAt','accountId']))
    expect(exception.source.sourceText).toBe('合成原文')
    expect(JSON.parse((db.prepare('SELECT payload FROM pending_clarifications WHERE id=?').get(gate.id) as {payload:string}).payload).attachments).toEqual(['synthetic.png'])
  } finally {db.close()}
})
