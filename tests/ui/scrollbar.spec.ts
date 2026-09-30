// 自绘滚动指示条巡检（Playwright × Electron）——工单 T0930-1820「隐藏原生条 + 自绘细条」。
//
// 覆盖：① 原生滚动条真隐藏（overflow:scroll 探针的占位宽 == 0）
//      ② 指示条在 DOM 里，且 pointer-events: none（不拦指针）
//      ③ 真实滚动容器滚动 → 指示条显形（display:block + is-visible）
//      ④ 停下约 900ms 后自动淡出（is-visible 消失，量出实际耗时）
//      ⑤ 几何随滚动走位：scrollTop=0 时滑块贴轨道顶、scrollTop=max 时滑块贴轨道底
//
// 为什么必须自绘（实测，别改回去，证据见 .scratch/T0930-1750-*.log 与 .scratch/T0930-1820-*.log）：
//   · 主进程 app.commandLine.appendSwitch('enable-features','OverlayScrollbar') 无效（仍占 15px）——
//     Chromium 的 FeatureList 在进程启动早期冻结；webPreferences.additionalArguments 同样无效；
//   · 只有**启动命令行**真传该 flag 才 0px，而打包后用户是双击快捷方式启动，拿不到；
//   · ::-webkit-scrollbar 自定义伪元素又会把覆盖式顶回占位式（实测 6px）。
//   → 所以走：scrollbar-width: none + ::-webkit-scrollbar{display:none} 彻底隐藏原生条，
//     条本体由 src/renderer/src/shell/ScrollIndicators.tsx 自绘（不占位、滚动时淡入、停下淡出）。
//
// 滚动能力红线：本用例只隐藏**可见的条**，不删滚动——容器仍是 overflow:auto（滚轮/键盘照常），
// 断言③⑤ 就是在真实容器上滚动的，滚不动的话用例自己会红。
//
// 数据纪律：
//   隔离：MZ_DATA_DIR 与 --user-data-dir 都是 mkdtemp 临时目录，真实账本 %APPDATA% 全程不碰。
//   本用例不注入任何账本数据：只用真实界面的滚动容器 + 一个渲染层探针量滚动条行为。

import { test, expect, _electron, type ElectronApplication, type Page } from '@playwright/test'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/** 起一个独立 Electron 实例：账本数据目录与 user-data-dir 都是临时目录。 */
async function launchIsolated(): Promise<{ app: ElectronApplication; page: Page }> {
  const dataDir = mkdtempSync(join(tmpdir(), 'mz-scroll-data-'))
  const userDataDir = mkdtempSync(join(tmpdir(), 'mz-scroll-udd-'))
  const app = await _electron.launch({
    args: ['.', `--user-data-dir=${userDataDir}`],
    env: { ...process.env, MZ_DATA_DIR: dataDir } as Record<string, string>,
  })
  const page = await app.firstWindow()
  await page.waitForSelector('.mz-shell', { timeout: 30_000 })
  return { app, page }
}

/** 注入一个 overflow:scroll 探针 div，量它被滚动条吃掉的宽度（占位式 = 15px，隐藏 = 0）。 */
async function scrollbarGutter(page: Page): Promise<number> {
  return page.evaluate(() => {
    const d = document.createElement('div')
    d.style.cssText = 'position:fixed;left:-9999px;top:0;width:120px;height:120px;overflow:scroll'
    d.innerHTML = '<div style="height:400px"></div>'
    document.body.appendChild(d)
    const g = d.offsetWidth - d.clientWidth
    d.remove()
    return g
  })
}

/**
 * 在**真实界面**里挑一个当前真有可滚高度的容器（不造假环境）：
 * 走一遍导航屏，取「用户真正会滚的那一栏」——即 overflowY 为 auto/scroll、scrollHeight 超出
 * clientHeight 且有足够高度的候选里面积最大的那个。
 *
 * 返回**选择器字符串**而不是元素引用：那屏的 React 重渲染（数据到位后重排）会换掉 DOM 节点，
 * 早先打在节点上的 data-* 标记会跟着旧节点一起消失（实测踩过：③ 刚打完标记，5 秒后 ④ 就找不到）。
 * 选择器按 data-testid / 唯一类名取，每次用 querySelector 现查，扛得住重渲染。
 * 找不到就抛出去（说明这些屏整页都在滚 / 没有可滚容器），而不是偷偷造一个假容器。
 */
