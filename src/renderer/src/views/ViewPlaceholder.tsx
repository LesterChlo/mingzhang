import type { ReactElement } from 'react'

/** 占位屏通用件（§2.4 空态范式：图标 48px 30% 透明 + 主文案 + 引导）。样式全走 token。 */
export function ViewPlaceholder({
  title,
  hint,
  icon,
}: {
  title: string
  hint: string
  icon: ReactElement
}): ReactElement {
  return (
    <div className="mz-placeholder" data-testid="view-placeholder">
      <div className="mz-placeholder-icon">{icon}</div>
      <div className="mz-placeholder-title">{title}</div>
      <div className="mz-placeholder-hint">{hint}</div>
    </div>
  )
}
