// M5 批量归类工具（D-01，两段式）。
// 与 commit_batch 同形：工具只 prepare / 只读，**绝不写账**——
//   classify_suggest：纯读建议（查库分组 + 规则/常识表建议），一行都不写；
//   classify_batch：只落「归类方案」gate，写入要等用户在界面上点确认。
// 工具 description 必须把这点说明白，否则模型会宣称"已经归类了"。

import { Type } from '@earendil-works/pi-ai'
import { defineTool, type ToolDefinition } from '@earendil-works/pi-coding-agent'
import type { Database } from 'better-sqlite3-multiple-ciphers'
import { buildClassifyCard, buildClassifyProposal, prepareClassify } from '../domain/classify'
import type { ClassifyProposalDTO } from '../../shared/types'
import type { TurnContext } from './tools'

export interface M5Deps {
  db: Database
  getTurnContext: () => TurnContext
}

/**
 * 金额格式化（与 tools.ts 的 yuan 同一口径）。
 *
 * 为什么在这里**本地写一份**而不是 import tools.ts 的：tools.ts 已经 import 了
 * 本文件，反向再 import 会形成循环依赖。宁可重复两行，也不把工具注册链绕成环。
 */
function yuan(cents: number): string {
  return (cents / 100).toFixed(2)
}

/**
 * classify_suggest 给模型看的文本（纯函数，单测直接调，不必起工具 harness）。
 *
 * 为什么 group_key 必须逐字写进这段文本（这是 D-01 两段式真正的接缝）：
 *   工具结果的 `details` **不进模型上下文**（pi-ai 的 openai-completions 只把
 *   content 里的文本块喂给模型，已实测）——只把分组放进 details，模型就永远拿不到
 *   键，classify_batch 的 assignments 填不出合法入参，两步式在真机上等于断了。
 *   `group_key` 是模型必须**逐字回填**的机器键，摆在文本里等于把接口合同直接递给模型。
 *
 * 为什么没把握的组要**明写「（无建议，请自行判断）」**而不是留空：
 *   留空模型会当成"缺字段"，自己编一个分类名顶上——那等于把错误写进确认门。
 *
 * 分组超过 limit 时只列前 limit 组（按 proposal.groups 的原顺序，不重新排序），
 * 并写明总数与截断口径，避免模型以为"就这么多组"。
 */
export function formatClassifySuggest(proposal: ClassifyProposalDTO, limit = 20): string {
  const groups = proposal.groups
  const unsure = groups.filter((g) => g.suggestedCategory === null).length
  const head = `当前待分类 ${proposal.pendingCount} 笔，分成 ${groups.length} 组，其中 ${unsure} 组没把握。`

  if (groups.length === 0) {
    // 空集不许出现 group_key / classify_batch：没有可回填的键就别教模型去调第二段
    return `${head}没有待分类的账目。`
  }

  const lines = groups.slice(0, limit).map(
    (g) =>
      `- group_key=${g.groupKey} · 商户=${g.merchant ?? '未命名'} · ${g.count} 笔 · ¥${yuan(g.totalCents)} · 建议分类=${g.suggestedCategory ?? '（无建议，请自行判断）'}`,
  )
  if (groups.length > limit) {
    lines.push(`（共 ${groups.length} 组，按笔数从多到少只列出前 ${limit} 组；其余请缩小范围后再看）`)
  }
  lines.push(
    '要落地归类请调用 classify_batch：assignments 里的 group_key 逐字照抄上面每行的 group_key，分类名填建议分类或你自己的判断；没把握的组不要瞎填，不传即可（那些组不执行）。',
  )
  return [head, ...lines].join('\n')
}

export function createM5Tools(deps: M5Deps): ToolDefinition[] {
  const { db, getTurnContext } = deps

  const classifySuggestTool = defineTool({
    name: 'classify_suggest',
    label: '待分类分组建议（只读）',
    description:
      '查看当前所有待分类的账目：按「商户 + 收支类型」分组，给出每组笔数、金额合计与建议分类。' +
      '建议来源是用户规则与本地常识表（只查不写）。' +
      '这是**只读**的：不改任何账目。要落地归类请再调用 classify_batch。',
    parameters: Type.Object({
      batch_id: Type.Optional(Type.String({ description: '只看某个批次的待分类；不传 = 全部待分类' })),
    }),
    execute: async (_toolCallId, params) => {
      const proposal = buildClassifyProposal(db, { batchId: params.batch_id ?? null })
      // 文本里必须带 group_key：details 不进模型上下文（见 formatClassifySuggest 的注释）
      const text = formatClassifySuggest(proposal)
      return { content: [{ type: 'text', text }], details: { proposal } }
    },
  })

  const classifyBatchTool = defineTool({
    name: 'classify_batch',
    label: '批量归类（两段式）',
    description:
      '把待分类账目按分组一次性归类：先调用 classify_suggest 拿到 group_key 与建议分类，' +
      '再把「分组 → 分类名」的映射用 assignments 传进来。' +
      '调用后只生成「批量归类待确认」方案，入账要等用户在界面上点确认——不要宣称已归类、已入账。' +
      '没把握的组不要瞎填，留在 assignments 里不传即可（那些组不执行）。',
    parameters: Type.Object({
      assignments: Type.Array(
        Type.Object({
          group_key: Type.String({ description: '分组 key（classify_suggest 给出的 group_key，原样回传）' }),
          category_name: Type.String({ description: '该组要归到的分类名（如 餐饮/交通）' }),
        }),
        { minItems: 1 },
      ),
      batch_id: Type.Optional(Type.String({ description: '只处理某个批次的待分类；不传 = 全部待分类' })),
    }),
    execute: async (_toolCallId, params) => {
      const ctx = getTurnContext()
      const res = prepareClassify(db, {
        assignments: params.assignments.map((a) => ({ groupKey: a.group_key, categoryName: a.category_name })),
        batchId: params.batch_id ?? null,
        sessionId: ctx.sessionId,
        sourceMessageId: ctx.sourceMessageId,
      })
      const card = buildClassifyCard(db, res.gateId)
      const text = `已生成归类方案：${card?.assignedCount ?? 0} 笔待用户确认。请用户在界面上点「确认归类」。`
      return { content: [{ type: 'text', text }], details: { card } }
    },
  })

  return [classifySuggestTool, classifyBatchTool]
}
