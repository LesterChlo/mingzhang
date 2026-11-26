// 纯 SVG 图表组件（第六阶段）——不引入任何第三方图表库，全部手写 SVG。
// 配色走 CSS 变量（--accent / --info / --warn / --danger / 序列色），深浅主题自动适配。
// 所有金额入参为「分」，由调用方格式化。

import { useId } from 'react'
import type { ReactElement } from 'react'

/** 图表序列色（环形/柱状按序取色）——奶油治愈风：鼠尾草绿/豆沙/咖啡/燕麦/灰蓝。 */
const SERIES = [
  'var(--sage)',
  'var(--clay)',
  'var(--coffee)',
  'var(--accent)',
  'var(--warn)',
  'var(--info)',
  'color-mix(in srgb, var(--sage) 62%, var(--bg-1))',
  'color-mix(in srgb, var(--clay) 55%, var(--bg-1))',
]

export function seriesColor(index: number): string {
  return SERIES[index % SERIES.length]
}

// === 环形图（占比） ===
export interface DonutSlice {
  label: string
  value: number
  color?: string
}

export interface DonutChartProps {
  slices: DonutSlice[]
  /** 中心主文字（如总额）。 */
  centerText?: string
  /** 中心副文字。 */
  centerSub?: string
  size?: number
  thickness?: number
}

export function DonutChart({ slices, centerText, centerSub, size = 180, thickness = 26 }: DonutChartProps): ReactElement {
  const total = slices.reduce((s, x) => s + Math.max(0, x.value), 0)
  if (total <= 0 || slices.length === 0) {
    return <div className="mz-chart-empty">暂无数据</div>
  }
  const r = (size - thickness) / 2
  const c = size / 2
  const circumference = 2 * Math.PI * r
  let offset = 0
  const gid = `mzDonutGrad`

  return (
    <div className="mz-chart-donut">
      <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} role="img" aria-label="占比环形图">
        <defs>
          {/* 每片给一层极轻的径向渐变，让色块有体积感（奶油风的轻拟物） */}
          {slices.map((_, i) => (
            <radialGradient key={`${gid}-${i}`} id={`${gid}-${i}`} cx="34%" cy="26%" r="82%">
              <stop offset="0%" stopColor={seriesColor(i)} stopOpacity={0.95} />
              <stop offset="100%" stopColor={seriesColor(i)} stopOpacity={0.78} />
            </radialGradient>
          ))}
        </defs>
        {/* 底环 */}
        <circle cx={c} cy={c} r={r} fill="none" stroke="var(--bg-3)" strokeWidth={thickness} />
        {slices.map((s, i) => {
          const value = Math.max(0, s.value)
          const len = (value / total) * circumference
          const dash = `${len} ${circumference - len}`
          const el = (
            <circle
              key={`${s.label}-${i}`}
              cx={c}
              cy={c}
              r={r}
              fill="none"
              stroke={s.color ?? `url(#${gid}-${i})`}
              strokeWidth={thickness}
              strokeDasharray={dash}
              strokeDashoffset={-offset}
              transform={`rotate(-90 ${c} ${c})`}
              strokeLinecap="butt"
              className="mz-donut-arc"
              style={{ animationDelay: `${i * 70}ms` }}
            >
              <title>{`${s.label}：${((value / total) * 100).toFixed(1)}%`}</title>
            </circle>
          )
          offset += len
          return el
        })}
        {centerText && (
          <text
            x={c}
            y={centerSub ? c - 4 : c + 4}
            textAnchor="middle"
            fill="var(--text-1)"
            fontSize={size / 9}
            fontWeight="600"
          >
            {centerText}
          </text>
        )}
        {centerSub && (
          <text x={c} y={c + size / 9} textAnchor="middle" fill="var(--text-2)" fontSize={size / 18}>
            {centerSub}
          </text>
        )}
      </svg>
      <ul className="mz-chart-legend">
        {slices.map((s, i) => {
          const pct = total > 0 ? (Math.max(0, s.value) / total) * 100 : 0
          return (
            <li key={`${s.label}-legend-${i}`}>
              <span className="mz-chart-dot" style={{ background: s.color ?? seriesColor(i) }} />
              <span className="mz-chart-legend-label">{s.label}</span>
              <span className="mz-chart-legend-pct mz-num">{pct.toFixed(1)}%</span>
            </li>
          )
        })}
      </ul>
    </div>
  )
}

