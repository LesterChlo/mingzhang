import { test, expect, _electron, type ElectronApplication } from '@playwright/test'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { confirmSingleRecord } from './single-record-fixture'

function directories() {
  const data = mkdtempSync(join(tmpdir(), 'mz-account-flow-data-'))
  const profile = mkdtempSync(join(tmpdir(), 'mz-account-flow-profile-'))
  writeFileSync(join(data, 'config.json'), JSON.stringify({ version: 2, onboarded: true, mock: true, theme: 'dark', providers: [], activeProviderId: null }))
  return { data, profile }
}
function launch(data: string, profile: string) {
  return _electron.launch({ args: ['.', `--user-data-dir=${profile}`], env: { ...process.env, MZ_DATA_DIR: data } as Record<string, string> })
}

test('账户真实流水/筛选/分类改名/默认名重启保全，管理不发模型请求', async () => {
  const { data, profile } = directories()
  let app = await launch(data, profile)
  try {
    let page = await app.firstWindow()
    await page.waitForSelector('.mz-shell')
    await expect.poll(async () => {
      try { await page.evaluate(() => window.mz.sendChat('合成就绪检查', [])); return true } catch { return false }
    }).toBe(true)
    await page.evaluate(() => window.mz.sendChat('午饭 12', []))
    const txId = await confirmSingleRecord(page, '午饭')
    await page.evaluate(() => window.mz.sendChat('收到 30', []))
    const income = await page.evaluate(async () => (await window.mz.listLedger({ state: 'needs_review' })).items.find(t => t.type === 'income'))
    expect(income).toBeTruthy()
    await page.evaluate(id => window.mz.confirmRecord(id, '红包'), income!.id)
    await page.evaluate(() => window.mz.sendChat('晚饭 7', [])) // remains unconfirmed; not in account totals
    const history = await page.evaluate(() => window.mz.loadHistory())
    const before = await page.evaluate(id => window.mz.txDetail(id), txId)
    const month = `${new Date().getFullYear()}-${String(new Date().getMonth() + 1).padStart(2, '0')}`
    await page.getByTestId('nav-accounts').click()
    const cash = page.getByTestId('account-card').filter({ has: page.getByRole('heading', { name: '现金', exact: true }) })
    await expect(cash.getByTestId('account-expense')).toHaveText('¥12.00')
    await expect(cash.getByTestId('account-income')).toHaveText('¥30.00')
    await expect(cash.getByTestId('account-count')).toHaveText('2 笔已确认收支')
    await cash.getByTestId('account-ledger').click()
    await expect(page.getByTestId('ledger-f-account')).toHaveValue('现金')
    await expect(page.getByTestId('ledger-chip-range')).toContainText(month)
    await expect(page.getByTestId('ledger-row')).toHaveCount(2)
    await page.getByTestId('nav-accounts').click()
    await cash.getByRole('button', { name: '修改账户名称 现金' }).click()
    await page.getByLabel('账户名称', { exact: true }).fill('日常现金')
    await page.getByTestId('management-save').click()
    await expect(page.getByRole('heading', { name: '日常现金', exact: true })).toBeVisible()
    await page.getByRole('button', { name: '修改支出分类 餐饮', exact: true }).click()
    await page.getByLabel('分类名称', { exact: true }).fill('日常餐饮')
    await page.getByTestId('management-save').click()
    await expect(page.getByRole('button', { name: '修改支出分类 日常餐饮', exact: true })).toBeVisible()
    const after = await page.evaluate(id => window.mz.txDetail(id), txId)
    expect(after!.tx).toMatchObject({ id: txId, amountCents: before!.tx.amountCents, type: before!.tx.type, state: before!.tx.state, accountName: '日常现金', categoryName: '日常餐饮' })
    expect(after!.audit).toEqual(before!.audit)
    // The old parser reassigns display IDs on every read; compare all durable content, not that unrelated presentation counter.
    expect((await page.evaluate(() => window.mz.loadHistory())).map(({ id, ...content }) => content)).toEqual(history.map(({ id, ...content }) => content))
    await app.close()
    app = await launch(data, profile)
    page = await app.firstWindow()
    await page.getByTestId('nav-accounts').click()
    await expect(page.getByTestId('account-card')).toHaveCount(4)
    await expect(page.getByRole('heading', { name: '现金', exact: true })).toHaveCount(0)
    await expect(page.getByRole('heading', { name: '日常现金', exact: true })).toBeVisible()
    await expect(page.getByRole('button', { name: '修改支出分类 餐饮', exact: true })).toHaveCount(0)
    await expect(page.getByRole('button', { name: '修改支出分类 日常餐饮', exact: true })).toBeVisible()
    expect((await page.evaluate(id => window.mz.txDetail(id), txId))!.tx).toEqual(after!.tx)
  } finally { await app.close() }
})

