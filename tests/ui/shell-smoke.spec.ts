// UI 自动巡检（Playwright × Electron，_electron.launch）——新外壳（方向 A）。
//
// 覆盖范围：左栏五项导航 / 五屏可达 / 速记行存在 / 本地数据锁标 / 深浅主题切换 / 无未捕获异常。
// 每落地一屏，就在本文件追加该屏的用例（旧 UI 的用例冻结在 ui-inspection.legacy.ts，按需迁移）。
//
// 纪律：
//   ① 数据目录必须隔离——MZ_DATA_DIR 指向临时目录 + --user-data-dir=<临时目录>，
//      绝不触碰真实账本 %APPDATA%\mingzhang（单实例锁也随之隔离）。
//   ② 需要模型回复的用例一律走离线演示（MZ_MOCK），不联网、不烧 key。
//   ③ 新用例要求「连跑两遍全绿」（防 flaky）。

import { test, expect, _electron, type ElectronApplication, type Page } from '@playwright/test'
import { mkdtempSync, readFileSync, existsSync, unlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { makeWechatXlsxBuffer } from '../xlsx-fixture'
import { startFakeProvider } from '../fake-provider'

let app: ElectronApplication
let page: Page
let dataDir: string
const pageErrors: string[] = []

test.beforeAll(async () => {
  dataDir = mkdtempSync(join(tmpdir(), 'mz-shell-data-'))
  const userDataDir = mkdtempSync(join(tmpdir(), 'mz-shell-udd-'))

  app = await _electron.launch({
    args: ['.', `--user-data-dir=${userDataDir}`],
    env: { ...process.env, MZ_DATA_DIR: dataDir } as Record<string, string>,
  })
  page = await app.firstWindow()
  // Electron 主日志里的未捕获异常也一并收集（渲染层 pageerror 是主要来源）
  page.on('pageerror', (e) => pageErrors.push(String(e)))

  await page.waitForSelector('.mz-shell', { timeout: 30_000 })
})

test.afterAll(async () => {
  await app?.close()
})

const NAV_LABELS: [string, string][] = [
  ['inbox', '收件箱'],
  ['ledger', '账本'],
  ['report', '报告'],
  ['accounts', '账户'],
  ['settings', '设置'],
]

test('外壳① 左栏导航五项齐全，默认停在收件箱', async () => {
  await expect(page.getByText('明账', { exact: true })).toBeVisible()
  await expect(page.getByText('本地记账 · 不上云')).toBeVisible()

  for (const [id, label] of NAV_LABELS) {
    const item = page.getByTestId(`nav-${id}`)
    await expect(item).toBeVisible()
    await expect(item).toContainText(label)
  }

  // 收件箱是唯一默认屏（规格 §1.2）。收件箱已是真实屏（不再是占位），断点相应改成 inbox-view。
  await expect(page.getByTestId('nav-inbox')).toHaveAttribute('aria-current', 'page')
  await expect(page.getByTestId('inbox-view')).toBeVisible()
  await expect(page.getByTestId('inbox-view')).toContainText('收件箱')
})

test('外壳② 五屏都可达（切屏后选中态跟随）', async () => {
  // 账本已是真实屏（不再是占位），断点相应改成 ledger-view —— 与外壳① 对收件箱的处理同口径。
  await page.getByTestId('nav-ledger').click()
  await expect(page.getByTestId('ledger-view')).toBeVisible()
  await expect(page.getByTestId('nav-ledger')).toHaveAttribute('aria-current', 'page')

  // 报告屏也已是真实屏（不再是占位），断点相应改成 report-view —— 与外壳① 对收件箱、② 对账本的处理同口径。
  await page.getByTestId('nav-report').click()
  await expect(page.getByTestId('report-view')).toBeVisible()

  await page.getByTestId('nav-accounts').click()
  await expect(page.getByTestId('view-placeholder')).toContainText('账户')

  // 设置屏复用既有 SettingsView：能进去、能看见它自己的小标题
  await page.getByTestId('nav-settings').click()
  await expect(page.getByTestId('settings-route')).toBeVisible()
  await expect(page.getByRole('heading', { name: '设置', exact: true })).toBeVisible()

  await page.getByTestId('nav-inbox').click()
  await expect(page.getByTestId('inbox-view')).toBeVisible()
})

test('外壳③ 速记行常驻：占位文案 + Ctrl K 提示', async () => {
  const capture = page.getByLabel('速记行')
  await expect(capture).toBeVisible()
  await expect(capture).toHaveAttribute('placeholder', /说一句，或把截图拖进来/)
  await expect(page.getByText('Ctrl K')).toBeVisible()

  // 速记行是五屏共享的：切到账本后仍在
  await page.getByTestId('nav-ledger').click()
  await expect(page.getByLabel('速记行')).toBeVisible()
  await page.getByTestId('nav-inbox').click()
})

test('外壳④ 本地数据锁标常驻，且指向隔离的数据目录', async () => {
  const lock = page.getByTestId('lock-badge')
  await expect(lock).toBeVisible()
  await expect(lock).toContainText('本地加密')

  // 强断言：锁标指向的是本次运行的临时数据目录（证明确实隔离，没连真账本）。
  // §2.3 原文口径：第二行是快照时间，数据目录挪到 title/悬浮——所以目录改由
  // data-datadir 属性 + title 双重承载，可见文案不再要求出现目录名。
  const leaf = basename(dataDir)
  expect(await lock.getAttribute('data-datadir')).toBe(dataDir)
  expect(leaf.length).toBeGreaterThan(0)
  await expect(lock).toHaveAttribute('title', dataDir)
  // 第二行＝快照时间（不是数据目录）
  await expect(page.getByTestId('lock-snapshot')).toContainText(/快照|尚未快照/)
})

test('外壳⑤ 深浅主题切换：token 与 data-theme 同步往返', async () => {
  const token = () =>
    page.evaluate(() => getComputedStyle(document.querySelector('.mz-shell')!).getPropertyValue('--bg-0').trim())
  const dataTheme = () => page.evaluate(() => document.documentElement.dataset.theme)

  // 初值由配置决定（全新数据目录的默认是 dark），所以这里只断言「DOM 与配置同口径」，
  // 不硬编码 dark——默认主题是产品决定，不该由用例锁死。
  const initial = await dataTheme()
  expect(['dark', 'light']).toContain(initial)
  const tokenOf = (t: string) => (t === 'dark' ? '#0e1013' : '#f7f8fa')
  expect(await token()).toBe(tokenOf(initial))

  await page.getByTestId('theme-toggle').click()
  const flipped = initial === 'dark' ? 'light' : 'dark'
  await expect(page.locator('html')).toHaveAttribute('data-theme', flipped)
  expect(await token()).toBe(tokenOf(flipped))

  // 切回来，保证用例可重复（连跑两遍）
  await page.getByTestId('theme-toggle').click()
  await expect(page.locator('html')).toHaveAttribute('data-theme', initial)
  expect(await token()).toBe(tokenOf(initial))
})

test('外壳⑥ 全程无未捕获异常', async () => {
  expect(pageErrors).toEqual([])
})

// 主题写盘往返：左栏切换 → IPC 按新枚举写 config.json → getState() 与 DOM 同口径。
// 锁的是「参数按新枚举走通」这一条链路（旧命名 mint 时代 getState 只会吐 'dark' | 'mint'）。
test('外壳⑦ 主题写盘往返：getState() 与 DOM data-theme 同口径，且为新枚举', async () => {
  const dataTheme = () => page.evaluate(() => document.documentElement.dataset.theme)
  const stateTheme = () => page.evaluate(() => window.mz.getState().then((s) => s.theme))

  const initial = await dataTheme()
  expect(['dark', 'light']).toContain(initial)

  await page.getByTestId('theme-toggle').click()
  const flipped = initial === 'dark' ? 'light' : 'dark'
  await expect(page.locator('html')).toHaveAttribute('data-theme', flipped)

  // IPC 已按新枚举写盘：getState()（重新读 config.json）与 DOM 同口径
  await expect.poll(() => stateTheme(), { timeout: 10_000 }).toBe(flipped)
  expect(await stateTheme()).toBe(flipped)
  // 现行情形枚举只有 dark / light——旧命名不再出现
  expect(['dark', 'light']).toContain(await stateTheme())

  // 落盘的真文件也是新枚举（证明写的是 config.json 而不是只在内存里翻个面）
  const onDisk = (JSON.parse(readFileSync(join(dataDir, 'config.json'), 'utf8')) as { theme: string }).theme
  expect(onDisk).toBe(flipped)
  expect(['dark', 'light']).toContain(onDisk)

  // 切回原值，保证用例可重复（连跑两遍）
  await page.getByTestId('theme-toggle').click()
  await expect(page.locator('html')).toHaveAttribute('data-theme', initial)
  await expect.poll(() => stateTheme(), { timeout: 10_000 }).toBe(initial)
})

// 原生标题栏跟随应用主题（用户实测反馈：Windows 深色系统 + 应用浅色主题 → 顶部一条黑框）。
// 口径：主进程 nativeTheme.themeSource 必须与 DOM data-theme 同值——由它决定 Windows
// 原生标题栏的明暗（实测 DWM 属性 20：light→0 浅色条，dark→1 深色条）。
// 锁这条是为了防回归成默认的 'system'：那会让标题栏跟着操作系统而不是跟着应用。
test('外壳⑧ 原生标题栏跟随应用主题：nativeTheme.themeSource 与 data-theme 同口径', async () => {
  const dataTheme = () => page.evaluate(() => document.documentElement.dataset.theme)
  const nativeSource = () => app.evaluate(({ nativeTheme }) => nativeTheme.themeSource)

  const initial = await dataTheme()
  expect(['dark', 'light']).toContain(initial)
  // 不断言等于 'system'：应用主题本身就该是显式的 dark/light
  expect(await nativeSource()).toBe(initial)

  await page.getByTestId('theme-toggle').click()
  const flipped = initial === 'dark' ? 'light' : 'dark'
  await expect(page.locator('html')).toHaveAttribute('data-theme', flipped)
  await expect.poll(nativeSource, { timeout: 10_000 }).toBe(flipped)

  // 切回原值，保证用例可重复（连跑两遍）
  await page.getByTestId('theme-toggle').click()
  await expect(page.locator('html')).toHaveAttribute('data-theme', initial)
  await expect.poll(nativeSource, { timeout: 10_000 }).toBe(initial)
})

// ---------------------------------------------------------------------------
// 主题开关唯一化（用户实测反馈单）
//
// 用户拍板：主题开关只留左下角那一个，设置页里那份整个删掉；同时修掉左右不同步的根因。
// 本段锁两件事：
//   ① 唯一化——全应用 theme-toggle 恰好 1 个且在左栏；设置页三个分页逐页看不到「外观」块。
//   ② 不回弹——左下角切完主题后进设置页再返回收件箱，data-theme 仍是被切后的值
//      （防「拿旧 App 级 state 又把它同步回去」这类回归）。
// 初值一律从 DOM 读再算 flipped，不硬编码 dark（沿用外壳⑤的口径）。
// ---------------------------------------------------------------------------

/** 设置页三个分页（逐页断言：哪个分页都不许再有主题切换）。 */
const SETTINGS_TABS = ['模型服务', '账单与备份', '数据储存'] as const

test('外壳⑬ 主题开关唯一化：全应用只剩左栏那一个，设置页三个分页都没有', async () => {
  // ① 全应用恰好一个主题开关，且它就在左栏（主导航）里
  await expect(page.getByTestId('theme-toggle'), '全应用应当只剩一个主题开关').toHaveCount(1)
  await expect(
    page.getByRole('navigation', { name: '主导航' }).getByTestId('theme-toggle'),
    '剩下的这个主题开关不在左栏里',
  ).toHaveCount(1)

  // ② 逐个分页翻过去：每页都看不到「外观」标题，也看不到那两个主题按钮
  //    （旧实现把外观卡写在三个分页的条件之外，所以哪一页都躲不掉）
  await page.getByTestId('nav-settings').click()
  const settings = page.getByTestId('settings-route')
  await expect(settings).toBeVisible()

  for (const label of SETTINGS_TABS) {
    await settings.getByRole('tab', { name: label }).click()
    await expect(
      settings.getByRole('heading', { name: '外观', exact: true }),
      `「${label}」分页里不该再有「外观」块`,
    ).toHaveCount(0)
    await expect(
      settings.getByRole('button', { name: '薄荷浅色', exact: true }),
      `「${label}」分页里不该再有「薄荷浅色」按钮`,
    ).toHaveCount(0)
    await expect(
      settings.getByRole('button', { name: '深色', exact: true }),
      `「${label}」分页里不该再有「深色」按钮`,
    ).toHaveCount(0)
  }

  await page.getByTestId('nav-inbox').click()
  await expect(page.getByTestId('inbox-view')).toBeVisible()
})

test('外壳⑭ 不回弹：左下角切主题 → 进设置页 → 返回收件箱，data-theme 仍是被切后的值', async () => {
  const dataTheme = () => page.evaluate(() => document.documentElement.dataset.theme)

  const initial = await dataTheme()
  expect(['dark', 'light']).toContain(initial)
  const flipped = initial === 'dark' ? 'light' : 'dark'

  // 点左下角开关：先本地生效、不等 IPC 的即时手感
  await page.getByTestId('theme-toggle').click()
  await expect(page.locator('html')).toHaveAttribute('data-theme', flipped)

  // 进设置页再返回收件箱。这一来一回会重新拿到 App 级 state；
  // 那里若还留着旧主题，ShellBody 的同步 effect 就把 DOM 翻回去 —— 用户看到的正是这个不同步。
  await page.getByTestId('nav-settings').click()
  const settings = page.getByTestId('settings-route')
  await expect(settings).toBeVisible()
  await settings.getByRole('button', { name: '返回收件箱' }).click()
  await expect(page.getByTestId('inbox-view')).toBeVisible()

  // 稍等一拍再断言：晚到的那次 state 同步也会被这一条抓住
  await page.waitForTimeout(500)
  await expect(
    page.locator('html'),
    '进设置页再返回后主题被读旧的 state 翻了回去（不同步回归）',
  ).toHaveAttribute('data-theme', flipped)

  // 切回原值，保证用例可重复（连跑两遍）
  await page.getByTestId('theme-toggle').click()
  await expect(page.locator('html')).toHaveAttribute('data-theme', initial)
})

// ---------------------------------------------------------------------------
// 速记行拖拽（缺陷单：拖文件进窗口没反应）
//
// 回归原点：新外壳 CaptureBar 的 addFiles() 只收 image/*，其余一律静默 return
// （用户实拖 XLSX 账单进窗口，界面毫无反应）。老版 ChatApp.tsx 本来就有完整 CSV/XLSX 管线。
// 本段锁死：账单文件进得来（chip 可见）、不支持的格式有明确提示、图片路径不受影响、
// 拖到窗口非速记行区域同样接得住。
//
// 账单字节来自 tests/xlsx-fixture.ts **脚本合成的假账单**（红线：不读用户真实账单），
// 经 base64 送进页面再 new File + new DataTransfer + 合成 DragEvent。
// ---------------------------------------------------------------------------

/** 往目标元素上合成一次"拖文件进来"：dragover + drop（bubbles/cancelable）。 */
async function dropFileInto(
  selector: string,
  f: { name: string; type: string; b64: string },
): Promise<void> {
  await page.evaluate(
    ({ sel, file }) => {
      const bin = atob(file.b64)
      const bytes = new Uint8Array(bin.length)
      for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i)
      const dt = new DataTransfer()
      dt.items.add(new File([bytes], file.name, { type: file.type }))
      const el = document.querySelector(sel)
      if (!el) throw new Error(`拖拽目标不存在：${sel}`)
      for (const type of ['dragover', 'drop']) {
        el.dispatchEvent(new DragEvent(type, { bubbles: true, cancelable: true, dataTransfer: dt }))
      }
    },
    { sel: selector, file: f },
  )
}

