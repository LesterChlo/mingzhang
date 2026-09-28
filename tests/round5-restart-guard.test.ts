// T0924-1418 round5 RED: P0 —— 成功恢复之后应用永久拒启。
// 根因：openLedger 用 `${base}.restore-` 前缀扫描「恢复工件」并无条件拒启；而
// replaceWithRollback / rollbackRestore 成功后**按设计保留** `.restore-rollback`
// （回滚能力本身，isRestoreConverged 也认它是正常态），前缀正好命中
// → 每做完一次恢复（快照恢复 / 口令包导入 / 撤销恢复），下次启动永久被拒；
// 错误文案还让用户去跑 recoverInterruptedRestore，而该动作此时是 no-op，等于无出路。
// 本文件锁定要求的行为：
//   R1 成功替换（replaceWithRollback 生产路径）后，按生产启动序（recover→openLedger）必须成功；
//   R2 撤销恢复（rollbackRestore）成功后重启必须成功；
//   R3 only-rollback 槽（target 存在，目录只剩 ledger.db + .restore-rollback）必须直接放行；
//   R4 未收敛状态仍必须拒启：journal 存在且 recover 无法收敛 / candidate / forward 未收敛；
//   R5 残留清单（.restore-residues.json）存在不得阻断启动（它是记录，不是未完成工件）；
//   R6 target 缺失 + 任何工件存在 → 仍拒启（保守，保持现状）。
// 同时锁死既有行为不回归：sidecar 拒启、空文件/符号链接拒启、缺表拒启、纯首启建库。
// 全部只用 mkdtempSync 合成库，绝不指向 %APPDATA% 真实数据目录。
import { describe, expect, it, afterEach } from 'vitest'
import DatabaseCtor from 'better-sqlite3-multiple-ciphers'
import { mkdtempSync, writeFileSync, existsSync, readFileSync, rmSync, mkdirSync, readdirSync, renameSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import * as backup from '../src/main/domain/backup'
import { openLedger, initSchemaIfEmpty } from '../src/main/db/connection'
import { schemaSql } from './helpers'
import { runMigrations } from '../src/main/db/migrations'

const DEK = 'r5'.repeat(32)

afterEach(() => {
  backup.__resetRestoreFileOps()
})

/** 造一个符合生产 schema 的合成加密账本，并写入一个可读标记。 */
function makeLedger(file: string, dek: string, marker: string): void {
  const db = new DatabaseCtor(file)
  db.pragma(`key = "x'${dek}'"`)
  db.pragma("cipher='chacha20'")
  db.exec(schemaSql())
  runMigrations(db)
  db.exec('CREATE TABLE IF NOT EXISTS marker(value TEXT NOT NULL)')
  db.prepare('INSERT INTO marker VALUES (?)').run(marker)
  db.close()
}

function readMarker(file: string, dek: string): string {
  const db = new DatabaseCtor(file)
  db.pragma(`key = "x'${dek}'"`)
  db.pragma("cipher='chacha20'")
  const row = db.prepare('SELECT value FROM marker').get() as { value: string }
  db.close()
  return row.value
}

const fakeSecrets = (dek: string) => ({ get: () => dek, set: () => {} }) as never

/** 生产启动序（src/main/index.ts）：recoverInterruptedRestore → openLedger。 */
function productionStartup(target: string, dek: string): { ok: boolean; stage: string; msg: string } {
  let outcome: string
  try {
    outcome = backup.recoverInterruptedRestore(target, { dekHex: dek })
  } catch (err) {
    return { ok: false, stage: 'recover', msg: (err as Error).message }
  }
  let db: { close?: () => void } | null = null
  try {
    db = openLedger(target, fakeSecrets(dek)) as unknown as { close?: () => void }
    return { ok: true, stage: `open(${outcome})`, msg: '' }
  } catch (err) {
    return { ok: false, stage: 'openLedger', msg: (err as Error).message }
  } finally {
    if (db && typeof db.close === 'function') db.close()
  }
}

/** 造一份快照文件，返回快照名（走生产 snapshot()，保证 backups/ 命名与断言路径真实）。 */
function makeSnapshotOf(srcFile: string, dek: string, backupsDir: string): string {
  mkdirSync(backupsDir, { recursive: true })
  const db = new DatabaseCtor(srcFile)
  db.pragma(`key = "x'${dek}'"`)
  db.pragma("cipher='chacha20'")
  const snap = backup.snapshot(db, backupsDir)
  db.close()
  return snap.replaceAll('\\', '/').split('/').pop() as string
}

describe('R5-P0 · R1 成功替换（快照恢复 → replaceWithRollback）后重启必须成功', () => {
  it('生产 mz:restoreSnapshot 的 commit 步成功后，生产启动序必须能打开账本', () => {
    const dir = mkdtempSync(join(tmpdir(), 'mz-r5p0-r1-'))
    try {
      const target = join(dir, 'ledger.db')
      const backupsDir = join(dir, 'backups')
      makeLedger(target, DEK, 'CURRENT-OLD')
      const newSrc = join(dir, 'new.db')
      makeLedger(newSrc, DEK, 'SNAPSHOT-NEW')
      const name = makeSnapshotOf(newSrc, DEK, backupsDir)

      // 生产 commit 步
      backup.restoreSnapshot(backupsDir, name, target, DEK)
      expect(readMarker(target, DEK)).toBe('SNAPSHOT-NEW')
      // 按设计保留回滚副本（回滚能力本身）
      expect(existsSync(`${target}.restore-rollback`), '成功后应保留回滚副本').toBe(true)
      expect(existsSync(`${target}.restore-journal.json`)).toBe(false)

      const r = productionStartup(target, DEK)
      console.log('R1 目录:', readdirSync(dir), '=> 启动', r.ok ? 'OK' : `FAIL@${r.stage} :: ${r.msg}`)
      expect(r.ok, `快照恢复后应用必须能重新启动（${r.stage} :: ${r.msg}）`).toBe(true)
      // 启动成功之外，数据必须是恢复后的那份
      const db = openLedger(target, fakeSecrets(DEK))
      db.close()
      expect(readMarker(target, DEK)).toBe('SNAPSHOT-NEW')
    } finally {
      rmSync(dir, { recursive: true, force: true, maxRetries: 3 })
    }
  })

  it('生产口令包导入的 commit 步（reencryptPlainToEncrypted）成功后重启必须成功', () => {
    const dir = mkdtempSync(join(tmpdir(), 'mz-r5p0-r1b-'))
    try {
      const target = join(dir, 'ledger.db')
      makeLedger(target, DEK, 'CURRENT-OLD')
      const plain = join(dir, 'import.plain')
      const src = new DatabaseCtor(plain)
      src.exec(schemaSql())
      runMigrations(src)
      src.exec('CREATE TABLE IF NOT EXISTS marker(value TEXT NOT NULL)')
      src.prepare('INSERT INTO marker VALUES (?)').run('IMPORTED-NEW')
      src.close()

      backup.reencryptPlainToEncrypted(plain, target, DEK)
      expect(readMarker(target, DEK)).toBe('IMPORTED-NEW')
      expect(existsSync(`${target}.restore-rollback`)).toBe(true)

      const r = productionStartup(target, DEK)
      console.log('R1b 目录:', readdirSync(dir), '=> 启动', r.ok ? 'OK' : `FAIL@${r.stage} :: ${r.msg}`)
      expect(r.ok, `口令包导入后应用必须能重新启动（${r.stage} :: ${r.msg}）`).toBe(true)
    } finally {
      rmSync(dir, { recursive: true, force: true, maxRetries: 3 })
    }
  })
})

describe('R5-P0 · R2 撤销恢复（rollbackRestore）成功后重启必须成功', () => {
  it('mz:rollbackRestore 的 commit 步成功后，生产启动序必须能打开账本', () => {
    const dir = mkdtempSync(join(tmpdir(), 'mz-r5p0-r2-'))
    try {
      const target = join(dir, 'ledger.db')
      const backupsDir = join(dir, 'backups')
      makeLedger(target, DEK, 'OLD-DATA')
      const newSrc = join(dir, 'new.db')
      makeLedger(newSrc, DEK, 'NEW-DATA')
      const name = makeSnapshotOf(newSrc, DEK, backupsDir)
      backup.restoreSnapshot(backupsDir, name, target, DEK)
      expect(readMarker(target, DEK)).toBe('NEW-DATA')

      // 生产 commit 步：撤销恢复
      backup.rollbackRestore(target, DEK)
      expect(readMarker(target, DEK)).toBe('OLD-DATA')
      // 撤销恢复同样按设计保留回滚槽（此时装的是被换回的新库）
      expect(existsSync(`${target}.restore-rollback`)).toBe(true)
      expect(existsSync(`${target}.restore-forward`)).toBe(false)
      expect(existsSync(`${target}.restore-journal.json`)).toBe(false)

      const r = productionStartup(target, DEK)
      console.log('R2 目录:', readdirSync(dir), '=> 启动', r.ok ? 'OK' : `FAIL@${r.stage} :: ${r.msg}`)
      expect(r.ok, `撤销恢复后应用必须能重新启动（${r.stage} :: ${r.msg}）`).toBe(true)
    } finally {
      rmSync(dir, { recursive: true, force: true, maxRetries: 3 })
    }
  })
})

describe('R5-P0 · R3 only-rollback 槽必须直接放行', () => {
  it('target 存在且目录只剩 ledger.db + .restore-rollback：openLedger 直接放行', () => {
    const dir = mkdtempSync(join(tmpdir(), 'mz-r5p0-r3-'))
    try {
      const target = join(dir, 'ledger.db')
      makeLedger(target, DEK, 'KEEP')
      // 只放一个「正常态」的回滚副本（无 journal / candidate / forward）
      writeFileSync(`${target}.restore-rollback`, readFileSync(target))

      const names = readdirSync(dir)
      console.log('R3 目录:', names)
      expect(names.some((n) => n.startsWith('ledger.db.restore-'))).toBe(true)

      const db = openLedger(target, fakeSecrets(DEK))
      try {
        expect((db.prepare('SELECT count(*) AS n FROM sqlite_master').get() as { n: number }).n).toBeGreaterThan(0)
      } finally {
        db.close()
      }
      expect(readMarker(target, DEK)).toBe('KEEP')
    } finally {
      rmSync(dir, { recursive: true, force: true, maxRetries: 3 })
    }
  })

  it('回滚槽带 WAL sidecar 残留（正常态）也不得阻断启动', () => {
    const dir = mkdtempSync(join(tmpdir(), 'mz-r5p0-r3b-'))
    try {
      const target = join(dir, 'ledger.db')
      makeLedger(target, DEK, 'KEEP')
      const rollback = `${target}.restore-rollback`
      writeFileSync(rollback, readFileSync(target))
      writeFileSync(`${rollback}-wal`, Buffer.alloc(64, 1))
      writeFileSync(`${rollback}-shm`, Buffer.alloc(32, 2))
      const db = openLedger(target, fakeSecrets(DEK))
      db.close()
    } finally {
      rmSync(dir, { recursive: true, force: true, maxRetries: 3 })
    }
  })
})

describe('R5-P0 · R4 未收敛状态仍必须拒启', () => {
  it('R4a journal 存在（replacing）且 target 已存在：未先收敛就 openLedger 必须拒绝', () => {
    const dir = mkdtempSync(join(tmpdir(), 'mz-r5p0-r4a-'))
    try {
      const target = join(dir, 'ledger.db')
      makeLedger(target, DEK, 'DIRTY?')
      const candidate = join(dir, 'cand.db')
      makeLedger(candidate, DEK, 'CANDIDATE')
      const staging = join(dir, 'ledger.db.restore-candidate-test')
      renameSync(candidate, staging)
      const forward = `${target}.restore-forward`
      const rollback = `${target}.restore-rollback`
      writeFileSync(
        `${target}.restore-journal.json`,
        JSON.stringify({
          phase: 'replacing',
          candidate: staging,
          target,
          rollback,
          forward,
          createdAt: new Date().toISOString(),
          pid: 1,
        }),
      )
      let thrown: Error | null = null
      try {
        openLedger(target, fakeSecrets(DEK))
      } catch (err) {
        thrown = err as Error
      }
      console.log('R4a openLedger ->', thrown ? `REJECTED :: ${thrown.message}` : 'ACCEPTED（不应发生）')
      expect(thrown, 'journal 未收敛时 openLedger 必须拒绝').not.toBeNull()
      // 拒绝文案不得再把 no-op 的 recoverInterruptedRestore 当作出路
      expect(thrown!.message).not.toMatch(/recoverInterruptedRestore/)
      // 先收敛再启动则必须成功
      const st = backup.recoverInterruptedRestore(target, { dekHex: DEK })
      console.log('R4a recover ->', st)
      const db = openLedger(target, fakeSecrets(DEK))
      db.close()
    } finally {
      rmSync(dir, { recursive: true, force: true, maxRetries: 3 })
    }
  })

  it('R4b journal 存在（rolling-back）且无法收敛：必须拒启且不得新建空账本', () => {
    const dir = mkdtempSync(join(tmpdir(), 'mz-r5p0-r4b-'))
    try {
      const target = join(dir, 'ledger.db')
      makeLedger(target, DEK, 'TARGET')
      const forward = `${target}.restore-forward`
      const rollback = `${target}.restore-rollback`
      writeFileSync(
        `${target}.restore-journal.json`,
        JSON.stringify({
          phase: 'rolling-back',
          candidate: `${target}.restore-candidate-rollback`,
          target,
          rollback,
          forward,
          createdAt: new Date().toISOString(),
          pid: 1,
        }),
      )
      expect(() => backup.recoverInterruptedRestore(target, { dekHex: DEK })).toThrow(/回滚|收敛|恢复/)
      expect(existsSync(`${target}.restore-journal.json`), '未收敛时 journal 必须保留').toBe(true)
      expect(() => openLedger(target, fakeSecrets(DEK))).toThrow()
    } finally {
      rmSync(dir, { recursive: true, force: true, maxRetries: 3 })
    }
  })

  it('R4c target 已存在但 forward 槽未收敛：必须拒启', () => {
    const dir = mkdtempSync(join(tmpdir(), 'mz-r5p0-r4c-'))
    try {
      const target = join(dir, 'ledger.db')
      makeLedger(target, DEK, 'TARGET')
      // forward 残留且无 journal：无法判断归属，绝不能当正常态放行
      writeFileSync(`${target}.restore-forward`, Buffer.from('synthetic-forward-residue'))
      let thrown: Error | null = null
      try {
        openLedger(target, fakeSecrets(DEK))
      } catch (err) {
        thrown = err as Error
      }
      console.log('R4c openLedger ->', thrown ? `REJECTED :: ${thrown.message}` : 'ACCEPTED（不应发生）')
      expect(thrown, 'forward 未收敛时必须拒启').not.toBeNull()
      expect(existsSync(`${target}.restore-forward`)).toBe(true)
    } finally {
      rmSync(dir, { recursive: true, force: true, maxRetries: 3 })
    }
  })

  it('R4d target 已存在但 candidate 未收敛：必须拒启', () => {
    const dir = mkdtempSync(join(tmpdir(), 'mz-r5p0-r4d-'))
    try {
      const target = join(dir, 'ledger.db')
      makeLedger(target, DEK, 'TARGET')
      const staging = join(dir, 'ledger.db.restore-candidate-orphan')
      makeLedger(staging, DEK, 'ORPHAN')
      let thrown: Error | null = null
      try {
        openLedger(target, fakeSecrets(DEK))
      } catch (err) {
        thrown = err as Error
      }
      console.log('R4d openLedger ->', thrown ? `REJECTED :: ${thrown.message}` : 'ACCEPTED（不应发生）')
      expect(thrown, 'candidate 未收敛时必须拒启').not.toBeNull()
      expect(existsSync(staging)).toBe(true)
    } finally {
      rmSync(dir, { recursive: true, force: true, maxRetries: 3 })
    }
  })
})

describe('R5-P0 · R5 残留清单不得阻断启动', () => {
  it('.restore-residues.json 存在（记录，非未完成工件）时必须正常启动', () => {
    const dir = mkdtempSync(join(tmpdir(), 'mz-r5p0-r5-'))
    try {
      const target = join(dir, 'ledger.db')
      makeLedger(target, DEK, 'KEEP')
      writeFileSync(`${target}.restore-rollback`, readFileSync(target))
      writeFileSync(
        `${target}.restore-residues.json`,
        JSON.stringify([{ path: join(dir, 'leftover.plain'), reason: 'EBUSY', at: new Date().toISOString() }], null, 2),
      )
      const names = readdirSync(dir)
      console.log('R5 目录:', names)
      expect(names).toContain('ledger.db.restore-residues.json')
      const db = openLedger(target, fakeSecrets(DEK))
      db.close()
    } finally {
      rmSync(dir, { recursive: true, force: true, maxRetries: 3 })
    }
  })
})

describe('R5-P0 · R6 target 缺失 + 任何工件仍拒启（保守，保持现状）', () => {
  it.each([
    ['rollback', (t: string) => `${t}.restore-rollback`],
    ['forward', (t: string) => `${t}.restore-forward`],
    ['candidate', (t: string) => `${t}.restore-candidate-x`],
    ['journal', (t: string) => `${t}.restore-journal.json`],
    ['journal-tmp', (t: string) => `${t}.restore-journal.json.tmp-1`],
    ['residues', (t: string) => `${t}.restore-residues.json`],
  ])('target 缺失 + %s 工件：必须拒启且不创建账本文件', (_name, pathOf) => {
    const dir = mkdtempSync(join(tmpdir(), 'mz-r5p0-r6-'))
    try {
      const target = join(dir, 'ledger.db')
      writeFileSync(pathOf(target), 'synthetic-residue')
      const calls: string[] = []
      const throwingSecrets = {
        get: () => {
          calls.push('get')
          throw new Error('SECRETS_TOUCHED')
        },
        set: () => {
          calls.push('set')
          throw new Error('SECRETS_TOUCHED')
        },
      }
      let thrown: Error | null = null
      try {
        openLedger(target, throwingSecrets as never)
      } catch (err) {
        thrown = err as Error
      }
      expect(thrown, 'target 缺失 + 工件存在时必须拒绝启动').not.toBeNull()
      expect(calls, '拒绝判定不得触碰 SecretsStore').toEqual([])
      expect(existsSync(target), '拒绝时不得创建账本文件').toBe(false)
    } finally {
      rmSync(dir, { recursive: true, force: true, maxRetries: 3 })
    }
  })
})

describe('R5-P0 · 既有守门行为不得回归', () => {
  it('B1 缺主库 + 残留 sidecar：仍在触碰 SecretsStore 之前拒启', () => {
    const dir = mkdtempSync(join(tmpdir(), 'mz-r5p0-keep-b1-'))
    try {
      const target = join(dir, 'ledger.db')
      writeFileSync(`${target}-wal`, Buffer.alloc(64, 7))
      const calls: string[] = []
      const secrets = {
        get: () => {
          calls.push('get')
          return DEK
        },
        set: () => {
          calls.push('set')
          throw new Error('SET-CALLED')
        },
      }
      expect(() => openLedger(target, secrets as never)).toThrow(/残留/)
      expect(calls).toEqual([])
      expect(existsSync(target)).toBe(false)
    } finally {
      rmSync(dir, { recursive: true, force: true, maxRetries: 3 })
    }
  })

  it('空文件 / 错 schema 仍必须拒绝（绝不补成新空账本）', () => {
    const dir = mkdtempSync(join(tmpdir(), 'mz-r5p0-keep-empty-'))
    try {
      const empty = join(dir, 'empty.db')
      writeFileSync(empty, Buffer.alloc(0))
      expect(() => openLedger(empty, fakeSecrets(DEK))).toThrow()

      const junk = join(dir, 'junk.db')
      const db = new DatabaseCtor(junk)
      db.pragma(`key = "x'${DEK}"`)
      db.pragma("cipher='chacha20'")
      db.exec('CREATE TABLE junk(id INTEGER PRIMARY KEY)')
      db.close()
      expect(() => openLedger(junk, fakeSecrets(DEK))).toThrow(/schema|结构|账务|损坏|解密/)
    } finally {
      rmSync(dir, { recursive: true, force: true, maxRetries: 3 })
    }
  })

  it('纯首启（无任何工件）仍可建库，二次打开不得重置', () => {
    const dir = mkdtempSync(join(tmpdir(), 'mz-r5p0-keep-fresh-'))
    try {
      const target = join(dir, 'ledger.db')
      const db = openLedger(target, fakeSecrets(DEK))
      initSchemaIfEmpty(db)
      db.close()
      expect(existsSync(target)).toBe(true)
      const again = openLedger(target, fakeSecrets(DEK))
      initSchemaIfEmpty(again)
      again.close()
    } finally {
      rmSync(dir, { recursive: true, force: true, maxRetries: 3 })
    }
  })
})
