import { test, expect, _electron as electron } from '@playwright/test'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
const root=fileURLToPath(new URL('../..',import.meta.url))

test('启动密钥不可解密时显示安全出口，不覆盖密文', async()=>{
 const dir=mkdtempSync(join(tmpdir(),'mz-startup-ui-'))
 const data=join(dir,'data'), profile=join(dir,'profile')
 mkdirSync(join(data,'secrets'),{recursive:true}); mkdirSync(profile)
 const key=join(data,'secrets','db.key'), original=Buffer.from('SYNTHETIC-INVALID-DEK-CIPHER')
 writeFileSync(key,original)
 const env={...process.env,MZ_DATA_DIR:data}
 delete env.ELECTRON_RUN_AS_NODE
 const app=await electron.launch({executablePath:join(root,'node_modules/electron/dist/electron.exe'),args:[join(root,'out/main/index.js'),`--user-data-dir=${profile}`],env})
 try {
  const page=await app.firstWindow({timeout:10000})
  await expect(page.getByTestId('startup-failure')).toBeVisible()
  await expect(page.getByTestId('startup-failure-message')).toContainText('密钥')
  await expect(page.getByTestId('startup-open-data')).toBeVisible()
  await expect(page.getByTestId('startup-close')).toBeVisible()
  expect(readFileSync(key)).toEqual(original)
  // Close/quit behavior and second-instance lock release are independently
  // exercised by the parent's final real-Electron probe after implementation.
 } finally {await app.close()}
})
