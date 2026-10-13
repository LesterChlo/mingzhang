// 账户管理（A 账户线）：list 在 ledger.ts；这里补新增/改名，均走审计。

import type { Database } from 'better-sqlite3-multiple-ciphers'
import type { CreateAccountInput, RenameAccountInput } from '../../shared/types'
export type { CreateAccountInput, RenameAccountInput } from '../../shared/types'
import { writeAudit } from './ledger'
import { nowIso } from '../db/time'

function accountName(value: unknown): string {
  if (typeof value !== 'string' || /[\u0000-\u001f\u007f-\u009f]/.test(value)) {
    throw new Error('账户名称无效：不允许控制字符')
  }
  const name = value.trim()
  if (!name || Array.from(name).length > 100) throw new Error('账户名称须为 1–100 个字符')
  return name
}

export function createAccount(db: Database, input: CreateAccountInput): number {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('新增账户参数无效')
  const name = accountName(input.name)
  if (!['cash', 'bank', 'alipay', 'wechat'].includes(input.type)) throw new Error('账户类型无效')
  let id!: number
  db.transaction(() => {
    if (db.prepare('SELECT id FROM accounts WHERE name=?').get(name)) throw new Error(`账户「${name}」已存在`)
    const ts = nowIso()
    const cur = db
      .prepare("INSERT INTO accounts (name, type, currency, created_at, updated_at) VALUES (?, ?, 'CNY', ?, ?)")
      .run(name, input.type, ts, ts)
    id = Number(cur.lastInsertRowid)
    writeAudit(db, {
      entity_type: 'account',
      entity_id: id,
      changed_by: 'user',
      change_type: 'create',
      after_value: { name, type: input.type },
      reasoning: '新增账户',
    })
  })()
  return id
}

export function renameAccountById(db: Database, input: RenameAccountInput): void {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('账户改名参数无效')
  if (!Number.isSafeInteger(input.accountId) || input.accountId <= 0) throw new Error('账户 ID 参数无效')
  if (typeof input.expectedName !== 'string' || !input.expectedName) throw new Error('原账户名称参数无效')
  const name = accountName(input.newName)
  db.transaction(() => {
    const row = db.prepare('SELECT id,name FROM accounts WHERE id=?').get(input.accountId) as { id: number; name: string } | undefined
    if (!row) throw new Error('账户不存在，请刷新后重试')
    if (row.name !== input.expectedName) throw new Error('账户名称已变更，当前信息过期，请刷新后重试')
    if (db.prepare('SELECT id FROM accounts WHERE name=? AND id<>?').get(name, row.id)) {
      throw new Error(`账户「${name}」已存在`)
    }
    if (name === row.name) return
    db.prepare('UPDATE accounts SET name=?,updated_at=? WHERE id=?').run(name, nowIso(), row.id)
    writeAudit(db, {
      entity_type: 'account',
      entity_id: row.id,
      changed_by: 'user',
      change_type: 'update',
      before_value: { name: row.name },
      after_value: { name },
      reasoning: '账户改名',
    })
  })()
}

/** 保留工具侧按名称调用的签名；与 UI 的 ID 路径共享验证和审计事务。 */
export function renameAccount(db: Database, oldName: string, newName: string): void {
  const old = accountName(oldName)
  const row = db.prepare('SELECT id,name FROM accounts WHERE name=?').get(old) as { id: number; name: string } | undefined
  if (!row) throw new Error(`账户「${old}」不存在`)
  renameAccountById(db, { accountId: row.id, expectedName: row.name, newName })
}
