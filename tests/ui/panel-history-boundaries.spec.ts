import { test, expect } from '@playwright/test'
import { startFakeProvider } from '../fake-provider'
import { historyDirs, launchHistory, activateHistoryProvider, holdSnapshot, releaseSnapshot, captured, requestReload } from './history-state-fixture'

test('历史快照等待期间：真实新轮被缓冲重放一次，不吞相同文本', async () => {
  const d = historyDirs()
  const { app, page } = await launchHistory(d.data, d.profile)
  try {
    await page.getByTestId('panel-toggle').click()
    await page.evaluate(() => window.mz.sendChat('合成已有历史', []))
    await expect(page.getByTestId('panel-msg-user')).toHaveCount(1)
    await holdSnapshot(app); await requestReload(page)
    await expect.poll(() => captured(app)).toMatchObject({ busy: false })
    const original = (await captured(app))!
    await page.evaluate(() => window.mz.sendChat('合成新增相同句', []))
    await page.evaluate(() => window.mz.sendChat('合成新增相同句', []))
    await releaseSnapshot(app)
    await expect(page.getByTestId('panel-history-loading')).toHaveCount(0)
    await expect(page.getByTestId('panel-msg-user')).toHaveCount(3)
    await expect(page.getByTestId('panel-msg-user').filter({ hasText: '合成新增相同句' })).toHaveCount(2)
    const final = await page.evaluate(() => window.mz.getPanelHistory())
    expect(final.eventCursor).toBeGreaterThan(original.eventCursor)
    expect(final.messages.filter(m => m.role === 'user').map(m => m.text)).toEqual(['合成已有历史', '合成新增相同句', '合成新增相同句'])
    await page.evaluate(() => (window as unknown as { __mzPanel: { reloadHistory(): Promise<void> } }).__mzPanel.reloadHistory())
    await expect(page.getByTestId('panel-msg-user')).toHaveCount(3)
  } finally { await releaseSnapshot(app); await app.close() }
})

test('忙中捕获快照：轮末完整历史、思考和图片读回，快照不发模型请求', async () => {
  const provider = await startFakeProvider('thinking', { count: 15, intervalMs: 80 })
  const d = historyDirs({ url: provider.url })
  const { app, page } = await launchHistory(d.data, d.profile)
  try {
    await page.getByTestId('panel-toggle').click()
    await activateHistoryProvider(page, provider.url)
    await page.evaluate(() => window.mz.sendChat('合成已有provider历史', []))
    const before = provider.requests()
    await holdSnapshot(app)
    await page.evaluate(() => {
      const g = window as unknown as { liveHistoryTurn: Promise<void> }
      g.liveHistoryTurn = window.mz.sendChat('合成忙轮附图', [{ fileName: 'synthetic.png', mediaType: 'image/png', dataBase64: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=' }])
    })
    await expect.poll(() => page.evaluate(() => window.mz.getState().then(s => s.activeProviderId))).toBe('synthetic-history-ui')
    await requestReload(page)
    await expect.poll(() => captured(app)).toMatchObject({ busy: true })
    await releaseSnapshot(app)
    await page.evaluate(() => (window as unknown as { liveHistoryTurn: Promise<void> }).liveHistoryTurn)
    await expect(page.getByTestId('panel-input')).toBeEnabled()
    await expect(page.getByTestId('panel-msg-user')).toHaveCount(2)
    await expect(page.getByTestId('panel-msg-image')).toHaveCount(1)
    expect(provider.requests()).toBe(before + 1)
    await page.getByTestId('panel-think').last().click()
    await expect(page.getByTestId('panel-think-full').last()).toContainText('思考第 15 步')
    const stable = await page.evaluate(() => window.mz.getPanelHistory())
    await page.evaluate(() => (window as unknown as { __mzPanel: { reloadHistory(): Promise<void> } }).__mzPanel.reloadHistory())
    expect((await page.evaluate(() => window.mz.getPanelHistory())).messages).toEqual(stable.messages)
    expect(provider.requests()).toBe(before + 1)
  } finally { await releaseSnapshot(app); await app.close(); await provider.close() }
})

test('旧会话等待快照/旧session事件迟到，不能污染新会话或复活旧确认门', async () => {
  const d = historyDirs()
  const { app, page } = await launchHistory(d.data, d.profile)
  try {
    await page.getByTestId('panel-toggle').click()
    await page.evaluate(() => window.mz.sendChat('合成旧会话锚点', []))
    const old = await page.evaluate(() => window.mz.getPanelHistory())
    await holdSnapshot(app); await requestReload(page)
    await expect.poll(() => captured(app)).toMatchObject({ sessionId: old.sessionId })
    // New-session requests may complete while the captured old response is still withheld.
    await app.evaluate(() => { (globalThis as unknown as { historyHold: boolean }).historyHold = false })
    expect(await page.evaluate(() => window.mz.newConversation())).toBe(true)
    await expect(page.getByTestId('panel-msg-user')).toHaveCount(0)
    const next = await page.evaluate(() => window.mz.getPanelHistory())
    expect(next.sessionId).not.toBe(old.sessionId)
    await releaseSnapshot(app)
    await expect(page.getByTestId('panel-msg-user')).toHaveCount(0)
    await app.evaluate(({ BrowserWindow }, previous) => BrowserWindow.getAllWindows()[0].webContents.send('mz:chat-event', { type: 'user-message', sessionId: previous.sessionId, streamId: previous.streamId, eventSeq: previous.eventCursor + 100, payload: { text: '合成旧session迟到事件' } }), old)
    await page.evaluate(() => window.mz.sendChat('合成新会话锚点', []))
    await expect(page.getByTestId('panel-msg-user')).toHaveCount(1)
    await expect(page.getByTestId('panel-msg-user')).toContainText('合成新会话锚点')
    await expect(page.getByTestId('classify-table')).toHaveCount(0)
  } finally { await releaseSnapshot(app); await app.close() }
})

test('真实认证前置拒绝：两次失败历史与重启保全，标本地失败而非助手答复', async () => {
  const d = historyDirs({ url: 'http://127.0.0.1:1/v1' })
  let { app, page } = await launchHistory(d.data, d.profile)
  try {
    await page.getByTestId('panel-toggle').click()
    for (let i = 0; i < 2; i++) {
      const result = await page.evaluate(async () => { try { await window.mz.sendChat('合成同句认证失败', []); return 'unexpected-success' } catch (e) { return String(e) } })
      expect(result).toContain('API key')
    }
    const history = await page.evaluate(() => window.mz.getPanelHistory())
    expect(history.messages.filter(m => m.role === 'user')).toHaveLength(2)
    await app.close()
    ;({ app, page } = await launchHistory(d.data, d.profile))
    await page.getByTestId('panel-toggle').click()
    await expect(page.getByTestId('panel-msg-user')).toHaveCount(2)
    await expect(page.getByTestId('panel-local-error')).toHaveCount(2)
    await expect(page.getByTestId('panel-local-error').first()).toContainText('未送达模型')
    await expect(page.getByTestId('panel-msg-assistant')).toHaveCount(0)
    expect((await page.evaluate(() => window.mz.getPanelHistory())).messages).toEqual(history.messages)
  } finally { await app.close() }
})
