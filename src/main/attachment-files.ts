// Local attachment boundary. No renderer-provided absolute paths, no link traversal.
import {
  lstatSync, realpathSync, openSync, fstatSync, closeSync, readFileSync,
  writeFileSync, unlinkSync, constants, type Stats,
} from 'node:fs'
import { resolve, parse, join, relative, isAbsolute, sep, basename } from 'node:path'
import { randomUUID } from 'node:crypto'

export const ATTACHMENT_MAX_FILE_BYTES = 10_485_760
const EXTENSIONS: Record<string, string> = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp', gif: 'image/gif' }
export const IMAGE_EXTENSIONS: Record<string, string> = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp', 'image/gif': 'gif' }
const identityPath = (path: string): string => process.platform === 'win32' ? resolve(path).toLowerCase() : resolve(path)
const sameFile = (a: Stats, b: Stats): boolean => a.dev === b.dev && a.ino === b.ino

export function isSafeAttachmentRef(ref: unknown): ref is string {
  if (typeof ref !== 'string' || !ref || ref.length > 1024 || /[\\\x00-\x1f\x7f:<>"|?*]/.test(ref) || isAbsolute(ref)) return false
  return ref.split('/').every(part => !!part && part !== '.' && part !== '..' && !/[. ]$/.test(part) && !/^(con|prn|aux|nul|com[0-9]|lpt[0-9])(?:\.|$)/i.test(part))
}
export function attachmentMediaType(ref: string): string | null {
  const ext = ref.split('.').pop()?.toLowerCase() ?? ''
  return Object.hasOwn(EXTENSIONS, ext) ? EXTENSIONS[ext] : null
}
export function imageMagicMatches(bytes: Buffer, mime: string): boolean {
  if (mime === 'image/png') return bytes.length >= 24 && bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) && bytes.toString('ascii', 12, 16) === 'IHDR'
  if (mime === 'image/jpeg') return bytes.length >= 4 && bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255
  if (mime === 'image/webp') return bytes.length >= 16 && bytes.toString('ascii', 0, 4) === 'RIFF' && bytes.toString('ascii', 8, 12) === 'WEBP'
  if (mime === 'image/gif') return bytes.length >= 13 && ['GIF87a', 'GIF89a'].includes(bytes.toString('ascii', 0, 6))
  return false
}
export function cleanAttachmentName(name: string, mime: string): string {
  const clean = basename(name.replaceAll('\\', '/')).replace(/[\x00-\x1f\x7f<>:"/\\|?*\u202a-\u202e\u2066-\u2069]/g, '_').trim().slice(0, 180).replace(/[. ]+$/, '')
  return clean && clean !== '.' && clean !== '..' ? clean : `image.${IMAGE_EXTENSIONS[mime]}`
}

/** Check every ancestor, including the root itself (NTFS junctions are symlinks to Node).
 * realpath equality is case-insensitive only on Windows; sibling prefixes never count as containment. */
export function safeAttachmentRoot(dir: string): string {
  if (typeof dir !== 'string' || !dir || dir.includes('\0')) throw new Error('附件目录不可用')
  const root = resolve(dir), anchor = parse(root).root
  let current = anchor
  for (const part of root.slice(anchor.length).split(sep).filter(Boolean)) {
    current = join(current, part)
    const stat = lstatSync(current)
    if (stat.isSymbolicLink() || !stat.isDirectory() || identityPath(realpathSync.native(current)) !== identityPath(current)) throw new Error('附件目录含链接或不可用')
  }
  return root
}
export function safeAttachmentFile(dir: string, ref: unknown): { path: string; stat: Stats } | null {
  if (!isSafeAttachmentRef(ref)) return null
  try {
    const root = safeAttachmentRoot(dir)
    let path = root
    const parts = ref.split('/')
    for (let i = 0; i < parts.length; i++) {
      path = join(path, parts[i])
      const stat = lstatSync(path)
      if (stat.isSymbolicLink() || (i < parts.length - 1 ? !stat.isDirectory() : !stat.isFile())) return null
      const real = realpathSync.native(path), rel = relative(root, real)
      if (!rel || isAbsolute(rel) || rel === '..' || rel.startsWith('..' + sep) || identityPath(real) !== identityPath(path)) return null
      if (i === parts.length - 1) return { path, stat }
    }
  } catch { /* Missing, inaccessible and unsafe files are unavailable, never rewritten. */ }
  return null
}
export function readAttachmentBytes(dir: string, ref: unknown): Buffer | null {
  const file = safeAttachmentFile(dir, ref)
  if (!file || file.stat.size <= 0 || file.stat.size > ATTACHMENT_MAX_FILE_BYTES) return null
  let fd: number | undefined
  try {
    fd = openSync(file.path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0))
    const stat = fstatSync(fd), again = safeAttachmentFile(dir, ref)
    if (!stat.isFile() || !sameFile(file.stat, stat) || !again || !sameFile(again.stat, stat) || stat.size <= 0 || stat.size > ATTACHMENT_MAX_FILE_BYTES) return null
    const bytes = readFileSync(fd)
    return bytes.length === stat.size && bytes.length <= ATTACHMENT_MAX_FILE_BYTES ? bytes : null
  } catch { return null } finally { if (fd !== undefined) closeSync(fd) }
}
export function readAttachmentDataUrl(dir: string, ref: unknown): string | null {
  if (!isSafeAttachmentRef(ref)) return null
  const mime = attachmentMediaType(ref)
  if (!mime) return null
  const bytes = readAttachmentBytes(dir, ref)
  return bytes && imageMagicMatches(bytes, mime) ? `data:${mime};base64,${bytes.toString('base64')}` : null
}

export interface OwnedAttachmentFile { ref: string; path: string; stat: Stats }
/** Exclusive UUID creation only; callers must have validated the whole operation before this. */
export function writeNewAttachment(dir: string, bytes: Buffer, mime: string, owned: OwnedAttachmentFile[]): string {
  const root = safeAttachmentRoot(dir), ref = `${randomUUID()}.${IMAGE_EXTENSIONS[mime]}`, path = join(root, ref)
  const fd = openSync(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, 0o600)
  const entry = { ref, path, stat: fstatSync(fd) }; owned.push(entry)
  try { writeFileSync(fd, bytes); entry.stat = fstatSync(fd) } finally { closeSync(fd) }
  return ref
}
/** Delete only a verified original identity, never a replacement/link/shared legacy file. */
export function unlinkOwnedAttachment(dir: string, entry: OwnedAttachmentFile): boolean {
  const file = safeAttachmentFile(dir, entry.ref)
  if (!file || file.path !== entry.path || !sameFile(file.stat, entry.stat)) return false
  unlinkSync(file.path)
  return true
}