// === 柱状图（排行 / 日趋势） ===
export interface BarDatum {
  label: string
  value: number
  /** 悬停完整说明。 */
  title?: string
  color?: string
}

export interface BarChartProps {
  data: BarDatum[]
  /** 值格式化（轴标签与提示）。 */
  format: (v: number) => string
  /** 柱高（像素）。 */
  height?: number
  /** 是否显示数值轴网格。 */
  showGrid?: boolean
  /** 负值用红色。 */
  negativeRed?: boolean
}

export function BarChart({ data, format, height = 160, showGrid = true, negativeRed = false }: BarChartProps): ReactElement {
  if (data.length === 0) return <div className="mz-chart-empty">暂无数据</div>

  const values = data.map((d) => d.value)
  const maxV = Math.max(...values, 0)
  const minV = Math.min(...values, 0)
  const span = maxV - minV || 1
  const padTop = 12
  const padBottom = 20
  const plotH = Math.max(40, height - padTop - padBottom)
  const zeroY = padTop + (maxV / span) * plotH
  const w = 100 // 用百分比布局，viewBox 宽度按柱数
  const gap = data.length > 20 ? 0.15 : 0.3
  const barW = w / data.length

  return (
    <div className="mz-chart-bar-wrap">
      <svg
        className="mz-chart-bar"
        viewBox={`0 0 ${w} ${height}`}
        preserveAspectRatio="none"
        role="img"
        aria-label="柱状图"
      >
        {showGrid && (
          <>
            <line x1={0} y1={padTop} x2={w} y2={padTop} stroke="var(--line)" strokeWidth={0.3} />
            <line x1={0} y1={zeroY} x2={w} y2={zeroY} stroke="var(--line-strong)" strokeWidth={0.4} />
          </>
        )}
        {data.map((d, i) => {
          const x = i * barW + barW * (gap / 2)
          const bw = barW * (1 - gap)
          const isNeg = d.value < 0
          const vh = (Math.abs(d.value) / span) * plotH
          const y = isNeg ? zeroY : zeroY - vh
          const color = d.color ?? (negativeRed && isNeg ? 'var(--loss)' : 'var(--accent)')
          return (
            <rect
              key={`${d.label}-${i}`}
              x={x}
              y={y}
              width={bw}
              height={Math.max(vh, d.value === 0 ? 0.3 : 0.6)}
              fill={color}
              rx={0.5}
              className="mz-bar"
              style={{ animationDelay: `${i * 30}ms` }}
            >
              <title>{d.title ?? `${d.label}：${format(d.value)}`}</title>
            </rect>
          )
        })}
      </svg>
      <div className="mz-chart-bar-axis">
        {data.map((d, i) => (
          <span
            key={`axis-${d.label}-${i}`}
            // 柱太多时只显示部分标签，避免糊成一团
            className={`mz-chart-bar-tick${shouldShowTick(i, data.length) ? '' : ' is-hidden'}`}
          >
            {d.label}
          </span>
        ))}
      </div>
    </div>
  )
}

/** 标签抽稀：超过 12 根柱时每 3 根显示一个，首尾必显。 */
function shouldShowTick(index: number, total: number): boolean {
  if (total <= 12) return true
  if (index === 0 || index === total - 1) return true
  return index % 3 === 0
}

// === 折线趋势图 ===
export interface LinePoint {
  label: string
  value: number
  title?: string
}

export interface LineChartProps {
  points: LinePoint[]
  format: (v: number) => string
  height?: number
  color?: string
  /** 是否填充线下方面积。 */
  area?: boolean
}

