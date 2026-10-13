import { _electron, expect, type ElectronApplication, type Page } from '@playwright/test'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { PanelHistorySnapshotDTO } from '../../src/shared/types'

export function historyDirs(provider?: { url: string; key?: boolean }) {
  const data = mkdtempSync(join(tmpdir(), 'mz-history-boundary-data-'))
  const profile = mkdtempSync(join(tmpdir(), 'mz-history-boundary-profile-'))
  const providerConfig = provider ? [{ id: 'synthetic-history-ui', name: '合成服务', baseUrl: provider.url, model: 'fake-model', visionCapable: true }] : []
  writeFileSync(join(data, 'config.json'), JSON.stringify({ version: 2, onboarded: true, mock: !provider, theme: 'dark', providers: providerConfig, activeProviderId: provider ? 'synthetic-history-ui' : null }))
  return { data, profile }
}
export async function launchHistory(data: string, profile: string) {
  const env = { ...process.env, MZ_DATA_DIR: data }; delete env.ELECTRON_RUN_AS_NODE
  const app = await _electron.launch({ args: ['.', `--user-data-dir=${profile}`], env: env as Record<string, string> })
  const page = await app.firstWindow()
  await page.waitForSelector('.mz-shell')
  await expect.poll(() => page.evaluate(() => window.mz.getPanelHistory().then(s => s.sessionId))).not.toBeNull()
  return { app, page }
}
export async function activateHistoryProvider(page: Page, url: string) {
  const old = (await page.evaluate(() => window.mz.getPanelHistory())).sessionId
  await page.evaluate(async baseUrl => window.mz.saveProvider({ provider: { id: 'synthetic-history-ui', name: '合成服务', baseUrl, model: 'fake-model', visionCapable: true }, apiKey: 'synthetic-ui-key', activate: true }), url)
  await expect.poll(() => page.evaluate(() => window.mz.getPanelHistory().then(s => s.sessionId))).not.toBe(old)
  await expect.poll(() => page.evaluate(() => window.mz.getPanelHistory().then(s => s.sessionId))).not.toBeNull()
  await expect(page.getByTestId('panel-history-loading')).toHaveCount(0)
  return old
}
/** Hold a real captured IPC snapshot; never fabricate window.mz or snapshot contents. */
export async function holdSnapshot(app: ElectronApplication) {
  await app.evaluate(({ ipcMain }) => {
    const g = globalThis as unknown as { historyOriginal?: (e: unknown) => PanelHistorySnapshotDTO; historyHold: boolean; historyCaptured: PanelHistorySnapshotDTO | null; historyRelease?: () => void }
    if (!g.historyOriginal) {
      g.historyOriginal = (ipcMain as unknown as { _invokeHandlers: Map<string, (e: unknown) => PanelHistorySnapshotDTO> })._invokeHandlers.get('mz:getPanelHistory')!
      ipcMain.removeHandler('mz:getPanelHistory')
      ipcMain.handle('mz:getPanelHistory', event => {
        const snapshot = g.historyOriginal!(event)
        if (!g.historyHold) return snapshot
        g.historyCaptured = snapshot
        return new Promise<PanelHistorySnapshotDTO>(resolve => { g.historyRelease = () => resolve(snapshot) })
      })
    }
    g.historyHold = true; g.historyCaptured = null
  })
}
export async function releaseSnapshot(app: ElectronApplication) {
  await app.evaluate(() => {
    const g = globalThis as unknown as { historyHold: boolean; historyRelease?: () => void }
    g.historyHold = false; g.historyRelease?.(); g.historyRelease = undefined
  })
}
export async function captured(app: ElectronApplication) {
  return app.evaluate(() => (globalThis as unknown as { historyCaptured: PanelHistorySnapshotDTO | null }).historyCaptured)
}
export async function requestReload(page: Page) {
  await page.evaluate(() => { void (window as unknown as { __mzPanel: { reloadHistory: () => Promise<void> } }).__mzPanel.reloadHistory() })
  await expect(page.getByTestId('panel-history-loading')).toBeVisible()
}
