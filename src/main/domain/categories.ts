import type { Database } from 'better-sqlite3-multiple-ciphers'
import type { CreateCategoryInput, RenameCategoryInput } from '../../shared/types'
export type { CreateCategoryInput, RenameCategoryInput } from '../../shared/types'
import { nowIso } from '../db/time'
import { writeAudit } from './ledger'

function categoryName(value: unknown): string {
  if (typeof value !== 'string' || /[\u0000-\u001f\u007f-\u009f]/.test(value)) {
    throw new Error('分类名称无效：不允许控制字符')
  }
  const name = value.trim()
  if (!name || Array.from(name).length > 100) throw new Error('分类名称须为 1–100 个字符')
  return name
}

export function createCategory(db: Database, input: CreateCategoryInput): number {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('新增分类参数无效')
  const name = categoryName(input.name)
  if (input.kind !== 'expense' && input.kind !== 'income') throw new Error('分类收支方向无效')
  let id!: number
  db.transaction(() => {
    if (db.prepare('SELECT id FROM categories WHERE name=? AND kind=?').get(name, input.kind)) {
      throw new Error(`该方向的分类「${name}」已存在`)
    }
    const ts = nowIso()
    const cur = db.prepare('INSERT INTO categories (name,kind,parent_id,created_at,updated_at) VALUES (?,?,NULL,?,?)')
      .run(name, input.kind, ts, ts)
    id = Number(cur.lastInsertRowid)
    writeAudit(db, {
      entity_type: 'category',
      entity_id: id,
      changed_by: 'user',
      change_type: 'create',
      after_value: { name, kind: input.kind },
      reasoning: '新增分类',
    })
  })()
  return id
}

function jsonObject(value: string): Record<string, unknown> | null {
  try {
    const parsed: unknown = JSON.parse(value)
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as Record<string, unknown> : null
  } catch {
    return null
  }
}

export function renameCategory(db: Database, input: RenameCategoryInput): void {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('分类改名参数无效')
  if (!Number.isSafeInteger(input.categoryId) || input.categoryId <= 0) throw new Error('分类 ID 参数无效')
  if (typeof input.expectedName !== 'string' || !input.expectedName) throw new Error('原分类名称参数无效')
  const name = categoryName(input.newName)
  db.transaction(() => {
    const row = db.prepare('SELECT id,name,kind FROM categories WHERE id=?').get(input.categoryId) as { id: number; name: string; kind: 'expense' | 'income' } | undefined
    if (!row) throw new Error('分类不存在，请刷新后重试')
    if (row.name !== input.expectedName) throw new Error('分类名称已变更，当前信息过期，请刷新后重试')
    if (db.prepare('SELECT id FROM categories WHERE name=? AND kind=? AND id<>?').get(name, row.kind, row.id)) {
      throw new Error(`该方向的分类「${name}」已存在`)
    }
    if (name === row.name) return
    const rules = db.prepare('SELECT id,condition,action,active FROM rules ORDER BY id').all() as { id: number; condition: string; action: string; active: number }[]
    // 无方向旧规则只能在改名前后均无同名歧义时迁移，否则必须让用户先处理习惯。
    const legacyAmbiguous = !!db.prepare('SELECT id FROM categories WHERE kind<>? AND name IN (?,?)').get(row.kind, row.name, name)
    const updates: { id: number; before: Record<string, unknown>; after: Record<string, unknown> }[] = []
    for (const rule of rules) {
      const condition = jsonObject(rule.condition)
      const action = jsonObject(rule.action)
      if (!condition || condition.match !== 'merchant' || (condition.op !== 'equals' && condition.op !== 'contains') || typeof condition.value !== 'string' || !condition.value.trim()) continue
      if (!action || typeof action.set_category !== 'string' || action.set_category.trim() !== row.name) continue
      if (condition.direction === undefined) {
        if (legacyAmbiguous) {
          if (rule.active === 1) throw new Error('旧分类习惯缺少收支方向且同名有歧义，请先停用旧习惯，再按方向重新保存')
          continue
        }
      } else if (condition.direction !== row.kind) continue
      updates.push({ id: rule.id, before: action, after: { ...action, set_category: name } })
    }
    const ts = nowIso()
    db.prepare('UPDATE categories SET name=?,updated_at=? WHERE id=?').run(name, ts, row.id)
    writeAudit(db, {
      entity_type: 'category', entity_id: row.id, changed_by: 'user', change_type: 'update',
      before_value: { name: row.name, kind: row.kind }, after_value: { name, kind: row.kind }, reasoning: '分类改名',
    })
    for (const update of updates) {
      db.prepare('UPDATE rules SET action=?,updated_at=? WHERE id=?').run(JSON.stringify(update.after), ts, update.id)
      writeAudit(db, {
        entity_type: 'rule', entity_id: update.id, changed_by: 'user', change_type: 'update',
        before_value: { action: update.before }, after_value: { action: update.after }, reasoning: '分类改名，同方向分类习惯跟随',
      })
    }
  })()
}
