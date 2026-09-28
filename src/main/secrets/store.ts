// 密钥存储（决定记录 §4）：全部经 Electron safeStorage（Windows DPAPI）加密后落盘。
// 三条硬规矩的落点：不进日志（本模块绝不打印明文）、不进导出/备份（备份只针对 DB）、
// 不进 pi 全局配置（pi 侧用 InMemoryCredentialStore + setRuntimeApiKey 运行时注入）。
//
// 文件名安全（2026-09-19 修复）：Windows 文件名中的冒号是 ADS（备用数据流）分隔符——
// 'provider-key:<id>' 会把密钥写进 'provider-key' 的隐藏流，且随基名删除连带丢失。
// 因此密钥名一律经 sanitizeName 清洗（':' → '_'，并禁其余 Windows 非法字符）后才作为文件名。

import { readFileSync, writeFileSync, existsSync, readdirSync, unlinkSync } from 'node:fs'
import { join } from 'node:path'
import { safeStorage } from 'electron'

/** Windows 非法文件名字符清洗：':' → '_'，其余禁字符 → '_'。 */
export function sanitizeSecretName(name: string): string {
  return name.replace(/[<>:"/\\|?*]/g, '_')
}

export class SecretsStore {
  constructor(private readonly dir: string) {}

  private file(name: string): string {
    return join(this.dir, sanitizeSecretName(name))
  }

  isAvailable(): boolean {
    return safeStorage.isEncryptionAvailable()
  }

  /** safeStorage 不可用 = 拒绝启动，绝不降级明文（决定记录 §6 的口令无后门口径同理）。 */
  requireAvailable(): void {
    if (!this.isAvailable()) {
      throw new Error('系统安全存储（safeStorage/DPAPI）不可用，无法安全保存密钥，应用拒绝启动。')
    }
  }

  set(name: string, plaintext: string): void {
    this.requireAvailable()
    const encrypted = safeStorage.encryptString(plaintext)
    writeFileSync(this.file(name), encrypted)
  }

  get(name: string): string | null {
    const f = this.file(name)
    if (!existsSync(f)) return null
    try {
      return safeStorage.decryptString(readFileSync(f))
    } catch {
      // 解密失败（换机/换账户拷贝过来的密文）按不存在处理，上层走重新配置流程
      return null
    }
  }

  has(name: string): boolean {
    return existsSync(this.file(name))
  }

  delete(name: string): void {
    const f = this.file(name)
    if (existsSync(f)) unlinkSync(f)
  }

  /** 目录下全部密钥文件名（不含内容）——诊断用，绝不返回内容。 */
  names(): string[] {
    try {
      return readdirSync(this.dir)
    } catch {
      return []
    }
  }
}

/**
 * 旧单槽密钥迁移（安全序）：把 'provider-key' 迁到 'provider-key:<activeId>'。
 *   ① set 新名 ② 读回校验非空且一致 ③ 才 delete 旧名；任一步失败保旧不删。
 * 返回 'migrated' | 'absent' | 'already' | 'failed'（failed 时旧文件原样保留，上层按缺密钥引导重填）。
 */
export function migrateLegacyProviderKey(
  secrets: Pick<SecretsStore, 'has' | 'get' | 'set' | 'delete'>,
  activeProviderId: string | null,
): 'migrated' | 'absent' | 'already' | 'failed' {
  const legacyName = 'provider-key'
  if (activeProviderId == null) return 'absent'
  const newName = `provider-key:${activeProviderId}`
  if (secrets.has(newName)) return 'already'
  if (!secrets.has(legacyName)) return 'absent'
  const oldValue = secrets.get(legacyName)
  if (!oldValue) {
    // 基名存在但读不出（历史 ADS 残留读不出 / 换机密文）：保旧，走"缺密钥→提示重填"
    return 'failed'
  }
  try {
    secrets.set(newName, oldValue)
  } catch {
    return 'failed' // 旧文件未动
  }
  const readback = secrets.get(newName)
  if (readback !== oldValue) return 'failed' // 读回校验失败：保旧不删
  try {
    secrets.delete(legacyName)
  } catch {
    // 删除失败无害：新名已就绪，旧名下次启动再清
  }
  return 'migrated'
}