/** 清掉速记行里的暂存内容与状态提示，保证后续用例从同一状态起步（连跑两遍）。 */
async function resetCapture(): Promise<void> {
  const capture = page.getByLabel('速记行')
  if (await capture.count()) await capture.press('Escape')
  await page.evaluate(() => {
    const v = (window as unknown as { __mzInbox?: { setProgress: (s: string) => void } }).__mzInbox
    v?.setProgress('')
  })
}

test('外壳⑨ 拖入 XLSX 账单：速记行出现「账单材料」chip，不再静默', async () => {
  await resetCapture()
  const b64 = Buffer.from(new Uint8Array(makeWechatXlsxBuffer())).toString('base64')
  await dropFileInto('[data-testid="capture-bar"]', {
    name: '账单.xlsx',
    type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    b64,
  })

  // 核心验收点：拖账单进来必须有可见落点（原来是什么都没发生）
  const bills = page.getByTestId('capture-bills')
  await expect(bills).toBeVisible()
  const chip = page.getByTestId('capture-bill').first()
  await expect(chip).toContainText('账单.xlsx')
  // chip 标出行数（夹具 4 行数据）
  await expect(chip).toContainText('4 行')
  // 拖账单不该报解析失败
  await expect(page.getByTestId('capture-error')).toHaveCount(0)
  await resetCapture()
})

test('外壳⑩ 拖入 .txt：明确提示「暂不支持」，不静默丢弃', async () => {
  await resetCapture()
  await dropFileInto('[data-testid="capture-bar"]', {
    name: '随手记.txt',
    type: 'text/plain',
    b64: Buffer.from('随手记点什么', 'utf8').toString('base64'),
  })

  const err = page.getByTestId('capture-error')
  await expect(err).toBeVisible()
  await expect(err).toContainText('暂不支持')
  await expect(err).toContainText('随手记.txt')
  // 提示必须说清支持范围（用户才知道该拖什么）
  await expect(err).toContainText('图片截图')
  await expect(err).toContainText('CSV')
  await resetCapture()
})

test('外壳⑪ 拖入 PNG：图片缩略图照常出现（回归保护）', async () => {
  await resetCapture()
  // 1×1 透明 PNG
  const png =
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='
  await dropFileInto('[data-testid="capture-bar"]', { name: '截图.png', type: 'image/png', b64: png })

  const thumbs = page.getByTestId('capture-thumbs')
  await expect(thumbs).toBeVisible()
  await expect(thumbs.locator('img')).toHaveCount(1)
  // 图片不该被账单 chip 误标
  await expect(page.getByTestId('capture-bill')).toHaveCount(0)
  await resetCapture()
})

test('外壳⑫ 拖到窗口非速记行区域（整窗接住）：同样解析出账单 chip', async () => {
  await resetCapture()
  const b64 = Buffer.from(new Uint8Array(makeWechatXlsxBuffer())).toString('base64')
  // 目标是整个应用外壳，不是速记行那条窄栏
  await dropFileInto('[data-testid="app-shell"]', {
    name: '整窗账单.xlsx',
    type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    b64,
  })

  const chip = page.getByTestId('capture-bill').first()
  await expect(chip).toBeVisible()
  await expect(chip).toContainText('整窗账单.xlsx')
  await resetCapture()
})

// ---------------------------------------------------------------------------
// 收件箱主屏（数据接线单，方向 A 第 2 切片）
//
// 全部走离线演示（MZ_MOCK 假模型）：不联网、不烧 key；数据目录仍是临时目录。
// 离线演示的确定性剧本里「账单」→ commit_batch(2 笔可入账 + 1 笔缺金额)
// → 落一个 batch_confirm 待决门，正好用来验收「提交 → 出卡 → 确认 → 卡片消失」全链路。
// ---------------------------------------------------------------------------

test.describe('收件箱（真实数据）', () => {
  test.beforeAll(async () => {
    // 引擎就绪是异步的：开 mock 后轮询 sendChat，失败就重试（只发无副作用的「待收尾」查询）
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
    await page.getByTestId('nav-inbox').click()
  })

  test('收件箱① 全新数据目录先给空态：不是死屏，是下一步动作', async () => {
    await expect(page.getByTestId('inbox-view')).toBeVisible()
    await expect(page.getByTestId('inbox-empty')).toBeVisible()
    await expect(page.getByTestId('inbox-empty')).toContainText('收件箱是空的')
    // 空态必须给出路：主按钮能跳到本月报告
    await page.getByTestId('inbox-empty').getByRole('button', { name: '查看本月报告' }).click()
    // 报告屏从占位转真屏后，占位断点改成该屏视图根（与收件箱/账本同口径），语义不变或更强。
    await expect(page.getByTestId('report-view')).toBeVisible()
    await page.getByTestId('nav-inbox').click()

    // 右栏三卡即使空态也在（本地数据 / 本月速览 / AI 记忆）
    await expect(page.getByTestId('aside-local')).toBeVisible()
    await expect(page.getByTestId('aside-report')).toBeVisible()
    await expect(page.getByTestId('aside-memory')).toBeVisible()
    // AI 记忆：后端无此通道，如实占位，绝不编数字
    await expect(page.getByTestId('aside-memory')).toContainText('待后端支持')
  })

  test('收件箱② 速记行可输入：回车提交 → 出现待决卡（含依据行与逐行明细）', async () => {
    // 先装观察哨：解析中卡片是瞬态，用 MutationObserver 记账，避免竞态断言
    await page.evaluate(() => {
      const w = window as unknown as { __mzSaw: { parsing: boolean } }
      w.__mzSaw = { parsing: false }
      const obs = new MutationObserver(() => {
        if (document.querySelector('[data-testid="inbox-parsing"]')) w.__mzSaw.parsing = true
      })
      obs.observe(document.body, { childList: true, subtree: true })
    })

    const capture = page.getByLabel('速记行')
    await expect(capture).toBeEnabled()
    await capture.fill('账单')
    await expect(capture).toHaveValue('账单')

    // 回车提交（§2.1：不再 readOnly）
    await capture.press('Enter')

    // 成功即清空输入
    await expect(capture).toHaveValue('')
    // 提交中出现过「待解析」卡片（AI 处理进展有可见落点）
    expect(await page.evaluate(() => (window as unknown as { __mzSaw: { parsing: boolean } }).__mzSaw.parsing)).toBe(true)

    // 真实待决卡：批量确认
    const card = page.locator('[data-testid="inbox-card"]').first()
    await expect(card).toBeVisible()
    await expect(card).toHaveAttribute('data-kind', 'batch_confirm')
    await expect(card).toContainText('批量确认')
    // 每张解析类卡片都有「依据」行
    await expect(card.getByTestId('inbox-basis')).toContainText('依据：')
    // 批量卡可展开逐行明细（真实 card.items）
    await card.getByTestId('inbox-batch-toggle').click()
    await expect(card.getByTestId('inbox-batch-items')).toBeVisible()
    await expect(card.getByTestId('inbox-batch-items').locator('.mz-batch-row')).toHaveCount(3)

    // 左栏角标与卡片流同源：1 项
    await expect(page.getByTestId('nav-inbox')).toContainText('1')
    // 右栏「待决」同源
    await expect(page.getByTestId('aside-pending')).toContainText('1 项')
  })

  test('收件箱③ 点确认后：批量门消失 + 回执可见 + 账目真的入账', async () => {
    const batchCard = page.locator('[data-testid="inbox-card"][data-kind="batch_confirm"]')
    await expect(batchCard).toBeVisible()

    await batchCard.getByTestId('inbox-confirm').click()

    // 操作后界面必须动：批量确认卡消失（不是留在原地装死）
    await expect(batchCard).toHaveCount(0)
    // 回执可见（§2.5 Toast）
    await expect(page.getByTestId('toast')).toBeVisible()
    // 批次里缺金额的那行转成「待核对」待办——真实后端行为，不假装全清空
    const rest = page.locator('[data-testid="inbox-card"][data-kind="batch_item"]')
    await expect(rest).toHaveCount(1)
    await expect(rest).toContainText('待核对')

    // 本月速览吃到真实数字：演示批次 12.00 + 34.00 = ¥46.00
    await expect(page.getByTestId('aside-expense')).toContainText('¥46.00')
    // 待决数与卡片流同源（剩 1 条待核对）
    await expect(page.getByTestId('aside-pending')).toContainText('1 项')
    await expect(page.getByTestId('nav-inbox')).toContainText('1')

    // 今天已记：默认折叠，展开后能看到刚入账的两笔
    const today = page.getByTestId('inbox-today')
    await expect(today).toContainText('今天已记 2 笔')
    await expect(page.getByTestId('inbox-today-list')).toHaveCount(0)
    await today.locator('button').click()
    await expect(page.getByTestId('inbox-today-list')).toBeVisible()
    await expect(page.getByTestId('inbox-today-list')).toContainText('演示甲')
    await expect(page.getByTestId('inbox-today-list')).toContainText('演示乙')
    await today.locator('button').click() // 收回，保持用例可重复
  })

  test('收件箱④ 待核对卡就地补答：answerPending 通道真通，队列清空回空态', async () => {
    const rest = page.locator('[data-testid="inbox-card"][data-kind="batch_item"]')
    await expect(rest).toBeVisible()

    await rest.getByLabel(/补金额/).fill('15 餐饮')
    await rest.getByRole('button', { name: '补录' }).click()

    // 补答后队列清空，回到空态；角标与待决数一起归零
    await expect(page.getByTestId('inbox-card')).toHaveCount(0)
    await expect(page.getByTestId('inbox-empty')).toBeVisible()
    await expect(page.getByTestId('aside-pending')).toContainText('0 项')
    await expect(page.getByTestId('nav-inbox')).not.toContainText('1')
    // 金额吃到账本：46.00 + 15.00 = ¥61.00
    await expect(page.getByTestId('aside-expense')).toContainText('¥61.00')
  })

  test('收件箱⑤ 删除确认卡：confirmGate 真通，软删除后本月聚合同步变小', async () => {
    // 离线演示剧本：「删掉 #1」→ prepareDeleteGate → delete_confirm 待决门（真实后端路径）
    const cap = page.getByLabel('速记行')
    await cap.fill('删掉 #1')
    await cap.press('Enter')

    const del = page.locator('[data-testid="inbox-card"][data-kind="delete_confirm"]')
    await expect(del).toBeVisible()
    await expect(del).toContainText('删除确认')
    await expect(del).toContainText('可撤回')
    // 依据行：删除类写明来源与「软删除可撤回」
    await expect(del.getByTestId('inbox-basis')).toContainText('依据：')
    await expect(del.getByTestId('inbox-basis')).toContainText('可撤回')
    // 待决数 +1
    await expect(page.getByTestId('aside-pending')).toContainText('1 项')

    await del.getByTestId('inbox-confirm').click()

    await expect(del).toHaveCount(0)
    await expect(page.getByTestId('toast')).toBeVisible()
    // 真的软删了：¥61.00 − ¥12.00 = ¥49.00（聚合排除已删除）
    await expect(page.getByTestId('aside-expense')).toContainText('¥49.00')
    await expect(page.getByTestId('inbox-empty')).toBeVisible()
  })

  test('收件箱⑥ 转账缺账户卡：如实显示原因，只给「忽略」，不给假按钮', async () => {
    // 离线演示剧本：含转账的批次 → 确认入账后，零钱通那笔缺转出/转入账户 → transfer_account 待办
    const cap = page.getByLabel('速记行')
    await cap.fill('账单里有零钱通转入')
    await cap.press('Enter')

    const batch = page.locator('[data-testid="inbox-card"][data-kind="batch_confirm"]')
    await expect(batch).toBeVisible()
    await batch.getByTestId('inbox-confirm').click()

    const tr = page.locator('[data-testid="inbox-card"][data-kind="transfer_account"]')
    await expect(tr).toBeVisible()
    await expect(tr).toContainText('待补账户')
    await expect(tr.getByTestId('inbox-basis')).toContainText('依据：')
    // 后端对转账待办拒绝「就地作答」，所以不该出现补录框或确认按钮
    await expect(tr.getByTestId('inbox-confirm')).toHaveCount(0)
    await expect(tr.getByLabel(/补金额/)).toHaveCount(0)
    await expect(tr.getByRole('button', { name: '忽略' })).toBeVisible()

    // 忽略即关闭这条待办
    await tr.getByRole('button', { name: '忽略' }).click()
    await expect(tr).toHaveCount(0)
    await expect(page.getByTestId('aside-pending')).toContainText('0 项')
  })

  test('收件箱⑦ 提交失败不静默：引擎未就绪时红字提示 + 输入内容保留', async () => {
    // 关掉离线演示 → 没有真实 provider，引擎不起 → sendChat 必失败
    await page.evaluate(() => (window.mz.setMock(false)))

    const capture = page.getByLabel('速记行')
    await capture.fill('午饭 35')
    await capture.press('Enter')

    const err = page.getByTestId('capture-error')
    await expect(err).toBeVisible()
    await expect(err).toContainText('没提交成功')
    // 失败不清空输入：用户可以改完重发
    await expect(capture).toHaveValue('午饭 35')
    await expect(capture).toBeEnabled()

    // 恢复离线演示，后续用例与「连跑两遍」都从同一状态起步
    await capture.fill('')
    await page.evaluate(() => (window.mz.setMock(true)))
  })

  test('收件箱⑧ 全程无未捕获异常', async () => {
    expect(pageErrors).toEqual([])
  })
})

