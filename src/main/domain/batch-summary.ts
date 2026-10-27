// 批次结果读回（D-03a）——批次一键入账后，「刚才那批到底发生了什么」的**事实口径**。
//
// 为什么要有这条通道：gate-executed 事件里的 result 只活在一轮对话的内存里，
// 应用一重启就什么都没了；而用户 126 笔入账后剩 38 笔待确认，界面必须**还能**说清这件事。
// 所以这里的数字一律从库里现算，绝不依赖任何内存态：
//   - 已入账 / 待分类：查 transactions（批次归属 = source_message_id = plan.batchId）
//   - 重复 / 不计收支 / 待核对：取 plan（方案原话，不重算、不猜）
//   - 逐行明细：重复取 plan.items，不计收支取套表时冻结的 plan.excludedRows；
//     旧批未保存可靠明细时为 null，不拿空数组冒充，也不重读可变原表。
//
// 口径边界（与既有事实层一致）：
//   待分类（needs_review 且无分类）⊂ 已入账；state='deleted' 一律排除。

import type { Database } from 'better-sqlite3-multiple-ciphers'
import { readBatchExcludedRows, type BatchPlan, type BatchPlanItem } from './batch'

export type { BatchResultSummaryDTO } from '../../shared/types'
import type { BatchResultSummaryDTO } from '../../shared/types'

interface GateRow {
  id: number
  payload: string
  status: string
  updated_at: string
}

/**
 * 取「已执行」的批次确认门：field='batch_confirm' 且 status='resolved'，按更新时间倒序取一条。
 * open / cancelled 都不是执行结果：未确认或已取消的方案不能冒充已执行。
 */
function pickGate(db: Database, gateId?: number): GateRow | null {
  const sql =
    "SELECT id, payload, status, updated_at FROM pending_clarifications" +
    " WHERE field = 'batch_confirm' AND status = 'resolved'" +
    (gateId === undefined ? '' : ' AND id = ?') +
    ' ORDER BY updated_at DESC, id DESC LIMIT 1'
  const row = (gateId === undefined ? db.prepare(sql).get() : db.prepare(sql).get(gateId)) as GateRow | undefined
  return row ?? null
}

function parsePlan(payload: string): BatchPlan | null {
  try {
    const p = JSON.parse(payload) as { plan?: BatchPlan }
    const plan = p.plan
    if (!plan || typeof plan.batchId !== 'string' || plan.batchId === '' ||
      !Number.isSafeInteger(plan.importId) || plan.importId <= 0 || !Array.isArray(plan.items) ||
      plan.items.some((item) => !item || !['new', 'duplicate', 'unparsed'].includes(item.status))) return null
    const counts = [plan.newCount, plan.duplicateCount, plan.unparsedCount, plan.skippedCount]
    if (counts.some((n) => n != null && (!Number.isSafeInteger(n) || n < 0))) return null
    if (plan.newCount !== plan.items.filter((item) => item.status === 'new').length ||
      plan.duplicateCount !== plan.items.filter((item) => item.status === 'duplicate').length ||
      plan.unparsedCount !== plan.items.filter((item) => item.status === 'unparsed').length) return null
    return plan
  } catch {
    // payload 损坏：读不出事实就返回 null，界面不显示结果条（不编数字）
    return null
  }
}

/** 重复项 → 逐行明细（商户 / 金额 / 原因，逐字取 plan 里的原话）。 */
function duplicateRows(items: BatchPlanItem[]): BatchResultSummaryDTO['duplicatesRows'] {
  return items
    .filter((it) => it.status === 'duplicate')
    .map((it) => ({
      merchant: it.merchant ?? null,
      amountCents: it.amountCents ?? null,
      reason: it.reason ?? '重复',
    }))
}

function summarize(db: Database, gate: GateRow): BatchResultSummaryDTO | null {
  const plan = parsePlan(gate.payload)
  if (!plan) return null

  // 本批次创建、未删除的交易（待分类也在这里：它是已入账但还没定分类）
  const booked = (
    db
      .prepare("SELECT COUNT(*) AS n FROM transactions WHERE source_message_id = ? AND state <> 'deleted'")
      .get(plan.batchId) as { n: number }
  ).n
  const needsCategory = (
    db
      .prepare(
        "SELECT COUNT(*) AS n FROM transactions WHERE source_message_id = ? AND state = 'needs_review' AND category_id IS NULL",
      )
      .get(plan.batchId) as { n: number }
  ).n

  // 只读当前待办归属；没有派生过待办的历史已关闭门才退回原plan口径。
  const exceptionRows = db.prepare("SELECT payload,status FROM pending_clarifications WHERE field IN ('batch_item','transfer_account')").all() as {payload:string;status:string}[]
  const own = exceptionRows.filter(r => {
    try {
      const p = JSON.parse(r.payload) as {batchId?:unknown;importId?:unknown}
      return p.batchId === plan.batchId || p.importId === plan.importId
    } catch { return false }
  })
  const unparsed = own.length > 0 ? own.filter(r => r.status === 'open').length : (plan.unparsedCount ?? 0)

  return {
    gateId: gate.id,
    batchId: plan.batchId,
    importId: plan.importId,
    executedAt: gate.updated_at,
    counts: {
      booked,
      needsCategory,
      excluded: plan.skippedCount ?? 0,
      duplicates: plan.duplicateCount ?? 0,
      unparsed,
    },
    duplicatesRows: duplicateRows(plan.items ?? []),
    excludedRows: readBatchExcludedRows(plan, (plan.items ?? []).map((item) => item.rowNo)),
  }
}

/** 按门 id 读回某一批的执行结果；门不存在 / 还没执行 / payload 损坏 → null。 */
export function getBatchSummary(db: Database, gateId: number): BatchResultSummaryDTO | null {
  const gate = pickGate(db, gateId)
  return gate ? summarize(db, gate) : null
}

/** 最近一次已执行的批次结果；一条都没执行过 → null。 */
export function getLatestBatchSummary(db: Database): BatchResultSummaryDTO | null {
  const gate = pickGate(db)
  return gate ? summarize(db, gate) : null
}
