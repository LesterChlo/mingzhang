import {expect,it,vi} from 'vitest'
import {renderToStaticMarkup} from 'react-dom/server'
import React from 'react'
vi.stubGlobal('React',React)
const {value}=vi.hoisted(()=>({value:{gateCards:[],details:{},busy:null,categories:[{id:8,name:'其他',kind:'income'}],runExec:vi.fn(),runAnswer:vi.fn()}}))
vi.mock('../src/renderer/src/shell/inboxStore',()=>({useInbox:()=>value}))
import {QueueCard} from '../src/renderer/src/views/QueueCard'
import type {PendingItemDTO} from '../src/shared/types'
const item={gateId:10,field:'batch_item',question:'合成金额缺失',txId:null,createdAt:'2026-10-08T10:00:00+08:00',groupKey:'synthetic',groupLabel:'合成',importException:{gateId:10,version:'frozen',missingFields:['amountCents'],values:{amountCents:null,txType:'income',occurredAt:'2026-10-08 09:15:00',accountId:2,toAccountId:null,categoryId:null},source:{batchId:'synth',importId:1,tableId:1,rowNo:2,sourceText:'<script>synthetic</script>',merchant:'合成收入',accountName:'银行卡'},reason:'缺金额'}} as PendingItemDTO
it('金额缺失仅对应可填字段，保留方向日期来源原值，不再自由文本补答',()=>{
 const html=renderToStaticMarkup(<QueueCard item={item}/> )
 expect(html).toContain('data-testid="exception-form"');expect(html).toContain('exception-amount');expect(html).toContain('收入')
 expect(html).toContain('2026-10-08 09:15:00');expect(html).toContain('第 2 行');expect(html).toContain('&lt;script&gt;synthetic&lt;/script&gt;')
 expect(html).not.toContain('金额（可带分类）');expect(html).not.toContain('<script>synthetic</script>')
})
it('转账显示真实双账户选择与原金额，没有缺金额框',()=>{
 const x={...item,field:'transfer_account',importException:{...item.importException!,missingFields:['accountId','toAccountId'],values:{...item.importException!.values,txType:'transfer',amountCents:4000,accountId:null}}} as PendingItemDTO
 const html=renderToStaticMarkup(<QueueCard item={x}/>)
 expect(html).toContain('exception-account');expect(html).toContain('exception-to-account');expect(html).toContain('¥40.00');expect(html).not.toContain('data-testid="exception-amount"')
})
