// 批次账务委托（spec-批次账务委托-2026-09-17 的 4 票落地）。
//   - 工具 commit_batch 只做识别/去重/计划，生成 batch_confirm gate；执行入口唯一 = UI 按钮。
//   - 金额必须有依据：缺金额的来源不猜，存待收尾（tx_id=NULL）；补充金额后继续（C4）。
//   - 去重：同渠道 + 可靠交易号幂等；仅相似（日期/商户/金额）不合并（C6）。
//   - 结果逐项交代：已完成 / 重复 / 待核对 / 失败，一个错误不伪装整批成功（C5）。
//   - 重复提交/重复材料不重复计账（C7）：gate 关闭后不可再执行；dedup_key 唯一兜底。

import type { Database } from 'better-sqlite3-multiple-ciphers'
import {
  createTransaction,
  recordParse,
  autoConfirm,
  requestReview,
  getOrCreateCategoryId,
  createImport,
  updateImportStatus,
  resolveAccountId,
  getTransaction,
  type TransactionFull,
} from './ledger'
import { createPending, getPending, closePending } from './pending'
import { classifyByMerchant, BUILTIN_CONFIDENCE } from './builtin-categories'
import { buildCard, txOf } from './cards'
import type { TransactionCardData } from '../../shared/types'
import { nowIso } from '../db/time'

export interface BatchItemInput {
  amount_cents?: number | null
  tx_type?: 'expense' | 'income' | 'transfer' | 'adjustment'
  merchant?: string | null
  occurred_at?: string | null
  category_name?: string | null
  note?: string | null
  /** 材料里的可靠交易号（如账单流水号）。无可靠标识就不传——不用内容哈希冒充身份。 */
  reliable_id?: string | null
  source_text?: string | null
  /** 第 8 单：账单原表行号（确定性套表路径带上，供对账与待办回显"第 N 行"）。 */
  row_no?: number | null
  /** 第 8 单：付款账户名（账单「支付方式」列映射而来；解析不到不猜默认账户）。 */
  account_name?: string | null
  /** 第 8 单：有值即该行没办完（金额/时间解析不出等），带原因转待办，绝不入账。 */
  review_reason?: string | null
}

export interface BatchPlanItem {
  status: 'new' | 'duplicate' | 'unparsed'
  reason?: string
  amountCents?: number | null
  txType?: string
  merchant?: string | null
  occurredAt?: string | null
  categoryName?: string | null
  dedupKey?: string | null
  sourceText?: string | null
  rowNo?: number | null
  accountName?: string | null
}

export interface BatchPlan {
  batchId: string
  importId: number
  channel: string | null
  /** B：本批来源附件（attachments/ 相对文件名），缺金额项转待收尾时随 payload 带走。 */
  attachments: string[]
  items: BatchPlanItem[]
  newCount: number
  duplicateCount: number
  unparsedCount: number
  /** 第 8 单：确定性套表路径才有——材料共多少行、其中多少行判定为不计收支。 */
  billTableId?: number | null
  rowsConsidered?: number | null
  skippedCount?: number
}

