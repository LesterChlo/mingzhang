// Parent-owned SPEC-F1 regression: real Electron, synthetic paired data/profile only.
import { test, expect, _electron, type ElectronApplication, type Page } from '@playwright/test'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

let app: ElectronApplication | undefined
let page: Page
let data: string
let txId: number
const errors: string[] = []
const sourceDate = '2036-05-31T18:07:26+05:45'
const targetDate = '2036-06-01T18:07:26+05:45'

async function sql(statement: string, params: unknown[] = []): Promise<any[]> {
  return app!.evaluate(({ safeStorage }, input) => {
    const fs = process.getBuiltinModule('fs')!
    const path = process.getBuiltinModule('path')!
    const mod = process.getBuiltinModule('module')!
    if (!path.basename(input.data).startsWith('mz-date-receipt-')) throw Error('NOT SYNTHETIC')
    const file = path.join(input.data, 'mingzhang.db')
    if (!fs.existsSync(file)) throw Error('MISSING SYNTHETIC DB')
    const Constructor = mod.createRequire(path.join(process.cwd(), 'package.json'))('better-sqlite3-multiple-ciphers')
    const key = safeStorage.decryptString(fs.readFileSync(path.join(input.data, 'secrets/db.key')))
    const db = new Constructor(file, { fileMustExist: true })
    try {
      db.pragma(`key = "x'${key}'"`)
      db.pragma("cipher='chacha20'")
      db.pragma('foreign_keys=ON')
      if (input.statement.startsWith('SELECT')) return db.prepare(input.statement).all(...input.params)
      db.prepare(input.statement).run(...input.params)
      return []
    } finally {
      db.close()
    }
  }, { data, statement, params })
}

async function open(filtered: boolean): Promise<void> {
  await page.getByTestId('nav-ledger').click()
  await page.getByTestId('ledger-f-state').selectOption('confirmed')
  await page.getByTestId('ledger-f-month').selectOption(filtered ? 'custom' : 'all')
  if (filtered) await page.getByTestId('ledger-f-month-custom').fill('2036-05')
  await page.locator(`[data-testid="ledger-row"][data-id="${txId}"]`).click()
  await expect(page.getByTestId('ledger-date-type')).toHaveAttribute('aria-busy', 'false')
  await expect(page.getByTestId('ledger-edit-date')).toHaveValue('2036-05-31')
}

const facts = async () => ({
  transactions: await sql('SELECT * FROM transactions ORDER BY id'),
  audits: await sql('SELECT * FROM audit_log ORDER BY id'),
  pending: await sql('SELECT * FROM pending_clarifications ORDER BY id'),
  sequence: await sql('SELECT * FROM sqlite_sequence ORDER BY name'),
})

test.beforeEach(async () => {
  errors.length = 0
  data = mkdtempSync(join(tmpdir(), 'mz-date-receipt-data-'))
  const profile = mkdtempSync(join(tmpdir(), 'mz-date-receipt-profile-'))
  const theme = test.info().title.includes('dark') ? 'dark' : 'light'
  writeFileSync(join(data, 'config.json'), JSON.stringify({
    version: 2, onboarded: true, mock: false, theme, providers: [], activeProviderId: null,
  }))
  app = await _electron.launch({
    executablePath: process.env.MZ_PACKAGE_EXE,
    args: [...(process.env.MZ_PACKAGE_EXE ? [] : ['.']), `--user-data-dir=${profile}`],
    env: { ...process.env, MZ_DATA_DIR: data } as Record<string, string>,
  })
  page = await app.firstWindow()
  page.on('pageerror', (error) => errors.push(String(error)))
  await page.waitForSelector('.mz-shell')
  const category = (await sql("SELECT id FROM categories WHERE kind='expense' AND name='购物'"))[0].id
  await sql("INSERT INTO transactions(account_id,category_id,amount_cents,type,occurred_at,state,merchant,source_message_id,created_at,updated_at) VALUES(3,?,26317,'expense',?,'confirmed','合成筛选回执','synthetic-filtered-receipt','2020-01-02','2020-01-03')", [category, sourceDate])
  txId = (await sql("SELECT id FROM transactions WHERE source_message_id='synthetic-filtered-receipt'"))[0].id
})