// ---------------------------------------------------------------------------
// 账本屏（真实数据，方向 A 第 3 切片）
//
// 覆盖：空账本态 → 记一笔入账 → 表格出行 → 服务端筛选生效 → 行详情改分类后
//       表格与 agg 同步 → 删除 → 已删除筛选里可见并可恢复。
//
// 隔离：本段用**第二个 Electron 实例 + 全新临时数据目录**——账本用例要从「空账本」起步，
// 而共用的那个实例此刻已被收件箱用例喂了 5 笔账。两个实例的 MZ_DATA_DIR 与 --user-data-dir
// 都不同（单实例锁按 user-data-dir 隔离），互不影响；真实账本 %APPDATA%\mingzhang 仍全程不碰。
// 模型回复走离线演示（mz.setMock(true)），不联网、不烧 key。
//
// 断言纪律：筛选**必须走服务端**——用例会直接调 listLedger 对账（见用例③），
// 防止"前端过滤当前页"这种 total/agg 会撒谎的假实现蒙混过关。
// ---------------------------------------------------------------------------
test.describe('账本（真实数据）', () => {
  let ledgerApp: ElectronApplication

  test.beforeAll(async () => {
    const ledgerDataDir = mkdtempSync(join(tmpdir(), 'mz-ledger-data-'))
    const ledgerUserDataDir = mkdtempSync(join(tmpdir(), 'mz-ledger-udd-'))
    ledgerApp = await _electron.launch({
      args: ['.', `--user-data-dir=${ledgerUserDataDir}`],
      env: { ...process.env, MZ_DATA_DIR: ledgerDataDir } as Record<string, string>,
    })
    // 本段起 page 指向这个干净实例（旧实例已跑完，由文件级 afterAll 关闭）
    page = await ledgerApp.firstWindow()
    page.on('pageerror', (e) => pageErrors.push(String(e)))
    await page.waitForSelector('.mz-shell', { timeout: 30_000 })

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
    await page.getByTestId('nav-ledger').click()
  })

  // 关掉本段那个实例：否则 Electron 进程不退，playwright 会挂住
  test.afterAll(async () => {
    await ledgerApp?.close()
  })

  test('账本① 筛选条齐全 + 空账本态是「去记一笔」不是死屏', async () => {
    await expect(page.getByTestId('ledger-view')).toBeVisible()

    // 筛选条八个条件都在（时间/类型/分类/账户/金额区间/状态/关键词）
    await expect(page.getByTestId('ledger-f-month')).toBeVisible()
    await expect(page.getByTestId('ledger-f-type')).toBeVisible()
    await expect(page.getByTestId('ledger-f-category')).toBeVisible()
    await expect(page.getByTestId('ledger-f-account')).toBeVisible()
    await expect(page.getByTestId('ledger-f-amount-min')).toBeVisible()
    await expect(page.getByTestId('ledger-f-amount-max')).toBeVisible()
    await expect(page.getByTestId('ledger-f-state')).toBeVisible()
    await expect(page.getByTestId('ledger-f-q')).toBeVisible()

    // 汇总行四段都在（数值来自服务端 agg）
    await expect(page.getByTestId('ledger-agg')).toContainText('笔')
    await expect(page.getByTestId('ledger-agg-expense')).toBeVisible()
    await expect(page.getByTestId('ledger-agg-income')).toBeVisible()
    await expect(page.getByTestId('ledger-agg-review')).toBeVisible()
  })

  test('账本② 记一笔并确认入账 → 表格出现该行', async () => {
    // 记一笔前先确认账本是空的（本用例按顺序跑，前面没写过账）
    const before = await page.evaluate(() => window.mz.listLedger({ limit: 1 }))
    expect(before.total).toBe(0)
    await expect(page.getByTestId('ledger-empty')).toContainText('还没有账目')

    // 速记行记一笔（离线演示：解析 → 直接入账，无待决卡）
    const cap = page.getByLabel('速记行')
    await cap.fill('星巴克 35')
    await cap.press('Enter')
    await expect(cap).toHaveValue('')

    // 表格出现该行（真数据，不是假数据）
    const row = page.locator('[data-testid="ledger-row"]').first()
    await expect(row).toBeVisible()
    await expect(row).toContainText('星巴克')
    await expect(row).toContainText('¥35.00')
    // 状态徽标：已确认入账 = 正常
    await expect(row.getByTestId('ledger-cell-state')).toHaveText('正常')
    // 汇总吃到真实数字（只来自 agg）
    await expect(page.getByTestId('ledger-agg-expense')).toContainText('¥35.00')
    await expect(page.getByTestId('ledger-agg-count')).toContainText('1')
  })

  test('账本③ 选分类筛选生效：真的走服务端（对账 listLedger，不靠前端过滤）', async () => {
    const cat = page.getByTestId('ledger-f-category')
    // 选一个该笔**不**属于的分类 → 表格空，且是「筛选无结果」态（不是「还没有账目」）
    await cat.selectOption('交通')
    await expect(page.getByTestId('ledger-noresult')).toBeVisible()
    await expect(page.getByTestId('ledger-noresult')).toContainText('没有符合条件的账目')
    // 生效筛选以 chip 展示，可单个移除
    await expect(page.getByTestId('ledger-chip-category')).toContainText('分类：交通')

    // 强断言：服务端口径也确认是 0（证明筛选进了 listLedger 参数，不是前端把当前页滤空）
    const serverSide = await page.evaluate(() => window.mz.listLedger({ category: '交通', limit: 50 }))
    expect(serverSide.total).toBe(0)

    // 换成这笔**真实**所属的分类 → 出行
    await cat.selectOption('咖啡')
    await expect(page.locator('[data-testid="ledger-row"]')).toHaveCount(1)
    await expect(page.locator('[data-testid="ledger-row"]').first()).toContainText('星巴克')
    const serverHit = await page.evaluate(() => window.mz.listLedger({ category: '咖啡', limit: 50 }))
    expect(serverHit.total).toBe(1)

    // 清除筛选 → 回到全量
    await page.getByTestId('ledger-clear-all').click()
    await expect(page.locator('[data-testid="ledger-row"]')).toHaveCount(1)
  })

  test('账本④ 行详情改分类 → 表格与 agg 同步跟着变', async () => {
    await page.locator('[data-testid="ledger-row"]').first().click()
    const detail = page.getByTestId('ledger-detail')
    await expect(detail).toBeVisible()
    // 改完即存：顶部短暂「已保存」
    await detail.getByTestId('ledger-edit-category').selectOption('购物')
    await expect(page.getByTestId('ledger-saved')).toBeVisible()

    // 表格里的分类列同步变了
    await expect(page.locator('[data-testid="ledger-row"]').first()).toContainText('购物')
    // 分类筛选从「咖啡」改到「购物」后仍然命中这一笔（同一笔、分类已改）
    await page.getByTestId('ledger-f-category').selectOption('购物')
    await expect(page.locator('[data-testid="ledger-row"]')).toHaveCount(1)
    await expect(page.getByTestId('ledger-agg-expense')).toContainText('¥35.00')
    await page.getByTestId('ledger-clear-all').click()
  })

  test('账本⑤ 待后端项是诚实的禁用态：日期/类型/拆账/标记不计收支', async () => {
    // ④ 已经选中了这行，而行点击是**开关式**（再点一次取消选中），所以这里只在
    // 详情栏没开时才点——否则会把刚开的面板又关掉。
    if ((await page.getByTestId('ledger-detail').count()) === 0) {
      await page.locator('[data-testid="ledger-row"]').first().click()
    }
    const todo = page.getByTestId('ledger-backend-todo')
    await expect(todo).toBeVisible()
    for (const id of ['date', 'type', 'split', 'adjust']) {
      await expect(page.getByTestId(`ledger-todo-${id}`)).toBeDisabled()
    }
    // 原因逐条写清，不给假按钮
    await expect(todo).toContainText('待后端')
  })

  test('账本⑥ 删除 → 实测口径：直接软删，收件箱**不**出现删除确认卡', async () => {
    // 回到默认视图（⑤ 可能留着分类筛选）：[清除全部] 只在有筛选时渲染
    const clearBtn = page.getByTestId('ledger-clear-all')
    if ((await clearBtn.count()) > 0) await clearBtn.click()
    await expect(page.locator('[data-testid="ledger-row"]')).toHaveCount(1)

    // 详情栏可能已开（开关式点击，先确保开着的确实是这一行）
    if ((await page.getByTestId('ledger-detail').count()) === 0) {
      await page.locator('[data-testid="ledger-row"]').first().click()
    }
    // 界面如实写明删除实况（不假装"已送入收件箱待确认"）
    await expect(page.getByTestId('ledger-delete-note')).toContainText('不经收件箱确认门')
    await page.getByTestId('ledger-delete').click()

    // 本屏立刻反映软删结果：默认视图（状态=正常）下该行消失，且有可见回执
    await expect(page.getByTestId('toast')).toBeVisible()
    await expect(page.getByTestId('ledger-noresult')).toBeVisible()

    // 实测口径：editTx {op:'delete'} 是**直接软删**，不经收件箱确认门
    // （唯一产生 delete_confirm 门的是 AI 侧 delete 工具 → prepareDeleteGate）。
    // 这里断言"收件箱没有多出删除确认卡"——如实锁住后端现状，不是假装已送入。
    const gates = await page.evaluate(() => window.mz.pendingGateCards())
    expect(gates.filter((g) => g.field === 'delete_confirm')).toHaveLength(0)
    // 软删真的生效了
    const deleted = await page.evaluate(() => window.mz.listLedger({ state: 'deleted', limit: 50 }))
    expect(deleted.total).toBe(1)
    expect(deleted.items[0].state).toBe('deleted')
  })

  test('账本⑦ 状态=已删除 筛选里可见该行，并能恢复', async () => {
    await page.getByTestId('ledger-f-state').selectOption('deleted')
    await expect(page.getByTestId('ledger-chip-state')).toContainText('状态：已删除')

    const row = page.locator('[data-testid="ledger-row"]')
    await expect(row).toHaveCount(1)
    await expect(row.first()).toContainText('星巴克')
    // 已删除行有徽标
    await expect(row.first().getByTestId('ledger-cell-state')).toHaveText('已删除')

    // 恢复（行点击是开关式：只在详情栏没开时才点）
    if ((await page.getByTestId('ledger-detail').count()) === 0) {
      await row.first().click()
    }
    await page.getByTestId('ledger-restore').click()
    await expect(page.getByTestId('toast')).toBeVisible()

    // 恢复后：已删除筛选下没有它了，正常筛选下回来了
    await expect(page.getByTestId('ledger-noresult')).toBeVisible()
    await page.getByTestId('ledger-clear-all').click()
    await expect(page.locator('[data-testid="ledger-row"]')).toHaveCount(1)
    const back = await page.evaluate(() => window.mz.listLedger({ state: 'confirmed', limit: 50 }))
    expect(back.total).toBe(1)
  })

  test('账本⑧ 加载态是 10 行骨架：不是白屏也不是假行', async () => {
    // 骨架是瞬态：先用 MutationObserver 记账，再切走→切回触发重新挂载，避免竞态断言
    await page.evaluate(() => {
      const w = window as unknown as { __mzSawLedgerSkeleton?: { rows: number } }
      w.__mzSawLedgerSkeleton = { rows: 0 }
      const obs = new MutationObserver(() => {
        const box = document.querySelector('[data-testid="ledger-loading"]')
        if (box) w.__mzSawLedgerSkeleton!.rows = box.querySelectorAll('.mz-skel').length
      })
      obs.observe(document.body, { childList: true, subtree: true })
    })

    await page.getByTestId('nav-inbox').click()
    await page.getByTestId('nav-ledger').click()
    await page.waitForFunction(
      () => ((window as unknown as { __mzSawLedgerSkeleton?: { rows: number } }).__mzSawLedgerSkeleton?.rows ?? 0) > 0,
      undefined,
      { timeout: 15_000 },
    )
    // 10 行骨架（每行 5 个色块 = 50 个），且没有任何真实行冒充
    const rows = await page.evaluate(() => (window as unknown as { __mzSawLedgerSkeleton: { rows: number } }).__mzSawLedgerSkeleton.rows)
    expect(rows).toBe(50)
    await expect(page.getByTestId('ledger-view')).toBeVisible()
  })

  test('账本⑨ 出错态不静默：后端真报错 → 红边卡 + 可重试，改回合法值即恢复', async () => {
    // 金额区间下限 > 上限：后端会真抛错（ledger-page 的「金额区间无效」），前端必须如实显示
    await page.getByTestId('ledger-f-amount-min').fill('100')
    await page.getByTestId('ledger-f-amount-max').fill('1')

    const err = page.getByTestId('ledger-error')
    await expect(err).toBeVisible()
    await expect(err).toContainText('金额区间无效')
    await expect(err).toContainText('数据不受影响')
    await expect(page.getByTestId('ledger-retry')).toBeVisible()

    // 重试按钮真的会重查（条件仍非法 → 仍报错，不假装成功）
    await page.getByTestId('ledger-retry').click()
    await expect(err).toBeVisible()

    // 改回合法值 → 错误消失，表格回来
    await page.getByTestId('ledger-f-amount-min').fill('')
    await page.getByTestId('ledger-f-amount-max').fill('')
    await expect(page.getByTestId('ledger-error')).toHaveCount(0)
    await expect(page.locator('[data-testid="ledger-row"]')).toHaveCount(1)
  })

  test('账本⑩ 全程无未捕获异常', async () => {
    expect(pageErrors).toEqual([])
  })
})

// ---------------------------------------------------------------------------
// 轮次超时（缺陷单：界面 10 秒谎报失败 + 引擎整轮永不结束）
//
// 真机证据：真实微信账单（159 行）拖进应用回车后，会话文件停在 toolResult 不再增长，
// 主进程 CPU 纹丝不动、没有任何错误事件、agent_runs 永远 running；界面却在 10s 时
// 自己把「待解析」卡片摘掉，写上「这一轮没有回音，试试重说一次或手动补全」——
// 那是渲染层盲定时器的臆测，不是引擎的结论（真相是"还在处理"），照做重试还会与
// 未结束的轮次叠加。
//
// 本段用与引擎用例同一个假 provider（tests/fake-provider.ts，hang 模式：连上不回数据）
// 起 Electron 实例，验收两件事：
//   ① 超过旧阈值（12s）后「解析中」卡片仍在，状态区没有「没有回音」这类假失败文案，
//      且如实显示已用时长；
//   ② 引擎空闲超时（注入小阈值）后卡片转失败态，文案是**引擎的真实原因**（含「超时」）。
//
// 隔离（红线）：MZ_DATA_DIR 与 --user-data-dir **都**用 mkdtemp 临时目录。
// 绝不只给真实数据目录配临时 --user-data-dir——safeStorage 的 DPAPI 口令绑 user-data-dir，
// 换目录解不开 secrets/db.key，应用会当"没有密钥"重新生成 DEK 覆盖写回，从此启动即崩。
// ---------------------------------------------------------------------------

