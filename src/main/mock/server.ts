// 离线演示（mock，决定记录 Q1 最小版）：内置确定性假模型。
// 实现 OpenAI 兼容 /chat/completions（SSE 流式），规则解析用户消息 → 产出账务工具调用；
// 工具结果回来后把工具返回的模板话术作为最终回复。无网络、零成本、全部对话流可演示（legacy mock 口径）。
// 仅在设置里显式开启时启动，监听 127.0.0.1 随机端口。

import http from 'node:http'
import type { AddressInfo } from 'node:net'
import { nowIso } from '../db/time'

interface ChatMessage {
  role: string
  content: string | { type: string; text?: string }[]
  tool_calls?: { id: string; type: string; function: { name: string; arguments: string } }[]
  tool_call_id?: string
}

function userText(msgs: ChatMessage[]): string {
  for (let i = msgs.length - 1; i >= 0; i--) {
    if (msgs[i].role === 'user') {
      const c = msgs[i].content
      if (typeof c === 'string') return c
      // 过滤 pi 对不支持视觉模型的图片降级占位符（"(image omitted: …)"）——不是用户说的话
      return c
        .filter((p) => p.type === 'text' && !/^\(image omitted/.test(p.text ?? ''))
        .map((p) => p.text ?? '')
        .join(' ')
        .trim()
    }
  }
  return ''
}

/** 最后一条 user 消息之后的工具结果（同一轮内）；上一轮的历史不算。 */
function lastToolResultText(msgs: ChatMessage[]): string | null {
  let lastUser = -1
  for (let i = msgs.length - 1; i >= 0; i--) {
    if (msgs[i].role === 'user') {
      lastUser = i
      break
    }
  }
  for (let i = msgs.length - 1; i > lastUser; i--) {
    if (msgs[i].role === 'tool') {
      const c = msgs[i].content
      const text = typeof c === 'string' ? c : c.filter((p) => p.type === 'text').map((p) => p.text ?? '').join('')
      return text || null
    }
  }
  return null
}

/** 上一条 assistant 消息调的是哪个工具（用于"读表 → 出方案"两步剧本）。 */
function lastToolName(msgs: ChatMessage[]): string | null {
  for (let i = msgs.length - 1; i >= 0; i--) {
    const name = msgs[i].tool_calls?.[msgs[i].tool_calls!.length - 1]?.function?.name
    if (name) return name
    if (msgs[i].role === 'user') return null
  }
  return null
}

/** 从消息里的「列名：A | B | C」样本行确定性地挑出各列，不猜不编。 */
function billColumns(msgs: ChatMessage[]): {
  tableId: number
  columns: Record<string, string>
  channel: string | null
} | null {
  const t = userText(msgs)
  const idM = /table_id=(\d+)/.exec(t)
  const headerM = /列名：(.*)/.exec(t)
  if (!idM || !headerM) return null
  const cols = headerM[1].split('|').map((c) => c.trim()).filter(Boolean)
  const pick = (re: RegExp): string | undefined => cols.find((c) => re.test(c))
  const amount = pick(/金额/)
  const time = pick(/交易时间|时间|日期/)
  if (!amount || !time) return null
  const columns: Record<string, string> = { amount, time }
  const merchant = pick(/交易对方|商户|商品/)
  const id = pick(/交易单号|流水号|订单号|单号/)
  const direction = pick(/收\/支|收支|收-支/)
  const account = pick(/^(支付方式|收\/付款方式|支付账户|付款账户|账户(?:名|名称)?)$/)
  if (merchant) columns.merchant = merchant
  if (id) columns.id = id
  if (direction) columns.direction = direction
  if (account) columns.account = account
  const fileM = /来源文件「(.*?)」/.exec(t)
  const file = fileM?.[1] ?? ''
  const channel = /微信/.test(file + t) ? '微信支付' : /支付宝/.test(file + t) ? '支付宝' : null
  return { tableId: Number(idM[1]), columns, channel }
}

/** 确定性规则解析（legacy mock 口径）。 */
/** 商户关键词 → 分类（离线演示确定性映射；命中教过的规则优先） */
const MERCHANT_CATEGORIES: [RegExp, string][] = [
  [/麦当劳|肯德基|必胜客|汉堡王|麦记/, '餐饮'],
  [/星巴克|瑞幸|咖啡|喜茶|奈雪|茶百道|蜜雪|costa|manner|tims/, '咖啡'],
  [/海底捞|外卖|美团|饿了么|兰州拉面|沙县|黄焖鸡|麻辣烫|火锅|烧烤|奶茶|早餐|午餐|晚餐|饭|面馆|食堂|小吃|餐厅/, '餐饮'],
  [/打车|滴滴|出租车|地铁|公交|高铁|火车|机票|航班|停车|加油|共享单车|哈啰|交通/, '交通'],
  [/超市|沃尔玛|家乐福|盒马|永辉|711|全家|罗森|便利店|京东|淘宝|拼多多|购物|商场|书店|文具/, '购物'],
]

function merchantGuess(t: string): string | null {
  for (const [re, cat] of MERCHANT_CATEGORIES) {
    if (re.test(t)) return cat
  }
  return null
}

/** 批次演示用自增交易号（模块级：decide 为模块级函数，跨服务器实例共享无妨）。 */
let mockBatchSeq = 0

/**
 * ②B 归类剧本：从 **classify_suggest 的工具结果文本**里解析出「分组 → 分类名」。
 *
 * 数据源是工具结果而不是用户指令：引擎的 classify_suggest 现在把分组清单
 * （`- group_key=… · 商户=… · N 笔 · ¥… · 建议分类=…`）写进**模型可见文本**，
 * 而 details 不进模型上下文——所以真实模型也只能从这段文本里读键。
 * 离线演示走同一条路，才不会把"绕开缺口"的样子演示给用户看。
 *
 * 形参名**逐字照工具 schema**（group_key / category_name，snake_case）——
 * 写成驼峰会被 pi 的入参校验挡下来，模型看到的只是一句校验失败。
 *
 * 分类名的确定性口径：建议分类 → 商户关键词兜底 → 其他（与 record 剧本同一套）。
 *
 * 解析不出来就返回空数组：调用方随后会**如实回一句文本**（不硬编假分组、不硬编假数字）。
 */
function classifyAssignments(toolText: string | null): { group_key: string; category_name: string }[] {
  const out: { group_key: string; category_name: string }[] = []
  if (!toolText) return out
  const re = /^- group_key=(.+?) · 商户=(.*?) · (\d+) 笔 · ¥-?[\d.]+ · 建议分类=(.*)$/gm
  let m = re.exec(toolText)
  while (m !== null) {
    const suggested = m[4].trim()
    const category_name =
      suggested && suggested !== '（无建议，请自行判断）' ? suggested : merchantGuess(m[2].trim()) ?? '其他'
    out.push({ group_key: m[1], category_name })
    m = re.exec(toolText)
  }
  return out
}

/** 通知只按已知结果生成回执；任意说明/写作指令不作为回复内容。 */
function notificationReply(text: string): string {
  const unknown = '（离线演示）暂时无法确认这次操作的结果，请查看界面和账本状态。'
  const validCount = (value: string, minimum = 0): boolean => Number.isSafeInteger(Number(value)) && Number(value) >= minimum
  if (/^系统通知：用户取消了刚才的删除操作，账目未变。/.test(text)) {
    return '已取消删除，账目未变。'
  }
  const failure = /^系统通知：((?:批次执行|批次|批量归类|归类|删除|入账|执行|操作)?)(失败|未完成)(?:，(账目未改变|账目未变))?。/.exec(text)
  if (failure) return `${failure[1] || '操作'}${failure[2]}${failure[3] ? `，${failure[3]}` : ''}。`
  // batchFollowUpSummary 的结果在第二句，转账结果还在后段；不靠截第一句净化。
  const result = /^系统通知：用户已在界面确认批次入账。已完成 (\d+) 笔（其中 (\d+) 笔缺分类转待确认），重复跳过 (\d+) 笔，缺金额待核对 (\d+) 笔(?:；(\d+) 笔转账因缺转入\/转出账户未入账（([\s\S]*)）(?=。(?:请主动逐笔追问用户这笔转账的「转出账户」和「转入账户」|请引导用户在这笔原待办里补齐「转出账户」和「转入账户」，保留原金额，提交后继续补记原行；不要另记一笔或忽略原待办，不要臆造账户。)))?。/.exec(text)
  if (result) {
    if (!result.slice(1, 5).every((value) => validCount(value)) || Number(result[2]) > Number(result[1]) || (result[5] !== undefined && !validCount(result[5], 1))) return unknown
    let reply = `批次已处理：已完成 ${result[1]} 笔（其中 ${result[2]} 笔缺分类转待确认），重复跳过 ${result[3]} 笔，缺金额待核对 ${result[4]} 笔。`
    if (result[5]) {
      // 商户字段来自材料，可能夹指令；只提取逐笔金额，绝不原样回显这个自由文本。
      const amounts = [...result[6].matchAll(/ ¥(-?\d+\.\d{2})(?=、(?!\s*¥-?\d+\.\d{2}(?:、|$))|$)/g)].map((m) => `¥${m[1]}`)
      const details = amounts.length === Number(result[5]) ? `（金额：${amounts.join('、')}）` : '（金额明细请查看待收尾）'
      reply += `${result[5]} 笔转账因缺转入/转出账户未入账${details}。这些转账还需补充转出账户和转入账户。`
    }
    return reply
  }
  const deleted = /^系统通知：用户已在界面确认删除（交易 #(\d+)，现状态 deleted）。/.exec(text)
  if (deleted) return validCount(deleted[1], 1) ? `交易 #${deleted[1]} 已删除，可随时恢复。` : unknown
  const record = /^系统通知：用户已在界面确认入账（交易 #(\d+)，现状态 confirmed）。/.exec(text)
  if (record) return validCount(record[1], 1) ? `交易 #${record[1]} 已入账。` : unknown
  const batch = /^系统通知：批次已入账 (\d+) 笔。/.exec(text)
  if (batch) return validCount(batch[1]) ? `批次已入账 ${batch[1]} 笔。` : unknown
  const classifiedBatch = /^系统通知：用户已在界面确认批量归类，(\d+) 笔入账（(\d+) 组）。/.exec(text)
  if (classifiedBatch) {
    if (!validCount(classifiedBatch[1]) || !validCount(classifiedBatch[2]) || Number(classifiedBatch[2]) > Number(classifiedBatch[1])) return unknown
    return `已归类并入账 ${classifiedBatch[1]} 笔（${classifiedBatch[2]} 组）。`
  }
  const classified = /^系统通知：已归类 (\d+) 笔。/.exec(text)
  if (classified) return validCount(classified[1]) ? `已归类 ${classified[1]} 笔。` : unknown
  return unknown
}

export function decide(
  messages: ChatMessage[],
  lastTxId = 0,
): { kind: 'tool'; name: string; args: Record<string, unknown> } | { kind: 'text'; text: string } {
  const t = userText(messages).trim()
  // 通知优先于工具结果/两步剧本：只知会，不再下单，也不把内部工具文本当回执。
  if (/^系统通知/.test(t)) {
    return { kind: 'text', text: notificationReply(t) }
  }
  const toolResult = lastToolResultText(messages)
  // 第 8 单剧本：读完表（read_bill 回来）→ 交一份从列名确定性推出来的读表方案
  if (lastToolName(messages) === 'read_bill' && toolResult) {
    const b = billColumns(messages)
    if (b) {
      const args: Record<string, unknown> = { table_id: b.tableId, columns: b.columns }
      if (b.channel) args.channel = b.channel
      if (b.columns.account) {
        // 账户只认原表完整单元格，不用包含映射（「零钱通」「未知银行卡」不能冒充已知账户）。
        // 先读完本表，再逐行给显式账户；未识别值仍由原表预检拒绝，空白仍是缺账户待办。
        const more = /^（还有第 (\d+) 行起的 \d+ 行没看，继续 read_bill）$/m.exec(toolResult)
        if (more) {
          return { kind: 'tool', name: 'read_bill', args: { table_id: b.tableId, from_row: Number(more[1]), limit: 200 } }
        }
        const accounts = new Map([
          ['零钱', '微信'], ['余额', '支付宝'],
          ['微信', '微信'], ['支付宝', '支付宝'], ['现金', '现金'], ['银行卡', '银行卡'],
        ])
        const rowOverrides: { rows: number[]; account_name: string }[] = []
        for (let i = messages.length - 1; i >= 0 && messages[i].role !== 'user'; i--) {
          const msg = messages[i]
          if (msg.role !== 'tool') continue
          const text = typeof msg.content === 'string' ? msg.content : msg.content.map((p) => p.text ?? '').join('')
          if (!text.startsWith(`材料 #${b.tableId}（`)) continue
          const headers = [...text.matchAll(/^表头：(.*)$/gm)]
          if (headers.length !== 1) continue
          const header = headers[0][1].split(' | ')
          const accountIndex = header.indexOf(b.columns.account)
          if (accountIndex < 0) continue
          const range = /^第 (\d+)–(\d+) 行：$/m.exec(text)
          const rows = [...text.matchAll(/^(\d+)\| (.*)$/gm)]
          // 换行也可能伪造行号；行数、连续行号及列数都对上才解释这一页。
          if (!range || rows.length !== Number(range[2]) - Number(range[1]) + 1 ||
            rows.some((r, n) => Number(r[1]) !== Number(range[1]) + n || r[2].split(' | ').length !== header.length)) continue
          for (const match of rows) {
            const cells = match[2].split(' | ')
            const account_name = accounts.get(cells[accountIndex].trim())
            if (account_name) rowOverrides.push({ rows: [Number(match[1])], account_name })
          }
        }
        if (rowOverrides.length) args.row_overrides = rowOverrides
      }
      if (b.columns.direction) {
        // 演示用确定性口径：微信账单里 收/支 为「不计收支」或「/」的行都不算账
        args.skip_when = [
          { column: b.columns.direction, contains: '不计' },
          { column: b.columns.direction, contains: '/' },
        ]
      }
      return { kind: 'tool', name: 'apply_bill', args }
    }
  }
  // ②B 归类剧本（真实工具两步式）：classify_suggest 看有哪些待分类 → classify_batch 落方案门。
  // 必须放在 if (toolResult) 之前：工具结果回来了、要决定下一步是哪支剧本。
  const prevTool = lastToolName(messages)
  if (prevTool === 'classify_batch') {
    // 工具真失败时**不许**回「方案已生成」：把引擎给的原文顶出去（校验失败/未知分组/分类名为空…）
    if (toolResult && /Validation failed|未知分组|分类名为空|归类方案为空/.test(toolResult)) {
      return { kind: 'text', text: toolResult }
    }
    return { kind: 'text', text: '方案已生成，等你在下面点确认。' }
  }
  if (prevTool === 'classify_suggest') {
    // 分组键从**工具结果文本**里读（与真实模型同一条路），不再要求用户指令里带指派
    const assignments = classifyAssignments(toolResult)
    if (assignments.length > 0) {
      return { kind: 'tool', name: 'classify_batch', args: { assignments } }
    }
    // 解析不出任何分组 → 如实转述 classify_suggest 的真实结论，绝不硬编假分组
    return { kind: 'text', text: toolResult ?? '现在没有待分类的账。' }
  }
  if (toolResult) {
    return { kind: 'text', text: toolResult }
  }
  // 账单材料已入库（消息里带 table_id 与列名样本）→ 先读表再出方案，绝不逐行报数
  const staged = billColumns(messages)
  if (staged) {
    return { kind: 'tool', name: 'read_bill', args: { table_id: staged.tableId, from_row: 1, limit: 50 } }
  }

  // ②B 归类：先问引擎「有哪些待分类」，方案门由 classify_batch 真落（引擎不动一个字）
  if (/归类/.test(t)) {
    return { kind: 'tool', name: 'classify_suggest', args: {} }
  }

  // 删除：删掉 #3 / 删掉这笔（用最近一笔）
  const delM = /(?:删掉|删除)\s*#?(\d+)/.exec(t)
  if (delM) {
    return { kind: 'tool', name: 'delete', args: { tx_id: Number(delM[1]) } }
  }
  if (/(?:删掉|删除)/.test(t) && /这笔|那笔|刚才/.test(t)) {
    if (lastTxId > 0) return { kind: 'tool', name: 'delete', args: { tx_id: lastTxId } }
    return { kind: 'text', text: '（离线演示）还没有可删的交易，先记一笔吧。' }
  }
  // 拆账：拆成 20 + 15
  const splitM = /拆成\s*(\d+(?:\.\d+)?)\s*\+\s*(\d+(?:\.\d+)?)/.exec(t)
  if (splitM && lastTxId > 0) {
    return {
      kind: 'tool',
      name: 'split',
      args: {
        tx_id: lastTxId,
        items: [
          { amount_cents: Math.round(Number(splitM[1]) * 100), category_name: '餐饮' },
          { amount_cents: Math.round(Number(splitM[2]) * 100), category_name: '购物' },
        ],
      },
    }
  }
  // 改分类：这笔改成 X
  const updM = /(?:这|那)笔改成\s*([一-龥]{1,8})/.exec(t)
  if (updM && lastTxId > 0) {
    return { kind: 'tool', name: 'update', args: { tx_id: lastTxId, category_name: updM[1] } }
  }
  // 批次含转账（第 5 单真实崩溃场景复现）：账单里混入一笔零钱通转入（transfer）——
  // 执行时应跳过该笔（缺转入/转出账户不能入账）、其余正常入账、不崩溃、gate 关闭。
  if (/账单|批次|批量/.test(t) && /转账|零钱通|转入/.test(t)) {
    return {
      kind: 'tool',
      name: 'commit_batch',
      args: {
        source_type: 'csv',
        channel: '演示渠道',
        items: [
          { amount_cents: 2000, tx_type: 'expense', merchant: '演示打车', reliable_id: `DEMO-${Date.now().toString(36)}-${++mockBatchSeq}-t1`, occurred_at: nowIso(), account_name: '微信', category_name: '交通' },
          { amount_cents: 10152, tx_type: 'transfer', merchant: '零钱通转入', reliable_id: `DEMO-${Date.now().toString(36)}-${mockBatchSeq}-t2`, source_text: '零钱通转入 101.52', occurred_at: nowIso(), account_name: '微信' },
          { amount_cents: 800, tx_type: 'expense', merchant: '演示早餐', reliable_id: `DEMO-${Date.now().toString(36)}-${mockBatchSeq}-t3`, occurred_at: nowIso(), account_name: '微信', category_name: '餐饮' },
        ],
      },
    }
  }
  // 批次：账单/批次/批量 → 确定性演示批次（2 笔可入账 + 1 笔缺金额）
  if (/账单|批次|批量/.test(t)) {
    return {
      kind: 'tool',
      name: 'commit_batch',
      args: {
        source_type: 'csv',
        channel: '演示渠道',
        items: [
          { amount_cents: 1200, tx_type: 'expense', merchant: '演示甲', reliable_id: `DEMO-${Date.now().toString(36)}-${++mockBatchSeq}-001`, occurred_at: nowIso(), account_name: '微信', category_name: '购物' },
          { amount_cents: 3400, tx_type: 'expense', merchant: '演示乙', reliable_id: `DEMO-${Date.now().toString(36)}-${mockBatchSeq}-002`, occurred_at: nowIso(), account_name: '微信', category_name: '餐饮' },
          { merchant: '演示丙（金额缺失）', reliable_id: `DEMO-${Date.now().toString(36)}-${mockBatchSeq}-003`, source_text: '演示丙，金额看不清' },
        ],
      },
    }
  }

  // 教规则："以后 X 都算 Y"
  const teach = /(?:以后\s*)?(.{2,20}?)都算\s*(.{1,12}?)[。.！!？?\s]*$/.exec(t)
  if (t.includes('都算') && teach) {
    return { kind: 'tool', name: 'teach', args: { action: 'set_category', match_merchant: teach[1], category_name: teach[2] } }
  }
  // 月报
  if (/月报/.test(t)) {
    return { kind: 'tool', name: 'month_report', args: {} }
  }
  // 待收尾
  if (/待收尾|待确认/.test(t)) {
    return { kind: 'tool', name: 'query', args: { mode: 'pending_list' } }
  }
  // 查账
  if (/花了多少|超支|支出多少|收入多少|花了多少|花超|统计|花了/.test(t)) {
    const income = /收入/.test(t)
    const category = /餐饮|吃饭|外卖/.test(t) ? '餐饮' : /咖啡/.test(t) ? '咖啡' : /交通|打车|地铁/.test(t) ? '交通' : null
    const args: Record<string, unknown> = {
      mode: 'aggregate',
      metric: income ? 'total_income' : /按分类|分类/.test(t) ? 'by_category' : 'total_expense',
      period: /上月/.test(t) ? 'last_month' : /最近7|最近 7/.test(t) ? 'last_7_days' : /本周/.test(t) ? 'this_week' : 'this_month',
    }
    if (category) args.category_name = category
    if (/超支|比上?月/.test(t)) args.compare_previous = true
    return { kind: 'tool', name: 'query', args }
  }
  // 删除
  const del = /删掉|删除/.exec(t)
  if (del && /这笔|那笔|刚才/.test(t)) {
    return { kind: 'text', text: '（离线演示）请直接在账本里点那笔交易，或告诉我它的编号（如 #3），我再发起删除确认。' }
  }
  // 记账：宽松金额解析（确定性规则；仅短句，避免把长材料误当记账）
  const numM = /(\d+(?:\.\d+)?)/.exec(t)
  if (numM && t.length <= 30) {
    const yuan = Number(numM[1])
    if (yuan > 0) {
      const before = t.slice(0, numM.index).trim()
      let after = t.slice(numM.index + numM[1].length).trim()
      const toM = /(?:转到?|到|给)\s*([一-龥]{2,6})/.exec(after)
      const isTransfer = /零钱通|转出|转入|转账|提现|余额宝/.test(t)
      const isIncome = /工资|红包|报销|进账|收到/.test(t)
      let merchant = before
        .replace(/^(?:记一笔?|记一下?|记|买|消费|花了?|支出|转出|转入|转账|提现)/, '')
        .replace(/[，,。.！!？?\s]+$/, '')
        .trim()
      if (!merchant) {
        merchant = after
          .replace(/^(?:元|块)/, '')
          .replace(/(?:转到?|到|给)\s*[一-龥]{2,6}/, '')
          .replace(/[，,。.！!！？?\s]+$/, '')
          .trim()
      }
      if (merchant && merchant.length >= 1 && merchant.length <= 30) {
        const args: Record<string, unknown> = {
          amount_cents: Math.round(yuan * 100),
          tx_type: isTransfer ? 'transfer' : isIncome ? 'income' : 'expense',
          merchant,
          confidence: 0.92,
          note: t,
        }
        if (isTransfer && toM) args.to_account_name = toM[1]
        if (!isTransfer && !isIncome) {
          args.category_name = merchantGuess(t) ?? '其他' // 粗分类保底：离线演示全链路可 confirmed
        }
        return { kind: 'tool', name: 'record', args }
      }
    }
  }
  return {
    kind: 'text',
    text: '（离线演示模式 · 确定性假模型）试试：「星巴克 35」「这个月餐饮花了多少」「上月超支了吗」「上月月报」「以后星巴克都算咖啡」「待收尾」。',
  }
}

function sseChunk(res: http.ServerResponse, id: string, model: string, delta: Record<string, unknown>, finish: string | null): void {
  res.write(
    `data: ${JSON.stringify({
      id,
      object: 'chat.completion.chunk',
      created: Math.floor(Date.now() / 1000),
      model,
      choices: [{ index: 0, delta, finish_reason: finish }],
    })}\n\n`,
  )
}

export interface MockServer {
  port: number
  close(): Promise<void>
}

export function startMockServer(): Promise<MockServer> {
  // 记忆最近一笔交易 id（工具结果里解析），供删/改/拆的确定性演示
  let lastTxId = 0
  const server = http.createServer((req, res) => {
    if (!req.url || !req.url.endsWith('/chat/completions')) {
      res.writeHead(404)
      res.end()
      return
    }
    const chunks: Buffer[] = []
    req.on('data', (c: Buffer) => chunks.push(c))
    req.on('end', () => {
      let messages: ChatMessage[] = []
      try {
        const body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as { messages?: ChatMessage[] }
        messages = body.messages ?? []
      } catch {
        messages = []
      }
      if (process.env.MZ_MOCK_DEBUG) {
        console.log('MOCK-REQ roles:', JSON.stringify(messages.map((m) => ({ role: m.role, c: typeof m.content === 'string' ? m.content.slice(0, 40) : JSON.stringify(m.content).slice(0, 300) }))))
        console.log('MOCK-DECIDE:', JSON.stringify(decide(messages)).slice(0, 160))
      }
      // 从最近的工具结果里解析"交易 #N"，维护 lastTxId
      for (let i = messages.length - 1; i >= 0; i--) {
        if (messages[i].role === 'tool') {
          const c = messages[i].content
          const txt = typeof c === 'string' ? c : (Array.isArray(c) ? c.filter((p) => p.type === 'text').map((p) => p.text ?? '').join(' ') : '')
          const m = /交易 #(\d+)/.exec(txt)
          if (m) lastTxId = Number(m[1])
          break
        }
      }
      let decision: ReturnType<typeof decide>
      try {
        decision = decide(messages, lastTxId)
      } catch (err) {
        decision = { kind: 'text', text: `（离线演示内部错误已兜底：${(err as Error).message}）` }
      }
      const id = `mock-${Date.now()}`
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' })
      if (decision.kind === 'tool') {
        sseChunk(res, id, 'mock-mingzhang', { role: 'assistant', content: null }, null)
        sseChunk(
          res,
          id,
          'mock-mingzhang',
          { tool_calls: [{ index: 0, type: 'function', id: `call-${id}`, function: { name: decision.name, arguments: '' } }] },
          null,
        )
        sseChunk(
          res,
          id,
          'mock-mingzhang',
          { tool_calls: [{ index: 0, function: { arguments: JSON.stringify(decision.args) } }] },
          null,
        )
        sseChunk(res, id, 'mock-mingzhang', {}, 'tool_calls')
      } else {
        sseChunk(res, id, 'mock-mingzhang', { role: 'assistant', content: '' }, null)
        for (const piece of decision.text.match(/.{1,16}/gs) ?? []) {
          sseChunk(res, id, 'mock-mingzhang', { content: piece }, null)
        }
        sseChunk(res, id, 'mock-mingzhang', {}, 'stop')
      }
      res.write('data: [DONE]\n\n')
      res.end()
    })
  })
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const port = (server.address() as AddressInfo).port
      resolve({
        port,
        close: () =>
          new Promise<void>((done) => {
            server.close(() => done())
          }),
      })
    })
  })
}
