// D-01 批量归类（两段式确认门，与 delete / commit_batch 同形）。
//
// 铁律（别越界）：
//   1) buildClassifyProposal / prepareClassify **只读或只落 gate**，绝不写交易；
//   2) 写入只发生在 applyClassify —— 唯一入口 = 用户在界面上点确认 → IPC → 这里；
//   3) 建议只用纯查询：matchRule（纯查 rules 表）+ matchBuiltinCategory（静态表）。
//      **绝不用 classifyByMerchant** —— 它内部 applyRules 会 getOrCreateCategoryId + bumpHit，
//      那是写库，会污染分类表与规则命中数（本函数的整个存在意义就是"只读地给建议"）。
//   4) 审计一律带 source_message_id = classifyId，undoClassify 靠它定位与回退。

import type { Database } from 'better-sqlite3-multiple-ciphers'
import { nowIso } from '../db/time'
import {
  confirm as confirmTx,
  getOrCreateCategoryId,
  getTransaction,
  requestReview,
  snapshot,
  updateFields,
  writeAudit,
  type TxSnapshot,
} from './ledger'
import { closePending, createPending, findOpenByTxAndField, getPending } from './pending'
import { matchBuiltinCategory } from './builtin-categories'
import { matchRule } from './rules'
import type {
  ClassifyAssignmentInput,
  ClassifyGroupDTO,
  ClassifyPlanCardData,
  ClassifyPlanGroupDTO,
  ClassifyProposalDTO,
  ClassifyResultDTO,
  ClassifyUndoResultDTO,
} from '../../shared/types'

/** 门 field 名（两段式第二段的标记；与 GATE_FIELDS 同族的独立 field）。 */
export const CLASSIFY_GATE_FIELD = 'batch_classify'

/** 无商户名的组在 groupKey 里的占位（展示名仍是 null）。 */
export const UNLABELED_KEY = '__unlabeled__'

/** 商户名归一：trim → 全角空格转半角 → 连续空白折叠为一个半角空格。 */
function normalizeMerchant(raw: string | null | undefined): string {
  const s = (raw ?? '').replace(/　/g, ' ').trim()
  if (!s) return UNLABELED_KEY
  return s.replace(/\s+/g, ' ')
}

function groupKeyOf(txType: string, normalized: string): string {
  return `${txType}::${normalized}`
}

// ---------------------------------------------------------------- 只读建议

interface PendingRow {
  id: number
  type: 'expense' | 'income'
  amount_cents: number
  merchant: string | null
  source_message_id: string | null
}

/**
 * 待分类集合（口径与批次结果条 needsCategory 一致）：needs_review + 无分类 + 收支类。
 * 给了 batchId 再按 source_message_id 收窄。
 */
function listPendingClassifiable(db: Database, batchId?: string | null): PendingRow[] {
  const sql =
    "SELECT id, type, amount_cents, merchant, source_message_id FROM transactions" +
    " WHERE state = 'needs_review' AND category_id IS NULL AND type IN ('expense','income')" +
    (batchId ? ' AND source_message_id = ?' : '') +
    ' ORDER BY id'
  const rows = (batchId ? db.prepare(sql).all(batchId) : db.prepare(sql).all()) as unknown as PendingRow[]
  return rows
}

/** 建议分类：用户规则 ＞ 常识表 ＞ 都没有。**纯读**（不建分类、不 bumpHit）。 */
function suggestFor(db: Database, merchant: string | null, txType: 'expense' | 'income'): {
  suggestedCategory: string | null
  suggestionSource: 'rule' | 'builtin' | null
} {
  if (!merchant) return { suggestedCategory: null, suggestionSource: null }
  const rule = matchRule(db, merchant)
  if (rule) {
    try {
      const action = JSON.parse(rule.action) as { set_category?: unknown }
      const name = typeof action.set_category === 'string' ? action.set_category.trim() : ''
      if (name) return { suggestedCategory: name, suggestionSource: 'rule' }
    } catch {
      // action 损坏：落回常识表
    }
  }
  const builtin = matchBuiltinCategory(merchant, txType)
  if (builtin) return { suggestedCategory: builtin, suggestionSource: 'builtin' }
  return { suggestedCategory: null, suggestionSource: null }
}

