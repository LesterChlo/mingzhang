// Issue31 parent-owned UI acceptance. Synthetic paired data/profile, no real records or model.
import { test, expect, _electron, type ElectronApplication, type Page } from '@playwright/test'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
let app: ElectronApplication, page: Page
const errors: string[] = []
test.beforeAll(async () => {
  const data = mkdtempSync(join(tmpdir(), 'mz-aside-data-')), profile = mkdtempSync(join(tmpdir(), 'mz-aside-profile-'))
  writeFileSync(join(data, 'config.json'), JSON.stringify({version:2,onboarded:true,mock:true,theme:'light',providers:[],activeProviderId:null}))
  app = await _electron.launch({executablePath:process.env.MZ_PACKAGE_EXE,args:[...(process.env.MZ_PACKAGE_EXE?[]:['.']),`--user-data-dir=${profile}`],env:{...process.env,MZ_DATA_DIR:data} as Record<string,string>})
  page = await app.firstWindow(); page.on('pageerror', e => errors.push(String(e)))
  await page.waitForSelector('.mz-shell')
})
test.afterAll(async () => { await app?.close() })
async function snapshot() {
  return page.evaluate(async () => ({ledger:await window.mz.listLedger({limit:100}),pending:await window.mz.listPending(),history:await window.mz.loadHistory()}))
}
test('右栏仅速览与轻量安全状态，旧详细卡和记忆占位均不渲染', async () => {
  await expect(page.getByTestId('aside-report')).toHaveCount(1)
  await expect(page.getByTestId('aside-local')).toHaveCount(0)
  await expect(page.getByTestId('aside-memory')).toHaveCount(0)
  await expect(page.getByTestId('aside-security')).toHaveCount(1)
  await expect(page.getByTestId('aside-snapshot-btn')).toHaveCount(0)
  await expect(page.getByTestId('aside-data-settings')).toHaveCount(1)
  await expect(page.getByTestId('aside-backup-settings')).toHaveCount(1)
})
test('两条设置入口落到真实分页且不调用模型/改账，返回后左栏仍默认模型服务', async () => {
  const before = await snapshot()
  for (const [id, tab, heading] of [['aside-data-settings','数据储存','数据与隐私'],['aside-backup-settings','账单与备份','备份']]) {
    await page.getByTestId(id).click()
    await expect(page.getByRole('tab',{name:tab,exact:true})).toHaveAttribute('aria-selected','true')
    await expect(page.getByRole('heading',{name:heading,exact:true})).toBeVisible()
    await expect(page.getByLabel('速记行')).toHaveCount(0)
    await expect(page.getByTestId('capture-error')).toHaveCount(0)
    await page.getByRole('button',{name:'返回收件箱',exact:true}).click()
  }
  expect(await snapshot()).toEqual(before)
  await page.getByTestId('nav-settings').click()
  await expect(page.getByRole('tab',{name:'模型服务',exact:true})).toHaveAttribute('aria-selected','true')
  await page.getByRole('button',{name:'返回收件箱',exact:true}).click()
})
test('快照入口仍在真实备份分页，点击后后端列表确有新增且账目不变', async () => {
  const before = await snapshot(), snaps = await page.evaluate(() => window.mz.listSnapshots())
  await page.getByTestId('aside-backup-settings').click()
  await page.getByRole('button',{name:'立即快照',exact:true}).click()
  await expect.poll(() => page.evaluate(() => window.mz.listSnapshots().then(s => s.length))).toBeGreaterThan(snaps.length)
  expect(await snapshot()).toEqual(before)
  await expect(page.getByRole('button',{name:'导出跨机备份包…'})).toBeVisible()
  await page.getByRole('button',{name:'返回收件箱',exact:true}).click()
})
test('深浅主题/窄窗口轻量入口可达，无整页滚动或错误', async () => {
  for (const theme of ['light','dark']) {
    await page.evaluate(t => window.mz.setTheme(t as 'light'|'dark'), theme)
    await page.reload(); await page.waitForSelector('.mz-shell')
    await expect(page.locator('html')).toHaveAttribute('data-theme',theme)
    await app.evaluate(({BrowserWindow}) => BrowserWindow.getAllWindows()[0].setContentSize(1100,560))
    await expect(page.getByTestId('aside-security')).toBeVisible()
    const geometry = await page.evaluate(() => {
      const box=document.querySelector('[data-testid="inbox-aside"]')!.getBoundingClientRect()
      const links=Array.from(document.querySelectorAll('[data-testid="aside-security"] button')).map(e=>{const r=e.getBoundingClientRect();return{left:r.left,right:r.right,top:r.top,bottom:r.bottom}})
      return {box:{left:box.left,right:box.right},links,overflow:document.documentElement.scrollWidth>innerWidth,pageScroll:document.scrollingElement!.scrollHeight>innerHeight}
    })
    expect(geometry.overflow).toBe(false); expect(geometry.pageScroll).toBe(false)
    for (const link of geometry.links) {expect(link.left).toBeGreaterThanOrEqual(geometry.box.left);expect(link.right).toBeLessThanOrEqual(geometry.box.right+1)}
    await page.getByTestId('aside-data-settings').click()
    await expect(page.getByRole('tab',{name:'数据储存',exact:true})).toHaveAttribute('aria-selected','true')
    await page.getByRole('button',{name:'返回收件箱',exact:true}).click()
  }
  expect(errors).toEqual([])
})
test('待确认与真实失败残留不污染设置，不被设置导航隐式确认或清除', async () => {
  await page.evaluate(async () => {
    await window.mz.setMock(true)
    for(let i=0;i<40;i++) {try {await window.mz.sendChat('账单',[]);return}catch{await new Promise(r=>setTimeout(r,100))}}
    throw new Error('合成引擎未就绪')
  })
  await expect.poll(()=>page.evaluate(()=>window.mz.listPending().then(p=>p.length))).toBeGreaterThan(0)
  await page.evaluate(()=>window.mz.setMock(false))
  await page.getByLabel('速记行').fill('合成缺服务失败')
  await page.getByLabel('速记行').press('Enter')
  await expect(page.getByTestId('capture-error')).toBeVisible()
  const before=await snapshot()
  await page.getByTestId('aside-backup-settings').click()
  await expect(page.getByTestId('inbox-card')).toHaveCount(0)
  await expect(page.getByTestId('capture-error')).toHaveCount(0)
  await expect(page.getByTestId('capture-notice')).toHaveCount(0)
  expect(await snapshot()).toEqual(before)
  await page.getByRole('button',{name:'返回收件箱',exact:true}).click()
  await expect(page.getByTestId('inbox-card')).toHaveCount(before.pending.length)
  await expect(page.getByTestId('capture-error')).toBeVisible()
  expect(errors).toEqual([])
})
