// Real temporary DB/files adversarial contract: no hardcoded temp path, no assertion weakening.
import { afterEach, expect, it, vi } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, readdirSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openSchemaDb } from './helpers'
import { seed } from '../src/main/db/seed'
import { createImport, createTransaction, getSetting, setSetting, updateFields } from '../src/main/domain/ledger'
import * as attachments from '../src/main/domain/transaction-attachments'
import * as attachmentFiles from '../src/main/attachment-files'
import { snapshot } from '../src/main/domain/backup'
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGNoCtD9DwAEVgH/dFWU5AAAAABJRU5ErkJggg==', 'base64')
const png2 = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGNwq9jyHwAE7AJy5WV9CAAAAABJRU5ErkJggg==', 'base64')
const dbs: ReturnType<typeof openSchemaDb>[] = []
afterEach(() => { for (const db of dbs.splice(0)) db.close(); vi.restoreAllMocks() })
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'mz-attachment-boundary-')), dir = join(root, 'attachments'); mkdirSync(dir)
  const db = openSchemaDb(join(root, 'synthetic.db')); seed(db); dbs.push(db)
  const tx = createTransaction(db, { amountCents: 123, txType: 'expense', sourceMessageId: 'synthetic-boundary' })
  const context = { attachmentsDir: dir, validateImage: vi.fn(() => true) }
  const list = () => attachments.getTransactionAttachments(db, tx, dir)
  const add = (files: unknown[], expectedVersion = list().version) => attachments.addTransactionAttachments(db, { txId: tx, files, expectedVersion } as never, context)
  const remove = (ref: string, expectedVersion = list().version) => attachments.removeTransactionAttachment(db, { txId: tx, expectedVersion, ref }, context)
  return { db, dir, tx, root, context, list, add, remove }
}
const file = (bytes = png, name = 'synthetic.png') => ({ fileName: name, mediaType: 'image/png', dataBase64: bytes.toString('base64') })
const state = (db: ReturnType<typeof openSchemaDb>) => Object.fromEntries(['transactions','imports','audit_log','pending_clarifications','settings','accounts','categories','rules','sqlite_sequence'].map(t => [t, db.prepare('SELECT * FROM ' + t + ' ORDER BY rowid').all()]))

it('所有shape/ID/version/每图类型检查在任何数据库与文件IO前完成', () => {
  const touched = vi.fn(() => { throw Error('DATABASE-IO-MUST-NOT-RUN') })
  const db = { prepare: touched, transaction: touched } as never
  const ctx = { attachmentsDir: 'synthetic-no-io', validateImage: vi.fn(() => true) }
  for (const input of [
    null, {}, { txId: '1', expectedVersion: 'v', files: [file()] }, { txId: 1.2, expectedVersion: 'v', files: [file()] },
    { txId: 1, expectedVersion: '', files: [file()] }, { txId: 1, expectedVersion: 'v', files: [file()], unknown: true },
    { txId: 1, expectedVersion: 'v', files: [{...file(), unknown: true}] },
    { txId: 1, expectedVersion: 'v', files: [{...file(), fileName: ''}] },
    { txId: 1, expectedVersion: 'v', files: [{...file(), mediaType: 'image/svg+xml'}] },
    { txId: 1, expectedVersion: 'v', files: [{...file(), dataBase64: 'not@@base64'}] },
  ]) { expect(() => attachments.addTransactionAttachments(db, input as never, ctx)).toThrow(); expect(touched).not.toHaveBeenCalled() }
})

it('稀疏files也必须按坏元素拒绝，不能用空槽绕过runtime exactshape', () => {
  const touched = vi.fn(() => { throw Error('DATABASE-IO-MUST-NOT-RUN') })
  const db = { prepare: touched, transaction: touched } as never
  expect(() => attachments.addTransactionAttachments(db, { txId: 1, expectedVersion: 'v', files: new Array(1) } as never, { attachmentsDir: 'synthetic-no-io', validateImage: () => true })).toThrow()
  expect(touched).not.toHaveBeenCalled()
})

