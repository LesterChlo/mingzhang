import type { ReactElement } from 'react'
import { ViewPlaceholder } from './ViewPlaceholder'

/** 报告（§3.3）：当月大卡片 + 历史月份小卡网格，只读屏，本单占位。 */
export function ReportView(): ReactElement {
  return (
    <ViewPlaceholder
      title="报告 · 待实现"
      hint="月份大卡片与历史小卡网格将在数据接线单落地"
      icon={
        <svg
          width="48"
          height="48"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.5"
          strokeLinecap="round"
          strokeLinejoin="round"
          aria-hidden="true"
        >
          <path d="M3 3v18h18" />
          <path d="M18 17V9" />
          <path d="M13 17V5" />
          <path d="M8 17v-3" />
        </svg>
      }
    />
  )
}