async function failSummary(app: ElectronApplication, failed: boolean): Promise<void> {
  await app.evaluate(({ ipcMain }, flag) => {
    const state = globalThis as unknown as { accountSummaryOriginal?: (event: unknown, month?: string) => unknown; accountSummaryFail: boolean; accountSummaryCalls: number }
    if (!state.accountSummaryOriginal) {
      state.accountSummaryOriginal = (ipcMain as unknown as { _invokeHandlers: Map<string, (event: unknown, month?: string) => unknown> })._invokeHandlers.get('mz:getAccountSummary')!
      state.accountSummaryCalls = 0
      ipcMain.removeHandler('mz:getAccountSummary')
      ipcMain.handle('mz:getAccountSummary', (event, month?: string) => {
        state.accountSummaryCalls++
        if (state.accountSummaryFail) throw new Error('合成读取故障')
        return state.accountSummaryOriginal!(event, month)
      })
    }
    state.accountSummaryFail = flag
  }, failed)
}

test('账户查询真故障/重试恢复、长列表真实滚轮与键盘，不让整页滚动', async () => {
  const { data, profile } = directories()
  const app = await launch(data, profile)
  try {
    const page = await app.firstWindow()
    await page.waitForSelector('.mz-shell')
    await failSummary(app, true)
    await page.getByTestId('nav-accounts').click()
    await expect(page.getByTestId('accounts-error')).toContainText('合成读取故障')
    const calls = await app.evaluate(() => (globalThis as unknown as { accountSummaryCalls: number }).accountSummaryCalls)
    await page.getByTestId('accounts-retry').click()
    await expect.poll(() => app.evaluate(() => (globalThis as unknown as { accountSummaryCalls: number }).accountSummaryCalls)).toBeGreaterThan(calls)
    await expect(page.getByTestId('accounts-error')).toContainText('合成读取故障')
    await failSummary(app, false)
    await page.getByTestId('accounts-retry').click()
    await expect(page.getByTestId('account-card')).toHaveCount(4)
    await page.evaluate(async () => {
      for (let i = 0; i < 20; i++) await window.mz.createAccount({ name: `合成长列表${String(i).padStart(2, '0')}`, type: 'bank' })
    })
    await page.getByTestId('nav-ledger').click()
    await page.getByTestId('nav-accounts').click()
    await expect(page.getByTestId('account-card')).toHaveCount(24)
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setContentSize(1200, 600))
    const scroll = page.getByTestId('accounts-scroll')
    const box = await scroll.boundingBox()
    await page.mouse.move(box!.x + box!.width / 2, box!.y + box!.height / 2)
    await page.mouse.wheel(0, 10000)
    await expect.poll(() => scroll.evaluate(el => el.scrollTop)).toBeGreaterThan(0)
    const target = page.getByRole('button', { name: '修改收入分类 其他', exact: true })
    await expect.poll(async () => (await target.boundingBox())!.y + (await target.boundingBox())!.height).toBeLessThanOrEqual(box!.y + box!.height + 1)
    const r = await target.boundingBox()
    await page.mouse.click(r!.x + r!.width / 2, r!.y + r!.height / 2)
    await expect(page.getByLabel('分类名称', { exact: true })).toBeFocused()
    await page.getByLabel('分类名称', { exact: true }).fill('其他收入')
    await page.getByLabel('分类名称', { exact: true }).press('Enter')
    await expect(page.getByTestId('management-notice')).toContainText('已保存名称')
    const geometry = await page.evaluate(() => ({ pageOverflow: document.scrollingElement!.scrollHeight - innerHeight, horizontal: document.documentElement.scrollWidth - innerWidth }))
    expect(geometry).toEqual({ pageOverflow: 0, horizontal: 0 })
    await page.getByTestId('theme-toggle').click()
    await expect(page.getByRole('button', { name: '修改收入分类 其他收入', exact: true })).toBeVisible()
  } finally { await app.close() }
})
