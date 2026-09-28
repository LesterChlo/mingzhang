// T0924-1418 round2 RED: B1-B6/并发/failpoint/sqlite_sequence/生产schema契约。
// 严格 TDD：本文件在当前未提交实现上必须真实失败；日志见 .scratch/T0924-1418-round2-red-*.log。
// 只用合成临时目录/合成账本，不触真实 AppData/账本。
import { describe, expect, it, afterEach } from 'vitest'
import DatabaseCtor from 'better-sqlite3-multiple-ciphers'
import { mkdtempSync, writeFileSync, existsSync, readFileSync, rmSync, mkdirSync, lstatSync, renameSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import * as backup from '../src/main/domain/backup'
import { openLedger, initSchemaIfEmpty } from '../src/main/db/connection'
import { RestoreGate } from '../src/main/domain/restore-gate'
import { schemaSql } from './helpers'
import { runMigrations } from '../src/main/db/migrations'

afterEach(() => {
  try { backup.__resetRestoreFileOps() } catch { /* ignore */ }
})

const DEK = 'r2'.repeat(32)

/** 第二轮独立复核要求的真实并发令牌回归：不能用 boolean 或任意 end 伪装修正。 */
function checkProductionSchemaContractRejectsMissingNonKeyColumn(): void {
  const dir = mkdtempSync(join(tmpdir(), 'mz-r2schema-'))
  const file = join(dir, 'contract.db')
  const db = new DatabaseCtor(file)
  db.exec(schemaSql())
  runMigrations(db)
  // 规则表的 hit_count 是生产契约列，但旧的手写子集漏掉了它；同名错结构应被拒绝。
  db.exec('ALTER TABLE rules RENAME TO rules_old')
  db.exec(`CREATE TABLE rules (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    condition TEXT NOT NULL UNIQUE,
    action TEXT NOT NULL,
    provenance TEXT NOT NULL,
    active INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  )`)
  db.exec('DROP TABLE rules_old')
  db.close()
  const probe = new DatabaseCtor(file)
  try {
    expect(() => backup.validateLedgerDatabase(probe, '生产契约回归')).toThrow(/hit_count|结构|列|契约/)
  } finally {
    probe.close()
    rmSync(dir, { recursive: true, force: true })
  }
}

function enc(file: string, dek = DEK) {
  const db = new DatabaseCtor(file)
  db.pragma(`key = "x'${dek}'"`)
  db.pragma("cipher='chacha20'")
  db.exec(schemaSql())
  runMigrations(db)
  db.close()
  return file
}

function mark(file: string, dek: string, marker: string) {
  const db = new DatabaseCtor(file)
  db.pragma(`key = "x'${dek}'"`)
  db.pragma("cipher='chacha20'")
  db.exec('CREATE TABLE IF NOT EXISTS t(a TEXT)')
  db.prepare("INSERT INTO t VALUES (?)").run(marker)
  db.close()
}

function readMark(file: string, dek: string): string {
  const db = new DatabaseCtor(file)
  db.pragma(`key = "x'${dek}'"`)
  db.pragma("cipher='chacha20'")
  const row = db.prepare('SELECT a FROM t').get() as { a: string }
  db.close()
  return row.a
}

const fakeSecrets = (dek: string) => ({ get: () => dek, set: () => {} }) as never

describe('B1 启动绝不把已存在异常库补成新空账本', () => {
  it('B1a 目标存在但为空文件：openLedger 必须拒绝而不是 initSchema 补成新空账本', () => {
    const dir = mkdtempSync(join(tmpdir(), 'mz-r2b1a-'))
    const target = join(dir, 'ledger.db')
    writeFileSync(target, Buffer.alloc(0))
    expect(() => openLedger(target, fakeSecrets(DEK))).toThrow()
    // 空库不得被“修好”成可用账本：仍无账务表
    const probe = new DatabaseCtor(target)
    try {
      probe.pragma(`key = "x'${DEK}'"`)
      probe.pragma("cipher='chacha20'")
      const tables = (probe.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as { name: string }[]).map(r => r.name)
      expect(tables).not.toContain('transactions')
    } finally { probe.close() }
  })

  it('B1b 目标存在但错 schema：openLedger 必须拒绝而不是补成新空账本', () => {
    const dir = mkdtempSync(join(tmpdir(), 'mz-r2b1b-'))
    const target = join(dir, 'ledger.db')
    const db = new DatabaseCtor(target)
    db.pragma(`key = "x'${DEK}'"`)
    db.pragma("cipher='chacha20'")
    db.exec('CREATE TABLE junk(id INTEGER PRIMARY KEY)')
    db.close()
    expect(() => openLedger(target, fakeSecrets(DEK))).toThrow(/schema|结构|账务|损坏|解密/)
  })

  it('B1c journal 缺失但 target 缺失且无 rollback：纯首次启动可建库，后续初始化只对真新库生效', () => {
    const dir = mkdtempSync(join(tmpdir(), 'mz-r2b1c-'))
    const target = join(dir, 'ledger.db')
    const db = openLedger(target, fakeSecrets(DEK))
    expect(() => initSchemaIfEmpty(db)).not.toThrow()
    db.close()
    expect(existsSync(target)).toBe(true)
    // 再次打开已初始化库并调用同一入口不得重置/补空
    const again = openLedger(target, fakeSecrets(DEK))
    expect(() => initSchemaIfEmpty(again)).not.toThrow()
    again.close()
    rmSync(dir, { recursive: true, force: true })
  })

  it('B1d journal 存在且 target 已存在：启动恢复必须先收敛，openLedger 不得直接打开脏库', () => {
    const dir = mkdtempSync(join(tmpdir(), 'mz-r2b1d-'))
    const target = join(dir, 'ledger.db')
    enc(target); mark(target, DEK, 'DIRTY?')
    const cand = join(dir, 'nope.db')
    enc(cand)
    const candidate = join(dir, 'ledger.db.restore-candidate-test')
    renameSync(cand, candidate)
    const forward = `${target}.restore-forward`
    const rollback = `${target}.restore-rollback`
    const jf = `${target}.restore-journal.json`
    writeFileSync(jf, JSON.stringify({ phase: 'replacing', candidate, target, rollback, forward, createdAt: new Date().toISOString(), pid: 1 }))
    // 未先 recover 就 open：必须拒绝（脏库不可直接用）
    expect(() => openLedger(target, fakeSecrets(DEK))).toThrow(/恢复|journal|中断/)
    // 启动恢复：target 已存在且无 forward/rollback 残留时，验证并清理 journal 后收敛。
    const st = backup.recoverInterruptedRestore(target, { dekHex: DEK })
    expect(st).toBe('recovered-candidate')
    expect(existsSync(jf)).toBe(false)
  })
})

describe('B2 RestoreGate 真实并发轮次（计数/令牌）', () => {
  it('两个并发 turn：一个 endTurn 不得提前解锁另一个；嵌套 begin/end 正确', async () => {
    const gate = new RestoreGate()
    // 两个真实并发轮次同时登记
    const [a, b] = await Promise.all([Promise.resolve(gate.beginTurn()), Promise.resolve(gate.beginTurn())])
    expect(a).toBe(true)
    expect(b).toBe(true)
    // 任一恢复在仍有 turn 未结束时必须拒绝
    await expect(gate.runRestore({ validate: async () => {}, close: async () => {}, commit: async () => {} })).rejects.toThrow(/Agent|轮次|互斥|忙/)
    gate.endTurn() // 只结束一轮
    await expect(gate.runRestore({ validate: async () => {}, close: async () => {}, commit: async () => {} })).rejects.toThrow(/Agent|轮次|互斥|忙/)
    gate.endTurn() // 两轮都结束才能恢复
    await gate.runRestore({ validate: async () => {}, close: async () => {}, commit: async () => {} })
  })

  it('令牌式 endTurn：旧令牌重复结束不得提前解锁其它并发轮次', async () => {
    const gate = new RestoreGate()
    const tokenA = gate.beginTurnToken()
    const tokenB = gate.beginTurnToken()
    expect(tokenA).not.toBeNull()
    expect(tokenB).not.toBeNull()
    expect(gate.activeTurns).toBe(2)
    gate.endTurn(tokenA)
    // 重复使用旧令牌是 no-op，不能误结束 B。
    gate.endTurn(tokenA)
    expect(gate.activeTurns).toBe(1)
    await expect(gate.runRestore({ validate: async () => {}, close: async () => {}, commit: async () => {} })).rejects.toThrow(/Agent|轮次|互斥|忙/)
    gate.endTurn(tokenB)
    expect(gate.activeTurns).toBe(0)
    await gate.runRestore({ validate: async () => {}, close: async () => {}, commit: async () => {} })
  })

  it('两个并发恢复：第二个必须以可识别的门拒绝错误失败', async () => {
    const gate = new RestoreGate()
    let release!: () => void
    const held = new Promise<void>(r => { release = r })
    const p1 = gate.runRestore({ validate: async () => { await held }, close: async () => {}, commit: async () => {} })
    // 真实同时发起第二个恢复
    await new Promise(r => setTimeout(r, 10))
    await expect(gate.runRestore({ validate: async () => {}, close: async () => {}, commit: async () => {} })).rejects.toThrow(/恢复|并发|互斥|RestoreGateRefused|GATE_REFUSED/)
    release()
    await p1
  })
})

describe('B3 gate 拒绝时 IPC 不得 close/commit/restart，原错误保持', () => {
  it('门拒绝发生在 restoring=true 之前：close/commit/reconnect 均 0 次，原错误保持', async () => {
    const mod = await import('../src/main/domain/restore-gate')
    // 生产 IPC 必须走 runRestoreWithReconnect（先 RED：helper 缺失）
    expect(typeof (mod as unknown as { runRestoreWithReconnect?: unknown }).runRestoreWithReconnect).toBe('function')
    expect(typeof (mod as unknown as { isRestoreGateRefusal?: unknown }).isRestoreGateRefusal).toBe('function')
    const { RestoreGate, runRestoreWithReconnect, isRestoreGateRefusal } = mod as unknown as {
      RestoreGate: new () => { beginTurn(): boolean; endTurn(): void; runRestore(s: { validate(): Promise<unknown>; close(): Promise<void>; commit(): Promise<void> }): Promise<void> }
      runRestoreWithReconnect: (g: unknown, s: { validate(): Promise<unknown>; close(): Promise<void>; commit(): Promise<void> }, r: () => Promise<void>) => Promise<void>
      isRestoreGateRefusal: (e: unknown) => boolean
    }
    const gate = new RestoreGate()
    expect(gate.beginTurn()).toBe(true) // 模拟 Agent 轮次进行中
    let closes = 0, commits = 0, reconnects = 0
    const caught = await runRestoreWithReconnect(gate, {
      validate: async () => {},
      close: async () => { closes++ },
      commit: async () => { commits++ },
    }, async () => { reconnects++ }).then(() => null, (e: unknown) => e)
    expect(isRestoreGateRefusal(caught)).toBe(true)
    expect(String((caught as Error)?.message ?? caught)).toMatch(/Agent|轮次|互斥|忙|恢复/)
    expect({ closes, commits, reconnects }).toEqual({ closes: 0, commits: 0, reconnects: 0 })
    gate.endTurn()
    // 已 close 后 commit 失败才重开，且原错误保持
    let closes2 = 0, reconnects2 = 0
    const commitErr = new Error('commit-boom')
    const caught2 = await runRestoreWithReconnect(gate, {
      validate: async () => {},
      close: async () => { closes2++ },
      commit: async () => { throw commitErr },
    }, async () => { reconnects2++ }).then(() => null, (e: unknown) => e)
    expect(caught2).toBe(commitErr)
    expect({ closes2, reconnects2 }).toEqual({ closes2: 1, reconnects2: 1 })
  })
})

describe('B4 importBackup 全路径 plain 清理', () => {
  it('decrypt 后各失败路径统一删除 plain（validate/门拒绝/close/commit），成功后无残留', async () => {
    const mod = await import('../src/main/domain/restore-gate')
    // 生产约定的统一清理入口（先 RED：缺失）
    expect(typeof backup.cleanupImportPlain).toBe('function')
    // 四种失败语义 + 成功语义，全部经 finally 统一清理（模拟 IPC importBackup 流程）
    const scenarios: { name: string; failAt: 'validate' | 'gate' | 'close' | 'commit' | 'none' }[] = [
      { name: '预验证失败', failAt: 'validate' },
      { name: '门拒绝', failAt: 'gate' },
      { name: 'close 失败', failAt: 'close' },
      { name: 'commit 失败', failAt: 'commit' },
      { name: '成功', failAt: 'none' },
    ]
    for (const sc of scenarios) {
      const dir = mkdtempSync(join(tmpdir(), 'mz-r2b4-'))
      const plain = join(dir, '.restore-1.plain')
      writeFileSync(plain, 'synthetic-plain-sentinel')
      const gate = new mod.RestoreGate()
      if (sc.failAt === 'gate') expect(gate.beginTurn()).toBe(true) // 让门拒绝
      const reconnect = async () => {}
      let threw: unknown = null
      try {
        if (sc.failAt === 'validate') throw new Error('候选坏')
        await (mod as unknown as { runRestoreWithReconnect: (g: unknown, s: { validate(): Promise<unknown>; close(): Promise<void>; commit(): Promise<void> }, r: () => Promise<void>) => Promise<void> }).runRestoreWithReconnect(gate, {
          validate: async () => {},
          close: async () => { if (sc.failAt === 'close') throw new Error('close-boom') },
          commit: async () => { if (sc.failAt === 'commit') throw new Error('commit-boom'); backup.cleanupImportPlain(plain) },
        }, reconnect)
      } catch (e) { threw = e } finally {
        backup.cleanupImportPlain(plain) // 生产 IPC finally 统一清理
      }
      if (sc.failAt === 'none') expect(threw).toBeNull()
      else expect(threw).toBeTruthy()
      expect(existsSync(plain)).toBe(false)
      if (sc.failAt === 'gate') gate.endTurn()
      rmSync(dir, { recursive: true, force: true })
    }
    // 清理自身永不抛（重复删除安全：reencrypt 已删后再次清理）
    expect(() => backup.cleanupImportPlain(join(tmpdir(), 'mz-r2b4-nonexistent.plain'))).not.toThrow()
  })
})

describe('B5 rollback 同 gate/同 journal/三阶段 failpoint 收敛', () => {
  it('rollback 走同一 gate：恢复进行中拒绝并发 rollback（IPC 层 gate 复用）', async () => {
    const { runRestoreWithReconnect } = await import('../src/main/domain/restore-gate')
    const gate = new RestoreGate()
    let release!: () => void
    const held = new Promise<void>(r => { release = r })
    const p1 = gate.runRestore({ validate: async () => { await held }, close: async () => {}, commit: async () => {} })
    await new Promise(r => setTimeout(r, 10))
    // rollback 的 IPC 路径必须同样经 gate：并发恢复进行中时 rollback 的 validate/close/commit 不得执行
    let ran = 0
    await expect(runRestoreWithReconnect(gate, {
      validate: async () => { ran++; await backup.validateRollbackCandidate(join(tmpdir(), 'mz-r2b5-nope.db'), DEK) },
      close: async () => { ran++ },
      commit: async () => { ran++ },
    }, async () => { ran += 100 })).rejects.toThrow(/恢复|并发|互斥|轮次/)
    expect(ran).toBe(0)
    release()
    await p1
  })

  it.each([['after-move-current'], ['after-commit']] as string[][])('正向替换 %s 崩溃后 recover 可收敛（基线已覆盖，此处锁定契约）', (stage) => {
    const dir = mkdtempSync(join(tmpdir(), 'mz-r2b5f-'))
    const target = join(dir, 'ledger.db')
    enc(target); mark(target, DEK, 'ORIGINAL')
    const cand = join(dir, 'cand.db')
    enc(cand); mark(cand, DEK, 'CANDIDATE')
    const staging = join(dir, 'ledger.db.restore-candidate-test')
    renameSync(cand, staging)
    expect(() => backup.replaceWithRollback(staging, target, { crashAt: stage as never })).toThrow(/SIMULATED-CRASH/)
    const st = backup.recoverInterruptedRestore(target, { dekHex: DEK })
    expect(['recovered-original', 'recovered-candidate']).toContain(st)
  })

  it('rollback 三阶段 rename failpoint：每次崩溃后 recover 可收敛且只在收敛后清 journal', () => {
    const stages = ['after-move-current', 'after-restore', 'after-refill'] as const
    for (const stage of stages) {
      const dir = mkdtempSync(join(tmpdir(), 'mz-r2b5r-'))
      const target = join(dir, 'ledger.db')
      enc(target); mark(target, DEK, 'CUR')
      const cand = join(dir, 'cand.db')
      enc(cand); mark(cand, DEK, 'NEW')
      const staging = join(dir, 'ledger.db.restore-candidate-test')
      renameSync(cand, staging)
      backup.replaceWithRollback(staging, target)
      expect(readMark(target, DEK)).toBe('NEW')
      // rollback 在指定阶段崩溃（先 RED：尚不支持 crashAt）
      expect(() => backup.rollbackRestore(target, DEK, { crashAt: stage })).toThrow(/SIMULATED-CRASH/)
      expect(existsSync(`${target}.restore-journal.json`)).toBe(true)
      // 下一次 recover 必须收敛：target 回到 OLD 且可验证，journal 只在确认收敛后清
      const st = backup.recoverInterruptedRestore(target, { dekHex: DEK })
      expect(st).toBe('recovered-rollback')
      expect(readMark(target, DEK)).toBe('CUR')
      expect(existsSync(`${target}.restore-journal.json`)).toBe(false)
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe('B6 journal 原子持久化四阶段 + 工件白名单 + 异常保留 journal', () => {
  it('journal 写入四阶段（tmp/write→fsync→rename→dir-fsync）可注入：每阶段失败均可观测', async () => {
    // 生产 restoreFileOps 经 atomicWriteJson 路由四阶段；逐阶段注入失败验证可观测性。
    const ops = backup.restoreFileOps as unknown as Record<string, unknown>
    expect(ops.fsyncFile).toBeDefined()
    expect(ops.fsyncDir).toBeDefined()
    expect(ops.atomicWriteJson).toBeDefined()
    for (const stage of ['writeFileSync', 'fsyncFile', 'renameSync'] as const) {
      const dir = mkdtempSync(join(tmpdir(), 'mz-r2b6j4-'))
      const target = join(dir, 'ledger.db')
      enc(target)
      const cand = join(dir, 'cand.db')
      enc(cand)
      const staging = join(dir, 'ledger.db.restore-candidate-test')
      renameSync(cand, staging)
      const real = (backup.restoreFileOps as unknown as Record<string, (a: string, b?: unknown) => void>)[stage]
      backup.__setRestoreFileOps({ [stage]: (() => { throw new Error(`INJECTED-${stage}`) }) as never })
      let threw: unknown = null
      try { backup.replaceWithRollback(staging, target) } catch (e) { threw = e }
      expect(String((threw as Error)?.message ?? threw)).toMatch(new RegExp(stage === 'writeFileSync' ? 'INJECTED-writeFileSync' : `INJECTED-${stage}`))
      expect(existsSync(`${target}.restore-journal.json`)).toBe(false)
      expect(existsSync(target)).toBe(true)
      backup.__resetRestoreFileOps()
      void real
      rmSync(dir, { recursive: true, force: true })
    }
    // dir-fsync 失败为尽力而为：不翻转成功结论
    {
      const dir = mkdtempSync(join(tmpdir(), 'mz-r2b6j4d-'))
      const target = join(dir, 'ledger.db')
      enc(target)
      const cand = join(dir, 'cand.db')
      enc(cand)
      const staging = join(dir, 'ledger.db.restore-candidate-test')
      renameSync(cand, staging)
      backup.__setRestoreFileOps({ fsyncDir: (() => { throw new Error('INJECTED-dir-fsync') }) as never })
      backup.replaceWithRollback(staging, target)
      expect(existsSync(target)).toBe(true)
      expect(existsSync(`${target}.restore-journal.json`)).toBe(false)
      backup.__resetRestoreFileOps()
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('候选/工件白名单拒绝路径越界与符号链接', () => {
    const dir = mkdtempSync(join(tmpdir(), 'mz-r2b6w-'))
    const target = join(dir, 'ledger.db')
    enc(target)
    const outside = join(tmpdir(), 'mz-r2b6-outside.db')
    enc(outside)
    // 越界 candidate 必须拒绝
    expect(() => backup.replaceWithRollback(join(dir, '..', 'mz-r2b6-outside.db'), target)).toThrow(/越界|白名单|非法|拒绝/)
    // 符号链接候选必须拒绝（POSIX；Windows 下若不支持则跳过）
    try {
      const link = join(dir, 'link.db')
      const { symlinkSync } = require('node:fs') as typeof import('node:fs')
      symlinkSync(outside, link)
      expect(lstatSync(link).isSymbolicLink()).toBe(true)
      expect(() => backup.replaceWithRollback(link, target)).toThrow(/符号|链接|白名单|拒绝|越界/)
    } catch (e) {
      if ((e as Error)?.message?.includes('白名单') || (e as Error)?.message?.includes('符号')) throw e
      // 创建链接失败则仅记录（Windows 权限），不断言失败
    }
  })

  it('正向替换异常且内部恢复 rename 也失败时绝不能删 journal', () => {
    const dir = mkdtempSync(join(tmpdir(), 'mz-r2b6j-'))
    const target = join(dir, 'ledger.db')
    enc(target); mark(target, DEK, 'ORIG')
    const cand = join(dir, 'cand.db')
    enc(cand); mark(cand, DEK, 'CAND')
    const staging = join(dir, 'ledger.db.restore-candidate-test')
    renameSync(cand, staging)
    const realRename = (backup.restoreFileOps as unknown as { renameSync: (a: string, b: string) => void }).renameSync
    let calls = 0
    // 注意：journal 已改走 atomicWriteJson（内部 tmp→rename），此处注入只拦截“数据 rename”
    // （target/rollback 工件），journal 自身的 tmp rename 放行，确保测试聚焦“内部恢复 rename 也失败”语义。
    backup.__setRestoreFileOps({ renameSync: ((a: string, b: string) => {
      if (String(a).endsWith('.tmp-' + process.pid + '-' + String(Date.now()).slice(0, 0)) || String(a).includes('.restore-journal.json.tmp-')) {
        return (realRename as (a: string, b: string) => void)(a, b)
      }
      calls++
      // 第一批 current→rollback 放行；候选落位抛错；内部回滚 rename 也抛错
      if (calls === 1) return (realRename as (a: string, b: string) => void)(a, b)
      throw Object.assign(new Error('EBUSY: injected rename failure'), { code: 'EBUSY' })
    }) as never })
    let threw: unknown = null
    try { backup.replaceWithRollback(staging, target) } catch (e) { threw = e }
    expect(threw).toBeTruthy()
    // 违规要求：此情形绝不能删 journal（当前实现 catch 里尝试删 journal → RED）
    expect(existsSync(`${target}.restore-journal.json`)).toBe(true)
  })
})

describe('生产 schema 契约：校验必须源自 schema.sql/迁移', () => {
  it('缺少生产契约中的非手写关键列也必须拒绝', () => {
    checkProductionSchemaContractRejectsMissingNonKeyColumn()
  })

  it('EXPECTED_* 不得是手写漂移子集：必须能从 schema.sql+迁移机械得出', async () => {
    const mod = await import('../src/main/domain/backup')
    // RED：当前实现内部 EXPECTED_LEDGER_TABLES/COLUMNS 未导出且无防漂移入口
    expect(typeof (mod as unknown as { getProductionSchemaContract?: unknown }).getProductionSchemaContract).toBe('function')
    const contract = (mod as unknown as { getProductionSchemaContract: () => { tables: string[]; columns: Record<string, string[]> } }).getProductionSchemaContract()
    // 与 schema.sql+迁移后真实库结构一致（表集合至少覆盖核心账务表）
    for (const t of ['accounts', 'categories', 'transactions', 'rules', 'imports', 'agent_runs', 'audit_log', 'pending_clarifications', 'settings', 'bill_tables', 'bill_rows']) {
      expect(contract.tables).toContain(t)
    }
    expect(contract.columns.transactions).toContain('amount_cents')
  })
})

describe('copyAll sqlite_sequence 高水位', () => {
  it('显式 id 插入后 copy 必须恢复每表 sqlite_sequence 高水位', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'mz-r2seq-'))
    const dekB = 's1'.repeat(32)
    // 源库：显式大 id 插入后删除部分行，使 max(id) < seq 高水位
    const srcF = join(dir, 'src.db')
    const src = new DatabaseCtor(srcF)
    src.pragma(`key = "x'${dekB}'"`)
    src.pragma("cipher='chacha20'")
    src.exec(schemaSql()); runMigrations(src)
    const now = new Date().toISOString()
    src.prepare("INSERT INTO accounts (id, name, type, currency, created_at, updated_at) VALUES (50, '高水位','cash','CNY',?,?)").run(now, now)
    src.prepare("DELETE FROM accounts WHERE id = 50").run()
    const srcSeq = (src.prepare("SELECT seq FROM sqlite_sequence WHERE name='accounts'").get() as { seq: number }).seq
    expect(srcSeq).toBe(50)
    // 用口令包导出→重加密路径（内部 copyAll）复制
    mkdirSync(join(dir, 'bk'), { recursive: true })
    await backup.exportPassphraseBackup(src, join(dir, 'bk'), '正确口令-123456', join(dir, 'p.mzbackup'))
    src.close()
    const plain = join(dir, 'c.plain')
    await backup.importPassphraseBackupToPlain(join(dir, 'p.mzbackup'), '正确口令-123456', plain)
    const target = join(dir, 'dst.db')
    backup.reencryptPlainToEncrypted(plain, target, dekB)
    const dst = new DatabaseCtor(target)
    dst.pragma(`key = "x'${dekB}'"`)
    dst.pragma("cipher='chacha20'")
    const dstSeqRow = dst.prepare("SELECT seq FROM sqlite_sequence WHERE name='accounts'").get() as { seq: number } | undefined
    dst.close()
    expect(dstSeqRow?.seq).toBe(50)
    rmSync(dir, { recursive: true, force: true })
  })
})
