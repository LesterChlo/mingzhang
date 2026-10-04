// 账务工具面（决定记录 §2：11 条，阶段 2 补齐中）。每条工具都走域层，不碰裸 SQL。
// 已就位：record(含规则命中) / query(聚合/单笔/待核对) / update / delete(两段式) / restore / split / teach。
// 待补：accounts / month_report / pending（M2）、commit_batch（M3）。

import { Type, StringEnum } from '@earendil-works/pi-ai'
import { defineTool, type ToolDefinition } from '@earendil-works/pi-coding-agent'
import type { Database } from 'better-sqlite3-multiple-ciphers'
import {
  createTransaction,
  createImport,
  recordParse,
  autoConfirm,
  requestReview,
  getTransaction,
  getThreshold,
  getOrCreateCategoryId,
  findCategoryId,
  resolveAccountId,
  resolveAccountIdWithMatch,
  updateFields,
  softDelete,
  restore,
  type TransactionFull,
} from '../domain/ledger'
import { aggregate, PERIODS, type Period } from '../domain/queries'
import { createPending } from '../domain/pending'
import { prepareDeleteGate } from '../domain/gates'

import { classifyByMerchant } from '../domain/builtin-categories'
import { createM2Tools } from './tools-m2'
import { createM3Tools } from './tools-m3'
import { createM4Tools } from './tools-m4'
import { createM5Tools } from './tools-m5'
import type {
  DeleteGateCardData,

  SplitCardData,
  TransactionCardData,
  QueryResultCardData,
  CardData,
} from '../../shared/types'

/** 引擎在每次 prompt 前设置的"当前轮次上下文"，工具从这里取 source_message_id 等锚点。 */
export interface TurnContext {
  sessionId: string
  sourceMessageId: string
  hasImage: boolean
  /** 视觉软拦（②）：图片来源且当前模型未通过视觉自检（离线演示除外）——入账强制转待确认。 */
  visionUnverified: boolean
  /** B：本轮保存的附件文件名（attachments/ 内相对路径），imports.source_ref 用。 */
  attachments: string[]
}

export interface EngineDeps {
  db: Database
  getTurnContext: () => TurnContext
}

function yuan(cents: number): string {
  return (cents / 100).toFixed(2)
}

export { buildCard, txOf } from '../domain/cards'
import { buildCard, txOf } from '../domain/cards'

/** query 三种模式返回的 details 形状不一，统一放宽 */
type QueryDetails = { card?: CardData }

function describeTx(tx: TransactionFull, categoryName: string | null): string {
  return `#${tx.id} ¥${yuan(tx.amount_cents)}${tx.merchant ? ` · ${tx.merchant}` : ''}${categoryName ? ` · ${categoryName}` : ''}（${tx.state}）`
}

