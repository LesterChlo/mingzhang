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

export function seed(db: Database): SeedResult {
  const ts = nowIso()
  const added: SeedResult = { accounts: 0, categories: 0, settings: 0 }

  const insAcc = db.prepare(
    "INSERT OR IGNORE INTO accounts (name, type, currency, created_at, updated_at) VALUES (?, ?, 'CNY', ?, ?)",
  )
  for (const [name, type] of ACCOUNTS) {
    added.accounts += insAcc.run(name, type, ts, ts).changes
  }

  const insCat = db.prepare(
    'INSERT OR IGNORE INTO categories (name, kind, parent_id, created_at, updated_at) VALUES (?, ?, NULL, ?, ?)',
  )
  for (const [name, kind] of CATEGORIES) {
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