/** 起一个独立 Electron 实例，数据目录与 user-data-dir 都是临时目录，env 可注入。 */
async function launchIsolated(
  env: Record<string, string>,
): Promise<{ app: ElectronApplication; page: Page; dataDir: string }> {
  const dataDir = mkdtempSync(join(tmpdir(), 'mz-timeout-data-'))
  const userDataDir = mkdtempSync(join(tmpdir(), 'mz-timeout-udd-'))
  const a = await _electron.launch({
    args: ['.', `--user-data-dir=${userDataDir}`],
    env: { ...process.env, MZ_DATA_DIR: dataDir, ...env } as Record<string, string>,
  })
  const p = await a.firstWindow()
  p.on('pageerror', (e) => pageErrors.push(String(e)))
  await p.waitForSelector('.mz-shell', { timeout: 30_000 })
  return { app: a, page: p, dataDir }
}

/** 把假 provider 写进应用配置并激活（走真实 IPC：config.json + safeStorage 密钥）。 */
async function useFakeProvider(p: Page, baseUrl: string): Promise<void> {
  await p.evaluate(async (url) => {
    await window.mz.saveProvider({
      provider: { id: 'fakeprovider', name: '假 provider', baseUrl: url, model: 'fake-model', visionCapable: false },
      apiKey: 'test-key-not-secret',
      activate: true,
    })
  }, baseUrl)
}

test.describe('轮次超时（真实信号驱动）', () => {
  test.describe.configure({ timeout: 120_000 })

  test('超时① 超过旧阈值 12s：「解析中」卡片仍在，状态区不说「没有回音」，并如实显示已用时长', async () => {
    const fake = await startFakeProvider('hang')
    // 引擎空闲阈值给足 20s：本用例只看"12s 时不许谎报失败"，引擎超时要留给下一段。
    const { app: tApp, page: tPage } = await launchIsolated({ MZ_TURN_IDLE_TIMEOUT_MS: '20000' })
    try {
      await useFakeProvider(tPage, fake.url)
      const cap = tPage.getByLabel('速记行')
      await expect(cap).toBeEnabled()
      await cap.fill('把这张账单记一下')
      await cap.press('Enter')

      // 提交后立刻出现「待解析」卡片
      const parsing = tPage.getByTestId('inbox-parsing')
      await expect(parsing).toBeVisible()

      // 越过旧阈值（10s）到 12s：卡片必须还在（引擎仍在处理，界面如实说"还在处理"）
      await tPage.waitForTimeout(12_000)
      await expect(parsing, '12s 后「解析中」卡片被盲定时器摘掉了').toBeVisible()

      // 状态区不许出现把锅推给用户的假失败文案
      const status = tPage.getByTestId('capture-status')
      await expect(status).not.toContainText('没有回音')
      await expect(status).not.toContainText('重说一次')
      // 也没有任何红字失败态
      await expect(tPage.getByTestId('capture-error')).toHaveCount(0)

      // 如实显示已用时长：秒数在走（12s 那一帧至少是两位数）
      const busyText = await tPage.getByTestId('capture-busy-text').innerText()
      const secs = Number(/(\d+)\s*s/.exec(busyText)?.[1] ?? '-1')
      expect(secs, `状态区没有显示已用秒数：${JSON.stringify(busyText)}`).toBeGreaterThanOrEqual(10)
    } finally {
      await tApp.close()
      await fake.close()
    }
  })

  test('超时② 引擎空闲超时后：卡片转失败态，文案是引擎的真实原因（含「超时」）', async () => {
    const fake = await startFakeProvider('hang')
    // 注入小阈值：引擎 4s 无响应即中止 → 广播 error（真实信号）→ 界面转失败态
    const { app: tApp, page: tPage } = await launchIsolated({ MZ_TURN_IDLE_TIMEOUT_MS: '4000' })
    try {
      await useFakeProvider(tPage, fake.url)
      // 引擎重启是异步的：先等它就绪（用一次无副作用的查询探活，探活用完就恢复 hang）
      const cap = tPage.getByLabel('速记行')
      await expect(cap).toBeEnabled()
      await cap.fill('把这张账单记一下')
      await cap.press('Enter')

      await expect(tPage.getByTestId('inbox-parsing')).toBeVisible()

      // 引擎超时（≤4s + 余量）后：「待解析」卡片消失，进失败态
      await expect(tPage.getByTestId('inbox-parsing')).toHaveCount(0, { timeout: 30_000 })

      // 文案必须是**引擎的真实原因**（含「超时」），不是界面编的，也不许被 IPC 管道噪声盖住
      const err = tPage.getByTestId('capture-error')
      await expect(err).toBeVisible()
      await expect(err).toContainText('超时')
      // Electron 会把主进程 rejection 包成 "Error invoking remote method 'mz:sendChat': TurnTimeoutError: …"，
      // 那层壳是管道噪声、不是引擎给的原因，不能摆在用户面前。
      await expect(err, '状态区把 IPC 管道噪声透给用户了').not.toContainText('Error invoking remote method')
      await expect(err, '状态区把错误类名透给用户了').not.toContainText('TurnTimeoutError')
      // 失败后输入框解锁、内容保留（用户可以改完重发）
      await expect(cap).toBeEnabled()
    } finally {
      await tApp.close()
      await fake.close()
    }
  })

  test('超时③ 失败文案由引擎广播驱动：状态区那句就是引擎 error 事件的原文', async () => {
    const fake = await startFakeProvider('hang')
    const { app: tApp, page: tPage } = await launchIsolated({ MZ_TURN_IDLE_TIMEOUT_MS: '4000' })
    try {
      // 先装监听再提交，确保不漏掉引擎广播的那一条
      await tPage.evaluate(() => {
        const w = window as unknown as { __mzErrors?: string[] }
        w.__mzErrors = []
        window.mz.onChatEvent((evt) => {
          if (evt.type === 'error') {
            w.__mzErrors!.push(String((evt.payload as { message?: string } | undefined)?.message ?? ''))
          }
        })
      })
      await useFakeProvider(tPage, fake.url)
      const cap = tPage.getByLabel('速记行')
      await cap.fill('把这张账单记一下')
      await cap.press('Enter')

      const err = tPage.getByTestId('capture-error')
      await expect(err).toBeVisible({ timeout: 30_000 })
      const shown = await err.innerText()
      const engineErrors = await tPage.evaluate(() => (window as unknown as { __mzErrors: string[] }).__mzErrors)
      const fromEngine = engineErrors.find((m) => m.includes('超时'))
      expect(fromEngine, `引擎没有广播含「超时」的 error：${JSON.stringify(engineErrors)}`).toBeTruthy()
      // 状态区那句 = 引擎广播的原文（只允许保留"没提交成功："这个前缀说明发生了什么），
      // 一个字的管道噪声都不许夹带。
      expect(shown.replace(/^没提交成功：/, ''), '状态区文案不是引擎广播的原文').toBe(fromEngine!)
    } finally {
      await tApp.close()
      await fake.close()
    }
  })

  // ---------------------------------------------------------------------------
  // 超时④/⑤（R3/R4，真机第二轮 09-26 23:12–23:15 的现场）：
  //   159 行微信账单那轮，引擎从 23:12:38 干到 23:15:27（thinking 了 2m05s，一直在流），
  //   界面却在 90 秒（≈23:14:08）写下"引擎没有回应，这一轮已停止等待"——引擎在干活，
  //   界面又一次宣布它死了。两件事要锁死：
  //   a) 思考期引擎把"还活着"如实推给界面（progress），界面据此重置自己的保险丝；
  //      保险丝阈值由主进程下发（uiFallbackWaitMs），不是 UI 写死的 90s；
  //   b) 只有**真静默**时保险丝才开口，而且说的是事实（"多久没动静"），
  //      不装成引擎失败、不把锅推给用户。
  // ---------------------------------------------------------------------------
  test('超时④ 思考流不算「没有回应」：存活信号到达界面 + 保险丝被真实信号重置', async () => {
    const fake = await startFakeProvider('thinking', { count: 40, intervalMs: 250 }) // ≈10s 思考流
    // 引擎 60s 内不会收敛（这一轮里引擎侧全程不该开口）；界面保险丝只给 3s：
    // 思考流必须把它压住——引擎活着，界面就不许开口。
    const { app: tApp, page: tPage } = await launchIsolated({
      MZ_TURN_IDLE_TIMEOUT_MS: '60000',
      MZ_UI_FALLBACK_WAIT_MS: '3000',
    })
    try {
      // 先装监听再提交：progress 就是引擎的存活信号，漏一条即"界面全黑"
      await tPage.evaluate(() => {
        const w = window as unknown as { __mzProgress?: number[] }
        w.__mzProgress = []
        window.mz.onChatEvent((evt) => {
          if (evt.type === 'progress') w.__mzProgress!.push(Date.now())
        })
      })
      await useFakeProvider(tPage, fake.url)
      const cap = tPage.getByLabel('速记行')
      await expect(cap).toBeEnabled()
      await cap.fill('把这张账单记一下')
      await cap.press('Enter')

      const parsing = tPage.getByTestId('inbox-parsing')
      await expect(parsing).toBeVisible()

      // 保险丝阈值真的从主进程送进界面了（不是 UI 写死的 90s）
      const info = await tPage.evaluate(() => window.mz.getSettingsInfo())
      expect(info.uiFallbackWaitMs, '保险丝阈值没有从主进程下发（UI 还在用自己的写死值）').toBe(3000)

      // 越过保险丝阈值（3s）到 6s：引擎一直在思考（活着），界面不许开口
      await tPage.waitForTimeout(6_000)
      await expect(parsing, '思考期被界面保险丝当成「没有回应」了').toBeVisible()
      const status = tPage.getByTestId('capture-status')
      await expect(status, '思考期状态区出现了谎报文案').not.toContainText('没有任何新动静')
      await expect(tPage.getByTestId('capture-error')).toHaveCount(0)

      // 期间真收到了存活信号（≥2 条）——真机上这段全黑正是 90s 谎报的起因
      const progressCount = await tPage.evaluate(() => (window as unknown as { __mzProgress: number[] }).__mzProgress.length)
      expect(progressCount, `界面没收到任何存活信号（思考期全黑）：${progressCount}`).toBeGreaterThanOrEqual(2)

      // 如实报时：秒数还在走
      const busyText = await tPage.getByTestId('capture-busy-text').innerText()
      const secs = Number(/(\d+)\s*s/.exec(busyText)?.[1] ?? '-1')
      expect(secs, `状态区没有显示已用秒数：${JSON.stringify(busyText)}`).toBeGreaterThanOrEqual(5)
    } finally {
      await tApp.close()
      await fake.close()
    }
  })

  test('超时⑤ 保险丝只在真静默时开口：先解除等待，文案说的是「没动静」而不是「引擎失败」', async () => {
    const fake = await startFakeProvider('stall') // 两口思考增量后彻底静默（连接不断、不报错）
    // 引擎 60s 不会收敛：这一轮里唯一会开口的只有界面保险丝（2.5s）
    const { app: tApp, page: tPage } = await launchIsolated({
      MZ_TURN_IDLE_TIMEOUT_MS: '60000',
      MZ_UI_FALLBACK_WAIT_MS: '2500',
    })
    try {
      await useFakeProvider(tPage, fake.url)
      const cap = tPage.getByLabel('速记行')
      await expect(cap).toBeEnabled()
      await cap.fill('把这张账单记一下')
      await cap.press('Enter')
      await expect(tPage.getByTestId('inbox-parsing')).toBeVisible()

      // 真静默 → 界面先解除等待（卡片消失），不必干等引擎那 60s
      await expect(tPage.getByTestId('inbox-parsing'), '真静默时界面一直不放用户走').toHaveCount(0, { timeout: 20_000 })

      // 说的是事实：多久没动静；不装成引擎失败，也不把锅推给用户
      const status = tPage.getByTestId('capture-status')
      await expect(status, '保险丝开口了但没说清楚是「没动静」').toContainText('没有任何新动静')
      await expect(status).not.toContainText('重说一次')
      await expect(status).not.toContainText('没有回音')
      await expect(status, '状态区把 IPC 管道噪声透给用户了').not.toContainText('Error invoking remote method')
      // 引擎并没有失败（它还在跑），界面别把这事装成引擎报错
      await expect(tPage.getByTestId('capture-error'), '界面把「界面自己的保险丝」装成了引擎报错').toHaveCount(0)
    } finally {
      await tApp.close()
      await fake.close()
    }
  })
})
// ---------------------------------------------------------------------------
// 批次结果条（D-03a「按批次读回」+ K3 设计 G 组事实条）
//
// 存在的理由：用户一键入账 126 笔后界面剩 38 笔「待确认」却**没有任何解释**——
// 第一反应是「是不是 bug」。这条横条用**数据算得出的数字**把「刚才那批发生了什么」说清楚。
//
// 数字口径（域层 src/main/domain/batch-summary.ts 现算，不取对话事件里的内存 result）：
//   已入账/待分类查 transactions（待分类 ⊂ 已入账）；重复/不计收支/待核对取批次方案 plan。
// 剧本走**离线演示 + 账单 XLSX**（与既有外壳⑨ 同一份合成夹具，不碰真实账单），数字是域层实跑出来的：
//   第 1 遍：4 行 = 3 笔入账（其中「小明」不在常识表 → 转待分类）+ 1 行不计收支 → 3 / 1 / 1 / 0 / 0
//   第 2 遍：同渠道同交易号全判重复 → 0 / 0 / 1 / 3 / 0
//
// 用例独立性（重要）：Playwright 在一条用例失败后会**另起 worker**，describe 级的 beforeAll
// 于是重跑、数据目录换新——后面的用例就全落到空账本上，连锁假红。
// 所以每条用例自己 ensure 出前置状态（ensureBatches），谁先跑都能立住，不吃上一条的状态。
//
// 隔离（红线）：独立 Electron 实例 + mkdtemp 临时数据目录与 user-data-dir，
// 真实账本 %APPDATA%\mingzhang 全程不碰；模型回复走离线演示，不联网、不烧 key。
// ---------------------------------------------------------------------------

