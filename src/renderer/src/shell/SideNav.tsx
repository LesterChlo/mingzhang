import type { ReactElement } from 'react'
import type { AppShellView } from './AppShell'
import { snapshotFreshness } from '../lib/shellFormat'

/** 导航项：§1.1 导航树五项（设置下挂的分节在设置屏内部，不占导航位）。 */
interface NavEntry {
  id: AppShellView
  label: string
  icon: ReactElement
}

const icon = (path: ReactElement): ReactElement => (
  <svg
    width="18"
    height="18"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="1.5"
    strokeLinecap="round"
    strokeLinejoin="round"
    aria-hidden="true"
  >
    {path}
  </svg>
)

// 图标：手写 24×24 SVG，逐个对应导航项
const NAV: NavEntry[] = [
  {
    id: 'inbox',
    label: '收件箱',
    icon: icon(
      <>
        <path d="M22 12h-6l-2 3h-4l-2-3H2" />
        <path d="M5.45 5.11 2 12v6a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-6l-3.45-6.89A2 2 0 0 0 16.76 4H7.24a2 2 0 0 0-1.79 1.11z" />
      </>,
    ),
  },
  {
    id: 'ledger',
    label: '账本',
    icon: icon(
      <>
        <path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20" />
        <path d="M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2z" />
      </>,
    ),
  },
  {
    id: 'report',
    label: '报告',
    icon: icon(
      <>
        <path d="M3 3v18h18" />
        <path d="M18 17V9" />
        <path d="M13 17V5" />
        <path d="M8 17v-3" />
      </>,
    ),
  },
  {
    id: 'accounts',
    label: '账户',
    icon: icon(
      <>
        <path d="M21 12V7H5a2 2 0 0 1 0-4h14v4" />
        <path d="M3 5v14a2 2 0 0 0 2 2h16v-5" />
        <path d="M18 12a2 2 0 0 0 0 4h4v-4Z" />
      </>,
    ),
  },
  {
    id: 'settings',
    label: '设置',
    icon: icon(
      <>
        <circle cx="12" cy="12" r="3" />
        <path d="M12 1v4m0 14v4M4.22 4.22l2.83 2.83m9.9 9.9 2.83 2.83M1 12h4m14 0h4M4.22 19.78l2.83-2.83m9.9-9.9 2.83-2.83" />
      </>,
    ),
  },
]

const MOON_ICON = (
  <svg
    width="14"
    height="14"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="1.5"
    strokeLinecap="round"
    aria-hidden="true"
  >
    <path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z" />
  </svg>
)

const LOCK_ICON = (
  <svg
    width="14"
    height="14"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="1.5"
    strokeLinecap="round"
    strokeLinejoin="round"
    aria-hidden="true"
  >
    <rect x="3" y="11" width="18" height="11" rx="2" />
    <path d="M7 11V7a5 5 0 0 1 10 0v4" />
  </svg>
)

export interface SideNavProps {
  active: AppShellView
  /** 收件箱待决角标（真实值，与收件箱卡片流同源）。 */
  pendingCount: number
  theme: 'dark' | 'light'
  dataDir: string
  /** 最近一次快照的 mtime（§2.3 锁标第二行）；null = 还没快照过。 */
  lastSnapshotMtime: number | null
  onSelect: (view: AppShellView) => void
  onToggleTheme: () => void
}

export function SideNav({
  active,
  pendingCount,
  theme,
  dataDir,
  lastSnapshotMtime,
  onSelect,
  onToggleTheme,
}: SideNavProps): ReactElement {
  // §2.3 原文口径：第二行是快照时间；数据目录挪到 title/悬浮。超过 7 天转黄。
  const snap = snapshotFreshness(lastSnapshotMtime)
  return (
    <nav className="mz-nav" aria-label="主导航">
      <div className="mz-brand">
        <div className="mz-brand-name">明账</div>
        <div className="mz-brand-sub">本地记账 · 不上云</div>
      </div>

      {NAV.map((item) => {
        const isActive = item.id === active
        return (
          <button
            key={item.id}
            type="button"
            className={`mz-nav-item${isActive ? ' is-active' : ''}`}
            aria-current={isActive ? 'page' : undefined}
            data-testid={`nav-${item.id}`}
            onClick={() => onSelect(item.id)}
          >
            {item.icon}
            <span>{item.label}</span>
            {item.id === 'inbox' && pendingCount > 0 && (
              <span className="mz-nav-badge mz-num">{pendingCount}</span>
            )}
          </button>
        )
      })}

      <div className="mz-nav-spacer" />

      <button
        type="button"
        className="mz-theme-toggle"
        onClick={onToggleTheme}
        data-testid="theme-toggle"
        aria-label={theme === 'dark' ? '切换到浅色' : '切换到深色'}
      >
        {MOON_ICON}
        <span>{theme === 'dark' ? '切换到浅色' : '切换到深色'}</span>
      </button>

      {/* §2.3 本地数据锁标：常驻导航底部，hover 显示数据目录完整路径，点击直达「设置 → 数据与安全」 */}
      <button
        type="button"
        className="mz-lock"
        title={dataDir}
        data-testid="lock-badge"
        data-datadir={dataDir}
        onClick={() => onSelect('settings')}
      >
        <span className={`mz-lock-dot${snap.stale ? ' is-stale' : ''}`} />
        {LOCK_ICON}
        <span className="mz-lock-tx">
          本地加密 · 仅本机
          <small className="mz-lock-snap" data-testid="lock-snapshot">
            {snap.text}
          </small>
        </span>
      </button>
    </nav>
  )
}