/** 计划批次：识别/去重/分类预估，落 batch_confirm gate。不写 transactions。 */
export function prepareBatch(
  db: Database,
  input: {
    items: BatchItemInput[]
    channel?: string | null
    sourceType: 'csv' | 'screenshot' | 'text' | 'xlsx'
    sessionId: string
    batchNote?: string | null
    attachments?: string[]
    billTableId?: number | null
    rowsConsidered?: number | null
    skippedCount?: number
  },
): { gateId: number; plan: BatchPlan } {
  if (!input.items.length) throw new Error('批次为空：没有识别到任何待处理条目')
  const batchId = `batch-${nowIso()}-${Math.random().toString(36).slice(2, 8)}`
  const importId = createImport(db, {
    sourceType: input.sourceType,
    status: 'pending',
    sourceMessageId: batchId,
    changedBy: 'import',
  })

  const plan: BatchPlan = {
    batchId,
    importId,
    channel: input.channel ?? null,
    attachments: input.attachments ?? [],
    items: [],
    newCount: 0,
    duplicateCount: 0,
    unparsedCount: 0,
    billTableId: input.billTableId ?? null,
    rowsConsidered: input.rowsConsidered ?? null,
    skippedCount: input.skippedCount ?? 0,
  }

  for (const item of input.items) {
    if (item.review_reason || item.amount_cents === undefined || item.amount_cents === null || item.amount_cents <= 0) {
      // C4：无法确认金额/时间 → 保存来源待收尾，不虚构、不默认成今天
      plan.items.push({
        status: 'unparsed',
        merchant: item.merchant ?? null,
        sourceText: item.source_text ?? null,
        occurredAt: item.occurred_at ?? null,
        amountCents: item.amount_cents ?? null,
        txType: item.tx_type ?? undefined,
        rowNo: item.row_no ?? null,
        accountName: item.account_name ?? null,
        reason: item.review_reason ?? '金额无法从材料确认',
      })
      plan.unparsedCount += 1
      continue
    }
    // C6：只有「同渠道 + 同可靠交易号」才自动判重
    let dedupKey: string | null = null
    if (item.reliable_id) {
      dedupKey = input.channel ? `${input.channel}:${item.reliable_id}` : String(item.reliable_id)
      const dup = db
        .prepare('SELECT id FROM transactions WHERE dedup_key = ? LIMIT 1')
        .get(dedupKey) as { id: number } | undefined
      if (dup) {
        plan.items.push({
          status: 'duplicate',
          reason: `与交易 #${dup.id} 同渠道同交易号，自动跳过`,
          dedupKey,
          merchant: item.merchant ?? null,
          amountCents: item.amount_cents,
          rowNo: item.row_no ?? null,
        })
        plan.duplicateCount += 1
        continue
      }
    }
    plan.items.push({
      status: 'new',
      amountCents: item.amount_cents,
      txType: item.tx_type ?? 'expense',
      merchant: item.merchant ?? null,
      occurredAt: item.occurred_at ?? null,
      categoryName: item.category_name ?? null,
      dedupKey,
      sourceText: item.source_text ?? null,
      rowNo: item.row_no ?? null,
      accountName: item.account_name ?? null,
    })
    plan.newCount += 1
  }

  const tail =
    input.skippedCount && input.skippedCount > 0 ? `，${input.skippedCount} 行按方案不计收支` : ''
  const gateId = createPending(db, {
    txId: null,
    sessionId: input.sessionId,
    field: 'batch_confirm',
    question: `批次待确认：${plan.newCount} 笔将入账，${plan.duplicateCount} 笔重复跳过，${plan.unparsedCount} 笔待核对${tail}`,
    payload: { plan },
  })
  return { gateId, plan }
}

export interface BatchResult {
  completed: { txId: number; card: TransactionCardData; needsReview: boolean }[]
  duplicates: { merchant: string | null; amountCents?: number | null; reason: string }[]
  unparsedKept: number
  transfersSkipped: { merchant: string | null; amountCents: number | null }[]
  /** 第 8 单：因账户映射对不上账本而未入账的笔数（不静默记到默认账户）。 */
  unmatchedAccounts: number
  importStatus: 'confirmed' | 'pending'
}

