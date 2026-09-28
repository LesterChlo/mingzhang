// 待收尾续办（第 4 单 A）：把"对话补答"的域层路径抽成共享函数——
// 对话补答（pending 工具）与待收尾面板就地回答（IPC）走同一条路径：
// gate 类拒绝 / 分类与金额语义 / revision 校验 / 答案进审计 / 幂等（已关闭即报错）。

import type { Database } from 'better-sqlite3-multiple-ciphers'
import { getOrCreateCategoryId, updateFields, confirm as confirmTx, getTransaction } from './ledger'
import { getPending, closePending, GATE_FIELDS } from './pending'
import { resolveBatchItem } from './batch'
import { buildCard } from './cards'
import { createRule, findByCondition } from './rules'
import type { TransactionCardData } from '../../shared/types'

export interface PendingAnswerResult {
  text: string
  card?: TransactionCardData
}

/**
 * 待收尾答一次学一次：confirm_record 答案是分类名且交易有商户时，
 * 顺手建一条 merchant contains 规则（provenance=learned_from_correction）。
 * 已有同条件规则则跳过不覆盖；任何失败都不阻塞主流程。
 */
function learnCategoryRule(db: Database, merchant: string | null, categoryName: string, gateId: number): void {
  try {
    const m = (merchant ?? '').trim()
    const c = (categoryName ?? '').trim()
    if (!m || !c) return
    const condition = { match: 'merchant' as const, op: 'contains' as const, value: m }
    if (findByCondition(db, condition)) return
    createRule(db, condition, { set_category: c }, {
      provenance: 'learned_from_correction',
      reasoning: `待收尾 #${gateId} 答复学得：${m} → ${c}`,
    })
  } catch {
    // 学习失败不阻塞主流程（静默跳过）
  }
}

/** 就地/对话共用的续办入口。expectedRevision 传入时做乐观校验（防重复作答）。 */
export function answerPending(
  db: Database,
  gateId: number,
  answer: string,
  opts: { sessionId: string; expectedRevision?: number; via: 'chat' | 'panel' },
): PendingAnswerResult {
  const row = getPending(db, gateId)
  if (!row || row.status !== 'open') throw new Error(`待收尾 #${gateId} 不存在或已关闭`)
  if (GATE_FIELDS.has(row.field)) {
    throw new Error(
      `#${gateId} 是${
        row.field === 'delete_confirm' ? '删除' : row.field === 'batch_classify' ? '批量归类' : '批次'
      }确认门，只能由用户在界面上点按钮完成，不能通过${opts.via === 'chat' ? '对话' : '面板'}作答。`,
    )
  }
  const ans = answer.trim()
  if (!ans) throw new Error('回答不能为空')

  if (row.field === 'transfer_account') {
    throw new Error(
      '这笔转账缺转入/转出账户：请在对话里说「把这笔转账记为 从<转出账户>到<转入账户> ¥X」，我会用记账工具补上（转账需要两个账户才能入账）；补记后到待办点「忽略」关掉这条即可。',
    )
  }

  if (row.field === 'confirm_record' && row.tx_id) {
    const tx = getTransaction(db, row.tx_id)
    if (!tx) throw new Error(`关联交易 #${row.tx_id} 不存在`)
    const isPlainConfirm = ans === '确认' || ans === '好的'
    if (!isPlainConfirm) {
      const kind = tx.type === 'income' ? 'income' : 'expense'
      const catId = getOrCreateCategoryId(db, ans, kind, { changedBy: 'user' })
      updateFields(db, tx.id, { category_id: catId }, { reasoning: `用户${opts.via === 'chat' ? '在对话中' : '在待收尾面板'}答复待收尾` })
    }
    // DDL 兜底：confirmed 的支出/收入必须有分类——仍缺分类则明确报错（不关闭事项）
    const fresh = getTransaction(db, tx.id)
    if (fresh && fresh.category_id === null && (fresh.type === 'expense' || fresh.type === 'income')) {
      throw new Error('还差分类才能入账：请给出分类（如"餐饮"）。')
    }
    const closed = closePending(db, row.id, 'resolved', opts.expectedRevision ?? row.revision)
    if (!closed) throw new Error(`待收尾 #${gateId} 已被处理（revision 变更），请刷新后重试`)
    confirmTx(db, tx.id, { reasoning: `用户${opts.via === 'chat' ? '在对话中' : '在待收尾面板'}答复待收尾 #${row.id}` })
    // 学一次下次自动：答案是分类名（非裸「确认」）时顺手学规则；失败不阻塞
    if (!isPlainConfirm) {
      const done = getTransaction(db, tx.id)
      const catName = done?.category_id != null
        ? (db.prepare('SELECT name FROM categories WHERE id=?').get(done.category_id) as { name: string } | undefined)?.name ?? null
        : null
      if (catName) learnCategoryRule(db, done?.merchant ?? null, catName, row.id)
    }
    const card = buildCard(db, getTransaction(db, tx.id)!)
    return { text: `已按答复处理 #${tx.id}（confirmed）。`, card }
  }

  if (row.field === 'batch_item') {
    // 批次缺金额项补答：答案 = 金额（可带分类）→ 创建交易继续
    const { txId, card } = resolveBatchItem(db, row.id, ans, opts.sessionId, opts.expectedRevision)
    return { text: `已按补充金额入账 #${txId}（confirmed）。`, card }
  }

  // 其他自由字段：关闭并留痕
  const closed = closePending(db, row.id, 'resolved', opts.expectedRevision ?? row.revision)
  if (!closed) throw new Error(`待收尾 #${gateId} 已被处理（revision 变更），请刷新后重试`)
  return { text: `待收尾 #${gateId} 已办结。` }
}
