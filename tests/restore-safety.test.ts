// T0924-1418 返工：恢复安全 7 阻断之回归测试（先 RED，后 GREEN）。
// 除 EBUSY 项（见 tests/restore-ebusy.test.ts，需 vi.mock）外，本文件覆盖其余 6 项。
// 全部只用临时合成库，不触碰真实账本/AppData。
import { describe, expect, it } from 'vitest'
import DatabaseCtor from 'better-sqlite3-multiple-ciphers'
import { mkdtempSync, writeFileSync, existsSync, readFileSync, rmSync, mkdirSync, renameSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import * as backup from '../src/main/domain/backup'
import { snapshot } from '../src/main/domain/backup'
import { schemaSql } from './helpers'
import { runMigrations } from '../src/main/db/migrations'
import { openLedger } from '../src/main/db/connection'

function makeLedger(file: string, dek: string, marker: string) {
  const db = new DatabaseCtor(file)
  db.pragma(`key = "x'${dek}'"`)
  db.pragma("cipher='chacha20'")
  db.exec(schemaSql())
  runMigrations(db)
  db.exec("CREATE TABLE IF NOT EXISTS t(a TEXT)")
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

/** 合成 user_version=1 旧库：schema.sql（天然无 bill 表）+ v1 迁移（dedup 列），版本锁 1。 */
function makeV1Ledger(file: string, dek: string, merchant: string) {
  const db = new DatabaseCtor(file)
  db.pragma(`key = "x'${dek}'"`)
  db.pragma("cipher='chacha20'")
  db.exec(schemaSql())
  db.exec('ALTER TABLE transactions ADD COLUMN dedup_key TEXT NULL')
  db.exec('CREATE INDEX IF NOT EXISTS idx_txn_dedup ON transactions(dedup_key) WHERE dedup_key IS NOT NULL')
  db.pragma('user_version = 1')
  const now = new Date().toISOString()
  const acc = Number(db.prepare("INSERT INTO accounts (name, type, currency, created_at, updated_at) VALUES ('现金','cash','CNY',?,?)").run(now, now).lastInsertRowid)
  const cat = Number(db.prepare("INSERT INTO categories (name, kind, created_at, updated_at) VALUES ('餐饮','expense',?,?)").run(now, now).lastInsertRowid)
  db.prepare(
    "INSERT INTO transactions (account_id, category_id, amount_cents, type, occurred_at, state, merchant, created_at, updated_at) VALUES (?,?,100,'expense',?,'confirmed',?,?,?)",
  ).run(acc, cat, now, merchant, now, now)
  db.close()
}

describe('R1 崩溃窗口：journal + 重启恢复，不造空库', () => {
  it('多步替换中段崩溃后，重启恢复能找回原库；目标缺失时 openLedger 拒绝新建空库', () => {
    const dir = mkdtempSync(join(tmpdir(), 'mz-r1-'))
    const dek = 'a1'.repeat(32)
    const target = join(dir, 'ledger.db')
    makeLedger(target, dek, 'ORIGINAL')
    const candidate = join(dir, 'candidate.db')
    makeLedger(candidate, dek, 'CANDIDATE')
    const staging = join(dir, 'ledger.db.restore-candidate-test')
    renameSync(candidate, staging)

    // 注入崩溃：原库已移入回滚槽、候选尚未落位时进程死亡。
    expect(() => backup.replaceWithRollback(staging, target, { crashAt: 'after-move-current' })).toThrow(/SIMULATED-CRASH/)
    expect(existsSync(target)).toBe(false)
    expect(existsSync(`${target}.restore-rollback`)).toBe(true)
    expect(existsSync(`${target}.restore-journal.json`)).toBe(true)

    // 重启恢复：原库回到目标名，可打开、可读。
    const st = backup.recoverInterruptedRestore(target, { dekHex: dek })
    expect(['recovered-original', 'recovered-candidate']).toContain(st)
    expect(readMarker(target, dek)).toBe('ORIGINAL')
    expect(existsSync(`${target}.restore-journal.json`)).toBe(false)

    // 目标缺失但残留回滚槽时，openLedger 绝不能静默新建空账本。
    const dir2 = mkdtempSync(join(tmpdir(), 'mz-r1b-'))
    const target2 = join(dir2, 'ledger.db')
    makeLedger(target2, dek, 'ORIGINAL')
    writeFileSync(`${target2}.restore-rollback`, readFileSync(target2))
    rmSync(target2, { force: true })
    const fakeSecrets = { get: () => dek, set: () => {} }
    expect(() => openLedger(target2, fakeSecrets as never)).toThrow(/未完成|恢复/)
    expect(existsSync(target2)).toBe(false)
  })

  it('提交已落位后崩溃（journal 未清），重启恢复保留候选结果', () => {
    const dir = mkdtempSync(join(tmpdir(), 'mz-r1c-'))
    const dek = 'a2'.repeat(32)
    const target = join(dir, 'ledger.db')
    makeLedger(target, dek, 'ORIGINAL')
    const candidate = join(dir, 'candidate.db')
    makeLedger(candidate, dek, 'CANDIDATE')
    const staging = join(dir, 'ledger.db.restore-candidate-test')
    renameSync(candidate, staging)
    expect(() => backup.replaceWithRollback(staging, target, { crashAt: 'after-commit' })).toThrow(/SIMULATED-CRASH/)
    const st = backup.recoverInterruptedRestore(target, { dekHex: dek })
    expect(st).toBe('recovered-candidate')
    expect(readMarker(target, dek)).toBe('CANDIDATE')
  })
})

describe('R2 普通 IPC 动态 Engine 绑定', () => {
  it('R2 普通 IPC 动态 Engine 绑定：旧 Engine dispose 后仍能服务新请求', async () => {
    const reg = await import('../src/main/engine/registry')
    expect(typeof reg.createEngineRegistry).toBe('function')
    const calls: string[] = []
    const engineA = {
      disposed: false,
      sendChat: async () => { if (this.disposed) throw new Error('旧 Engine 已 dispose'); calls.push('A-served') },
    }
    const engineB = {
      disposed: false,
      sendChat: async () => { if (this.disposed) throw new Error('新 Engine 已 dispose'); calls.push('B-served') },
    }
    const r = reg.createEngineRegistry<typeof engineA | typeof engineB>()
    r.set(engineA)
    const ipcSend = () => r.get().sendChat('hi', [])
    await ipcSend()
    engineA.disposed = true
    r.set(engineB)
    await ipcSend()
    expect(calls).toEqual(['A-served', 'B-served'])
    expect(r.get()).toBe(engineB)
  })
})

describe('R3 验证时序与 Agent/恢复互斥', () => {
  it('R3 验证时序与 Agent/恢复互斥：失败重开后普通 IPC 使用新 Engine，验证失败不关闭连接', async () => {
    const gateMod = await import('../src/main/domain/restore-gate')
    const gate = new gateMod.RestoreGate()
    const order: string[] = []
    const steps = (tag: string) => ({
      validate: async () => { order.push(`${tag}:validate`); return tag },
      close: async () => { order.push(`${tag}:close`) },
      commit: async () => { order.push(`${tag}:commit`) },
    })

    expect(gate.beginTurn()).toBe(true)
    await expect(gate.runRestore(steps('busy'))).rejects.toThrow(/Agent|恢复|忙|互斥/)
    expect(order).toEqual([])
    gate.endTurn()

    await expect(
      gate.runRestore({
        validate: async () => { throw new Error('候选坏') },
        close: async () => { order.push('should-not-close') },
        commit: async () => { order.push('should-not-commit') },
      }),
    ).rejects.toThrow(/候选坏/)
    expect(order).not.toContain('should-not-close')
    expect(order).not.toContain('should-not-commit')

    await gate.runRestore(steps('ok'))
    expect(order.slice(-3)).toEqual(['ok:validate', 'ok:close', 'ok:commit'])

    const engineRegistry = (await import('../src/main/engine/registry')).createEngineRegistry<{ disposed: boolean; serve(): string }>()
    const oldEngine = { disposed: false, serve() { if (this.disposed) throw new Error('旧引擎已 dispose'); return 'old' } }
    const newEngine = { disposed: false, serve() { if (this.disposed) throw new Error('新引擎已 dispose'); return 'new' } }
    engineRegistry.set(oldEngine)
    expect(engineRegistry.get().serve()).toBe('old')
    oldEngine.disposed = true
    engineRegistry.set(newEngine)
    expect(engineRegistry.get().serve()).toBe('new')
  })
})

describe('R5 旧快照 user_version=1 兼容', () => {
  it('v1 快照恢复时先迁移再验证：成功升级到 v2 且旧数据可读', () => {
    const dir = mkdtempSync(join(tmpdir(), 'mz-r5-'))
    const dek = 'b1'.repeat(32)
    const bk = join(dir, 'backups')
    const v1file = join(dir, 'v1.db')
    makeV1Ledger(v1file, dek, '王家饭馆')
    const probe = new DatabaseCtor(v1file)
    probe.pragma(`key = "x'${dek}'"`)
    probe.pragma("cipher='chacha20'")
    expect(probe.pragma('user_version', { simple: true })).toBe(1)
    probe.close()

    const src = new DatabaseCtor(v1file)
    src.pragma(`key = "x'${dek}'"`)
    src.pragma("cipher='chacha20'")
    const snap = snapshot(src, bk)
    src.close()
    const name = snap.replaceAll('\\', '/').split('/').pop() as string

    const current = join(dir, 'current.db')
    makeLedger(current, dek, 'CURRENT-MUST-GO')
    backup.restoreSnapshot(bk, name, current, dek)

    const db = new DatabaseCtor(current)
    db.pragma(`key = "x'${dek}'"`)
    db.pragma("cipher='chacha20'")
    expect(db.pragma('user_version', { simple: true })).toBe(2)
    expect(db.prepare("SELECT COUNT(*) n FROM sqlite_master WHERE type='table' AND name='bill_tables'").get()).toMatchObject({ n: 1 })
    expect(db.prepare('SELECT merchant FROM transactions').get()).toMatchObject({ merchant: '王家饭馆' })
    db.close()
  })

  it('坏旧结构（缺核心列）迁移/验证失败，不得替换当前库', () => {
    const dir = mkdtempSync(join(tmpdir(), 'mz-r5b-'))
    const dek = 'b2'.repeat(32)
    const bk = join(dir, 'backups')
    const bad = join(dir, 'badv1.db')
    makeV1Ledger(bad, dek, '坏结构')
    const db0 = new DatabaseCtor(bad)
    db0.pragma(`key = "x'${dek}'"`)
    db0.pragma("cipher='chacha20'")
    // 坏旧结构：整个丢掉一张预期账务表（迁移能跑，但结构验证必须拦下）
    db0.exec('DROP TABLE audit_log')
    db0.close()
    const src = new DatabaseCtor(bad)
    src.pragma(`key = "x'${dek}'"`)
    src.pragma("cipher='chacha20'")
    const snap = snapshot(src, bk)
    src.close()
    const name = snap.replaceAll('\\', '/').split('/').pop() as string
    const current = join(dir, 'current.db')
    const sentinel = Buffer.from('current-must-stay')
    writeFileSync(current, sentinel)
    expect(() => backup.restoreSnapshot(bk, name, current, dek)).toThrow()
    expect(readFileSync(current).equals(sentinel)).toBe(true)
  })
})

describe('R6 schema 验证验列不止验表名', () => {
  it('同名但缺关键列的候选必须拒绝且不改当前库', () => {
    const dir = mkdtempSync(join(tmpdir(), 'mz-r6-'))
    const dek = 'c1'.repeat(32)
    const bk = join(dir, 'backups')
    mkdirSync(bk, { recursive: true })
    // 11 张表名齐全，但 transactions 缺 amount_cents 等关键列，且无外键可供旧检查命中。
    const wrong = join(bk, 'mingzhang-snapshot-wrongcol.db')
    const w = new DatabaseCtor(wrong)
    w.pragma(`key = "x'${dek}'"`)
    w.pragma("cipher='chacha20'")
    w.pragma('foreign_keys = OFF')
    for (const t of ['accounts', 'categories', 'rules', 'imports', 'agent_runs', 'audit_log', 'pending_clarifications', 'settings', 'bill_tables', 'bill_rows']) {
      w.exec(`CREATE TABLE ${t}(id INTEGER PRIMARY KEY)`)
    }
    w.exec('CREATE TABLE transactions(id INTEGER PRIMARY KEY, account_id INTEGER)')
    w.close()
    const current = join(dir, 'current.db')
    const sentinel = Buffer.from('current-must-stay-r6')
    writeFileSync(current, sentinel)
    expect(() => backup.restoreSnapshot(bk, 'mingzhang-snapshot-wrongcol.db', current, dek)).toThrow(/关键列|结构|迁移/)
    expect(readFileSync(current).equals(sentinel)).toBe(true)
  })
})

describe('R7 .restore-rollback 真实回滚往返', () => {
  it('R7 .restore-rollback 真实回滚往返：恢复→回滚→重复回滚，sidecar 与数据均可验证', () => {
    const dir = mkdtempSync(join(tmpdir(), 'mz-r7-'))
    const dek = 'd1'.repeat(32)
    const bk = join(dir, 'backups')
    const target = join(dir, 'ledger.db')
    makeLedger(target, dek, 'OLD-DATA')
    const src = join(dir, 'new.db')
    makeLedger(src, dek, 'NEW-DATA')
    const s = new DatabaseCtor(src)
    s.pragma(`key = "x'${dek}'"`)
    s.pragma("cipher='chacha20'")
    const snap = snapshot(s, bk)
    s.close()
    const name = snap.replaceAll('\\', '/').split('/').pop() as string
    expect(typeof backup.rollbackRestore).toBe('function')
    backup.restoreSnapshot(bk, name, target, dek)
    expect(readMarker(target, dek)).toBe('NEW-DATA')
    expect(existsSync(`${target}.restore-rollback`)).toBe(true)

    backup.rollbackRestore(target, dek)
    expect(readMarker(target, dek)).toBe('OLD-DATA')
    expect(existsSync(`${target}.restore-rollback`)).toBe(true)

    backup.rollbackRestore(target, dek)
    expect(readMarker(target, dek)).toBe('NEW-DATA')
    expect(existsSync(`${target}.restore-forward`)).toBe(false)
  })

  it('无回滚副本时明确报错，不碰目标库', () => {
    const dir = mkdtempSync(join(tmpdir(), 'mz-r7b-'))
    const dek = 'd2'.repeat(32)
    const target = join(dir, 'ledger.db')
    makeLedger(target, dek, 'KEEP')
    expect(() => backup.rollbackRestore(target, dek)).toThrow(/回滚|副本/)
    expect(readMarker(target, dek)).toBe('KEEP')
  })
})
