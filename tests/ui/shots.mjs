// 截图脚本（T0928 第 3 轮 C：体检取证 + 交付截图）——不是巡检用例（文件名不带 .spec.，playwright test 不收集）。
//
// 跑法（在仓库根，环境变量与 ui-test 同口径）：
//   ELECTRON_DISABLE_SANDBOX=1 env -u ELECTRON_RUN_AS_NODE node tests/ui/shots.mjs <输出目录>
// 例：... node tests/ui/shots.mjs shots
//
// 隔离红线：MZ_DATA_DIR 与 --user-data-dir 都是 mkdtemp 临时目录——绝不碰真实账本 %APPDATA%\mingzhang。
// 内容：同一隔离实例先深后浅（setTheme 切浅，面板历史不丢），六屏各一张：
//   01-inbox 收件箱（有卡片）/ 02-ledger-list 账本列表 / 03-ledger-detail 账本详情
//   04-panel 助手面板（有对话+工具卡）/ 05-settings-model 设置-模型服务 / 06-wizard 向导覆盖层

import { _electron } from '@playwright/test'
import { mkdtempSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const OUT = process.argv[2] || 'shots'

async function launch() {
  const dataDir = mkdtempSync(join(tmpdir(), 'mz-shots-data-'))
  const udd = mkdtempSync(join(tmpdir(), 'mz-shots-udd-'))
  const app = await _electron.launch({
    args: ['.', `--user-data-dir=${udd}`],
    env: { ...process.env, MZ_DATA_DIR: dataDir },
    cwd: process.cwd(),
  })
  const page = await app.firstWindow()
  await page.waitForSelector('.mz-shell', { timeout: 30_000 })
  return { app, page }
}

/** 离线演示引擎就绪（与巡检同口径）。 */
async function ready(page) {
  await page.evaluate(async () => {
    const mz = window.mz
    await mz.setMock(true)
    for (let i = 0; i < 40; i++) {
      try {
        await mz.sendChat('待收尾', [])
        return
      } catch {
        await new Promise((r) => setTimeout(r, 500))
      }
    }
    throw new Error('离线演示引擎 20s 内未就绪')
  })
}

/** 喂内容：批量卡（确认后出转账待补卡 + 待分类账）+ 面板归类一轮（对话/思考条/工具卡/映射表）。 */
async function seed(page) {
  const cap = page.getByLabel('速记行')
  await cap.fill('把这张账单记一下')
  await cap.press('Enter')
  const batch = page.locator('[data-testid="inbox-card"][data-kind="batch_confirm"]')
  await batch.waitFor({ timeout: 30_000 })
  // 确认这批 → 出 transfer_account 待补卡 + 待分类账（供面板归类）
  await batch.getByTestId('inbox-confirm').click()
  await batch.waitFor({ state: 'detached', timeout: 30_000 })

  // 面板归类一轮（有对话气泡 + 思考条 + 两张工具卡 + 归类映射表）
  const panel = page.getByTestId('assistant-panel')
  if ((await panel.getAttribute('aria-hidden')) === 'true') {
    await page.getByTestId('panel-toggle').click()
  }
  const proposal = await page.evaluate(() => window.mz.getClassifyProposal())
  console.log('[shots] classify proposal:', proposal.pendingCount, '笔 /', proposal.groups.length, '组')
  await page.getByTestId('panel-input').fill('把待分类的账按建议归类')
  await page.getByTestId('panel-send').click()
  // 最低保证：两张工具卡 + 助手回复（= 有对话＋工具卡）；有待分类时顺带等映射表
  const tools = page.getByTestId('panel-tool')
  await tools.nth(1).waitFor({ timeout: 30_000 })
  await page.getByTestId('panel-msg-assistant').last().waitFor({ timeout: 30_000 })
  if (proposal.pendingCount > 0) {
    await page.getByTestId('classify-table').waitFor({ timeout: 30_000 })
  } else {
    console.log('[shots] 本批无缺分类项，映射表不出现（面板仍有对话+工具卡）')
  }
}

async function shootAll(page, dir) {
  mkdirSync(dir, { recursive: true })
  const shot = (name) => page.screenshot({ path: join(dir, name) })

  await page.getByTestId('nav-inbox').click()
  await page.waitForTimeout(300)
  await shot('01-inbox.png')

  await page.getByTestId('nav-ledger').click()
  await page.locator('[data-testid="ledger-row"]').first().waitFor({ timeout: 15_000 })
  await shot('02-ledger-list.png')

  await page.locator('[data-testid="ledger-row"]').first().click()
  await page.getByTestId('ledger-detail').waitFor({ timeout: 15_000 })
  await shot('03-ledger-detail.png')
  await page.getByTestId('ledger-detail-close').click()

  await page.getByTestId('nav-inbox').click() // 面板在收件箱上开着（推挤式）
  await page.waitForTimeout(300)
  await shot('04-panel.png')

  await page.getByTestId('nav-settings').click()
  await page.getByTestId('settings-route').waitFor()
  await page.waitForTimeout(300)
  await shot('05-settings-model.png')

  await page.getByRole('button', { name: '＋ 新增预设' }).click()
  await page.getByTestId('wizard-overlay').waitFor()
  await page.waitForTimeout(300)
  await shot('06-wizard.png')
  await page.keyboard.press('Escape')
}

const { app, page } = await launch()
try {
  await ready(page)
  await seed(page)

  // 深色（默认主题）
  await shootAll(page, join(OUT, 'dark'))

  // 浅色：走界面上的主题开关（与外壳⑤同路径：本地翻转 + 写盘 + App 重取 state，面板历史不丢）
  await page.getByTestId('theme-toggle').click()
  await page.waitForFunction(() => document.documentElement.dataset.theme === 'light', null, { timeout: 10_000 })
  await page.waitForTimeout(300)
  await shootAll(page, join(OUT, 'light'))

  console.log('shots done →', OUT)
} finally {
  await app.close()
}