test.describe('批次结果条（真实数据）', () => {
  let barApp: ElectronApplication
  let barPage: Page
  const barErrors: string[] = []
  /** 已经导入过几遍账单（跨用例累计；worker 重启后随 describe 状态一起重置）。 */
  let imported = 0

  /** 把一份合成微信账单拖进速记行并提交：走 read_bill → apply_bill 两步剧本。 */
  async function importBill(): Promise<void> {
    await barPage.getByTestId('nav-inbox').click()
    const capture = barPage.getByLabel('速记行')
    await capture.press('Escape')
    const b64 = Buffer.from(new Uint8Array(makeWechatXlsxBuffer())).toString('base64')
    await barPage.evaluate(
      ({ name, type, data }) => {
        const bin = atob(data)
        const bytes = new Uint8Array(bin.length)
        for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i)
        const dt = new DataTransfer()
        dt.items.add(new File([bytes], name, { type }))
        const el = document.querySelector('[data-testid="capture-bar"]')
        if (!el) throw new Error('拖拽目标不存在：capture-bar')
        for (const t of ['dragover', 'drop']) {
          el.dispatchEvent(new DragEvent(t, { bubbles: true, cancelable: true, dataTransfer: dt }))
        }
      },
      { name: '微信账单.xlsx', type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', data: b64 },
    )
    await expect(barPage.getByTestId('capture-bill').first(), '账单没解析成速记行 chip').toBeVisible()
    await capture.fill('把这张账单记一下')
    await capture.press('Enter')
    // 落一个 batch_confirm 待决门并点确认入账（真实 executeBatch 路径）
    const card = barPage.locator('[data-testid="inbox-card"][data-kind="batch_confirm"]')
    await expect(card, '账单没落出批次待确认门').toBeVisible({ timeout: 30_000 })
    await card.getByTestId('inbox-confirm').click()
    await expect(card, '点确认后批次门没消失').toHaveCount(0)
    imported += 1
  }

  /** 导入到第 n 遍为止（幂等）：已够就不动，避免重复导入把断言基数搅乱。 */
  async function ensureBatches(n: number): Promise<void> {
    while (imported < n) await importBill()
  }

  test.beforeAll(async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'mz-bar-data-'))
    const userDataDir = mkdtempSync(join(tmpdir(), 'mz-bar-udd-'))
    barApp = await _electron.launch({
      args: ['.', `--user-data-dir=${userDataDir}`],
      env: { ...process.env, MZ_DATA_DIR: dataDir } as Record<string, string>,
    })
    barPage = await barApp.firstWindow()
    barPage.on('pageerror', (e) => barErrors.push(String(e)))
    await barPage.waitForSelector('.mz-shell', { timeout: 30_000 })
    await barPage.evaluate(async () => {
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
  })

  test.afterAll(async () => {
    await barApp?.close()
  })

  test('结果条① 一键入账后：结果条驻留，四段数字与本批实际数据一致', async () => {
    // 还没导过账单：不该凭空显示一条结果（不编数字）
    await expect(barPage.getByTestId('batch-result-bar'), '没导入批次就显示结果条').toHaveCount(0)

    await ensureBatches(1)

    const bar = barPage.getByTestId('batch-result-bar')
    await expect(bar, '入账后收件箱顶部没有驻留结果条').toBeVisible()

    // 四段计数：夹具 4 行 = 3 笔入账（含 1 笔待分类）+ 1 行不计收支
    await expect(bar.getByTestId('br-booked')).toHaveText('✓ 3 已入账')
    await expect(bar.getByTestId('br-needs-category')).toHaveText('⏸ 1 待分类')
    await expect(bar.getByTestId('br-excluded')).toHaveText('⊘ 1 不计收支')
    await expect(bar.getByTestId('br-duplicates')).toHaveText('⧉ 0 重复跳过')

    // 子集说明必须说清「待分类含在已入账里」，否则用户会以为 3+1 是两笔、算不平
    await expect(bar.getByTestId('br-subset-note')).toHaveText('已入账含 1 笔待分类')
    // 有待分类 → 主按钮在（②B 规格变更 G-03：主按钮改走面板归类）
    await expect(bar.getByTestId('br-go-handle')).toHaveText('去面板归类 1 笔 →')
  })

  test('结果条② 折叠组：重复行逐行列出，不计收支组如实说「逐行明细待后端」', async () => {
    await ensureBatches(1)
    const bar = barPage.getByTestId('batch-result-bar')
    await expect(bar).toBeVisible()

    // 不计收支组：数字在，但逐行明细后端拿不到 → 必须**说出来**，不许拿空数组冒充
    const exToggle = bar.getByTestId('br-excluded-toggle')
    await expect(exToggle).toHaveText('▸ 不计收支 1 行')
    await exToggle.click()
    const exNote = bar.getByTestId('br-excluded-note')
    await expect(exNote).toBeVisible()
    await expect(exNote).toContainText('共 1 行按方案不计收支')
    await expect(exNote, '后端没给的明细被编成了「没有不计收支的行」').toContainText('逐行明细待后端')
    // D-01 未实现 → 绝不渲染「全部恢复为正常收支」这类无依赖按钮
    await expect(bar.getByRole('button', { name: /恢复为正常收支/ })).toHaveCount(0)

    // 重复组：这批没有重复行，折叠头在、**没有明细行**（空态不是明细）
    const dupToggle = bar.getByTestId('br-dup-toggle')
    await expect(dupToggle).toHaveText('▸ 重复跳过 0 笔')
    await dupToggle.click()
    const dupRows = bar.getByTestId('br-dup-rows')
    await expect(dupRows).toBeVisible()
    await expect(dupRows).toContainText('这一批没有重复跳过的行')
    await expect(dupRows.locator('.mz-br-row'), '没有重复行却渲染出了明细行').toHaveCount(0)
  })

  test('结果条③ 主按钮开面板并自动发出归类指令（②B 规格变更 G-03）', async () => {
    await ensureBatches(1)
    await barPage.getByTestId('nav-inbox').click()
    const bar = barPage.getByTestId('batch-result-bar')
    await expect(bar).toBeVisible()
    await bar.getByTestId('br-go-handle').click()

    // 主按钮的职责从「跳账本」改成「开面板 + 发指令」（次级链接逐笔手动才是跳账本那条）
    const panel = barPage.getByTestId('assistant-panel')
    await expect(panel, '主按钮没打开助手面板').toHaveAttribute('aria-hidden', 'false')
    await expect(panel.getByTestId('panel-msg-user').last(), '没自动发出归类指令').toContainText(
      '把待分类的账按建议归类',
    )
    await expect(barPage.getByTestId('ledger-view'), '主按钮不该再跳账本屏').toHaveCount(0)
  })

  test('结果条④ 关闭是内存态：切屏往返仍是关闭态', async () => {
    await ensureBatches(1)
    await barPage.getByTestId('nav-inbox').click()
    const bar = barPage.getByTestId('batch-result-bar')
    await expect(bar).toBeVisible()

    await bar.getByTestId('br-dismiss').click()
    await expect(barPage.getByTestId('batch-result-bar'), '点了 ✕ 结果条还在').toHaveCount(0)
    await barPage.getByTestId('nav-ledger').click()
    await barPage.getByTestId('nav-inbox').click()
    // D-04 跨重启持久化本单未实现：同一进程里关掉就该一直是关掉的
    await expect(barPage.getByTestId('batch-result-bar'), '切屏往返后结果条自己回来了（本单只做内存态）').toHaveCount(0)
  })

  test('结果条⑤ 重载后按批次读回：待分类定掉 → 主按钮消失（退化为摘要行）', async () => {
    await ensureBatches(1)
    // 重载 = 全新渲染进程状态，唯一的「读回」真检验：数据只能来自库里那份批次方案
    await barPage.reload()
    await barPage.waitForSelector('.mz-shell', { timeout: 30_000 })
    await expect(barPage.getByTestId('batch-result-bar'), '重载后读不回批次结果（D-03a 通道没通）').toBeVisible()

    // 账本里把那笔「待分类」定掉（既有交互，不动）
    await barPage.getByTestId('nav-ledger').click()
    await barPage.getByTestId('ledger-f-state').selectOption('needs_review')
    const row = barPage.locator('[data-testid="ledger-row"]').first()
    await expect(row, '待分类那笔不在账本待核对列表里').toBeVisible()
    await row.click()
    const detail = barPage.getByTestId('ledger-detail')
    await expect(detail).toBeVisible()
    await detail.getByTestId('ledger-edit-category').selectOption('餐饮')
    await expect(barPage.getByTestId('ledger-saved')).toBeVisible()

    await barPage.getByTestId('nav-inbox').click()
    const bar = barPage.getByTestId('batch-result-bar')
    await expect(bar.getByTestId('br-needs-category')).toHaveText('⏸ 0 待分类')
    await expect(bar.getByTestId('br-go-handle'), '待分类清零了主按钮还在').toHaveCount(0)
    // 摘要行本身还在（事实没变：3 笔确实入账了）
    await expect(bar.getByTestId('br-booked')).toHaveText('✓ 3 已入账')
  })

  test('结果条⑥ 同一份账单导第二遍：重复跳过的行逐行列出', async () => {
    await ensureBatches(2)
    const bar = barPage.getByTestId('batch-result-bar')
    await expect(bar).toBeVisible()
    // 同渠道同交易号全判重复：0 笔入账、3 笔重复跳过、1 行不计收支
    await expect(bar.getByTestId('br-booked')).toHaveText('✓ 0 已入账')
    await expect(bar.getByTestId('br-duplicates')).toHaveText('⧉ 3 重复跳过')
    await expect(bar.getByTestId('br-excluded')).toHaveText('⊘ 1 不计收支')

    await bar.getByTestId('br-dup-toggle').click()
    const rows = bar.getByTestId('br-dup-rows').locator('.mz-br-row')
    await expect(rows).toHaveCount(3)
    // 逐行给得出来：商户 · 金额 · 原因（不只是一个数字）
    await expect(rows.nth(0)).toContainText('星巴克咖啡')
    await expect(rows.nth(0)).toContainText('¥35.00')
    await expect(rows.nth(0)).toContainText('自动跳过')
    await expect(rows.nth(1)).toContainText('全家便利店')
    await expect(rows.nth(2)).toContainText('小明')

    // 全程无未捕获异常
    expect(barErrors).toEqual([])
  })
})

// ---------------------------------------------------------------------------
// ②B 助手面板（K3 P 组：能追问/能下指令/看得见它干了什么）＋ 归类映射表闭环
//
// 存在的理由：上一单把「去处理 N 笔」做成跳账本，用户得自己数、自己分类；
// 引擎（D-01）其实已经能给出分组建议并落门确认，界面却没入口——
// 这一单把面板立起来，让结果条走「面板 → 真实工具 → 映射表 → 用户确认 → 整体撤销」。
//
// 数字口径：映射表的每一格都来自域层真跑出来的 classify-plan 卡（引擎落门后重建），
// 断言的笔数/组数/分类**从真实建议里读出来再断言**，不写死猜的数。
//
// 用例独立性（沿用上一单的教训）：每条用例自己 ensureBatches 前置状态，
// worker 重启后 describe 状态重置也不会连锁假红。
//
// 隔离（红线）：独立 Electron 实例 + mkdtemp 临时数据目录与 user-data-dir，
// 真实账本 %APPDATA%\mingzhang 全程不碰；模型回复走离线演示，不联网、不烧 key。
// ---------------------------------------------------------------------------

