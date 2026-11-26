// 系统托盘（第二阶段）：右键菜单 = 打开 / 重启 Ollama / 查看状态 / 完全退出。
// 关闭主窗口时按设置最小化到托盘（不再直接退出），主程序与 Ollama 进程解耦。

import { Tray, Menu, nativeImage, BrowserWindow, Notification } from 'electron'

let tray: Tray | null = null

export interface TrayOptions {
  iconPath: string
  getWindow: () => BrowserWindow | null
  onRestartOllama: () => Promise<void>
  onShowStatus: () => Promise<void>
  onQuit: () => void
}

export function createTray(opts: TrayOptions): Tray | null {
  // 测试环境 / electron mock 未提供 Tray 或 nativeImage 时优雅跳过，不阻断启动。
  if (typeof Tray === 'undefined' || typeof nativeImage === 'undefined') return null
  // 托盘图标用多尺寸 ico 的 16/32 尺寸；nativeImage 会自动选合适尺寸。
  const icon = nativeImage.createFromPath(opts.iconPath)
  tray = new Tray(icon.isEmpty() ? nativeImage.createEmpty() : icon)
  tray.setToolTip('记账中心')

  const buildMenu = (): void => {
    const menu = Menu.buildFromTemplate([
      {
        label: '打开记账中心',
        click: () => {
          const w = opts.getWindow()
          if (w) {
            if (w.isMinimized()) w.restore()
            if (!w.isVisible()) w.show()
            w.focus()
          }
        },
      },
      { type: 'separator' },
      {
        label: '重启 Ollama 模型服务',
        click: () => opts.onRestartOllama(),
      },
      {
        label: '查看模型服务状态',
        click: () => opts.onShowStatus(),
      },
      { type: 'separator' },
      {
        label: '完全退出',
        click: () => opts.onQuit(),
      },
    ])
    tray!.setContextMenu(menu)
  }
  buildMenu()

  // 单击托盘图标：显示/聚焦主窗口
  tray.on('click', () => {
    const w = opts.getWindow()
    if (w) {
      if (w.isMinimized()) w.restore()
      if (!w.isVisible()) w.show()
      w.focus()
    }
  })

  return tray
}

/** 弹一条系统通知（托盘状态提示用）。 */
export function notify(title: string, body: string): void {
  try {
    if (typeof Notification === 'undefined' || !Notification.isSupported?.()) return
    new Notification({ title, body }).show()
  } catch {
    /* 测试环境或不支持时忽略 */
  }
}

export function destroyTray(): void {
  tray?.destroy()
  tray = null
}

export function trayExists(): boolean {
  return tray !== null
}
