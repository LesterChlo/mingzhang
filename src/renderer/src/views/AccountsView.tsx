import type { ReactElement } from 'react'
import { ViewPlaceholder } from './ViewPlaceholder'

/** 账户（§3.4）：账户卡网格 + 分类 chips + 月度预算，本单占位。 */
export function AccountsView(): ReactElement {
  return (
    <ViewPlaceholder
      title="账户 · 待实现"
      hint="账户卡、分类管理与月度预算将在数据接线单落地"
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
          <path d="M21 12V7H5a2 2 0 0 1 0-4h14v4" />
          <path d="M3 5v14a2 2 0 0 0 2 2h16v-5" />
          <path d="M18 12a2 2 0 0 0 0 4h4v-4Z" />
        </svg>
      }
    />
  )
}