async function pickRealScroller(
  page: Page,
): Promise<{ selector: string; label: string; scrollHeight: number; clientHeight: number }> {
  // 确定性挑容器（不靠「页面恰好溢出一点」——实测某次只剩 43px 溢出，内容一变就找不到容器，
  // 在 CI 上就是随机红）：直接取设置屏的真实滚动容器 [data-testid="settings-route"]；
  // 若它此刻没溢出（内容短），在其内部注入一个**测试专用撑高块**把容器撑开。
  // 容器与指示条全是真的，只有「内容长度」由测试注入，滚动行为走真实 DOM。
  await page.getByTestId('nav-settings').click()
  await page.waitForTimeout(400)
  return page.evaluate(() => {
    const el = document.querySelector('[data-testid="settings-route"]') as HTMLElement | null
    if (!el) throw new Error('设置屏的滚动容器 [data-testid="settings-route"] 不存在')
    if (el.scrollHeight - el.clientHeight < 20) {
      const spacer = document.createElement('div')
      spacer.setAttribute('data-testid', 'scroll-spacer')
      spacer.style.height = '900px'
      el.appendChild(spacer)
    }
    return {
      selector: '[data-testid="settings-route"]',
      label: 'settings-route',
      scrollHeight: el.scrollHeight,
      clientHeight: el.clientHeight,
    }
  })
}

/** 把某个真实滚动容器滚到指定位置并派发一次 scroll 事件（scroll 不冒泡，靠 document 捕获阶段收）。 */
async function scrollProbe(page: Page, selector: string, top: number | 'max'): Promise<number> {
  return page.evaluate(
    ({ sel, t }) => {
      const el = document.querySelector(sel)
      if (!el) throw new Error(`真实滚动容器 ${sel} 不见了（重渲染换掉了节点）`)
      el.scrollTop = t === 'max' ? el.scrollHeight : t
      el.dispatchEvent(new Event('scroll'))
      return el.scrollTop
    },
    { sel: selector, t: top },
  )
}

/** 读指示条当前状态：显隐（inline style + 类）、指针穿透、当前矩形。 */
async function indicatorState(
  page: Page,
): Promise<{
  display: string
  visible: boolean
  pointerEvents: string
  rect: { top: number; bottom: number }
} | null> {
  return page.evaluate(() => {
    const el = document.querySelector('[data-testid="scroll-indicator"]')
    if (!el) return null
    const r = el.getBoundingClientRect()
    return {
      display: (el as HTMLElement).style.display,
      visible: el.classList.contains('is-visible'),
      pointerEvents: getComputedStyle(el).pointerEvents,
      rect: { top: r.top, bottom: r.bottom },
    }
  })
}

/** 滑块与容器某一沿的间距（指示条还没画出来时返回 NaN，让 expect.poll 继续重试）。 */
async function thumbGap(page: Page, selector: string, edge: 'top' | 'bottom'): Promise<number> {
  return page.evaluate(
    ({ sel, e }) => {
      const c = document.querySelector(sel)
      const i = document.querySelector('[data-testid="scroll-indicator"]')
      if (!c) throw new Error(`真实滚动容器 ${sel} 不见了`)
      if (!i) return Number.NaN
      if ((i as HTMLElement).style.display !== 'block') return Number.NaN
      const cr = c.getBoundingClientRect()
      const ir = i.getBoundingClientRect()
      return e === 'top' ? ir.top - cr.top : cr.bottom - ir.bottom
    },
    { sel: selector, e: edge },
  )
}


