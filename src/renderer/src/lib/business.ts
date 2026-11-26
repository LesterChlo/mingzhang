// 商品经营 API 客户端：封装 window.mz 的业务 IPC 调用，提供类型安全的渲染层接口。

import type {
  ProductDTO,
  ProductWithVariantsDTO,
  ProductProfileDTO,
  VariantDTO,
  VariantProfileDTO,
  CreateVariantDTO,
  UpdateVariantDTO,
  SaleInputDTO,
  SaleResultDTO,
  PurchaseInputDTO,
  PurchaseResultDTO,
  RefundInputDTO,
  RefundResultDTO,
  CSIncomeInputDTO,
  OtherInputDTO,
  ExpenseInputDTO,
  BusinessOverviewDTO,
  OverviewRangeDTO,
  ProfitCalcInputDTO,
  ProfitCalcResultDTO,
  MonthlyReportDTO,
  TrendPointDTO,
  SnapshotDTO,
  QuickTemplateDTO,
  TemplateKindDTO,
  CreateTemplateDTO,
  UpdateTemplateDTO,
} from '../../../shared/types'

/** 获取全部商品列表（不含规格明细）。 */
export function listProducts(): Promise<ProductDTO[]> {
  return window.mz.listProducts()
}

/** 获取全部商品 + 各自规格明细（经营首页用）。 */
export function listProductsWithVariants(): Promise<ProductWithVariantsDTO[]> {
  return window.mz.listProductsWithVariants()
}

/** 获取单个商品。 */
export function getProduct(id: number): Promise<ProductDTO | null> {
  return window.mz.getProduct(id)
}

/** 获取商品档案（含计算字段 + 各规格档案）。 */
export function getProductProfile(id: number): Promise<ProductProfileDTO | null> {
  return window.mz.getProductProfile(id)
}

/** 修改商品标准售价（= 首个规格售价，不影响历史订单）。 */
export function updateProductPrice(id: number, cents: number): Promise<boolean> {
  return window.mz.updateProductPrice(id, cents)
}

// === 规格 ===

/** 某商品的规格列表。 */
export function listVariants(productId: number): Promise<VariantDTO[]> {
  return window.mz.listVariants(productId)
}

/** 获取单个规格。 */
export function getVariant(id: number): Promise<VariantDTO | null> {
  return window.mz.getVariant(id)
}

/** 规格档案（单规格计算字段）。 */
export function getVariantProfile(id: number): Promise<VariantProfileDTO | null> {
  return window.mz.getVariantProfile(id)
}

/** 新增规格。 */
export function createVariant(input: CreateVariantDTO): Promise<number> {
  return window.mz.createVariant(input)
}

/** 修改规格（名称/售价/排序）。 */
export function updateVariant(input: UpdateVariantDTO): Promise<boolean> {
  return window.mz.updateVariant(input)
}

/** 删除规格（有历史记录则拒绝）。 */
export function deleteVariant(id: number): Promise<boolean> {
  return window.mz.deleteVariant(id)
}

/** 修改规格售价（不影响历史订单）。 */
export function updateVariantPrice(id: number, cents: number): Promise<boolean> {
  return window.mz.updateVariantPrice(id, cents)
}

/** 销售记账（成本快照 + 全表联动）。 */
export function recordSale(input: SaleInputDTO): Promise<SaleResultDTO> {
  return window.mz.recordSale(input)
}

/** 进货记账（加权平均成本 + 全表联动）。 */
export function recordPurchase(input: PurchaseInputDTO): Promise<PurchaseResultDTO> {
  return window.mz.recordPurchase(input)
}

/** 退款记账（关联原订单或手动，禁止超退）。 */
export function recordRefund(input: RefundInputDTO): Promise<RefundResultDTO> {
  return window.mz.recordRefund(input)
}

/** 客服收入记账。 */
export function recordCSIncome(input: CSIncomeInputDTO): Promise<number> {
  return window.mz.recordCSIncome(input)
}

/** 其他收支记账。 */
export function recordOther(input: OtherInputDTO): Promise<number> {
  return window.mz.recordOther(input)
}

