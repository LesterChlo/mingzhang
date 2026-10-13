// 批次结果的展示偏好；只使用当前账本 settings，不保存聊天、不写账务或审计。
import type { Database } from 'better-sqlite3-multiple-ciphers'
import type { BatchPresentationDTO } from '../../shared/types'
import { nowIso } from '../db/time'

const defaults = (): BatchPresentationDTO => ({ dismissed: false, duplicatesOpen: false, excludedOpen: false })
const fields = ['dismissed', 'duplicatesOpen', 'excludedOpen'] as const

/** IPC 入参不信任类型：整段校验完成后才可能写入。 */
function validatePatch(value: unknown): Partial<BatchPresentationDTO> {
  if (!value || typeof value !== 'object' || Array.isArray(value) || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) {
    throw new Error('批次展示状态参数无效')
  }
  const clean: Partial<BatchPresentationDTO> = {}
  for (const key of Reflect.ownKeys(value)) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key)!
    if (typeof key !== 'string' || !fields.includes(key as typeof fields[number]) || !('value' in descriptor) || typeof descriptor.value !== 'boolean') {
      throw new Error('批次展示状态只允许dismissed/duplicatesOpen/excludedOpen的boolean值')
    }
    clean[key as typeof fields[number]] = descriptor.value
  }
  return clean
}

function requireBatchGate(db: Database, gateId: number): void {
  if (!Number.isSafeInteger(gateId) || gateId <= 0) throw new Error('批次确认门参数无效')
  const gate = db.prepare("SELECT id FROM pending_clarifications WHERE id=? AND field='batch_confirm' AND status='resolved'").get(gateId)
  if (!gate) throw new Error('已执行的批次确认门不存在')
}

export function getBatchPresentation(db: Database, gateId: number): BatchPresentationDTO {
  requireBatchGate(db, gateId)
  const row = db.prepare('SELECT value FROM settings WHERE key=?').get(`ui.batch-result:${gateId}`) as { value: string } | undefined
  if (!row) return defaults()
  try {
    const value: unknown = JSON.parse(row.value)
    const state = validatePatch(value)
    return fields.every(key => Object.hasOwn(state, key)) ? { ...defaults(), ...state } : defaults()
  } catch {
    // 历史坏值不在读取时修写；账本读取错误不进入这个 catch。
    return defaults()
  }
}

export function setBatchPresentation(db: Database, gateId: number, patch: Partial<BatchPresentationDTO>): BatchPresentationDTO {
  const clean = validatePatch(patch)
  // 事务内重读合并，避免两连接的部分 patch 覆盖彼此。
  let result!: BatchPresentationDTO
  db.transaction(() => {
    const current = getBatchPresentation(db, gateId)
    result = { ...current, ...clean }
    if (Object.keys(clean).length === 0) return
    db.prepare('INSERT INTO settings(key,value,updated_at) VALUES (?,?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_at=excluded.updated_at')
      .run(`ui.batch-result:${gateId}`, JSON.stringify(result), nowIso())
  })()
  return result
}
