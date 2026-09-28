import type { ReactElement } from 'react'
import type { AppConfigDTO } from '../../../shared/types'
import { SettingsView } from '../components/SettingsView'

/** 设置路由（§3.5）：本单直接复用现有 SettingsView，功能不丢、不重写。 */
export interface SettingsRouteProps {
  state: AppConfigDTO
  reload: () => Promise<void>
  /** 从设置返回上一层（左栏仍是导航，这里只用于把外壳切回收件箱）。 */
  onDone: () => void
  onAddProvider: () => void
  /** T0928 §1：编辑按行落点——传入该行预设 id（此前两路合一，新增会被开成编辑当前预设）。 */
  onEditProvider: (id: string) => void
  onContinueSession: () => void
}

export function SettingsRoute({
  state,
  reload,
  onDone,
  onAddProvider,
  onEditProvider,
  onContinueSession,
}: SettingsRouteProps): ReactElement {
  return (
    <div className="mz-route-scroll" data-testid="settings-route">
      <SettingsView
        state={state}
        reload={reload}
        onDone={onDone}
        onAddProvider={onAddProvider}
        onEditProvider={onEditProvider}
        onContinueSession={onContinueSession}
      />
    </div>
  )
}
