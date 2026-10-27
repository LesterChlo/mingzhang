import { test, expect, _electron, type ElectronApplication, type Page } from '@playwright/test'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const entries = [
  ['aside-data-settings', '数据储存'],
  ['aside-backup-settings', '账单与备份'],
] as const

async function fixture(): Promise<{ app: ElectronApplication; page: Page }> {
  const data = mkdtempSync(join(tmpdir(), 'mz-settings-context-data-'))
  const profile = mkdtempSync(join(tmpdir(), 'mz-settings-context-profile-'))
  writeFileSync(join(data, 'config.json'), JSON.stringify({ version: 2, onboarded: true, mock: false, theme: 'light', providers: [], activeProviderId: null }))
  const env = { ...process.env, MZ_DATA_DIR: data }
  delete env.ELECTRON_RUN_AS_NODE
  const app = await _electron.launch({
    executablePath: process.env.MZ_PACKAGE_EXE,
    args: [...(process.env.MZ_PACKAGE_EXE ? [] : ['.']), `--user-data-dir=${profile}`],
    env: env as Record<string, string>,
  })
  const page = await app.firstWindow()
  await expect(page.getByTestId('inbox-view')).toBeVisible()
  expect(await page.getByTestId('lock-badge').getAttribute('data-datadir')).toBe(data)
  expect(await app.evaluate(({ app }) => app.getPath('userData'))).toBe(profile)
  return { app, page }
}

async function facts(page: Page) {
  return page.evaluate(async () => ({ ledger: await window.mz.listLedger({ limit: 100 }), history: await window.mz.loadHistory() }))
}

async function visitAccountBudget(page: Page) {
  await page.getByTestId('nav-accounts').click()
  await expect(page.getByTestId('accounts-view')).toBeVisible()
  await page.getByTestId('accounts-budget').click()
  await expect(page.getByRole('tab', { name: '账单与备份', exact: true })).toHaveAttribute('aria-selected', 'true')
  await expect(page.getByRole('button', { name: '返回账户', exact: true })).toBeVisible()
}

test('设置来源冷启动正控：收件箱两个右栏入口返回收件箱且不动账或历史', async () => {
  const { app, page } = await fixture()
  try {
    const before = await facts(page)
    for (const [entry, tab] of entries) {
      await page.getByTestId(entry).click()
      await expect(page.getByRole('tab', { name: tab, exact: true })).toHaveAttribute('aria-selected', 'true')
      await expect(page.getByRole('button', { name: '返回账户', exact: true })).toHaveCount(0)
      await page.getByRole('button', { name: '返回收件箱', exact: true }).click()
      await expect(page.getByTestId('inbox-view')).toBeVisible()
    }
    expect(await facts(page)).toEqual(before)
  } finally { await app.close() }
})

test('设置来源侧栏正控：账户来源不污染直接设置，账户预算仍可返回账户', async () => {
  const { app, page } = await fixture()
  try {
    const before = await facts(page)
    await visitAccountBudget(page)
    await page.getByRole('button', { name: '返回账户', exact: true }).click()
    await expect(page.getByTestId('accounts-view')).toBeVisible()
    await page.getByTestId('nav-settings').click()
    await expect(page.getByRole('tab', { name: '模型服务', exact: true })).toHaveAttribute('aria-selected', 'true')
    await page.getByRole('button', { name: '返回收件箱', exact: true }).click()
    await expect(page.getByTestId('inbox-view')).toBeVisible()
    expect(await facts(page)).toEqual(before)
  } finally { await app.close() }
})

test('设置来源热路径回归：账户预算之后从收件箱两个右栏入口进入仍返回收件箱', async () => {
  const { app, page } = await fixture()
  try {
    const before = await facts(page)
    for (const [entry, tab] of entries) {
      await visitAccountBudget(page)
      await page.getByRole('button', { name: '返回账户', exact: true }).click()
      await expect(page.getByTestId('accounts-view')).toBeVisible()
      await page.getByTestId('nav-inbox').click()
      await page.getByTestId(entry).click()
      await expect(page.getByRole('tab', { name: tab, exact: true })).toHaveAttribute('aria-selected', 'true')
      await expect(page.getByRole('button', { name: '返回收件箱', exact: true })).toBeVisible()
      await expect(page.getByRole('button', { name: '返回账户', exact: true })).toHaveCount(0)
      await page.getByRole('button', { name: '返回收件箱', exact: true }).click()
      await expect(page.getByTestId('inbox-view')).toBeVisible()
    }
    expect(await facts(page)).toEqual(before)
  } finally { await app.close() }
})
