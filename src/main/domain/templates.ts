// 快捷记账模板（第八阶段）。v3 已建表，v5 补 variant_id / use_count。
// 用途：把一次常用记账（如「猫粮 1kg × 1 件 微信收入」）存成模板，下次一键带出全部字段。
// 排序：常用优先（use_count 降序），其次新建在前。

import type { Database } from 'better-sqlite3-multiple-ciphers'
import { nowIso } from '../db/time'

/** 模板可覆盖的记账类型。 */
export type TemplateKind = 'sale' | 'purchase' | 'expense' | 'refund' | 'cs_income' | 'other'

export const TEMPLATE_KINDS: readonly TemplateKind[] = ['sale', 'purchase', 'expense', 'refund', 'cs_income', 'other'] as const

export interface QuickTemplate {
  id: number
  name: string
  kind: TemplateKind
  product_id: number | null
  variant_id: number | null
  channel: string | null
  default_qty: number | null
  default_price_cents: number | null
  note: string | null
  use_count: number
}

/** 带商品/规格名的展示用模板。 */
export interface QuickTemplateView extends QuickTemplate {
  product_name: string | null
  brand: string | null
  variant_name: string | null
}

export interface CreateTemplateInput {
  name: string
  kind: TemplateKind
  product_id?: number | null
  variant_id?: number | null
  channel?: string | null
  default_qty?: number | null
  default_price_cents?: number | null
  note?: string | null
}

export interface UpdateTemplateInput {
  id: number
  name?: string
  channel?: string | null
  default_qty?: number | null
  default_price_cents?: number | null
  note?: string | null
  product_id?: number | null
  variant_id?: number | null
}

function assertKind(kind: string): TemplateKind {
  if (!(TEMPLATE_KINDS as readonly string[]).includes(kind)) {
    throw new Error(`模板类型无效：${kind}`)
  }
  return kind as TemplateKind
}

/** 全部模板（带商品/规格名），常用优先。 */
export function listTemplates(db: Database, kind?: TemplateKind): QuickTemplateView[] {
  const where = kind ? 'WHERE t.kind = ?' : ''
  const args = kind ? [assertKind(kind)] : []
  return db.prepare(`
    SELECT t.*, p.name AS product_name, p.brand AS brand, v.spec_name AS variant_name
    FROM quick_templates t
    LEFT JOIN products p ON p.id = t.product_id
    LEFT JOIN product_variants v ON v.id = t.variant_id
    ${where}
    ORDER BY t.use_count DESC, t.id DESC
  `).all(...args) as unknown as QuickTemplateView[]
}

export function getTemplate(db: Database, id: number): QuickTemplateView | null {
  return (db.prepare(`
    SELECT t.*, p.name AS product_name, p.brand AS brand, v.spec_name AS variant_name
    FROM quick_templates t
    LEFT JOIN products p ON p.id = t.product_id
    LEFT JOIN product_variants v ON v.id = t.variant_id
    WHERE t.id = ?
  `).get(id) as QuickTemplateView | undefined) ?? null
}

/** 新建模板。同名同类型视为重复，拒绝。 */
export function createTemplate(db: Database, input: CreateTemplateInput): number {
  const ts = nowIso()
  const name = input.name.trim()
  if (!name) throw new Error('模板名称不能为空')
  const kind = assertKind(input.kind)
  const dup = db
    .prepare('SELECT id FROM quick_templates WHERE name = ? AND kind = ?')
    .get(name, kind) as { id: number } | undefined
  if (dup) throw new Error(`已存在同名模板「${name}」`)
  // 有规格时必须与商品匹配
  if (input.variant_id != null) {
    const v = db
      .prepare('SELECT product_id FROM product_variants WHERE id = ?')
      .get(input.variant_id) as { product_id: number } | undefined
    if (!v) throw new Error(`规格 #${input.variant_id} 不存在`)
    if (input.product_id != null && v.product_id !== input.product_id) {
      throw new Error('规格与商品不匹配')
    }
  }
  const r = db.prepare(
    'INSERT INTO quick_templates' +
      ' (name, kind, product_id, variant_id, channel, default_qty, default_price_cents, note, use_count, created_at, updated_at)' +
      ' VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?)',
  ).run(
    name, kind, input.product_id ?? null, input.variant_id ?? null,
    input.channel ?? null, input.default_qty ?? null, input.default_price_cents ?? null,
    input.note ?? null, ts, ts,
  )
  return Number(r.lastInsertRowid)
}

/** 修改模板（不改 kind，避免模板语义漂移）。 */
export function updateTemplate(db: Database, input: UpdateTemplateInput): void {
  const t = getTemplate(db, input.id)
  if (!t) throw new Error(`模板 #${input.id} 不存在`)
  const ts = nowIso()
  const sets: string[] = []
  const args: unknown[] = []
  if (input.name !== undefined) {
    const name = input.name.trim()
    if (!name) throw new Error('模板名称不能为空')
    const dup = db
      .prepare('SELECT id FROM quick_templates WHERE name = ? AND kind = ? AND id <> ?')
      .get(name, t.kind, t.id) as { id: number } | undefined
    if (dup) throw new Error(`已存在同名模板「${name}」`)
    sets.push('name = ?'); args.push(name)
  }
  if (input.channel !== undefined) { sets.push('channel = ?'); args.push(input.channel) }
  if (input.default_qty !== undefined) { sets.push('default_qty = ?'); args.push(input.default_qty) }
  if (input.default_price_cents !== undefined) { sets.push('default_price_cents = ?'); args.push(input.default_price_cents) }
  if (input.note !== undefined) { sets.push('note = ?'); args.push(input.note) }
  if (input.product_id !== undefined) { sets.push('product_id = ?'); args.push(input.product_id) }
  if (input.variant_id !== undefined) { sets.push('variant_id = ?'); args.push(input.variant_id) }
  if (sets.length === 0) return
  sets.push('updated_at = ?'); args.push(ts, input.id)
  db.prepare(`UPDATE quick_templates SET ${sets.join(', ')} WHERE id = ?`).run(...args)
}

export function deleteTemplate(db: Database, id: number): void {
  const r = db.prepare('DELETE FROM quick_templates WHERE id = ?').run(id)
  if (r.changes === 0) throw new Error(`模板 #${id} 不存在`)
}

/** 套用模板时累加使用次数（用于「常用优先」排序）。 */
export function touchTemplate(db: Database, id: number): void {
  db.prepare('UPDATE quick_templates SET use_count = use_count + 1, updated_at = ? WHERE id = ?')
    .run(nowIso(), id)
}

/** 各类型的模板数量（用于 Tab 角标/统计）。 */
export function templateCounts(db: Database): Record<TemplateKind, number> {
  const rows = db.prepare('SELECT kind, COUNT(*) AS c FROM quick_templates GROUP BY kind').all() as unknown as { kind: string; c: number }[]
  const out = { sale: 0, purchase: 0, expense: 0, refund: 0, cs_income: 0, other: 0 } as Record<TemplateKind, number>
  for (const r of rows) {
    if ((TEMPLATE_KINDS as readonly string[]).includes(r.kind)) out[r.kind as TemplateKind] = r.c
  }
  return out
}