test.afterEach(async () => {
  await app?.close()
  app = undefined
})

test('全部时间跨月保存保留原行详情与原有局部成功回执（正控）', async () => {
  await open(false)
  await page.getByTestId('ledger-edit-date').fill('2036-06-01')
  await page.getByTestId('ledger-save-date-type').click()
  await expect(page.getByTestId('ledger-detail')).toBeVisible()
  await expect(page.getByTestId('ledger-date-type-notice')).toContainText('2036-06')
  expect((await sql('SELECT occurred_at FROM transactions WHERE id=?', [txId]))[0].occurred_at).toBe(targetDate)
  expect(errors).toEqual([])
})

for (const theme of ['light', 'dark']) {
  test(`月份筛选跨月移出后外层成功回执仍可见且账审计准确 ${theme}`, async () => {
    await open(true)
    const before = (await sql('SELECT * FROM transactions WHERE id=?', [txId]))[0]
    const pending = await sql('SELECT * FROM pending_clarifications ORDER BY id')
    await page.getByTestId('ledger-edit-date').fill('2036-06-01')
    await page.getByTestId('ledger-save-date-type').click()
    await expect(page.locator(`[data-testid="ledger-row"][data-id="${txId}"]`)).toHaveCount(0)
    await expect(page.getByTestId('ledger-detail')).toHaveCount(0)
    const toast = page.getByTestId('toast')
    // This assertion is the old production UI's actual RED, not a static-code assertion.
    await expect(toast).toBeVisible({ timeout: 3000 })
    await expect(toast).toContainText('2036-05')
    await expect(toast).toContainText('2036-06')
    expect(await toast.evaluate((element) => element.closest('[data-testid="ledger-detail"]') === null)).toBe(true)
    await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))))
    await expect(toast).toBeVisible()
    await page.screenshot({ path: test.info().outputPath(`filtered-toast-${theme}.png`) })
    const after = (await sql('SELECT * FROM transactions WHERE id=?', [txId]))[0]
    expect(after).toEqual({ ...before, occurred_at: targetDate, updated_at: after.updated_at })
    expect(await sql('SELECT * FROM pending_clarifications ORDER BY id')).toEqual(pending)
    const audits = await sql("SELECT * FROM audit_log WHERE entity_type='transaction' AND entity_id=? AND change_type='update'", [txId])
    expect(audits).toHaveLength(1)
    expect(audits[0].changed_by).toBe('user')
    expect(JSON.parse(audits[0].before_value).occurred_at).toBe(sourceDate)
    expect(JSON.parse(audits[0].after_value).occurred_at).toBe(targetDate)
    expect(await sql("SELECT COALESCE(SUM(amount_cents),0) cents FROM v_reportable_transactions WHERE occurred_at LIKE '2036-05%'")).toEqual([{ cents: 0 }])
    expect(await sql("SELECT SUM(amount_cents) cents FROM v_reportable_transactions WHERE occurred_at LIKE '2036-06%'")).toEqual([{ cents: 26317 }])
    expect(await page.evaluate(() => window.mz.listLedger({ month: '2036-05', state: 'confirmed' }))).toMatchObject({ items: [] })
    expect(errors).toEqual([])
  })
}

test('月份筛选中的过期保存不发成功回执，不重放草稿且所有业务表零写', async () => {
  await open(true)
  await page.getByTestId('ledger-edit-date').fill('2036-06-01')
  await sql("UPDATE transactions SET merchant='合成并发修改' WHERE id=?", [txId])
  const before = await facts()
  await page.getByTestId('ledger-save-date-type').click()
  await expect(page.getByTestId('ledger-date-type-error')).toContainText('交易已变化')
  await expect(page.getByTestId('toast')).toHaveCount(0)
  await expect(page.getByTestId('ledger-edit-date')).toHaveValue('2036-06-01')
  await expect(page.getByTestId('ledger-detail')).toBeVisible()
  expect(await facts()).toEqual(before)
  expect(errors).toEqual([])
})
