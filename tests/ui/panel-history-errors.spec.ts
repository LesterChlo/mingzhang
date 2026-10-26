import { test, expect, type ElectronApplication } from '@playwright/test'
import { readdirSync, renameSync } from 'node:fs'
import { join } from 'node:path'
import { historyDirs, launchHistory } from './history-state-fixture'

test('存在的会话真I/O错误可见并重试，不把坏路径吞成空历史', async () => {
  const d = historyDirs()
  const { app, page } = await launchHistory(d.data, d.profile)
  let moved = ''
  try {
    await page.getByTestId('panel-toggle').click()
    await page.evaluate(() => window.mz.sendChat('合成不可读历史锚点', []))
    const snapshot = await page.evaluate(() => window.mz.getPanelHistory())
    const file = readdirSync(join(d.data, 'sessions')).find(name => name.endsWith('.jsonl') && name.includes(snapshot.sessionId!))!
    expect(file).toBeTruthy()
    const session = { path: join(d.data, 'sessions', file) }
    moved = `${session.path}.synthetic-preserved`
    renameSync(session.path, moved)
    // Rename the synthetic attachments directory to canonical JSONL: a real EISDIR read, not a window.mz stub.
    renameSync(join(d.data, 'attachments'), session.path)
    await page.evaluate(() => (window as unknown as { __mzPanel: { reloadHistory(): Promise<void> } }).__mzPanel.reloadHistory())
    await expect(page.getByTestId('panel-history-error')).toContainText('历史读取失败')
    await expect(page.getByTestId('panel-history-error')).not.toContainText('mz:getPanelHistory')
    await expect(page.getByTestId('panel-msg-user')).toContainText('合成不可读历史锚点')
    renameSync(session.path, join(d.data, 'attachments'))
    renameSync(moved, session.path); moved = ''
    await page.getByTestId('panel-history-retry').click()
    await expect(page.getByTestId('panel-history-error')).toHaveCount(0)
    await expect(page.getByTestId('panel-msg-user')).toHaveCount(1)
    await expect(page.getByTestId('panel-input')).toBeEnabled()
  } finally {
    if (moved) {
      const original = moved.replace(/\.synthetic-preserved$/, '')
      renameSync(original, join(d.data, 'attachments'))
      renameSync(moved, original)
    }
    await app.close()
  }
})

test('面板失败invoke先返回/真实error后到：同一发送身份仍只有一个回执', async () => {
  const d = historyDirs({ url: 'http://127.0.0.1:1/v1' })
  const { app, page } = await launchHistory(d.data, d.profile)
  try {
    await page.getByTestId('panel-toggle').click()
    await expect(page.getByTestId('panel-input')).toBeEnabled()
    await app.evaluate(({ BrowserWindow }) => {
      const win = BrowserWindow.getAllWindows()[0]
      const send = win.webContents.send.bind(win.webContents)
      const g = globalThis as unknown as { releaseHistoryError?: () => void }
      win.webContents.send = (channel, ...args) => {
        if (channel === 'mz:chat-event' && args[0]?.type === 'error') { g.releaseHistoryError = () => send(channel, ...args); return }
        send(channel, ...args)
      }
    })
    await page.getByTestId('panel-input').fill('合成晚到错误事件')
    await page.getByTestId('panel-send').click()
    await expect(page.getByTestId('panel-local-error')).toHaveCount(1)
    await expect(page.getByTestId('panel-input')).toBeEnabled()
    await app.evaluate(() => (globalThis as unknown as { releaseHistoryError?: () => void }).releaseHistoryError?.())
    await expect(page.getByTestId('panel-local-error')).toHaveCount(1)
    await expect(page.getByTestId('panel-local-error')).toContainText('API key')
    await expect(page.getByTestId('panel-msg-user')).toHaveCount(1)
    await expect(page.getByTestId('panel-msg-assistant')).toHaveCount(0)
  } finally { await app.close() }
})