/** 只读建议：现在有哪些待分类、怎么分组、建议给什么分类。**不写任何一行。** */
export function buildClassifyProposal(db: Database, opts?: { batchId?: string | null }): ClassifyProposalDTO {
  const batchId = opts?.batchId ?? null
  const rows = listPendingClassifiable(db, batchId)

  const byKey = new Map<string, ClassifyGroupDTO & { order: number }>()
  for (const r of rows) {
    const normalized = normalizeMerchant(r.merchant)
    const key = groupKeyOf(r.type, normalized)
    let g = byKey.get(key)
    if (!g) {
      const suggestion = suggestFor(db, r.merchant, r.type)
      g = {
        groupKey: key,
        merchant: r.merchant,
        txType: r.type,
        txIds: [],
        count: 0,
        totalCents: 0,
        suggestedCategory: suggestion.suggestedCategory,
        suggestionSource: suggestion.suggestionSource,
        order: byKey.size,
      }
      byKey.set(key, g)
    }
    // 展示名取组内第一个非空原始商户名
    if (g.merchant === null && r.merchant) g.merchant = r.merchant
    g.txIds.push(r.id)
    g.count += 1
    g.totalCents += r.amount_cents
  }

  const groups = [...byKey.values()]
    .sort((a, b) => b.count - a.count || Math.abs(b.totalCents) - Math.abs(a.totalCents) || (a.groupKey < b.groupKey ? -1 : a.groupKey > b.groupKey ? 1 : 0))
    .map(({ order: _order, ...g }) => {
      g.txIds.sort((a, b) => a - b)
      return g
    })

  return {
    generatedAt: nowIso(),
    batchId,
    pendingCount: rows.length,
    groups,
  }
}

// ---------------------------------------------------------------- 落方案（不写账）

interface GatePayload {
  classifyId: string
  batchId: string | null
  groups: ClassifyPlanGroupDTO[]
}

/**
 * 落方案：校验 → 生成 classifyId → 落 gate。**绝不写交易。**
 * 返回 { gateId, classifyId, plan }。
 */
export function prepareClassify(
  db: Database,
  input: {
    assignments: ClassifyAssignmentInput[]
    batchId?: string | null
    sessionId: string
    sourceMessageId?: string | null
  },
): { gateId: number; classifyId: string; plan: { groups: ClassifyPlanGroupDTO[] } } {
  const assignments = input.assignments ?? []
  if (assignments.length === 0) throw new Error('归类方案为空：没有指定任何分组')

  const batchId = input.batchId ?? null
  const proposal = buildClassifyProposal(db, { batchId })
  const byKey = new Map(proposal.groups.map((g) => [g.groupKey, g]))

  const groups: ClassifyPlanGroupDTO[] = []
  const seen = new Set<string>()
  for (const a of assignments) {
    const key = String(a?.groupKey ?? '')
    const g = byKey.get(key)
    if (!g) throw new Error(`未知分组：${key}（当前待分类集合里没有这一组，请重新读取建议）`)
    const name = String(a?.categoryName ?? '').trim()
    if (!name) throw new Error(`分组 ${key} 的分类名为空`)
    if (seen.has(key)) continue // 同一组重复给 → 以后一个为准，避免重复入账
    seen.add(key)
    groups.push({
      groupKey: g.groupKey,
      merchant: g.merchant,
      txType: g.txType,
      txIds: [...g.txIds],
      count: g.count,
      totalCents: g.totalCents,
      categoryName: name,
    })
  }

  const classifyId = `cls-${nowIso()}-${Math.random().toString(36).slice(2, 8)}`
  const payload: GatePayload = { classifyId, batchId, groups }
  const gateId = createPending(db, {
    txId: null,
    sessionId: input.sessionId,
    field: CLASSIFY_GATE_FIELD,
    question: '批量归类待确认',
    payload: payload as unknown as Record<string, unknown>,
  })
  return { gateId, classifyId, plan: { groups } }
}

