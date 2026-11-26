// 骨架加载态（第八阶段）：替代单调的「正在加载…」，让首屏有形体感。

import type { ReactElement } from 'react'

export interface SkeletonProps {
  /** 骨架行数量。 */
  rows?: number
  /** 首行是否加高（模拟 KPI 卡）。 */
  tall?: boolean
  /** 末尾是否带一条短行。 */
  short?: boolean
}

export function Skeleton({ rows = 3, tall = false, short = false }: SkeletonProps): ReactElement {
  return (
    <div className="mz-biz-skeleton" role="status" aria-label="正在加载">
      {Array.from({ length: rows }).map((_, i) => (
        <div
          key={i}
          className={`mz-biz-skeleton-row${tall && i === 0 ? ' is-tall' : ''}`}
        />
      ))}
      {short && <div className="mz-biz-skeleton-row is-short" />}
    </div>
  )
}