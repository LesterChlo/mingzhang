// Synthetic real-Electron detail actions; no model, real data or UI substitute.
import {test,expect,_electron,type ElectronApplication,type Page} from '@playwright/test'
import {mkdtempSync,writeFileSync,mkdirSync,readFileSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
let app:ElectronApplication,page:Page,data:string,profile:string
const errors:string[]=[]
const png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGNoCtD9DwAEVgH/dFWU5AAAAABJRU5ErkJggg==','base64')
const png2=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGNwXl3yHwAE+QJiJYUBnAAAAABJRU5ErkJggg==','base64')
async function sql(statement:string,params:unknown[]=[]):Promise<any>{
 return app.evaluate(({safeStorage},input)=>{
  const fs=process.getBuiltinModule('fs')!,path=process.getBuiltinModule('path')!,mod=process.getBuiltinModule('module')!
  if(!path.basename(input.data).startsWith('mz-attachment-ui-'))throw Error('NOT SYNTHETIC')
  const Ctor=mod.createRequire(path.join(process.cwd(),'package.json'))('better-sqlite3-multiple-ciphers'),file=path.join(input.data,'mingzhang.db')
  if(!fs.existsSync(file))throw Error('NO SYNTHETIC DB')
  const key=safeStorage.decryptString(fs.readFileSync(path.join(input.data,'secrets','db.key'))),db=new Ctor(file,{fileMustExist:true})
  try{db.pragma(`key = "x'${key}'"`);db.pragma("cipher='chacha20'");db.pragma('foreign_keys=ON');return input.statement.startsWith('SELECT')?db.prepare(input.statement).all(...input.params):{changes:db.prepare(input.statement).run(...input.params).changes}}finally{db.close()}
 },{data,statement,params})
}
async function launch():Promise<void>{app=await _electron.launch({executablePath:process.env.MZ_PACKAGE_EXE,args:[...(process.env.MZ_PACKAGE_EXE?[]:['.']),`--user-data-dir=${profile}`],env:{...process.env,MZ_DATA_DIR:data} as Record<string,string>});page=await app.firstWindow();page.on('pageerror',e=>errors.push(String(e)));await page.waitForSelector('.mz-shell')}
async function open(id:number):Promise<void>{await page.getByTestId('nav-inbox').click();await page.getByTestId('nav-ledger').click();await page.locator(`[data-testid="ledger-row"][data-id="${id}"]`).click();await expect(page.getByTestId('ledger-attachments')).toBeVisible();await expect(page.getByTestId('ledger-attachments')).toHaveAttribute('aria-busy','false')}
async function upload(files:{name:string;mimeType:string;buffer:Buffer}[]):Promise<void>{await page.getByTestId('ledger-attachment-input').setInputFiles(files);await expect(page.getByTestId('ledger-attachments')).toHaveAttribute('aria-busy','false')}
const list=(id=1)=>page.evaluate(id=>window.mz.listTransactionAttachments(id),id)
test.beforeAll(async()=>{
 data=mkdtempSync(join(tmpdir(),'mz-attachment-ui-data-'));profile=mkdtempSync(join(tmpdir(),'mz-attachment-ui-profile-'));writeFileSync(join(data,'config.json'),JSON.stringify({version:2,onboarded:true,mock:false,theme:'light',providers:[],activeProviderId:null}));await launch()
 const date=new Date().toISOString().slice(0,10)
 for(const name of ['合成多附件交易','合成共享原图交易'])await sql("INSERT INTO transactions(account_id,category_id,amount_cents,type,occurred_at,state,merchant,source_message_id,created_at,updated_at) VALUES(2,1,1200,'expense',?,'confirmed',?,?,'2026-10-08','2026-10-08')",[date,name,'synthetic-shared'])
 await open(1)
})
test.afterAll(async()=>{await app?.close()})
test('两张不同图片全部真实添加，可回读文件和审计，账务金额/分类不变且不发模型',async()=>{
 const before=await page.evaluate(()=>window.mz.listLedger({limit:100})),history=await page.evaluate(()=>window.mz.loadHistory())
 await upload([{name:'合成票据一.png',mimeType:'image/png',buffer:png},{name:'合成票据二.png',mimeType:'image/png',buffer:png2}]);await expect(page.getByTestId('ledger-attachment-item')).toHaveCount(2)
 const next=await list();expect(next.items).toHaveLength(2);expect(readFileSync(join(data,'attachments',next.items[0].ref))).toEqual(png);expect(readFileSync(join(data,'attachments',next.items[1].ref))).toEqual(png2)
 const after=await page.evaluate(()=>window.mz.listLedger({limit:100}));expect(after.agg).toEqual(before.agg);expect(after.items.map(({attachmentRef,...r})=>r)).toEqual(before.items.map(({attachmentRef,...r})=>r));expect(await page.evaluate(()=>window.mz.loadHistory())).toEqual(history)
 expect((await sql("SELECT changed_by FROM audit_log WHERE entity_id=1 AND change_type='update'"))[0].changed_by).toBe('user')
})
test('原图弹层真实查看可Esc关闭，重复内容诚实no-op不增文件审计',async()=>{
 const before=await list(),audits=await sql('SELECT * FROM audit_log')
 await page.getByTestId('ledger-attachment-preview').first().click();await expect(page.getByTestId('ledger-attachment-dialog')).toBeVisible();await page.keyboard.press('Escape');await expect(page.getByTestId('ledger-attachment-dialog')).toHaveCount(0)
 await upload([{name:'同内容不同名.png',mimeType:'image/png',buffer:png}]);await expect(page.getByTestId('ledger-attachment-notice')).toContainText('未重复添加');expect(await list()).toEqual(before);expect(await sql('SELECT * FROM audit_log')).toEqual(audits)
})
test('整组含破损图片时全部拒绝，真实审计失败保全目录和账本后能重试',async()=>{
 const before=await list(),audits=await sql('SELECT * FROM audit_log')
 await upload([{name:'valid.png',mimeType:'image/png',buffer:png},{name:'bad.png',mimeType:'image/png',buffer:Buffer.from('NOT-AN-IMAGE')}]);await expect(page.getByTestId('ledger-attachment-error')).toContainText('损坏');expect(await list()).toEqual(before);expect(await sql('SELECT * FROM audit_log')).toEqual(audits)
 await sql("CREATE TRIGGER synthetic_attachment_audit BEFORE INSERT ON audit_log BEGIN SELECT RAISE(ABORT,'合成附件审计失败'); END")
 await page.getByTestId('ledger-attachment-remove').first().click();await expect(page.getByTestId('ledger-attachment-error')).toContainText('合成附件审计失败');expect(await list()).toEqual(before)
 await sql('DROP TRIGGER synthetic_attachment_audit');await page.getByTestId('ledger-attachment-error').getByRole('button',{name:'刷新附件'}).click();await expect(page.getByTestId('ledger-attachment-error')).toHaveCount(0)
})
test('过期意图真实IPC拒绝零写，显式刷新后再操作，不自动重放移除',async()=>{
 const before=await list();await sql("UPDATE transactions SET note='合成并发变更' WHERE id=1")
 await page.getByTestId('ledger-attachment-remove').first().click();await expect(page.getByTestId('ledger-attachment-error')).toContainText('过期');expect((await list()).items).toEqual(before.items)
 await page.getByTestId('ledger-attachment-error').getByRole('button',{name:'刷新附件'}).click();await expect(page.getByTestId('ledger-attachment-error')).toHaveCount(0)
})
test('移除只断本笔引用、共享另一笔和原图不变，重启后空覆盖不复活',async()=>{
 const shared=(await list()).items[0].ref
 await sql("INSERT INTO imports(source_type,source_ref,source_message_id,status,created_at,updated_at) VALUES('screenshot',?,'synthetic-shared','confirmed','2026-10-08','2026-10-08')",[shared]);await open(1)
 const other=await list(2);expect(other.items.map(r=>r.ref)).toContain(shared)
 while(await page.getByTestId('ledger-attachment-item').count()) {await page.getByTestId('ledger-attachment-remove').first().click();await expect(page.getByTestId('ledger-attachments')).toHaveAttribute('aria-busy','false')}
 expect((await list()).items).toEqual([]);expect((await list(2)).items).toEqual(other.items);expect(readFileSync(join(data,'attachments',shared))).toEqual(png)
 await app.close();await launch();await open(1);expect((await list()).items).toEqual([]);await expect(page.getByTestId('ledger-attach-empty')).toBeVisible();expect((await list(2)).items.map(r=>r.ref)).toContain(shared)
})
test('真实GIF/WebP经WASM解码添加预览，删除状态禁止管理，备份边界明确',async()=>{
 await upload([{name:'合成.gif',mimeType:'image/gif',buffer:Buffer.from('R0lGODdhAgACAIEAAAwiOAAAAAAAAAAAACwAAAAAAgACAAAIBgABCAQQEAA7','base64')},{name:'合成.webp',mimeType:'image/webp',buffer:Buffer.from('UklGRjAAAABXRUJQVlA4ICQAAABQAQCdASoCAAIAAUAmJQBOgC6gAP77LkvF3YjjJ4dVU9ffoAA=','base64')}]);await expect(page.getByTestId('ledger-attachment-item')).toHaveCount(2);expect((await list()).items.map(i=>i.mediaType)).toEqual(['image/gif','image/webp'])
 await page.getByTestId('ledger-attachment-preview').last().click();await expect(page.getByTestId('ledger-attachment-dialog').locator('img')).toBeVisible();await page.keyboard.press('Escape')
 await expect(page.getByTestId('ledger-attachment-backup-note')).toContainText('不含原图')
 await sql("UPDATE transactions SET state='deleted' WHERE id=1");await page.getByTestId('ledger-detail-close').click();await page.getByTestId('nav-inbox').click();await page.getByTestId('nav-ledger').click()
 // Direct API negative still rejects even if deleted rows are hidden by the normal filter.
 const current=await list();const rejected=await page.evaluate(async input=>{try{await window.mz.removeTransactionAttachment(input);return ''}catch(e){return String(e)}},{txId:1,expectedVersion:current.version,ref:current.items[0].ref});expect(rejected).toContain('已删除');expect((await list()).items).toEqual(current.items)
 expect(errors).toEqual([])
})

test('deep/light narrow panel real wheel reaches attachments; deleted controls are disabled',async()=>{
 await sql("UPDATE transactions SET state='confirmed' WHERE id=1")
 for(const theme of ['light','dark']){
  await page.evaluate(t=>window.mz.setTheme(t as 'light'|'dark'),theme);await page.reload();await page.waitForSelector('.mz-shell');await open(1)
  await app.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows()[0].setContentSize(1100,600))
  const panel=page.getByTestId('ledger-detail'),box=await panel.boundingBox();expect(box).not.toBeNull()
  await page.mouse.move(box!.x+box!.width/2,box!.y+box!.height/2);await page.mouse.wheel(0,400)
  await expect.poll(()=>page.getByTestId('ledger-attachment-add').evaluate(e=>{const r=e.getBoundingClientRect();return r.top>=0&&r.bottom<=innerHeight})).toBe(true)
  await expect.poll(()=>panel.evaluate(e=>e.scrollTop)).toBeGreaterThan(0)
  expect(await page.evaluate(()=>document.documentElement.scrollWidth-innerWidth)).toBeLessThanOrEqual(0)
 }
 await sql("UPDATE transactions SET state='deleted' WHERE id=1")
 await page.getByTestId('ledger-detail-close').click()
 await page.getByTestId('ledger-f-state').selectOption('deleted');await page.locator('[data-testid="ledger-row"][data-id="1"]').click()
 await expect(page.getByTestId('ledger-attachment-add')).toBeDisabled();await expect(page.getByTestId('ledger-attachment-remove').first()).toBeDisabled()
 expect(errors).toEqual([])
})