/** 经营支出记账。 */
export function recordExpense(input: ExpenseInputDTO): Promise<number> {
  return window.mz.recordExpense(input)
}

/** 获取固定渠道枚举。 */
export function listChannels(): Promise<{
  income: readonly string[]
  expense: readonly string[]
  refund: readonly string[]
  expenseCategories: readonly string[]
}> {
  return window.mz.listChannels()
}

// === 第五阶段：经营概览 + 盈亏测算 ===

/** 全局经营概览（区间可空 = 全部）。 */
export function getBusinessOverview(range?: OverviewRangeDTO): Promise<BusinessOverviewDTO> {
  return window.mz.getBusinessOverview(range)
}

/** 实时盈亏测算。 */
export function calculateProfit(input: ProfitCalcInputDTO): Promise<ProfitCalcResultDTO> {
  return window.mz.calculateProfit(input)
}

/** 今天 0 点（本地）的 ISO 字符串。 */
export function todayStartISO(): string {
  const d = new Date()
  d.setHours(0, 0, 0, 0)
  return d.toISOString()
}

/** 本月 1 号 0 点（本地）的 ISO 字符串。 */
export function monthStartISO(): string {
  const d = new Date()
  d.setDate(1)
  d.setHours(0, 0, 0, 0)
  return d.toISOString()
}

// === 第六阶段：月度报表 + 趋势 ===

/** 月度经营报表（含日趋势/商品排行/渠道与支出占比）。 */
export function getMonthlyReport(month: string): Promise<MonthlyReportDTO> {
  return window.mz.getMonthlyReport(month)
}

/** 有经营数据的月份列表（降序）。 */
export function listBusinessMonths(limit?: number): Promise<string[]> {
  return window.mz.listBusinessMonths(limit)
}

/** 近 N 月趋势（月份从旧到新，含空月补 0）。 */
export function getTrend(months?: number, endMonth?: string): Promise<TrendPointDTO[]> {
  return window.mz.getTrend(months, endMonth)
}

/** 当前本地月份 'YYYY-MM'。 */
export function currentMonth(): string {
  const d = new Date()
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`
}

/** 'YYYY-MM' → 「2026 年 11 月」。 */
export function monthLabel(month: string): string {
  const m = /^(\d{4})-(\d{1,2})$/.exec(month.trim())
  return m ? `${m[1]} 年 ${Number(m[2])} 月` : month
}

/** 'YYYY-MM-DD' → 「11/26」。 */
export function dayLabel(date: string): string {
  const m = /^\d{4}-(\d{2})-(\d{2})$/.exec(date)
  return m ? `${Number(m[1])}/${Number(m[2])}` : date
}

/** 紧凑金额：¥1.2万 / ¥3500 / ¥12.35（图表标签用，省空间）。 */
export function moneyCompact(cents: number): string {
  const yuan = cents / 100
  const neg = yuan < 0
  const abs = Math.abs(yuan)
  let out: string
  if (abs >= 10000) out = `${(abs / 10000).toFixed(1)}万`
  else if (abs >= 1000) out = abs.toFixed(0)
  else out = abs.toFixed(2)
  return `${neg ? '-' : ''}¥${out}`
}

// === 第七阶段：Excel 导出 + 备份管理 ===

/** 导出经营报表 Excel（month 为空 = 全部）。返回保存路径或 null（取消）。 */
export function exportBusinessExcel(month?: string | null): Promise<string | null> {
  return window.mz.exportBusinessExcel(month ?? null)
}

/** 立即创建一份数据库快照，返回快照路径。 */
export function createBusinessSnapshot(): Promise<string | null> {
  return window.mz.createBusinessSnapshot()
}

/** 快照列表（时间倒序）。 */
export function listBusinessSnapshots(): Promise<SnapshotDTO[]> {
  return window.mz.listBusinessSnapshots()
}

/** 备份目录路径。 */
export function getBackupsDir(): Promise<string | null> {
  return window.mz.getBackupsDir()
}

/** 字节数 → 人话（KB/MB）。 */
export function bytesText(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / 1024 / 1024).toFixed(2)} MB`
}

