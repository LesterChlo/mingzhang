// 数据目录解析（决定记录 §1）：便携标记优先，否则 %APPDATA%\mingzhang。
// 优先级：MZ_DATA_DIR 环境变量（开发/测试）> 程序目录旁可写 data/ > %APPDATA%\mingzhang。
// 注意：开发模式下 exe 在 node_modules 里，跳过便携探测，避免污染仓库外目录。

import { existsSync, mkdirSync, writeFileSync, unlinkSync } from 'node:fs'
import { join } from 'node:path'
import { app } from 'electron'

export interface ResolvedPaths {
  dataDir: string
  dbFile: string
  sessionsDir: string
  attachmentsDir: string
  secretsDir: string
  piDir: string
  backupsDir: string
  configFile: string
  portable: boolean
}

function isWritable(dir: string): boolean {
  const probe = join(dir, '.mz-write-probe')
  try {
    writeFileSync(probe, 'x')
    unlinkSync(probe)
    return true
  } catch {
    return false
  }
}

export function resolvePaths(): ResolvedPaths {
  let dataDir: string | undefined
  let portable = false

  if (process.env.MZ_DATA_DIR) {
    dataDir = process.env.MZ_DATA_DIR
  } else if (app.isPackaged) {
    const exeDir = join(app.getPath('exe'), '..')
    const candidate = join(exeDir, 'data')
    if (existsSync(candidate) && isWritable(candidate)) {
      dataDir = candidate
      portable = true
    }
  }

  if (!dataDir) {
    dataDir = join(app.getPath('appData'), 'mingzhang')
  }
  mkdirSync(dataDir, { recursive: true })

  const sessionsDir = join(dataDir, 'sessions')
  const attachmentsDir = join(dataDir, 'attachments')
  const secretsDir = join(dataDir, 'secrets')
  const piDir = join(dataDir, 'pi')
  const backupsDir = join(dataDir, 'backups')
  for (const d of [sessionsDir, attachmentsDir, secretsDir, piDir, backupsDir]) {
    mkdirSync(d, { recursive: true })
  }

  return {
    dataDir,
    dbFile: join(dataDir, 'mingzhang.db'),
    sessionsDir,
    attachmentsDir,
    secretsDir,
    piDir,
    backupsDir,
    configFile: join(dataDir, 'config.json'),
    portable,
  }
}
