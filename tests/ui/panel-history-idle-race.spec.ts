// Parent R1 acceptance: real Electron + production IPC + real SDK + gated loopback SSE.
import { test, expect, _electron, type ElectronApplication } from '@playwright/test'
import http from 'node:http'
import type { AddressInfo } from 'node:net'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { PanelHistorySnapshotDTO } from '../../src/shared/types'

async function service() {
  let release = () => {}, requests = 0
  const server = http.createServer((req, res) => {
    req.resume(); req.on('end', () => {
      requests++
      res.writeHead(200, { 'content-type': 'text/event-stream' })
      const emit = (delta: unknown, finish: string | null = null) => res.write(`data: ${JSON.stringify({ id: 'synthetic-idle-race', object: 'chat.completion.chunk', model: 'synthetic', created: 1, choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`)
      emit({ role: 'assistant', content: '' }); emit({ reasoning_content: '合成轮正在核对' })
      release = () => {
        if (res.writableEnded || res.destroyed) return
        emit({ content: '合成轮已完成' }); emit({}, 'stop'); res.end('data: [DONE]\n\n')
      }
    })
  })
  await new Promise<void>(r => server.listen(0, '127.0.0.1', r))
  return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`, release: () => release(), requests: () => requests, close: async () => { server.closeAllConnections(); await new Promise<void>(r => server.close(() => r())) } }
}
async function launch(url: string) {
  const data = mkdtempSync(join(tmpdir(), 'mz-idle-race-data-')), profile = mkdtempSync(join(tmpdir(), 'mz-idle-race-profile-'))
  writeFileSync(join(data, 'config.json'), JSON.stringify({ version: 2, onboarded: true, mock: false, theme: 'dark', providers: [{ id: 'synthetic-idle-race', name: '合成服务', baseUrl: url, model: 'synthetic', visionCapable: false }], activeProviderId: 'synthetic-idle-race' }))
  const env = { ...process.env, MZ_DATA_DIR: data }; delete env.ELECTRON_RUN_AS_NODE
  const app = await _electron.launch({ args: ['.', `--user-data-dir=${profile}`], env: env as Record<string, string> })
  const page = await app.firstWindow(); await page.waitForSelector('.mz-shell')
  await page.evaluate(baseUrl => window.mz.saveProvider({ provider: { id: 'synthetic-idle-race', name: '合成服务', baseUrl, model: 'synthetic', visionCapable: false }, apiKey: 'synthetic-race-test-key', activate: true }), url)
  await expect.poll(() => page.evaluate(() => window.mz.getPanelHistory().then(s => s.sessionId))).not.toBeNull()
  await page.getByTestId('panel-toggle').click(); await expect(page.getByTestId('panel-history-loading')).toHaveCount(0)
  return { app, page }
}
async function gateSnapshot(app: ElectronApplication, capture: 'before' | 'after') {
  await app.evaluate(({ ipcMain }, timing) => {
    const original = (ipcMain as unknown as { _invokeHandlers: Map<string, (event: unknown) => PanelHistorySnapshotDTO> })._invokeHandlers.get('mz:getPanelHistory')!
    const state = globalThis as unknown as { idleRaceRequested: boolean; idleRaceCaptured?: PanelHistorySnapshotDTO; idleRaceRelease?: () => void }
    let once = true
    ipcMain.removeHandler('mz:getPanelHistory')
    ipcMain.handle('mz:getPanelHistory', event => {
      if (!once) return original(event)
      once = false; state.idleRaceRequested = true
      const early = timing === 'before' ? original(event) : null
      state.idleRaceCaptured = early ?? undefined
      return new Promise<PanelHistorySnapshotDTO>(resolve => { state.idleRaceRelease = () => { const real = early ?? original(event); state.idleRaceCaptured = real; resolve(real) } })
    })
  }, capture)
}
async function releaseSnapshot(app: ElectronApplication) { await app.evaluate(() => (globalThis as unknown as { idleRaceRelease?: () => void }).idleRaceRelease?.()) }

for (const timing of ['before', 'after'] as const) {
  test(`真实历史重读与轮末竞态：${timing === 'before' ? 'busy拍摄正控' : '最终idle拍摄反例'}，消息完整且输入解锁`, async () => {
    const provider = await service(), { app, page } = await launch(provider.url)
    try {
      await page.evaluate(() => { (window as unknown as { idleRaceTurn: Promise<void> }).idleRaceTurn = window.mz.sendChat('合成轮末恢复锚点', []) })
      await expect(page.getByTestId('panel-state')).toHaveText('处理中…')
      await expect(page.getByTestId('panel-think')).toHaveCount(1)
      await gateSnapshot(app, timing)
      await page.evaluate(() => { void (window as unknown as { __mzPanel: { reloadHistory(): Promise<void> } }).__mzPanel.reloadHistory() })
      await expect(page.getByTestId('panel-history-loading')).toBeVisible()
      await expect.poll(() => app.evaluate(() => (globalThis as unknown as { idleRaceRequested: boolean }).idleRaceRequested)).toBe(true)
      if (timing === 'before') expect(await app.evaluate(() => (globalThis as unknown as { idleRaceCaptured?: PanelHistorySnapshotDTO }).idleRaceCaptured?.busy)).toBe(true)
      provider.release()
      await page.evaluate(() => (window as unknown as { idleRaceTurn: Promise<void> }).idleRaceTurn)
      await releaseSnapshot(app)
      await expect(page.getByTestId('panel-history-loading')).toHaveCount(0)
      await expect(page.getByTestId('panel-msg-user')).toHaveCount(1)
      await expect(page.getByTestId('panel-msg-assistant')).toContainText('合成轮已完成')
      const history = await page.evaluate(() => window.mz.getPanelHistory())
      expect(history.busy).toBe(false)
      expect(history.messages.filter(m => m.role === 'user').map(m => m.text)).toEqual(['合成轮末恢复锚点'])
      if (timing === 'after') expect(await app.evaluate(() => (globalThis as unknown as { idleRaceCaptured?: PanelHistorySnapshotDTO }).idleRaceCaptured?.busy)).toBe(false)
      expect(provider.requests()).toBe(1)
      await expect(page.getByTestId('panel-input')).toBeEnabled()
      await expect(page.getByTestId('panel-send')).toBeEnabled()
      await expect(page.getByTestId('panel-state')).toHaveText('就绪')
    } finally { await releaseSnapshot(app); await app.close(); await provider.close() }
  })
}

test('idle历史不能提前放行仍待主进程回显的本地发送，随后真轮末解锁且同句只留一次', async () => {
  const provider = await service(), { app, page } = await launch(provider.url)
  try {
    await app.evaluate(({ ipcMain }) => {
      const original = (ipcMain as unknown as { _invokeHandlers: Map<string, (...args: unknown[]) => unknown> })._invokeHandlers.get('mz:sendChat')!
      const state = globalThis as unknown as { idleLocalRequested: boolean; releaseIdleLocal?: () => void }
      ipcMain.removeHandler('mz:sendChat')
      ipcMain.handle('mz:sendChat', (...args) => { state.idleLocalRequested = true; return new Promise(resolve => { state.releaseIdleLocal = () => resolve(original(...args)) }) })
    })
    await page.getByTestId('panel-input').fill('合成本地待回显')
    await page.getByTestId('panel-send').click()
    await expect.poll(() => app.evaluate(() => (globalThis as unknown as { idleLocalRequested: boolean }).idleLocalRequested)).toBe(true)
    await expect(page.getByTestId('panel-input')).toBeDisabled()
    await page.evaluate(() => (window as unknown as { __mzPanel: { reloadHistory(): Promise<void> } }).__mzPanel.reloadHistory())
    await expect(page.getByTestId('panel-msg-user')).toHaveCount(1)
    expect((await page.evaluate(() => window.mz.getPanelHistory())).busy).toBe(false)
    expect(provider.requests()).toBe(0)
    await expect(page.getByTestId('panel-input')).toBeDisabled()
    await app.evaluate(() => (globalThis as unknown as { releaseIdleLocal?: () => void }).releaseIdleLocal?.())
    await expect.poll(provider.requests).toBe(1)
    provider.release()
    await expect(page.getByTestId('panel-input')).toBeEnabled()
    await expect(page.getByTestId('panel-msg-user')).toHaveCount(1)
    const saved = await page.evaluate(() => window.mz.getPanelHistory())
    expect(saved.messages.filter(m => m.role === 'user').map(m => m.text)).toEqual(['合成本地待回显'])
  } finally { await app.close(); await provider.close() }
})

test('idle完整快照已包含本地回显与轮末：invoke尚未返回也要正确收口，不重复用户消息', async () => {
  const provider = await service(), { app, page } = await launch(provider.url)
  try {
    await app.evaluate(({ ipcMain }) => {
      const original = (ipcMain as unknown as { _invokeHandlers: Map<string, (...args: unknown[]) => Promise<unknown>> })._invokeHandlers.get('mz:sendChat')!
      const state = globalThis as unknown as { idleLocalSettled: boolean; releaseIdleReply?: () => void }
      ipcMain.removeHandler('mz:sendChat')
      ipcMain.handle('mz:sendChat', async (...args) => {
        const result = await original(...args)
        state.idleLocalSettled = true
        return new Promise(resolve => { state.releaseIdleReply = () => resolve(result) })
      })
    })
    await page.getByTestId('panel-input').fill('合成本地已回显轮')
    await page.getByTestId('panel-send').click()
    await expect(page.getByTestId('panel-state')).toHaveText('处理中…')
    await gateSnapshot(app, 'after')
    await page.evaluate(() => { void (window as unknown as { __mzPanel: { reloadHistory(): Promise<void> } }).__mzPanel.reloadHistory() })
    await expect(page.getByTestId('panel-history-loading')).toBeVisible()
    provider.release()
    await expect.poll(() => app.evaluate(() => (globalThis as unknown as { idleLocalSettled: boolean }).idleLocalSettled)).toBe(true)
    await releaseSnapshot(app)
    await expect(page.getByTestId('panel-history-loading')).toHaveCount(0)
    await expect(page.getByTestId('panel-msg-user')).toHaveCount(1)
    await expect(page.getByTestId('panel-msg-assistant')).toContainText('合成轮已完成')
    await expect(page.getByTestId('panel-input')).toBeEnabled()
    expect(provider.requests()).toBe(1)
    await app.evaluate(() => (globalThis as unknown as { releaseIdleReply?: () => void }).releaseIdleReply?.())
    await expect(page.getByTestId('panel-msg-user')).toHaveCount(1)
  } finally { await app.close(); await provider.close() }
})

test('idle已收口的旧invoke迟到：不能解锁正在运行的新发送，保留两次独立同句', async () => {
  const provider = await service(), { app, page } = await launch(provider.url)
  try {
    await app.evaluate(({ ipcMain }) => {
      const original = (ipcMain as unknown as { _invokeHandlers: Map<string, (...args: unknown[]) => Promise<unknown>> })._invokeHandlers.get('mz:sendChat')!
      const state = globalThis as unknown as { firstIdleSettled: boolean; releaseOldIdleReply?: () => void }
      let first = true
      ipcMain.removeHandler('mz:sendChat')
      ipcMain.handle('mz:sendChat', async (...args) => {
        if (!first) return original(...args)
        first = false
        const result = await original(...args)
        state.firstIdleSettled = true
        return new Promise(resolve => { state.releaseOldIdleReply = () => resolve(result) })
      })
    })
    await page.getByTestId('panel-input').fill('合成同句独立轮')
    await page.getByTestId('panel-send').click()
    await expect.poll(provider.requests).toBe(1)
    await gateSnapshot(app, 'after')
    await page.evaluate(() => { void (window as unknown as { __mzPanel: { reloadHistory(): Promise<void> } }).__mzPanel.reloadHistory() })
    await expect(page.getByTestId('panel-history-loading')).toBeVisible()
    provider.release()
    await expect.poll(() => app.evaluate(() => (globalThis as unknown as { firstIdleSettled: boolean }).firstIdleSettled)).toBe(true)
    await releaseSnapshot(app)
    await expect(page.getByTestId('panel-input')).toBeEnabled()
    await page.getByTestId('panel-input').fill('合成同句独立轮')
    await page.getByTestId('panel-send').click()
    await expect.poll(provider.requests).toBe(2)
    await expect(page.getByTestId('panel-input')).toBeDisabled()
    await app.evaluate(() => (globalThis as unknown as { releaseOldIdleReply?: () => void }).releaseOldIdleReply?.())
    await expect(page.getByTestId('panel-state')).toHaveText('处理中…')
    await expect(page.getByTestId('panel-input')).toBeDisabled()
    provider.release()
    await expect(page.getByTestId('panel-input')).toBeEnabled()
    await expect(page.getByTestId('panel-msg-user')).toHaveCount(2)
    const saved = await page.evaluate(() => window.mz.getPanelHistory())
    expect(saved.messages.filter(message => message.role === 'user').map(message => message.text)).toEqual(['合成同句独立轮', '合成同句独立轮'])
    expect(provider.requests()).toBe(2)
  } finally { await releaseSnapshot(app); await app.close(); await provider.close() }
})

test('idle快照已恢复真实认证失败：迟到invoke拒绝不重复已保存的失败回执', async () => {
  const provider = await service()
  const data = mkdtempSync(join(tmpdir(), 'mz-idle-auth-failure-data-')), profile = mkdtempSync(join(tmpdir(), 'mz-idle-auth-failure-profile-'))
  writeFileSync(join(data, 'config.json'), JSON.stringify({ version: 2, onboarded: true, mock: false, theme: 'dark', providers: [{ id: 'deepseek', name: '合成无应用凭据', baseUrl: provider.url, model: 'synthetic', visionCapable: false }], activeProviderId: 'deepseek' }))
  const env = { ...process.env, MZ_DATA_DIR: data, DEEPSEEK_API_KEY: 'synthetic-idle-host-key' }; delete env.ELECTRON_RUN_AS_NODE
  const app = await _electron.launch({ args: ['.', `--user-data-dir=${profile}`], env: env as Record<string, string> })
  const page = await app.firstWindow()
  try {
    await page.waitForSelector('.mz-shell')
    await expect.poll(() => page.evaluate(() => window.mz.getPanelHistory().then(snapshot => snapshot.sessionId))).not.toBeNull()
    await page.getByTestId('panel-toggle').click()
    await expect(page.getByTestId('panel-history-loading')).toHaveCount(0)
    await app.evaluate(({ ipcMain }) => {
      const original = (ipcMain as unknown as { _invokeHandlers: Map<string, (...args: unknown[]) => Promise<unknown>> })._invokeHandlers.get('mz:sendChat')!
      const state = globalThis as unknown as { failureRequested: boolean; failedMainSettled: boolean; releaseFailedMain?: () => Promise<void>; releaseFailedReply?: () => void }
      ipcMain.removeHandler('mz:sendChat')
      ipcMain.handle('mz:sendChat', (...args) => {
        state.failureRequested = true
        return new Promise((resolve, reject) => {
          state.releaseFailedMain = async () => {
            try { resolve(await original(...args)) }
            catch (error) { state.failedMainSettled = true; state.releaseFailedReply = () => reject(error) }
          }
        })
      })
    })
    await page.getByTestId('panel-input').fill('合成真实失败迟到回执')
    await page.getByTestId('panel-send').click()
    await expect.poll(() => app.evaluate(() => (globalThis as unknown as { failureRequested: boolean }).failureRequested)).toBe(true)
    await gateSnapshot(app, 'after')
    await page.evaluate(() => { void (window as unknown as { __mzPanel: { reloadHistory(): Promise<void> } }).__mzPanel.reloadHistory() })
    await expect(page.getByTestId('panel-history-loading')).toBeVisible()
    await app.evaluate(() => (globalThis as unknown as { releaseFailedMain?: () => Promise<void> }).releaseFailedMain?.())
    await expect.poll(() => app.evaluate(() => (globalThis as unknown as { failedMainSettled: boolean }).failedMainSettled)).toBe(true)
    await releaseSnapshot(app)
    await expect(page.getByTestId('panel-history-loading')).toHaveCount(0)
    await expect(page.getByTestId('panel-msg-user')).toHaveCount(1)
    await expect(page.getByTestId('panel-local-error')).toHaveCount(1)
    await expect(page.getByTestId('panel-input')).toBeEnabled()
    const saved = await page.evaluate(() => window.mz.getPanelHistory())
    expect(saved.messages.filter(message => message.isError)).toHaveLength(1)
    await app.evaluate(() => (globalThis as unknown as { releaseFailedReply?: () => void }).releaseFailedReply?.())
    await expect(page.getByTestId('panel-local-error')).toHaveCount(1)
    await expect(page.getByTestId('panel-msg-user')).toHaveCount(1)
    await expect(page.getByTestId('panel-msg-assistant')).toHaveCount(0)
    expect(provider.requests()).toBe(0)
    expect((await page.evaluate(() => window.mz.getPanelHistory())).messages).toEqual(saved.messages)
  } finally { await releaseSnapshot(app); await app.close(); await provider.close() }
})