/** 时间戳 → 「2026-11-26 15:30」。 */
export function timeText(mtime: number): string {
  const d = new Date(mtime)
  const pad = (n: number): string => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`
}

/** 相对时间：刚刚 / N 分钟前 / N 小时前 / N 天前。 */
export function relativeTime(mtime: number): string {
  const diff = Date.now() - mtime
  const min = Math.floor(diff / 60000)
  if (min < 1) return '刚刚'
  if (min < 60) return `${min} 分钟前`
  const hour = Math.floor(min / 60)
  if (hour < 24) return `${hour} 小时前`
  return `${Math.floor(hour / 24)} 天前`
}

// === 第八阶段：快捷记账模板 ===

/** 全部模板（可按类型过滤，常用优先）。 */
export function listTemplates(kind?: TemplateKindDTO): Promise<QuickTemplateDTO[]> {
  return window.mz.listTemplates(kind)
}

/** 单个模板。 */
export function getTemplate(id: number): Promise<QuickTemplateDTO | null> {
  return window.mz.getTemplate(id)
}

/** 新建模板。 */
export function createTemplate(input: CreateTemplateDTO): Promise<number> {
  return window.mz.createTemplate(input)
}

/** 修改模板。 */
export function updateTemplate(input: UpdateTemplateDTO): Promise<boolean> {
  return window.mz.updateTemplate(input)
}

/** 删除模板。 */
export function deleteTemplate(id: number): Promise<boolean> {
  return window.mz.deleteTemplate(id)
}

/** 套用模板时累加使用次数。 */
export function touchTemplate(id: number): Promise<boolean> {
  return window.mz.touchTemplate(id)
}

/** 各类型模板数量。 */
export function templateCounts(): Promise<Record<TemplateKindDTO, number>> {
  return window.mz.templateCounts()
}

/** 模板类型 → 中文标签。 */
export const TEMPLATE_KIND_LABEL: Record<TemplateKindDTO, string> = {
  sale: '销售',
  purchase: '进货',
  expense: '经营支出',
  refund: '退款',
  cs_income: '客服收入',
  other: '其他收支',
}

// === 格式化辅助 ===

/** 整数分 → ¥1,234.50（与 ledgerFilter.money 同口径，此处独立避免循环依赖）。 */
export function money(cents: number): string {
  const neg = cents < 0
  const s = (Math.abs(cents) / 100).toFixed(2)
  const [int, dec] = s.split('.')
  return `${neg ? '-' : ''}¥${int.replace(/\B(?=(\d{3})+(?!\d))/g, ',')}.${dec}`
}

/** 元 → 分（输入框用元，存储用分）。 */
export function yuanToCents(yuan: string): number {
  const n = parseFloat(yuan)
  if (isNaN(n)) return 0
  return Math.round(n * 100)
}

/** 分 → 元（展示用）。 */
export function centsToYuan(cents: number): string {
  return (cents / 100).toFixed(2)
}

/** 当前本地时间 ISO（datetime-local 输入框值 → ISO）。 */
export function localNowISO(): string {
  return new Date().toISOString()
}

/** datetime-local 值 → ISO 字符串。 */
export function datetimeLocalToISO(value: string): string {
  if (!value) return localNowISO()
  // datetime-local 格式 'YYYY-MM-DDTHH:mm'，new Date 会按本地时区解析
  const d = new Date(value)
  return isNaN(d.getTime()) ? localNowISO() : d.toISOString()
}

/** ISO → datetime-local 输入框值。 */
export function isoToDatetimeLocal(iso: string): string {
  const d = new Date(iso)
  if (isNaN(d.getTime())) return ''
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`
}

/** 百分比格式化（0.2 → "20.0%"）。 */
export function percent(rate: number): string {
  return `${(rate * 100).toFixed(1)}%`
}

/** 出错文案人话化。 */
export function humanError(e: unknown): string {
  const raw = e instanceof Error ? e.message : String(e)
  return raw.replace(/^Error invoking remote method '[^']+': Error: /, '')
}
