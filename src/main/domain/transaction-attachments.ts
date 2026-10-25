// Transaction-scoped attachment authority lives in the existing encrypted settings table.
// Images remain local plaintext files; SQL rollback is not cross-filesystem crash atomicity.
import type { Database } from 'better-sqlite3-multiple-ciphers'
import { createHash } from 'node:crypto'
import { readdirSync } from 'node:fs'
import type { AddTxAttachmentsInput, RemoveTxAttachmentInput, TxAttachmentDTO, TxAttachmentListDTO } from '../../shared/types'
import {
  ATTACHMENT_MAX_FILE_BYTES, IMAGE_EXTENSIONS, attachmentMediaType, cleanAttachmentName,
  imageMagicMatches, isSafeAttachmentRef, readAttachmentBytes, safeAttachmentFile,
  safeAttachmentRoot, unlinkOwnedAttachment, writeNewAttachment, type OwnedAttachmentFile,
} from '../attachment-files'
import { getSetting, setSetting, writeAudit } from './ledger'

export const TX_ATTACHMENT_LIMITS = Object.freeze({ maxCount: 12, maxFileBytes: ATTACHMENT_MAX_FILE_BYTES, maxTotalBytes: 41_943_040 })
export interface TransactionAttachmentContext { attachmentsDir: string; validateImage: (bytes: Buffer, mediaType: string) => boolean }
interface Metadata { ref: string; fileName: string; mediaType: string; byteLength: number; sha256?: string }
interface Authority { version: 1; items: Metadata[] }
type Row = Record<string, unknown>
const txKey = (id: number): string => `tx.attachments:${id}`
const sourceKey = (source: string): string => `source.attachments:${source}`
const hash = (bytes: Buffer | string): string => createHash('sha256').update(bytes).digest('hex')
const identity = (ref: string): string => process.platform === 'win32' ? ref.toLowerCase() : ref
function error(): never { throw new Error('附件引用数据损坏，已停止操作；请检查账本来源') }
function object(value: unknown): value is Row { return !!value && typeof value === 'object' && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype }
function exact(value: unknown, keys: string[]): asserts value is Row {
  if (!object(value) || Object.keys(value).length !== keys.length || keys.some(k => !Object.hasOwn(value, k))) throw new Error('附件参数无效')
}
export function validateAttachmentTxId(id: unknown): asserts id is number {
  if (typeof id !== 'number' || !Number.isSafeInteger(id) || id <= 0) throw new Error('交易编号无效')
}
function versionInput(version: unknown): asserts version is string {
  if (typeof version !== 'string' || !version.trim() || version.length > 200) throw new Error('附件版本缺失或无效，请刷新后重试')
}
function json(raw: string): unknown { try { return JSON.parse(raw) } catch { return error() } }
function refs(value: unknown): string[] {
  if (!Array.isArray(value) || value.length > 10_000 || value.some(v => typeof v !== 'string')) return error()
  return value.filter((v): v is string => isSafeAttachmentRef(v) && attachmentMediaType(v) !== null)
}
function sourceRefs(raw: string): string[] {
  const value = json(raw)
  if (!object(value) || value.version !== 1 || Object.keys(value).length !== 2 || !Object.hasOwn(value, 'refs')) return error()
  // New source bindings are strict; bad refs never become a silently empty replacement.
  const clean = refs(value.refs)
  if (clean.length !== (value.refs as unknown[]).length) return error()
  return clean
}
function authority(raw: string): Authority {
  const value = json(raw)
  if (!object(value) || value.version !== 1 || Object.keys(value).length !== 2 || !Array.isArray(value.items) || value.items.length > 10_000) return error()
  const seen = new Set<string>()
  const items = value.items.map((item: unknown): Metadata => {
    if (!object(item) || Object.keys(item).some(k => !['ref', 'fileName', 'mediaType', 'byteLength', 'sha256'].includes(k)) ||
        !isSafeAttachmentRef(item.ref) || typeof item.fileName !== 'string' || !item.fileName || item.fileName.length > 180 ||
        typeof item.mediaType !== 'string' || !Object.hasOwn(IMAGE_EXTENSIONS, item.mediaType) || attachmentMediaType(item.ref) !== item.mediaType ||
        typeof item.byteLength !== 'number' || !Number.isSafeInteger(item.byteLength) || item.byteLength < 0 ||
        cleanAttachmentName(item.fileName, item.mediaType) !== item.fileName ||
        (item.sha256 !== undefined && (typeof item.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(item.sha256)))) return error()
    const refId = identity(item.ref)
    if (seen.has(refId)) return error()
    seen.add(refId)
    return { ref: item.ref, fileName: item.fileName, mediaType: item.mediaType, byteLength: item.byteLength, ...(item.sha256 !== undefined ? { sha256: item.sha256 as string } : {}) }
  })
  return { version: 1, items }
}
function currentTx(db: Database, txId: number): Row {
  const tx = db.prepare('SELECT * FROM transactions WHERE id=?').get(txId) as Row | undefined
  if (!tx) throw new Error(`交易 #${txId} 不存在`)
  return tx
}
/** Read provenance only. No get-or-create, seed, audit, repair or model calls. */
function provenance(db: Database, tx: Row): { refs: string[]; binding: unknown } {
  const source = tx.source_message_id as string | null
  const imports = source ? db.prepare('SELECT id,source_ref FROM imports WHERE source_message_id=? ORDER BY id DESC').all(source) as { id: number; source_ref: string | null }[] : []
  const rawSource = source ? getSetting(db, sourceKey(source)) : null
  const found: string[] = imports.flatMap(row => isSafeAttachmentRef(row.source_ref) && attachmentMediaType(row.source_ref) ? [row.source_ref] : [])
  if (rawSource !== null) found.push(...sourceRefs(rawSource))
  const importIds = new Set(imports.map(row => row.id))
  const pending = db.prepare("SELECT id,tx_id,field,payload FROM pending_clarifications WHERE tx_id=? OR field IN ('batch_confirm','batch_item','transfer_account') ORDER BY id").all(tx.id) as { id: number; tx_id: number | null; field: string; payload: string }[]
  const matching: unknown[] = []
  for (const row of pending) {
    const payload = json(row.payload)
    if (!object(payload)) return error()
    const plan = payload.plan
    if (plan !== undefined && !object(plan)) return error()
    const p = object(plan) ? plan : payload
    const match = row.tx_id === tx.id || (source !== null && source !== undefined && (p.batchId === source || p.sourceMessageId === source || importIds.has(p.importId as number)))
    if (!match) continue
    matching.push(row)
    if (Object.hasOwn(p, 'attachments')) found.push(...refs(p.attachments))
    if (p !== payload && Object.hasOwn(payload, 'attachments')) found.push(...refs(payload.attachments))
  }
  return { refs: [...new Map(found.map(ref => [identity(ref), ref])).values()], binding: { imports, rawSource, matching } }
}
function readState(db: Database, txId: number): { tx: Row; items: Metadata[] | null; legacyRefs: string[]; version: string } {
  const tx = currentTx(db, txId), source = provenance(db, tx), raw = getSetting(db, txKey(txId))
  const items = raw === null ? null : authority(raw).items
  const audit = db.prepare("SELECT MAX(id) AS id FROM audit_log WHERE entity_type='transaction' AND entity_id=?").get(txId)
  return { tx, items, legacyRefs: source.refs, version: hash(JSON.stringify({ tx, authority: raw, source: source.binding, audit })) }
}
function metadata(state: ReturnType<typeof readState>, dir: string): Metadata[] {
  return state.items ?? state.legacyRefs.map(ref => ({
    ref, fileName: cleanAttachmentName(ref, attachmentMediaType(ref)!), mediaType: attachmentMediaType(ref)!, byteLength: safeAttachmentFile(dir, ref)?.stat.size ?? 0,
  }))
}
function dto(state: ReturnType<typeof readState>, dir: string): TxAttachmentListDTO {
  const items: TxAttachmentDTO[] = metadata(state, dir).map(item => {
    const file = safeAttachmentFile(dir, item.ref)
    return { ref: item.ref, fileName: item.fileName, mediaType: item.mediaType, byteLength: item.byteLength, available: !!file && file.stat.size > 0 && file.stat.size <= TX_ATTACHMENT_LIMITS.maxFileBytes }
  })
  return { version: state.version, items, limits: { ...TX_ATTACHMENT_LIMITS } }
}
export function getTransactionAttachments(db: Database, txId: number, attachmentsDir: string): TxAttachmentListDTO {
  validateAttachmentTxId(txId)
  return dto(readState(db, txId), attachmentsDir)
}
/** Paperclip and detail share DB-only authority. Corrupt refs fail closed without resurrecting imports. */
export function primaryTransactionAttachmentRef(db: Database, txId: number): string | null {
  try { const state = readState(db, txId); return state.items ? state.items[0]?.ref ?? null : state.legacyRefs[0] ?? null } catch { return null }
}
function writable(db: Database, id: number, version: string): ReturnType<typeof readState> {
  const state = readState(db, id)
  if (state.tx.state === 'deleted') throw new Error('这笔交易已删除，请先恢复后再修改附件')
  if (state.version !== version) throw new Error('附件或交易已变化，当前版本过期，请刷新后重新复核')
  return state
}
function commitAuthority(db: Database, txId: number, before: Metadata[], after: Metadata[]): void {
  setSetting(db, txKey(txId), JSON.stringify({ version: 1, items: after }), { audit: false })
  writeAudit(db, { entity_type: 'transaction', entity_id: txId, changed_by: 'user', change_type: 'update', before_value: { attachments: before }, after_value: { attachments: after }, reasoning: '用户在交易详情中修改本地附件引用' })
}
function preflightFiles(value: unknown): { fileName: string; mediaType: string; base64: string }[] {
  if (!Array.isArray(value) || !value.length || value.length > TX_ATTACHMENT_LIMITS.maxCount) throw new Error('一次添加需为 1~12 张图片')
  // Linear validation: quantified base64 groups overflow V8's regex stack on valid 10MiB input.
  return Array.from(value, file => {
    exact(file, ['fileName', 'mediaType', 'dataBase64'])
    if (typeof file.fileName !== 'string' || !file.fileName.trim() || file.fileName.length > 1024 || typeof file.mediaType !== 'string' || !Object.hasOwn(IMAGE_EXTENSIONS, file.mediaType) || typeof file.dataBase64 !== 'string') throw new Error('图片参数或格式无效，仅支持 PNG/JPEG/WebP/GIF')
    const base64 = file.dataBase64
    if (!base64.length || base64.length > Math.ceil(TX_ATTACHMENT_LIMITS.maxFileBytes / 3) * 4 || base64.length % 4 !== 0 || /[^A-Za-z0-9+/=]/.test(base64)) throw new Error('图片 base64 无效或超过 10MiB')
    const padding = base64.endsWith('==') ? 2 : base64.endsWith('=') ? 1 : 0
    const firstPadding = base64.indexOf('=')
    const last = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'.indexOf(base64[base64.length - padding - 1])
    if ((firstPadding !== -1 && firstPadding !== base64.length - padding) || (padding === 2 && (last & 15) !== 0) || (padding === 1 && (last & 3) !== 0)) throw new Error('图片 base64 padding 无效')
    const length = base64.length / 4 * 3 - padding
    if (length <= 0 || length > TX_ATTACHMENT_LIMITS.maxFileBytes) throw new Error('图片大小必须为 1B~10MiB')
    return { fileName: cleanAttachmentName(file.fileName, file.mediaType), mediaType: file.mediaType, base64 }
  })
}
function decodeFiles(checked: ReturnType<typeof preflightFiles>, validate: TransactionAttachmentContext['validateImage']): { bytes: Buffer; fileName: string; mediaType: string; sha256: string }[] {
  return checked.map(file => {
    const bytes = Buffer.from(file.base64, 'base64')
    if (bytes.toString('base64') !== file.base64 || !imageMagicMatches(bytes, file.mediaType) || !validate(bytes, file.mediaType)) throw new Error('图片内容损坏或与声明格式不一致')
    return { bytes, fileName: file.fileName, mediaType: file.mediaType, sha256: hash(bytes) }
  })
}
export function validateAddTransactionAttachmentsInput(input: unknown): asserts input is AddTxAttachmentsInput {
  exact(input, ['txId', 'expectedVersion', 'files']); validateAttachmentTxId(input.txId); versionInput(input.expectedVersion)
  preflightFiles(input.files)
}
export function addTransactionAttachments(db: Database, input: AddTxAttachmentsInput, ctx: TransactionAttachmentContext): TxAttachmentListDTO {
  validateAddTransactionAttachmentsInput(input)
  // All shape/encoded bounds checks precede even a SQL transaction; stale input never decodes.
  const checked = preflightFiles(input.files)
  const owned: OwnedAttachmentFile[] = []
  try {
    db.transaction(() => {
      const state = writable(db, input.txId, input.expectedVersion), decoded = decodeFiles(checked, ctx.validateImage), before = metadata(state, ctx.attachmentsDir)
      const hashes = new Set<string>()
      for (const item of before) {
        // Read the current safe file rather than trusting persisted hash metadata after local tampering.
        const bytes = readAttachmentBytes(ctx.attachmentsDir, item.ref)
        if (bytes) hashes.add(hash(bytes))
      }
      const unique = decoded.filter(file => { if (hashes.has(file.sha256)) return false; hashes.add(file.sha256); return true })
      if (!unique.length) return // honest no-op: no settings, audit, version or file change
      const total = before.reduce((n, item) => n + Math.max(item.byteLength, safeAttachmentFile(ctx.attachmentsDir, item.ref)?.stat.size ?? 0), 0) + unique.reduce((n, file) => n + file.bytes.length, 0)
      if (before.length + unique.length > TX_ATTACHMENT_LIMITS.maxCount || total > TX_ATTACHMENT_LIMITS.maxTotalBytes || before.some(item => Math.max(item.byteLength, safeAttachmentFile(ctx.attachmentsDir, item.ref)?.stat.size ?? 0) > TX_ATTACHMENT_LIMITS.maxFileBytes)) throw new Error('交易附件超出限制：最多12张、单张10MiB、合计40MiB')
      safeAttachmentRoot(ctx.attachmentsDir)
      const added: Metadata[] = unique.map(file => ({ ref: writeNewAttachment(ctx.attachmentsDir, file.bytes, file.mediaType, owned), fileName: file.fileName, mediaType: file.mediaType, byteLength: file.bytes.length, sha256: file.sha256 }))
      commitAuthority(db, input.txId, before, [...before, ...added])
    })()
  } catch (failure) {
    for (const file of owned) { try { unlinkOwnedAttachment(ctx.attachmentsDir, file) } catch { /* Keep original SQL/IO error; uncertain residue is never broadly deleted. */ } }
    throw failure
  }
  return getTransactionAttachments(db, input.txId, ctx.attachmentsDir)
}
export function removeTransactionAttachment(db: Database, input: RemoveTxAttachmentInput, ctx: TransactionAttachmentContext): TxAttachmentListDTO {
  exact(input, ['txId', 'expectedVersion', 'ref']); validateAttachmentTxId(input.txId); versionInput(input.expectedVersion)
  if (!isSafeAttachmentRef(input.ref) || attachmentMediaType(input.ref) === null) throw new Error('附件引用无效')
  db.transaction(() => {
    const state = writable(db, input.txId, input.expectedVersion), before = metadata(state, ctx.attachmentsDir)
    if (!before.some(item => item.ref === input.ref)) throw new Error('此附件不属于当前交易')
    commitAuthority(db, input.txId, before, before.filter(item => item.ref !== input.ref))
  })()
  return getTransactionAttachments(db, input.txId, ctx.attachmentsDir)
}

