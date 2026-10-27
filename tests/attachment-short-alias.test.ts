// Real controlled-folder alias regression. Windows exercises a physical NTFS 8.3 alias;
// other platforms run the identical ordinary-directory positive and real-link negative.
import {it,expect} from 'vitest'
import {mkdtempSync,mkdirSync,writeFileSync,lstatSync,realpathSync,symlinkSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join,resolve} from 'node:path'
import {execFileSync} from 'node:child_process'
import {safeAttachmentRoot,readAttachmentBytes} from '../src/main/attachment-files'
import {openSchemaDb} from './helpers'
import {seed} from '../src/main/db/seed'
import {createTransaction} from '../src/main/domain/ledger'
import {getTransactionAttachments,addTransactionAttachments} from '../src/main/domain/transaction-attachments'
const png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGNoCtD9DwAEVgH/dFWU5AAAAABJRU5ErkJggg==','base64')
function fixture():{root:string;alias:string}{
 const root=mkdtempSync(join(tmpdir(),'mz-attachment-long-folder-alias-'));mkdirSync(join(root,'attachments'))
 if(process.platform!=='win32')return{root,alias:join(root,'attachments')}
 const literal=join(root,'attachments').replaceAll("'","''")
 const script=`$ErrorActionPreference='Stop';[Console]::OutputEncoding=[System.Text.UTF8Encoding]::new($false);$fso=New-Object -ComObject Scripting.FileSystemObject;[Console]::Out.Write($fso.GetFolder('${literal}').ShortPath)`
 const alias=execFileSync('powershell.exe',['-NoProfile','-NonInteractive','-EncodedCommand',Buffer.from(script,'utf16le').toString('base64')],{encoding:'utf8',timeout:15000}).trim()
 // The assertion is not skipped: on Windows this test must genuinely reach an alias.
 expect(resolve(alias).toLowerCase()).not.toBe(resolve(join(root,'attachments')).toLowerCase())
 expect(lstatSync(alias).isSymbolicLink()).toBe(false);expect(realpathSync.native(alias).toLowerCase()).toBe(realpathSync.native(join(root,'attachments')).toLowerCase())
 return{root,alias}
}
it('普通NTFS短名不是链接：受控别名路径可真添加与回读，账户/字节/审计保持',()=>{
 const f=fixture(),canonical=realpathSync.native(f.alias)
 expect(safeAttachmentRoot(f.alias)).toBe(canonical)
 const db=openSchemaDb(':memory:');try{seed(db);const txId=createTransaction(db,{amountCents:123,txType:'expense',sourceMessageId:'synthetic-short-path'}),before=getTransactionAttachments(db,txId,f.alias)
 const next=addTransactionAttachments(db,{txId,expectedVersion:before.version,files:[{fileName:'synthetic.png',mediaType:'image/png',dataBase64:png.toString('base64')}]},{attachmentsDir:f.alias,validateImage:()=>true})
 expect(next.items).toHaveLength(1);expect(next.items[0].available).toBe(true);expect(readAttachmentBytes(f.alias,next.items[0].ref)).toEqual(png);expect(getTransactionAttachments(db,txId,canonical)).toEqual(next)
 expect(db.prepare("SELECT COUNT(*) n FROM audit_log WHERE entity_type='transaction' AND entity_id=? AND change_type='update' AND changed_by='user'").get(txId)).toMatchObject({n:1})
 }finally{db.close()}
})
it('短名放行不削弱真实junction/祖先链接拒绝，不读外部图',()=>{
 const f=fixture(),outside=mkdtempSync(join(tmpdir(),'mz-attachment-alias-outside-'));writeFileSync(join(outside,'outside.png'),png)
 const link=join(f.root,'linked-root');symlinkSync(outside,link,process.platform==='win32'?'junction':'dir')
 expect(()=>safeAttachmentRoot(link)).toThrow();expect(readAttachmentBytes(link,'outside.png')).toBeNull()
 const linkedAncestor=join(f.root,'linked-parent');symlinkSync(outside,linkedAncestor,process.platform==='win32'?'junction':'dir');mkdirSync(join(outside,'nested'));writeFileSync(join(outside,'nested','outside.png'),png)
 expect(()=>safeAttachmentRoot(join(linkedAncestor,'nested'))).toThrow();expect(readAttachmentBytes(join(linkedAncestor,'nested'),'outside.png')).toBeNull()
})
