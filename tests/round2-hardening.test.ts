// T0924-1418 round2 hardening: adversarial recovery convergence regressions.
// Synthetic temporary databases only; never touches the real ledger or AppData.
import { afterEach, describe, expect, it } from 'vitest'
import DatabaseCtor from 'better-sqlite3-multiple-ciphers'
import { existsSync, mkdtempSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import * as backup from '../src/main/domain/backup'
import { openLedger } from '../src/main/db/connection'
import { schemaSql } from './helpers'
import { runMigrations } from '../src/main/db/migrations'

const DEK = 'h2'.repeat(32)

afterEach(() => {
  backup.__resetRestoreFileOps()
})

function enc(file: string, marker: string): void {
  const db = new DatabaseCtor(file)
  db.pragma(`key = "x'${DEK}'"`)
  db.pragma("cipher='chacha20'")
  db.exec(schemaSql())
  runMigrations(db)
  db.exec('CREATE TABLE IF NOT EXISTS marker(value TEXT NOT NULL)')
  db.prepare('INSERT INTO marker VALUES (?)').run(marker)
  db.close()
}

function readMarker(file: string): string {
  const db = new DatabaseCtor(file)
  db.pragma(`key = "x'${DEK}'"`)
  db.pragma("cipher='chacha20'")
  const row = db.prepare('SELECT value FROM marker').get() as { value: string }
  db.close()
  return row.value
}

function journal(target: string, phase: 'replacing' | 'rolling-back', candidate = `${target}.restore-candidate-test`): string {
  const file = `${target}.restore-journal.json`
  writeFileSync(file, JSON.stringify({
    phase,
    candidate,
    target,
    rollback: `${target}.restore-rollback`,
    forward: `${target}.restore-forward`,
    createdAt: new Date().toISOString(),
    pid: process.pid,
  }))
  return file
}

describe('round2 hardening: convergence must be explicit', () => {
  it('replacing journal with a target and residual forward slot keeps the journal', () => {
    const dir = mkdtempSync(join(tmpdir(), 'mz-r2-hard-forward-'))
    const target = join(dir, 'ledger.db')
    enc(target, 'TARGET')
    enc(`${target}.restore-rollback`, 'OLD')
    const forward = `${target}.restore-forward`
    // forward 模拟替换阶段残留：恢复不能把它猜成已成功，也不能静默清 journal。
    writeFileSync(forward, Buffer.from('synthetic-forward-residue'))
    const jf = journal(target, 'replacing')

    expect(() => backup.recoverInterruptedRestore(target, { dekHex: DEK })).toThrow(/收敛|forward|恢复/)
    expect(existsSync(jf)).toBe(true)
    expect(existsSync(forward)).toBe(true)
  })

  it('rolling-back journal with no rollback or forward slot is not treated as converged', () => {
    const dir = mkdtempSync(join(tmpdir(), 'mz-r2-hard-missing-back-'))
    const target = join(dir, 'ledger.db')
    enc(target, 'TARGET')
    const jf = journal(target, 'rolling-back')

    expect(() => backup.recoverInterruptedRestore(target, { dekHex: DEK })).toThrow(/回滚|收敛|恢复/)
    expect(existsSync(jf)).toBe(true)
  })

  it('rollback cannot clear journal when a forward slot remains unrenamed', () => {
    const dir = mkdtempSync(join(tmpdir(), 'mz-r2-hard-roll-forward-'))
    const target = join(dir, 'ledger.db')
    const candidate = join(dir, 'candidate.db')
    enc(target, 'OLD')
    enc(candidate, 'NEW')
    const staging = join(dir, 'ledger.db.restore-candidate-test')
    renameSync(candidate, staging)
    backup.replaceWithRollback(staging, target)
    expect(readMarker(target)).toBe('NEW')

    const realRename = backup.restoreFileOps.renameSync
    const forward = `${target}.restore-forward`
    const rollback = `${target}.restore-rollback`
    backup.__setRestoreFileOps({
      renameSync: ((from: string, to: string) => {
        if (from === forward && to === rollback) return // deliberately leave forward behind
        return realRename(from, to)
      }) as typeof realRename,
    })

    expect(() => backup.rollbackRestore(target, DEK)).toThrow(/收敛|forward|恢复/)
    expect(existsSync(`${target}.restore-journal.json`)).toBe(true)
    expect(existsSync(forward)).toBe(true)
  })

  it('openLedger refuses a missing target when a forward recovery artifact remains', () => {
    const dir = mkdtempSync(join(tmpdir(), 'mz-r2-hard-open-forward-'))
    const target = join(dir, 'ledger.db')
    writeFileSync(`${target}.restore-forward`, Buffer.from('synthetic-forward-residue'))
    const secrets = { get: () => DEK, set: () => {} } as never

    expect(() => openLedger(target, secrets)).toThrow(/恢复|forward|空账本/)
    expect(existsSync(target)).toBe(false)
  })

  it('openLedger refuses journal temp residue instead of creating a new database', () => {
    const dir = mkdtempSync(join(tmpdir(), 'mz-r2-hard-open-jtmp-'))
    const target = join(dir, 'ledger.db')
    writeFileSync(`${target}.restore-journal.json.tmp-synthetic`, '{}')
    const secrets = { get: () => DEK, set: () => {} } as never

    expect(() => openLedger(target, secrets)).toThrow(/恢复|journal|空账本/)
    expect(existsSync(target)).toBe(false)
  })
})