/** Source binding participates in the caller's creation/audit transaction; never a second commit. */
export function registerTransactionSourceAttachments(db: Database, txId: number, input: string[]): void {
  if (!db.inTransaction) throw new Error('附件来源必须与创建交易在同一事务中保存')
  validateAttachmentTxId(txId)
  const tx = currentTx(db, txId), source = tx.source_message_id
  if (typeof source !== 'string' || !source || source.length > 1024) throw new Error('附件来源身份无效')
  const clean = refs(input)
  if (clean.length !== input.length) throw new Error('附件来源引用无效')
  if (!clean.length) return
  const key = sourceKey(source), previous = getSetting(db, key)
  const merged = [...new Map([...(previous === null ? [] : sourceRefs(previous)), ...clean].map(ref => [identity(ref), ref])).values()]
  const next = JSON.stringify({ version: 1, refs: merged })
  if (next !== previous) setSetting(db, key, next, { audit: false })
}

/** Conservative reference index for the user-explicit old-file cleanup action.
 * Validate every payload before deleting ANY candidate, including resolved pending/soft-deleted tx. */
export function collectAttachmentReferences(db: Database): Set<string> {
  const protectedRefs = new Set<string>()
  const protect = (values: string[]): void => { for (const ref of values) protectedRefs.add(identity(ref)) }
  const strictRefs = (value: unknown): string[] => {
    if (!Array.isArray(value) || value.length > 10_000 || value.some(ref => !isSafeAttachmentRef(ref))) return error()
    return value as string[]
  }
  const imports = db.prepare('SELECT source_ref FROM imports WHERE source_ref IS NOT NULL').all() as { source_ref: string }[]
  protect(strictRefs(imports.map(row => row.source_ref)))
  const settings = db.prepare("SELECT key,value FROM settings WHERE key LIKE 'tx.attachments:%' OR key LIKE 'source.attachments:%'").all() as { key: string; value: string }[]
  for (const row of settings) {
    if (row.key.startsWith('tx.attachments:')) protect(authority(row.value).items.map(item => item.ref))
    else protect(sourceRefs(row.value))
  }
  for (const row of db.prepare('SELECT payload FROM pending_clarifications').all() as { payload: string }[]) {
    const value = json(row.payload)
    if (!object(value)) return error()
    if (Object.hasOwn(value, 'attachments')) protect(strictRefs(value.attachments))
    if (Object.hasOwn(value, 'plan')) {
      if (!object(value.plan)) return error()
      if (Object.hasOwn(value.plan, 'attachments')) protect(strictRefs(value.plan.attachments))
    }
  }
  return protectedRefs
}
export function cleanupUnreferencedAttachments(db: Database, dir: string, keepDays: number): number {
  if (typeof keepDays !== 'number' || !Number.isFinite(keepDays) || keepDays < 1 || keepDays > 365_000) throw new Error('附件保留天数无效')
  const protectedRefs = collectAttachmentReferences(db), root = safeAttachmentRoot(dir), cutoff = Date.now() - keepDays * 86_400_000
  let removed = 0
  for (const ref of readdirSync(root)) {
    if (protectedRefs.has(identity(ref)) || !attachmentMediaType(ref)) continue
    const file = safeAttachmentFile(root, ref)
    if (!file || file.stat.mtimeMs >= cutoff) continue
    if (unlinkOwnedAttachment(root, { ref, path: file.path, stat: file.stat })) removed++
  }
  return removed
}
