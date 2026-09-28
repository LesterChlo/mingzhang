// 账户管理（A 账户线）：list 在 ledger.ts；这里补新增/改名，均走审计。

import type { Database } from 'better-sqlite3-multiple-ciphers'
import { writeAudit } from './ledger'
import { nowIso } from '../db/time'

export interface CreateAccountInput {
  name: string
  type: 'cash' | 'bank' | 'alipay' | 'wechat'
}

export function createAccount(db: Database, input: CreateAccountInput): number {
  const ts = nowIso()
  const cur = db
    .prepare("INSERT INTO accounts (name, type, currency, created_at, updated_at) VALUES (?, ?, 'CNY', ?, ?)")
    .run(input.name, input.type, ts, ts)
  const id = Number(cur.lastInsertRowid)
  writeAudit(db, {
    entity_type: 'account',
    entity_id: id,
    changed_by: 'user',
    change_type: 'create',
    after_value: { name: input.name, type: input.type },
    reasoning: '新增账户',
  })
  return id
}

export function renameAccount(db: Database, oldName: string, newName: string): void {
  const row = db.prepare('SELECT id FROM accounts WHERE name = ?').get(oldName) as { id: number } | undefined
  if (!row) throw new Error(`账户「${oldName}」不存在`)
  db.prepare('UPDATE accounts SET name = ?, updated_at = ? WHERE id = ?').run(newName, nowIso(), row.id)
  writeAudit(db, {
    entity_type: 'account',
    entity_id: row.id,
    changed_by: 'user',
    change_type: 'update',
    before_value: { name: oldName },
    after_value: { name: newName },
    reasoning: '账户改名',
  })
}
