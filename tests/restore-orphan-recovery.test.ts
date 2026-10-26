import { describe, it, expect } from 'vitest'
import { mkdtempSync, writeFileSync, readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import Database from 'better-sqlite3-multiple-ciphers'
import { schemaSql } from './helpers'
import { runMigrations } from '../src/main/db/migrations'
import { recoverInterruptedRestore } from '../src/main/domain/backup'
import { openLedger, initSchemaIfEmpty } from '../src/main/db/connection'
import { seed } from '../src/main/db/seed'

const DEK = 'ac'.repeat(32)
function make(file: string) {
  const db = new Database(file)
  db.pragma(`key = "x'${DEK}'"`)
  db.pragma("cipher='chacha20'")
  db.exec(schemaSql()); runMigrations(db); seed(db)
  db.prepare('INSERT INTO settings(key,value,updated_at) VALUES(?,?,?)').run('synthetic-preserve','original','2026-01-01T00:00:00+08:00')
  db.close()
}
function businessState(db: InstanceType<typeof Database>) {
  const names = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name <> 'sqlite_sequence' ORDER BY name").all() as {name:string}[]
  return names.map(({name}) => [name, db.prepare(`SELECT * FROM "${name.replace(/"/g,'""')}" ORDER BY rowid`).all()])
}
function startup(file: string, expectedBytes?: Buffer) {
  recoverInterruptedRestore(file, {dekHex: DEK})
  // 恢复阶段必须保持活库字节；openLedger 的 WAL 切换与 seed 的序列
  // 高水位推进属既有后续启动写入，不用它们伪造“恢复修改了账目”。
  if (expectedBytes) expect(readFileSync(file)).toEqual(expectedBytes)
  const db = openLedger(file, {get:()=>DEK, has:()=>true, set:()=>{throw new Error('never set')}} as never)
  try {
    const before = businessState(db)
    initSchemaIfEmpty(db); seed(db)
    expect(businessState(db)).toEqual(before)
    expect((db.prepare('SELECT value FROM settings WHERE key=?').get('synthetic-preserve') as {value:string}).value).toBe('original')
  } finally { db.close() }
}

describe('中断恢复孤儿工件收敛（生产启动链）', () => {
  it('有效目标 + 孤儿未提交候选，不再每次重启无进展', () => {
    const dir=mkdtempSync(join(tmpdir(),'mz-orphan-candidate-')); const file=join(dir,'ledger.db')
    make(file)
    const before=readFileSync(file)
    const artifact=file+'.restore-candidate-123-456'
    writeFileSync(artifact, Buffer.from('SYNTHETIC-UNCOMMITTED-CANDIDATE'))
    startup(file, before)
    expect(existsSync(artifact)).toBe(false)
    startup(file)
  })

  it('有效目标 + 未提交 journal 临时文件，可安全收敛并保留账目', () => {
    const dir=mkdtempSync(join(tmpdir(),'mz-orphan-tmp-')); const file=join(dir,'ledger.db')
    make(file)
    const before=readFileSync(file)
    const artifact=file+'.restore-journal.json.tmp-123'
    writeFileSync(artifact, '{"synthetic":"interrupted-write"')
    startup(file, before)
    expect(existsSync(artifact)).toBe(false)
    startup(file)
  })

  it('没有有效目标时拒绝自动消费孤儿候选，不建空库', () => {
    const dir=mkdtempSync(join(tmpdir(),'mz-orphan-missing-')); const file=join(dir,'ledger.db')
    const artifact=file+'.restore-candidate-123-456'
    const bytes=Buffer.from('SYNTHETIC-ONLY-CANDIDATE')
    writeFileSync(artifact,bytes)
    expect(()=>startup(file)).toThrow()
    expect(existsSync(file)).toBe(false)
    expect(readFileSync(artifact)).toEqual(bytes)
  })

  it('正式 journal 损坏时不当成孤儿临时日志吞掉', () => {
    const dir=mkdtempSync(join(tmpdir(),'mz-orphan-badjournal-')); const file=join(dir,'ledger.db')
    make(file)
    const before=readFileSync(file)
    const journal=file+'.restore-journal.json'
    writeFileSync(journal,'SYNTHETIC-BROKEN-JOURNAL')
    expect(()=>startup(file)).toThrow(/日志损坏/)
    expect(readFileSync(file)).toEqual(before)
    expect(readFileSync(journal,'utf8')).toBe('SYNTHETIC-BROKEN-JOURNAL')
  })
})