test.describe('助手面板与归类映射表（②B 真实数据）', () => {
  let panelApp: ElectronApplication
  let panelPage: Page
  const panelErrors: string[] = []
  let imported = 0

  async function importBill(): Promise<void> {
    await panelPage.getByTestId('nav-inbox').click()
    const capture = panelPage.getByLabel('速记行')
    await capture.press('Escape')
    const b64 = Buffer.from(new Uint8Array(makeWechatXlsxBuffer())).toString('base64')
    await panelPage.evaluate(
      ({ name, type, data }) => {
        const bin = atob(data)
        const bytes = new Uint8Array(bin.length)
        for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i)
        const dt = new DataTransfer()
        dt.items.add(new File([bytes], name, { type }))
        const el = document.querySelector('[data-testid="capture-bar"]')
        if (!el) throw new Error('拖拽目标不存在：capture-bar')
        for (const t of ['dragover', 'drop']) {
          el.dispatchEvent(new DragEvent(t, { bubbles: true, cancelable: true, dataTransfer: dt }))
        }
      },
      { name: '微信账单.xlsx', type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', data: b64 },
    )
    await expect(panelPage.getByTestId('capture-bill').first(), '账单没解析成速记行 chip').toBeVisible()
    await capture.fill('把这张账单记一下')
    await capture.press('Enter')
    const card = panelPage.locator('[data-testid="inbox-card"][data-kind="batch_confirm"]')
    await expect(card, '账单没落出批次待确认门').toBeVisible({ timeout: 30_000 })
    await card.getByTestId('inbox-confirm').click()
    await expect(card, '点确认后批次门没消失').toHaveCount(0)
    imported += 1
  }

  async function ensureBatches(n: number): Promise<void> {
    while (imported < n) await importBill()
  }

  /** 打开面板（幂等）：面板是应用级状态，上一条用例可能已经把它开着——
   *  无脑点开关反而会把它关掉（那正是上一条把面板留着时会发生的事）。 */
  async function openPanel(): Promise<void> {
    const panel = panelPage.getByTestId('assistant-panel')
    if ((await panel.getAttribute('aria-hidden')) === 'true') {
      await panelPage.getByTestId('panel-toggle').click()
    }
    await expect(panel).toHaveAttribute('aria-hidden', 'false')
  }

  /**
   * 读真实建议（getClassifyProposal）→ 发出计划书原文那句归类指令。
   * 缺口已修：指派由模型从 classify_suggest 的**工具结果文本**里读 group_key，
   * 指令不再夹带「分组键=分类名」这种只有绕开缺口才需要的东西。
   * 这里仍读一次 getClassifyProposal：那是**断言基准**（笔数/组数取真实数字），
   * 不是给模型的输入——两者别混为一谈。
   *
   * _category 形参只为不动既有调用点而保留（③ 仍传 '其他'），指令里已不再使用它。
   */
  async function askClassify(_category = '其他'): Promise<{
    groupKey: string
    count: number
    groupCount: number
    pendingCount: number
  }> {
    const p = await panelPage.evaluate(async () => {
      const mz = (
        window as unknown as {
          mz: {
            getClassifyProposal: (
              b?: string | null,
            ) => Promise<{
              pendingCount: number
              groups: { groupKey: string; count: number; merchant: string | null }[]
            }>
          }
        }
      ).mz
      return mz.getClassifyProposal()
    })
    const g = p.groups[0]
    if (!g) throw new Error('库里没有待分类账目，夹具前置不成立')
    await panelPage.getByTestId('panel-input').fill('把待分类的账按建议归类')
    await panelPage.getByTestId('panel-send').click()
    return { groupKey: g.groupKey, count: g.count, groupCount: p.groups.length, pendingCount: p.pendingCount }
  }

  test.beforeAll(async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'mz-panel-data-'))
    const userDataDir = mkdtempSync(join(tmpdir(), 'mz-panel-udd-'))
    panelApp = await _electron.launch({
      args: ['.', `--user-data-dir=${userDataDir}`],
      env: { ...process.env, MZ_DATA_DIR: dataDir } as Record<string, string>,
    })
    panelPage = await panelApp.firstWindow()
    panelPage.on('pageerror', (e) => panelErrors.push(String(e)))
    await panelPage.waitForSelector('.mz-shell', { timeout: 30_000 })
    await panelPage.evaluate(async () => {
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
  })

  test.afterAll(async () => {
    await panelApp?.close()
  })

  test('面板① 开合是推挤式第三列：收件箱主列变窄但不被遮挡，收起不卸载', async () => {
    await ensureBatches(1)

    // 没打开时：面板在树里但视觉隐藏
    const panel = panelPage.getByTestId('assistant-panel')
    await expect(panel, '面板节点根本不存在（收起时也必须留在树上，历史才留得住）').toHaveCount(1)
    await expect(panel).toHaveAttribute('aria-hidden', 'true')
    await expect(panel, '收起时还占着 420px').toBeHidden()

    const mainBox = await panelPage.locator('.mz-main').boundingBox()
    expect(mainBox, '主列没有布局盒子').not.toBeNull()

    await openPanel()
    await expect(panel).toBeVisible()
    // 推挤而不是浮层：主列实宽必须真的变窄
    const squeezed = await panelPage.locator('.mz-main').boundingBox()
    expect(squeezed!.width, '面板盖在收件箱上（浮层），主列没被推挤').toBeLessThan(mainBox!.width)
    // 面板自己就是 420px 的第三列
    const panelBox = await panel.boundingBox()
    expect(Math.round(panelBox!.width), '面板宽度不是 420px').toBe(420)
    // 主列没被遮：收件箱容器与结果条都还可见可点
    await expect(panelPage.getByTestId('inbox-view'), '收件箱被面板挡住了').toBeVisible()
    await expect(panelPage.getByTestId('batch-result-bar'), '结果条被面板挡住了').toBeVisible()
    // 还没有任何归类卡 → 空态，不许凭空造一张表
    await expect(panelPage.getByTestId('cls-empty')).toContainText('现在没有待分类的账')

    await panelPage.getByTestId('panel-toggle').click()
    await expect(panel, '再点一次没收起').toHaveAttribute('aria-hidden', 'true')
    await expect(panel, '收起时被卸载了（历史会丢）').toHaveCount(1)
    const restored = await panelPage.locator('.mz-main').boundingBox()
    expect(Math.round(restored!.width), '收起后主列没回到原宽').toBe(Math.round(mainBox!.width))
  })

  test('面板② 消息流与工具卡：离线剧本走 classify_suggest → classify_batch 真工具', async () => {
    await ensureBatches(1)
    await openPanel()
    await askClassify()

    // 助手回复（引擎离线演示返回的文本）
    await expect(
      panelPage.getByTestId('panel-msg-assistant').last(),
      '离线剧本没跑出助手回复',
    ).toBeVisible({ timeout: 30_000 })
    // 思考条：折叠只报耗时（T0928 §4：正文累积断言谈后移，见本用例末尾）。
    const think = panelPage.getByTestId('panel-think').last()
    await expect(think, '没有思考条').toBeVisible()
    await expect(think).toContainText('思考')

    // 工具卡：中文标签、顺序是「先看有哪些待分类，后生成归类方案」。
    // 注意断言**最近两张**而不是总数：面板的历史按设计要跨用例留住
    // （beforeAll 的就绪探测那轮也留了卡），写成 toHaveCount(2) 反而会把"历史没丢"当失败。
    const tools = panelPage.getByTestId('panel-tool')
    const n = await tools.count()
    expect(n, '这一轮连两张工具卡都没留下').toBeGreaterThanOrEqual(2)
    await expect(tools.nth(n - 2)).toContainText('看有哪些待分类')
    await expect(tools.nth(n - 1)).toContainText('生成归类方案')
    // 跑完了就是完成态，不是永远转圈
    await expect(tools.nth(n - 1)).toContainText('完成')

    // §4 思考正文（点名改的那条断言）：离线演示剧本不发思考流（剧本语义不动），
    // 切到假 provider 的 thinking 模式跑一轮，让引擎的 thinking_delta → thinking-delta
    // 广播真的流到面板；跑完恢复离线演示。放在工具卡断言之后：恢复时的探活轮也会
    // 走一次演示剧本、留下它自己的工具卡，不能搅乱上面"最近两张"的口径。
    await panelPage.evaluate(() => window.mz.setMock(false))
    const fakeThink = await startFakeProvider('thinking', { count: 4, intervalMs: 50 })
    try {
      await useFakeProvider(panelPage, fakeThink.url)
      // 引擎重启是异步的：与 beforeAll 同口径，用无副作用的查询探活
      for (let i = 0; i < 40; i++) {
        try {
          await panelPage.evaluate(() => window.mz.sendChat('待收尾', []))
          break
        } catch {
          await new Promise((r) => setTimeout(r, 500))
        }
        if (i === 39) throw new Error('假 thinking provider 引擎 20s 内未就绪')
      }
      await panelPage.getByTestId('panel-input').fill('想一句再回答')
      await panelPage.getByTestId('panel-send').click()
      await expect(panelPage.getByTestId('panel-input'), '假思考这一轮没收尾').toBeEnabled({ timeout: 30_000 })

      const thinkReal = panelPage.getByTestId('panel-think').last()
      await expect(thinkReal).toContainText('思考')
      await thinkReal.click()
      const thinkFull = panelPage.getByTestId('panel-think-full').last()
      await expect(thinkFull, '展开区没有渲染思考正文（thinking-delta 没流到面板）').not.toHaveText('')
      await expect(thinkFull, '展开区不是假 provider 吐的真实思考增量').toContainText('思考第')
      await expect(thinkFull, '有正文时不该再出"未接"占位').not.toContainText('思考全文通道未接')
    } finally {
      await fakeThink.close()
      // 恢复离线演示并探活：后续用例与「连跑两遍」都从同一状态起步
      await panelPage.evaluate(() => window.mz.setMock(true))
      for (let i = 0; i < 40; i++) {
        try {
          await panelPage.evaluate(() => window.mz.sendChat('待收尾', []))
          break
        } catch {
          await new Promise((r) => setTimeout(r, 500))
        }
      }
    }
  })

  test('面板③ 映射表：行内改分类 → 确认 → 账真的动了', async () => {
    await ensureBatches(1)
    await openPanel()
    const g = await askClassify('其他')

    const table = panelPage.getByTestId('classify-table')
    await expect(table, '引擎落门后没有渲染出归类映射表').toBeVisible({ timeout: 30_000 })
    // 表头笔数/组数 = 真实建议里的数字
    await expect(panelPage.getByTestId('classify-head')).toHaveText(
      `归类方案 · ${g.pendingCount} 笔 · ${g.groupCount} 组`,
    )
    // 行：商户 + 笔数 + 金额合计（走 money()）+ 分类输入框
    const rows = table.getByTestId('cls-row')
    await expect(rows, '映射表行数与真实分组数不一致').toHaveCount(g.groupCount)
    await expect(rows.first().getByTestId('cls-count')).toHaveText(`${g.count} 笔`)
    await expect(rows.first().getByTestId('cls-amount')).toContainText('¥')
    // 卡里带过来的建议分类是初值；没把握的组是空 + placeholder「未定」
    const cat = rows.first().getByTestId('cls-cat')
    await expect(cat, '分类输入框没有带上卡里的初值').toHaveValue('其他')

    // 行内改**只改本地 state**：改完还没点确认时，结果条待分类数不动
    await cat.fill('餐饮')
    await expect(
      panelPage.getByTestId('br-needs-category'),
      '还没点确认账就动了（行内改必须只改本地 state）',
    ).toHaveText(`⏸ ${g.pendingCount} 待分类`)

    await panelPage.getByTestId('cls-apply').click()
    const res = panelPage.getByTestId('cls-result')
    await expect(res, '确认后没有回执').toBeVisible()
    await expect(res).toContainText(`已归类 ${g.count} 笔`)
    // 账真的动了：结果条的待分类数掉下来（引擎把该组写进库里了）
    await expect(
      panelPage.getByTestId('br-needs-category'),
      '确认归类后待分类数没变（映射表没真的落库）',
    ).toHaveText('⏸ 0 待分类')
    // 撤销入口在
    await expect(panelPage.getByTestId('cls-undo')).toContainText('撤销这次归类')

    // 收尾：把夹具还原回「还有 1 笔待分类」，好让后面几条用例的 askClassify 读得到分组
    // （③ 确认归类是真的把账改掉了，④⑤ 的前置得从这里拿回来——撤销正是同一个入口）
    await panelPage.getByTestId('cls-undo').click()
    await expect(panelPage.getByTestId('br-needs-category'), '③ 收尾没把账还原回待分类').toHaveText(
      `⏸ ${g.pendingCount} 待分类`,
    )
  })

  test('面板④ 撤销这次归类：那批真的回到待分类', async () => {
    await ensureBatches(1)
    await openPanel()
    const g = await askClassify('其他')
    await expect(panelPage.getByTestId('classify-table')).toBeVisible({ timeout: 30_000 })
    await panelPage.getByTestId('cls-apply').click()
    await expect(panelPage.getByTestId('cls-result')).toContainText(`已归类 ${g.count} 笔`)
    await expect(panelPage.getByTestId('br-needs-category')).toHaveText('⏸ 0 待分类')

    await panelPage.getByTestId('cls-undo').click()
    await expect(panelPage.getByTestId('cls-undo-result')).toContainText(`已撤销 ${g.count} 笔`)
    // 撤销是真回退：待分类数回到原值，不是只在界面上换个说法
    await expect(panelPage.getByTestId('br-needs-category'), '撤销后账没回到待分类').toHaveText(
      `⏸ ${g.pendingCount} 待分类`,
    )
  })

  test('面板⑤ 关闭不中断任务：收着面板发指令，重开能看到完整回复与工具卡', async () => {
    await ensureBatches(1)
    await openPanel()
    await askClassify()

    // 立刻收起，不等这一轮跑完
    await panelPage.getByTestId('panel-toggle').click()
    await expect(panelPage.getByTestId('assistant-panel')).toHaveAttribute('aria-hidden', 'true')
    await panelPage.waitForTimeout(3_000)

    await openPanel()
    await expect(
      panelPage.getByTestId('panel-msg-assistant').last(),
      '收着面板这段时间里跑完的回复丢了',
    ).toBeVisible({ timeout: 30_000 })
    const tools = panelPage.getByTestId('panel-tool')
    const n = await tools.count()
    expect(n, '关面板期间的工具卡没留住').toBeGreaterThanOrEqual(2)
    await expect(tools.nth(n - 2)).toContainText('看有哪些待分类')
    await expect(tools.nth(n - 1)).toContainText('生成归类方案')
    // 期间落下的门卡重开后也看得见
    await expect(panelPage.getByTestId('classify-table'), '关面板期间落的门卡没恢复').toBeVisible()
  })

  test('面板⑥ 次级链接「逐笔手动」：跳账本并带上 needs_review 筛选', async () => {
    await ensureBatches(1)
    const bar = panelPage.getByTestId('batch-result-bar')
    await expect(bar).toBeVisible()
    await expect(bar.getByTestId('br-go-ledger')).toHaveText('逐笔手动')
    await bar.getByTestId('br-go-ledger').click()

    const ledger = panelPage.getByTestId('ledger-view')
    await expect(ledger, '次级链接没跳到账本屏').toBeVisible()
    await expect(ledger.getByTestId('ledger-f-state')).toHaveValue('needs_review')
    await expect(ledger.getByTestId('ledger-chip-state')).toContainText('待核对')
    await expect(ledger.locator('[data-testid="ledger-row"]'), '待分类那笔不在账本里').toHaveCount(1)
    await expect(ledger.locator('[data-testid="ledger-row"]').first()).toContainText('小明')

    // 全程无未捕获异常
    expect(panelErrors).toEqual([])
  })

  test('面板⑦ 速记行发的消息，面板流里有它自己的用户气泡（这一轮不是面板发的）', async () => {
    await ensureBatches(1)
    await panelPage.getByTestId('nav-inbox').click()
    await openPanel()

    const userBubbles = panelPage.getByTestId('panel-msg-user')
    const before = await userBubbles.count()

    // 从**速记行**发：这条路径不经过面板的 send()，面板本地不会塞乐观气泡，
    // 流里那条用户气泡只能来自引擎回显（user-message）。
    const capture = panelPage.getByLabel('速记行')
    await capture.press('Escape')
    await capture.fill('午饭 35 微信')
    await capture.press('Enter')

    await expect(
      userBubbles,
      '速记行发的这句在面板流里没有用户气泡（引擎没广播 user-message 回显）',
    ).toHaveCount(before + 1, { timeout: 30_000 })
    await expect(userBubbles.last(), '用户气泡的内容不是速记行发的那句').toContainText('午饭 35 微信')
    // 随后的助手回复也在流里（面板没把这轮显示成"只有用户消息、没有回答"）
    await expect(panelPage.getByTestId('panel-msg-assistant').last(), '速记行那轮的助手回复没进面板流').toBeVisible({
      timeout: 30_000,
    })

    expect(panelErrors).toEqual([])
  })

  test('面板⑧ 同一句话连发两次：两个用户气泡都在（去重不许把第二条吞掉）', async () => {
    await ensureBatches(1)
    await openPanel()

    // 用一句离线剧本不会命中任何工具规则的短句：这一轮纯文本，不改账、不落门。
    const sentence = '面板连发两次的去重锚点句'
    const matching = panelPage.getByTestId('panel-msg-user').filter({ hasText: sentence })
    await expect(matching, '这句之前不该在流里（否则数不清）').toHaveCount(0)

    for (let i = 0; i < 2; i++) {
      await panelPage.getByTestId('panel-input').fill(sentence)
      await panelPage.getByTestId('panel-send').click()
      // 等这一轮真的收完（输入框解锁）再发第二句 —— 不许把两轮叠在一轮里
      await expect(panelPage.getByTestId('panel-input'), `第 ${i + 1} 轮没有收尾，输入框一直是禁用的`).toBeEnabled({
        timeout: 30_000,
      })
      // 逐条数清：第 i 句发完就该有 i+1 个气泡（"最后一条同文本就跳过"的去重会永远停在 1）
      await expect(matching, `第 ${i + 1} 句发完后流里的同文本气泡数不对（去重把这一句吞了）`).toHaveCount(i + 1)
    }

    await expect(matching, '同一句话连发两次只剩一条气泡 —— §4 的去重 bug 还在').toHaveCount(2)
    expect(panelErrors).toEqual([])
  })
})

