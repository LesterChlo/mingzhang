// 待收尾 / 确认门（票 01 规格 + 决定记录 §3 L2）：
//   - pending_clarifications 表落库持久化，新开对话不丢事；
//   - delete / commit_batch 的 gate 同表承载（field='delete_confirm' | 'batch_confirm'），
//     补答通道对 gate 类事项拒绝 —— 确认信号只认 UI 按钮。
// 阶段 1 仅实现 needs_review 确认桥（field='confirm_record'）；其余阶段 2 补齐。

import type { Database } from 'better-sqlite3-multiple-ciphers'
import { nowIso } from '../db/time'

/** 需要 UI 按钮确认的事项类型。这些 field 永远不能被"对话补答"关闭。 */
export const GATE_FIELDS = new Set(['delete_confirm', 'batch_confirm', 'batch_classify'])

export interface PendingRow {
  id: number
  tx_id: number | null
  session_id: string
  field: string
  question: string
  rounds: number
  payload: string
  revision: number
  status: 'open' | 'resolved' | 'cancelled'
}

export function createPending(
  db: Database,
  input: {
    txId?: number | null
    sessionId: string
    field: string
    question: string
    payload?: Record<string, unknown>
  },
): number {
  const cur = db
    .prepare(
      'INSERT INTO pending_clarifications (tx_id, session_id, field, question, rounds, payload, revision, status, created_at, updated_at)' +
        " VALUES (?, ?, ?, ?, 1, ?, 1, 'open', ?, ?)",
    )
    .run(
      input.txId ?? null,
      input.sessionId,
      input.field,
      input.question,
      JSON.stringify(input.payload ?? {}),
      nowIso(),
      nowIso(),
    )
  return Number(cur.lastInsertRowid)
}

export function getPending(db: Database, id: number): PendingRow | null {
  return (
    (db.prepare('SELECT * FROM pending_clarifications WHERE id = ?').get(id) as PendingRow | undefined) ?? null
  )
}

export function findOpenByTxAndField(
  db: Database,
  txId: number,
  field: string,
): PendingRow | null {
  const row = db
    .prepare(
      "SELECT * FROM pending_clarifications WHERE tx_id = ? AND field = ? AND status = 'open' ORDER BY id DESC LIMIT 1",
    )
    .get(txId, field) as PendingRow | undefined
  return row ?? null
}

export function listOpen(db: Database): PendingRow[] {
  return db
    .prepare("SELECT * FROM pending_clarifications WHERE status = 'open' ORDER BY id")
    .all() as unknown as PendingRow[]
}

/** B：payload 里的首个来源附件（attachments/ 相对文件名）——待收尾预览用；无则 null。 */
export function firstAttachmentRef(payloadJson: string | null): string | null {
  if (!payloadJson) return null
  try {
    const p = JSON.parse(payloadJson) as { attachments?: unknown }
    const arr = Array.isArray(p.attachments) ? p.attachments : []
    return typeof arr[0] === 'string' && arr[0] ? arr[0] : null
  } catch {
    return null
  }
}

/** 关闭 pending（确认/取消）。revision 校验防重复作答（spec 验收 5）。 */
export function closePending(
  db: Database,
  id: number,
  status: 'resolved' | 'cancelled',
  expectedRevision?: number,
): PendingRow | null {
  const row = getPending(db, id)
  if (!row) return null
  if (row.status !== 'open') return null
  if (expectedRevision !== undefined && row.revision !== expectedRevision) return null
  db.prepare('UPDATE pending_clarifications SET status = ?, updated_at = ? WHERE id = ?').run(
    status,
    nowIso(),
    id,
  )
  return getPending(db, id)
}
