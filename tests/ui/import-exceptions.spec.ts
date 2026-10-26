// UI/IPC acceptance uses synthetic exception payloads; parsing/constructors are independently covered by domain tests.
import {test,expect,_electron,type ElectronApplication,type Page} from '@playwright/test'
import {mkdtempSync,writeFileSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
let app:ElectronApplication,page:Page,data:string,profile:string
const errors:string[]=[]
async function sql(statement:string,params:unknown[]=[]):Promise<any>{
 return app.evaluate(async({safeStorage},input)=>{
  const fs=process.getBuiltinModule('fs')!,path=process.getBuiltinModule('path')!,mod=process.getBuiltinModule('module')!
  if(!path.basename(input.data).startsWith('mz-exception-ui-'))throw Error('NOT SYNTHETIC')
  const Ctor=mod.createRequire(path.join(process.cwd(),'package.json'))('better-sqlite3-multiple-ciphers')
  const key=safeStorage.decryptString(fs.readFileSync(path.join(input.data,'secrets','db.key')))
  const file=path.join(input.data,'mingzhang.db');if(!fs.existsSync(file))throw Error('NO SYNTHETIC DATABASE')
  const db=new Ctor(file,{fileMustExist:true})
  try{db.pragma(`key = "x'${key}'"`);db.pragma("cipher='chacha20'");db.pragma('foreign_keys=ON');return input.statement.startsWith('SELECT')?db.prepare(input.statement).all(...input.params):{changes:db.prepare(input.statement).run(...input.params).changes}}
  finally{db.close()}
 },{data,statement,params})
}
async function launch():Promise<void>{
 app=await _electron.launch({executablePath:process.env.MZ_PACKAGE_EXE,args:[...(process.env.MZ_PACKAGE_EXE?[]:['.']),`--user-data-dir=${profile}`],env:{...process.env,MZ_DATA_DIR:data} as Record<string,string>})
 page=await app.firstWindow();page.on('pageerror',e=>errors.push(String(e)));await page.waitForSelector('.mz-shell')
}
async function seedException(name:string,values:Record<string,unknown>):Promise<number>{
 const source='synthetic-'+name
 await sql("INSERT INTO imports (source_type,source_message_id,status,created_at,updated_at) VALUES ('csv',?,'pending','2026-10-08','2026-10-08')",[source])
 const imp=(await sql('SELECT id FROM imports WHERE source_message_id=?',[source]))[0].id
 await sql("INSERT INTO pending_clarifications(session_id,field,question,payload,status,created_at,updated_at) VALUES ('synthetic',?,?,?,'open','2026-10-08','2026-10-08')",[values.txType==='transfer'?'transfer_account':'batch_item',name,JSON.stringify({exceptionVersion:1,batchId:source,importId:imp,merchant:name,sourceText:'合成原行：<原文> 2026-10-08',rowNo:7,amountCents:1250,txType:'income',occurredAt:'2026-10-08 09:15:00',accountName:'银行卡',attachments:[],...values})])
 return (await sql("SELECT id FROM pending_clarifications WHERE json_extract(payload,'$.batchId')=?",[source]))[0].id
}
async function refresh():Promise<void>{await page.reload();await page.waitForSelector('.mz-shell');await expect(page.getByTestId('inbox-loading')).toHaveCount(0)}
const card=(id:number)=>page.locator(`[data-testid="inbox-card"][data-gate="${id}"]`)
test.beforeAll(async()=>{data=mkdtempSync(join(tmpdir(),'mz-exception-ui-data-'));profile=mkdtempSync(join(tmpdir(),'mz-exception-ui-profile-'));writeFileSync(join(data,'config.json'),JSON.stringify({version:2,onboarded:true,mock:false,theme:'light',providers:[],activeProviderId:null}));await launch()})
test.afterAll(async()=>{await app?.close()})
test('收入缺金额只补该字段，原日期账户来源保留，提交经真实IPC只生一笔',async()=>{
 const id=await seedException('合成收入金额缺失',{amountCents:null});await refresh();const c=card(id)
 await expect(c.getByTestId('exception-form')).toBeVisible();await expect(c.getByTestId('exception-date')).toHaveCount(0);await expect(c.getByTestId('exception-account')).toHaveCount(0)
 await expect(c.getByTestId('exception-preserved')).toContainText('收入');await expect(c.getByTestId('exception-preserved')).toContainText('2026-10-08 09:15:00');await expect(c).toContainText('第 7 行')
 await c.getByTestId('exception-amount').fill('15.88');await c.getByTestId('exception-category').selectOption({label:'其他'});await c.getByTestId('exception-submit').click();await expect(c).toHaveCount(0)
 const rows=await page.evaluate(()=>window.mz.listLedger({limit:100}));expect(rows.items).toHaveLength(1);expect(rows.items[0]).toMatchObject({type:'income',amountCents:1588,accountName:'银行卡',occurredAt:'2026-10-08 09:15:00',state:'confirmed'})
 expect((await sql("SELECT changed_by FROM audit_log WHERE change_type='confirm'"))[0].changed_by).toBe('user')
})
test('日期和未知账户独立缺项，不覆盖有效原值或默认今天现金',async()=>{
 const date=await seedException('合成收入日期缺失',{occurredAt:null}),account=await seedException('合成收入账户缺失',{accountName:'原材料未知账户'});await refresh()
 const d=card(date);await expect(d.getByTestId('exception-amount')).toHaveCount(0);await expect(d.getByTestId('exception-date')).toHaveValue('')
 await d.getByTestId('exception-date').fill('2026-10-02');await d.getByTestId('exception-category').selectOption({label:'其他'});await d.getByTestId('exception-submit').click();await expect(d).toHaveCount(0)
 const a=card(account);await expect(a.getByTestId('exception-account')).toBeVisible();await a.getByTestId('exception-account').selectOption({label:'微信'});await a.getByTestId('exception-category').selectOption({label:'其他'});await a.getByTestId('exception-submit').click();await expect(a).toHaveCount(0)
 const rows=await page.evaluate(()=>window.mz.listLedger({limit:100}));expect(rows.items.find(r=>r.merchant==='合成收入日期缺失')).toMatchObject({amountCents:1250,type:'income',occurredAt:'2026-10-02',accountName:'银行卡'});expect(rows.items.find(r=>r.merchant==='合成收入账户缺失')).toMatchObject({amountCents:1250,type:'income',accountName:'微信'})
})
test('转账真实双账户不同才允许补录，只有一笔且收入支出汇总不变',async()=>{
 const id=await seedException('合成原转账',{txType:'transfer',amountCents:6300,accountName:null,toAccountName:null});await refresh();const c=card(id),before=await page.evaluate(()=>window.mz.listLedger({limit:100}))
 await c.getByTestId('exception-account').selectOption({label:'银行卡'});await c.getByTestId('exception-to-account').selectOption({label:'银行卡'});await c.getByTestId('exception-submit').click();await expect(c.getByTestId('exception-error')).toContainText('不能相同');expect(await page.evaluate(()=>window.mz.listLedger({limit:100}))).toEqual(before)
 await c.getByTestId('exception-to-account').selectOption({label:'微信'});await c.getByTestId('exception-submit').click();await expect(c).toHaveCount(0)
 const after=await page.evaluate(()=>window.mz.listLedger({limit:100}));expect(after.total).toBe(before.total+1);expect(after.agg.incomeCents).toBe(before.agg.incomeCents);expect(after.agg.expenseCents).toBe(before.agg.expenseCents);expect(after.items.find(r=>r.type==='transfer')).toMatchObject({amountCents:6300,accountName:'银行卡'});const transfer=after.items.find(r=>r.type==='transfer')!;expect((await page.evaluate(id=>window.mz.txDetail(id),transfer.id))!.tx.toAccountName).toBe('微信')
})
test('旧版本拒绝不写账并刷新，不自动重放旧用户意图；审计故障可原行重试',async()=>{
 const id=await seedException('合成冲突重试',{amountCents:null});await refresh();let c=card(id);await c.getByTestId('exception-amount').fill('23.50');await c.getByTestId('exception-category').selectOption({label:'其他'})
 await sql('UPDATE pending_clarifications SET revision=revision+1 WHERE id=?',[id]);const before=await page.evaluate(()=>window.mz.listLedger({limit:100}));await c.getByTestId('exception-submit').click();await expect(page.getByTestId('toast')).toContainText('版本');expect(await page.evaluate(()=>window.mz.listLedger({limit:100}))).toEqual(before)
 c=card(id);await expect(c.getByTestId('exception-amount')).toHaveValue('');await c.getByTestId('exception-amount').fill('23.50');await c.getByTestId('exception-category').selectOption({label:'其他'})
 await sql("CREATE TRIGGER synthetic_ui_audit BEFORE INSERT ON audit_log WHEN NEW.change_type='confirm' BEGIN SELECT RAISE(ABORT,'合成审计失败'); END")
 await c.getByTestId('exception-submit').click();await expect(page.getByTestId('toast')).toContainText('合成审计失败');expect(await page.evaluate(()=>window.mz.listLedger({limit:100}))).toEqual(before)
 await sql('DROP TRIGGER synthetic_ui_audit');await c.getByTestId('exception-submit').click();await expect(c).toHaveCount(0)
 expect((await page.evaluate(()=>window.mz.listLedger({limit:100}))).items.filter(r=>r.merchant==='合成冲突重试')).toHaveLength(1)
})
test('缺分类只待核对，用户选择分类再明确确认才能收口；关闭重启不重复',async()=>{
 const id=await seedException('合成待分类续办',{amountCents:null});await refresh();const c=card(id);await c.getByTestId('exception-amount').fill('7.00');await c.getByTestId('exception-submit').click();await expect(c).toHaveCount(0)
 let tx=(await page.evaluate(()=>window.mz.listLedger({limit:100}))).items.find(r=>r.merchant==='合成待分类续办')!;expect(tx.state).toBe('needs_review')
 const next=page.locator('[data-testid="inbox-card"][data-kind="confirm_record"]').filter({hasText:'合成待分类续办'});await expect(next).toBeVisible();await next.getByLabel(/分类 #/).selectOption('其他');await next.getByTestId('inbox-confirm').click();await expect(next).toHaveCount(0)
 expect((await sql("SELECT status FROM imports WHERE source_message_id='synthetic-合成待分类续办'"))[0].status).toBe('confirmed')
 const before=await page.evaluate(()=>window.mz.listLedger({limit:100}));await app.close();await launch();expect(await page.evaluate(()=>window.mz.listLedger({limit:100}))).toEqual(before);expect(await page.evaluate(()=>window.mz.listPending())).toEqual([]);expect(errors).toEqual([])
})

test('deep/shallow narrow window scroll reaches original row without page overflow',async()=>{
 const ids:number[]=[]
 for(let i=0;i<14;i++)ids.push(await seedException(`synthetic-scroll-row-${i}`,{amountCents:null,sourceText:'synthetic source wrapping content; '.repeat(20)}))
 await refresh()
 for(const theme of ['light','dark']){
  await page.evaluate(t=>window.mz.setTheme(t as 'light'|'dark'),theme);await page.reload();await page.waitForSelector('.mz-shell')
  await app.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows()[0].setContentSize(1100,600))
  // Existing product's bounded scrolling region is the inbox; queue is its content, not a scroll container.
  const target=card(ids[0]).getByTestId('exception-submit'),area=page.locator('.mz-inbox'),box=await area.boundingBox();expect(box).not.toBeNull()
  await page.mouse.move(box!.x+box!.width/2,box!.y+box!.height/2);await page.mouse.wheel(0,16000)
  await expect.poll(()=>target.evaluate(e=>{const r=e.getBoundingClientRect();return r.top>=0&&r.bottom<=innerHeight})).toBe(true)
  const geometry=await page.evaluate(()=>({page:document.scrollingElement!.scrollHeight-innerHeight,width:document.documentElement.scrollWidth-innerWidth,region:(document.querySelector('.mz-inbox') as HTMLElement).scrollTop}))
  expect(geometry.page).toBeLessThanOrEqual(0);expect(geometry.width).toBeLessThanOrEqual(0);expect(geometry.region).toBeGreaterThan(0)
 }
 expect(errors).toEqual([])
})
