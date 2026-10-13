import { test, expect, _electron } from '@playwright/test'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

test('历史和展示状态：重启/新会话/继续旧会话，无旧确认门复活，批次关闭及折叠不丢', async () => {
  const data = mkdtempSync(join(tmpdir(), 'mz-panel-history-ui-'))
  const profile = mkdtempSync(join(tmpdir(), 'mz-panel-history-udd-'))
  writeFileSync(join(data, 'config.json'), JSON.stringify({ version: 2, onboarded: true, mock: true, theme: 'dark', providers: [], activeProviderId: null }))
  const launch = () => _electron.launch({ args: ['.', `--user-data-dir=${profile}`], env: { ...process.env, MZ_DATA_DIR: data } as Record<string, string> })
  let app = await launch()
  try {
    let page = await app.firstWindow()
    await page.getByTestId('panel-toggle').click()
    await expect(page.getByTestId('panel-input')).toBeEnabled()
    const sentence = '合成重复句子锚点'
    for (let i = 0; i < 2; i++) {
      await page.getByTestId('panel-input').fill(sentence)
      await page.getByTestId('panel-send').click()
      await expect(page.getByTestId('panel-input')).toBeEnabled()
      await expect(page.getByTestId('panel-msg-user').filter({ hasText: sentence })).toHaveCount(i + 1)
    }
    await page.evaluate(() => window.mz.sendChat('午饭 12 微信', []))
    await expect(page.getByTestId('panel-tool')).toHaveCount(1)
    const original = await page.evaluate(() => window.mz.getPanelHistory())
    const facts = await page.evaluate(() => window.mz.listLedger({ limit: 100 }))
    await app.close()
    app = await launch()
    page = await app.firstWindow()
    await page.getByTestId('panel-toggle').click()
    await expect(page.getByTestId('panel-msg-user').filter({ hasText: sentence })).toHaveCount(2)
    await expect(page.getByTestId('panel-tool')).toHaveCount(1)
    expect((await page.evaluate(() => window.mz.getPanelHistory())).messages).toEqual(original.messages)
    expect(await page.evaluate(() => window.mz.listLedger({ limit: 100 }))).toEqual(facts)
    expect(await page.evaluate(() => window.mz.newConversation())).toBe(true)
    await expect(page.getByTestId('panel-msg-user')).toHaveCount(0)
    const archives = await page.evaluate(() => window.mz.listSessions())
    const old = archives.find(s => s.id === original.sessionId)!
    expect(old).toBeTruthy()
    await page.evaluate(path => window.mz.continueSession(path), old.path)
    await expect(page.getByTestId('panel-msg-user').filter({ hasText: sentence })).toHaveCount(2)
    expect(await page.evaluate(() => window.mz.listLedger({ limit: 100 }))).toEqual(facts)
    await page.evaluate(() => window.mz.sendChat('批次', []))
    const pending = await page.evaluate(() => window.mz.pendingGateCards())
    const gate = pending.find(g => g.field === 'batch_confirm')!
    expect(gate).toBeTruthy()
    await page.evaluate(id => window.mz.confirmGate(id), gate.gateId)
    await expect(page.getByTestId('batch-result-bar')).toBeVisible()
    await page.getByTestId('br-excluded-toggle').click()
    await expect(page.getByTestId('br-excluded-toggle')).toHaveAttribute('aria-expanded', 'true')
    await expect.poll(() => page.evaluate(id => window.mz.getBatchPresentation(id), gate.gateId)).toMatchObject({ excludedOpen: true })
    await app.close()
    app = await launch()
    page = await app.firstWindow()
    await expect(page.getByTestId('br-excluded-toggle')).toHaveAttribute('aria-expanded', 'true')
    await page.getByTestId('br-dismiss').click()
    await expect(page.getByTestId('batch-result-bar')).toHaveCount(0)
    await expect.poll(() => page.evaluate(id => window.mz.getBatchPresentation(id), gate.gateId)).toMatchObject({ dismissed: true })
    await app.close()
    app = await launch()
    page = await app.firstWindow()
    await page.waitForSelector('.mz-shell')
    await expect.poll(() => page.evaluate(() => window.mz.getBatchResult().then(s => s?.gateId))).toBe(gate.gateId)
    await expect(page.getByTestId('batch-result-bar')).toHaveCount(0)
    const closed = await page.evaluate(() => window.mz.pendingGateCards())
    expect(closed.some(g => g.gateId === gate.gateId)).toBe(false)
  } finally { await app.close() }
})