export function buildClassifyCard(db: Database, gateId: number): ClassifyPlanCardData | null {
  const gate = getPending(db, gateId)
  if (!gate || gate.field !== CLASSIFY_GATE_FIELD) return null
  let p: GatePayload
  try {
    p = JSON.parse(gate.payload) as GatePayload
  } catch {
    return null
  }
  if (!p || typeof p.classifyId !== 'string' || !Array.isArray(p.groups)) return null
  const groups: ClassifyPlanGroupDTO[] = p.groups
    .filter((g) => g && typeof g.groupKey === 'string')
    .map((g) => ({
      groupKey: g.groupKey,
      merchant: g.merchant ?? null,
      txType: g.txType === 'income' ? 'income' : 'expense',
      txIds: Array.isArray(g.txIds) ? g.txIds : [],
      count: typeof g.count === 'number' ? g.count : (Array.isArray(g.txIds) ? g.txIds.length : 0),
      totalCents: typeof g.totalCents === 'number' ? g.totalCents : 0,
      categoryName: typeof g.categoryName === 'string' && g.categoryName.trim() ? g.categoryName : null,
    }))
  let assignedCount = 0
  let unassignedCount = 0
  for (const g of groups) {
    if (g.categoryName) assignedCount += g.count
    else unassignedCount += g.count
  }
  return {
    kind: 'classify-plan',
    gateId: gate.id,
    classifyId: p.classifyId,
    batchId: p.batchId ?? null,
    groups,
    assignedCount,
    unassignedCount,
  }
}

// ---------------------------------------------------------------- 执行（唯一写账入口）

interface PlanRow {
  groupKey: string
  merchant: string | null
  categoryName: string | null
  txIds: number[]
}

/**
 * 执行归类 gate（仅 UI 确认按钮调用）。整个执行包在**单个事务**里（要么全成，要么全不动）。
 * gate 不存在 / 已关闭 / 类型不符 → null（照 executeDeleteGate 的写法）。
 * rows 缺省 = 方案里的 groups；给了 rows 就以 rows 为准（用户改选后的最终映射）。
 */
export function applyClassify(db: Database, gateId: number, rows?: ClassifyAssignmentInput[]): ClassifyResultDTO | null {
  const gate = getPending(db, gateId)
  if (!gate || gate.status !== 'open' || gate.field !== CLASSIFY_GATE_FIELD) return null

  let payload: GatePayload
  try {
    payload = JSON.parse(gate.payload) as GatePayload
  } catch {
    return null
  }
  const classifyId = payload.classifyId
  if (typeof classifyId !== 'string' || !classifyId) return null

  // rows 覆盖方案：按 groupKey 换分类名；方案外的分组忽略（不擅自入账方案里没有的笔）
  const override = new Map<string, string>()
  for (const r of rows ?? []) {
    const name = String(r?.categoryName ?? '').trim()
    if (name) override.set(String(r?.groupKey ?? ''), name)
  }
  const plan: PlanRow[] = (Array.isArray(payload.groups) ? payload.groups : []).map((g) => ({
    groupKey: g.groupKey,
    merchant: g.merchant ?? null,
    categoryName: override.has(g.groupKey) ? override.get(g.groupKey)! : (g.categoryName ?? null),
    txIds: Array.isArray(g.txIds) ? g.txIds : [],
  }))

  const result: ClassifyResultDTO = {
    gateId,
    classifyId,
    batchId: payload.batchId ?? null,
    appliedCount: 0,
    appliedGroups: [],
    skipped: [],
  }

  db.transaction((): void => {
    for (const group of plan) {
      let appliedInGroup = 0
      for (const txId of group.txIds) {
        const tx = getTransaction(db, txId)
        if (!tx) {
          result.skipped.push({ txId, reason: `#${txId} 不存在` })
          continue
        }
        if (tx.state === 'deleted') {
          result.skipped.push({ txId, reason: '已删除' })
          continue
        }
        if (tx.state === 'confirmed') {
          result.skipped.push({ txId, reason: '已入账，无需重复' })
          continue
        }
        const name = (group.categoryName ?? '').trim()
        if (!name) {
          result.skipped.push({ txId, reason: '未定分类' })
          continue
        }
        if (tx.type !== 'expense' && tx.type !== 'income') {
          result.skipped.push({ txId, reason: '非收支类不参与归类' })
          continue
        }
        // 逐笔镜像 doConfirmRecord 的单笔确认链，审计带 classifyId（撤销靠它定位）
        const categoryId = getOrCreateCategoryId(db, name, tx.type, { changedBy: 'user' })
        updateFields(db, txId, { category_id: categoryId }, { reasoning: '批量归类（用户确认）', sourceMessageId: classifyId })
        const review = findOpenByTxAndField(db, txId, 'confirm_record')
        if (review) closePending(db, review.id, 'resolved')
        confirmTx(db, txId, { reasoning: '批量归类（用户确认）', sourceMessageId: classifyId })
        result.appliedCount += 1
        appliedInGroup += 1
      }
      if (appliedInGroup > 0) {
        result.appliedGroups.push({ merchant: group.merchant, categoryName: group.categoryName!, count: appliedInGroup })
      }
    }
    closePending(db, gateId, 'resolved')
  })()

  return result
}

