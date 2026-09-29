// 截图脚本（T0928 第 3 轮 C：体检取证 + 交付截图）——不是巡检用例（文件名不带 .spec.，playwright test 不收集）。
//
// 跑法（在仓库根，环境变量与 ui-test 同口径）：
//   ELECTRON_DISABLE_SANDBOX=1 env -u ELECTRON_RUN_AS_NODE node tests/ui/shots.mjs <输出目录>
// 例：... node tests/ui/shots.mjs shots
//
// 隔离红线：MZ_DATA_DIR 与 --user-data-dir 都是 mkdtemp 临时目录——绝不碰真实账本 %APPDATA%\mingzhang。
// 内容：同一隔离实例先深后浅（setTheme 切浅，面板历史不丢），七屏各一张：
//   01-inbox 收件箱（有卡片）/ 02-ledger-list 账本列表 / 03-ledger-detail 账本详情
//   04-panel 助手面板（有对话+工具卡）/ 05-settings-model 设置-模型服务 / 06-wizard 向导覆盖层
//   07-report 报告屏（当月大卡 + 预算条 + 分类条 + 历史月份网格）
// 报告屏那一屏先给账本补一笔"上个月"的合成账单（脚本生成的假数据，绝不碰真实账本），
// 否则历史网格全是空卡，截不出"点卡切月 + 环比"的样子。

import { _electron } from '@playwright/test'
import * as XLSX from 'xlsx'
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


/** 上个月的合成假账单（脚本生成，红线：绝不读用户真实账单）。让报告屏的历史网格与环比有内容可看。 */
const BILL_HEADER = [
  '交易时间', '交易类型', '交易对方', '商品', '收/支', '金额(元)',
  '支付方式', '当前状态', '交易单号', '商户单号', '备注',
]

function prevMonthKey(d = new Date()) {
  const p = new Date(d.getFullYear(), d.getMonth() - 1, 1)
  return `${p.getFullYear()}-${String(p.getMonth() + 1).padStart(2, '0')}`
}

function makePrevMonthBill() {
  const prev = prevMonthKey()
  const rows = [
    [`${prev}-05 10:12:00`, '商户消费', '星巴克咖啡', '拿铁', '支出', '¥35.00', '零钱', '支付成功', 'SHPREV01', 'MP1', ''],
    [`${prev}-08 12:30:00`, '商户消费', '海底捞', '火锅', '支出', '¥268.00', '零钱', '支付成功', 'SHPREV02', 'MP2', ''],
    [`${prev}-12 09:05:00`, '商户消费', '滴滴打车', '快车', '支出', '¥46.50', '零钱', '支付成功', 'SHPREV03', 'MP3', ''],
    [`${prev}-20 19:40:00`, '商户消费', '京东超市', '日用品', '支出', '¥165.00', '零钱', '支付成功', 'SHPREV04', 'MP4', ''],
    [`${prev}-26 21:15:00`, '商户消费', '万达影城', '电影票', '支出', '¥98.00', '零钱', '支付成功', 'SHPREV05', 'MP5', ''],
  ]
  const ws = XLSX.utils.aoa_to_sheet([BILL_HEADER, ...rows])
  const wb = XLSX.utils.book_new()
  XLSX.utils.book_append_sheet(wb, ws, '微信支付账单')
  const bin = XLSX.write(wb, { type: 'array', bookType: 'xlsx' })
  return Buffer.from(new Uint8Array(bin)).toString('base64')
}

async function seedPrevMonthBill(page) {
  await page.getByTestId('nav-inbox').click()
  const cap = page.getByLabel('速记行')
  await cap.press('Escape')
  await page.evaluate((data) => {
    const bin = atob(data)
    const bytes = new Uint8Array(bin.length)
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i)
    const dt = new DataTransfer()
    dt.items.add(
      new File([bytes], '微信账单.xlsx', {
        type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      }),
    )
    const el = document.querySelector('[data-testid="capture-bar"]')
    el.dispatchEvent(new DragEvent('dragover', { bubbles: true, cancelable: true, dataTransfer: dt }))
    el.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: dt }))
  }, makePrevMonthBill())
  await page.getByTestId('capture-bill').first().waitFor({ timeout: 30_000 })
  await cap.fill('把这张账单记一下')
  await cap.press('Enter')
  const card = page.locator('[data-testid="inbox-card"][data-kind="batch_confirm"]')
  await card.waitFor({ timeout: 30_000 })
  await card.getByTestId('inbox-confirm').click()
  await card.waitFor({ state: 'detached', timeout: 30_000 })
  // 演示预算：按本月已用支出 × 1.25 落一个整数预算，让预算进度条有东西可画
  // （真通道写入，只落在这个临时数据目录里）
  const cur = await page.evaluate(async () => {
    const m = await window.mz.reportMonths(1)
    const now = m[0]
    await window.mz.setBudget(Math.max(100000, Math.round((now.expenseCents * 1.25) / 10000) * 10000))
    return now
  })
  console.log('[shots] 本月已用:', `¥${(cur.expenseCents / 100).toFixed(2)}`)
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

  // 报告屏用：上个月的合成账单 + 演示预算
  await seedPrevMonthBill(page)
  const rep = await page.evaluate(() => window.mz.latestReport())
  console.log('[shots] 上月月报:', rep ? `${rep.month} 支出 ¥${(rep.totalExpenseCents / 100).toFixed(2)}` : '(空)')
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

  await page.getByTestId('nav-report').click()
  await page.getByTestId('report-hero').waitFor({ timeout: 15_000 })
  // 等底部 toast 自己收起来（3s 自动隐藏），别让它盖住历史月份网格
  await page.getByTestId('toast').waitFor({ state: 'detached', timeout: 10_000 }).catch(() => {})
  await page.waitForTimeout(300)
  await shot('07-report.png')

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
