// 报告屏 UI 巡检（Playwright × Electron）——issue #3「报告屏落地」。
//
// 覆盖：① 当月大卡数字与夹具一致（含环比、分类 Top、预算条三档）② 历史网格 N 张卡 + 点卡切换
//      ③ 点分类条 → 账本且「该月 + 该分类」筛选 chip 已带上 ④ 空态 ⑤ 出错态 + 重新生成恢复
//      ⑥ 零整页滚动（滚动归报告屏自己的区域）
//
// 数据纪律：
//   ① 隔离：MZ_DATA_DIR 与 --user-data-dir 都是 mkdtemp 临时目录，真实账本 %APPDATA% 全程不碰。
//   ② 夹具账单是**脚本合成**的假微信账单（tests/xlsx-fixture 的表头 + 本文件自造的行），
//      绝不读用户真实账单；日期按"上一个月 / 本月"动态算，用例不写死月份。
//   ③ 金额/分类全部取常识表能兜住商户（星巴克咖啡/京东超市/滴滴打车），
//      所以导入后就是**已确认入账**，报告数字可精确断言。
//   ④ 出错态不是 stub window.mz（contextBridge 不可重定义），而是在**主进程**把
//      mz:reportMonths 的真 handler 包一层开关：真抛错 → 界面进错误态；[重新生成] 仍报错
//      （证明是真重查，不是静态卡）；关掉开关再点 [重新生成] → 界面恢复（证明恢复路径通）。

import { test, expect, _electron, type ElectronApplication, type Page } from '@playwright/test'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import * as XLSX from 'xlsx'
import { WECHAT_HEADER } from '../xlsx-fixture'

const p2 = (n: number): string => String(n).padStart(2, '0')
const monthKey = (d: Date): string => `${d.getFullYear()}-${p2(d.getMonth() + 1)}`
const monthLabel = (month: string): string => {
  const m = /^(\d{4})-(\d{1,2})$/.exec(month)
  return `${m?.[1]} 年 ${Number(m?.[2])} 月`
}

const NOW = new Date()
const CUR = monthKey(NOW)
const PREV = monthKey(new Date(NOW.getFullYear(), NOW.getMonth() - 1, 1))

/** 假账单的固定事实（断言用真值另算，与实现无关）：
 *   上月：星巴克咖啡 ¥35.00（常识表→餐饮）+ 京东超市 ¥65.00（→购物）= ¥100.00 / 2 笔
 *   本月：速记行「滴滴打车 28」= ¥28.00（→交通）/ 1 笔，收入 0 笔
 *   环比：本月比上月少 ¥72.00（72.0%） */
const PREV_EXPENSE = '¥100.00'
const CUR_EXPENSE = '¥28.00'

/** 起一个独立 Electron 实例：账本数据目录与 user-data-dir 都是临时目录。 */
async function launchIsolated(): Promise<{ app: ElectronApplication; page: Page }> {
  const dataDir = mkdtempSync(join(tmpdir(), 'mz-report-data-'))
  const userDataDir = mkdtempSync(join(tmpdir(), 'mz-report-udd-'))
  const app = await _electron.launch({
    args: ['.', `--user-data-dir=${userDataDir}`],
    env: { ...process.env, MZ_DATA_DIR: dataDir } as Record<string, string>,
  })
  const page = await app.firstWindow()
  await page.waitForSelector('.mz-shell', { timeout: 30_000 })
  return { app, page }
}

