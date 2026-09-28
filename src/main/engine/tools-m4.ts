// 第 8 单 段2：账单套表工具面——Agent 自己读表、自己出方案，程序按方案逐行办。
// 分工：read_bill / list_bills 是"眼睛"，apply_bill 是"交方案"；金额与行数都不从模型嘴里过。

import { Type, StringEnum } from '@earendil-works/pi-ai'
import { defineTool, type ToolDefinition } from '@earendil-works/pi-coding-agent'
import type { Database } from 'better-sqlite3-multiple-ciphers'
import { applyBillPlan, listBillTables, readBillRows, BillPlanError, type BillPlanInput } from '../domain/bill'
import type { TurnContext } from './tools'
import type { BatchGateCardData } from '../../shared/types'

export interface M4Deps {
  db: Database
  getTurnContext: () => TurnContext
}

const ValueMapSchema = Type.Object({
  contains: Type.String({ description: '列里出现的原文关键词（包含匹配）' }),
  account_name: Type.Optional(Type.String({ description: '映射到哪个账本账户名（账户映射用）' })),
  type: Type.Optional(StringEnum(['expense', 'income', 'transfer'], { description: '映射成哪类（方向映射用）' })),
})

export function createM4Tools(deps: M4Deps): ToolDefinition[] {
  const { db, getTurnContext } = deps

  const listBillsTool = defineTool({
    name: 'list_bills',
    label: '已入库的账单材料',
    description: '列出最近入库的账单材料（id、来源文件、共几行、还剩几行没处理、列名）。拖入账单后先调它确认材料在哪。',
    parameters: Type.Object({ limit: Type.Optional(Type.Integer({ description: '最多列几条，默认 10' })) }),
    execute: async () => {
      const tables = listBillTables(db)
      if (tables.length === 0) return { content: [{ type: 'text', text: '还没有入库的账单材料。' }], details: {} }
      const text = tables
        .map(
          (t) =>
            `材料 #${t.id}｜${t.sourceType.toUpperCase()}｜${t.fileName ?? '未命名'}｜共 ${t.rowCount} 行｜待处理 ${t.openRows} 行｜列名：${t.header.filter((h) => h).join(' | ')}`,
        )
        .join('\n')
      return { content: [{ type: 'text', text }], details: {} }
    },
  })

  const readBillTool = defineTool({
    name: 'read_bill',
    label: '读账单原表',
    description:
      '分页读回已入库账单材料的原始行（这是你看表的唯一通道，不要凭猜）。' +
      '先看表头和前几十行定列名与取值分布，再决定 apply_bill 的方案；套表后有疑问也可以回读指定行核对。',
    parameters: Type.Object({
      table_id: Type.Integer({ description: '材料 id（消息里的 table_id，或 list_bills 的返回值）' }),
      from_row: Type.Optional(Type.Integer({ description: '起始行号（1 起），默认 1' })),
      limit: Type.Optional(Type.Integer({ description: '读多少行，默认 50，最多 200' })),
    }),
    execute: async (_id, params) => {
      const view = readBillRows(db, params.table_id, params.from_row ?? 1, params.limit ?? 50)
      const lines = [
        `材料 #${view.table.id}（${view.table.fileName ?? '未命名'}）共 ${view.table.rowCount} 行，待处理 ${view.table.openRows} 行`,
        `表头：${view.table.header.filter((h) => h).join(' | ')}`,
        `第 ${view.from}–${view.to} 行：`,
        ...view.rows.map((r) => `${r.no}| ${r.cells.join(' | ')}${r.disposition === 'open' ? '' : ` 〔已处理：${r.disposition}${r.reason ? ` · ${r.reason}` : ''}〕`}`),
      ]
      const more = view.to < view.table.rowCount ? `\n（还有第 ${view.to + 1} 行起的 ${view.table.rowCount - view.to} 行没看，继续 read_bill）` : ''
      return { content: [{ type: 'text', text: lines.join('\n') + more }], details: {} }
    },
  })

  const applyBillTool = defineTool({
    name: 'apply_bill',
    label: '按方案套表入账（两段式）',
    description:
      '对你读过的账单材料提交一份「读表方案」，由程序逐行取金额、取时间、判方向与账户并生成待确认清单。' +
      '禁止自己逐行报数字——那正是会抄错的地方。方案要点：columns 给出各列在表头里的列名；' +
      'direction_column_values / account_column_values 把列里的取值映射成收支方向 / 账本账户（没覆盖到的取值会整批退回，让你补映射，不会静默归类）；' +
      'skip_when 排除不计收支的行（如已全额退款、零钱通内部流转）；categories 按商户关键词给分类；' +
      '个别行拿得准则用 row_overrides 逐行裁决（type 传 skip 即排除该行）。' +
      '调用后只生成批次待确认清单，必须用户在界面点「确认入账」才落账——不要宣称已入账。',
    parameters: Type.Object({
      table_id: Type.Integer({ description: '材料 id' }),
      columns: Type.Object({
        amount: Type.String({ description: '金额列的列名' }),
        time: Type.String({ description: '交易时间列的列名（必填，否则整批会被记到今天）' }),
        merchant: Type.Optional(Type.String({ description: '交易对方/商户列' })),
        id: Type.Optional(Type.String({ description: '可靠交易号/流水号列（参与跨批去重）' })),
        direction: Type.Optional(Type.String({ description: '收/支方向列' })),
        account: Type.Optional(Type.String({ description: '支付方式/账户列' })),
      }),
      channel: Type.Optional(Type.String({ description: '支付渠道名（微信/支付宝…），参与去重标识；不确定就不传' })),
      account_name: Type.Optional(Type.String({ description: '整批默认付款账户名（该列没法映射时用）' })),
      direction_column_values: Type.Optional(Type.Array(ValueMapSchema, { description: '方向列取值 → expense/income/transfer' })),
      account_column_values: Type.Optional(Type.Array(ValueMapSchema, { description: '账户列取值 → 账本账户名' })),
      amount_signed: Type.Optional(Type.Boolean({ description: '金额列自带正负号表方向（负=支出、正=收入）' })),
      default_type: Type.Optional(StringEnum(['expense', 'income'], { description: '既无方向列也无符号时的类别，默认 expense' })),
      skip_when: Type.Optional(
        Type.Array(Type.Object({ column: Type.String(), contains: Type.String() }), {
          description: '这些行不计收支（如 当前状态 含「已全额退款」）',
        }),
      ),
      categories: Type.Optional(
        Type.Array(
          Type.Object({
            match: Type.String({ description: '商户列关键词' }),
            op: Type.Optional(StringEnum(['contains', 'equals'])),
            category_name: Type.String(),
          }),
          { description: '按商户给分类；没命中的仍走已教规则与常识表' },
        ),
      ),
      row_overrides: Type.Optional(
        Type.Array(
          Type.Object({
            rows: Type.Optional(Type.Array(Type.Integer(), { description: '精确行号列表' })),
            from_row: Type.Optional(Type.Integer({ description: '行区间起' })),
            to_row: Type.Optional(Type.Integer({ description: '行区间止' })),
            type: Type.Optional(StringEnum(['expense', 'income', 'transfer', 'adjustment', 'skip'])),
            category_name: Type.Optional(Type.String()),
            account_name: Type.Optional(Type.String()),
          }),
          { description: '逐行/逐段例外裁决（你看过原文才敢下的判断）' },
        ),
      ),
    }),
    execute: async (
      _id,
      params,
    ): Promise<{ content: { type: 'text'; text: string }[]; details: { card?: BatchGateCardData } }> => {
      const ctx = getTurnContext()
      const plan: BillPlanInput = {
        table_id: params.table_id,
        columns: params.columns as BillPlanInput['columns'],
        channel: params.channel ?? null,
        account_name: params.account_name ?? null,
        direction_column_values: (params.direction_column_values ?? []) as BillPlanInput['direction_column_values'],
        account_column_values: (params.account_column_values ?? []) as BillPlanInput['account_column_values'],
        amount_signed: params.amount_signed ?? false,
        default_type: params.default_type as BillPlanInput['default_type'],
        skip_when: params.skip_when ?? [],
        categories: params.categories as BillPlanInput['categories'],
        row_overrides: params.row_overrides as BillPlanInput['row_overrides'],
      }
      let r: ReturnType<typeof applyBillPlan>
      try {
        r = applyBillPlan(db, plan, { sessionId: ctx.sessionId, sourceMessageId: ctx.sourceMessageId })
      } catch (e) {
        if (e instanceof BillPlanError) {
          return { content: [{ type: 'text', text: `方案没通过（材料一行都没动）：${e.message}` }], details: {} }
        }
        throw e
      }
      const tail =
        r.reviewSamples.length > 0
          ? `\n待核对 ${r.reviewCount} 行（已转待办，不会再被后续方案处理）：\n` +
            r.reviewSamples.map((s) => `  第 ${s.row} 行：${s.reason}｜${s.text}`.slice(0, 200)).join('\n')
          : ''
      const skipTail = r.skippedSamples.length > 0 ? `\n不计收支 ${r.skippedCount} 行（样例：第 ${r.skippedSamples[0].row} 行 ${r.skippedSamples[0].reason}）` : ''
      if (!r.gateId || !r.plan) {
        return {
          content: [
            {
              type: 'text',
              text: `材料 ${r.rowsConsidered} 行已全部判定为不计收支，没有需要入账的行，未生成待确认清单。${skipTail}`,
            },
          ],
          details: {},
        }
      }
      const card: BatchGateCardData = {
        kind: 'batch-gate',
        gateId: r.gateId,
        channel: r.plan.channel,
        newCount: r.newCount,
        duplicateCount: r.duplicateCount,
        unparsedCount: r.reviewCount,
        rowsConsidered: r.rowsConsidered,
        skippedCount: r.skippedCount,
        items: r.plan.items.map((it) => ({
          status: it.status,
          merchant: it.merchant ?? null,
          amountCents: it.amountCents ?? null,
          reason: it.reason ?? null,
          rowNo: it.rowNo ?? null,
        })),
      }
      const text =
        `方案已套用：材料 ${r.rowsConsidered} 行 = 将入账 ${r.newCount} + 重复跳过 ${r.duplicateCount} + 待核对 ${r.reviewCount} + 不计收支 ${r.skippedCount}。` +
        `金额与行数由程序从原表逐行取（不经我复述）。请用户在界面上点「确认入账」。${skipTail}${tail}`
      return { content: [{ type: 'text', text }], details: { card } }
    },
  })

  return [listBillsTool, readBillTool, applyBillTool]
}
