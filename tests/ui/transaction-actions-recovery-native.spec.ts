// Parent R1 native IPC/window regression: real isolated Electron, no replacement IPC or model.
import {test,expect,_electron,type ElectronApplication,type Page} from '@playwright/test'
import {mkdtempSync,writeFileSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
let app:ElectronApplication,page:Page,data:string,profile:string
const errors:string[]=[]
async function launch(){app=await _electron.launch({executablePath:process.env.MZ_PACKAGE_EXE,args:[...(process.env.MZ_PACKAGE_EXE?[]:['.']),`--user-data-dir=${profile}`],env:{...process.env,MZ_DATA_DIR:data} as Record<string,string>});page=await app.firstWindow();page.on('pageerror',e=>errors.push(String(e)));await page.waitForSelector('.mz-shell')}
async function sql(statement:string,params:unknown[]=[]):Promise<any>{return app.evaluate(({safeStorage},input)=>{const fs=process.getBuiltinModule('fs')!,path=process.getBuiltinModule('path')!,mod=process.getBuiltinModule('module')!;if(!path.basename(input.data).startsWith('mz-actions-ui-'))throw Error('NOT SYNTHETIC');const file=path.join(input.data,'mingzhang.db');if(!fs.existsSync(file))throw Error('MISSING SYNTHETIC DB');const Ctor=mod.createRequire(path.join(process.cwd(),'package.json'))('better-sqlite3-multiple-ciphers'),key=safeStorage.decryptString(fs.readFileSync(path.join(input.data,'secrets/db.key'))),db=new Ctor(file,{fileMustExist:true});try{db.pragma(`key = "x'${key}'"`);db.pragma("cipher='chacha20'");db.pragma('foreign_keys=ON');return input.statement.startsWith('SELECT')?db.prepare(input.statement).all(...input.params):{changes:db.prepare(input.statement).run(...input.params).changes}}finally{db.close()}},{data,statement,params})}
async function open(id=1,state='confirmed'){await page.getByTestId('nav-inbox').click();await page.getByTestId('nav-ledger').click();await page.getByTestId('ledger-f-state').selectOption(state);await page.locator(`[data-testid="ledger-row"][data-id="${id}"]`).click();await expect(page.getByTestId('ledger-actions')).toHaveAttribute('aria-busy','false')}
async function facts(){return {transactions:await sql('SELECT * FROM transactions ORDER BY id'),audits:await sql('SELECT * FROM audit_log ORDER BY id'),pending:await sql('SELECT * FROM pending_clarifications ORDER BY id'),settings:await sql('SELECT * FROM settings ORDER BY key'),sequence:await sql('SELECT * FROM sqlite_sequence ORDER BY name')}}
test.beforeEach(async()=>{errors.length=0;data=mkdtempSync(join(tmpdir(),'mz-actions-ui-data-'));profile=mkdtempSync(join(tmpdir(),'mz-actions-ui-profile-'));writeFileSync(join(data,'config.json'),JSON.stringify({version:2,onboarded:true,mock:false,theme:'light',providers:[],activeProviderId:null}));await launch();for(const [name,state,category] of [['R1合成独立原笔','confirmed',1],['R1合成独立待核对原笔','needs_review',null]])await sql("INSERT INTO transactions(account_id,category_id,amount_cents,type,occurred_at,state,merchant,source_message_id,created_at,updated_at) VALUES(2,?,9764,'expense','2047-12-31T22:43:26-03:30',?,?,?,'2026-01-01','2026-01-02')",[category,state,name,'synthetic-actions-source'])})
test.afterEach(async()=>{await app?.close()})

async function whole(){
  const names=await sql("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
  const entries=[]
  for(const {name} of names)entries.push([name,await sql(`SELECT * FROM "${String(name).replaceAll('"','""')}" ORDER BY rowid`)])
  return Object.fromEntries(entries)
}
const total=async()=>(await sql('SELECT COALESCE(SUM(amount_cents),0) n FROM v_reportable_transactions'))[0].n

test('R1 active child can be restored with the real window after process restart without renewing old group undo',async({},info)=>{
  await open()
  await page.getByTestId('ledger-split-open').click()
  const amounts=page.getByTestId('ledger-actions').getByTestId('split-item-amount')
  await amounts.nth(0).fill('16.41');await amounts.nth(1).fill('81.23')
  await page.getByTestId('ledger-actions').getByTestId('split-preview').click()
  const plan=page.getByTestId('ledger-actions').getByTestId('split-plan')
  await expect(plan).toBeVisible();await plan.getByTestId('split-confirm').click()
  await expect.poll(async()=>(await sql('SELECT state FROM transactions WHERE id=1'))[0].state).toBe('deleted')
  const children=await sql('SELECT * FROM transactions WHERE id>2 ORDER BY id');expect(children).toHaveLength(2)
  expect(children.map((x:any)=>x.amount_cents)).toEqual([1641,8123]);expect(await total()).toBe(9764)
  const original=(await sql('SELECT * FROM transactions WHERE id=1'))[0]
  const oldUndo=(await page.evaluate(()=>window.mz.getTransactionActions(1)))!.undoSplit!
  const id=children[0].id
  expect(await page.evaluate(async id=>window.mz.editTx(id,{op:'delete'}),id)).toMatchObject({status:'ok'})
  await app.close();await launch();await open(id,'deleted')
  await expect(page.getByTestId('ledger-restore')).toBeEnabled();await page.getByTestId('ledger-restore').click()
  await expect.poll(async()=>(await sql('SELECT state FROM transactions WHERE id=?',[id]))[0].state).toBe('confirmed')
  expect((await sql('SELECT * FROM transactions WHERE id=1'))[0]).toEqual(original)
  expect((await sql('SELECT * FROM transactions WHERE id=?',[id]))[0]).toEqual({...children[0],updated_at:(await sql('SELECT updated_at FROM transactions WHERE id=?',[id]))[0].updated_at})
  expect((await sql('SELECT * FROM transactions WHERE id=?',[children[1].id]))[0]).toEqual(children[1]);expect(await total()).toBe(9764)
  expect((await page.evaluate(()=>window.mz.getTransactionActions(1)))!.undoSplit).toMatchObject({canUndo:false,version:oldUndo.version})
  const before=await whole();await expect(page.evaluate(async value=>window.mz.undoTransactionSplit(value),{gateId:oldUndo.gateId,expectedVersion:oldUndo.version})).rejects.toThrow('关联交易、审计或来源附件已变化，不能覆盖后续操作')
  expect(await whole()).toEqual(before)
  await open(id,'confirmed')
  await page.evaluate(async()=>{await document.fonts.ready;await Promise.all(document.getAnimations().filter(a=>a.effect?.getTiming().iterations!==Infinity).map(a=>a.finished.catch(()=>{})))})
  await page.screenshot({path:info.outputPath('split-child-restored-light.png')})
  expect(errors).toEqual([])
})
for(const op of ['set','delete','restore'] as const)test(`R1 native IPC ${op} audit failure rolls back all tables and same retry succeeds`,async()=>{
  if(op==='restore')expect(await page.evaluate(()=>window.mz.editTx(1,{op:'delete'}))).toMatchObject({status:'ok'})
  const before=await whole(),sum=await total()
  await sql("CREATE TRIGGER r1_native_abort BEFORE INSERT ON audit_log WHEN NEW.entity_type='transaction' AND NEW.entity_id=1 BEGIN SELECT RAISE(ABORT,'R1_NATIVE_ATOMIC'); END")
  const change=()=>page.evaluate(async op=>window.mz.editTx(1,op==='set'?{op:'set',fields:{categoryName:'R1原生合成新分类',amountCents:11003,note:'R1原生复合改账'}}:{op}),op)
  expect(await change()).toMatchObject({status:'error',message:expect.stringContaining('R1_NATIVE_ATOMIC')})
  expect(await whole()).toEqual(before);expect(await total()).toBe(sum)
  await sql('DROP TRIGGER r1_native_abort');expect(await change()).toMatchObject({status:'ok'})
  expect((await sql('SELECT state FROM transactions WHERE id=1'))[0].state).toBe(op==='delete'?'deleted':'confirmed')
  if(op==='set'){
    expect((await sql('SELECT amount_cents,note FROM transactions WHERE id=1'))[0]).toEqual({amount_cents:11003,note:'R1原生复合改账'})
    expect(await sql("SELECT * FROM categories WHERE name='R1原生合成新分类'")).toHaveLength(1)
  }
  expect(errors).toEqual([])
})
