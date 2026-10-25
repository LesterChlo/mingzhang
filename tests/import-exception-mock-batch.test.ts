// Parent guard for the actual offline fixture server, not a model or live dataset.
import {it,expect} from 'vitest'
import {startMockServer} from '../src/main/mock/server'
import {openSchemaDb} from './helpers'
import {seed} from '../src/main/db/seed'
import {prepareBatch,executeBatch} from '../src/main/domain/batch'
async function sample(text:string){const server=await startMockServer();try{const r=await fetch(`http://127.0.0.1:${server.port}/v1/chat/completions`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({stream:true,messages:[{role:'user',content:text}]})});expect(r.ok).toBe(true);const s=await r.text(),parts=s.split('\n').filter(l=>l.startsWith('data: ')&&!l.includes('[DONE]')).map(l=>JSON.parse(l.slice(6)));const tools=parts.flatMap(p=>p.choices[0].delta.tool_calls??[]);expect(tools.find(t=>t.function?.name)?.function.name).toBe('commit_batch');return JSON.parse(tools.map(t=>t.function?.arguments??'').join(''))}finally{await server.close()}}
for(const [label,text,normal,transfer,unparsed] of [['普通批次','合成账单',2,0,1],['转账批次','合成账单包含零钱通转入',2,1,0]] as const){
 it(`离线${label}的正常示例提供显式日期/账户，仍有意保留原异常行`,async()=>{const args=await sample(text),db=openSchemaDb(':memory:');try{seed(db);const p=prepareBatch(db,{sourceType:args.source_type,sessionId:'synthetic-mock',channel:args.channel,items:args.items});expect(p.plan.newCount).toBe(normal+transfer);expect(p.plan.unparsedCount).toBe(unparsed);const r=executeBatch(db,p.gateId);expect(r?.completed).toHaveLength(normal);expect(r?.transfersSkipped).toHaveLength(transfer);expect(r?.unparsedKept).toBe(unparsed);expect(db.prepare('SELECT COUNT(*) n FROM transactions').get()).toEqual({n:normal})}finally{db.close()}})
}
