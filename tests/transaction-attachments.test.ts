// Parent frozen acceptance for issue30: app-scoped synthetic files and ledger only.
import { afterEach, expect, it } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, existsSync, renameSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import { openSchemaDb } from './helpers'
import { seed } from '../src/main/db/seed'
import { createTransaction, createImport } from '../src/main/domain/ledger'
import * as attachments from '../src/main/domain/transaction-attachments'

// Genuine small PNG, not arbitrary text labelled as an image. Decoder seam below is only a domain test control.
const png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGNoCtD9DwAEVgH/dFWU5AAAAABJRU5ErkJggg==','base64')
const png2=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGNwq9jyHwAE7AJy5WV9CAAAAABJRU5ErkJggg==','base64')
const sha=(bytes:Buffer)=>createHash('sha256').update(bytes).digest('hex')
const open: ReturnType<typeof openSchemaDb>[]=[]
function fixture(){
 const data=mkdtempSync(join(tmpdir(),'mz-attachment-parent-')),dir=join(data,'attachments');mkdirSync(dir)
 const db=openSchemaDb(join(data,'synthetic.db'));seed(db);open.push(db)
 const tx=createTransaction(db,{amountCents:1200,txType:'expense',merchant:'合成附件账目',sourceMessageId:'synthetic-origin'})
 return {db,dir,tx,data,context:{attachmentsDir:dir,validateImage:(bytes:Buffer,_mediaType:string)=>bytes.equals(png)||bytes.equals(png2)}}
}
afterEach(()=>{for(const db of open.splice(0))db.close()})
function state(db:ReturnType<typeof openSchemaDb>){return Object.fromEntries(['transactions','imports','audit_log','pending_clarifications','settings','accounts','categories','rules','sqlite_sequence'].map(t=>[t,db.prepare(`SELECT * FROM ${t} ORDER BY rowid`).all()]))}
function list(f:ReturnType<typeof fixture>){return attachments.getTransactionAttachments(f.db,f.tx,f.dir)}
function add(f:ReturnType<typeof fixture>,files:unknown[],version=list(f).version){return attachments.addTransactionAttachments(f.db,{txId:f.tx,expectedVersion:version,files} as never,f.context)}
function remove(f:ReturnType<typeof fixture>,ref:string,version=list(f).version){return attachments.removeTransactionAttachment(f.db,{txId:f.tx,expectedVersion:version,ref},f.context)}
const file=(name='synthetic-image.png',bytes=png)=>({fileName:name,mediaType:'image/png',dataBase64:bytes.toString('base64')})

it('只读列表与多图添加/逐张移除有版本审计，不改变金额状态、不上传模型',()=>{
 const f=fixture(),before=state(f.db),empty=list(f)
 expect(empty.items).toEqual([]);expect(state(f.db)).toEqual(before)
 const result=add(f,[file('synthetic-one.png'),file('synthetic-two.png',png2)])
 expect(result.items).toHaveLength(2);expect(result.items[0]).toMatchObject({fileName:'synthetic-one.png',mediaType:'image/png',available:true})
 expect(readFileSync(join(f.dir,result.items[1].ref))).toEqual(png2)
 expect(readFileSync(join(f.dir,result.items[0].ref))).toEqual(png)
 expect(f.db.prepare('SELECT amount_cents,state FROM transactions WHERE id=?').get(f.tx)).toEqual({amount_cents:1200,state:'raw_input'})
 const audit=f.db.prepare("SELECT changed_by,before_value,after_value FROM audit_log WHERE entity_type='transaction' AND entity_id=? AND change_type='update' ORDER BY id DESC LIMIT 1").get(f.tx) as {changed_by:string;before_value:string;after_value:string}
 expect(audit.changed_by).toBe('user');expect(JSON.parse(audit.after_value).attachments).toHaveLength(2)
 const once=state(f.db),duplicate=add(f,[file('another-name.png')],result.version)
 expect(duplicate.version).toBe(result.version);expect(state(f.db)).toEqual(once)
 const removed=remove(f,result.items[0].ref);expect(removed.items.map(item=>item.ref)).toEqual([result.items[1].ref])
 expect(existsSync(join(f.dir,result.items[0].ref))).toBe(true)
 const bytes=state(f.db);list(f);expect(state(f.db)).toEqual(bytes)
})

it('两个交易共享旧来源：移除本笔引用不影响另一笔，不删共享原图，旧来源不因空列表复活',()=>{
 const f=fixture();writeFileSync(join(f.dir,'synthetic-shared.png'),png)
 createImport(f.db,{sourceType:'screenshot',sourceMessageId:'synthetic-origin',sourceRef:'synthetic-shared.png'})
 const second=createTransaction(f.db,{amountCents:300,txType:'expense',sourceMessageId:'synthetic-origin'})
 const old=list(f);expect(old.items.map(x=>x.ref)).toEqual(['synthetic-shared.png'])
 remove(f,'synthetic-shared.png',old.version)
 expect(list(f).items).toEqual([])
 expect(attachments.getTransactionAttachments(f.db,second,f.dir).items.map(x=>x.ref)).toEqual(['synthetic-shared.png'])
 expect(readFileSync(join(f.dir,'synthetic-shared.png'))).toEqual(png)
})

