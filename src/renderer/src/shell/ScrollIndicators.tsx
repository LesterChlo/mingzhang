// 自绘滚动指示条：原生条已被 shell.css 隐藏（scrollbar-width: none + ::-webkit-scrollbar
// 都不占位）；这里在滚动时浮出一根细条，停下淡出。
//
// 为什么是自绘（实测，别改回去；证据见 .scratch/T0930-1750-*.log 与 .scratch/T0930-1820-*.log）：
//   主进程 app.commandLine.appendSwitch('enable-features','OverlayScrollbar') 与
//   webPreferences.additionalArguments 实测都无效（仍占 15px）——Chromium 的 FeatureList 在
//   进程启动早期就冻结；只有**启动命令行**真传该 flag 才 0px，而打包后用户是双击快捷方式启动，
//   拿不到。::-webkit-scrollbar 自定义伪元素又会把覆盖式顶回占位式。所以只能隐藏原生条 + 自绘。
//
// 不改任何滚动容器的结构：靠 document 捕获阶段的 scroll 事件监听全部容器
//（scroll 不冒泡，但捕获阶段能收到）。
import { useEffect, useRef } from 'react'
import type { ReactElement } from 'react'

/** 最后一次滚动后多久淡出（工单口径：约 1 秒） */
const HIDE_DELAY_MS = 900
/** 轨道距容器右沿的内缩（px） */
const TRACK_INSET_RIGHT = 3
/** 轨道距容器上下沿的内缩（px） */
const TRACK_INSET_Y = 2
/** 滑块宽度（px） */
const THUMB_WIDTH = 6
/** 滑块最小高度（px）：内容很长时也不缩成一根针 */
const MIN_THUMB = 24

export function ScrollIndicators(): ReactElement {
  const ref = useRef<HTMLDivElement | null>(null)

  useEffect(() => {
    const el = ref.current
    if (!el) return
    let timer: number | undefined
    let raf = 0
    let target: HTMLElement | null = null
    let shown = false

    const hide = (): void => {
      el.style.display = 'none'
      if (shown) {
        shown = false
        el.classList.remove('is-visible')
      }
    }

    /** 按最近一次滚动的目标容器重算滑块几何（读布局集中在这里，避免滚动中反复读）。 */
    const draw = (): void => {
      raf = 0
      const t = target
      if (!t) return hide()
      const span = t.scrollHeight - t.clientHeight
      const rect = t.getBoundingClientRect()
      // 没得滚 / 尺寸未成形 / 完全在视口外 → 不画（别留一根悬在空白处的条）
      if (span <= 1 || rect.height <= 0 || rect.bottom < 0 || rect.top > window.innerHeight) return hide()
      const trackTop = rect.top + TRACK_INSET_Y
      const trackH = rect.height - TRACK_INSET_Y * 2
      const thumbH = Math.max(MIN_THUMB, (trackH * t.clientHeight) / t.scrollHeight)
      const ratio = Math.min(1, Math.max(0, t.scrollTop / span))
      el.style.left = `${rect.right - TRACK_INSET_RIGHT - THUMB_WIDTH}px`
      el.style.width = `${THUMB_WIDTH}px`
      el.style.top = `${trackTop + (trackH - thumbH) * ratio}px`
      el.style.height = `${thumbH}px`
      el.style.display = 'block'
    }

    const onScroll = (e: Event): void => {
      const t = e.target
      if (!(t instanceof HTMLElement)) return
      // 只认真正能纵向滚的容器（横向滚动条不在本单范围）
      if (t.scrollHeight - t.clientHeight <= 1) return
      target = t
      if (!shown) {
        shown = true
        el.classList.add('is-visible')
      }
      if (timer) window.clearTimeout(timer)
      timer = window.setTimeout(() => {
        shown = false
        el.classList.remove('is-visible')
      }, HIDE_DELAY_MS)
      if (!raf) raf = window.requestAnimationFrame(draw)
    }

    document.addEventListener('scroll', onScroll, { capture: true, passive: true })
    // 窗口尺寸变了，之前算的轨道位置就作废了，重画一次（此刻可能还有未淡出的条）
    window.addEventListener('resize', draw)
    return () => {
      document.removeEventListener('scroll', onScroll, { capture: true })
      window.removeEventListener('resize', draw)
      if (timer) window.clearTimeout(timer)
      if (raf) window.cancelAnimationFrame(raf)
    }
  }, [])

  // pointer-events: none 写在样式表里：它是「不拦指针」这条红线的唯一执行点，别搬进这里。
  return <div ref={ref} className="mz-scroll-indicator" data-testid="scroll-indicator" style={{ display: 'none' }} />
}
