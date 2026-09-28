// UI 自动巡检（Playwright × Electron，_electron.launch）。
// 跑「离线演示」（mock）：不联网、确定性回复。覆盖试用反馈 #1–#4 回归 + 核心链路巡检。
// 纪律：每条修复配一条回归用例；连跑两遍全绿（防 flaky）。

import { test, expect, _electron, type ElectronApplication, type Page } from '@playwright/test'
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { bulkExpect, makeWechatXlsxBuffer } from '../xlsx-fixture'

let electronApp: ElectronApplication
let page: Page
let dataDir: string

async function launch(freshDataDir: string): Promise<void> {
  electronApp = await _electron.launch({
    args: ['.'],
    env: { ...process.env, MZ_DATA_DIR: freshDataDir, MZ_MOCK_DEBUG: undefined } as Record<string, string>,
  })
  page = await electronApp.firstWindow()
  await page.waitForSelector('.app', { timeout: 30_000 })
}

async function chat(text: string): Promise<void> {
  await page.getByPlaceholder(/说一句账/).fill(text)
  await page.keyboard.press('Enter')
}

/** 工具行与模型气泡会重复同一话术——统一取首个匹配，规避 strict mode。 */
function see(re: RegExp): ReturnType<Page['getByText']> {
  return page.getByText(re).first()
}

async function openTab(name: '对话' | '账本' | '待收尾' | '设置'): Promise<void> {
  // 若当前停在设置覆盖层（header 隐藏），任何 tab 切换前先返回对话
  const inSettings = await page
    .getByRole('heading', { name: '设置', exact: true })
    .isVisible()
    .catch(() => false)
  if (name === '设置') {
    // 幂等：上一用例可能已停在设置页（此时 header 隐藏）
    if (!inSettings) await page.getByRole('button', { name: '设置', exact: true }).click()
    return
  }
  if (inSettings) await page.getByRole('button', { name: '返回对话' }).click()
  // 精确匹配：'对话' 不能命中 header 里的「新开对话」（DOM 顺序在前）
  if (name === '待收尾') {
    await page.getByRole('button', { name: /^待收尾/ }).first().click()
    return
  }
  await page.getByRole('button', { name, exact: true }).click()
}

// 第 7 单 段3：设置页顶部三格子分类切换（需先进设置页）
async function openSettingsSection(name: '模型服务' | '账单与备份' | '数据储存'): Promise<void> {
  await page.getByRole('tab', { name, exact: true }).click()
}

