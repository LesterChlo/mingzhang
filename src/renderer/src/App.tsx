import { useCallback, useEffect, useRef, useState } from 'react'
import type { AppConfigDTO } from '../../shared/types'
import { AppShell } from './shell/AppShell'
import { Wizard } from './components/Wizard'

/**
 * UI 重做第 1 切片：外壳（token 层 + 左栏导航 + 五屏路由 + 深浅主题）。
 * 启动流程、错误态与模型向导入口保留；旧对话式组件（ChatApp / Cards / LedgerPanel /
 * PendingPanel / SettingsView）文件全部留着不删，本单只做并存——数据接线单再定去留。
 */
export function App() {
  const [state, setState] = useState<AppConfigDTO | null>(null)
  const [error, setError] = useState<string | null>(null)
  // T0928 §1：向导入口拆成两路——「＋ 新增预设」恒进 add，行内「编辑」进那一行的 edit
  // （此前两路汇成一个处理器，按 providers.length 判模式：已有预设时点"新增"会开成编辑当前预设）。
  const [wizard, setWizard] = useState<{ mode: 'add' | 'edit'; providerId: string | null } | null>(null)
  // 打开向导前记下焦点（「＋ 新增预设」或某行的「编辑」），关闭后归还——可退出性的一部分。
  const wizardTriggerRef = useRef<Element | null>(null)

  const reload = useCallback(
    () =>
      window.mz
        .getState()
        .then(setState)
        .catch((e) => setError(String(e))),
    [],
  )

  useEffect(() => {
    void reload()
  }, [reload])

  const openWizard = useCallback((mode: 'add' | 'edit', providerId: string | null) => {
    wizardTriggerRef.current = document.activeElement
    setWizard({ mode, providerId })
  }, [])
  const closeWizard = useCallback(() => {
    setWizard(null)
    // 等卸载完再还焦点，免得焦点落在已消失的元素上
    requestAnimationFrame(() => {
      ;(wizardTriggerRef.current as HTMLElement | null)?.focus?.()
      wizardTriggerRef.current = null
    })
  }, [])

  if (error) {
    return (
      <div className="fatal">
        <h2>启动失败</h2>
        <p>{error}</p>
      </div>
    )
  }
  if (!state) return <div className="fatal">正在加载…</div>

  return (
    <>
      <AppShell
        state={state}
        reload={reload}
        onAddProvider={() => openWizard('add', null)}
        onEditProvider={(id) => openWizard('edit', id)}
        onContinueSession={reload}
      />
      {wizard && (
        <Wizard
          mode={wizard.mode}
          initial={
            wizard.mode === 'edit' ? (state.providers.find((p) => p.id === wizard.providerId) ?? null) : null
          }
          onDone={() => {
            closeWizard()
            void reload()
          }}
          onCancel={closeWizard}
        />
      )}
    </>
  )
}
