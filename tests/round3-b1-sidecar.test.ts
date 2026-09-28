// T0924-1418 第三轮独立复核 · 阻断①（B1）回归测试。
// 缺陷：openLedger 只扫描 `${base}.restore-` 前缀的恢复工件；当「正式主库文件不存在，
// 但残留 SQLite sidecar（-wal / -shm / -journal，Windows 崩溃/强杀残留）」时，
// 它被当成「首次启动」放行，SQLite 随即静默新建一个空账本 —— 旧库数据全部不可见。
// 要求：此情形必须拒绝启动，且检测必须早于 SecretsStore 触碰与任何库文件创建。
// 全部使用 mkdtemp 合成临时目录，绝不指向 %APPDATA% 真实数据目录。
import { describe, expect, it } from 'vitest'
import DatabaseCtor from 'better-sqlite3-multiple-ciphers'
import { mkdtempSync, writeFileSync, existsSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { schemaSql } from './helpers'
import { runMigrations } from '../src/main/db/migrations'
import { openLedger } from '../src/main/db/connection'

const DEK = 'b1'.repeat(32)

/** 造一个符合生产 schema 的合成账本（只为④ 验证 sidecar 存在时仍可正常打开）。 */
function makeLedger(file: string, dek: string) {
  const db = new DatabaseCtor(file)
  db.pragma(`key = "x'${dek}'"`)
  db.pragma("cipher='chacha20'")
  db.exec(schemaSql())
  runMigrations(db)
  db.close()
}

/** 统一清理：rm -rf 合成临时目录。 */
function cleanup(dir: string) {
  rmSync(dir, { recursive: true, force: true, maxRetries: 3 })
}

describe('R3-B1 缺主库 + 残留 sidecar：拒绝启动，绝不静默新建空账本', () => {
  it('① 缺主库 + 仅 -wal 残留：openLedger 拒绝启动，且在触碰 SecretsStore 之前就拒绝', () => {
    const dir = mkdtempSync(join(tmpdir(), 'mz-r3b1-wal-'))
    try {
      const target = join(dir, 'ledger.db')
      expect(existsSync(target)).toBe(false)
      writeFileSync(`${target}-wal`, Buffer.alloc(64, 7))

      const calls: string[] = []
      const throwingSecrets = {
        get: () => {
          calls.push('get')
          throw new Error('SECRETS_TOUCHED:get')
        },
        set: () => {
          calls.push('set')
          throw new Error('SECRETS_TOUCHED:set')
        },
      }

      let thrown: Error | null = null
      try {
        openLedger(target, throwingSecrets as never)
      } catch (err) {
        thrown = err as Error
      }

      expect(thrown, '主库缺失但有 -wal 残留时必须拒绝启动').not.toBeNull()
      expect(thrown!.message).toMatch(/残留/)
      expect(thrown!.message).toMatch(/拒绝.*空账本|空账本/)
      // 检测必须早于 SecretsStore：stub 一旦被调用就抛错，调用即测试失败。
      expect(calls, '拒绝判定不得触碰 SecretsStore').toEqual([])
      expect(existsSync(target), '拒绝时不得创建任何账本文件').toBe(false)
    } finally {
      cleanup(dir)
    }
  })

  it('② 缺主库 + 仅 -shm 残留：openLedger 拒绝启动，且在触碰 SecretsStore 之前就拒绝', () => {
    const dir = mkdtempSync(join(tmpdir(), 'mz-r3b1-shm-'))
    try {
      const target = join(dir, 'ledger.db')
      expect(existsSync(target)).toBe(false)
      writeFileSync(`${target}-shm`, Buffer.alloc(64, 3))

      const calls: string[] = []
      const throwingSecrets = {
        get: () => {
          calls.push('get')
          throw new Error('SECRETS_TOUCHED:get')
        },
        set: () => {
          calls.push('set')
          throw new Error('SECRETS_TOUCHED:set')
        },
      }

      let thrown: Error | null = null
      try {
        openLedger(target, throwingSecrets as never)
      } catch (err) {
        thrown = err as Error
      }

      expect(thrown, '主库缺失但有 -shm 残留时必须拒绝启动').not.toBeNull()
      expect(thrown!.message).toMatch(/残留/)
      expect(thrown!.message).toMatch(/拒绝.*空账本|空账本/)
      expect(calls, '拒绝判定不得触碰 SecretsStore').toEqual([])
      expect(existsSync(target), '拒绝时不得创建任何账本文件').toBe(false)
    } finally {
      cleanup(dir)
    }
  })

  it('③ 缺主库 + 仅 -journal 残留：openLedger 拒绝启动', () => {
    const dir = mkdtempSync(join(tmpdir(), 'mz-r3b1-jrn-'))
    try {
      const target = join(dir, 'ledger.db')
      writeFileSync(`${target}-journal`, Buffer.alloc(64, 5))

      const calls: string[] = []
      const throwingSecrets = {
        get: () => {
          calls.push('get')
          throw new Error('SECRETS_TOUCHED:get')
        },
        set: () => {
          calls.push('set')
          throw new Error('SECRETS_TOUCHED:set')
        },
      }

      let thrown: Error | null = null
      try {
        openLedger(target, throwingSecrets as never)
      } catch (err) {
        thrown = err as Error
      }

      expect(thrown, '主库缺失但有 -journal 残留时必须拒绝启动').not.toBeNull()
      expect(thrown!.message).toMatch(/残留/)
      expect(calls).toEqual([])
      expect(existsSync(target)).toBe(false)
    } finally {
      cleanup(dir)
    }
  })

  it('④ 主库存在 + sidecar（WAL 正常态）：不得误拒，仍能正常打开', () => {
    const dir = mkdtempSync(join(tmpdir(), 'mz-r3b1-ok-'))
    try {
      const target = join(dir, 'ledger.db')
      makeLedger(target, DEK)
      const secrets = { get: () => DEK, set: () => { throw new Error('SET-CALLED') } }

      const first = openLedger(target, secrets as never)
      // WAL 模式下真实 sidecar 已生成
      expect(existsSync(`${target}-wal`), 'WAL 模式应产生 -wal').toBe(true)
      expect(existsSync(`${target}-shm`), 'WAL 模式应产生 -shm').toBe(true)

      // 主库存在 + sidecar 存在是正常状态，绝不能被 B1 守卫误伤
      const second = openLedger(target, secrets as never)
      expect((second.prepare('SELECT count(*) AS n FROM sqlite_master').get() as { n: number }).n).toBeGreaterThan(0)
      second.close()
      first.close()
    } finally {
      cleanup(dir)
    }
  })

  it('⑤ 缺主库 + 仅 -wal 且 SecretsStore 可用：旧实现会静默建出空库并返回连接，守卫必须拦住', () => {
    const dir = mkdtempSync(join(tmpdir(), 'mz-r3b1-leak-'))
    try {
      const target = join(dir, 'ledger.db')
      writeFileSync(`${target}-wal`, Buffer.alloc(64, 9))
      // 这次 secrets 可用：若无守卫，openLedger 会真的建出空账本并返回 db（即数据丢失形态）
      const secrets = { get: () => DEK, set: () => { throw new Error('SET-CALLED') } }

      let db: { close?: () => void } | null = null
      let thrown: Error | null = null
      try {
        db = openLedger(target, secrets as never) as unknown as { close?: () => void }
      } catch (err) {
        thrown = err as Error
      }
      if (db && typeof db.close === 'function') db.close()

      expect(thrown, 'openLedger 不应静默新建空账本并返回连接').not.toBeNull()
      expect(thrown!.message).toMatch(/残留/)
      expect(existsSync(target), '拒绝时不得创建账本文件').toBe(false)
    } finally {
      cleanup(dir)
    }
  })
})
