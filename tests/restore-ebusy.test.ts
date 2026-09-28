// R4 提交后 plain 清理：EBUSY/Windows 锁不能把成功误报为失败；
// 清理失败只留可追踪残留，不碰 .restore-rollback 槽。
// 用生产级可注入 seam（restoreFileOps），无 vi.mock，不触真实账本。
import { describe, expect, it, afterEach } from 'vitest'
import DatabaseCtor from 'better-sqlite3-multiple-ciphers'
import { mkdtempSync, writeFileSync, existsSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  reencryptPlainToEncrypted,
  __setRestoreFileOps,
  __resetRestoreFileOps,
  restoreFileOps,
} from '../src/main/domain/backup'
import { schemaSql } from './helpers'
import { runMigrations } from '../src/main/db/migrations'

afterEach(() => {
  __resetRestoreFileOps()
})

function makeEnc(file: string, dek: string, marker: string) {
  const db = new DatabaseCtor(file)
  db.pragma(`key = "x'${dek}'"`)
  db.pragma("cipher='chacha20'")
  db.exec(schemaSql())
  runMigrations(db)
  db.exec('CREATE TABLE IF NOT EXISTS t(a TEXT)')
  db.prepare('INSERT INTO t VALUES (?)').run(marker)
  db.close()
}

function makePlain(file: string, marker: string) {
  const db = new DatabaseCtor(file)
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

function ebusy(path: string): NodeJS.ErrnoException {
  const e = new Error(`EBUSY: resource busy or locked, unlink '${path}'`) as NodeJS.ErrnoException
  e.code = 'EBUSY'
  e.path = path
  return e
}

describe('R4 提交后清理 EBUSY 不误报成功', () => {
  it('plain 删除遇 EBUSY：替换照样成功，残留可追踪，回滚槽完好', () => {
    expect(typeof __setRestoreFileOps).toBe('function')
    const dir = mkdtempSync(join(tmpdir(), 'mz-r4-'))
    const dek = 'e1'.repeat(32)
    const target = join(dir, 'ledger.db')
    makeEnc(target, dek, 'OLD')
    const plain = join(dir, 'cand.plain')
    makePlain(plain, 'NEW')

    const realRm = restoreFileOps.rmSync
    // 仅 plain 明文路径抛 EBUSY，其余走真实 fs。
    __setRestoreFileOps({
      rmSync: ((p: string, o?: unknown) => {
        if (String(p) === plain) throw ebusy(String(p))
        return (realRm as (p: string, o?: unknown) => void)(p, o)
      }) as typeof realRm,
    })

    // 必须不抛：提交已成功，不能因清理失败误报失败。
    reencryptPlainToEncrypted(plain, target, dek)
    expect(readMarker(target, dek)).toBe('NEW')
    // 回滚槽是旧库，可打开验证。
    const rollback = `${target}.restore-rollback`
    expect(existsSync(rollback)).toBe(true)
    expect(readMarker(rollback, dek)).toBe('OLD')
    // 残留可追踪：plain 还在 + 有残留清单。
    expect(existsSync(plain)).toBe(true)
    const manifest = `${target}.restore-residues.json`
    expect(existsSync(manifest)).toBe(true)
    expect(String(readFileSync(manifest, 'utf8'))).toContain('cand.plain')
  })

  it('回滚槽清理遇 EBUSY：不得覆盖/破坏回滚槽，当前库原样不动并明确失败', () => {
    const dir = mkdtempSync(join(tmpdir(), 'mz-r4b-'))
    const dek = 'e2'.repeat(32)
    const target = join(dir, 'ledger.db')
    makeEnc(target, dek, 'OLD')
    const before = readFileSync(target)
    const rollback = `${target}.restore-rollback`
    // 预置一个旧回滚槽（上一轮残留），其删除被锁。
    writeFileSync(rollback, Buffer.from('previous-rollback-sentinel'))
    const plain = join(dir, 'cand.plain')
    makePlain(plain, 'NEW')

    const realRm = restoreFileOps.rmSync
    __setRestoreFileOps({
      rmSync: ((p: string, o?: unknown) => {
        if (String(p).startsWith(rollback)) throw ebusy(String(p))
        return (realRm as (p: string, o?: unknown) => void)(p, o)
      }) as typeof realRm,
    })

    expect(() => reencryptPlainToEncrypted(plain, target, dek)).toThrow(/EBUSY|回滚|清理/)
    // 当前库字节不变，回滚槽内容不被覆盖。
    expect(readFileSync(target).equals(before)).toBe(true)
    expect(String(readFileSync(rollback, 'utf8'))).toBe('previous-rollback-sentinel')
  })
})
