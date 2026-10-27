import { describe, it, expect, vi } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { openSchemaDb } from './helpers'

vi.mock('electron', () => ({ safeStorage: {
  isEncryptionAvailable: () => true,
  encryptString: (s: string) => Buffer.from(`MZ-TEST:${s}`),
  decryptString: (b: Buffer) => {
    const s = b.toString()
    if (!s.startsWith('MZ-TEST:')) throw new Error('synthetic unreadable ciphertext')
    return s.slice(8)
  },
} }))
import { SecretsStore } from '../src/main/secrets/store'
import { loadOrCreateDek, openLedger, initSchemaIfEmpty } from '../src/main/db/connection'

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'mz-dek-preserve-'))
  const keyDir = join(dir, 'secrets')
  mkdirSync(keyDir)
  return { dir, keyDir, secrets: new SecretsStore(keyDir), file: join(dir, 'ledger.db'), key: join(keyDir, 'db.key') }
}

describe('账本密钥保全（仅合成临时目录）', () => {
  it('存在但不可解密的密文拒绝重新生成，字节原样保留', () => {
    const f = fixture()
    const original = Buffer.from('SYNTHETIC-UNREADABLE-DEK')
    writeFileSync(f.key, original)
    expect(() => loadOrCreateDek(f.secrets)).toThrow(/密钥|安全/)
    expect(readFileSync(f.key)).toEqual(original)
  })

  it('已有账本缺少密钥时不写新密钥、不动原库', () => {
    const f = fixture()
    const db = openSchemaDb(f.file)
    db.close()
    const original = readFileSync(f.file)
    expect(() => openLedger(f.file, f.secrets)).toThrow(/密钥/)
    expect(existsSync(f.key)).toBe(false)
    expect(readFileSync(f.file)).toEqual(original)
  })

  it('已有库且密文不可解密，拒绝打开并保留两份原字节', () => {
    const f = fixture()
    const db = openSchemaDb(f.file)
    db.close()
    const before = readFileSync(f.file)
    const cipher = Buffer.from('SYNTHETIC-KEY-WRONG-PROFILE')
    writeFileSync(f.key, cipher)
    expect(() => openLedger(f.file, f.secrets)).toThrow(/密钥|解密/)
    expect(readFileSync(f.key)).toEqual(cipher)
    expect(readFileSync(f.file)).toEqual(before)
  })

  it('新目录无库无钥仍可创建，初始化后用同一密钥重开', () => {
    const f = fixture()
    const db = openLedger(f.file, f.secrets)
    initSchemaIfEmpty(db)
    db.close()
    expect(existsSync(f.key)).toBe(true)
    const original = readFileSync(f.key)
    const reopened = openLedger(f.file, f.secrets)
    reopened.close()
    expect(readFileSync(f.key)).toEqual(original)
  })

  it('已有可读密钥被复用，不发生覆盖', () => {
    const f = fixture()
    const key = 'ab'.repeat(32)
    f.secrets.set('db.key', key)
    const cipher = readFileSync(f.key)
    expect(loadOrCreateDek(f.secrets)).toBe(key)
    expect(readFileSync(f.key)).toEqual(cipher)
  })

  it('主库缺失但 sidecar 残留时仍在任何密钥操作前拒绝', () => {
    const f = fixture()
    writeFileSync(f.file + '-wal', Buffer.from('SYNTHETIC-SIDECAR'))
    expect(() => openLedger(f.file, f.secrets)).toThrow(/附属|残留/)
    expect(existsSync(f.key)).toBe(false)
    expect(existsSync(f.file)).toBe(false)
  })
})