export function createLedgerTools(deps: EngineDeps): ToolDefinition[] {
  const { db, getTurnContext } = deps

  const recordTool = defineTool({
    name: 'record',
    label: '记账',
    description:
      '记一笔账。用户表达任何记账意图时调用（自然语言或截图解析结果）。金额用整数分（35元=3500）且恒正；' +
      '所有单笔都保存为待确认，只有用户在界面点击确认入账才正式入账，不要宣称已入账；' +
      '分类拿不准就省略 category_name（系统会套用用户规则或常识提供建议，仍需用户确认）；' +
      '转账类资金流转用 tx_type=transfer，目标账户不明传 null。',
    parameters: Type.Object({
      amount_cents: Type.Integer({ description: '金额，整数分，恒正。35 元 = 3500' }),
      tx_type: StringEnum(['expense', 'income', 'transfer', 'adjustment'], {
        description: 'expense=支出 income=收入 transfer=账户间转账 adjustment=余额调整',
      }),
      merchant: Type.Optional(Type.String({ description: '商户名，看不出就省略' })),
      category_name: Type.Optional(
        Type.String({ description: '分类名（如 餐饮/购物/交通）。拿不准就省略，不要猜' }),
      ),
      account_name: Type.Optional(Type.String({ description: '付款账户名（现金/银行卡/支付宝/微信）。看不出就省略' })),
      to_account_name: Type.Optional(Type.String({ description: '仅转账时：转入账户名。不明就省略' })),
      occurred_at: Type.Optional(
        Type.String({ description: '交易发生时间，ISO-8601 本地时间。看不出就省略（默认现在）' }),
      ),
      note: Type.Optional(Type.String({ description: '备注/原始描述' })),
      confidence: Type.Number({ description: '本次解析的整体置信度 0.0~1.0。金额或方向不确定必须 < 0.6' }),
    }),
    execute: async (_toolCallId, params) => {
      const ctx = getTurnContext()
      // StringEnum 的静态类型是 string，收窄到字面量联合（工具 schema 已约束取值）
      const txType = params.tx_type as 'expense' | 'income' | 'transfer' | 'adjustment'

      // 账户解析：名字匹配不上时仍给默认账户（不打断记账），
      // 但记下"没匹配上"，回给用户的消息里必须点名（缺陷③：不许静默变现金）。
      const account = resolveAccountIdWithMatch(db, params.account_name ?? null)
      const accountId = account.id
      const accountMissNote = account.matched
        ? ''
        : `账户「${String(params.account_name).trim()}」不存在，已按默认账户记账，可在账本详情改`
      let toAccountId: number | null = null
      if (txType === 'transfer' && params.to_account_name) {
        try {
          toAccountId = resolveAccountId(db, params.to_account_name)
        } catch {
          toAccountId = null
        }
      }

      const importId = createImport(db, {
        sourceType: ctx.hasImage ? 'screenshot' : 'text',
        status: 'parsed',
        sourceRef: ctx.attachments[0] ?? null,
        sourceMessageId: ctx.sourceMessageId,
        changedBy: 'import',
      })

      const txId = createTransaction(db, {
        amountCents: params.amount_cents,
        txType,
        accountId,
        toAccountId,
        occurredAt: params.occurred_at ?? null,
        merchant: params.merchant ?? null,
        note: params.note ?? null,
        sourceMessageId: ctx.sourceMessageId,
        changedBy: 'user',
      })

      // 分类：模型显式 ＞ 用户规则 ＞ 常识表 ＞ 再缺才转待确认
      let categoryId: number | null = null
      let categoryCreated = false
      let ruleHit: { ruleId: number; categoryName: string } | null = null
      let builtinName: string | null = null
      if (params.category_name && (txType === 'expense' || txType === 'income')) {
        categoryId = getOrCreateCategoryId(db, params.category_name, txType, {
          sourceMessageId: ctx.sourceMessageId,
          changedBy: 'llm',
        })
        categoryCreated = true
      } else if (txType === 'expense' || txType === 'income') {
        const decided = classifyByMerchant(db, {
          merchant: params.merchant ?? null,
          kind: txType,
          txId,
          sourceMessageId: ctx.sourceMessageId,
          changedBy: 'llm',
        })
        categoryId = decided.categoryId
        ruleHit = decided.ruleHit
        builtinName = decided.builtinName
      }

      recordParse(db, txId, {
        amountCents: params.amount_cents,
        txType,
        accountId,
        categoryId,
        occurredAt: params.occurred_at ?? null,
        merchant: params.merchant ?? null,
        note: params.note ?? null,
        confidenceScore: params.confidence,
        sourceMessageId: ctx.sourceMessageId,
        reasoning: params.note ?? null,
      })

      // 单笔一律先确认；分类/置信度只提供建议和核对原因，不能代替用户确认。
      const threshold = getThreshold(db)
      const categoryMissing = (txType === 'expense' || txType === 'income') && categoryId === null
      const transferTargetMissing = txType === 'transfer' && toAccountId === null
      let reviewReason: string | null = null
      if (params.confidence < threshold && builtinName === null) reviewReason = `置信度 ${params.confidence} 低于阈值 ${threshold}`
      else if (categoryMissing) reviewReason = '分类未定'
      else if (transferTargetMissing) reviewReason = '转账目标账户未定'
      else if (ctx.visionUnverified) reviewReason = '图片来源未经视觉自检（软拦：结果进待确认）'
      else reviewReason = '单笔记账需要用户确认'

      requestReview(db, txId, {
        reason: reviewReason,
        sourceMessageId: ctx.sourceMessageId,
        confidenceScore: params.confidence,
      })
      const gateId = createPending(db, {
        txId,
        sessionId: ctx.sessionId,
        field: 'confirm_record',
        question: reviewReason,
        payload: { txId, reason: reviewReason, requiresExplicitConfirm: true },
      })
      const card = buildCard(db, txOf(db, txId), { reviewReason, gateId, ruleHit })
      let text = `已保存待确认（交易 #${txId}，原因：${reviewReason}）。请用户在界面上点「确认入账」。` +
        (categoryCreated && card.tx.categoryName ? `（新建分类「${card.tx.categoryName}」）` : '') +
        (ruleHit ? `（命中规则 #${ruleHit.ruleId}）` : '') +
        (builtinName !== null ? `（常识分类「${builtinName}」）` : '')

      // 账户没匹配上：点名说出来（模型会照着转述给用户），不静默（缺陷③）
      if (accountMissNote) text += ` ⚠ ${accountMissNote}`

      return { content: [{ type: 'text', text }], details: { importId, card, accountMiss: !account.matched } }
    },
  })

  const queryTool = defineTool({
    name: 'query',
    label: '查账',
    description:
      '查账聚合：总支出/总收入/按分类，也支持查单笔（mode=single）和待核对列表（mode=pending_list）。数字由代码聚合（整数分），返回后请用自然语言转述，不要改动数字。',
    parameters: Type.Object({
      mode: Type.Optional(StringEnum(['aggregate', 'single', 'pending_list'], { description: '默认 aggregate' })),
      metric: Type.Optional(
        StringEnum(['total_expense', 'total_income', 'by_category'], {
          description: 'aggregate 模式：total_expense=总支出 total_income=总收入 by_category=按分类看',
        }),
      ),
      period: Type.Optional(
        StringEnum([...PERIODS], {
          description: 'aggregate 模式：this_month=本月 last_month=上月 this_week=本周（周一起） last_7_days=最近7天',
        }),
      ),
      category_name: Type.Optional(Type.String({ description: 'aggregate 模式：只看某个分类时给出' })),
      compare_previous: Type.Optional(Type.Boolean({ description: '用户问"超支了吗/比上月多吗"时传 true' })),
      tx_id: Type.Optional(Type.Integer({ description: 'single 模式：交易 id（卡片上的 #id）' })),
    }),
    execute: async (_toolCallId, params) => {
      const mode = params.mode ?? 'aggregate'

      if (mode === 'single') {
        if (!params.tx_id) throw new Error('single 模式需要 tx_id')
        const tx = txOf(db, params.tx_id)
        const card = buildCard(db, tx)
        return { content: [{ type: 'text', text: describeTx(tx, card.tx.categoryName) }], details: { card } as QueryDetails }
      }

      if (mode === 'pending_list') {
        const rows = db
          .prepare(
            "SELECT p.id gid, p.field, p.question, p.tx_id FROM pending_clarifications p WHERE p.status='open' ORDER BY p.id",
          )
          .all() as unknown as { gid: number; field: string; question: string; tx_id: number | null }[]
        if (rows.length === 0) {
          return { content: [{ type: 'text', text: '当前没有待收尾事项。' }], details: {} as QueryDetails }
        }
        const lines = rows.map(
          (r) => `- [${r.gid}] ${r.field}${r.tx_id ? `（交易 #${r.tx_id}）` : ''}：${r.question}`,
        )
        return { content: [{ type: 'text', text: `共 ${rows.length} 条待收尾：\n${lines.join('\n')}` }], details: {} }
      }

      const result = aggregate(db, {
        metric: (params.metric ?? 'total_expense') as 'total_expense' | 'total_income' | 'by_category',
        period: (params.period ?? 'this_month') as Period,
        categoryName: params.category_name ?? null,
        comparePrevious: params.compare_previous ?? false,
      })
      const card: QueryResultCardData = { kind: 'query', ...result }
      const lines: string[] = []
      lines.push(
        `${result.range[0]} ~ ${result.range[1]} ${result.categoryName ? `「${result.categoryName}」` : ''}` +
          `${result.txType === 'expense' ? '支出' : '收入'}合计 ¥${yuan(result.totalCents)}，共 ${result.count} 笔。`,
      )
      if (result.byCategory.length > 0) {
        const top = result.byCategory
          .slice(0, 5)
          .map((c) => `${c.category} ¥${yuan(c.totalCents)}(${c.count}笔)`)
          .join('，')
        lines.push(`分类：${top}`)
      }
      if (result.previous) {
        const diff = result.previous.deltaCents
        lines.push(
          `上期（${result.previous.range[0]} ~ ${result.previous.range[1]}）¥${yuan(result.previous.totalCents)}；` +
            `本期较上期${diff >= 0 ? '多' : '少'} ¥${yuan(Math.abs(diff))}。`,
        )
      }
      lines.push(
        result.budgetCents
          ? `月度预算 ¥${yuan(result.budgetCents)}，剩余 ¥${yuan(result.budgetRemainingCents ?? 0)}。`
          : '未设置月度预算（如需预算对比可让用户在设置里填）。这是查账口径，不是预算提醒。',
      )
      return { content: [{ type: 'text', text: lines.join('\n') }], details: { card } }
    },
  })

  const updateTool = defineTool({
    name: 'update',
    label: '改账',
    description:
      '修改已有交易（改分类/金额/商户/时间/账户等）。只传需要改的字段；结果返回 before→after 对照。金额同样是整数分恒正。',
    parameters: Type.Object({
      tx_id: Type.Integer({ description: '要改的交易 id（卡片上的 #id）' }),
      category_name: Type.Optional(Type.String({ description: '改成这个分类（不存在会新建）' })),
      amount_cents: Type.Optional(Type.Integer({ description: '改成这个金额（整数分，恒正）' })),
      merchant: Type.Optional(Type.String()),
      note: Type.Optional(Type.String()),
      occurred_at: Type.Optional(Type.String({ description: 'ISO-8601 本地时间' })),
      account_name: Type.Optional(Type.String({ description: '改成这个付款账户' })),
      to_account_name: Type.Optional(Type.String({ description: '仅转账：改成这个转入账户' })),
      reason: Type.Optional(Type.String({ description: '用户给出的修改原因，可选' })),
    }),
    execute: async (_toolCallId, params) => {
      const tx = txOf(db, params.tx_id)
      if (tx.state === 'deleted') throw new Error(`交易 #${tx.id} 已删除，先恢复才能改`)
      const before = buildCard(db, tx)

      const fields: Record<string, unknown> = {}
      // 账户：匹配不上时同样点名（缺陷③），口径与 record 工具一致
      let accountMissNote = ''
      if (params.account_name !== undefined) {
        const acc = resolveAccountIdWithMatch(db, params.account_name)
        fields.account_id = acc.id
        if (!acc.matched) {
          accountMissNote = `账户「${String(params.account_name).trim()}」不存在，已按默认账户记账，可在账本详情改`
        }
      }
      if (params.category_name !== undefined) {
        const kind = tx.type === 'income' ? 'income' : 'expense'
        fields.category_id = getOrCreateCategoryId(db, params.category_name, kind, { changedBy: 'user' })
      }
      if (params.amount_cents !== undefined) fields.amount_cents = params.amount_cents
      if (params.merchant !== undefined) fields.merchant = params.merchant
      if (params.note !== undefined) fields.note = params.note
      if (params.occurred_at !== undefined) fields.occurred_at = params.occurred_at
      if (params.to_account_name !== undefined) {
        if (tx.type !== 'transfer') throw new Error('只有转账类交易才能改转入账户')
        fields.to_account_id = resolveAccountId(db, params.to_account_name)
      }
      if (Object.keys(fields).length === 0) throw new Error('没有给出任何要修改的字段')

      updateFields(db, tx.id, fields, {
        changedBy: 'user',
        reasoning: params.reason ?? '用户在对话中纠正',
      })
      const after = buildCard(db, txOf(db, tx.id))

      const changes: string[] = []
      if (before.tx.amountCents !== after.tx.amountCents)
        changes.push(`金额 ¥${yuan(before.tx.amountCents)} → ¥${yuan(after.tx.amountCents)}`)
      if (before.tx.categoryName !== after.tx.categoryName)
        changes.push(`分类 ${before.tx.categoryName ?? '未分类'} → ${after.tx.categoryName ?? '未分类'}`)
      if (before.tx.merchant !== after.tx.merchant)
        changes.push(`商户 ${before.tx.merchant ?? '—'} → ${after.tx.merchant ?? '—'}`)
      // 账户没匹配上：点名说出来（缺陷③），模型会照着转述给用户
      if (accountMissNote) changes.push(accountMissNote)

      return {
        content: [{ type: 'text', text: `已修改 #${tx.id}：${changes.join('；') || '字段已更新'}` }],
        details: { card: after, changes },
      }
    },
  })

  const deleteTool = defineTool({
    name: 'delete',
    label: '删账（两段式）',
    description:
      '删除一笔交易。调用后只是生成「删除待确认」清单，真正删除要等用户在界面上点确认按钮——你在对话里无法完成删除，也不要宣称已删除。',
    parameters: Type.Object({
      tx_id: Type.Integer({ description: '要删除的交易 id（卡片上的 #id）' }),
    }),
    execute: async (_toolCallId, params) => {
      const ctx = getTurnContext()
      const tx = txOf(db, params.tx_id)
      const { gateId } = prepareDeleteGate(db, {
        txId: tx.id,
        sessionId: ctx.sessionId,
        sourceMessageId: ctx.sourceMessageId,
      })
      const card: DeleteGateCardData = { kind: 'delete-gate', gateId, tx: buildCard(db, tx).tx }
      return {
        content: [
          { type: 'text', text: `已生成删除待确认清单（交易 #${tx.id}）。请用户在界面上点「确认删除」或「取消」。` },
        ],
        details: { card },
      }
    },
  })

  const restoreTool = defineTool({
    name: 'restore',
    label: '恢复删除',
    description: '恢复一笔已软删除的交易，回到删除前的状态。',
    parameters: Type.Object({
      tx_id: Type.Integer({ description: '要恢复的交易 id' }),
    }),
    execute: async (_toolCallId, params) => {
      const tx = txOf(db, params.tx_id)
      if (tx.state !== 'deleted') throw new Error(`交易 #${tx.id} 不是删除状态，无需恢复`)
      const target = restore(db, tx.id, { reasoning: '用户恢复删除' })
      const card = buildCard(db, txOf(db, tx.id))
      return { content: [{ type: 'text', text: `已恢复 #${tx.id}（${target}）。` }], details: { card } }
    },
  })

  const splitTool = defineTool({
    name: 'split',
    label: '拆账',
    description:
      '把一笔交易拆成多笔。子项金额之和必须等于原笔金额，不等会直接拒绝。拆分方式不明确时先反问用户，不要猜。',
    parameters: Type.Object({
      tx_id: Type.Integer({ description: '要拆分的交易 id' }),
      items: Type.Array(
        Type.Object({
          amount_cents: Type.Integer({ description: '子项金额（整数分）' }),
          category_name: Type.Optional(Type.String({ description: '子项分类' })),
          merchant: Type.Optional(Type.String()),
          note: Type.Optional(Type.String()),
        }),
        { minItems: 2, description: '拆分方案（至少 2 项）' },
      ),
    }),
    execute: async (_toolCallId, params) => {
      const tx = txOf(db, params.tx_id)
      if (tx.state === 'deleted') throw new Error(`交易 #${tx.id} 已删除，不能拆分`)
      const sum = params.items.reduce((acc, it) => acc + it.amount_cents, 0)
      if (sum !== tx.amount_cents) {
        throw new Error(
          `拆分子项之和 ¥${yuan(sum)} ≠ 原笔金额 ¥${yuan(tx.amount_cents)}，已拒绝。请和用户确认正确的拆分方案。`,
        )
      }
      softDelete(db, tx.id, {
        sourceMessageId: tx.source_message_id,
        reasoning: 'split into 子项',
      })
      const cards: TransactionCardData[] = []
      const createdIds: number[] = []
      for (const item of params.items) {
        let categoryId: number | null = null
        if (item.category_name) {
          const kind = tx.type === 'income' ? 'income' : 'expense'
          categoryId =
            findCategoryId(db, item.category_name, kind) ??
            getOrCreateCategoryId(db, item.category_name, kind, { changedBy: 'user' })
        }
        const newId = createTransaction(db, {
          amountCents: item.amount_cents,
          txType: tx.type as 'expense' | 'income' | 'transfer' | 'adjustment',
          accountId: tx.account_id,
          occurredAt: tx.occurred_at,
          merchant: item.merchant ?? tx.merchant,
          note: item.note ?? null,
          sourceMessageId: tx.source_message_id,
          changedBy: 'user',
        })
        // 子项直接 confirmed（A4：一次性确认全部子项）；解析审计链保持口径一致
        recordParse(db, newId, {
          amountCents: item.amount_cents,
          categoryId,
          merchant: item.merchant ?? tx.merchant,
          confidenceScore: 1,
          sourceMessageId: tx.source_message_id,
          reasoning: '拆分子项',
        })
        autoConfirm(db, newId, { confidenceScore: 1, sourceMessageId: tx.source_message_id })
        updateFields(db, newId, { note: item.note ?? null }, { reasoning: `split from #${tx.id}`, changedBy: 'user' })
        cards.push(buildCard(db, txOf(db, newId)))
        createdIds.push(newId)
      }
      const splitCard: SplitCardData = { kind: 'split', originalId: tx.id, cards }
      return {
        content: [{ type: 'text', text: `已把 #${tx.id} 拆成 ${createdIds.map((id) => `#${id}`).join(' + ')}。` }],
        details: { card: splitCard },
      }
    },
  })

  const teachTool = defineTool({
    name: 'teach',
    label: '教规则',
    description:
      '引导用户到界面显式保存或管理分类规则。此工具只提供操作指引，不创建、覆盖或停用规则，overwrite 不构成用户授权。',
    parameters: Type.Object({
      action: StringEnum(['set_category', 'remove'], { description: 'set_category=教新规则 remove=撤销规则' }),
      match_merchant: Type.Optional(Type.String({ description: 'set_category 时：商户关键词' })),
      op: Type.Optional(StringEnum(['contains', 'equals'], { description: '默认 contains（包含匹配）' })),
      category_name: Type.Optional(Type.String({ description: 'set_category 时：要设置的分类' })),
      rule_id: Type.Optional(Type.Integer({ description: 'remove 时：规则 id（规则卡片上有）' })),
      overwrite: Type.Optional(Type.Boolean({ description: '用户同意覆盖同条件旧规则时传 true' })),
    }),
    execute: async () => ({
      content: [{ type: 'text', text: '规则只能由用户在界面明确保存、修改或停用。请在批次分类复核完成后点击保存规则，或前往设置中的分类规则管理；对话不会自动学习规则。' }],
      details: {},
    }),
  })

  return [recordTool, queryTool, updateTool, deleteTool, restoreTool, splitTool, teachTool, ...createM2Tools({ db, getTurnContext }), ...createM3Tools({ db, getTurnContext }), ...createM4Tools({ db, getTurnContext }), ...createM5Tools({ db, getTurnContext })]
}