// ---------------------------------------------------------------------------
// 模型向导覆盖层（T0928 §1）：「＋ 新增预设」要真的"弹出来"，且入口分路。
//
// 缺陷：向导此前是 <AppShell> 的兄弟节点、排在整页文档流下方（.wizard 无 fixed、无遮罩），
// 首屏看不出任何变化，必须滚轮往下才看得见；且「新增 / 编辑」两路汇成一个处理器，
// 已有预设时点「＋ 新增预设」会被开成"编辑当前预设"。
//
// 验收口径（工单原文）：
//   ① 点「＋ 新增预设」→ 向导 boundingBox 在 viewport 内、页面未发生滚动；
//   ② Esc / 点遮罩 / ✕ 都能关；Esc 关闭 → 回设置页且滚动位置不跑偏；
//   ③ 回归：填自定义端点（假 key）保存 → 列表出现该预设；
//   ④ 已有 1 个预设时点「＋ 新增预设」→ 进 add 模式（不是编辑现有预设）。
// 每条用例起独立 Electron 实例（launchIsolated），不碰共享实例的设置屏状态。
// ---------------------------------------------------------------------------

/** 设置屏滚动三处的读数：window / 设置路由容器 / 视图容器。 */
async function scrollState(p: Page): Promise<{ win: number; route: number; view: number }> {
  return p.evaluate(() => ({
    win: window.scrollY,
    route: document.querySelector('.mz-route-scroll')?.scrollTop ?? -1,
    view: document.querySelector('.mz-view')?.scrollTop ?? -1,
  }))
}

test.describe('模型向导覆盖层（T0928 §1）', () => {
  test('向导① 打开即入眼：覆盖层铺满视口、卡片在视口内、页面零滚动、焦点进第一格', async () => {
    const { app: tApp, page: tPage } = await launchIsolated({})
    try {
      await tPage.getByTestId('nav-settings').click()
      await expect(tPage.getByTestId('settings-route')).toBeVisible()
      const before = await scrollState(tPage)

      await tPage.getByRole('button', { name: '＋ 新增预设' }).click()
      const overlay = tPage.getByTestId('wizard-overlay')
      await expect(overlay, '点「＋ 新增预设」后覆盖层没出现').toBeVisible()

      // 遮罩铺满整个视口（fixed inset 0）。Electron 页没有仿真视口（viewportSize() 为 null），
      // 视口尺寸以页面内 innerWidth/innerHeight 为准。
      const vp = await tPage.evaluate(() => ({ width: window.innerWidth, height: window.innerHeight }))
      const ob = (await overlay.boundingBox())!
      expect(Math.round(ob.x), '遮罩左缘不在视口左缘').toBe(0)
      expect(Math.round(ob.y), '遮罩上缘不在视口上缘').toBe(0)
      expect(Math.round(ob.width), '遮罩没铺满视口宽').toBe(vp.width)
      expect(Math.round(ob.height), '遮罩没铺满视口高').toBe(vp.height)

      // 卡片完整落在视口内（打开即入眼，不需要滚动去找它）
      const cb = (await tPage.getByTestId('wizard-card').boundingBox())!
      expect(cb.x, '卡片越出视口左缘').toBeGreaterThanOrEqual(0)
      expect(cb.y, '卡片越出视口上缘').toBeGreaterThanOrEqual(0)
      expect(cb.x + cb.width, '卡片越出视口右缘').toBeLessThanOrEqual(vp.width)
      expect(cb.y + cb.height, '卡片越出视口下缘（要滚轮才看得见的老毛病还在）').toBeLessThanOrEqual(vp.height)

      // 页面零滚动：打开向导前后，三处滚动读数一个都不许动
      const after = await scrollState(tPage)
      expect(after, '打开向导让页面滚动位置跑偏了').toEqual(before)

      // 焦点进第一格（Base URL）
      await expect(tPage.getByLabel('Base URL'), '打开后焦点没进第一格').toBeFocused()
    } finally {
      await tApp.close()
    }
  })

  test('向导② Esc / ✕ / 点遮罩都能关；关闭后回设置页、滚动不跑偏、焦点回「＋ 新增预设」', async () => {
    const { app: tApp, page: tPage } = await launchIsolated({})
    try {
      await tPage.getByTestId('nav-settings').click()
      const addBtn = tPage.getByRole('button', { name: '＋ 新增预设' })
      const overlay = tPage.getByTestId('wizard-overlay')
      const before = await scrollState(tPage)

      // 关法一：Esc
      await addBtn.click()
      await expect(overlay).toBeVisible()
      await tPage.keyboard.press('Escape')
      await expect(overlay, 'Esc 没能关掉向导').toHaveCount(0)
      await expect(tPage.getByTestId('settings-route'), 'Esc 关闭后没回到设置页').toBeVisible()
      expect(await scrollState(tPage), 'Esc 关闭后页面滚动位置跑偏了').toEqual(before)
      await expect(addBtn, '关闭后焦点没还回「＋ 新增预设」').toBeFocused()

      // 关法二：✕
      await addBtn.click()
      await expect(overlay).toBeVisible()
      await overlay.getByLabel('关闭向导').click()
      await expect(overlay, '✕ 没能关掉向导').toHaveCount(0)
      await expect(tPage.getByTestId('settings-route')).toBeVisible()
      expect(await scrollState(tPage), '✕ 关闭后页面滚动位置跑偏了').toEqual(before)

      // 关法三：点遮罩（点卡片外、视口角落的遮罩区）
      await addBtn.click()
      await expect(overlay).toBeVisible()
      await tPage.mouse.click(10, 10)
      await expect(overlay, '点遮罩没能关掉向导').toHaveCount(0)
      await expect(tPage.getByTestId('settings-route')).toBeVisible()
      expect(await scrollState(tPage), '点遮罩关闭后页面滚动位置跑偏了').toEqual(before)
    } finally {
      await tApp.close()
    }
  })

  test('向导③ 回归：自定义端点（假 key）走通向导 → 设置列表出现该预设', async () => {
    const fake = await startFakeProvider('ok')
    const { app: tApp, page: tPage } = await launchIsolated({})
    try {
      await tPage.getByTestId('nav-settings').click()
      await tPage.getByRole('button', { name: '＋ 新增预设' }).click()
      const overlay = tPage.getByTestId('wizard-overlay')
      await expect(overlay).toBeVisible()

      // 第 1 步：自定义端点 + 假 key
      await overlay.getByRole('button', { name: '自定义端点' }).click()
      await overlay.getByLabel('Base URL').fill(fake.url)
      await overlay.getByLabel('模型 ID').fill('fake-model')
      await overlay.getByLabel('API Key').fill('test-key-not-secret')
      await overlay.getByRole('button', { name: '测试连接 →' }).click()

      // 第 2 步：跑一次连接测试（假 provider 对非流式请求回 ok）→ 通过 → 下一步解锁
      await overlay.getByRole('button', { name: '重新测试' }).click()
      await expect(overlay.getByText(/✓ 连接成功/), '假 provider 下连接测试没通过').toBeVisible({ timeout: 30_000 })
      await overlay.getByRole('button', { name: '下一步：视觉自检 →' }).click()

      // 第 3 步：跳过视觉自检 → 完成配置
      await overlay.getByLabel(/跳过视觉自检/).check()
      await overlay.getByRole('button', { name: '完成配置' }).click()

      // 回设置页：列表里出现刚保存的预设（模型 ID 是检索锚点）
      await expect(overlay, '保存后向导没关闭').toHaveCount(0)
      await expect(
        tPage.locator('.provider-row').filter({ hasText: 'fake-model' }),
        '设置列表里没出现刚保存的自定义预设',
      ).toHaveCount(1)
    } finally {
      await tApp.close()
      await fake.close()
    }
  })

  test('向导④ 入口分路：已有预设时「＋ 新增预设」进 add 模式，行内「编辑」进该预设的 edit 模式', async () => {
    const fake = await startFakeProvider('ok')
    const { app: tApp, page: tPage } = await launchIsolated({})
    try {
      // 先用真实 IPC 造一个已激活预设（假 provider），刷新渲染层让设置列表拿到它
      await useFakeProvider(tPage, fake.url)
      await tPage.reload()
      await tPage.waitForSelector('.mz-shell', { timeout: 30_000 })
      await tPage.getByTestId('nav-settings').click()
      const row = tPage.locator('.provider-row').filter({ hasText: '假 provider' })
      await expect(row, '造好的假预设有没出现在设置列表').toHaveCount(1)

      // 点「＋ 新增预设」→ 必须是 add 模式（不是被开成编辑当前预设）
      await tPage.getByRole('button', { name: '＋ 新增预设' }).click()
      const overlay = tPage.getByTestId('wizard-overlay')
      await expect(overlay.getByRole('heading', { name: '添加模型预设' }), '已有预设时点新增被开成了编辑模式').toBeVisible()
      await expect(overlay.getByLabel('Base URL'), 'add 模式不该预填已有预设的 Base URL').not.toHaveValue(fake.url)
      await tPage.keyboard.press('Escape')
      await expect(overlay).toHaveCount(0)

      // 点该行的「编辑」→ 必须是这一行的 edit 模式（带它的配置进来）
      await row.getByRole('button', { name: '编辑' }).click()
      await expect(
        overlay.getByRole('heading', { name: '编辑模型预设' }),
        '点行内编辑没进 edit 模式',
      ).toBeVisible()
      await expect(overlay.getByLabel('Base URL'), 'edit 模式没带上该行预设的 Base URL').toHaveValue(fake.url)
    } finally {
      await tApp.close()
      await fake.close()
    }
  })

  test('向导⑥ 卡片有实底与投影：不是「透明外框」（背景变量作用域失效回归）', async () => {
    const { app: tApp, page: tPage } = await launchIsolated({})
    try {
      await tPage.getByTestId('nav-settings').click()
      await tPage.getByTestId('settings-route').waitFor()
      await tPage.getByRole('button', { name: '＋ 新增预设' }).click()
      await expect(tPage.getByTestId('wizard-card')).toBeVisible({ timeout: 10_000 })
      const style = await tPage.evaluate(() => {
        const el = document.querySelector('.wizard-card') as HTMLElement
        const cs = getComputedStyle(el)
        return { bg: cs.backgroundColor, shadow: cs.boxShadow, inShell: !!el.closest('.mz-shell') }
      })
      const m = /rgba?\((\d+),\s*(\d+),\s*(\d+)(?:,\s*([\d.]+))?\)/.exec(style.bg)
      expect(m, `卡片背景不是实色：${style.bg}`).not.toBeNull()
      const alpha = m && m[4] !== undefined ? Number(m[4]) : 1
      expect(alpha, `卡片背景是半透明/透明（${style.bg}）——变量作用域又失效了？`).toBe(1)
      expect(style.shadow, '卡片没有投影，会显得像贴上去的').not.toBe('none')
      console.log(`[实测] wizard-card 背景=${style.bg}｜投影=${style.shadow.slice(0, 40)}｜在壳内=${style.inShell}`)
    } finally {
      await tApp.close()
    }
  })
})

// ---------------------------------------------------------------------------
// 测试连接步（T0928 §2）：文案跟状态走 + 进入即测 + providerId 回落已存密钥。
//
// 缺陷：按钮文案写死「重新测试」（用户一次都没测过），且不点它无法进下一步；
//      编辑模式留空 Key 测试时没带 providerId，拿空 Key 打端点必然 401（主线缺陷①已修主进程侧）。
//
// 验收口径（工单原文）：
//   新建模式进步骤 2 → 按钮初始文案为「测试连接」；假端点通过 → 下一步可点；
//   失败 → 按钮变「重新测试」且下一步禁用。编辑模式：留空 Key + 已存密钥 → 测试通过（不得 401）。
// 每条用例起独立 Electron 实例（launchIsolated）。
// ---------------------------------------------------------------------------

/** 进设置屏并打开「＋ 新增预设」，第 1 步填自定义端点（假 provider）后点「测试连接 →」。 */
async function openWizardToStep2(tPage: Page, baseUrl: string): Promise<void> {
  await tPage.getByTestId('nav-settings').click()
  await tPage.getByRole('button', { name: '＋ 新增预设' }).click()
  const overlay = tPage.getByTestId('wizard-overlay')
  await expect(overlay).toBeVisible()
  await overlay.getByRole('button', { name: '自定义端点' }).click()
  await overlay.getByLabel('Base URL').fill(baseUrl)
  await overlay.getByLabel('模型 ID').fill('fake-model')
  await overlay.getByLabel('API Key').fill('test-key-not-secret')
  await overlay.getByRole('button', { name: '测试连接 →' }).click()
}

