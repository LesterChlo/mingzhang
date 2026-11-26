// Ollama 本地模型服务的进程管理：无窗口 detached 启动、存活检测、重启。
// 设计目标（第二阶段）：
//   - 主程序与 Ollama 进程解耦：spawn(detached, windowsHide, stdio:ignore) + unref()
//     → Ollama 成为独立进程，主程序退出不杀它；关闭主程序不影响已运行的 Ollama。
//   - 启动前检测 /api/version，已在运行则跳过，避免重复启动多个实例。
//   - Ollama 不可用时记账功能（表单录入）仍可用，仅 AI 对话不可用。
//   - 不再用 一键启动.bat / cmd /c 包裹，彻底消除黑窗口。

import { spawn, exec } from 'node:child_process'
import { existsSync } from 'node:fs'
import { dirname } from 'node:path'

// 部署位置（与 D:\Ollama 便携版一致）。可被环境变量覆盖以便迁移。
const OLLAMA_EXE = process.env.MZ_OLLAMA_EXE ?? 'D:\\Ollama\\ollama.exe'
const OLLAMA_DIR = dirname(OLLAMA_EXE)
const OLLAMA_HOST = process.env.MZ_OLLAMA_HOST ?? '127.0.0.1:11434'
const VERSION_URL = `http://${OLLAMA_HOST}/api/version`

// 与 D:\Ollama\start.bat 保持一致的环境变量（模型目录 + 大上下文）
const OLLAMA_ENV = {
  ...process.env,
  OLLAMA_MODELS: process.env.MZ_OLLAMA_MODELS ?? 'D:\\Ollama\\models',
  OLLAMA_HOST,
  OLLAMA_CONTEXT_LENGTH: process.env.MZ_OLLAMA_CTX ?? '32768',
}

export interface OllamaStatus {
  running: boolean
  version?: string
  pid?: number | null
  managed: boolean // 是否由本进程启动
}

let managedPid: number | null = null

/** 检测 Ollama 是否在运行（GET /api/version，2s 超时） */
export async function isOllamaRunning(): Promise<OllamaStatus> {
  try {
    const res = await fetch(VERSION_URL, { signal: AbortSignal.timeout(2000) })
    if (res.ok) {
      const j = (await res.json()) as { version?: string }
      return { running: true, version: j.version, pid: managedPid, managed: managedPid !== null }
    }
  } catch {
    /* not running / unreachable */
  }
  return { running: false, pid: managedPid, managed: managedPid !== null }
}

/** 无窗口启动 Ollama（detached，主程序退出不影响它）。返回是否最终就绪。 */
export async function startOllamaDetached(): Promise<boolean> {
  const st = await isOllamaRunning()
  if (st.running) return true // 已在运行，不重复启动

  if (!existsSync(OLLAMA_EXE)) {
    console.warn(`[ollama] 可执行文件不存在：${OLLAMA_EXE}，跳过启动（记账功能仍可用）`)
    return false
  }

  try {
    const child = spawn(OLLAMA_EXE, ['serve'], {
      cwd: OLLAMA_DIR,
      env: OLLAMA_ENV,
      detached: true, // 独立进程组，父退出不杀子
      stdio: 'ignore', // 不继承 stdio，无窗口
      windowsHide: true, // Windows 下隐藏控制台窗口
    })
    child.unref() // 放开父对子的引用，允许父独立退出
    managedPid = child.pid ?? null
  } catch (err) {
    console.warn('[ollama] 启动失败：', (err as Error).message)
    return false
  }

  // 轮询等待就绪（最多 30s，每 2s 探一次）
  for (let i = 0; i < 15; i++) {
    await new Promise((r) => setTimeout(r, 2000))
    const s = await isOllamaRunning()
    if (s.running) return true
  }
  return false
}

/** 确保启动（按 autoStart 开关）。返回最终状态。 */
export async function ensureOllama(autoStart: boolean): Promise<OllamaStatus> {
  const st = await isOllamaRunning()
  if (st.running) return st
  if (!autoStart) return { running: false, managed: false }
  await startOllamaDetached()
  return isOllamaRunning()
}

/** 重启（托盘菜单用）。先 taskkill 旧实例（含非本进程启动的），再 detached 启新。 */
export async function restartOllama(): Promise<boolean> {
  await new Promise<void>((resolve) => {
    exec('taskkill /F /IM ollama.exe', () => resolve())
  })
  managedPid = null
  await new Promise((r) => setTimeout(r, 1500))
  return startOllamaDetached()
}

export function getManagedPid(): number | null {
  return managedPid
}
