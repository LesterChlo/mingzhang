import { test, expect, _electron, type Page } from '@playwright/test'
import { mkdirSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { confirmSingleRecord } from './single-record-fixture'

async function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'mz-single-ui-'))
  const data = join(dir, 'data'), profile = join(dir, 'profile')
  mkdirSync(data); mkdirSync(profile)
  const env = { ...process.env, MZ_DATA_DIR: data }
  delete env.ELECTRON_RUN_AS_NODE
  const app = await _electron.launch({ args: ['.', `--user-data-dir=${profile}`], env: env as Record<string,string> })
  const page = await app.firstWindow()
  await page.waitForSelector('.mz-shell')
  expect(await app.evaluate(({app}) => app.getPath('userData'))).toBe(profile)
  expect(await page.getByTestId('lock-badge').getAttribute('data-datadir')).toBe(data)
  return {app, page}
}
async function ready(page: Page) {
  await page.evaluate(async () => {
    await window.mz.setMock(true)
    for (let i=0;i<40;i++) {
      try { await window.mz.sendChat('待收尾', []); return } catch { await new Promise(r=>setTimeout(r,250)) }
    }
    throw new Error('离线引擎未就绪')
  })
}

test('单笔新契约：文字产生待确认，补答不能绕过，实点击后正式收支更新且重复确认不写两笔', async () => {
  const {app,page} = await fixture()
  try {
    await ready(page)
    const before = await page.evaluate(() => window.mz.listLedger({limit:100}))
    expect(before.total).toBe(0)
    const cap = page.getByLabel('速记行')
    await cap.fill('星巴克 35'); await cap.press('Enter')
    const card = page.locator('[data-testid="inbox-card"][data-kind="confirm_record"]')
    await expect(card).toHaveCount(1)
    await expect(card).toContainText('¥35.00')
    const waiting = await page.evaluate(() => window.mz.listLedger({limit:100}))
    expect(waiting.total).toBe(1)
    expect(waiting.items[0]).toMatchObject({state:'needs_review', amountCents:3500, categoryName:'咖啡', accountName:'现金',type:'expense'})
    expect(waiting.agg.expenseCents).toBe(0)
    expect(waiting.agg.incomeCents).toBe(0)
    const pend = (await page.evaluate(() => window.mz.listPending())).find(p=>p.txId===waiting.items[0].id)!
    const rejected = await page.evaluate(async p => {
      try { await window.mz.answerPending(p.gateId, '确认 咖啡'); return null } catch (e) {return String(e)}
    }, pend)
    expect(rejected).toContain('确认')
    expect(await page.evaluate(() => window.mz.listLedger({limit:100}))).toEqual(waiting)
    const txId = await confirmSingleRecord(page, '星巴克')
    const after = await page.evaluate(() => window.mz.listLedger({limit:100}))
    expect(after.total).toBe(1)
    expect(after.items[0]).toMatchObject({id:txId,state:'confirmed',amountCents:3500,categoryName:'咖啡',accountName:'现金',type:'expense'})
    expect(after.agg.expenseCents).toBe(3500)
    expect(after.agg.incomeCents).toBe(0)
    await expect(page.getByTestId('inbox-card')).toHaveCount(0)
    // 按钮办结后消失；重试相同生产确认 IPC 必须幂等，而不是再记一笔。
    await page.evaluate(id => window.mz.confirmRecord(id, '咖啡'), txId)
    expect(await page.evaluate(() => window.mz.listLedger({limit:100}))).toEqual(after)
    await page.getByTestId('nav-ledger').click()
    await expect(page.getByTestId('ledger-row')).toHaveCount(1)
    await expect(page.getByTestId('ledger-agg-expense')).toContainText('¥35.00')
    await page.getByTestId('nav-inbox').click()
    await cap.fill('工资 120'); await cap.press('Enter')
    const incomeCard = page.locator('[data-testid="inbox-card"][data-kind="confirm_record"]').filter({hasText:'工资'})
    await expect(incomeCard).toHaveCount(1)
    const incomeWaiting = await page.evaluate(() => window.mz.listLedger({limit:100}))
    expect(incomeWaiting.total).toBe(2)
    expect(incomeWaiting.items.find(t=>t.merchant==='工资')).toMatchObject({state:'needs_review',type:'income',amountCents:12000,accountName:'现金'})
    expect(incomeWaiting.agg.expenseCents).toBe(3500)
    expect(incomeWaiting.agg.incomeCents).toBe(0)
    await incomeCard.getByLabel(/分类 #/).selectOption('其他')
    const incomeId = await confirmSingleRecord(page, '工资')
    const incomeAfter = await page.evaluate(() => window.mz.listLedger({limit:100}))
    expect(incomeAfter.total).toBe(2)
    expect(incomeAfter.items.find(t=>t.id===incomeId)).toMatchObject({state:'confirmed',type:'income',amountCents:12000,accountName:'现金',categoryName:'其他'})
    expect(incomeAfter.agg.expenseCents).toBe(3500)
    expect(incomeAfter.agg.incomeCents).toBe(12000)
    await page.evaluate(id=>window.mz.confirmRecord(id,'其他'),incomeId)
    expect(await page.evaluate(() => window.mz.listLedger({limit:100}))).toEqual(incomeAfter)
    await page.getByTestId('nav-ledger').click()
    await expect(page.getByTestId('ledger-row')).toHaveCount(2)
    await expect(page.getByTestId('ledger-agg-income')).toContainText('¥120.00')
    console.log('SINGLE_CONFIRM_READBACK', JSON.stringify({waiting,after,incomeWaiting,incomeAfter}))
  } finally { await app.close() }
})

test('工具失败详情默认折叠：中性摘要可见、实点展开才见原始错误、不改账', async () => {
  const {app,page} = await fixture()
  try {
    await page.getByTestId('panel-toggle').click()
    const before = await page.evaluate(() => window.mz.listLedger({limit:100}))
    // 只注入生产 IPC 事件来覆盖 renderer 的错误展示，不替换 mz 或请求真模型。
    await app.evaluate(({BrowserWindow}) => {
      const win = BrowserWindow.getAllWindows()[0]
      win.webContents.send('mz:chat-event', {type:'tool-start',payload:{toolName:'record'}})
      win.webContents.send('mz:chat-event', {type:'tool-end',payload:{toolName:'record',isError:true,text:'合成错误详情：amount_cents 校验失败 SYN-ERROR-DETAIL'}})
    })
    const tool = page.locator('[data-testid="panel-tool"][data-status="error"]')
    await expect(tool).toHaveCount(1)
    await expect(tool).toContainText('这次尝试未成功，请以本轮最终结果为准。')
    const details = tool.locator('details')
    expect(await details.evaluate(el => (el as HTMLDetailsElement).open)).toBe(false)
    await expect(details.locator('pre')).not.toBeVisible()
    await details.locator('summary').click()
    expect(await details.evaluate(el => (el as HTMLDetailsElement).open)).toBe(true)
    await expect(details.locator('pre')).toBeVisible()
    await expect(details.locator('pre')).toHaveText('合成错误详情：amount_cents 校验失败 SYN-ERROR-DETAIL')
    expect(await page.evaluate(() => window.mz.listLedger({limit:100}))).toEqual(before)
  } finally { await app.close() }
})
