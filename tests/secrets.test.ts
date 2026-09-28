// ① 密钥文件冒号 bug 回归：SafeStorage mock + 真实临时目录，覆盖 FS 层（内存 FakeSecrets 掩盖的问题）。

import { describe, expect, it, beforeEach, vi } from 'vitest'
import { mkdtempSync, readdirSync, existsSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// 假 safeStorage：可逆"加密"（前缀标记），校验读写一致性
vi.mock('electron', () => ({
  safeStorage: {
    isEncryptionAvailable: () => true,
    encryptString: (s: string) => Buffer.from(`MZENC:${s}`, 'utf8'),
    decryptString: (b: Buffer) => {
      const s = b.toString('utf8')
      if (!s.startsWith('MZENC:')) throw new Error('not encrypted')
      return s.slice(6)
    },
  },
}))

import { SecretsStore, sanitizeSecretName, migrateLegacyProviderKey } from '../src/main/secrets/store'

let dir: string
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'mz-secrets-'))
})

describe('① SecretsStore 文件名清洗（冒号 = Windows ADS）', () => {
  it('含冒号名：set 后磁盘上是清洗名文件（非 ADS），get/has 走同一清洗', () => {
    const s = new SecretsStore(dir)
    s.set('provider-key:custom-1', 'secret-值')
    // 冒号被清洗为下划线：真实文件名 provider-key_custom-1
    expect(existsSync(join(dir, 'provider-key_custom-1'))).toBe(true)
    // 不产生 ADS（目录里只有这一个文件，且基名不含裸冒号文件）
    const files = readdirSync(dir)
    expect(files).toEqual(['provider-key_custom-1'])
    // 读回一致
    expect(s.get('provider-key:custom-1')).toBe('secret-值')
    expect(s.has('provider-key:custom-1')).toBe(true)
  })

  it('sanitizeSecretName：Windows 全部禁字符清洗；普通名原样', () => {
    expect(sanitizeSecretName('provider-key:custom-1')).toBe('provider-key_custom-1')
    expect(sanitizeSecretName('a<b>c:"d"/e\\|f?g*h')).toBe('a_b_c__d__e__f_g_h')
    expect(sanitizeSecretName('db.key')).toBe('db.key') // 点合法，保持不变
  })

  it('delete 走清洗：删的是清洗名文件；names 列真实文件', () => {
    const s = new SecretsStore(dir)
    s.set('provider-key:abc', 'v1')
    s.set('db.key', 'dek')
    expect(s.names().sort()).toEqual(['db.key', 'provider-key_abc'])
    s.delete('provider-key:abc')
    expect(existsSync(join(dir, 'provider-key_abc'))).toBe(false)
    expect(s.has('provider-key:abc')).toBe(false)
    expect(s.get('db.key')).toBe('dek') // 其他密钥不受影响
  })

  it('换机密文：读不出 → 返回 null（走重填流程）', () => {
    const s = new SecretsStore(dir)
    writeFileSync(join(dir, 'db.key'), Buffer.from('raw garbage not encrypted'))
    expect(s.get('db.key')).toBeNull()
  })
})

describe('① 旧单槽迁移（安全序：set → 读回校验 → 才删旧；失败保旧）', () => {
  it('正常路径：迁移成功 + 旧名删除', () => {
    const s = new SecretsStore(dir)
    s.set('provider-key', 'old-key-值')
    const r = migrateLegacyProviderKey(s, 'custom-1')
    expect(r).toBe('migrated')
    expect(s.get('provider-key:custom-1')).toBe('old-key-值')
    expect(s.has('provider-key')).toBe(false) // 旧名已清（清洗后不再有 ADS 风险）
  })

  it('目标已存在 → already（不覆盖不删除）', () => {
    const s = new SecretsStore(dir)
    s.set('provider-key', 'old')
    s.set('provider-key:x', 'existing-new')
    expect(migrateLegacyProviderKey(s, 'x')).toBe('already')
    expect(s.get('provider-key:x')).toBe('existing-new')
    expect(s.has('provider-key')).toBe(true) // 旧名保留
  })

  it('旧名读不出（ADS 残留/换机）→ failed，保旧不删，走缺密钥重填', () => {
    const s = new SecretsStore(dir)
    writeFileSync(join(dir, 'provider-key'), Buffer.from('unreadable-cipher'))
    expect(s.get('provider-key')).toBeNull()
    const r = migrateLegacyProviderKey(s, 'x')
    expect(r).toBe('failed')
    expect(existsSync(join(dir, 'provider-key'))).toBe(true) // 保旧
    expect(s.has('provider-key:x')).toBe(false)
  })

  it('set 失败 → failed 且旧文件原样（任一步失败保旧不删）', () => {
    const s = new SecretsStore(dir)
    s.set('provider-key', 'precious')
    const failing = {
      has: (n: string) => s.has(n),
      get: (n: string) => s.get(n),
      set: (n: string, v: string) => {
        throw new Error('disk full')
      },
      delete: (n: string) => s.delete(n),
    }
    expect(migrateLegacyProviderKey(failing, 'x')).toBe('failed')
    expect(s.get('provider-key')).toBe('precious') // 旧密钥无损
    expect(s.has('provider-key:x')).toBe(false)
  })

  it('无 activeProviderId → absent；无旧名 → absent', () => {
    const s = new SecretsStore(dir)
    expect(migrateLegacyProviderKey(s, null)).toBe('absent')
    expect(migrateLegacyProviderKey(s, 'x')).toBe('absent')
  })
})

describe('① 端到端复盘（用户中招路径）：ADS 写入 + 基名删除曾导致丢钥', () => {
  it('修复后：含冒号名写入真实独立文件，迁移删除旧名不再连带丢钥', () => {
    const s = new SecretsStore(dir)
    // 老版本行为复现：直接写含冒号名（ADS）→ 基名文件含主流数据
    const adsPath = join(dir, 'provider-key')
    writeFileSync(adsPath + ':custom', 'via-ads') // 在真实 Windows 上这是 ADS；Git Bash/临时目录行为可能不同，仅作对照
    // 修复后行为：清洗名独立文件
    s.set('provider-key:custom', 'safe-key')
    expect(existsSync(join(dir, 'provider-key_custom'))).toBe(true)
    // 基名删除不再影响新密钥（修复前：ADS 依附基名，基名删除 = 新钥丢失）
    s.delete('provider-key')
    expect(s.get('provider-key:custom')).toBe('safe-key')
    void adsPath
  })
})
