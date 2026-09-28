import { useCallback, useEffect, useState } from 'react'
import type { ReactElement } from 'react'
import type { AppConfigDTO, ThemeName } from '../../../shared/types'
import type { LedgerFilterState } from '../lib/ledgerFilter'
import { SideNav } from './SideNav'
import { CaptureBar } from './CaptureBar'
import { InboxProvider, useInbox } from './inboxStore'
import { PanelProvider, usePanel } from './panelStore'
import { AccountsView } from '../views/AccountsView'
import { AssistantPanel } from '../views/AssistantPanel'
import { InboxView } from '../views/InboxView'
import { LedgerView } from '../views/LedgerView'
import { ReportView } from '../views/ReportView'
import { SettingsRoute } from '../views/SettingsRoute'

/** §1.1 导航树的五个落点。收件箱是唯一默认屏。 */
export type AppShellView = 'inbox' | 'ledger' | 'report' | 'accounts' | 'settings'

/** 真实应用的主题由 <html data-theme> 驱动；与配置枚举同口径（dark / light），不再做映射。 */
export type ShellTheme = ThemeName

/** 锁标第二行的快照时间（§2.3）：取自 inboxStore 的快照列表，回落设置信息里的 lastSnapshot。 */
function useLastSnapshotMtime(): number | null {
  const { snapshots, settings } = useInbox()
  return snapshots[0]?.mtime ?? settings?.lastSnapshot?.mtime ?? null
}

export interface AppShellProps {
  state: AppConfigDTO
  reload: () => Promise<void>
  /** 打开模型供应商向导·新增（T0928 §1 起与编辑分路：新增恒进 add 模式）。 */
  onAddProvider: () => void
  /** 打开模型供应商向导·编辑某个预设（按行传入该预设 id）。 */
  onEditProvider: (id: string) => void
  /** 会话续接成功后回到默认屏。 */
  onContinueSession: () => void
}

export function AppShell({ state, reload, onAddProvider, onEditProvider, onContinueSession }: AppShellProps): ReactElement {
  return (
    <InboxProvider>
      {/* ②B：面板状态必须在 CaptureBar（星标开关）之上，所以 Provider 排在 InboxProvider 里层 */}
      <PanelProvider>
        <ShellBody
          state={state}
          reload={reload}
          onAddProvider={onAddProvider}
          onEditProvider={onEditProvider}
          onContinueSession={onContinueSession}
        />
      </PanelProvider>
    </InboxProvider>
  )
}

function ShellBody({ state, reload, onAddProvider, onEditProvider, onContinueSession }: AppShellProps): ReactElement {
  const [view, setView] = useState<AppShellView>('inbox')
  const [theme, setTheme] = useState<ShellTheme>(() => state.theme)
  // 账本屏的初始筛选：结果条主按钮带 needs_review 跳过来时用它（走完即失效，见 onGoLedger）。
  // 只进一个筛选条件，账本屏自己的筛选条仍是唯一的筛选入口。
  const [ledgerInitialFilter, setLedgerInitialFilter] = useState<Partial<LedgerFilterState> | undefined>(
    undefined,
  )
  // 真实待决数（与收件箱卡片流同源：inboxStore 是唯一数据源）
  const { pendingCount, toast, dismissToast } = useInbox()
  // ②B：结果条主按钮的职责是「开面板 + 发指令」，由 panelStore 统一持有
  const { openPanel, send } = usePanel()
  const lastSnapshot = useLastSnapshotMtime()

  // 主题：以 getState() 的 theme 为准，挂到 <html data-theme>
  useEffect(() => {
    setTheme(state.theme)
  }, [state.theme])

  useEffect(() => {
    document.documentElement.dataset.theme = theme
  }, [theme])

  const toggleTheme = useCallback(() => {
    const next: ShellTheme = theme === 'dark' ? 'light' : 'dark'
    setTheme(next) // 立刻生效，不等 IPC
    // 写盘成功后刷新 App 级 state：读 state.theme 的地方（设置屏等）才跟得上左下角这个开关。
    // 以前这里不调 reload，App 的 state.theme 一直停在旧值——左右不同步的根因。
    void window.mz
      .setTheme(next)
      .then(() => reload())
      .catch(() => {
        // 写盘失败：本地主题回退到配置里的真值，不让界面停在一个没落盘的主题上
        setTheme(state.theme)
      })
  }, [theme, state.theme, reload])

  return (
    <div className="mz-shell" data-testid="app-shell">
      <SideNav
        active={view}
        pendingCount={pendingCount}
        theme={theme}
        dataDir={state.dataDir}
        lastSnapshotMtime={lastSnapshot}
        onSelect={setView}
        onToggleTheme={toggleTheme}
      />

      <main className="mz-main">
        {/* §2.1 速记行：五屏共享、钉在内容区顶部（数据接线单：可输入、可提交、可拖图） */}
        <CaptureBar />

        <div className="mz-view" key={view}>
          {view === 'inbox' && (
            <InboxView
              onGoReport={() => setView('report')}
              onGoLedger={() => {
                setLedgerInitialFilter({ state: 'needs_review' })
                setView('ledger')
              }}
              // ②B G-03：主按钮不再把人送去账本数数，而是开面板并直接下指令
              onGoHandle={() => {
                openPanel()
                void send('把待分类的账按建议归类')
              }}
            />
          )}
          {view === 'ledger' && <LedgerView initialFilter={ledgerInitialFilter} />}
          {view === 'report' && (
            <ReportView
              // 报告屏点分类条 → 账本，并带上「该月 + 该分类」两个条件（走 LedgerView 既有的 initialFilter，
              // 与结果条跳 needs_review 同一条路；账本屏自己的筛选条仍是唯一筛选入口）。
              onGoLedger={({ month, category }) => {
                setLedgerInitialFilter({ range: 'custom', customMonth: month, category })
                setView('ledger')
              }}
            />
          )}
          {view === 'accounts' && <AccountsView />}
          {view === 'settings' && (
            <SettingsRoute
              state={state}
              reload={reload}
              onDone={() => setView('inbox')}
              onAddProvider={onAddProvider}
              onEditProvider={onEditProvider}
              onContinueSession={onContinueSession}
            />
          )}
        </div>
      </main>

      {/* ②B：助手面板是**第三列**（推挤式，不是浮层）——问话时账本还得看得见。
          收起时组件不卸载（只 aria-hidden + 视觉隐藏），流与历史留着。 */}
      <AssistantPanel />

      {/* §2.5 Toast：底部居中，操作结果一句话 + 3s 自动收起 */}
      {toast && (
        <div
          className={`mz-toast mz-toast-${toast.tone}`}
          data-testid="toast"
          role="status"
          onMouseEnter={dismissToast}
        >
          {toast.text}
        </div>
      )}
    </div>
  )
}