test.describe.serial('UI 巡检 · 试用第 1 轮（离线演示）', () => {
  test.beforeAll(async () => {
    dataDir = mkdtempSync(join(tmpdir(), 'mz-ui-'))
    await launch(dataDir)
  })

  test.afterAll(async () => {
    await electronApp?.close()
  })

  test('B① 空态三按钮：全新安装直接进主界面，一键开启离线演示', async () => {
    // 空态可见（未配置模型不拦路）
    await expect(page.getByText('先配一个模型，就能开始记账')).toBeVisible()
    await expect(page.getByRole('button', { name: '配置模型' })).toBeVisible()
    await expect(page.getByRole('button', { name: '怎么配？看教程' })).toBeVisible()
    // 一键离线演示
    await page.getByRole('button', { name: '先开离线演示' }).click()
    await expect(page.getByText(/试试：「星巴克 35」/)).toBeVisible({ timeout: 30_000 })
    // 聊天输入可用
    await expect(page.getByPlaceholder(/说一句账/)).toBeEnabled()
  })

  test('急救 · 空态引导卡：model 就绪但对话为空时给可点示例；发送按钮横排单行', async () => {
    // B① 结尾 mock 已就绪、items 为空（未发过任何消息）→ 引导卡直接可见
    // 引导卡可见（含稳定钩子），≥3 个可点击示例
    const guide = page.getByTestId('empty-guide')
    await expect(guide).toBeVisible()
    const examples = guide.getByRole('button')
    expect(await examples.count()).toBeGreaterThanOrEqual(3)
    // 点示例 → 填入输入框（不直接发送）
    await examples.filter({ hasText: '麦当劳 26' }).click()
    await expect(page.getByPlaceholder(/说一句账/)).toHaveValue('麦当劳 26')
    await page.getByPlaceholder(/说一句账/).fill('')
    // 发送按钮：横排单行（CSS 白带不换行 + 实测高度为单行）
    const sendBtn = page.getByRole('button', { name: '发送', exact: true })
    await expect(sendBtn).toBeVisible()
    expect(await sendBtn.innerText()).toBe('发送')
    const whiteSpace = await sendBtn.evaluate((el) => getComputedStyle(el).whiteSpace)
    expect(whiteSpace).toBe('nowrap')
    const box = await sendBtn.boundingBox()
    expect(box?.height).toBeLessThan(60) // 竖排堆叠时高度会翻倍
  })

  test('A2 发图：气泡内渲染缩略图（点击可放大）', async () => {
    // 生成 1x1 红 PNG 作为测试图
    const png = Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
      'base64',
    )
    await page.setInputFiles('input[type="file"]', {
      name: 'pay-screenshot.png',
      mimeType: 'image/png',
      buffer: png,
    })
    // 输入区预览缩略图出现
    await expect(page.locator('.thumbs .msg-thumb, .thumbs img').first()).toBeVisible()
    await chat('瑞幸 12')
    // 用户气泡内的缩略图（A2 回归核心断言）
    const userBubble = page.locator('.user-bubble').last()
    await expect(userBubble.locator('img.msg-thumb')).toHaveCount(1, { timeout: 20_000 })
    // 点击放大 → 覆盖层出现 → 点击关闭
    await userBubble.locator('img.msg-thumb').click()
    await expect(page.locator('.zoom-overlay img')).toBeVisible()
    await page.locator('.zoom-overlay').click()
    await expect(page.locator('.zoom-overlay')).toHaveCount(0)
    // mock 确定性入账（附件通道放开：不软拦）
    await expect(see(/已入账：交易 #1，¥12\.00 · 瑞幸/)).toBeVisible({ timeout: 30_000 })
  })

  test('巡检 · 记一笔 / 查账（卡片与数字）', async () => {
    // 急救引导卡的示例已把「麦当劳 26」填入输入框——清空后按原剧本走，避免输入框残留污染
    await page.getByPlaceholder(/说一句账/).fill('')
    await chat('星巴克 35')
    await expect(see(/已入账：交易 #2，¥35\.00 · 星巴克/)).toBeVisible({ timeout: 30_000 })
    await chat('这个月花了多少')
    await expect(see(/支出合计/)).toBeVisible({ timeout: 30_000 })
    await expect(see(/¥47\.00/)).toBeVisible({ timeout: 30_000 }) // 12 + 35
  })

  test('巡检 · 改分类 / 拆账（before→after 与子项卡片）', async () => {
    await chat('这笔改成购物')
    await expect(see(/已修改 #2/)).toBeVisible({ timeout: 30_000 })
    await chat('拆成 20 + 15')
    await expect(see(/已把 #2 拆成 #\d+ \+ #\d+/)).toBeVisible({ timeout: 30_000 })
  })

  test('巡检 · 规则 / 月报', async () => {
    await chat('以后星巴克都算咖啡')
    await expect(see(/学会了：以后「星巴克」算「咖啡」/)).toBeVisible({ timeout: 30_000 })
    await chat('上月月报')
    await expect(see(/没有任何已确认的收支记录，这份月报是空的/)).toBeVisible({ timeout: 30_000 })
  })

  test('巡检 · 批次 CSV 路径（批次门 → 待办确认入账 → 逐项交代）', async () => {
    await openTab('对话')
    await chat('处理这份账单')
    await expect(see(/批次已生成待确认清单：2 笔将入账/)).toBeVisible({ timeout: 30_000 })
    // 段4-1：对话卡片只读——没有可点的确认按钮，改为"请到待办处理"引导
    await expect(see(/请到「待办」处理/)).toBeVisible({ timeout: 10_000 })
    await expect(page.locator('.tool-line').getByRole('button', { name: '确认入账', exact: true })).toHaveCount(0)
    // 执行入口在待办
    await openTab('待收尾')
    await page.getByRole('button', { name: '确认入账', exact: true }).last().click()
    await expect(see(/批次已入账 2 笔/)).toBeVisible({ timeout: 30_000 })
    await openTab('对话')
    await expect(page.getByText(/批次已入账/).first()).toBeVisible()
    await expect(page.locator('.chat-list').getByText(/演示甲/).first()).toBeVisible()
    await expect(page.locator('.chat-list').getByText(/金额看不清|缺金额/).first()).toBeVisible()
  })

  test('A3 待收尾：批次/删除就地重建卡片 + 一路点到确认（不依赖对话卡片）', async () => {
    await openTab('对话')
    // 删除待确认（显式编号：#1 瑞幸）
    await chat('删掉 #1')
    await expect(see(/已生成删除待确认清单/)).toBeVisible({ timeout: 30_000 })
    // 新批次待确认（自增交易号 → 每次都是可入账的新批次）
    await chat('再来一份账单')
    await expect(see(/批次已生成待确认清单：2 笔将入账/)).toBeVisible({ timeout: 30_000 })
    // A2 新口径：批次/删除行在待收尾**就地重建卡片**，直接执行（卡片可能已被归档）
    await openTab('待收尾')
    const rows = page.locator('.pending-item')
    const delRow = rows.filter({ hasText: '删除待确认' }).first()
    await expect(delRow.locator('.tx-card').getByRole('button', { name: '确认删除' })).toBeVisible()
    const batchRow = rows.filter({ hasText: '批次待确认' }).first()
    await expect(batchRow.locator('.tx-card').getByRole('button', { name: '确认入账' })).toBeVisible()
    // 一路点到确认：先就地删（行随办结消失），再就地批
    await delRow.locator('.tx-card').getByRole('button', { name: '确认删除' }).click()
    await expect(rows.filter({ hasText: '删除待确认' })).toHaveCount(0, { timeout: 30_000 })
    await batchRow.locator('.tx-card').getByRole('button', { name: '确认入账' }).click()
    await expect(rows.filter({ hasText: '批次待确认' })).toHaveCount(0, { timeout: 30_000 })
    // 执行结果可从账本核实（软删 #1 + 批次入账 演示甲/乙）
    await openTab('账本')
    await expect(page.locator('.badge', { hasText: '已删除' }).first()).toBeVisible({ timeout: 30_000 })
    await expect(page.getByText(/演示甲/).first()).toBeVisible()
    await openTab('待收尾')
  })

  test('A1 设置往返：对话状态保留（不重载/不清屏）', async () => {
    await openTab('对话')
    const before = await page.locator('.chat-list').innerHTML()
    await openTab('设置')
    await expect(page.getByRole('heading', { name: '设置' })).toBeVisible()
    await page.getByRole('button', { name: '返回对话' }).click()
    const after = await page.locator('.chat-list').innerHTML()
    expect(after).toBe(before) // 保活：DOM 完全一致
  })

  test('A1 重启后历史可见（含工具卡片与用户消息）', async () => {
    await electronApp.close()
    await launch(dataDir) // 同一数据目录重启
    await expect(page.getByPlaceholder(/说一句账/)).toBeEnabled({ timeout: 30_000 })
    // 历史恢复：用户消息 + 工具卡片都在
    await expect(page.locator('.user-bubble', { hasText: '星巴克 35' }).first()).toBeVisible({ timeout: 20_000 })
    await expect(page.getByText(/已入账：交易 #2，¥35\.00 · 星巴克/).first()).toBeVisible()
    await expect(see(/确认批次入账。已完成 2 笔/)).toBeVisible()
  })

  test('A4 新开对话：清屏 + 明确反馈 + 待收尾不受影响', async () => {
    await page.getByRole('button', { name: '新开对话' }).click()
    await expect(see(/已开启新对话（上一段已归档/)).toBeVisible({ timeout: 30_000 })
    // 旧消息不再显示（新会话历史为空）
    await expect(page.locator('.user-bubble', { hasText: '星巴克 35' })).toHaveCount(0)
    // 待收尾住 DB 不受影响
    await openTab('待收尾')
    await expect(page.locator('.pending-item').first()).toBeVisible()
    // 新会话可继续对话（连续性）
    await openTab('对话')
    await chat('星巴克 35')
    await expect(see(/已入账：交易 #\d+，¥35\.00 · 星巴克/)).toBeVisible({ timeout: 30_000 })
  })

  test('第 3/6 单 · 账本页：口径汇总卡（月份写进标签）/ 构成条 / 搜索 / 时间线 / 分页', async () => {
    await openTab('账本')
    // 口径唯一（段2-4）：汇总卡标签写真实月份口径，不再是"当前筛选/当前页"
    await expect(page.getByText(/支出合计/).first()).toBeVisible()
    await expect(page.getByText(/收入合计/).first()).toBeVisible()
    await expect(page.getByText(/笔数 \/ 待办/)).toBeVisible()
    // 分类构成条（来自整口径聚合）+ 图例
    await expect(page.getByText(/分类构成（/).first()).toBeVisible()
    await expect(page.locator('.share .bar .bar-seg').first()).toBeVisible()
    // 月报复盘面板：空月整块缺席（legacy ReportPanel 设计——不编造；本轮数据全在当月）
    await expect(page.locator('.report')).toHaveCount(0)
    // 搜索：搜「演示甲」能命中批次入账；清除后恢复
    await page.getByLabel('搜索').fill('演示甲')
    await page.getByRole('button', { name: '搜索', exact: true }).click()
    await expect(page.getByText(/演示甲/).first()).toBeVisible({ timeout: 20_000 })
    await page.getByRole('button', { name: '清除', exact: true }).click()
    // 筛选仍可用：类型=转账 应该没有记录（本轮数据无转账）——不硬编码，断言状态徽章仍渲染
    await page.getByLabel('状态').selectOption('confirmed')
    await expect(page.locator('.tx-table .badge').first()).toBeVisible()
    await page.getByLabel('状态').selectOption('')
    // 时间线仍可用：点第一行 → 抽屉 + 人话化 diff 容器
    await page.locator('.tx-table tbody tr').first().click()
    await expect(page.locator('.drawer')).toBeVisible()
    await expect(page.locator('.drawer .timeline').first()).toBeVisible()
    await page.locator('.drawer-head').getByRole('button', { name: '关闭' }).click()
    // 分页结构（数据不足一页时不显示 pager，但结构类名可查）
    await expect(page.locator('.tx-table')).toBeVisible()
  })

  test('A5 第 2 轮回归：新开对话后待收尾就地执行 + 定位兜底 + 归档查看', async () => {
    await openTab('对话')
    // 准备：开一个批次门，然后新开对话（旧卡片归档）
    await chat('再来一份账单')
    await expect(see(/批次已生成待确认清单/)).toBeVisible({ timeout: 30_000 })
    await page.getByRole('button', { name: '新开对话' }).click()
    await expect(see(/已开启新对话（上一段已归档/)).toBeVisible({ timeout: 30_000 })
    // A3：待收尾数量明示
    await expect(see(/有 \d+ 条待收尾，仍可在「待收尾」页处理/)).toBeVisible()
    // A2：待收尾就地重建批次卡 → 直接确认入账（不依赖对话卡片）；行随办结消失
    await openTab('待收尾')
    const batchRow = page.locator('.pending-item').filter({ hasText: '批次待确认' }).first()
    await expect(batchRow.locator('.tx-card').getByRole('button', { name: '确认入账' })).toBeVisible()
    await batchRow.locator('.tx-card').getByRole('button', { name: '确认入账' }).click()
    await expect(page.locator('.pending-item').filter({ hasText: '批次待确认' })).toHaveCount(0, { timeout: 30_000 })
    // 段3：待办是唯一办理入口，不再有"去对话处理"死按钮；confirm_record 给就地「回答」+「原交易」跳转
    const reviewRow = page.locator('.pending-item').filter({ hasText: '入账待确认' }).first()
    if (await reviewRow.count()) {
      await expect(reviewRow.getByRole('button', { name: '回答' })).toBeVisible()
      await expect(reviewRow.getByRole('button', { name: '原交易' })).toBeVisible()
      // 「原交易」跳到账本并打开该笔抽屉（不再是跳去对话找卡片）
      await reviewRow.getByRole('button', { name: '原交易' }).click()
      await expect(page.locator('.drawer')).toBeVisible({ timeout: 20_000 })
      await page.locator('.drawer-head').getByRole('button', { name: '关闭' }).click()
      await openTab('待收尾')
    }
    // A4：归档会话列表 + 只读查看（会话归档在「数据储存」格）
    await openTab('设置')
    await openSettingsSection('数据储存')
    await expect(page.getByRole('heading', { name: '会话归档' })).toBeVisible()
    await page.getByRole('button', { name: '查看' }).first().click()
    await expect(page.getByText(/归档对话 · /)).toBeVisible({ timeout: 20_000 })
    await page.getByRole('button', { name: '关闭' }).click()
  })

  test('C · IPC 注册面对账：preload invoke 通道 ⊆ 主进程 handler（防静默丢 handler）', async () => {
    // 主进程真实 handler 名单
    const handlers = await electronApp.evaluate(() => [...(globalThis as { __mzIpcChannels?: Set<string> }).__mzIpcChannels ?? []])
    // preload 里所有 invoke 通道（从源码解析——与打包无关，巡检跑在仓库内）
    const preloadSrc = readFileSync(join(process.cwd(), 'src/preload/index.ts'), 'utf8')
    const channels = [...preloadSrc.matchAll(/ipcRenderer\.invoke\('([a-zA-Z:-]+)'/g)].map((m) => m[1])
    expect(channels.length).toBeGreaterThan(20)
    const missing = channels.filter((c) => !handlers.includes(c))
    expect(missing).toEqual([]) // 曾发生：sendChat/confirmRecord 被静默丢掉
  })

  test('第 4 单 A/B：批次缺金额就地回答（面板表单）+ 来源附件缩略图与放大', async () => {
    await openTab('对话')
    // 发图 + 账单 → 批次确认 → 缺金额项（attachments 随批次进 payload）
    const png = Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
      'base64',
    )
    await page.setInputFiles('input[type="file"]', { name: 'bill.png', mimeType: 'image/png', buffer: png })
    await chat('处理这份账单')
    await expect(see(/批次已生成待确认清单/)).toBeVisible({ timeout: 30_000 })
    // 段4-1：对话卡片只读 → 确认入账改到待办 tab 就地执行
    await openTab('待收尾')
    await page.getByRole('button', { name: '确认入账', exact: true }).last().click()
    await expect(see(/批次已入账/)).toBeVisible({ timeout: 30_000 })
    // 待收尾：batch_item 行带来源附件缩略图
    await page.getByRole('button', { name: '刷新待办' }).click()
    // 段3-3：待办按新事项置顶（倒序）——本用例自己的缺金额行 = 最新一条（列表按 id 降序，新行在最前）
    const amountRows = page.locator('.pending-item').filter({ hasText: '批次缺金额' })
    const row = amountRows.first()
    await expect(row.locator('img.msg-thumb')).toBeVisible({ timeout: 20_000 })
    await row.locator('img.msg-thumb').click()
    await expect(page.locator('.zoom-overlay img')).toBeVisible()
    await page.locator('.zoom-overlay').click()
    await expect(page.locator('.zoom-overlay')).toHaveCount(0)
    // A：就地补金额（面板表单）→ 本行随办结消失（历史行不受影响）
    const before = await amountRows.count()
    await row.getByRole('button', { name: '补金额', exact: true }).click()
    await row.getByLabel(/续办答案/).fill('15 餐饮')
    await row.getByRole('button', { name: '提交答案' }).click()
    await expect(amountRows).toHaveCount(before - 1, { timeout: 30_000 })
    // 账本可核实（演示丙 15.00 confirmed）
    await openTab('账本')
    await page.getByLabel('搜索').fill('演示丙')
    await page.getByRole('button', { name: '搜索', exact: true }).click()
    await expect(page.getByText(/¥15\.00/).first()).toBeVisible({ timeout: 20_000 })
    await expect(page.locator('.tx-table .badge', { hasText: '已确认' }).first()).toBeVisible()
  })

  test('巡检 · 设置往返 + 三格子分类 + 备份页（快照）+ 教程可展开', async () => {
    await openTab('设置')
    // 默认落在「模型服务」：教程可展开
    await expect(page.getByRole('heading', { name: '模型服务' })).toBeVisible()
    await page.getByText('怎么配？看教程（常见供应商填法 / 视觉自检说明）').click()
    await expect(page.getByText('四步：')).toBeVisible()
    // 模型服务格里的动作可点（新增预设 → 进向导含"测试连接"）
    await expect(page.getByRole('button', { name: '＋ 新增预设' })).toBeEnabled()
    // 「账单与备份」：手动快照
    await openSettingsSection('账单与备份')
    await expect(page.getByRole('heading', { name: '备份' })).toBeVisible()
    await page.getByRole('button', { name: '立即快照' }).click()
    await expect(page.getByText(/快照已创建/)).toBeVisible({ timeout: 30_000 })
    // 「数据储存」：数据目录信息
    await openSettingsSection('数据储存')
    await expect(page.getByText(/当前数据目录/)).toBeVisible()
    await page.getByRole('button', { name: '返回对话' }).click()
  })

  // —— 第 5 单 C5：本轮真实崩溃场景（批次含转账）+ 连点防重 ——

  test('第 5 单 · 含转账条目的批次执行：不崩溃、转账跳过落待办、其余入账、gate 关闭', async () => {
    await openTab('对话')
    // mock 确定性批次里混入一笔零钱通转入（transfer，缺账户不能入账）
    await chat('含转账的账单')
    await expect(see(/批次已生成待确认清单：3 笔将入账/)).toBeVisible({ timeout: 30_000 })
    // 段4-1：确认在待办 tab 就地执行
    await openTab('待收尾')
    await page.getByRole('button', { name: '确认入账', exact: true }).last().click()
    await expect(see(/批次已入账 2 笔/)).toBeVisible({ timeout: 30_000 }) // C1：明确"已入账 N 笔"（3 项里转账不计）
    // 段3-4：被跳过的转账落成一条"转账缺账户"待办（关对话不丢）
    await expect(page.locator('.pending-item').filter({ hasText: '转账缺账户' }).first()).toBeVisible({ timeout: 10_000 })
    // 两笔支出入账：账本可搜到
    await openTab('账本')
    await page.getByLabel('搜索').fill('演示打车')
    await page.getByRole('button', { name: '搜索', exact: true }).click()
    await expect(page.getByText(/演示打车/).first()).toBeVisible({ timeout: 20_000 })
    await page.getByLabel('搜索').fill('零钱通转入')
    await page.getByRole('button', { name: '搜索', exact: true }).click()
    // 转账确实没入账（账本搜不到）
    await expect(page.getByText(/没搜到/).first()).toBeVisible({ timeout: 20_000 })
    await page.getByRole('button', { name: '清除', exact: true }).click()
  })

  test('第 5 单 · 确认按钮连点防重：同一批次双击只入账一次', async () => {
    const readDemoJiaTotal = async (): Promise<number> => {
      await openTab('账本')
      await page.getByLabel('搜索').fill('演示甲')
      await page.getByRole('button', { name: '搜索', exact: true }).click()
      await expect(page.locator('.tx-table tbody tr', { hasText: '演示甲' }).first()).toBeVisible({ timeout: 20_000 })
      const txt = await page.locator('.filters .muted', { hasText: '共' }).first().innerText()
      await page.getByRole('button', { name: '清除', exact: true }).click()
      const m = /共\s*(\d+)/.exec(txt)
      return m ? Number.parseInt(m[1], 10) : 0
    }
    const before = await readDemoJiaTotal()

    await openTab('对话')
    await chat('再来一份账单')
    await expect(see(/批次已生成待确认清单：2 笔将入账/)).toBeVisible({ timeout: 30_000 })
    // 段4-1：连点在待办 tab 的批次确认按钮（对话卡片已只读）
    await openTab('待收尾')
    const btn = await page.getByRole('button', { name: '确认入账', exact: true }).last().elementHandle()
    await btn!.click()
    await btn!.click({ timeout: 2000 }).catch(() => {})
    await btn!.click({ timeout: 2000 }).catch(() => {})
    await expect(see(/批次已入账 2 笔/)).toBeVisible({ timeout: 30_000 })

    // 演示甲只应新增 1 笔（若重复执行会变成 +2、+3）
    const after = await readDemoJiaTotal()
    expect(after).toBe(before + 1)
  })

  test('第 5 单 C4② · 继续此对话：引擎切回归档会话并载入其历史', async () => {
    await electronApp.close()
    await launch(dataDir) // 重启后仍是同一数据目录（归档会话在盘）
    await expect(page.getByPlaceholder(/说一句账/)).toBeEnabled({ timeout: 30_000 })

    // 新开一段对话，让当前会话进入空档 → 便于验证"继续"把引擎切回旧会话
    await page.getByRole('button', { name: '新开对话' }).click()
    await expect(see(/已开启新对话|当前已是新对话/)).toBeVisible({ timeout: 30_000 })

    await openTab('设置')
    await openSettingsSection('数据储存')
    await expect(page.getByRole('heading', { name: '会话归档' })).toBeVisible()
    // 出现「继续此对话」入口（有归档会话时）
    const contBtn = page.getByRole('button', { name: '继续此对话' }).first()
    await expect(contBtn).toBeVisible({ timeout: 10_000 })
    page.once('dialog', (d) => void d.accept())
    await contBtn.click()
    // 续接后回到对话视图，且载入的是那段归档历史（非空的新会话）——证明引擎已切换 + 历史已重载
    await expect(page.getByRole('heading', { name: '设置', exact: true })).toBeHidden({ timeout: 30_000 })
    await expect(page.locator('.chat-list .msg').first()).toBeVisible({ timeout: 30_000 })
    expect(await page.locator('.chat-list .msg').count()).toBeGreaterThan(1)
  })

  test('第 6 单 段1 · 执行返回语义化（已办结门 / 已删账都有明确文案，无静默）', async () => {
    await openTab('对话')
    // ① 批次门：待办里确认后 → 再执行同一门返回 already_closed + 非空文案
    await chat('再来一份账单')
    await expect(see(/批次已生成待确认清单：2 笔将入账/)).toBeVisible({ timeout: 30_000 })
    const gateId = Number(await page.locator('.tool-line[data-gate]').last().getAttribute('data-gate'))
    await openTab('待收尾')
    await page.getByRole('button', { name: '确认入账', exact: true }).last().click()
    await expect(see(/批次已入账 2 笔/)).toBeVisible({ timeout: 30_000 })
    const r1 = await page.evaluate((id) => (window as unknown as { mz: { confirmGate: (n: number) => Promise<{ status: string; message: string }> } }).mz.confirmGate(id), gateId)
    expect(r1.status).toBe('already_closed')
    expect(r1.message.length).toBeGreaterThan(0)

    // ② 收入缺分类 → needs_review；删掉它；直接确认必须报错且状态不变（域层护栏，旧快照改不活已删账）
    await openTab('对话')
    await chat('工资 5000')
    await expect(see(/已保存待确认（交易 #\d+/)).toBeVisible({ timeout: 30_000 })
    const pend = await page.evaluate(() => (window as unknown as { mz: { listPending: () => Promise<{ field: string; txId: number | null }[]> } }).mz.listPending())
    const salary = pend.filter((p) => p.field === 'confirm_record' && p.txId != null).pop()
    expect(salary).toBeTruthy()
    const txId = salary!.txId as number
    await chat(`删掉 #${txId}`)
    await expect(see(/已生成删除待确认清单/)).toBeVisible({ timeout: 30_000 })
    await openTab('待收尾')
    await page.getByRole('button', { name: '确认删除', exact: true }).last().click()
    await page.waitForTimeout(600)
    const r2 = await page.evaluate((id) => (window as unknown as { mz: { confirmRecord: (n: number) => Promise<{ status: string; message: string }> } }).mz.confirmRecord(id), txId)
    expect(r2.status).toBe('error')
    expect(r2.message).toMatch(/已删除/)
    // 真值：这笔仍是 deleted——旧快照没能把它改活
    const truth = await page.evaluate(() => (window as unknown as { mz: { listLedger: (f: unknown) => Promise<{ items: { id: number; state: string }[] }> } }).mz.listLedger({ limit: 500 }))
    expect(truth.items.find((t) => t.id === txId)?.state).toBe('deleted')
  })

  test('第 6 单 段1 · 重启后历史卡片按当前态收敛为只读（无可点但静默的按钮）', async () => {
    await electronApp.close()
    await launch(dataDir) // 重启：历史卡片是当时的快照
    await expect(page.getByPlaceholder(/说一句账/)).toBeEnabled({ timeout: 30_000 })
    await expect(page.locator('.tool-line .tx-card').first()).toBeVisible({ timeout: 30_000 })
    // 已办结的卡片渲染为只读灰条
    const resolved = page.locator('.card-resolved')
    expect(await resolved.count()).toBeGreaterThan(0)
    // 每个带"已处理"灰条的卡片内，不得残留"确认入账/确认删除"按钮
    const n = await resolved.count()
    for (let i = 0; i < n; i++) {
      const card = resolved.nth(i).locator('xpath=ancestor::*[contains(@class,"tx-card")][1]')
      await expect(card.getByRole('button', { name: /确认入账|确认删除/ })).toHaveCount(0)
    }
  })

  test('第 6 单 段2+段3 · 本次入账条 / 账本降级摘要+自动重载 / 待办分组 / 月份规范化', async () => {
    const readCountNow = async (): Promise<number> => {
      const txt = await page.locator('.filters .muted', { hasText: '共' }).first().innerText()
      const m = /共\s*(\d+)/.exec(txt)
      return m ? Number.parseInt(m[1], 10) : 0
    }
    // 段2-1：单笔记账（自动确认）也进常驻"本次入账"条——过去这种路径完全没有反馈
    await openTab('对话')
    await chat('星巴克 35')
    await expect(page.locator('.deposit-bar')).toContainText('本次入账 1 笔', { timeout: 30_000 })
    await expect(page.locator('.deposit-bar').getByRole('button', { name: '查看' })).toBeVisible()
    // 造一个未确认批次门
    await chat('再来一份账单')
    await expect(see(/批次已生成待确认清单：2 笔将入账/)).toBeVisible({ timeout: 30_000 })

    // 段3-1：账本页不再重复一份待办清单，降级为一行摘要 + "去处理"；页内无就地执行卡片
    await openTab('账本')
    await expect(page.locator('.pending-summary')).toBeVisible()
    await expect(page.getByRole('button', { name: /去处理/ }).first()).toBeVisible()
    await expect(page.locator('.pending-block')).toHaveCount(0)
    const before = await readCountNow()

    // 段3-2：待办 tab 按来源分组；就地确认批次门 → 行随办结消失 → 回账本"共 N 笔"反映新入的 2 笔（S1/段2-2 因果链）
    await page.getByRole('button', { name: /去处理/ }).first().click()
    await expect(page.locator('.pending-group').first()).toBeVisible({ timeout: 10_000 })
    const batchRow = page.locator('.pending-item').filter({ hasText: '批次待确认' }).last()
    await batchRow.locator('.tx-card').getByRole('button', { name: '确认入账', exact: true }).click()
    await expect(page.locator('.pending-item').filter({ hasText: '批次待确认' })).toHaveCount(0, { timeout: 30_000 })
    await openTab('账本')
    await expect.poll(async () => readCountNow(), { timeout: 15_000 }).toBeGreaterThanOrEqual(before + 2)

    // S3：月份手输 "2026-9"（少个 0）→ 规范化补 0，结果不塌成 0 笔
    const d = new Date()
    await page.getByLabel('月份').fill(`${d.getFullYear()}-${d.getMonth() + 1}`)
    await expect(page.locator('.tx-table tbody tr').first()).toBeVisible({ timeout: 10_000 })
    expect(await readCountNow()).toBeGreaterThan(0)

    // 空月份 = 显式"全部月份"口径（不再悄悄变成隐藏的全时间视图）
    await page.getByLabel('月份').fill('')
    await expect(page.getByText('全部月份').first()).toBeVisible({ timeout: 10_000 })
  })

  test('第 6 单 段4 · 抽屉动作组（改分类 / 撤销 / 删除 / 恢复）+ 对话卡片只读', async () => {
    // 记一笔已入账的支出
    await openTab('对话')
    await chat('超市 20')
    await expect(see(/已入账：交易 #\d+，¥20\.00 · 超市/)).toBeVisible({ timeout: 30_000 })

    await openTab('账本')
    await page.getByLabel('月份').fill('')
    await page.getByLabel('搜索').fill('超市')
    await page.getByRole('button', { name: '搜索', exact: true }).click()
    const row = page.locator('.tx-table tbody tr', { hasText: '超市' }).first()
    await expect(row).toBeVisible({ timeout: 20_000 })
    await row.click()

    await expect(page.getByRole('button', { name: '改分类' })).toBeVisible()
    await expect(page.getByRole('button', { name: '删除' })).toBeVisible()
    // 改分类：行内下拉选「餐饮」→ 保存 → ✓ 已修改 + 撤销（反向 update）
    await page.getByRole('button', { name: '改分类' }).click()
    await page.getByLabel('新分类').selectOption('餐饮')
    await page.getByRole('button', { name: '保存' }).click()
    await expect(page.getByText(/✓ 已修改/)).toBeVisible({ timeout: 10_000 })
    await page.getByRole('button', { name: '撤销' }).click()
    await expect(page.getByText(/✓ 已修改/)).toBeVisible({ timeout: 10_000 })
    // 删除（原生 confirm，可测）→ 已删除 → 恢复这笔
    page.once('dialog', (d) => void d.accept())
    await page.getByRole('button', { name: '删除' }).click()
    await expect(page.getByText(/✓ 已删除/)).toBeVisible({ timeout: 10_000 })
    await page.getByRole('button', { name: '恢复这笔' }).click()
    await expect(page.getByText(/✓ 已恢复/)).toBeVisible({ timeout: 10_000 })
    await page.locator('.drawer-head').getByRole('button', { name: '关闭' }).click()
  })

  test('第 7/8 单 · 拖入微信账单 XLSX → 逐行入库 → Agent 读表出方案 → 程序套表进批次门', async () => {
    await openTab('对话')
    const buf = Buffer.from(makeWechatXlsxBuffer())
    await page.setInputFiles('input[type="file"]', {
      name: 'wechat-bill.xlsx',
      mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      buffer: buf,
    })
    // 本地解析成二维表才会出现附件条（含行数）
    await expect(page.getByText(/XLSX · wechat-bill\.xlsx（4 行）/)).toBeVisible({ timeout: 15_000 })
    await page.getByPlaceholder(/说一句账/).press('Enter')
    // 第 8 单新链路：先读表（read_bill）再交方案（apply_bill），材料 4 行 = 3 笔入账 + 1 行不计收支
    await expect(see(/方案已套用：材料 4 行 = 将入账 3 \+ 重复跳过 0 \+ 待核对 0 \+ 不计收支 1/)).toBeVisible({ timeout: 30_000 })
    await openTab('待收尾')
    await page.getByRole('button', { name: '确认入账', exact: true }).last().click()
    await expect(see(/批次已入账 3 笔/)).toBeVisible({ timeout: 30_000 })
    // 逐笔明细确实进了账本（账本口径保活会留着上一条用例的筛选，所以这里主动搜）
    await openTab('账本')
    await page.getByPlaceholder(/搜商户/).fill('星巴克咖啡')
    await page.getByRole('button', { name: '搜索' }).click()
    await expect(page.getByText(/¥35\.00/).first()).toBeVisible({ timeout: 15_000 })
    await page.getByRole('button', { name: '清除' }).click()
    await openTab('对话')
  })

  test('第 8 单 · 300 行账单：金额与行数由程序从原表取，入账笔数与合计分毫不差', async () => {
    await openTab('对话')
    // "本次入账"条是会话内累计的——先清掉，好让本用例断言的是这一批的准确数字
    const bar = page.locator('.deposit-bar')
    if (await bar.isVisible().catch(() => false)) await bar.getByRole('button', { name: '✕' }).click()
    const n = 300
    const exp = bulkExpect(n)
    await page.setInputFiles('input[type="file"]', {
      name: 'bulk-bill.xlsx',
      mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      buffer: Buffer.from(makeWechatXlsxBuffer(n)),
    })
    await expect(page.getByText(/XLSX · bulk-bill\.xlsx（300 行）/)).toBeVisible({ timeout: 20_000 })
    await page.getByPlaceholder(/说一句账/).press('Enter')
    await expect(
      see(new RegExp(`方案已套用：材料 ${n} 行 = 将入账 ${exp.count} \\+ 重复跳过 0 \\+ 待核对 0 \\+ 不计收支 ${exp.skipped}`)),
    ).toBeVisible({ timeout: 60_000 })
    await openTab('待收尾')
    await page.getByRole('button', { name: '确认入账', exact: true }).last().click()
    // 常驻条数字 = 独立算出的真值：行数不丢一分、金额不错一分
    await expect(see(new RegExp(`✓ 本次入账 ${exp.count} 笔 ¥${(exp.cents / 100).toFixed(2)}`))).toBeVisible({ timeout: 60_000 })
    await openTab('对话')
  })

  test('第 7 单 段2 · 不支持的格式 → 明确提示，不再静默吞文件', async () => {
    await openTab('对话')
    await page.setInputFiles('input[type="file"]', {
      name: '发票.pdf',
      mimeType: 'application/pdf',
      buffer: Buffer.from('%PDF-1.4 fake'),
    })
    await expect(see(/暂不支持「发票\.pdf」/)).toBeVisible({ timeout: 10_000 })
    await expect(see(/图片截图 \/ CSV、XLSX/)).toBeVisible()
  })
})