// ---------------------------------------------------------------- 撤销

interface AuditRow {
  id: number
  entity_id: number
  change_type: string
  before_value: string | null
  source_message_id: string | null
}

/**
 * 整体撤销一次批量归类（按 classifyId 定位）。
 * 每笔保护：该笔**最新**一条审计若不是本 classifyId 产生 → 不撤销（这之后用户又改过）。
 * 幂等：重复撤销 → revertedCount=0 + skipped 说明。
 */
export function undoClassify(db: Database, classifyId: string): ClassifyUndoResultDTO {
  const result: ClassifyUndoResultDTO = { classifyId, revertedCount: 0, skipped: [] }
  if (!classifyId) return result

  const txIds = (
    db
      .prepare(
        "SELECT DISTINCT entity_id AS txId FROM audit_log WHERE entity_type='transaction' AND source_message_id = ? ORDER BY entity_id",
      )
      .all(classifyId) as { txId: number }[]
  ).map((r) => r.txId)

  for (const txId of txIds) {
    const latest = db
      .prepare("SELECT id, entity_id, change_type, before_value, source_message_id FROM audit_log WHERE entity_type='transaction' AND entity_id=? ORDER BY id DESC LIMIT 1")
      .get(txId) as AuditRow | undefined
    if (!latest) {
      result.skipped.push({ txId, reason: '找不到审计记录' })
      continue
    }
    if (latest.source_message_id !== classifyId) {
      result.skipped.push({ txId, reason: '这之后被改过，未撤销' })
      continue
    }
    // 该笔本次归类产生的最早一条审计 → before_value 即归类前的样子
    const first = db
      .prepare("SELECT id, entity_id, change_type, before_value, source_message_id FROM audit_log WHERE entity_type='transaction' AND entity_id=? AND source_message_id=? ORDER BY id ASC LIMIT 1")
      .get(txId, classifyId) as AuditRow | undefined
    if (!first) {
      result.skipped.push({ txId, reason: '找不到本次归类的审计' })
      continue
    }
    // 已经是撤销态（回退后又被同一次 classify 撤销过）→ 幂等跳过
    let before: Partial<TxSnapshot> | null = null
    try {
      before = JSON.parse(first.before_value ?? '') as Partial<TxSnapshot> | null
    } catch {
      before = null
    }
    const targetState = before?.state ?? 'needs_review'
    const targetCategory = before?.category_id ?? null
    const tx = getTransaction(db, txId)
    if (!tx) {
      result.skipped.push({ txId, reason: `#${txId} 不存在` })
      continue
    }
    if (tx.state === targetState && (tx.category_id ?? null) === targetCategory) {
      result.skipped.push({ txId, reason: '已撤销过，无需重复' })
      continue
    }
    const beforeSnap = snapshot(db, txId)
    db.prepare('UPDATE transactions SET state=?, category_id=?, updated_at=? WHERE id=?').run(
      targetState,
      targetCategory,
      nowIso(),
      txId,
    )
    writeAudit(db, {
      entity_type: 'transaction',
      entity_id: txId,
      changed_by: 'user',
      change_type: 'update',
      before_value: beforeSnap,
      after_value: snapshot(db, txId),
      source_message_id: classifyId,
      reasoning: '撤销批量归类',
    })
    // 重建待办：回到 needs_review 就得重新有一件"待分类"的事
    if (targetState === 'needs_review' && !findOpenByTxAndField(db, txId, 'confirm_record')) {
      requestReview(db, txId, { reason: '撤销批量归类', sourceMessageId: classifyId })
      createPending(db, {
        txId,
        sessionId: 'undo',
        field: 'confirm_record',
        question: '批量归类已撤销，待重新分类',
        payload: { txId, reason: '撤销批量归类' },
      })
    }
    result.revertedCount += 1
  }
  return result
}
