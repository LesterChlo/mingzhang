// M3 账务工具：commit_batch（批次账务委托，两段式）。
// 计划/去重/落 gate；执行入口唯一 = UI 确认按钮 → engine.confirmGate → domain.executeBatch。

import { Type, StringEnum } from '@earendil-works/pi-ai'
import { defineTool, type ToolDefinition } from '@earendil-works/pi-coding-agent'
import type { Database } from 'better-sqlite3-multiple-ciphers'
import { prepareBatch, type BatchItemInput } from '../domain/batch'
import type { TurnContext } from './tools'
import type { BatchGateCardData } from '../../shared/types'

export interface M3Deps {
  db: Database
  getTurnContext: () => TurnContext
}

export function createM3Tools(deps: M3Deps): ToolDefinition[] {
  const { db, getTurnContext } = deps

  const commitBatchTool = defineTool({
    name: 'commit_batch',
    label: '批次入账（两段式）',
    description:
      '批量入账：用户拖入账单材料（CSV/多张截图）后，把解析出的条目一次提交。' +
      '每条尽力给出 amount_cents/tx_type/merchant/occurred_at/category_name；材料里的可靠交易号放 reliable_id（用于跨批去重）；' +
      '读不出金额的条目不要猜，amount_cents 省略并尽量给 merchant/source_text。' +
      '调用后只生成「批次待确认」清单，入账要等用户在界面上点确认——不要宣称已入账。',
    parameters: Type.Object({
      source_type: StringEnum(['csv', 'screenshot', 'text', 'xlsx'], { description: '材料类型' }),
      channel: Type.Optional(Type.String({ description: '支付渠道名（如 支付宝/微信），参与去重标识' })),
      batch_note: Type.Optional(Type.String({ description: '用户对整批的说明，可选' })),
      items: Type.Array(
        Type.Object({
          amount_cents: Type.Optional(Type.Integer({ description: '金额（整数分）。读不出就省略，不要猜' })),
          tx_type: Type.Optional(StringEnum(['expense', 'income', 'transfer', 'adjustment'])),
          merchant: Type.Optional(Type.String()),
          occurred_at: Type.Optional(Type.String({ description: 'ISO-8601 本地时间' })),
          category_name: Type.Optional(Type.String()),
          note: Type.Optional(Type.String()),
          reliable_id: Type.Optional(Type.String({ description: '材料里的可靠交易号/流水号' })),
          source_text: Type.Optional(Type.String({ description: '该条原始文本（给缺金额项留证据）' })),
        }),
        { minItems: 1 },
      ),
    }),
    execute: async (_toolCallId, params) => {
      const ctx = getTurnContext()
      const items: BatchItemInput[] = params.items.map((it) => ({
        amount_cents: it.amount_cents ?? null,
        tx_type: it.tx_type as BatchItemInput['tx_type'],
        merchant: it.merchant ?? null,
        occurred_at: it.occurred_at ?? null,
        category_name: it.category_name ?? null,
        note: it.note ?? null,
        reliable_id: it.reliable_id ?? null,
        source_text: it.source_text ?? null,
      }))
      const { gateId, plan } = prepareBatch(db, {
        items,
        channel: params.channel ?? null,
        sourceType: params.source_type as 'csv' | 'screenshot' | 'text' | 'xlsx',
        sessionId: ctx.sessionId,
        batchNote: params.batch_note ?? null,
        attachments: ctx.attachments, // B：来源附件随批次进 payload（缺金额项转待收尾可预览）
      })
      const card: BatchGateCardData = {
        kind: 'batch-gate',
        gateId,
        channel: params.channel ?? null,
        newCount: plan.newCount,
        duplicateCount: plan.duplicateCount,
        unparsedCount: plan.unparsedCount,
        items: plan.items.map((it) => ({
          status: it.status,
          merchant: it.merchant ?? null,
          amountCents: it.amountCents ?? null,
          reason: it.reason ?? null,
        })),
      }
      const text =
        `批次已生成待确认清单：${plan.newCount} 笔将入账，${plan.duplicateCount} 笔重复跳过，${plan.unparsedCount} 笔缺金额待核对。` +
        `请用户在界面上点「确认入账」。`
      return { content: [{ type: 'text', text }], details: { card } }
    },
  })

  return [commitBatchTool]
}