test.describe('测试连接步（T0928 §2）', () => {
  test('连接① 新建：进步骤 2 按钮初始文案是「测试连接」，且不点它也自动开测', async () => {
    const fake = await startFakeProvider('hang') // hang：连接挂起永不回 → 「测试中…」会稳定停住
    const { app: tApp, page: tPage } = await launchIsolated({})
    try {
      await tPage.getByTestId('nav-settings').click()
      await tPage.getByRole('button', { name: '＋ 新增预设' }).click()
      const overlay = tPage.getByTestId('wizard-overlay')
      await overlay.getByRole('button', { name: '自定义端点' }).click()
      await overlay.getByLabel('Base URL').fill(fake.url)
      await overlay.getByLabel('模型 ID').fill('fake-model')
      await overlay.getByLabel('API Key').fill('test-key-not-secret')

      // 同步读"从未测过"这一帧：DOM 触发 click 后让出一个微任务 —— React 同车道 flush
      // （微任务）落地成步骤 2，而 useEffect 的自动测试是宏任务、还没跑。
      const firstFrameLabels = await tPage.evaluate(async () => {
        const card = document.querySelector('.wizard-card')!
        const next = [...card.querySelectorAll('button')].find((b) => b.textContent?.trim() === '测试连接 →') as
          | HTMLButtonElement
          | undefined
        next!.click()
        await Promise.resolve()
        return [...card.querySelectorAll('.row button')].map((b) => b.textContent?.trim())
      })
      expect(firstFrameLabels, '进步骤 2 的初始帧里按钮写的不是「测试连接」').toContain('测试连接')
      expect(firstFrameLabels, '一次都还没测过，初始帧不该写「重新测试」').not.toContain('重新测试')

      // 自动测试：不点任何按钮，它自己进入「测试中…」（hang 假端点让它停在这一态）
      await expect(
        overlay.getByRole('button', { name: '测试中…' }),
        '进步骤 2 没有自动开测（按钮一直等人点）',
      ).toBeVisible({ timeout: 10_000 })
    } finally {
      await tApp.close()
      await fake.close()
    }
  })

  test('连接② 新建·通过：自动测出 ✓ 后按钮变「重新测试」，下一步可点', async () => {
    const fake = await startFakeProvider('ok')
    const { app: tApp, page: tPage } = await launchIsolated({})
    try {
      await openWizardToStep2(tPage, fake.url)
      const overlay = tPage.getByTestId('wizard-overlay')
      // 不点按钮：自动测试自己跑出 ✓
      await expect(overlay.getByText(/✓ 连接成功/), '进入步骤 2 后没有自动测出通过').toBeVisible({ timeout: 30_000 })
      await expect(overlay.getByRole('button', { name: '重新测试' }), '通过后按钮没变成「重新测试」').toBeEnabled()
      const next = overlay.getByRole('button', { name: '下一步：视觉自检 →' })
      await expect(next, '通过后下一步仍被禁用').toBeEnabled()
      await next.click()
      await expect(overlay.getByRole('heading', { name: '视觉自检' })).toBeVisible()
    } finally {
      await tApp.close()
      await fake.close()
    }
  })

  test('连接③ 新建·失败：按钮变「重新测试」且下一步禁用', async () => {
    // 不可达端点（127.0.0.1:9 = discard 端口，连接即被拒，失败很快，不用等 45s 超时）
    const { app: tApp, page: tPage } = await launchIsolated({})
    try {
      await openWizardToStep2(tPage, 'http://127.0.0.1:9/v1')
      const overlay = tPage.getByTestId('wizard-overlay')
      await expect(overlay.getByText(/✗ /), '不可达端点没有测出失败').toBeVisible({ timeout: 30_000 })
      await expect(overlay.getByRole('button', { name: '重新测试' }), '失败后按钮没变成「重新测试」').toBeEnabled()
      await expect(
        overlay.getByRole('button', { name: '下一步：视觉自检 →' }),
        '失败后下一步不该可点',
      ).toBeDisabled()
    } finally {
      await tApp.close()
    }
  })

  test('连接④ 编辑：留空 Key + 已存密钥 → 自动测通过（providerId 回落，不得 401）', async () => {
    const fake = await startFakeProvider('ok')
    const { app: tApp, page: tPage } = await launchIsolated({})
    try {
      // 造一个带密钥的已激活预设 → 编辑它（Key 留空 = 用已存密钥）
      await useFakeProvider(tPage, fake.url)
      await tPage.reload()
      await tPage.waitForSelector('.mz-shell', { timeout: 30_000 })
      await tPage.getByTestId('nav-settings').click()
      await tPage.locator('.provider-row').filter({ hasText: '假 provider' }).getByRole('button', { name: '编辑' }).click()
      const overlay = tPage.getByTestId('wizard-overlay')
      await expect(overlay.getByRole('heading', { name: '编辑模型预设' })).toBeVisible()
      // Key 留空直接进步骤 2
      await expect(overlay.getByLabel('API Key')).toHaveValue('')
      await overlay.getByRole('button', { name: '测试连接 →' }).click()
      // 自动测（带 providerId 回落已存密钥）→ 通过，且文案不是 401 这类裸错误
      const result = overlay.locator('p.ok, p.err').first()
      await expect(result, '编辑模式留空 Key 的自动测试没有出结果').toBeVisible({ timeout: 30_000 })
      await expect(result, '留空 Key 测出了 401 —— providerId 回落没生效').not.toContainText(/401/)
      await expect(result).toContainText('✓ 连接成功')
      await expect(overlay.getByRole('button', { name: '下一步：视觉自检 →' })).toBeEnabled()
    } finally {
      await tApp.close()
      await fake.close()
    }
  })

  test('连接⑤ 编辑·无已存密钥：失败但给明确文案，不裸 401', async () => {
    const fake = await startFakeProvider('ok')
    const { app: tApp, page: tPage, dataDir } = await launchIsolated({})
    try {
      // 造"配置在、密钥文件不在"：先正常存带密钥的预设，再删掉它的密钥文件
      // （生产同款现场：secrets 目录被清/换机拷过来密文解不出 → getSavedKey 取不到）。
      await useFakeProvider(tPage, fake.url)
      const keyFile = join(dataDir, 'secrets', 'provider-key_fakeprovider')
      expect(existsSync(keyFile), '密钥文件没落在预期位置（secrets 布局变了？）').toBe(true)
      unlinkSync(keyFile)

      await tPage.reload()
      await tPage.waitForSelector('.mz-shell', { timeout: 30_000 })
      await tPage.getByTestId('nav-settings').click()
      const row = tPage.locator('.provider-row').filter({ hasText: '假 provider' })
      await expect(row).toHaveCount(1)
      await expect(row.getByText('缺 Key'), '删掉密钥文件后设置列表还认为有 Key').toBeVisible()
      await row.getByRole('button', { name: '编辑' }).click()
      const overlay = tPage.getByTestId('wizard-overlay')
      await overlay.getByRole('button', { name: '测试连接 →' }).click()
      const result = overlay.locator('p.ok, p.err').first()
      await expect(result, '无已存密钥的自动测试没有出结果').toBeVisible({ timeout: 30_000 })
      await expect(result, '结果不该是成功（根本没 Key 可用）').toContainText('✗')
      await expect(result, '取不到已存密钥时给了裸 401，而不是明确文案').not.toContainText(/401/)
    } finally {
      await tApp.close()
      await fake.close()
    }
  })
})

// ---------------------------------------------------------------------------
// 账本详情改账户（T0928 §5，契约B 已就位：editTx {op:'set', fields:{accountName}}）。
//
// 现象：聊天记的账（未提账户时）落「现金」，用户想改账户，账本里改不了——
// 行详情（LedgerDetail）的账户栏此前是静态文本 + "改账户待后端"占位。
// 验收口径（工单原文）：详情把某笔从"现金"改到另一个账户 → 详情与列表都显示新账户名。
// ---------------------------------------------------------------------------
test.describe('账本详情改账户（T0928 §5）', () => {
  test('详情把某笔从「现金」改到「微信」→ 详情与列表同步显示新账户名', async () => {
    const { app: tApp, page: tPage } = await launchIsolated({})
    try {
      // 离线演示引擎就绪（与账本段 beforeAll 同口径）
      await tPage.evaluate(async () => {
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

      // 速记行记一笔（未提账户 → 落默认账户「现金」，离线演示解析即入账）
      const cap = tPage.getByLabel('速记行')
      await cap.fill('午饭 35')
      await cap.press('Enter')
      await expect(cap).toHaveValue('')

      // 账本屏出现该行，账户列是「现金」
      await tPage.getByTestId('nav-ledger').click()
      const row = tPage.locator('[data-testid="ledger-row"]').first()
      await expect(row, '记一笔后账本列表没出行').toBeVisible()
      await expect(row.locator('.mz-td-acc'), '新记的账没落在默认账户「现金」').toHaveText('现金')

      // 开详情：账户是可编辑下拉（不是静态文本/待后端占位），当前值已选中为「现金」
      await row.click()
      const detail = tPage.getByTestId('ledger-detail')
      await expect(detail).toBeVisible()
      const accSel = detail.getByTestId('ledger-edit-account')
      await expect(accSel, '详情里的账户不是可编辑下拉').toBeVisible()
      await expect(accSel, '账户下拉的当前值不是「现金」').toHaveValue('现金')
      await expect(detail.getByTestId('ledger-account-gap'), '"改账户待后端"占位还在').toHaveCount(0)

      // 改成「微信」→ 已保存 → 详情刷新成新账户
      await accSel.selectOption('微信')
      await expect(detail.getByTestId('ledger-saved'), '改账户没出「已保存」回执').toBeVisible({ timeout: 10_000 })
      await expect(accSel, '详情里的账户没刷成新账户').toHaveValue('微信')

      // 列表同步刷新（沿用既有 onChanged → reload 通路）
      await expect(row.locator('.mz-td-acc'), '账本列表的账户列没跟着改').toHaveText('微信')
    } finally {
      await tApp.close()
    }
  })
})

// ---------------------------------------------------------------------------
// 面板聊天化 + 全局滚动口径（T0928 第 3 轮 A/B）。
//
// 缺陷：消息一多，面板把应用整块撑高（.mz-shell / .mz-ap 都只有 min-height 无封顶），
// 滚的是整个页面，面板自己滚不了。
// 验收口径（工单原文）：
//   ① 面板内可滚（scrollHeight > clientHeight）；同一时刻 document.scrollingElement
//     不超过 innerHeight；② 新消息到达自动贴底（±2px；往上翻过就不抢，自己发新消息再贴底）；
//   ③ 气泡/角色标识结构可见且 testid 稳定；④ 逐屏外壳不滚动。
// ---------------------------------------------------------------------------

/** 打开面板（幂等，独立实例版）。 */
async function openPanelIsolated(p: Page): Promise<void> {
  const panel = p.getByTestId('assistant-panel')
  if ((await panel.getAttribute('aria-hidden')) === 'true') {
    await p.getByTestId('panel-toggle').click()
  }
  await expect(panel).toHaveAttribute('aria-hidden', 'false')
}

/** 面板流（.mz-ap-stream）的滚动三读数。 */
async function streamMetrics(p: Page): Promise<{ scrollTop: number; clientHeight: number; scrollHeight: number }> {
  return p.getByTestId('panel-stream').evaluate((el) => ({
    scrollTop: el.scrollTop,
    clientHeight: el.clientHeight,
    scrollHeight: el.scrollHeight,
  }))
}

/** 外壳（文档根）有没有发生整页滚动：scrollingElement 高度必须 <= 视口高。 */
async function shellPageOverflow(p: Page): Promise<number> {
  return p.evaluate(() => {
    const el = document.scrollingElement ?? document.documentElement
    return el.scrollHeight - window.innerHeight
  })
}

test.describe('面板聊天化与滚动口径（T0928 A/B）', () => {
  test('滚动① 面板内可滚、外壳零滚动、新消息贴底、上翻不抢、自发再贴底、气泡结构可见', async () => {
    const fake = await startFakeProvider('ok')
    const { app: tApp, page: tPage } = await launchIsolated({})
    try {
      await useFakeProvider(tPage, fake.url)
      // 引擎探活
      for (let i = 0; i < 40; i++) {
        try {
          await tPage.evaluate(() => window.mz.sendChat('待收尾', []))
          break
        } catch {
          await new Promise((r) => setTimeout(r, 500))
        }
        if (i === 39) throw new Error('假 provider 引擎 20s 内未就绪')
      }
      await openPanelIsolated(tPage)

      // 连发 8 轮把流撑出可滚高度（假 provider ok 模式秒回）
      for (let i = 1; i <= 8; i++) {
        await tPage.getByTestId('panel-input').fill(`第 ${i} 句`)
        await tPage.getByTestId('panel-send').click()
        await expect(tPage.getByTestId('panel-input'), `第 ${i} 轮没收尾`).toBeEnabled({ timeout: 30_000 })
      }

      // ① 面板内可滚
      const m1 = await streamMetrics(tPage)
      expect(m1.scrollHeight, '流没撑出可滚高度（面板内滚动不成立）').toBeGreaterThan(m1.clientHeight)
      // ① 同一时刻外壳零整页滚动
      expect(await shellPageOverflow(tPage), '外壳出现了整页长条滚动').toBeLessThanOrEqual(0)
      // ② 新消息到达自动贴底（±2px）
      expect(Math.abs(m1.scrollTop + m1.clientHeight - m1.scrollHeight), '新消息没自动贴底').toBeLessThanOrEqual(2)

      // ③ 气泡/角色标识：用户与助手气泡结构都在、角色标可见
      const roles = tPage.getByTestId('panel-msg-role')
      expect(await roles.count(), '没有角色标识').toBeGreaterThanOrEqual(2)
      await expect(tPage.getByTestId('panel-msg-user').first()).toHaveClass(/is-user/)
      await expect(tPage.getByTestId('panel-msg-assistant').first()).toHaveClass(/is-assistant/)

      // ④ 往上翻过就不抢：滚到顶，用速记行发起一轮（不是面板发的），面板不该被拽下去
      await tPage.getByTestId('panel-stream').evaluate((el) => {
        el.scrollTop = 0
      })
      expect((await streamMetrics(tPage)).scrollTop).toBe(0)
      const cap = tPage.getByLabel('速记行')
      await cap.fill('速记发起的一轮')
      await cap.press('Enter')
      // 等这一轮的用户气泡进流（回显），再看滚动位置
      await expect(
        tPage.getByTestId('panel-msg-user').filter({ hasText: '速记发起的一轮' }),
        '速记那轮的用户气泡没进面板流',
      ).toHaveCount(1)
      const m2 = await streamMetrics(tPage)
      expect(m2.scrollTop, '往上翻过之后，新消息把面板抢滚了').toBe(0)

      // ⑤ 自己发新消息时再贴底
      await tPage.getByTestId('panel-input').fill('我自己再说一句')
      await tPage.getByTestId('panel-send').click()
      await expect(tPage.getByTestId('panel-input')).toBeEnabled({ timeout: 30_000 })
      const m3 = await streamMetrics(tPage)
      expect(Math.abs(m3.scrollTop + m3.clientHeight - m3.scrollHeight), '自己发新消息没有回贴到底部').toBeLessThanOrEqual(2)
    } finally {
      await tApp.close()
      await fake.close()
    }
  })



  test('滚动② 逐屏外壳不滚动（收件箱/账本/报告/账户/设置）', async () => {
    const { app: tApp, page: tPage } = await launchIsolated({})
    try {
      // 给收件箱喂点内容（离线演示一批账单卡），证明有内容时外壳也不滚
      await tPage.evaluate(async () => {
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
      const cap = tPage.getByLabel('速记行')
      await cap.fill('账单里有咖啡两笔')
      await cap.press('Enter')
      await expect(tPage.locator('[data-testid="inbox-card"]').first(), '收件箱没喂出卡片').toBeVisible({
        timeout: 30_000,
      })

      for (const nav of ['inbox', 'ledger', 'report', 'accounts', 'settings'] as const) {
        await tPage.getByTestId(`nav-${nav}`).click()
        await expect(tPage.getByTestId(`nav-${nav}`)).toHaveAttribute('aria-current', 'page')
        expect(await shellPageOverflow(tPage), `「${nav}」屏外壳出现了整页滚动`).toBeLessThanOrEqual(0)
      }
    } finally {
      await tApp.close()
    }
  })
})

