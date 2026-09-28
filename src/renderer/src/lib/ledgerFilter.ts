// 账本屏的筛选状态层（纯函数，无 React / 无 IPC —— 可单测、可复用）。
//
// 纪律：
//   ① **筛选一律走服务端**：这里只把界面状态翻译成 listLedger 的参数（LedgerFilter），
//      分页也在服务端（limit/offset），前端绝不「先取一页再自己过滤」——否则 total 与 agg 都会撒谎。
//   ② 界面状态与 DTO 解耦：类型/状态用字面量映射成中文标签，未知值原样透出，不猜。
//   ③ 金额区间按「元」输入，换算成整数分（R1）；空/非法 = 不加这个条件（不静默当 0）。

import type { LedgerFilter } from '../../../shared/types'

/** 每页行数（规格 §3.2：50 行/页）。 */
export const PAGE_SIZE = 50

/** 时间范围：全部 / 本月 / 上月 / 自定义月份。 */
export type TimeRange = 'all' | 'thisMonth' | 'lastMonth' | 'custom'

export interface LedgerFilterState {
  range: TimeRange
  /** 自定义月份 'YYYY-MM'（range === 'custom' 时生效）。 */
  customMonth: string
  /** 交易类型：'' = 不限；expense / income / transfer / adjustment。 */
  type: string
  /** 分类名（服务端按 categories.name 精确匹配）。 */
  category: string
  /** 账户名（本方或转账对方，服务端口径）。 */
  account: string
  /** 金额下限 / 上限（元，字符串原样保留用户输入）。 */
  amountMin: string
  amountMax: string
  /** 状态：'' = 不限；confirmed / needs_review / deleted。 */
  state: string
  /** 关键词（商户 / 备注 / 分类名，服务端口径）。 */
  q: string
}

export const DEFAULT_FILTERS: LedgerFilterState = {
  range: 'all',
  customMonth: '',
  type: '',
  category: '',
  account: '',
  amountMin: '',
  amountMax: '',
  // 默认视图 = 正常（confirmed）：已删除的账不该混在日常流水里（撤回路径见 §3.2：
  // 筛「状态=已删除」再点恢复）。默认状态下**不出 chip**，所以空账本态不会被误判成「筛选无结果」。
  state: 'confirmed',
  q: '',
}

/** 类型 / 状态的中文标签（与后端字面量一一对应；未知值原样透出）。 */
export const TYPE_LABELS: Record<string, string> = {
  expense: '支出',
  income: '收入',
  transfer: '转账',
  adjustment: '不计收支',
}

export const STATE_LABELS: Record<string, string> = {
  raw_input: '待解析',
  parsed: '待确认',
  needs_review: '待核对',
  confirmed: '正常',
  deleted: '已删除',
}

/** 状态徽标配色（tokens 语义：黄=待核对 / 红=已删除 / 蓝=过渡态 / 灰=常态）。 */
export function stateTone(state: string): 'green' | 'yellow' | 'blue' | 'red' | 'gray' {
  switch (state) {
    case 'needs_review':
      return 'yellow'
    case 'deleted':
      return 'red'
    case 'raw_input':
    case 'parsed':
      return 'blue'
    default:
      return 'gray'
  }
}

const p2 = (n: number): string => String(n).padStart(2, '0')

/** 'YYYY-MM' ← Date。 */
export function monthOf(d: Date): string {
  return `${d.getFullYear()}-${p2(d.getMonth() + 1)}`
}

/** 上一个自然月 'YYYY-MM'。 */
export function prevMonthOf(d: Date): string {
  return monthOf(new Date(d.getFullYear(), d.getMonth() - 1, 1))
}

/** 时间范围 → 'YYYY-MM'；全部 = undefined（不传 month）。自定义月份格式非法 = undefined（不硬编当前月）。 */
export function monthFor(state: LedgerFilterState, now: Date = new Date()): string | undefined {
  switch (state.range) {
    case 'thisMonth':
      return monthOf(now)
    case 'lastMonth':
      return prevMonthOf(now)
    case 'custom':
      return /^\d{4}-\d{2}$/.test(state.customMonth.trim()) ? state.customMonth.trim() : undefined
    default:
      return undefined
  }
}

/** 元（字符串）→ 整数分；空串 / 非数字 → null（= 不加该条件）。 */
export function centsOf(input: string): number | null {
  const t = input.trim()
  if (!t) return null
  const n = Number(t)
  if (!Number.isFinite(n)) return null
  return Math.round(n * 100)
}