async function stateFailure(app: ElectronApplication, failing: boolean) {
  await app.evaluate(({ ipcMain }, flag) => {
    const g = globalThis as unknown as { batchStateOriginal?: (...args: unknown[]) => unknown; batchStateFail: boolean }
    if (!g.batchStateOriginal) {
      g.batchStateOriginal = (ipcMain as unknown as { _invokeHandlers: Map<string, (...args: unknown[]) => unknown> })._invokeHandlers.get('mz:setBatchPresentation')!
      ipcMain.removeHandler('mz:setBatchPresentation')
      ipcMain.handle('mz:setBatchPresentation', (...args) => {
        if (g.batchStateFail) throw new Error('合成展示写入故障')
        return g.batchStateOriginal!(...args)
      })
    }
    g.batchStateFail = flag
  }, failing)
}

test('批次展示保存真实拒绝：折叠/关闭不假成功，可纠正并保持账本', async () => {
  const d = historyDirs()
  const { app, page } = await launchHistory(d.data, d.profile)
  try {
    await page.evaluate(() => window.mz.sendChat('批次', []))
    const gate = (await page.evaluate(() => window.mz.pendingGateCards())).find(g => g.field === 'batch_confirm')!
    await page.evaluate(id => window.mz.confirmGate(id), gate.gateId)
    await expect(page.getByTestId('br-excluded-toggle')).toBeEnabled()
    const facts = await page.evaluate(() => window.mz.listLedger({ limit: 100 }))
    await stateFailure(app, true)
    await page.getByTestId('br-excluded-toggle').click()
    await expect(page.getByTestId('br-state-error')).toContainText('合成展示写入故障')
    await expect(page.getByTestId('br-excluded-toggle')).toHaveAttribute('aria-expanded', 'false')
    expect(await page.evaluate(id => window.mz.getBatchPresentation(id), gate.gateId)).toMatchObject({ excludedOpen: false })
    await page.getByTestId('br-dismiss').click()
    await expect(page.getByTestId('batch-result-bar')).toBeVisible()
    await expect(page.getByTestId('toast')).toContainText('关闭状态未能保存')
    expect(await page.evaluate(id => window.mz.getBatchPresentation(id), gate.gateId)).toMatchObject({ dismissed: false })
    await stateFailure(app, false)
    await page.getByTestId('br-excluded-toggle').click()
    await expect.poll(() => page.evaluate(id => window.mz.getBatchPresentation(id), gate.gateId)).toMatchObject({ excludedOpen: true })
    await page.getByTestId('br-dismiss').click()
    await expect.poll(() => page.evaluate(id => window.mz.getBatchPresentation(id), gate.gateId)).toMatchObject({ dismissed: true })
    await expect(page.getByTestId('batch-result-bar')).toHaveCount(0)
    expect(await page.evaluate(() => window.mz.listLedger({ limit: 100 }))).toEqual(facts)
  } finally { await app.close() }
})

test('面板真认证失败只留一次诚实发送记录，不重复伪助手回复', async () => {
  const d = historyDirs({ url: 'http://127.0.0.1:1/v1' })
  const { app, page } = await launchHistory(d.data, d.profile)
  try {
    await page.getByTestId('panel-toggle').click()
    await expect(page.getByTestId('panel-input')).toBeEnabled()
    await page.getByTestId('panel-input').fill('合成面板认证失败')
    await page.getByTestId('panel-send').click()
    await expect(page.getByTestId('panel-input')).toBeEnabled()
    await expect(page.getByTestId('panel-msg-user')).toHaveCount(1)
    await expect(page.getByTestId('panel-local-error')).toHaveCount(1)
    await expect(page.getByTestId('panel-local-error')).toContainText('API key')
    await expect(page.getByTestId('panel-msg-assistant')).toHaveCount(0)
    const saved = await page.evaluate(() => window.mz.getPanelHistory())
    expect(saved.messages.filter(m => m.role === 'user')).toHaveLength(1)
    await page.evaluate(() => (window as unknown as { __mzPanel: { reloadHistory(): Promise<void> } }).__mzPanel.reloadHistory())
    await expect(page.getByTestId('panel-local-error')).toHaveCount(1)
    await expect(page.getByTestId('panel-msg-user')).toHaveCount(1)
  } finally { await app.close() }
})