/** 执行批次 gate（UI 按钮调用）。返回逐项结果；gate 非法 → null。 */
export function executeBatch(db: Database, gateId: number): BatchResult | null {
  const gate = getPending(db, gateId)
  if (!gate || gate.status !== 'open' || gate.field !== 'batch_confirm') return null
  const { plan } = JSON.parse(gate.payload) as { plan: BatchPlan }

  const result: BatchResult = { completed: [], duplicates: [], unparsedKept: 0, transfersSkipped: [], unmatchedAccounts: 0, importStatus: 'pending' }
  // 一次性 + 原子性：整体包进事务——任何一步抛错全部回滚、gate 保持 open 可重试（防半执行/重复执行）
  let out: BatchResult | null = null
  const run = db.transaction((): void => {
  let hasUnparsed = false

  for (const item of plan.items) {
    if (item.status === 'duplicate') {
      result.duplicates.push({
        merchant: item.merchant ?? null,
        amountCents: item.amountCents ?? null,
        reason: item.reason ?? '重复',
      })
      continue
    }
    if (item.status === 'unparsed') {
      // 缺金额项在 prepare 时已经落 pending（见下），此处计数
      result.unparsedKept += 1
      hasUnparsed = true
      continue
    }
    const txType = (item.txType ?? 'expense') as 'expense' | 'income' | 'transfer' | 'adjustment'
    if (txType === 'transfer') {
      // 批次转账缺账户对信息（执行入口无法追问）——不入账（DB 约束禁止无对方账户的转账置 confirmed）。
      // 计入 transfersSkipped，并落一条"缺账户"待办（已落库，关对话不丢），由用户补转入/转出账户后记一笔。
      result.transfersSkipped.push({ merchant: item.merchant ?? null, amountCents: item.amountCents ?? null })
      createPending(db, {
        txId: null,
        sessionId: gate.session_id,
        field: 'transfer_account',
        question: `转账缺账户、未入账：${item.merchant ?? '转账'} ¥${((item.amountCents ?? 0) / 100).toFixed(2)}——补「转出账户」和「转入账户」后记一笔`,
        payload: {
          batchId: plan.batchId,
          importId: plan.importId,
          merchant: item.merchant ?? null,
          amountCents: item.amountCents ?? null,
          channel: plan.channel ?? null,
          occurredAt: item.occurredAt ?? null,
          sourceText: item.sourceText ?? null,
          rowNo: item.rowNo ?? null,
          attachments: plan.attachments,
        },
      })
      continue
    }
    // 第 8 单：账单「支付方式」列映射出的账户——名字对不上就绝不静默落默认账户（宁可转待办）
    let accountId: number
    if (item.accountName) {
      const hit = db.prepare('SELECT id FROM accounts WHERE name = ?').get(item.accountName) as { id: number } | undefined
      if (!hit) {
        createPending(db, {
          txId: null,
          sessionId: gate.session_id,
          field: 'batch_item',
          question: `账户「${item.accountName}」不存在，这笔未入账：${item.merchant ?? ''} ¥${((item.amountCents ?? 0) / 100).toFixed(2)}`,
          payload: {
            batchId: plan.batchId,
            importId: plan.importId,
            merchant: item.merchant ?? null,
            amountCents: item.amountCents ?? null,
            occurredAt: item.occurredAt ?? null,
            sourceText: item.sourceText ?? null,
            rowNo: item.rowNo ?? null,
            attachments: plan.attachments,
          },
        })
        result.unmatchedAccounts += 1
        hasUnparsed = true
        continue
      }
      accountId = hit.id
    } else {
      accountId = resolveAccountId(db)
    }
    const txId = createTransaction(db, {
      amountCents: item.amountCents!,
      txType,
      accountId,
      occurredAt: item.occurredAt ?? null,
      merchant: item.merchant ?? null,
      note: item.sourceText ?? null,
      sourceMessageId: plan.batchId,
      changedBy: 'import',
    })
    if (item.dedupKey) {
      db.prepare('UPDATE transactions SET dedup_key = ? WHERE id = ?').run(item.dedupKey, txId)
    }

    // 分类：模型显式 ＞ 用户规则 ＞ 常识表 ＞ 再缺转 needs_review
    let categoryId: number | null = null
    let ruleHit: { ruleId: number; categoryName: string } | null = null
    let builtinName: string | null = null
    if (item.categoryName && (txType === 'expense' || txType === 'income')) {
      categoryId = getOrCreateCategoryId(db, item.categoryName, txType, { changedBy: 'llm' })
    } else if (txType === 'expense' || txType === 'income') {
      const decided = classifyByMerchant(db, {
        merchant: item.merchant ?? null,
        kind: txType,
        txId,
        sourceMessageId: plan.batchId,
        changedBy: 'llm',
      })
      categoryId = decided.categoryId
      ruleHit = decided.ruleHit
      builtinName = decided.builtinName
    }
    recordParse(db, txId, {
      amountCents: item.amountCents!,
      txType,
      accountId,
      categoryId,
      merchant: item.merchant ?? null,
      confidenceScore: 0.9,
      sourceMessageId: plan.batchId,
      reasoning: '批次入账',
    })

    const tx = getTransaction(db, txId) as TransactionFull
    const needsReview = (txType === 'expense' || txType === 'income') && categoryId === null
    if (needsReview) {
      requestReview(db, txId, { reason: '分类未定', sourceMessageId: plan.batchId, confidenceScore: 0.9 })
      createPending(db, {
        txId,
        sessionId: gate.session_id,
        field: 'confirm_record',
        question: '批次入账缺分类，待确认',
        payload: { txId, reason: '分类未定' },
      })
    } else {
      autoConfirm(db, txId, {
        confidenceScore: builtinName !== null ? BUILTIN_CONFIDENCE : 0.9,
        sourceMessageId: plan.batchId,
        reasoning: builtinName !== null ? `常识分类「${builtinName}」（错了去账本改）` : undefined,
      })
    }
    result.completed.push({ txId, card: buildCard(db, txOf(db, txId), { ruleHit }), needsReview })
  }

  // 待核对项落待收尾（tx_id=NULL，不虚构金额）；全部办结才把批次收口为 confirmed
  const openUnparsed = plan.items.filter((i) => i.status === 'unparsed')
  for (const item of openUnparsed) {
    const where = item.rowNo ? `第 ${item.rowNo} 行` : (item.merchant ?? '材料未提供信息')
    createPending(db, {
      txId: null,
      sessionId: gate.session_id,
      field: 'batch_item',
      question: `${item.reason ?? '金额待补'}：${where}——${item.sourceText ?? ''}`.trim(),
      payload: {
        batchId: plan.batchId,
        importId: plan.importId,
        channel: plan.channel ?? null,
        merchant: item.merchant ?? null,
        amountCents: item.amountCents ?? null,
        txType: item.txType ?? null,
        occurredAt: item.occurredAt ?? null,
        sourceText: item.sourceText ?? null,
        rowNo: item.rowNo ?? null,
        attachments: plan.attachments,
      },
    })
  }
  result.importStatus = hasUnparsed || openUnparsed.length > 0 ? 'pending' : 'confirmed'
  updateImportStatus(db, plan.importId, result.importStatus, { changedBy: 'import' })
  closePending(db, gateId, 'resolved')
  out = result
  })
  run()
  return out
}

