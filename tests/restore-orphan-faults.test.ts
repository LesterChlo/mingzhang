import { afterEach, describe, expect, it, vi } from 'vitest'
import Database from 'better-sqlite3-multiple-ciphers'
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { basename, join } from 'node:path'
import { tmpdir } from 'node:os'
import * as backup from '../src/main/domain/backup'
import { openLedger, initSchemaIfEmpty } from '../src/main/db/connection'
import { runMigrations } from '../src/main/db/migrations'
import { seed } from '../src/main/db/seed'
import { schemaSql } from './helpers'

const DEK = 'ae'.repeat(32)
const dirs: string[] = []
afterEach(() => {
  backup.__resetRestoreFileOps()
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true, maxRetries: 3 })
})

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'mz-orphan-faults-'))
  dirs.push(dir)
  const file = join(dir, 'ledger.db')
  const db = new Database(file)
  try {
    db.pragma(`key = "x'${DEK}'"`)
    db.pragma("cipher='chacha20'")
    db.pragma('journal_mode = WAL')
    db.exec(schemaSql())
    runMigrations(db)
    seed(db)
    db.prepare('INSERT INTO settings(key,value,updated_at) VALUES(?,?,?)')
      .run('synthetic-orphan-marker', 'ORIGINAL', '2026-01-01T00:00:00+08:00')
  } finally { db.close() }
  const getSecret = vi.fn(() => DEK)
  const start = (recoveryDek: string | null = DEK, afterRecovery?: () => void): void => {
    backup.recoverInterruptedRestore(file, recoveryDek === null ? undefined : { dekHex: recoveryDek })
    afterRecovery?.()
    const opened = openLedger(file, { get: getSecret, set: () => { throw new Error('never set') } } as never)
    try {
      initSchemaIfEmpty(opened)
      expect(seed(opened)).toEqual({ accounts: 0, categories: 0, settings: 0 })
      expect(opened.prepare('SELECT value FROM settings WHERE key=?').get('synthetic-orphan-marker'))
        .toMatchObject({ value: 'ORIGINAL' })
    } finally { opened.close() }
  }
  return { dir, file, start, getSecret }
}

function writeOrphan(file: string, suffix = '.restore-candidate-123-456'): string {
  const path = file + suffix
  writeFileSync(path, `SYNTHETIC-EVIDENCE:${suffix}`)
  return path
}

function evidence(dir: string, file: string): string[] {
  return readdirSync(dir)
    .filter((name) => name.startsWith(`.${basename(file)}.restore-quarantine-`))
    .map((name) => join(dir, name))
}

