// 启动失败的安全人工出口。无脚本、无任意文件能力；仅打开已解析的数据目录或退出。
import { app, BrowserWindow, nativeTheme, shell } from 'electron'

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]!))
}

export function showStartupFailure(error: unknown, dataDir: string | null): BrowserWindow {
  const reason = error instanceof Error ? error.message : '启动过程中发生异常，请保留原数据后再检查。'
  const dark = nativeTheme.shouldUseDarkColors
  const colors = dark
    ? { bg: '#191c23', card: '#232832', text: '#e7ebf2', muted: '#b5becd', line: '#3c4657', action: '#a8b9db', actionText: '#202a3c' }
    : { bg: '#f3f4f7', card: '#ffffff', text: '#202a3c', muted: '#526075', line: '#d8dee8', action: '#506991', actionText: '#ffffff' }
  const failure = new BrowserWindow({
    width: 660, height: 480, minWidth: 560, minHeight: 420,
    title: '明账 · 启动未完成', autoHideMenuBar: true,
    backgroundColor: colors.bg,
    webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true },
  })
  const html = `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'"><title>明账 · 启动未完成</title><style>
*{box-sizing:border-box}body{margin:0;padding:32px;font:14px/1.65 system-ui,'Microsoft YaHei',sans-serif;background:${colors.bg};color:${colors.text}}main{padding:26px;border:1px solid ${colors.line};border-radius:16px;background:${colors.card}}.eyebrow{font-size:12px;color:${colors.muted};letter-spacing:.08em}h1{font-size:23px;font-weight:600;margin:6px 0 14px}p{margin:0 0 16px;color:${colors.muted}}.reason{max-height:126px;overflow:auto;padding:12px 14px;border-radius:9px;background:${colors.bg};color:${colors.text};overflow-wrap:anywhere;white-space:pre-wrap}nav{display:flex;gap:10px;margin-top:22px}a{display:inline-flex;align-items:center;justify-content:center;min-height:38px;padding:0 16px;border-radius:9px;text-decoration:none;font-weight:500;border:1px solid ${colors.line};color:${colors.text}}a.primary{background:${colors.action};color:${colors.actionText};border-color:${colors.action}}a:focus-visible{outline:2px solid ${colors.action};outline-offset:3px}.note{font-size:12px;margin:17px 0 0}</style></head><body><main data-testid="startup-failure"><div class="eyebrow">明账 · 数据保护</div><h1>暂时无法打开账本</h1><p>这次启动已停止。请保留现有账本、密钥与恢复文件，不要清空目录或重新建账。</p><div class="reason" data-testid="startup-failure-message">${escapeHtml(reason)}</div><nav>${dataDir ? '<a role="button" data-testid="startup-open-data" href="mz-startup:open-data">打开数据目录</a>' : ''}<a role="button" class="primary" data-testid="startup-close" href="mz-startup:close">关闭明账</a></nav><p class="note">这里不会自动重置账本。检查原密钥、备份或恢复状态后，再重新启动。</p></main></body></html>`
  failure.webContents.on('will-navigate', (event, url) => {
    event.preventDefault()
    if (url === 'mz-startup:close') { failure.close(); return }
    if (url === 'mz-startup:open-data' && dataDir) void shell.openPath(dataDir)
  })
  failure.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
  failure.on('closed', () => app.quit())
  void failure.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`)
  return failure
}