/**
 * 批次执行后给模型的系统通知（第 5 单 C1/C3）：逐项交代结果；
 * 含被跳过的转账时，明确指示模型主动追问「转出/转入账户」后补记——把转账补录流程产品化到对话。
 */
export function batchFollowUpSummary(result: BatchResult): string {
  const skipped =
    result.transfersSkipped.length > 0
      ? `；${result.transfersSkipped.length} 笔转账因缺转入/转出账户未入账（${result.transfersSkipped
          .map((t) => `${t.merchant ?? '转账'} ¥${((t.amountCents ?? 0) / 100).toFixed(2)}`)
          .join('、')}）。请主动逐笔追问用户这笔转账的「转出账户」和「转入账户」，问清后用 record 工具（tx_type=transfer，带 account_name 与 to_account_name）补记——不要臆造账户。`
      : ''
  return (
    `系统通知：用户已在界面确认批次入账。已完成 ${result.completed.length} 笔（其中 ${result.completed.filter((c) => c.needsReview).length} 笔缺分类转待确认），` +
    `重复跳过 ${result.duplicates.length} 笔，缺金额待核对 ${result.unparsedKept} 笔${skipped}。请用两三句话向用户交代结果。`
  )
}

/** 待收尾补答（batch_item）：用户给出金额（可带分类）→ 创建交易继续。返回新交易 id。 */
export function resolveBatchItem(
  db: Database,
  gateId: number,
  answer: string,
  sessionId: string,
  expectedRevision?: number,
): { txId: number; card: TransactionCardData } {
  const gate = getPending(db, gateId)
  if (!gate || gate.status !== 'open' || gate.field !== 'batch_item') {
    throw new Error(`待收尾 #${gateId} 不存在或已办结`)
  }
  const payload = JSON.parse(gate.payload) as {
    batchId: string
    importId: number
    merchant: string | null
    occurredAt: string | null
    sourceText: string | null
  }
  // 答复格式：金额（必填，元或分数字）+ 可选分类词
  const m = /(\d+(?:\.\d+)?)/.exec(answer)
  if (!m) throw new Error('没读到金额。请给出该笔的金额，例如「23.5」或「23.5 餐饮」。')
  const amountCents = Math.round(Number(m[1]) * 100)
  if (!Number.isFinite(amountCents) || amountCents <= 0) throw new Error('金额无效')
  const categoryText = answer.replace(m[0], '').replace(/[元¥¥\s]/g, '').trim()

  const txId = createTransaction(db, {
    amountCents,
    txType: 'expense',
    occurredAt: payload.occurredAt ?? null,
    merchant: payload.merchant ?? null,
    note: payload.sourceText ?? null,
    sourceMessageId: payload.batchId,
    changedBy: 'import',
  })
  let categoryId: number | null = null
  let builtinName: string | null = null
  if (categoryText) {
    categoryId = getOrCreateCategoryId(db, categoryText, 'expense', { changedBy: 'user' })
  } else {
    // 补答没带分类：用户规则 ＞ 常识表，再缺才转待确认
    const decided = classifyByMerchant(db, {
      merchant: payload.merchant ?? null,
      kind: 'expense',
      txId,
      sourceMessageId: payload.batchId,
      changedBy: 'llm',
    })
    categoryId = decided.categoryId
    builtinName = decided.builtinName
  }
  recordParse(db, txId, {
    amountCents,
    txType: 'expense',
    categoryId,
    merchant: payload.merchant ?? null,
    confidenceScore: 1,
    sourceMessageId: payload.batchId,
    reasoning: `补答待收尾 #${gateId}`,
  })
  const tx = getTransaction(db, txId) as TransactionFull
  if (categoryId) {
    autoConfirm(db, txId, {
      confidenceScore: builtinName !== null ? BUILTIN_CONFIDENCE : 1,
      sourceMessageId: payload.batchId,
      reasoning: builtinName !== null ? `补答待收尾 #${gateId}，常识分类「${builtinName}」（错了去账本改）` : `补答待收尾 #${gateId}`,
    })
  } else {
    requestReview(db, txId, { reason: '分类未定', sourceMessageId: payload.batchId, confidenceScore: 1 })
    createPending(db, {
      txId,
      sessionId,
      field: 'confirm_record',
      question: '批次补录缺分类，待确认',
      payload: { txId, reason: '分类未定' },
    })
  }
  if (!closePending(db, gateId, 'resolved', expectedRevision ?? gate.revision)) {
    throw new Error(`待收尾 #${gateId} 已被处理（revision 变更），请刷新后重试`)
  }

  // 批次收口：该批次没有其他未办结的 batch_item 了 → import 翻 confirmed
  const others = db
    .prepare("SELECT COUNT(*) n FROM pending_clarifications WHERE field='batch_item' AND status='open'")
    .get() as { n: number }
  if (others.n === 0) {
    db.prepare("UPDATE imports SET status='confirmed', updated_at=? WHERE id=?").run(nowIso(), payload.importId)
  }
  return { txId, card: buildCard(db, txOf(db, txId)) }
}