export function LineChart({ points, format, height = 170, color = 'var(--accent)', area = true }: LineChartProps): ReactElement {
  if (points.length === 0) return <div className="mz-chart-empty">暂无数据</div>

  const w = 100
  const padTop = 14
  const padBottom = 20
  const plotH = Math.max(40, height - padTop - padBottom)
  const values = points.map((p) => p.value)
  const maxV = Math.max(...values, 0)
  const minV = Math.min(...values, 0)
  const span = maxV - minV || 1
  const stepX = points.length > 1 ? w / (points.length - 1) : 0
  const toY = (v: number): number => padTop + ((maxV - v) / span) * plotH
  const coords = points.map((p, i) => ({ x: i * stepX, y: toY(p.value), p }))
  const linePath = coords.map((c, i) => `${i === 0 ? 'M' : 'L'}${c.x},${c.y}`).join(' ')
  const areaPath = `${linePath} L${w},${padTop + plotH} L0,${padTop + plotH} Z`
  const zeroY = toY(0)
  const gid = useId().replace(/:/g, '')
  const areaId = `mzArea-${gid}`

  return (
    <div className="mz-chart-line-wrap">
      <svg
        className="mz-chart-line"
        viewBox={`0 0 ${w} ${height}`}
        preserveAspectRatio="none"
        role="img"
        aria-label="趋势折线图"
      >
        <defs>
          {/* 线下面积用自上而下的渐隐，比平涂更有呼吸感 */}
          <linearGradient id={areaId} x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor={color} stopOpacity={0.22} />
            <stop offset="70%" stopColor={color} stopOpacity={0.05} />
            <stop offset="100%" stopColor={color} stopOpacity={0} />
          </linearGradient>
        </defs>
        {area && <path d={areaPath} fill={`url(#${areaId})`} />}
        <line x1={0} y1={zeroY} x2={w} y2={zeroY} stroke="var(--line)" strokeWidth={0.3} strokeDasharray="1.2 1.2" />
        <path
          d={linePath}
          fill="none"
          stroke={color}
          strokeWidth={0.8}
          strokeLinejoin="round"
          strokeLinecap="round"
          className="mz-line-path"
        />
        {coords.map((c, i) => (
          <circle
            key={`pt-${i}`}
            cx={c.x}
            cy={c.y}
            r={1}
            fill="var(--bg-1)"
            stroke={color}
            strokeWidth={0.55}
            className="mz-line-dot"
            style={{ animationDelay: `${120 + i * 60}ms` }}
          >
            <title>{c.p.title ?? `${c.p.label}：${format(c.p.value)}`}</title>
          </circle>
        ))}
      </svg>
      <div className="mz-chart-line-axis">
        {points.map((p, i) => (
          <span key={`${p.label}-${i}`} className="mz-chart-line-tick">{p.label}</span>
        ))}
      </div>
    </div>
  )
}

// === 横向进度条（商品排行/占比列表） ===
export interface RankBarProps {
  items: { label: string; sub?: string; value: number; formatted: string }[]
  /** 用于配色（负值红）。 */
  negativeRed?: boolean
}

export function RankBars({ items, negativeRed = false }: RankBarProps): ReactElement {
  if (items.length === 0) return <div className="mz-chart-empty">暂无数据</div>
  const maxAbs = Math.max(...items.map((x) => Math.abs(x.value)), 1)
  return (
    <ul className="mz-chart-rank">
      {items.map((item, i) => {
        const pct = (Math.abs(item.value) / maxAbs) * 100
        const isNeg = item.value < 0
        return (
          <li key={`${item.label}-${i}`} className="mz-chart-rank-item">
            <span className="mz-chart-rank-index">{i + 1}</span>
            <div className="mz-chart-rank-body">
              <div className="mz-chart-rank-head">
                <span className="mz-chart-rank-label">{item.label}</span>
                {item.sub && <span className="mz-chart-rank-sub">{item.sub}</span>}
                <span className={`mz-chart-rank-value mz-num${negativeRed && isNeg ? ' is-neg' : ''}`}>{item.formatted}</span>
              </div>
              <div className="mz-chart-rank-track">
                <div
                  className={`mz-chart-rank-fill${negativeRed && isNeg ? ' is-neg' : ''}`}
                  style={{ width: `${pct}%`, background: negativeRed && isNeg ? 'var(--danger)' : seriesColor(i) }}
                />
              </div>
            </div>
          </li>
        )
      })}
    </ul>
  )
}