/** 在页面内起一个滚动生命周期追踪器（rAF 逐帧采样，不受 Node 侧 poll 粒度影响）。 */
async function startScrollTrace(page: Page, selector: string, top: number): Promise<void> {
  await page.evaluate(
    ({ sel, t }) => {
      const el = document.querySelector(sel)
      const ind = document.querySelector('[data-testid="scroll-indicator"]')
      const w = window as unknown as { __mzScrollTrace?: unknown }
      w.__mzScrollTrace = null
      if (!el || !ind) return
      const start = performance.now()
      el.scrollTop = t
      el.dispatchEvent(new Event('scroll'))
      const tick = (): void => {
        const visible = ind.classList.contains('is-visible')
        const drawn = (ind as HTMLElement).style.display === 'block'
        const trace = (w.__mzScrollTrace ?? { shownMs: null, fadeMs: null, scrollTop: el.scrollTop }) as {
          shownMs: number | null
          fadeMs: number | null
          scrollTop: number
        }
        if (visible && drawn && trace.shownMs === null) trace.shownMs = performance.now() - start
        if (trace.shownMs !== null && !visible) {
          trace.fadeMs = performance.now() - start
          trace.scrollTop = el.scrollTop
          w.__mzScrollTrace = trace
          return
        }
        w.__mzScrollTrace = trace
        requestAnimationFrame(tick)
      }
      requestAnimationFrame(tick)
    },
    { sel: selector, t: top },
  )
}

/** 读追踪结果（fade 未完成时为 null）。 */
async function readScrollTrace(page: Page): Promise<{ shownMs: number | null; fadeMs: number | null; scrollTop: number } | null> {
  return page.evaluate(() => (window as unknown as { __mzScrollTrace?: { shownMs: number | null; fadeMs: number | null; scrollTop: number } }).__mzScrollTrace ?? null)
}

// ---------------------------------------------------------------------------

// 故意**不**开 mode:'serial'：一条断言红了不该让后面几条跟着「did not run」——
// 每条都要跑出自己的独立结论。③④⑤ 共用 ③ 里挑好的容器选择器（每次现查节点）；
// ③ 若挂掉，后两条会因拿不到容器而红，这是正确的失败，不是被跳过。

