// M2 账务工具：accounts / month_report / pending（存/列/补答）。
// 与 tools.ts 同约定：每条工具走域层，不碰裸 SQL。

import { Type, StringEnum } from '@earendil-works/pi-ai'
import { defineTool, type ToolDefinition } from '@earendil-works/pi-coding-agent'
import type { Database } from 'better-sqlite3-multiple-ciphers'
import {
  getTransaction,
  getOrCreateCategoryId,
  updateFields,
  confirm as confirmTx,
  listAccounts,
} from '../domain/ledger'
import { createAccount, renameAccount } from '../domain/accounts'
import { buildReport, reportText } from '../domain/reports'
import { createPending, getPending, closePending, GATE_FIELDS } from '../domain/pending'
import { buildCard, txOf, type TurnContext } from './tools'
import type { ReportCardData } from '../../shared/types'

function previousMonthOf(today: Date): { year: number; month: number } {
  const first = new Date(today.getFullYear(), today.getMonth(), 1)
  const lastPrev = new Date(first.getFullYear(), first.getMonth(), 0)
  return { year: lastPrev.getFullYear(), month: lastPrev.getMonth() + 1 }
}

export interface M2Deps {
  db: Database
  getTurnContext: () => TurnContext
}

type PendingDetails = {
  card?: import('../../shared/types').CardData
  items?: { gateId: number; field: string; question: string; txId: number | null }[]
}

export function createM2Tools(deps: M2Deps): ToolDefinition[] {
  const { db, getTurnContext } = deps

  const accountsTool = defineTool({
    name: 'accounts',
    label: '账户管理',
    description: '列出账户 / 新增账户 / 改账户名。账户类型只能是 cash/bank/alipay/wechat 之一。',
    parameters: Type.Object({
      action: StringEnum(['list', 'add', 'rename'], { description: '默认 list' }),
      name: Type.Optional(Type.String({ description: 'add：新账户名；rename：原账户名' })),
      type: Type.Optional(StringEnum(['cash', 'bank', 'alipay', 'wechat'], { description: 'add 时必填' })),
      new_name: Type.Optional(Type.String({ description: 'rename 时：新名字' })),
    }),
    execute: async (_toolCallId, params) => {
      const action = params.action ?? 'list'
      if (action === 'add') {
        if (!params.name || !params.type) throw new Error('新增账户需要 name 和 type')
        const id = createAccount(db, { name: params.name, type: params.type as 'cash' | 'bank' | 'alipay' | 'wechat' })
        return { content: [{ type: 'text', text: `已新增账户「${params.name}」（#${id}）。` }], details: {} }
      }
      if (action === 'rename') {
        if (!params.name || !params.new_name) throw new Error('改名需要 name 和 new_name')
        renameAccount(db, params.name, params.new_name)
        return {
          content: [{ type: 'text', text: `已把账户「${params.name}」改名为「${params.new_name}」。` }],
          details: {},
        }
      }
      const rows = listAccounts(db)
      const lines = rows.map((r) => `- #${r.id} ${r.name}（${r.type}）`)
      return { content: [{ type: 'text', text: `共 ${rows.length} 个账户：\n${lines.join('\n')}` }], details: {} }
    },
  })

  const monthReportTool = defineTool({
    name: 'month_report',
    label: '月报',
    description:
      '生成月报：默认统计上月（也可指定 month=YYYY-MM）。数字由代码聚合、文本由模板生成。月报是只读呈现，不改动任何账。',
    parameters: Type.Object({
      month: Type.Optional(Type.String({ description: 'YYYY-MM；省略 = 上月' })),
    }),
    execute: async (_toolCallId, params) => {
      let year: number
      let month: number
      if (params.month) {
        const m = /^\d{4}-\d{2}$/.exec(params.month)
        if (!m) throw new Error('month 格式应为 YYYY-MM')
        year = Number(m[0].slice(0, 4))
        month = Number(m[0].slice(5, 7))
      } else {
        const prev = previousMonthOf(new Date())
        year = prev.year
        month = prev.month
      }
      const report = buildReport(db, year, month)
      const card: ReportCardData = { kind: 'report', ...report, text: reportText(report) }
      return { content: [{ type: 'text', text: card.text }], details: { card } }
    },
  })

  const pendingTool = defineTool({
    name: 'pending',
    label: '待收尾',
    description:
      '待收尾事项：list=列出未完成项；save=把一件事先存起来以后处理（question 说明悬而未决的点）；' +
      'answer=用户答复后把答案写回对应交易并关闭事项。注意：删除/批量类确认门（delete_confirm/batch_confirm）只能由用户在界面上点按钮，answer 通道对它们无效。',
    parameters: Type.Object({
      action: StringEnum(['list', 'save', 'answer'], { description: '默认 list' }),
      gate_id: Type.Optional(Type.Integer({ description: 'answer：待收尾事项 id' })),
      answer: Type.Optional(Type.String({ description: 'answer：用户的答复（如分类名、"确认"）' })),
      question: Type.Optional(Type.String({ description: 'save：要记下的问题' })),
      tx_id: Type.Optional(Type.Integer({ description: 'save：关联的交易 id，可选' })),
    }),
    execute: async (_toolCallId, params) => {
      const ctx = getTurnContext()
      const action = params.action ?? 'list'

      if (action === 'save') {
        if (!params.question) throw new Error('save 需要 question')
        const id = createPending(db, {
          txId: params.tx_id ?? null,
          sessionId: ctx.sessionId,
          field: 'note',
          question: params.question,
          payload: { txId: params.tx_id ?? null },
        })
        return { content: [{ type: 'text', text: `已记下待收尾 #${id}：${params.question}` }], details: {} as PendingDetails }
      }

      if (action === 'answer') {
        if (!params.gate_id || params.answer === undefined) throw new Error('answer 需要 gate_id 和 answer')
        // 第 4 单：对话补答与面板就地回答走同一条域层续办路径（answerPending）
        const { answerPending } = await import('../domain/pending-answer')
        const result = answerPending(db, params.gate_id, params.answer, {
          sessionId: ctx.sessionId,
          via: 'chat',
        })
        const details = result.card ? { card: result.card } : {}
        return { content: [{ type: 'text', text: result.text }], details }
      }

      const rows = db
        .prepare("SELECT id, field, question, tx_id, created_at, payload FROM pending_clarifications WHERE status='open' ORDER BY id DESC")
        .all() as unknown as { id: number; field: string; question: string; tx_id: number | null; created_at: string; payload: string | null }[]
      const items = rows.map((r) => ({
        gateId: r.id,
        field: r.field,
        question: r.question,
        txId: r.tx_id,
      }))
      if (items.length === 0) {
        return { content: [{ type: 'text', text: '当前没有待收尾事项。' }], details: {} as PendingDetails }
      }
      const lines = items.map((r) => `- [${r.gateId}] ${r.field}${r.txId ? `（交易 #${r.txId}）` : ''}：${r.question}`)
      return {
        content: [{ type: 'text', text: `共 ${items.length} 条待收尾：\n${lines.join('\n')}` }],
        details: { items },
      }
    },
  })

  void getTransaction
  return [accountsTool, monthReportTool, pendingTool]
}