it('关闭重开数据库后多附件列表/空覆盖一致，未迁移schema；settings引用随原账本备份范围',()=>{
 const f=fixture(),added=add(f,[file()]),ref=added.items[0].ref,path=join(f.data,'synthetic.db')
 const version=added.version;f.db.close();open.splice(open.indexOf(f.db),1)
 const db=openSchemaDb(path);open.push(db)
 const saved=attachments.getTransactionAttachments(db,f.tx,f.dir)
 expect(saved.version).toBe(version);expect(saved.items.map(x=>x.ref)).toEqual([ref])
 expect(db.pragma('user_version',{simple:true})).toBe(2)
 expect(db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name LIKE '%attachment%'").all()).toEqual([])
})

it('过期版本/任意相对路径/ADS/错误mime与损坏图片拒绝，账本和原文件全部保全',()=>{
 const f=fixture(),first=add(f,[file()]),before=state(f.db),filesBefore=readdirSync(f.dir)
 for(const invalid of [
  {fileName:'bad.png',mediaType:'image/png',dataBase64:'not@@base64'},
  {fileName:'bad.png',mediaType:'image/png',dataBase64:Buffer.from('not-image').toString('base64')},
  {fileName:'bad.svg',mediaType:'image/svg+xml',dataBase64:png.toString('base64')},
  {fileName:'bad.png',mediaType:'image/jpeg',dataBase64:png.toString('base64')},
 ]){expect(()=>add(f,[invalid])).toThrow();expect(state(f.db)).toEqual(before);expect(readdirSync(f.dir)).toEqual(filesBefore)}
 expect(()=>add(f,[file()],first.version+'stale')).toThrow();expect(state(f.db)).toEqual(before)
 for(const ref of ['../outside.png','sub/../outside.png','C:/synthetic.png','original.png:stream','\\\\synthetic\\share.png']){
  expect(()=>remove(f,ref)).toThrow();expect(state(f.db)).toEqual(before)
 }
})

it('符号链接来源不读取外部图，缺失文件诚实不可用、不修写；删账禁止修改引用',()=>{
 const f=fixture(),outside=join(f.data,'outside-synthetic.png');writeFileSync(outside,png)
 const link=join(f.dir,'synthetic-linked.png')
 // NTFS file symlink needs privilege; directory junction is still a real reparse point and cannot be read as an image.
 try {symlinkSync(outside,link,'file')}catch{symlinkSync(f.data,link,'junction')}
 createImport(f.db,{sourceType:'screenshot',sourceMessageId:'synthetic-origin',sourceRef:'synthetic-linked.png'})
 const before=state(f.db),rows=list(f)
 expect(rows.items[0]?.available).toBe(false);expect(state(f.db)).toEqual(before)
 const safe=add(f,[file()]);expect(safe.items.some(x=>x.available)).toBe(true)
 f.db.prepare("UPDATE transactions SET state='deleted' WHERE id=?").run(f.tx)
 const deleted=state(f.db);expect(()=>add(f,[file()])).toThrow();expect(state(f.db)).toEqual(deleted)
})

it('审计故障回滚引用且只清理本次新文件，既有共享来源不变，可同版本重试',()=>{
 const f=fixture();writeFileSync(join(f.dir,'synthetic-retained.png'),png)
 const before=state(f.db),version=list(f).version,filesBefore=readdirSync(f.dir)
 f.db.exec("CREATE TRIGGER synthetic_attachment_audit_fail BEFORE INSERT ON audit_log WHEN NEW.entity_type='transaction' AND NEW.change_type='update' BEGIN SELECT RAISE(ABORT,'SYNTHETIC-ATTACHMENT-AUDIT'); END")
 expect(()=>add(f,[file()],version)).toThrow(/SYNTHETIC-ATTACHMENT-AUDIT/)
 expect(state(f.db)).toEqual(before);expect(readdirSync(f.dir)).toEqual(filesBefore)
 expect(readFileSync(join(f.dir,'synthetic-retained.png'))).toEqual(png)
 f.db.exec('DROP TRIGGER synthetic_attachment_audit_fail')
 expect(add(f,[file()],version).items).toHaveLength(1)
})

it('读取全部合法既有批次来源，不以首张冒充多附件，缺失图保留不可用标记',()=>{
 const f=fixture();writeFileSync(join(f.dir,'synthetic-first.png'),png)
 const importId=createImport(f.db,{sourceType:'screenshot',sourceMessageId:'synthetic-origin',sourceRef:'synthetic-first.png'})
 f.db.prepare("INSERT INTO pending_clarifications (session_id,field,question,payload,status,created_at,updated_at) VALUES ('synthetic','batch_confirm','合成批次',?,'resolved','synthetic','synthetic')").run(JSON.stringify({plan:{batchId:'synthetic-origin',importId,items:[],attachments:['synthetic-first.png','synthetic-second-missing.png']}}))
 const before=state(f.db),result=list(f)
 expect(result.items.map(x=>x.ref)).toEqual(['synthetic-first.png','synthetic-second-missing.png'])
 expect(result.items.map(x=>x.available)).toEqual([true,false]);expect(state(f.db)).toEqual(before)
 expect(sha(readFileSync(join(f.dir,'synthetic-first.png')))).toBe(sha(png))
})