describe('孤儿恢复故障矩阵（真实文件 + 生产 recover→open→init→seed）', () => {
  it('候选/sidecar/临时日志全部 rename 留证，合法回滚槽与残留清单不变，二次启动幂等', () => {
    const f = fixture()
    const originals = [
      writeOrphan(f.file),
      writeOrphan(f.file, '.restore-candidate-123-456-wal'),
      writeOrphan(f.file, '.restore-candidate-123-456-shm'),
      writeOrphan(f.file, '.restore-journal.json.tmp-123-456'),
    ]
    const bytes = originals.map((path) => readFileSync(path))
    const rollback = f.file + '.restore-rollback'
    writeFileSync(rollback, readFileSync(f.file))
    const residues = f.file + '.restore-residues.json'
    writeFileSync(residues, '[{"synthetic":"previous-residue"}]')
    const kept = [f.file, rollback, residues].map((path) => readFileSync(path))
    const realRename = backup.restoreFileOps.renameSync
    const renamed: Array<[string, string]> = []
    const realRm = backup.restoreFileOps.rmSync
    backup.__setRestoreFileOps({
      rmSync: (path, opts) => {
        if ([f.file, rollback, residues, ...originals].includes(path)) throw new Error('must preserve evidence by rename, not delete')
        realRm(path, opts)
      },
      renameSync: (from, to) => { realRename(from, to); renamed.push([from, to]) },
    })

    f.start(DEK, () => {
      for (const [i, path] of [f.file, rollback, residues].entries()) expect(readFileSync(path)).toEqual(kept[i])
    })
    expect(renamed.map(([from]) => from).sort()).toEqual([...originals].sort())
    expect(evidence(f.dir, f.file)).toHaveLength(originals.length)
    for (let i = 0; i < originals.length; i += 1) {
      expect(existsSync(originals[i])).toBe(false)
      const moved = renamed.find(([from]) => from === originals[i])![1]
      expect(basename(moved)).toContain(basename(originals[i]))
      expect(readFileSync(moved)).toEqual(bytes[i])
    }
    for (const [i, path] of [rollback, residues].entries()) expect(readFileSync(path)).toEqual(kept[i + 1])
    expect(backup.listPendingRestoreArtifacts(f.file)).toEqual([])
    const after = readdirSync(f.dir).sort()
    f.start()
    expect(readdirSync(f.dir).sort()).toEqual(after)
    expect(renamed).toHaveLength(originals.length)
  })

  it.each([1, 2])('第 %s 次隔离 rename 遇 EBUSY：拒绝启动且每份证据仍有一处，解锁后收敛', (failAt) => {
    const f = fixture()
    const originals = [writeOrphan(f.file), writeOrphan(f.file, '.restore-journal.json.tmp-123-456')]
    const bytes = originals.map((path) => readFileSync(path))
    const before = readFileSync(f.file)
    const realRename = backup.restoreFileOps.renameSync
    let calls = 0
    backup.__setRestoreFileOps({ renameSync: (from, to) => {
      calls += 1
      if (calls === failAt) throw Object.assign(new Error('SYNTHETIC-EBUSY'), { code: 'EBUSY' })
      realRename(from, to)
    } })
    expect(() => f.start()).toThrow(/EBUSY/)
    expect(f.getSecret).not.toHaveBeenCalled()
    expect(readFileSync(f.file)).toEqual(before)
    const preserved = [...originals.filter(existsSync), ...evidence(f.dir, f.file)]
    expect(preserved).toHaveLength(originals.length)
    for (const blob of bytes) expect(preserved.filter((path) => readFileSync(path).equals(blob))).toHaveLength(1)
    backup.__resetRestoreFileOps()
    f.start()
    expect(evidence(f.dir, f.file)).toHaveLength(originals.length)
    expect(backup.listPendingRestoreArtifacts(f.file)).toEqual([])
  })

  it.each([null, 'ff'.repeat(32), 'not-a-dek'])('缺失/错误/格式错误的目标 DEK %s：不消费任何孤儿工件', (dek) => {
    const f = fixture()
    const artifact = writeOrphan(f.file)
    const before = readFileSync(f.file)
    const bytes = readFileSync(artifact)
    expect(() => f.start(dek)).toThrow()
    expect(f.getSecret).not.toHaveBeenCalled()
    expect(readFileSync(f.file)).toEqual(before)
    expect(readFileSync(artifact)).toEqual(bytes)
    expect(evidence(f.dir, f.file)).toEqual([])
  })

  it.each(['missing', 'empty', 'corrupt', 'schema'] as const)('目标 %s：不造空库，不移走候选', (state) => {
    const f = fixture()
    if (state === 'missing') rmSync(f.file)
    if (state === 'empty') writeFileSync(f.file, Buffer.alloc(0))
    if (state === 'corrupt') writeFileSync(f.file, 'SYNTHETIC-CORRUPT-LEDGER')
    if (state === 'schema') {
      const db = new Database(f.file)
      try {
        db.pragma(`key = "x'${DEK}'"`); db.pragma("cipher='chacha20'")
        // 这里只隔离 schema 缺索引变量；WAL 只读连接可新建 shm/wal，不等于消费恢复证据。
        db.pragma('journal_mode = DELETE')
        db.exec('DROP INDEX idx_txn_state')
      } finally { db.close() }
    }
    const artifact = writeOrphan(f.file)
    const before = existsSync(f.file) ? readFileSync(f.file) : null
    const names = readdirSync(f.dir).sort()
    expect(() => f.start()).toThrow()
    expect(f.getSecret).not.toHaveBeenCalled()
    expect(readdirSync(f.dir).sort()).toEqual(names)
    if (before) expect(readFileSync(f.file)).toEqual(before)
    else expect(existsSync(f.file)).toBe(false)
    expect(readFileSync(artifact, 'utf8')).toContain('SYNTHETIC-EVIDENCE:')
  })

  it.each([
    '.restore-forward', '.restore-forward-wal', '.restore-unknown',
    '.restore-candidate-bad.name', '.restore-journal.json.tmp-bad', '.restore-rollback-unknown',
  ])('未知冲突 %s 与合法孤儿共存：全部先拒绝，不部分清理', (suffix) => {
    const f = fixture()
    const orphan = writeOrphan(f.file)
    const unknown = writeOrphan(f.file, suffix)
    const before = [f.file, orphan, unknown].map((path) => readFileSync(path))
    expect(() => f.start()).toThrow(/未知|恢复/)
    expect(f.getSecret).not.toHaveBeenCalled()
    for (const [i, path] of [f.file, orphan, unknown].entries()) expect(readFileSync(path)).toEqual(before[i])
    expect(evidence(f.dir, f.file)).toEqual([])
  })

  it('正式 journal 损坏且两类孤儿共存：正式与临时日志均不吞掉', () => {
    const f = fixture()
    const paths = [f.file, writeOrphan(f.file), writeOrphan(f.file, '.restore-journal.json.tmp-123')]
    paths.push(writeOrphan(f.file, '.restore-journal.json'))
    const bytes = paths.map((path) => readFileSync(path))
    expect(() => f.start()).toThrow(/日志损坏/)
    expect(f.getSecret).not.toHaveBeenCalled()
    for (const [i, path] of paths.entries()) expect(readFileSync(path)).toEqual(bytes[i])
    expect(evidence(f.dir, f.file)).toEqual([])
  })

  it.each(['candidate', 'journal-tmp', 'target'] as const)('路径 %s 是目录：预检拒绝且不移动其它普通孤儿', (kind) => {
    const f = fixture()
    const orphan = writeOrphan(f.file)
    const bad = kind === 'target' ? f.file : f.file + (kind === 'candidate' ? '.restore-candidate-directory' : '.restore-journal.json.tmp-456')
    if (kind === 'target') rmSync(f.file)
    mkdirSync(bad)
    expect(() => f.start()).toThrow()
    expect(f.getSecret).not.toHaveBeenCalled()
    expect(lstatSync(bad).isDirectory()).toBe(true)
    expect(existsSync(orphan)).toBe(true)
    expect(evidence(f.dir, f.file)).toEqual([])
  })

  it.each(['lstat', 'realpath', 'readdir'] as const)('预检 %s seam 故障：fail closed，保持所有原始字节', (stage) => {
    const f = fixture()
    const artifact = writeOrphan(f.file)
    const bytes = [f.file, artifact].map((path) => readFileSync(path))
    const fail = () => { throw new Error('SYNTHETIC-PRECHECK-FAULT') }
    if (stage === 'lstat') backup.__setRestoreFileOps({ lstatSync: fail })
    if (stage === 'realpath') backup.__setRestoreFileOps({ realpathSync: fail })
    if (stage === 'readdir') backup.__setRestoreFileOps({ readdirSync: fail })
    expect(() => f.start()).toThrow(/SYNTHETIC-PRECHECK-FAULT/)
    expect(f.getSecret).not.toHaveBeenCalled()
    for (const [i, path] of [f.file, artifact].entries()) expect(readFileSync(path)).toEqual(bytes[i])
    expect(evidence(f.dir, f.file)).toEqual([])
  })

  it.each([true, false])('正式 replacing journal + forward 未知，目标存在=%s：整套磁盘证据原样保留', (targetPresent) => {
    const f = fixture()
    const candidate = writeOrphan(f.file)
    const rollback = f.file + '.restore-rollback'
    writeFileSync(rollback, readFileSync(f.file))
    const forward = writeOrphan(f.file, '.restore-forward')
    const journal = f.file + '.restore-journal.json'
    writeFileSync(journal, JSON.stringify({ phase: 'replacing', target: f.file, candidate, rollback, forward,
      createdAt: '2026-01-01T00:00:00Z', pid: 123 }))
    if (!targetPresent) rmSync(f.file)
    const paths = readdirSync(f.dir).map((name) => join(f.dir, name))
    const bytes = paths.map((path) => readFileSync(path))
    expect(() => f.start()).toThrow(/forward|前向|收敛/)
    expect(f.getSecret).not.toHaveBeenCalled()
    expect(readdirSync(f.dir).sort()).toEqual(paths.map((path) => basename(path)).sort())
    for (const [i, path] of paths.entries()) expect(readFileSync(path)).toEqual(bytes[i])
    expect(existsSync(f.file)).toBe(targetPresent)
  })

  it('隔离成功后目标意外丢失：点前缀证据仍阻止首次启动造空库', () => {
    const f = fixture()
    writeOrphan(f.file)
    f.start()
    const kept = evidence(f.dir, f.file)
    expect(kept).toHaveLength(1)
    const bytes = readFileSync(kept[0])
    rmSync(f.file)
    f.getSecret.mockClear()
    expect(() => f.start()).toThrow(/恢复|证据|缺失/)
    expect(() => openLedger(f.file, { get: f.getSecret, set: () => { throw new Error('never set') } } as never)).toThrow(/恢复/)
    expect(f.getSecret).not.toHaveBeenCalled()
    expect(existsSync(f.file)).toBe(false)
    expect(readFileSync(kept[0])).toEqual(bytes)
  })

  it.each(['candidate', 'journal-tmp', 'target'] as const)('真实目录链接 %s：拒绝解析到目录外，不触碰链接目标', (kind) => {
    const f = fixture()
    const outside = mkdtempSync(join(tmpdir(), 'mz-orphan-outside-'))
    dirs.push(outside)
    const sentinel = join(outside, 'sentinel')
    writeFileSync(sentinel, 'SYNTHETIC-OUTSIDE-PRESERVED')
    const path = kind === 'target' ? f.file : f.file + (kind === 'candidate' ? '.restore-candidate-link' : '.restore-journal.json.tmp-789')
    if (kind === 'target') rmSync(f.file)
    symlinkSync(outside, path, process.platform === 'win32' ? 'junction' : 'dir')
    try {
      expect(() => f.start()).toThrow(/链接|普通|越界/)
      expect(f.getSecret).not.toHaveBeenCalled()
      expect(lstatSync(path).isSymbolicLink()).toBe(true)
      expect(readFileSync(sentinel, 'utf8')).toBe('SYNTHETIC-OUTSIDE-PRESERVED')
      expect(evidence(f.dir, f.file)).toEqual([])
    } finally { rmSync(path) } // 只拆本测试自建链接，绝不递归走入链接目标。
  })

  it.each(['candidate', 'journal-tmp', 'target'] as const)('悬空链接 %s seam：exists=false 仍必须 lstat 并拒绝', (kind) => {
    const f = fixture()
    const artifact = writeOrphan(f.file, kind === 'journal-tmp' ? '.restore-journal.json.tmp-123' : '.restore-candidate-dangling')
    const path = kind === 'target' ? f.file : artifact
    const realExists = backup.restoreFileOps.existsSync
    const realLstat = backup.restoreFileOps.lstatSync
    const checked: string[] = []
    backup.__setRestoreFileOps({
      existsSync: (p) => p === path ? false : realExists(p),
      lstatSync: (p) => {
        checked.push(p)
        const st = realLstat(p)
        if (p === path) st.isSymbolicLink = () => true
        return st
      },
    })
    const bytes = [f.file, artifact].map((p) => readFileSync(p))
    expect(() => f.start()).toThrow(/链接|普通|缺失/)
    expect(checked).toContain(path)
    expect(f.getSecret).not.toHaveBeenCalled()
    for (const [i, p] of [f.file, artifact].entries()) expect(readFileSync(p)).toEqual(bytes[i])
  })

  it('预检后目标消失：fileMustExist 不造库，候选原样留存', () => {
    const f = fixture()
    const artifact = writeOrphan(f.file)
    const realPath = backup.restoreFileOps.realpathSync
    backup.__setRestoreFileOps({ realpathSync: (p) => {
      const result = realPath(p)
      if (p === f.file) rmSync(f.file)
      return result
    } })
    expect(() => f.start()).toThrow()
    expect(f.getSecret).not.toHaveBeenCalled()
    expect(existsSync(f.file)).toBe(false)
    expect(existsSync(artifact)).toBe(true)
    expect(evidence(f.dir, f.file)).toEqual([])
  })

  it('预检解析目标越界 seam：在解密前拒绝，不移动孤儿工件', () => {
    const f = fixture()
    const artifact = writeOrphan(f.file)
    const realPath = backup.restoreFileOps.realpathSync
    backup.__setRestoreFileOps({ realpathSync: (p) => p === artifact ? join(f.dir, 'outside', basename(artifact)) : realPath(p) })
    expect(() => f.start()).toThrow(/越界/)
    expect(f.getSecret).not.toHaveBeenCalled()
    expect(existsSync(artifact)).toBe(true)
    expect(evidence(f.dir, f.file)).toEqual([])
  })

  it.each(['-wal', '-shm', '-journal'])('目标附属文件 %s 非普通文件：必须在 SQLite 前做 lstat 严边界', (suffix) => {
    const f = fixture()
    const artifact = writeOrphan(f.file)
    const sidecar = f.file + suffix
    writeFileSync(sidecar, 'SYNTHETIC-SIDECAR-EVIDENCE')
    const before = [f.file, artifact, sidecar].map((path) => readFileSync(path))
    const realLstat = backup.restoreFileOps.lstatSync
    const checked: string[] = []
    backup.__setRestoreFileOps({ lstatSync: (path) => {
      checked.push(path)
      const st = realLstat(path)
      if (path === sidecar) st.isSymbolicLink = () => true
      return st
    } })
    expect(() => f.start()).toThrow(/链接|普通/)
    expect(checked).toContain(sidecar)
    expect(f.getSecret).not.toHaveBeenCalled()
    for (const [i, path] of [f.file, artifact, sidecar].entries()) expect(readFileSync(path)).toEqual(before[i])
    expect(evidence(f.dir, f.file)).toEqual([])
  })

  it('正式 journal 候选字段指向目标本身：视为损坏日志，在任何清理前拒绝', () => {
    const f = fixture()
    const candidate = writeOrphan(f.file)
    const journal = f.file + '.restore-journal.json'
    writeFileSync(journal, JSON.stringify({ phase: 'replacing', target: f.file, candidate: f.file,
      rollback: f.file + '.restore-rollback', forward: f.file + '.restore-forward',
      createdAt: '2026-01-01T00:00:00Z', pid: 123 }))
    const paths = [f.file, candidate, journal]
    const bytes = paths.map((path) => readFileSync(path))
    expect(() => f.start()).toThrow(/日志损坏/)
    expect(f.getSecret).not.toHaveBeenCalled()
    for (const [i, path] of paths.entries()) expect(readFileSync(path)).toEqual(bytes[i])
  })

  it.each(['exists', 'lstat'] as const)('隔离证据目标碰撞 %s seam：拒绝覆盖，源工件原样保留', (kind) => {
    const f = fixture()
    const artifact = writeOrphan(f.file)
    const before = [f.file, artifact].map((path) => readFileSync(path))
    const realExists = backup.restoreFileOps.existsSync
    const realLstat = backup.restoreFileOps.lstatSync
    if (kind === 'exists') backup.__setRestoreFileOps({ existsSync: (path) => basename(path).startsWith('.ledger.db.restore-quarantine-') || realExists(path) })
    if (kind === 'lstat') backup.__setRestoreFileOps({ lstatSync: (path) => basename(path).startsWith('.ledger.db.restore-quarantine-') ? realLstat(artifact) : realLstat(path) })
    const rename = vi.fn()
    backup.__setRestoreFileOps({ renameSync: rename })
    expect(() => f.start()).toThrow(/覆盖/)
    expect(rename).not.toHaveBeenCalled()
    expect(f.getSecret).not.toHaveBeenCalled()
    for (const [i, path] of [f.file, artifact].entries()) expect(readFileSync(path)).toEqual(before[i])
  })

  it('目标 WAL 中 schema 漂移：验证拒绝且原始 main/wal/shm 证据逐字节不变', () => {
    const f = fixture()
    const db = new Database(f.file)
    let disk: Array<[string, Buffer]>
    try {
      db.pragma(`key = "x'${DEK}'"`); db.pragma("cipher='chacha20'")
      db.pragma('journal_mode = WAL')
      db.pragma('wal_autocheckpoint = 0')
      db.exec('DROP INDEX idx_txn_state')
      disk = ['', '-wal', '-shm'].map((suffix) => [f.file + suffix, readFileSync(f.file + suffix)])
    } finally { db.close() }
    // 合成强杀现场：还原未 checkpoint 的 main/wal/shm，不留活数据库句柄。
    for (const [path, bytes] of disk!) writeFileSync(path, bytes)
    const artifact = writeOrphan(f.file)
    expect(() => f.start()).toThrow(/索引/)
    expect(f.getSecret).not.toHaveBeenCalled()
    for (const [path, bytes] of disk!) expect(readFileSync(path)).toEqual(bytes)
    expect(existsSync(artifact)).toBe(true)
    expect(evidence(f.dir, f.file)).toEqual([])
  })

  it.each(['mkdir', 'copy-main', 'copy-sidecar', 'cleanup'] as const)('自有验证副本 %s seam 失败：不隔离孤儿，不改原始账本证据', (stage) => {
    const f = fixture()
    const artifact = writeOrphan(f.file)
    const sidecar = f.file + '-wal'
    if (stage === 'copy-sidecar') writeFileSync(sidecar, 'SYNTHETIC-WAL-COPY-FAILURE')
    const paths = [f.file, artifact, ...(stage === 'copy-sidecar' ? [sidecar] : [])]
    const bytes = paths.map((path) => readFileSync(path))
    const realCopy = backup.restoreFileOps.copyFileSync
    let stagingDir: string | undefined
    const realMkdir = backup.restoreFileOps.mkdtempSync
    backup.__setRestoreFileOps({ mkdtempSync: (prefix) => {
      if (stage === 'mkdir') throw new Error('SYNTHETIC-STAGING-mkdir')
      stagingDir = realMkdir(prefix)
      return stagingDir
    } })
    if (stage === 'copy-main' || stage === 'copy-sidecar') backup.__setRestoreFileOps({ copyFileSync: (from, to) => {
      if (from === (stage === 'copy-main' ? f.file : sidecar)) throw new Error(`SYNTHETIC-STAGING-${stage}`)
      realCopy(from, to)
    } })
    if (stage === 'cleanup') backup.__setRestoreFileOps({ rmSync: () => { throw new Error('SYNTHETIC-STAGING-cleanup') } })
    try {
      expect(() => f.start()).toThrow(/SYNTHETIC-STAGING/)
      expect(f.getSecret).not.toHaveBeenCalled()
      for (const [i, path] of paths.entries()) expect(readFileSync(path)).toEqual(bytes[i])
      expect(evidence(f.dir, f.file)).toEqual([])
    } finally {
      backup.__resetRestoreFileOps()
      if (stagingDir) rmSync(stagingDir, { recursive: true, force: true })
    }
  })

  it('正式 replacing journal 的 forward 悬空链接 seam：即使 exists=false 也保留候选和日志', () => {
    const f = fixture()
    const candidate = writeOrphan(f.file)
    const forward = writeOrphan(f.file, '.restore-forward')
    const journal = f.file + '.restore-journal.json'
    writeFileSync(journal, JSON.stringify({ phase: 'replacing', target: f.file, candidate,
      rollback: f.file + '.restore-rollback', forward, createdAt: '2026-01-01T00:00:00Z', pid: 123 }))
    const bytes = [f.file, candidate, forward, journal].map((path) => readFileSync(path))
    const realExists = backup.restoreFileOps.existsSync
    const realLstat = backup.restoreFileOps.lstatSync
    backup.__setRestoreFileOps({
      existsSync: (path) => path === forward ? false : realExists(path),
      lstatSync: (path) => {
        const st = realLstat(path)
        if (path === forward) st.isSymbolicLink = () => true
        return st
      },
    })
    expect(() => f.start()).toThrow(/forward|前向/)
    expect(f.getSecret).not.toHaveBeenCalled()
    for (const [i, path] of [f.file, candidate, forward, journal].entries()) expect(readFileSync(path)).toEqual(bytes[i])
  })
})
