// 确认门（决定记录 §3 L2）：delete / commit_batch 两段式。
// 工具只 prepare（生成 gate，落 pending_clarifications），执行入口唯一 = UI 按钮 → IPC → 这里。
// 补答通道对 gate 类事项拒绝（GATE_FIELDS）——模型侧"确认"永远到不了执行层。

import type { Database } from 'better-sqlite3-multiple-ciphers'
import { softDelete, snapshot, getTransaction, type TxSnapshot } from './ledger'
import { createPending, getPending, closePending, listOpen, findOpenByTxAndField, type PendingRow } from './pending'
import { buildClassifyCard } from './classify'
import { buildCard } from './cards'
import type { BatchGateCardData, CardData, DeleteGateCardData } from '../../shared/types'

export interface GateInfo {
  gate: PendingRow
  txId: number
}

/** 删除待确认：校验交易可删 → 落 gate（已有未决 gate 则复用）。返回 gateId。 */
export function prepareDeleteGate(
  db: Database,
  input: { txId: number; sessionId: string; sourceMessageId?: string | null },
): { gateId: number; snapshot: TxSnapshot } {
  const tx = db.prepare('SELECT id, state FROM transactions WHERE id=?').get(input.txId) as
    | { id: number; state: string }
    | undefined
  if (!tx) throw new Error(`交易 #${input.txId} 不存在`)
  if (tx.state === 'deleted') throw new Error(`交易 #${input.txId} 已是删除状态`)
  const snap = snapshot(db, input.txId)
  if (!snap) throw new Error(`交易 #${input.txId} 不存在`)
  const existing = db
    .prepare('SELECT id FROM pending_clarifications WHERE tx_id=? AND field=? AND status=? ORDER BY id DESC LIMIT 1')
    .get(input.txId, 'delete_confirm', 'open') as { id: number } | undefined
  if (existing) return { gateId: existing.id, snapshot: snap }
  const gateId = createPending(db, {
    txId: input.txId,
    sessionId: input.sessionId,
    field: 'delete_confirm',
    question: '删除这笔交易（等待用户在界面上确认）',
    payload: { txId: input.txId, snapshot: snap },
  })
  return { gateId, snapshot: snap }
}

/** 执行删除 gate（UI 按钮调用）。gate 不存在/已关闭/类型不符 → null。 */
export function executeDeleteGate(db: Database, gateId: number): { txId: number } | null {
  const gate = getPending(db, gateId)
  if (!gate || gate.status !== 'open' || gate.field !== 'delete_confirm') return null
  const payload = JSON.parse(gate.payload) as { txId: number }
  softDelete(db, payload.txId, { reasoning: '用户在界面上确认删除' })
  // 第 6 单 段1-2：交易已删除 → 它挂着的"入账待确认"事项随之作废（否则待办/历史卡片留一个改了会报错的死入口）
  const review = findOpenByTxAndField(db, payload.txId, 'confirm_record')
  if (review) closePending(db, review.id, 'cancelled')
  closePending(db, gateId, 'resolved')
  return { txId: payload.txId }
}

/** A2：为 open 的 delete/batch gate 就地重建原卡片（数据在 DB，渲染组件现成）——待收尾可直接执行。 */
export function buildOpenGateCards(db: Database): { gateId: number; field: string; card: CardData }[] {
  const out: { gateId: number; field: string; card: CardData }[] = []
  for (const gate of listOpen(db)) {
    if (gate.field === 'delete_confirm') {
      const tx = getTransaction(db, gate.tx_id ?? -1)
      if (!tx) continue
      const card: DeleteGateCardData = { kind: 'delete-gate', gateId: gate.id, tx: buildCard(db, tx).tx }
      out.push({ gateId: gate.id, field: gate.field, card })
    } else if (gate.field === 'batch_confirm') {
      try {
        const { plan } = JSON.parse(gate.payload) as {
          plan: {
            batchId: string
            channel: string | null
            newCount: number
            duplicateCount: number
            unparsedCount: number
            rowsConsidered?: number | null
            skippedCount?: number
            items: { status: string; merchant: string | null; amountCents: number | null; reason?: string | null; rowNo?: number | null }[]
          }
        }
        const card: BatchGateCardData = {
          kind: 'batch-gate',
          gateId: gate.id,
          channel: plan.channel ?? null,
          newCount: plan.newCount,
          duplicateCount: plan.duplicateCount,
          unparsedCount: plan.unparsedCount,
          rowsConsidered: plan.rowsConsidered ?? null,
          skippedCount: plan.skippedCount ?? 0,
          items: plan.items.map((it) => ({
            status: it.status as 'new' | 'duplicate' | 'unparsed',
            merchant: it.merchant ?? null,
            amountCents: it.amountCents ?? null,
            reason: it.reason ?? null,
            rowNo: it.rowNo ?? null,
          })),
        }
        out.push({ gateId: gate.id, field: gate.field, card })
      } catch {
        // payload 损坏：跳过该 gate（仍可在对话里处理）
      }
    } else if (gate.field === 'batch_classify') {
      // D-01 批量归类：payload 里就是映射表，重建即渲染（改动只增分支，既有分支一律不动）
      const card = buildClassifyCard(db, gate.id)
      if (card) out.push({ gateId: gate.id, field: gate.field, card })
    }
  }
  return out
}

/** 取消 gate（任意类型）。 */
export function cancelGate(db: Database, gateId: number): boolean {
  const gate = getPending(db, gateId)
  if (!gate || gate.status !== 'open') return false
  return closePending(db, gateId, 'cancelled') !== null
}
