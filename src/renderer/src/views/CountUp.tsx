// 数字递增动画 + 迷你趋势箭头（Creamy Cozy 改造配套）。
//
// 目的：核心经营数字加载时平滑递增，而不是硬跳变——这是"灵动感"的关键之一，
// 同时保证数字准确（最终值严格等于传入值，动画只是过场）。
//
// 设计约束：
//   * 金额一律以「分」传入，组件内部换算，不引入浮点误差（最终帧强制对齐目标值）。
//   * 动画时长 ≤ 420ms，用 easeOutCubic，避免拖沓。
//   * 尊重 prefers-reduced-motion：直接显示终值。
//   * 千分位与货币符号沿用 lib/business 的 money()，保证与全站口径一致。

import { useEffect, useRef, useState } from 'react'
import type { ReactElement } from 'react'
import { money } from '../lib/business'

/** easeOutCubic：起步快、收尾柔，适合数字滚动。 */
function easeOutCubic(t: number): number {
  return 1 - Math.pow(1 - t, 3)
}

function prefersReducedMotion(): boolean {
  if (typeof window === 'undefined' || !window.matchMedia) return false
  return window.matchMedia('(prefers-reduced-motion: reduce)').matches
}

export interface CountUpMoneyProps {
  /** 目标金额（分）。 */
  cents: number
  /** 动画时长（毫秒）。 */
  duration?: number
  /** 额外 class。 */
  className?: string
}

/** 金额递增动画。终值严格等于 cents（不会因为动画产生分位误差）。 */
export function CountUpMoney({ cents, duration = 420, className }: CountUpMoneyProps): ReactElement {
  const [shown, setShown] = useState<number>(() => (prefersReducedMotion() ? cents : 0))
  const rafRef = useRef<number | null>(null)
  const fromRef = useRef(0)

  useEffect(() => {
    if (prefersReducedMotion()) {
      setShown(cents)
      return
    }
    const from = fromRef.current
    const delta = cents - from
    if (delta === 0) {
      setShown(cents)
      return
    }
    const start = performance.now()
    const tick = (now: number): void => {
      const p = Math.min(1, (now - start) / duration)
      const v = from + delta * easeOutCubic(p)
      if (p >= 1) {
        // 收尾强制对齐目标值：动画绝不改变最终数字
        setShown(cents)
        fromRef.current = cents
        rafRef.current = null
        return
      }
      setShown(v)
      rafRef.current = requestAnimationFrame(tick)
    }
    rafRef.current = requestAnimationFrame(tick)
    return () => {
      if (rafRef.current !== null) cancelAnimationFrame(rafRef.current)
      fromRef.current = cents
    }
  }, [cents, duration])

  // 取整到分再格式化，避免出现 ¥12.345 这种浮点尾巴
  return <span className={className}>{money(Math.round(shown))}</span>
}

export interface DeltaBadgeProps {
  /** 变化率（0.12 = +12%）；null = 无从比较，不显示。 */
  ratio: number | null
  /** 语义：上升是好事还是坏事（支出上升是坏事）。 */
  goodWhenUp?: boolean
  /** 文案后缀，如「较上月」。 */
  suffix?: string
}

/** 趋势箭头 + 百分比。数据不足时渲染 null（不编造数字）。 */
export function DeltaBadge({ ratio, goodWhenUp = true, suffix }: DeltaBadgeProps): ReactElement | null {
  if (ratio === null || !Number.isFinite(ratio)) return null
  const up = ratio > 0.0005
  const flat = Math.abs(ratio) <= 0.0005
  const good = flat ? null : up === goodWhenUp
  const cls = good === null ? 'is-flat' : good ? 'is-good' : 'is-bad'
  const arrow = flat ? '—' : up ? '▲' : '▼'
  const pct = `${Math.abs(ratio * 100).toFixed(1)}%`
  return (
    <span className={`mz-delta ${cls}`} title={suffix ? `${suffix} ${up ? '上升' : flat ? '持平' : '下降'} ${pct}` : undefined}>
      <span className="mz-delta-arrow" aria-hidden="true">{arrow}</span>
      <span className="mz-num">{pct}</span>
      {suffix && <span className="mz-delta-suffix">{suffix}</span>}
    </span>
  )
}
