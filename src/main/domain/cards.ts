// 卡片装配：把交易行渲染成渲染层卡片 DTO。域层职责（知道 DTO 不碰引擎）。

import type { Database } from 'better-sqlite3-multiple-ciphers'
import type { TransactionFull } from './ledger'
import type { TransactionCardData } from '../../shared/types'

export function buildCard(
  db: Database,
  tx: TransactionFull,
  opts: {
    reviewReason?: string | null
    gateId?: number
    ruleHit?: { ruleId: number; categoryName: string } | null
  } = {},
): TransactionCardData {
  const accName = (db.prepare('SELECT name FROM accounts WHERE id=?').get(tx.account_id) as { name: string } | undefined)?.name ?? null
  const catName = tx.category_id
    ? (db.prepare('SELECT name FROM categories WHERE id=?').get(tx.category_id) as { name: string } | undefined)?.name ?? null
    : null
  const toAccName = tx.to_account_id
    ? (db.prepare('SELECT name FROM accounts WHERE id=?').get(tx.to_account_id) as { name: string } | undefined)?.name ?? null
    : null
  return {
    kind: 'transaction',
    gateId: opts.gateId,
    tx: {
      id: tx.id,
      amountCents: tx.amount_cents,
      type: tx.type,
      merchant: tx.merchant,
      categoryName: catName,
      accountName: accName,
      toAccountName: toAccName,
      occurredAt: tx.occurred_at,
      state: tx.state,
      confidenceScore: tx.confidence_score,
      note: tx.note,
    },
    reviewReason: opts.reviewReason ?? null,
    ruleHit: opts.ruleHit ?? null,
  }
}

export function txOf(db: Database, txId: number): TransactionFull {
  const tx = getTransactionOf(db, txId)
  if (!tx) throw new Error(`交易 #${txId} 不存在`)
  return tx
}

function getTransactionOf(db: Database, txId: number): TransactionFull | null {
  return (db.prepare('SELECT * FROM transactions WHERE id = ?').get(txId) as TransactionFull | undefined) ?? null
}
