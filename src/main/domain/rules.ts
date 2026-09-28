// 规则引擎（A6，Q4 定稿口径）。rules 表结构不动，只填数据 + 读写。JSON 口径：
//   condition = {"match":"merchant","op":"contains","value":"星巴克"}
//   action    = {"set_category":"咖啡"}
// 时机：解析后、写分类前；只匹配 active=1；无 priority 字段，平局取新（ORDER BY id DESC）。
// 移植自 legacy backend/domain/rules.py。

import type { Database } from 'better-sqlite3-multiple-ciphers'
import { getOrCreateCategoryId, writeAudit } from './ledger'
import { nowIso } from '../db/time'

export interface RuleCondition {
  match: 'merchant'
  op: 'contains' | 'equals'
  value: string
}

export interface RuleAction {
  set_category: string
}

export interface RuleRow {
  id: number
  condition: string
  action: string
  provenance: 'manual' | 'learned_from_correction'
  active: 0 | 1
  hit_count: number
  created_at: string
  updated_at: string
}

export function listRules(db: Database, opts: { activeOnly?: boolean } = {}): RuleRow[] {
  const sql = opts.activeOnly === false ? 'SELECT * FROM rules ORDER BY id DESC' : 'SELECT * FROM rules WHERE active = 1 ORDER BY id DESC'
  return db.prepare(sql).all() as unknown as RuleRow[]
}

function canonical(v: unknown): string {
  return JSON.stringify(v)
}

export function findByCondition(db: Database, condition: RuleCondition): RuleRow | null {
  const blob = canonical(condition)
  for (const row of listRules(db)) {
    try {
      if (canonical(JSON.parse(row.condition)) === blob) return row
    } catch {
      continue
    }
  }
  return null
}

function matches(condition: RuleCondition, merchant: string | null): boolean {
  if (!merchant || condition.match !== 'merchant') return false
  const value = String(condition.value ?? '')
  if (!value) return false
  if (condition.op === 'equals') return merchant === value
  return merchant.includes(value) // contains（默认）
}

export function matchRule(db: Database, merchant: string | null): RuleRow | null {
  for (const row of listRules(db)) {
    try {
      if (matches(JSON.parse(row.condition) as RuleCondition, merchant)) return row
    } catch {
      continue
    }
  }
  return null
}

export function createRule(
  db: Database,
  condition: RuleCondition,
  action: RuleAction,
  opts: { provenance?: 'manual' | 'learned_from_correction'; sourceMessageId?: string | null; reasoning?: string } = {},
): number {
  const ts = nowIso()
  const cur = db
    .prepare(
      'INSERT INTO rules (condition, action, provenance, active, hit_count, created_at, updated_at) VALUES (?,?,?,1,0,?,?)',
    )
    .run(
      canonical(condition),
      canonical(action),
      opts.provenance ?? 'manual',
      ts,
      ts,
    )
  const ruleId = Number(cur.lastInsertRowid)
  writeRuleAudit(db, {
    ruleId,
    changedBy: 'user',
    changeType: 'create',
    afterValue: { condition, action, provenance: opts.provenance ?? 'manual' },
    sourceMessageId: opts.sourceMessageId ?? null,
    reasoning: opts.reasoning ?? '用户教学',
  })
  return ruleId
}

export function updateRuleAction(
  db: Database,
  ruleId: number,
  action: RuleAction,
  opts: { provenance?: 'manual' | 'learned_from_correction'; sourceMessageId?: string | null; reasoning?: string } = {},
): void {
  const before = db.prepare('SELECT * FROM rules WHERE id=?').get(ruleId) as RuleRow | undefined
  db.prepare('UPDATE rules SET action=?, provenance=?, updated_at=? WHERE id=?').run(
    canonical(action),
    opts.provenance ?? 'manual',
    nowIso(),
    ruleId,
  )
  writeRuleAudit(db, {
    ruleId,
    changedBy: 'user',
    changeType: 'update',
    beforeValue: { action: before ? JSON.parse(before.action) : null },
    afterValue: { action, provenance: opts.provenance ?? 'manual' },
    sourceMessageId: opts.sourceMessageId ?? null,
    reasoning: opts.reasoning ?? '用户覆盖已有规则',
  })
}

function writeRuleAudit(
  db: Database,
  input: {
    ruleId: number
    changedBy: 'user' | 'rule_engine'
    changeType: 'create' | 'update'
    beforeValue?: unknown
    afterValue?: unknown
    sourceMessageId?: string | null
    reasoning?: string | null
  },
): void {
  writeAudit(db, {
    entity_type: 'rule',
    entity_id: input.ruleId,
    changed_by: input.changedBy,
    change_type: input.changeType,
    before_value: input.beforeValue,
    after_value: input.afterValue,
    source_message_id: input.sourceMessageId ?? null,
    reasoning: input.reasoning ?? null,
  })
}

export function bumpHit(
  db: Database,
  ruleId: number,
  opts: { txId?: number | null; sourceMessageId?: string | null } = {},
): void {
  const before = db.prepare('SELECT hit_count FROM rules WHERE id=?').get(ruleId) as
    | { hit_count: number }
    | undefined
  db.prepare('UPDATE rules SET hit_count = hit_count + 1, updated_at=? WHERE id=?').run(nowIso(), ruleId)
  writeRuleAudit(db, {
    ruleId,
    changedBy: 'rule_engine',
    changeType: 'update',
    beforeValue: { hit_count: before?.hit_count ?? 0 },
    afterValue: { hit_count: (before?.hit_count ?? 0) + 1 },
    sourceMessageId: opts.sourceMessageId ?? null,
    reasoning: `规则 #${ruleId} 命中` + (opts.txId ? `，交易 #${opts.txId}` : ''),
  })
}

/** 撤销 = active=0（软撤，保留历史）+ 审计；不物理删除。 */
export function deactivateRule(
  db: Database,
  ruleId: number,
  opts: { sourceMessageId?: string | null; reasoning?: string } = {},
): void {
  const before = db.prepare('SELECT * FROM rules WHERE id=?').get(ruleId) as RuleRow | undefined
  db.prepare('UPDATE rules SET active=0, updated_at=? WHERE id=?').run(nowIso(), ruleId)
  writeRuleAudit(db, {
    ruleId,
    changedBy: 'user',
    changeType: 'update',
    beforeValue: { active: before?.active ?? null },
    afterValue: { active: 0 },
    sourceMessageId: opts.sourceMessageId ?? null,
    reasoning: opts.reasoning ?? '用户撤销规则',
  })
}

/** 解析后、写分类前调用。命中则返回 (categoryId, ruleId)，否则 (null, null)。 */
export function applyRules(
  db: Database,
  input: {
    merchant: string | null
    kind: 'expense' | 'income'
    txId?: number | null
    sourceMessageId?: string | null
  },
): { categoryId: number | null; ruleId: number | null } {
  const rule = matchRule(db, input.merchant)
  if (!rule) return { categoryId: null, ruleId: null }
  let action: RuleAction
  try {
    action = JSON.parse(rule.action) as RuleAction
  } catch {
    return { categoryId: null, ruleId: null }
  }
  if (!action.set_category) return { categoryId: null, ruleId: null }
  const categoryId = getOrCreateCategoryId(db, action.set_category, input.kind, {
    sourceMessageId: input.sourceMessageId ?? null,
    changedBy: 'llm',
  })
  bumpHit(db, rule.id, { txId: input.txId ?? null, sourceMessageId: input.sourceMessageId ?? null })
  return { categoryId, ruleId: rule.id }
}
