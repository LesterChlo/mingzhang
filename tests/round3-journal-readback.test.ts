// T0924-1418 round3 RED: B3 恢复日志（journal）原子写必须读回确认。
// 旧实现：tmp→fsync→rename→dir-fsync 后无读回，损坏的 journal 会被继续提交，
// 并在「成功」后被清掉 —— 等于把一次不可收敛的多步替换伪装成成功。
// 本文件注入 writeFileSync 写坏 journal 内容，断言：必须抛错 + 目标库字节不变。
// 全部只用 mkdtempSync 合成库，不触真实账本 / %APPDATA%。
import { describe, expect, it, afterEach } from 'vitest'
import DatabaseCtor from 'better-sqlite3-multiple-ciphers'
import { mkdtempSync, readFileSync, existsSync, rmSync, renameSync, writeFileSync as fsWriteFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import * as backup from '../src/main/domain/backup'
import { schemaSql } from './helpers'
import { runMigrations } from '../src/main/db/migrations'

afterEach(() => {
  backup.__resetRestoreFileOps()
})

const DEK = 'r3'.repeat(32)

/** 与 tests/restore-safety.test.ts 的 makeLedger 同源：schema + 迁移 + 合成标记表。 */
function makeLedger(file: string, dek: string, marker: string): void {
  const db = new DatabaseCtor(file)
  db.pragma(`key = "x'${dek}'"`)
  db.pragma("cipher='chacha20'")
  db.exec(schemaSql())
  runMigrations(db)
  db.exec('CREATE TABLE IF NOT EXISTS t(a TEXT)')
  db.prepare('INSERT INTO t VALUES (?)').run(marker)
  db.close()
}

function readMarker(file: string, dek: string): string {
  const db = new DatabaseCtor(file)
  db.pragma(`key = "x'${dek}'"`)
  db.pragma("cipher='chacha20'")
  const row = db.prepare('SELECT a FROM t').get() as { a: string }
  db.close()
  return row.a
}

/** 注入：只污染 journal 的写入（tmp→rename 落盘），其余文件操作走真实 fs。 */
function corruptJournalWrites(mode: 'truncate' | 'garbage'): void {
  const realWrite = backup.restoreFileOps.writeFileSync
  backup.__setRestoreFileOps({
    writeFileSync: ((file: string, data: string | Buffer) => {
      if (String(file).includes('.restore-journal.json')) {
        const text = String(data)
        const broken = mode === 'truncate' ? text.slice(0, Math.max(1, Math.floor(text.length / 2))) : '\x00\x01\x02GARBAGE\not-json'
        return (realWrite as (f: string, d: string | Buffer) => void)(file, broken)
      }
      return (realWrite as (f: string, d: string | Buffer) => void)(file, data)
    }) as typeof backup.restoreFileOps.writeFileSync,
  })
}

describe('B3 RED：journal 写坏后必须抛错且目标库字节不变', () => {
  it('replaceWithRollback：journal 落盘内容被截断 → 必须抛错，目标库字节前后一致', () => {
    const dir = mkdtempSync(join(tmpdir(), 'mz-r3b3-trunc-'))
    const target = join(dir, 'ledger.db')
    makeLedger(target, DEK, 'ORIGINAL')
    const before = readFileSync(target)
    const staging = join(dir, 'ledger.db.restore-candidate-test')
    const src = join(dir, 'new.db')
    makeLedger(src, DEK, 'CANDIDATE')
    renameSync(src, staging)

    corruptJournalWrites('truncate')

    let threw: unknown = null
    try {
      backup.replaceWithRollback(staging, target)
    } catch (e) {
      threw = e
    }
    expect(threw).toBeTruthy()
    expect(String((threw as Error)?.message ?? threw)).toMatch(/journal|恢复日志|读回|回读/i)
    // 目标库字节前后一致：绝不因 journal 不可信就继续提交
    expect(readFileSync(target).equals(before)).toBe(true)
    expect(readMarker(target, DEK)).toBe('ORIGINAL')
    // journal 语义可解释：要么已安全清理（不存在），要么保留且状态不被伪装成成功
    const jf = `${target}.restore-journal.json`
    if (existsSync(jf)) {
      // 保留的 journal 必须仍是可解析的旧内容或明确残留，不得被静默当作成功清掉后继续
      expect(readMarker(target, DEK)).toBe('ORIGINAL')
    }
    rmSync(dir, { recursive: true, force: true })
  })

  it('replaceWithRollback：journal 落盘成不可解析乱码 → 必须抛错，目标库不动', () => {
    const dir = mkdtempSync(join(tmpdir(), 'mz-r3b3-garb-'))
    const target = join(dir, 'ledger.db')
    makeLedger(target, DEK, 'ORIGINAL')
    const before = readFileSync(target)
    const staging = join(dir, 'ledger.db.restore-candidate-test')
    const src = join(dir, 'new.db')
    makeLedger(src, DEK, 'CANDIDATE')
    renameSync(src, staging)

    corruptJournalWrites('garbage')

    expect(() => backup.replaceWithRollback(staging, target)).toThrow(/journal|恢复日志|读回|回读/i)
    expect(readFileSync(target).equals(before)).toBe(true)
    expect(readMarker(target, DEK)).toBe('ORIGINAL')
    rmSync(dir, { recursive: true, force: true })
  })

  it('rollbackRestore：journal 写坏 → 必须抛错，三槽不动、目标库字节不变', () => {
    const dir = mkdtempSync(join(tmpdir(), 'mz-r3b3-rb-'))
    const target = join(dir, 'ledger.db')
    makeLedger(target, DEK, 'OLD-DATA')
    const staging = join(dir, 'ledger.db.restore-candidate-test')
    const src = join(dir, 'new.db')
    makeLedger(src, DEK, 'NEW-DATA')
    renameSync(src, staging)
    // 先正常恢复一次，制造真实回滚槽
    backup.replaceWithRollback(staging, target)
    expect(readMarker(target, DEK)).toBe('NEW-DATA')

    const before = readFileSync(target)
    corruptJournalWrites('truncate')

    expect(() => backup.rollbackRestore(target, DEK)).toThrow(/journal|恢复日志|读回|回读/i)
    expect(readFileSync(target).equals(before)).toBe(true)
    expect(readMarker(target, DEK)).toBe('NEW-DATA')
    rmSync(dir, { recursive: true, force: true })
  })
})

describe('B3 兼容：journal 完好时读回确认不得误伤既有语义', () => {
  it('正常替换仍成功：目标换新、回滚槽保留旧库、journal 清除', () => {
    const dir = mkdtempSync(join(tmpdir(), 'mz-r3b3-ok-'))
    const target = join(dir, 'ledger.db')
    makeLedger(target, DEK, 'OLD')
    const staging = join(dir, 'ledger.db.restore-candidate-test')
    const src = join(dir, 'new.db')
    makeLedger(src, DEK, 'NEW')
    renameSync(src, staging)

    backup.replaceWithRollback(staging, target)
    expect(readMarker(target, DEK)).toBe('NEW')
    expect(readMarker(`${target}.restore-rollback`, DEK)).toBe('OLD')
    expect(existsSync(`${target}.restore-journal.json`)).toBe(false)
    rmSync(dir, { recursive: true, force: true })
  })

  it('读回校验必须真的读盘：把 journal 替换成合法但字段不符的 JSON 也要被拒', () => {
    const dir = mkdtempSync(join(tmpdir(), 'mz-r3b3-fields-'))
    const target = join(dir, 'ledger.db')
    makeLedger(target, DEK, 'ORIGINAL')
    const before = readFileSync(target)
    const staging = join(dir, 'ledger.db.restore-candidate-test')
    const src = join(dir, 'new.db')
    makeLedger(src, DEK, 'CANDIDATE')
    renameSync(src, staging)

    const realWrite = backup.restoreFileOps.writeFileSync
    backup.__setRestoreFileOps({
      writeFileSync: ((file: string, data: string | Buffer) => {
        if (String(file).includes('.restore-journal.json')) {
          // 合法 JSON，但 phase/candidate/target/rollback/forward 五字段缺失
          return (realWrite as (f: string, d: string | Buffer) => void)(file, JSON.stringify({ hello: 'world' }))
        }
        return (realWrite as (f: string, d: string | Buffer) => void)(file, data)
      }) as typeof backup.restoreFileOps.writeFileSync,
    })

    expect(() => backup.replaceWithRollback(staging, target)).toThrow(/journal|恢复日志|读回|回读|字段|phase/i)
    expect(readFileSync(target).equals(before)).toBe(true)
    expect(readMarker(target, DEK)).toBe('ORIGINAL')
    rmSync(dir, { recursive: true, force: true })
  })
})

describe('B3 残留语义：journal 读回失败且删不掉时必须留可追踪残留，且不覆盖原始错误', () => {
  it('journal 写坏 + 正式 journal 删除失败：抛读回错误、journal 保留、残留清单可追踪', () => {
    const dir = mkdtempSync(join(tmpdir(), 'mz-r3b3-residue-'))
    const target = join(dir, 'ledger.db')
    makeLedger(target, DEK, 'ORIGINAL')
    const before = readFileSync(target)
    const staging = join(dir, 'ledger.db.restore-candidate-test')
    const src = join(dir, 'new.db')
    makeLedger(src, DEK, 'CANDIDATE')
    renameSync(src, staging)
    const jf = `${target}.restore-journal.json`

    const realRm = backup.restoreFileOps.rmSync
    corruptJournalWrites('garbage')
    backup.__setRestoreFileOps({
      rmSync: ((p: string, o?: unknown) => {
        // 正式 journal 删不掉（模拟 Windows 锁）：tmp 与其它路径照常
        if (p === jf) {
          const e = new Error(`EBUSY: resource busy or locked, unlink '${p}'`) as NodeJS.ErrnoException
          e.code = 'EBUSY'
          throw e
        }
        return (realRm as (p: string, o?: unknown) => void)(p, o)
      }) as typeof backup.restoreFileOps.rmSync,
    })

    // 抛出的必须是读回失败这一原始错误，不得被清理失败覆盖
    let threw: unknown = null
    try {
      backup.replaceWithRollback(staging, target)
    } catch (e) {
      threw = e
    }
    expect(String((threw as Error)?.message ?? threw)).toMatch(/journal|恢复日志|读回/i)
    expect(String((threw as Error)?.message ?? threw)).not.toMatch(/EBUSY/)
    // 目标库字节不变，journal 保留（可解释），残留清单可追踪
    expect(readFileSync(target).equals(before)).toBe(true)
    expect(readMarker(target, DEK)).toBe('ORIGINAL')
    expect(existsSync(jf)).toBe(true)
    const manifest = `${target}.restore-residues.json`
    expect(existsSync(manifest)).toBe(true)
    expect(String(readFileSync(manifest, 'utf8'))).toContain('restore-journal.json')
    rmSync(dir, { recursive: true, force: true })
  })
})
