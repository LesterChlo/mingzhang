// 预置数据（幂等）：4 账户 + 8 分类 + settings 键。与 legacy seed.py 一一对应（计划书 §5.6）——另新增咖啡/交通常用支出分类。

import type { Database } from 'better-sqlite3-multiple-ciphers'
import { nowIso } from './time'

const ACCOUNTS: [string, string][] = [
  ['现金', 'cash'],
  ['银行卡', 'bank'],
  ['支付宝', 'alipay'],
  ['微信', 'wechat'],
]

const CATEGORIES: [string, string][] = [
  ['餐饮', 'expense'],
  ['咖啡', 'expense'],
  ['交通', 'expense'],
  ['购物', 'expense'],
  ['其他', 'expense'],
  ['生活费', 'income'],
  ['红包', 'income'],
  ['其他', 'income'],
]

const SETTINGS: [string, string][] = [
  ['llm_mode', 'online'],
  ['monthly_budget_cents', '0'],
  ['confidence_threshold', '0.7'],
]

export interface SeedResult {
  accounts: number
  categories: number
  settings: number
}

/** 利用既有改名审计识别已使用的默认名，不增 settings 键或猜历史库的 ID。 */
function renamedNames(db: Database, entity: 'account' | 'category'): Set<string> {
  const table = entity === 'account' ? 'accounts' : 'categories'
  const kindColumn = entity === 'account' ? 'type' : 'kind'
  const rows = db.prepare(
    `SELECT a.before_value,a.after_value,e.${kindColumn} AS kind FROM audit_log a JOIN ${table} e ON e.id=a.entity_id` +
    " WHERE a.entity_type=? AND a.change_type='update'",
  ).all(entity) as { before_value: string | null; after_value: string | null; kind: string }[]
  const names = new Set<string>()
  for (const row of rows) {
    try {
      const before = JSON.parse(row.before_value ?? 'null')
      const after = JSON.parse(row.after_value ?? 'null')
      if (typeof before?.name === 'string' && typeof after?.name === 'string' && before.name !== after.name) {
        names.add(JSON.stringify([before.name, row.kind]))
      }
    } catch { /* 坏历史 JSON 不应阻断 seed；仅采信可识别的改名证据。 */ }
  }
  return names
}

export function seed(db: Database): SeedResult {
  const ts = nowIso()
  const added: SeedResult = { accounts: 0, categories: 0, settings: 0 }
  const renamedAccounts = renamedNames(db, 'account')
  const renamedCategories = renamedNames(db, 'category')

  const insAcc = db.prepare(
    "INSERT OR IGNORE INTO accounts (name, type, currency, created_at, updated_at) VALUES (?, ?, 'CNY', ?, ?)",
  )
  for (const [name, type] of ACCOUNTS) {
    if (renamedAccounts.has(JSON.stringify([name, type]))) continue
    added.accounts += insAcc.run(name, type, ts, ts).changes
  }

  const insCat = db.prepare(
    'INSERT OR IGNORE INTO categories (name, kind, parent_id, created_at, updated_at) VALUES (?, ?, NULL, ?, ?)',
  )
  for (const [name, kind] of CATEGORIES) {
    if (renamedCategories.has(JSON.stringify([name, kind]))) continue
    added.categories += insCat.run(name, kind, ts, ts).changes
  }

  const insSet = db.prepare(
    'INSERT OR IGNORE INTO settings (key, value, updated_at) VALUES (?, ?, ?)',
  )
  for (const [key, value] of SETTINGS) {
    added.settings += insSet.run(key, value, ts).changes
  }

  return added
}