/** 界面筛选状态 + 页码 → listLedger 参数（分页也走服务端）。 */
export function toLedgerFilter(state: LedgerFilterState, page: number, now: Date = new Date()): LedgerFilter {
  const f: LedgerFilter = {
    limit: PAGE_SIZE,
    offset: Math.max(0, (Math.max(1, page) - 1) * PAGE_SIZE),
  }
  const month = monthFor(state, now)
  if (month) f.month = month
  if (state.type) f.type = state.type
  if (state.category) f.category = state.category
  if (state.account) f.account = state.account
  if (state.state) f.state = state.state
  const q = state.q.trim()
  if (q) f.q = q
  const min = centsOf(state.amountMin)
  const max = centsOf(state.amountMax)
  if (min !== null) f.amountMinCents = min
  if (max !== null) f.amountMaxCents = max
  return f
}

/** 生效筛选的 chips（可单个移除）。key = 要清掉的那一项。 */
export interface FilterChip {
  key: 'range' | 'type' | 'category' | 'account' | 'amount' | 'state' | 'q'
  label: string
}

/** 金额 chip 文案（元，两位小数；只填一端就说单端）。 */
function amountChipLabel(min: string, max: string): string {
  const lo = centsOf(min)
  const hi = centsOf(max)
  const yuan = (c: number): string => `¥${(c / 100).toFixed(2)}`
  if (lo !== null && hi !== null) return `金额：${yuan(lo)} ~ ${yuan(hi)}`
  if (lo !== null) return `金额：≥ ${yuan(lo)}`
  if (hi !== null) return `金额：≤ ${yuan(hi)}`
  return ''
}

export function activeChips(state: LedgerFilterState, now: Date = new Date()): FilterChip[] {
  const chips: FilterChip[] = []
  if (state.range !== 'all') {
    const m = monthFor(state, now)
    const label = state.range === 'thisMonth' ? '本月' : state.range === 'lastMonth' ? '上月' : '自定义'
    chips.push({ key: 'range', label: m ? `时间：${label}（${m}）` : `时间：${label}（未选月）` })
  }
  if (state.type) chips.push({ key: 'type', label: `类型：${TYPE_LABELS[state.type] ?? state.type}` })
  if (state.category) chips.push({ key: 'category', label: `分类：${state.category}` })
  if (state.account) chips.push({ key: 'account', label: `账户：${state.account}` })
  const amt = amountChipLabel(state.amountMin, state.amountMax)
  if (amt) chips.push({ key: 'amount', label: amt })
  if (state.state && state.state !== DEFAULT_FILTERS.state) {
    chips.push({ key: 'state', label: `状态：${STATE_LABELS[state.state] ?? state.state}` })
  }
  if (state.q.trim()) chips.push({ key: 'q', label: `关键词：${state.q.trim()}` })
  return chips
}

/** 移除单个 chip（金额 chip 同时清两端）。 */
export function removeChip(state: LedgerFilterState, key: FilterChip['key']): LedgerFilterState {
  switch (key) {
    case 'range':
      return { ...state, range: 'all', customMonth: '' }
    case 'type':
      return { ...state, type: '' }
    case 'category':
      return { ...state, category: '' }
    case 'account':
      return { ...state, account: '' }
    case 'amount':
      return { ...state, amountMin: '', amountMax: '' }
    case 'state':
      // 取消状态 chip = 回到默认视图（正常），不是「不限」
      return { ...state, state: DEFAULT_FILTERS.state }
    case 'q':
      return { ...state, q: '' }
    default:
      return state
  }
}

/** 是否处于「非默认筛选」：用来区分「空账本态」与「筛选无结果态」。 */
export function hasActiveFilters(state: LedgerFilterState): boolean {
  return activeChips(state).length > 0
}

/** 金额展示：整数分 → ¥1,234.50（配 .mz-num 做 tabular-nums）。 */
export function money(cents: number): string {
  const neg = cents < 0
  const s = (Math.abs(cents) / 100).toFixed(2)
  const [int, dec] = s.split('.')
  return `${neg ? '-' : ''}¥${int.replace(/\B(?=(\d{3})+(?!\d))/g, ',')}.${dec}`
}

/** 金额单元格的语义 class：支出 text-1 / 收入 accent / 转账·不计收支 text-2（规格 §3.2 与 §4.1）。 */
export function amountClass(type: string): string {
  switch (type) {
    case 'income':
      return 'mz-amt-income'
    case 'transfer':
    case 'adjustment':
      return 'mz-amt-transfer'
    default:
      return 'mz-amt-expense'
  }
}

/** 日期列：ISO 本地时间 → YYYY-MM-DD（取日期部分，不重新解析时区）。 */
export function dateOf(occurredAt: string): string {
  return occurredAt.slice(0, 10)
}

/** 出错文案人话化：Electron 的 invoke 失败会带 "Error invoking remote method 'x': Error: " 前缀。 */
export function humanError(e: unknown): string {
  const raw = e instanceof Error ? e.message : String(e)
  const m = /Error invoking remote method '[^']*':\s*(?:Error:\s*)?([\s\S]*)$/.exec(raw)
  return (m ? m[1] : raw).trim() || '未知错误'
}