it('query_only列表零写；version绑定tx状态/来源/payload而非mtime，stale不调用decoder不写文件', () => {
  const f = fixture(), original = state(f.db), emptyVersion = f.list().version
  f.db.pragma('query_only=ON'); expect(f.list().items).toEqual([]); f.db.pragma('query_only=OFF'); expect(state(f.db)).toEqual(original)
  updateFields(f.db, f.tx, { merchant: '合成新商户' }); const changed = state(f.db)
  expect(f.list().version).not.toBe(emptyVersion)
  expect(() => f.add([file()], emptyVersion)).toThrow(/过期/); expect(f.context.validateImage).not.toHaveBeenCalled()
  expect(state(f.db)).toEqual(changed); expect(readdirSync(f.dir)).toEqual([])
  const v = f.list().version
  createImport(f.db, { sourceType: 'screenshot', sourceMessageId: 'synthetic-boundary', sourceRef: 'missing.png' })
  expect(f.list().version).not.toBe(v)
  const v2 = f.list().version
  setSetting(f.db, 'source.attachments:synthetic-boundary', JSON.stringify({version:1,refs:['source.png']}), {audit:false})
  expect(f.list().version).not.toBe(v2)
})

it('任一坏图整组拒绝、严格base64 padding/大小/magic；上限12张/10MiB/40MiB都可达到而不得超过', () => {
  const f = fixture(), before = state(f.db)
  for (const bad of [file(Buffer.from('not-image')), {...file(),dataBase64:'Zg==='}, {...file(),dataBase64:'Zh=='}, {...file(),dataBase64:png.toString('base64')+'\n'}, {...file(),mediaType:'image/jpeg'}]) {
    expect(() => f.add([file(),bad])).toThrow(); expect(state(f.db)).toEqual(before); expect(readdirSync(f.dir)).toEqual([])
  }
  f.context.validateImage.mockClear()
  const tooLarge = Buffer.alloc(10_485_761); png.copy(tooLarge)
  expect(() => f.add([file(tooLarge)])).toThrow(); expect(f.context.validateImage).not.toHaveBeenCalled()
  const big = (suffix: number) => { const b = Buffer.alloc(10_485_760); png.copy(b); b[b.length-1] = suffix; return b }
  const four = f.add([1,2,3,4].map(n => file(big(n))))
  expect(four.items).toHaveLength(4); expect(four.items.reduce((n,r) => n+r.byteLength,0)).toBe(41_943_040)
  expect(() => f.add([file(png2)])).toThrow(/限制/)
  const g = fixture()
  const twelve = g.add(Array.from({length:12},(_,i)=>{const b=Buffer.concat([png,Buffer.from([i])]);return file(b)}))
  expect(twelve.items).toHaveLength(12); expect(() => g.add([file(png2)])).toThrow(/限制/)
})

it('fileName仅display清洗，同名不覆盖原件；内容dedup不刷新version/audit/目录', () => {
  const f = fixture(); writeFileSync(join(f.dir,'same.png'),png2)
  const added=f.add([file(png,'C:\\synthetic\\same.png'),file(png2,'same.png')]); expect(added.items).toHaveLength(2)
  expect(added.items.every(r=>/^[a-f0-9-]{36}\.png$/.test(r.ref))).toBe(true)
  expect(added.items.map(r=>r.fileName)).toEqual(['same.png','same.png']); expect(readFileSync(join(f.dir,'same.png'))).toEqual(png2)
  const before=state(f.db), names=readdirSync(f.dir)
  expect(f.add([file(png,'different.png')]).version).toBe(added.version); expect(state(f.db)).toEqual(before); expect(readdirSync(f.dir)).toEqual(names)
})

it('长展示文件名截断后仍规范，不得提交随后读不回的坏metadata', () => {
  const f = fixture()
  const result = f.add([file(png, 'x'.repeat(179) + '.suffix.png')])
  expect(result.items[0].fileName).toBe('x'.repeat(179))
  expect(f.list().items).toEqual(result.items)
})

it('第二个文件写入故障只回收本次UUID，原图/共享文件与全库sequence不变，可原版本重试', () => {
  const f = fixture(); writeFileSync(join(f.dir, 'retained.png'), png)
  const before = state(f.db), version = f.list().version, names = readdirSync(f.dir)
  const original = attachmentFiles.writeNewAttachment
  vi.spyOn(attachmentFiles, 'writeNewAttachment').mockImplementationOnce(original).mockImplementationOnce(() => { throw Error('SYNTHETIC-FILE-WRITE') })
  expect(() => f.add([file(png), file(png2)], version)).toThrow(/SYNTHETIC-FILE-WRITE/)
  expect(state(f.db)).toEqual(before); expect(readdirSync(f.dir)).toEqual(names); expect(readFileSync(join(f.dir, 'retained.png'))).toEqual(png)
  vi.restoreAllMocks(); expect(f.add([file(png), file(png2)], version).items).toHaveLength(2)
})