/** 离线演示引擎就绪（与既有巡检同口径：开 mock 后轮询无副作用的「待收尾」）。 */
async function readyMock(page: Page): Promise<void> {
  await page.evaluate(async () => {
    const mz = (window as unknown as { mz: Record<string, (...a: unknown[]) => Promise<unknown>> }).mz
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

/** 合成一份"上个月"的假微信账单（行由本文件给定，日期动态算上月）。 */
function makePrevMonthBillBuffer(): ArrayBuffer {
  const rows: string[][] = [
    [
      `${PREV}-05 10:12:00`,
      '商户消费',
      '星巴克咖啡',
      '拿铁',
      '支出',
      '¥35.00',
      '零钱',
      '支付成功',
      'WXPREV0001',
      'MPREV1',
      '',
    ],
    [
      `${PREV}-20 19:40:00`,
      '商户消费',
      '京东超市',
      '日用品',
      '支出',
      '¥65.00',
      '零钱',
      '支付成功',
      'WXPREV0002',
      'MPREV2',
      '',
    ],
  ]
  const ws = XLSX.utils.aoa_to_sheet([WECHAT_HEADER, ...rows])
  const wb = XLSX.utils.book_new()
  XLSX.utils.book_append_sheet(wb, ws, '微信支付账单')
  return XLSX.write(wb, { type: 'array', bookType: 'xlsx' }) as ArrayBuffer
}

/** 把合成账单拖进速记行 → 提交 → 落批次待决门 → 点确认（走 read_bill → apply_bill 真路径）。 */
async function importBill(page: Page, buf: ArrayBuffer): Promise<void> {
  await page.getByTestId('nav-inbox').click()
  const capture = page.getByLabel('速记行')
  await capture.press('Escape')
  const b64 = Buffer.from(new Uint8Array(buf)).toString('base64')
  await page.evaluate(
    ({ data }) => {
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
      if (!el) throw new Error('拖拽目标不存在：capture-bar')
      for (const t of ['dragover', 'drop']) {
        el.dispatchEvent(new DragEvent(t, { bubbles: true, cancelable: true, dataTransfer: dt }))
      }
    },
    { data: b64 },
  )
  await expect(page.getByTestId('capture-bill').first(), '账单没解析成速记行 chip').toBeVisible()
  await capture.fill('把这张账单记一下')
  await capture.press('Enter')
  const card = page.locator('[data-testid="inbox-card"][data-kind="batch_confirm"]')
  await expect(card, '账单没落出批次待确认门').toBeVisible({ timeout: 30_000 })
  await card.getByTestId('inbox-confirm').click()
  await expect(card, '点确认后批次门没消失').toHaveCount(0)
}

/** 外壳（文档根）有没有发生整页滚动：scrollingElement 高度必须 <= 视口高。 */
async function shellPageOverflow(page: Page): Promise<number> {
  return page.evaluate(() => {
    const el = document.scrollingElement ?? document.documentElement
    return el.scrollHeight - window.innerHeight
  })
}

/** 主进程侧故障注入开关：把真 handler 包一层，on=true 时抛错，on=false 时透传真实现。 */
async function setReportMonthsFail(app: ElectronApplication, on: boolean): Promise<void> {
  await app.evaluate(({ ipcMain }, fail) => {
    const w = globalThis as unknown as Record<string, unknown>
    const handlers = (ipcMain as unknown as { _invokeHandlers: Map<string, (e: unknown, c?: number) => unknown> })
      ._invokeHandlers
    if (typeof w.__mzOrigReportMonths !== 'function') {
      const orig = handlers.get('mz:reportMonths')
      if (!orig) throw new Error('主进程没有 mz:reportMonths 的 handler（故障注入前提不成立）')
      w.__mzOrigReportMonths = orig
      w.__mzReportCalls = 0
      ipcMain.removeHandler('mz:reportMonths')
      ipcMain.handle('mz:reportMonths', (e: unknown, count?: number) => {
        w.__mzReportCalls = (w.__mzReportCalls as number) + 1
        if (w.__mzReportFail) throw new Error('演示注入：报告查询失败')
        return (w.__mzOrigReportMonths as (e: unknown, c?: number) => unknown)(e, count)
      })
    }
    w.__mzReportFail = fail
  }, on)
}

async function reportMonthsCalls(app: ElectronApplication): Promise<number> {
  return app.evaluate(() => (globalThis as unknown as Record<string, number>).__mzReportCalls ?? -1)
}

// ---------------------------------------------------------------------------

test.describe('报告屏（跨两个月的真实数据）', () => {
  let app: ElectronApplication
  let page: Page
  const pageErrors: string[] = []

  test.beforeAll(async () => {
    const launched = await launchIsolated()
    app = launched.app
    page = launched.page
    page.on('pageerror', (e) => pageErrors.push(String(e)))
    await readyMock(page)
    // 上月：合成账单（常识表兜住分类 → 直接已确认入账）
    await importBill(page, makePrevMonthBillBuffer())
    // 本月：速记行记一笔（离线演示 → record 工具 → 已确认）
    const capture = page.getByLabel('速记行')
    await capture.fill('滴滴打车 28')
    await capture.press('Enter')
    await expect(capture).toHaveValue('')
    // 等引擎把这一轮收尾（入账事件随后广播，报告屏会自己刷新）
    await expect(page.getByTestId('nav-inbox')).toBeVisible()
    await page.getByTestId('nav-report').click()
    await expect(page.getByTestId('report-hero')).toBeVisible({ timeout: 30_000 })
  })

  test.afterAll(async () => {
    await app?.close()
  })

  test('报告① 当月大卡与夹具数据一致：支出/收入/笔数/分类 Top/环比，预算条三档', async () => {
    // 强对账：先问后端要真值（服务端口径，界面不得自己反算）
    const rep = await page.evaluate((m: string) => window.mz.latestReport(m), CUR)
    expect(rep, '后端没返回本月月报').not.toBeNull()
    expect(rep?.totalExpenseCents).toBe(2800)
    expect(rep?.totalIncomeCents).toBe(0)
    expect(rep?.countExpense).toBe(1)
    expect(rep?.countIncome).toBe(0)
    expect(rep?.topCategories.map((c) => c.category)).toEqual(['交通'])

    // 界面数字逐字对上
    await expect(page.getByTestId('report-month')).toHaveText(monthLabel(CUR))
    await expect(page.getByTestId('report-expense')).toHaveText(CUR_EXPENSE)
    await expect(page.getByTestId('report-income')).toHaveText('¥0.00')
    await expect(page.getByTestId('report-count-expense')).toHaveText('1 笔')
    await expect(page.getByTestId('report-count-income')).toHaveText('0 笔')
    // 分类 Top 条：可点，且条上写明金额/笔数/占比
    const cat = page.getByTestId('report-cat')
    await expect(cat).toHaveCount(1)
    await expect(cat).toHaveAttribute('data-category', '交通')
    await expect(cat).toContainText(CUR_EXPENSE)
    await expect(cat).toContainText('1 笔')
    await expect(cat).toContainText('100%')
    // 环比：↓ + 金额 + 百分比（上月 ¥100.00 → 本月 ¥28.00，少 72.0%）
    const delta = page.getByTestId('report-delta')
    await expect(delta).toContainText('↓')
    await expect(delta).toContainText('72.0%')
    await expect(delta).toContainText('少花 ¥72.00') // 金额是「较上月少花的差额」，不是上月总数
    await expect(delta).toContainText(PREV)

    // 预算：没设预算就不画条（不拿 0 元预算画一根满条）
    await expect(page.getByTestId('report-budget')).toHaveCount(0)

    // 设预算 30 元 → 本月已用 93.3% → 超 90% 转黄
    await page.evaluate(() => window.mz.setBudget(3000))
    await page.getByTestId('report-prev-month').click() // 切走再切回 = 重新取数
    await page.getByTestId('report-next-month').click()
    await expect(page.getByTestId('report-budget')).toBeVisible()
    await expect(page.getByTestId('report-budget-remain')).toHaveText('剩余 ¥2.00')
    await expect(page.getByTestId('report-budget-fill')).toHaveClass(/is-warn/)

    // 预算 20 元 → 超支 → 转红
    await page.evaluate(() => window.mz.setBudget(2000))
    await page.getByTestId('report-prev-month').click()
    await page.getByTestId('report-next-month').click()
    await expect(page.getByTestId('report-budget-fill')).toHaveClass(/is-over/)
    await expect(page.getByTestId('report-budget-remain')).toHaveText('已超支 ¥8.00')

    // 预算 100 元 → 正常档
    await page.evaluate(() => window.mz.setBudget(10000))
    await page.getByTestId('report-prev-month').click()
    await page.getByTestId('report-next-month').click()
    await expect(page.getByTestId('report-budget-fill')).toHaveClass(/is-ok/)
  })

  test('报告② 历史网格 N 张卡（近 12 个月）、点卡切换当月大卡', async () => {
    const cards = page.getByTestId('report-month-card')
    await expect(cards, '历史网格不是 12 张卡').toHaveCount(12)

    // 窗口从"上个月"到"本月"逐月连续（后端 listMonthSummaries 补零，不是"有数据才有卡"）
    const months = await page.evaluate(() => window.mz.reportMonths(12))
    expect(months.map((m) => m.month)).toEqual(
      Array.from({ length: 12 }, (_, i) => monthKey(new Date(NOW.getFullYear(), NOW.getMonth() - 11 + i, 1))),
    )
    expect(months.filter((m) => m.empty)).toHaveLength(10)

    // 卡上写的是该月自己的数字
    const curCard = page.locator(`[data-testid="report-month-card"][data-month="${CUR}"]`)
    await expect(curCard).toHaveCount(1)
    await expect(curCard).toContainText(CUR_EXPENSE)
    await expect(curCard).toHaveAttribute('aria-current', 'true')
    const prevCard = page.locator(`[data-month="${PREV}"]`)
    await expect(prevCard).toContainText(PREV_EXPENSE)
    await expect(prevCard).toHaveAttribute('data-empty', 'false')
    // 更早的月份是空卡（"无记录"而不是 ¥0.00 冒充有数据）
    const older = page.locator(`[data-month="${monthKey(new Date(NOW.getFullYear(), NOW.getMonth() - 3, 1))}"]`)
    await expect(older).toHaveAttribute('data-empty', 'true')
    await expect(older).toContainText('无记录')

    // 点上一月的卡 → 大卡整体切过去（月份标题 + 支出 + 笔数 + 分类 Top）
    await prevCard.click()
    await expect(page.getByTestId('report-month')).toHaveText(monthLabel(PREV))
    await expect(page.getByTestId('report-expense')).toHaveText(PREV_EXPENSE)
    await expect(page.getByTestId('report-count-expense')).toHaveText('2 笔')
    await expect(page.getByTestId('report-cat')).toHaveCount(2)
    await expect(page.getByTestId('report-cat').first()).toHaveAttribute('data-category', '购物')
    await expect(page.getByTestId('report-current-tag')).toHaveCount(0)
    await expect(prevCard).toHaveAttribute('aria-current', 'true')

    // 点一个空月 → 大卡说清"这个月没有"，不编数字
    await older.click()
    await expect(page.getByTestId('report-month-empty')).toContainText(monthLabel(monthKey(new Date(NOW.getFullYear(), NOW.getMonth() - 3, 1))))
    await expect(page.getByTestId('report-expense')).toHaveText('¥0.00')
    await expect(page.getByTestId('report-cat')).toHaveCount(0)

    // 回到本月（后续用例从本月出发）
    await curCard.click()
    await expect(page.getByTestId('report-expense')).toHaveText(CUR_EXPENSE)
  })

  test('报告③ 点分类条 → 切到账本，且「该月 + 该分类」筛选 chip 已带上', async () => {
    await page.getByTestId('report-cat').first().click() // 交通
    await expect(page.getByTestId('ledger-view'), '点分类条没切到账本').toBeVisible()
    await expect(page.getByTestId('nav-ledger')).toHaveAttribute('aria-current', 'page')

    // 筛选 chip 两个都在：月份 + 分类（值取自报告屏点的那一条）
    const rangeChip = page.getByTestId('ledger-chip-range')
    await expect(rangeChip).toContainText(CUR)
    const catChip = page.getByTestId('ledger-chip-category')
    await expect(catChip).toContainText('分类：交通')

    // 筛选条控件与表格也跟着（真走服务端，不是前端过滤）
    await expect(page.getByTestId('ledger-f-month')).toHaveValue('custom')
    await expect(page.getByTestId('ledger-f-month-custom')).toHaveValue(CUR)
    await expect(page.getByTestId('ledger-f-category')).toHaveValue('交通')
    const rows = page.locator('[data-testid="ledger-row"]')
    await expect(rows, '按交通筛本月应是 1 行').toHaveCount(1)
    await expect(rows.first()).toContainText('滴滴打车')
    await expect(rows.first()).toContainText(CUR_EXPENSE)
    // 服务端口径对账
    const server = await page.evaluate(
      (f: { month: string; category: string }) => window.mz.listLedger({ ...f, limit: 50 }),
      { month: CUR, category: '交通' },
    )
    expect(server.total).toBe(1)

    // 回报告屏继续（下一条用例要零页面滚动）
    await page.getByTestId('nav-report').click()
    await expect(page.getByTestId('report-hero')).toBeVisible()
  })

  test('报告④ 报告屏在自身区域内滚，应用本体零整页滚动', async () => {
    // 有内容（两月有数 + 12 张卡）时也必须是零整页滚动
    expect(await shellPageOverflow(page), '报告屏出现了整页长条滚动').toBeLessThanOrEqual(0)
    expect(
      await page.getByTestId('report-view').evaluate((el) => getComputedStyle(el).overflowY),
      '报告屏区域不是可滚容器',
    ).toBe('auto')

    // 把窗口压矮逼出溢出：滚的必须是报告屏自己，整页依旧不动
    await page.setViewportSize({ width: 1280, height: 520 })
    const area = page.getByTestId('report-view')
    const metrics = await area.evaluate((el) => ({ scrollHeight: el.scrollHeight, clientHeight: el.clientHeight }))
    expect(metrics.scrollHeight, '压矮窗口后报告屏内容仍没撑出可滚高度').toBeGreaterThan(metrics.clientHeight)
    const scrolled = await area.evaluate((el) => {
      el.scrollTop = 200
      return el.scrollTop
    })
    expect(scrolled, '报告屏区域滚不动').toBeGreaterThan(0)
    expect(await shellPageOverflow(page), '压矮窗口后整页出现长条滚动').toBeLessThanOrEqual(0)
  })

  test('报告⑤ 全程无未捕获异常', async () => {
    expect(pageErrors, `页面有未捕获异常：${pageErrors.join(' | ')}`).toHaveLength(0)
  })
})

// ---------------------------------------------------------------------------

test.describe('报告屏（空账本与出错态）', () => {
  let app: ElectronApplication
  let page: Page
  const pageErrors: string[] = []

  test.beforeAll(async () => {
    const launched = await launchIsolated()
    app = launched.app
    page = launched.page
    page.on('pageerror', (e) => pageErrors.push(String(e)))
    await readyMock(page)
    await page.getByTestId('nav-report').click()
    await expect(page.getByTestId('report-view')).toBeVisible()
  })

  test.afterAll(async () => {
    await app?.close()
  })

  test('报告⑥ 空态：还没有可生成的报告 + 引导记第一笔（聚焦速记行）', async () => {
    const empty = page.getByTestId('report-empty')
    await expect(empty).toBeVisible()
    await expect(empty).toContainText('还没有可生成的报告')
    // 空态必须给出路：主按钮把焦点送到速记行
    await page.getByTestId('report-empty-cta').click()
    await expect(page.getByLabel('速记行')).toBeFocused()
    // 空账本时不该出现大卡与历史网格（没有数据就别摆一张空卡）
    await expect(page.getByTestId('report-hero')).toHaveCount(0)
    await expect(page.getByTestId('report-months')).toHaveCount(0)
  })

  test('报告⑦ 出错态：主进程真抛错 → 报告生成失败 + [重新生成]；修好后重试即恢复', async () => {
    await setReportMonthsFail(app, true)
    const before = await reportMonthsCalls(app)
    // 切走再切回 = 重新挂载并重查
    await page.getByTestId('nav-inbox').click()
    await page.getByTestId('nav-report').click()
    const err = page.getByTestId('report-error')
    await expect(err, '真抛错时没进错误态').toBeVisible()
    await expect(err).toContainText('报告生成失败')
    await expect(err).toContainText('演示注入：报告查询失败')
    expect(await reportMonthsCalls(app), '错误态不是真查库的结果').toBeGreaterThan(before)
    // 错误态里不摆大卡/网格（别拿半截数据冒充成功）
    await expect(page.getByTestId('report-hero')).toHaveCount(0)
    await expect(page.getByTestId('report-months')).toHaveCount(0)

    // [重新生成]：故障未修 → 仍报错，但必须**真的重查了一次**（计数器涨）
    const mid = await reportMonthsCalls(app)
    await page.getByTestId('report-retry').click()
    await expect(err).toBeVisible()
    expect(await reportMonthsCalls(app), '[重新生成] 没有真的重查').toBeGreaterThan(mid)

    // 故障修好 → 再点 [重新生成] → 界面恢复（这里是空账本，回到空态）
    await setReportMonthsFail(app, false)
    await page.getByTestId('report-retry').click()
    await expect(page.getByTestId('report-error')).toHaveCount(0)
    await expect(page.getByTestId('report-empty')).toBeVisible()
    expect(pageErrors, `页面有未捕获异常：${pageErrors.join(' | ')}`).toHaveLength(0)
  })
})