test.describe('自绘滚动指示条（原生条隐藏 + 滚动时显形）', () => {
  let app: ElectronApplication
  let page: Page
  /** ③④⑤ 共用的真实滚动容器（③ 里挑好，按选择器现查节点，扛得住 React 重渲染）。 */
  let scroller: { selector: string; label: string; scrollHeight: number; clientHeight: number } | null = null

  /** 取容器；③ 挂掉时给一句能直接定位的人话，而不是抛 "undefined.selector" 的天书。 */
  function needScroller(): { selector: string; label: string; scrollHeight: number; clientHeight: number } {
    if (!scroller) {
      throw new Error('③ 没挑到可驱动的真实滚动容器（③④⑤ 都依赖它）。先看 ③ 的失败原因——多半是那些屏整页都在滚。')
    }
    return scroller
  }

  test.beforeAll(async () => {
    const launched = await launchIsolated()
    app = launched.app
    page = launched.page
    // 压矮窗口逼出真实溢出（与 report-screen 同口径：滚动归区域，不归整页）
    await page.setViewportSize({ width: 1280, height: 520 })
  })

  test.afterAll(async () => {
    await app?.close()
  })

  test('滚动条① 原生滚动条完全隐藏：不占布局宽度（占位 0px）', async () => {
    const gutter = await scrollbarGutter(page)
    expect(gutter, '原生滚动条仍占位').toBe(0)
  })

  test('滚动条② 自绘指示条在 DOM 里且不拦指针', async () => {
    const indicator = page.getByTestId('scroll-indicator')
    await expect(indicator, '自绘指示条没挂到 shell 上').toHaveCount(1)
    const state = await indicatorState(page)
    expect(state, '指示条读不到').not.toBeNull()
    expect(state?.pointerEvents, '指示条会拦指针（会挡住滚动/点击）').toBe('none')
  })

  test('滚动条③ 真实容器滚动时指示条显形（display:block + is-visible）', async () => {
    const picked = await pickRealScroller(page)
    expect(picked.scrollHeight, `真实容器 ${picked.label} 没可滚高度，本条用例失去意义`).toBeGreaterThan(
      picked.clientHeight,
    )
    scroller = picked

    // 页面内 rAF 追踪：量出「派发滚动 → 真的画出并显形」的毫秒数（Node 侧 poll 粒度太粗，不采用）
    await startScrollTrace(page, needScroller().selector, 120)

    await expect
      .poll(async () => (await indicatorState(page))?.display, { timeout: 5000 })
      .toBe('block')
    await expect
      .poll(async () => (await indicatorState(page))?.visible, { timeout: 5000 })
      .toBe(true)
    const trace = await readScrollTrace(page)
    console.log(
      `[实测] 指示条显形耗时 ${trace?.shownMs?.toFixed(1)}ms（容器 ${picked.label}，scrollTop=${trace?.scrollTop}）`,
    )
    // 显形必须在一帧内跟上滚动（requestAnimationFrame 绘制），拖到几百毫秒就是真的卡
    expect(trace?.shownMs, '追踪器没采到显形时刻').not.toBeNull()
    expect(trace?.shownMs as number, '指示条显形慢得离谱（没走 rAF 绘制？）').toBeLessThan(200)
    expect(trace?.scrollTop as number, '真实容器滚不动（滚动能力被删了？）').toBeGreaterThan(0)
  })

  test('滚动条④ 停下后自动淡出（900ms 量级），且不拦任何指针', async () => {
    // 再滚一次重新武装 900ms 计时器；页面内 rAF 追踪量真实的「最后一次滚动 → 类被摘掉」耗时
    await startScrollTrace(page, needScroller().selector, 60)
    expect((await indicatorState(page))?.visible, '重新滚动后指示条没显形').toBe(true)

    await expect
      .poll(async () => (await indicatorState(page))?.visible, { timeout: 5000 })
      .toBe(false)
    const trace = await readScrollTrace(page)
    const fadeMs = trace?.fadeMs as number
    console.log(`[实测] 指示条淡出耗时 ${fadeMs?.toFixed(1)}ms（最后一次滚动之后，口径 HIDE_DELAY_MS=900）`)
    // 锁住「约 900ms 淡出」这条产品口径：早于 800ms 是闪一下就没，晚于 1600ms 是赖着不走
    expect(fadeMs, '追踪器没采到淡出时刻').not.toBeNull()
    expect(fadeMs, '淡出太快（滚动指示条一闪就消失）').toBeGreaterThanOrEqual(800)
    expect(fadeMs, '淡出太慢（停下后条赖着不走）').toBeLessThanOrEqual(1600)

    const after = await indicatorState(page)
    expect(after?.pointerEvents, '淡出后仍拦指针').toBe('none')
  })

  test('滚动条⑤ 几何随滚动走位：顶端贴轨道顶、底端贴轨道底', async () => {
    // scrollTop = 0 → 滑块顶边 ≈ 轨道顶（轨道上下各内缩 2px，容差 4px）
    await scrollProbe(page, needScroller().selector, 0)
    await expect
      .poll(async () => (await thumbGap(page, needScroller().selector, 'top')) <= 4, { timeout: 5000 })
      .toBe(true)
    const gapTop = await thumbGap(page, needScroller().selector, 'top')
    expect(gapTop, '滑块没贴轨道顶（或滑出了容器）').toBeGreaterThanOrEqual(0)
    console.log(`[实测] scrollTop=0 时滑块顶边距容器顶 ${gapTop.toFixed(2)}px（容器 ${needScroller().label}，轨道上内缩 2px）`)

    // scrollTop = max → 滑块底边 ≈ 容器底（容差 8px）
    await scrollProbe(page, needScroller().selector, 'max')
    await expect
      .poll(async () => (await thumbGap(page, needScroller().selector, 'bottom')) <= 8, { timeout: 5000 })
      .toBe(true)
    const gapBottom = await thumbGap(page, needScroller().selector, 'bottom')
    expect(gapBottom, '滑块没贴轨道底（或滑出了容器）').toBeGreaterThanOrEqual(0)
    console.log(`[实测] scrollTop=max 时滑块底边距容器底 ${gapBottom.toFixed(2)}px（容器 ${needScroller().label}，轨道下内缩 2px）`)
  })
})
