import {test,expect,_electron as electron} from '@playwright/test'
import {mkdtempSync,mkdirSync,writeFileSync,readFileSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {fileURLToPath} from 'node:url'
const root=fileURLToPath(new URL('../..',import.meta.url))

test('启动失败页的关闭按钮退出，原profile可再次启动且密文不变',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'mz-startup-close-')),data=join(dir,'data'),profile=join(dir,'profile')
 mkdirSync(join(data,'secrets'),{recursive:true});mkdirSync(profile)
 const key=join(data,'secrets/db.key'),original=Buffer.from('SYNTHETIC-BAD-KEY-FOR-CLOSE')
 writeFileSync(key,original)
 const env={...process.env,MZ_DATA_DIR:data};delete env.ELECTRON_RUN_AS_NODE
 const options={executablePath:join(root,'node_modules/electron/dist/electron.exe'),args:[join(root,'out/main/index.js'),`--user-data-dir=${profile}`],env}
 for(let i=0;i<2;i++){
  const app=await electron.launch(options)
  try{
   const p=await app.firstWindow();await expect(p.getByTestId('startup-failure')).toBeVisible()
   expect(await p.evaluate(()=>document.scrollingElement!.scrollHeight <= innerHeight)).toBe(true)
   const closed=app.waitForEvent('close',{timeout:10000})
   await p.getByTestId('startup-close').click()
   await closed
   expect(readFileSync(key)).toEqual(original)
  }finally{await app.close().catch(()=>{})}
 }
})