it('真实数据库快照保存多附件权威与空覆盖，但另目录没有图片应诚实available=false', () => {
  const f = fixture(), added = f.add([file(png), file(png2)])
  const imageMissingDir = join(f.root, 'synthetic-other-attachments'); mkdirSync(imageMissingDir)
  const copy = snapshot(f.db, join(f.root, 'synthetic-backups')), db = openSchemaDb(copy); dbs.push(db)
  expect(attachments.getTransactionAttachments(db, f.tx, imageMissingDir).items.map(r => r.ref)).toEqual(added.items.map(r => r.ref))
  expect(attachments.getTransactionAttachments(db, f.tx, imageMissingDir).items.every(r => !r.available)).toBe(true)
  f.remove(added.items[0].ref); f.remove(added.items[1].ref)
  const emptyCopy = snapshot(f.db, join(f.root, 'synthetic-backups')), emptyDb = openSchemaDb(emptyCopy); dbs.push(emptyDb)
  expect(attachments.getTransactionAttachments(emptyDb, f.tx, f.dir).items).toEqual([])
})

it('坏权威payload不能当空表重写或恢复旧来源；unsafe ref不能被读', () => {
  const f=fixture(); createImport(f.db,{sourceType:'screenshot',sourceMessageId:'synthetic-boundary',sourceRef:'legacy.png'})
  for(const raw of ['broken','null',JSON.stringify({version:2,items:[]}),JSON.stringify({version:1,items:[{ref:'../outside.png',fileName:'outside.png',mediaType:'image/png',byteLength:1}]})]) {
    setSetting(f.db,'tx.attachments:'+f.tx,raw,{audit:false}); const before=state(f.db)
    expect(()=>f.list()).toThrow(); expect(()=>f.add([file()],'stale')).toThrow(); expect(state(f.db)).toEqual(before); expect(getSetting(f.db,'tx.attachments:'+f.tx)).toBe(raw)
  }
})

it('移除审计故障全库回滚/文件保留；显式空覆盖关闭重开仍不复活，另一笔共享不变', () => {
  const f=fixture(); writeFileSync(join(f.dir,'legacy.png'),png)
  createImport(f.db,{sourceType:'screenshot',sourceMessageId:'synthetic-boundary',sourceRef:'legacy.png'})
  const second=createTransaction(f.db,{amountCents:99,txType:'expense',sourceMessageId:'synthetic-boundary'}),version=f.list().version,before=state(f.db)
  f.db.exec("CREATE TRIGGER synthetic_remove_audit_fail BEFORE INSERT ON audit_log WHEN NEW.entity_type='transaction' AND NEW.change_type='update' BEGIN SELECT RAISE(ABORT,'SYNTHETIC-REMOVE'); END")
  expect(()=>f.remove('legacy.png',version)).toThrow(/SYNTHETIC-REMOVE/); expect(state(f.db)).toEqual(before)
  f.db.exec('DROP TRIGGER synthetic_remove_audit_fail'); f.remove('legacy.png',version)
  f.db.close(); dbs.splice(dbs.indexOf(f.db),1)
  const db=openSchemaDb(join(f.root,'synthetic.db'));dbs.push(db)
  expect(attachments.getTransactionAttachments(db,f.tx,f.dir).items).toEqual([])
  expect(attachments.getTransactionAttachments(db,second,f.dir).items.map(r=>r.ref)).toEqual(['legacy.png'])
  expect(readFileSync(join(f.dir,'legacy.png'))).toEqual(png)
  db.prepare("UPDATE transactions SET state='deleted' WHERE id=?").run(second)
  const frozen=state(db),v=attachments.getTransactionAttachments(db,second,f.dir).version
  expect(()=>attachments.removeTransactionAttachment(db,{txId:second,expectedVersion:v,ref:'legacy.png'},f.context)).toThrow(/删除/);expect(state(db)).toEqual(frozen)
})
