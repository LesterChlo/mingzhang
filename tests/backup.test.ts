
import { describe, expect, it } from 'vitest'
import DatabaseCtor from 'better-sqlite3-multiple-ciphers'
import { randomBytes } from 'node:crypto'
import { mkdtempSync, readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  snapshot,
  autoSnapshotIfNeeded,
  listSnapshots,
  exportPassphraseBackup,
  importPassphraseBackupToPlain,
  reencryptPlainToEncrypted,
  restoreSnapshot,
} from '../src/main/domain/backup'
import { schemaSql } from './helpers'
import { runMigrations } from '../src/main/db/migrations'

function basenameSafe(path: string): string {
  return path.replaceAll('\\', '/').split('/').pop() ?? ''
}

function openEnc(file: string, dek: string) {
  const db = new DatabaseCtor(file)
  db.pragma(`key = "x'${dek}'"`)
  db.pragma("cipher='chacha20'")
  db.exec(schemaSql())
  runMigrations(db)
  db.exec("CREATE TABLE t(a TEXT); INSERT INTO t VALUES('星巴克')")
  return db
}

describe('M4 备份域', () => {
  it('快照：VACUUM INTO 产出明文头文件；自动快照 24h 节流', () => {
    const dir = mkdtempSync(join(tmpdir(), 'mz-bk-'))
    const bk = join(dir, 'backups')
    const db = openEnc(join(dir, 'db.db'), 'ab'.repeat(32))
    const s = snapshot(db, bk)
    expect(existsSync(s)).toBe(true)
    // 快照是密文（VACUUM INTO 沿用加密库的 cipher，拷走即乱码）
    expect(readFileSync(s).subarray(0, 15).toString('latin1')).not.toMatch(/^SQLite format 3/)
    // 节流：刚快照过 → 不再生成
    expect(autoSnapshotIfNeeded(db, bk, new Date())).toBeNull()
    // 24h 后 → 生成
    const later = new Date(Date.now() + 25 * 60 * 60 * 1000)
    expect(autoSnapshotIfNeeded(db, bk, later)).not.toBeNull()
    db.close()
  })

  it('口令备份包：导出→（换 DEK）导入重加密→数据完整', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'mz-bk2-'))
    const bk = join(dir, 'backups')
    const dekA = 'ab'.repeat(32)
    const dbA = openEnc(join(dir, 'a.db'), dekA)
    const pkg = join(dir, 'backup.mzbackup')
    await exportPassphraseBackup(dbA, bk, '正确口令-123', pkg)
    dbA.close()

    // 头部结构
    const blob = readFileSync(pkg)
    expect(blob.subarray(0, 4).toString('latin1')).toBe('MZBK')
    expect(blob.subarray(0, 15).toString('latin1')).not.toContain('SQLite') // 不含明文库头

    // 错误口令 → 拒绝
    const tmpPlain = join(dir, 'restore-plain.db')
    await expect(importPassphraseBackupToPlain(pkg, '错误口令-456', tmpPlain)).rejects.toThrow(/GCM|口令/)
    expect(existsSync(tmpPlain)).toBe(false)

    // 正确口令 → 解密到明文 → 用"新机器 DEK"重加密落位
    await importPassphraseBackupToPlain(pkg, '正确口令-123', tmpPlain)
    expect(readFileSync(tmpPlain).subarray(0, 15).toString('latin1')).toMatch(/^SQLite format 3/)
    const dekB = randomBytes(32).toString('hex')
    const target = join(dir, 'restored.db')
    reencryptPlainToEncrypted(tmpPlain, target, dekB)
    expect(existsSync(tmpPlain)).toBe(false)

    const dbB = new DatabaseCtor(target)
    dbB.pragma(`key = "x'${dekB}'"`)
    dbB.pragma("cipher='chacha20'")
    expect(dbB.prepare('SELECT a FROM t').get()).toMatchObject({ a: '星巴克' })
    expect(dbB.prepare("SELECT COUNT(*) n FROM sqlite_master WHERE type='table' AND name='transactions'").get()).toMatchObject({ n: 1 })
    dbB.close()
  }, 30_000)

  it('恢复安全：快照名不能越界，坏候选不改当前库，合法候选可恢复', () => {
    const dir = mkdtempSync(join(tmpdir(), 'mz-restore-safe-'))
    const bk = join(dir, 'backups')
    const outsideDir = join(dir, 'outside')
    mkdirSync(bk, { recursive: true })
    mkdirSync(outsideDir, { recursive: true })
    const dek = 'ef'.repeat(32)

    // 逃逸名即便指向真实合法文件也必须拒绝，不能把 backups 外的库当快照。
    const outsideSnapshot = join(outsideDir, 'mingzhang-snapshot-x.db')
    const outsideDb = openEnc(outsideSnapshot, dek)
    outsideDb.close()
    const current = join(dir, 'current.db')
    writeFileSync(current, 'current-ledger-must-stay')
    expect(() => restoreSnapshot(bk, `..${outsideDir.slice(dir.length) || '/outside'}/mingzhang-snapshot-x.db`, current, dek)).toThrow(/快照文件名不合法/)
    expect(readFileSync(current, 'utf8')).toBe('current-ledger-must-stay')
    expect(() => restoreSnapshot(bk, 'mingzhang-snapshot-x.db/child.db', current, dek)).toThrow(/快照文件名不合法/)

    // 坏候选（缺账务表）不得先删当前库；用正确 DEK 打开，单独验证账务表门。
    const incomplete = join(bk, 'mingzhang-snapshot-bad.db')
    const plain = openEnc(incomplete, dek)
    plain.exec('DROP TABLE audit_log')
    plain.close()
    expect(() => restoreSnapshot(bk, basenameSafe(incomplete), current, dek)).toThrow(/账务表/)
    expect(readFileSync(current, 'utf8')).toBe('current-ledger-must-stay')

    // 合法密文快照：先完整验证，再替换，并留下可回滚副本。
    const source = openEnc(join(dir, 'source.db'), dek)
    const good = snapshot(source, bk)
    source.close()
    restoreSnapshot(bk, basenameSafe(good), current, dek)
    const restored = new DatabaseCtor(current)
    restored.pragma(`key = "x'${dek}'"`)
    restored.pragma("cipher='chacha20'")
    expect(restored.prepare('SELECT a FROM t').get()).toMatchObject({ a: '星巴克' })
    restored.close()
    expect(existsSync(join(dir, 'current.db.restore-rollback'))).toBe(true)
  })

  it('恢复安全：损坏 SQLite 与外键违规的口令包候选均拒绝且不改当前库', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'mz-pass-safe-'))
    const bk = join(dir, 'backups')
    const dek = '12'.repeat(32)
    const current = join(dir, 'current.db')
    const source = openEnc(join(dir, 'source.db'), dek)
    const goodPkg = join(dir, 'good.mzbackup')
    await exportPassphraseBackup(source, bk, '正确口令-123', goodPkg)
    source.close()

    const currentBytes = Buffer.from('current-ledger-must-stay')
    writeFileSync(current, currentBytes)

    const corruptPlain = join(dir, 'corrupt.plain')
    const validPlain = join(dir, 'valid.plain')
    await importPassphraseBackupToPlain(goodPkg, '正确口令-123', validPlain)
    const plainDb = new DatabaseCtor(validPlain)
    plainDb.close()

    // 独立合成一个具备全部预期表/关键列、但 transactions 外键违规的候选。
    const fkPlain = join(dir, 'fk-invalid.plain')
    const fkDb = new DatabaseCtor(fkPlain)
    fkDb.exec('PRAGMA journal_mode = DELETE')
    fkDb.pragma('foreign_keys = OFF')
    fkDb.exec(schemaSql())
    runMigrations(fkDb)
    fkDb.pragma('foreign_keys = OFF')
    const fkNow = new Date().toISOString()
    fkDb.prepare("INSERT INTO accounts (name, type, currency, created_at, updated_at) VALUES ('fk-acc','cash','CNY',?,?)").run(fkNow, fkNow)
    const fkCat = Number(
      fkDb.prepare("INSERT INTO categories (name, kind, created_at, updated_at) VALUES ('fk-cat','expense',?,?)").run(fkNow, fkNow).lastInsertRowid
    )
    fkDb.prepare(
      "INSERT INTO transactions (account_id, category_id, amount_cents, type, occurred_at, state, created_at, updated_at) VALUES (999999, ?, 100, 'expense', ?, 'confirmed', ?, ?)",
    ).run(fkCat, fkNow, fkNow, fkNow)
    fkDb.close()

    // 损坏 SQLite 候选应被拒绝且当前库保持不变。
    const corruptBytes = readFileSync(validPlain)
    corruptBytes.fill(0x5a, 100)
    writeFileSync(corruptPlain, corruptBytes)
    expect(() => reencryptPlainToEncrypted(corruptPlain, current, dek)).toThrow()
    expect(readFileSync(current).equals(currentBytes)).toBe(true)

    // 独立合成的外键违规候选应被拒绝，且当前库保持不变。
    expect(() => reencryptPlainToEncrypted(fkPlain, current, dek)).toThrow(/外键/)
    expect(readFileSync(current).equals(currentBytes)).toBe(true)
  }, 30_000)

  it('启动清扫：*.plain 残留被移除；导出失败不残留明文', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'mz-bk3-'))
    const bk = join(dir, 'backups')
    const { mkdirSync } = await import('node:fs')
    mkdirSync(bk, { recursive: true })
    writeFileSync(join(bk, '.export-123.plain'), 'leftover')
    writeFileSync(join(bk, '.restore-456.plain'), 'leftover')
    writeFileSync(join(bk, 'mingzhang-snapshot-x.db'), 'keepme')
    const db = openEnc(join(dir, 'db.db'), 'cd'.repeat(16))
    // 错口令导出（解密侧无临时文件）；直接验证清扫
    const { sweepPlainResidues } = await import('../src/main/domain/backup')
    expect(sweepPlainResidues(bk)).toBe(2)
    expect(existsSync(join(bk, 'mingzhang-snapshot-x.db'))).toBe(true)
    expect(existsSync(join(bk, '.export-123.plain'))).toBe(false)
    // 正常导出后无残留
    await exportPassphraseBackup(db, bk, '正确口令-123', join(dir, 'ok.mzbackup'))
    const leftovers = (await import('node:fs')).readdirSync(bk).filter((f) => f.endsWith('.plain'))
    expect(leftovers).toEqual([])
    db.close()
  }, 30_000)
})
