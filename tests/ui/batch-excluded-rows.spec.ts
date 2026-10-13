import { test, expect, _electron } from '@playwright/test'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

test('排除行：真实账单→方案→确认后全部明细可展开，查询不改账，重启不丢', async () => {
  const data = mkdtempSync(join(tmpdir(), 'mz-excluded-ui-'))
  const profile = mkdtempSync(join(tmpdir(), 'mz-excluded-udd-'))
  writeFileSync(join(data, 'config.json'), JSON.stringify({ version: 2, onboarded: true, mock: true, theme: 'dark', providers: [], activeProviderId: null }))
  const launch = () => _electron.launch({ args: ['.', `--user-data-dir=${profile}`], env: { ...process.env, MZ_DATA_DIR: data } as Record<string, string> })
  let app = await launch()
  try {
    let page = await app.firstWindow()
    await page.waitForSelector('.mz-shell')
    await expect.poll(() => page.evaluate(() => window.mz.getState().then(s => s.mock))).toBe(true)
    await expect.poll(async () => {
      try { await page.evaluate(() => window.mz.sendChat('合成就绪检查', [])); return true } catch { return false }
    }).toBe(true)
    const cells = [['交易时间', '交易对方', '金额', '收/支'], ['2026-06-01 09:00:00', '合成餐饮', '12.34', '支出'], ...Array.from({ length: 12 }, (_, i) => ['2026-06-02 10:00:00', `合成排除${i + 1}`, `${i + 1}.25`, '不计收支'])]
    await page.evaluate(async cells => {
      const table = await window.mz.stageBill({ sourceType: 'csv', fileName: 'synthetic.csv', cells })
      await window.mz.sendChat(`核对合成材料 table_id=${table.id}\n列名：${table.header.join(' | ')}`, [])
    }, cells)
    const gates = await page.evaluate(() => window.mz.pendingGateCards())
    const gate = gates.find(g => g.field === 'batch_confirm')!
    expect(gate).toBeTruthy()
    await page.evaluate(id => window.mz.confirmGate(id), gate.gateId)
    await expect(page.getByTestId('br-excluded')).toContainText('12 不计收支')
    const before = await page.evaluate(() => window.mz.listLedger({ limit: 100 }))
    await page.getByTestId('br-excluded-toggle').click()
    await expect(page.getByTestId('br-excluded-row')).toHaveCount(12)
    await expect(page.getByTestId('br-excluded-row').first()).toContainText('合成排除1')
    const list = page.getByTestId('br-excluded-list')
    const box = await list.boundingBox()
    expect(box).not.toBeNull()
    await page.mouse.move(box!.x + box!.width / 2, box!.y + box!.height / 2)
    await page.mouse.wheel(0, 10000)
    await expect.poll(() => list.evaluate(el => el.scrollTop)).toBeGreaterThan(0)
    const source = page.getByTestId('br-excluded-row').last().locator('summary')
    await expect.poll(async () => {
      const target = await source.boundingBox()
      return target ? target.y + target.height : Infinity
    }).toBeLessThanOrEqual(box!.y + box!.height + 1)
    const lastBox = await source.boundingBox()
    await page.mouse.click(lastBox!.x + 20, lastBox!.y + lastBox!.height / 2)
    await expect(page.getByTestId('br-excluded-row').last().locator('details')).toHaveAttribute('open', '')
    expect(await page.evaluate(() => window.mz.listLedger({ limit: 100 }))).toEqual(before)
    await app.close()
    app = await launch()
    page = await app.firstWindow()
    await expect(page.getByTestId('br-excluded')).toContainText('12 不计收支')
    await page.getByTestId('br-excluded-toggle').click()
    await expect(page.getByTestId('br-excluded-row')).toHaveCount(12)
    expect(await page.evaluate(() => window.mz.listLedger({ limit: 100 }))).toEqual(before)
    await page.getByTestId('theme-toggle').click()
    await expect(page.getByTestId('br-excluded-row').first()).toContainText('合成排除1')
  } finally { await app.close() }
})
