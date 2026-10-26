// DEK 保全补强：缺少存在性证明时不得生成；fakeSecrets 的可读路径仍兼容。
// 全部只使用 os.tmpdir() 下的合成账本，绝不读取真实 profile。
import { describe, expect, it, vi } from 'vitest'
import { existsSync, mkdtempSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import DatabaseCtor from 'better-sqlite3-multiple-ciphers'
import { openSchemaDb, schemaSql } from './helpers'
import { runMigrations } from '../src/main/db/migrations'
import { openLedger } from '../src/main/db/connection'

function ledgerFile(): string {
  return join(mkdtempSync(join(tmpdir(), 'mz-dek-guards-')), 'ledger.db')
}

describe('DEK 存在性守卫（仅合成临时目录）', () => {
  it('已有账本缺钥且 fakeSecrets 无 has：拒绝且不调用 set、不创建 sidecar', () => {
    const file = ledgerFile()
    const originalDb = openSchemaDb(file)
    originalDb.close()
    const original = readFileSync(file)
    const secrets = { get: vi.fn(() => null), set: vi.fn() }

    expect(() => openLedger(file, secrets as never)).toThrow(/密钥/)
    expect(secrets.set).not.toHaveBeenCalled()
    expect(readFileSync(file)).toEqual(original)
    expect(existsSync(`${file}-wal`)).toBe(false)
    expect(existsSync(`${file}-shm`)).toBe(false)
  })

  it('无库且 fakeSecrets 无 has：不能证明密钥不存在，拒绝 set 和建库', () => {
    const file = ledgerFile()
    const secrets = { get: vi.fn(() => null), set: vi.fn() }
    let opened: ReturnType<typeof openLedger> | null = null
    try {
      expect(() => { opened = openLedger(file, secrets as never) }).toThrow(/密钥/)
    } finally {
      opened?.close()
    }
    expect(secrets.set).not.toHaveBeenCalled()
    expect(existsSync(file)).toBe(false)
  })

  it('fakeSecrets 已有可读密钥：不调用 has 或 set，仍可打开生产形态的加密库', () => {
    const file = ledgerFile()
    const key = 'cd'.repeat(32)
    const originalDb = new DatabaseCtor(file)
    try {
      originalDb.pragma(`key = "x'${key}'"`)
      originalDb.pragma("cipher='chacha20'")
      originalDb.exec(schemaSql())
      runMigrations(originalDb)
    } finally {
      originalDb.close()
    }
    const secrets = {
      get: vi.fn(() => key),
      set: vi.fn(() => { throw new Error('unexpected set') }),
      has: vi.fn(() => { throw new Error('unexpected has') }),
    }
    const opened = openLedger(file, secrets as never)
    try {
      expect((opened.prepare('SELECT count(*) AS n FROM sqlite_master').get() as { n: number }).n).toBeGreaterThan(0)
    } finally {
      opened.close()
    }
    expect(secrets.get).toHaveBeenCalledTimes(1)
    expect(secrets.has).not.toHaveBeenCalled()
    expect(secrets.set).not.toHaveBeenCalled()
  })
})
