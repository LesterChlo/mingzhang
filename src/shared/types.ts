// 主进程 ↔ 渲染层共享类型。所有 IPC 通道与载荷集中在此定义。

declare global {
  // eslint-disable-next-line no-var
  var __mzIpcChannels: Set<string> | undefined
}

export interface ProviderPreset {
  id: string
  name: string
  baseUrl: string
  hint: string
}

export interface ProviderDTO {
  id: string
  name: string
  baseUrl: string
  model: string
  visionCapable: boolean
  selfCheckAt?: string | null
  apiKeySet: boolean
}

/** 外观主题：dark = 深色（全新安装默认），light = 浅色。纯视觉，不影响引擎与数据。 */
export type ThemeName = 'dark' | 'light'

export interface AppConfigDTO {
  version: number
  onboarded: boolean
  mock?: boolean
  theme: ThemeName
  dataDir: string
  dbFile: string
  providers: ProviderDTO[]
  activeProviderId: string | null
  /** 兼容便捷字段 = 当前激活的 provider。 */
  provider: ProviderDTO | null
}

export interface TestConnectionResult {
  ok: boolean
  detail: string
}

/**
 * 供应商探测（测试连接 / 视觉自检）从渲染层发起的入参。
 * apiKey 留空 + 给 providerId = "用这个预设已保存的 Key"（编辑模式的标准姿势，缺陷①）。
 * 密钥读取口（getSavedKey）只在主进程侧注入，不属于跨进程契约，故不在此声明。
 */
export interface ProviderProbeRequest {
  baseUrl: string
  model: string
  apiKey?: string
  providerId?: string
}

export interface ChatEvent {
  type:
    | 'user-message' // 用户消息回显
    | 'text-delta' // 助手流式文本
    | 'tool-start' // 工具开始
    | 'tool-end' // 工具结束（含卡片 details）
    | 'turn-end' // 一轮结束
    | 'agent-end' // 整轮 prompt 结束
    | 'record-confirmed' // 入账确认门执行完成（UI 按钮触发）
    | 'gate-executed' // 删除/批次确认门执行完成（UI 按钮触发）
    | 'gate-cancelled' // 确认门取消
    | 'tx-deleted' // 账本详情里直接删除了一笔（UI 触发）
    | 'tx-restored' // 账本详情里恢复了一笔（UI 触发）
    | 'progress' // 引擎存活信号（思考期等无正文阶段；渲染层据此重置自己的保险丝）
    | 'thinking-delta' // 思考正文增量（契约 A：模型 thinking 期间把 inner.delta 如实推给界面）
    | 'error' // 错误
  // biome-ignore lint/suspicious/noExplicitAny: 事件载荷按 type 区分，此处从简
  payload?: any
}

/** 第 6 单 段4-2：详情抽屉动作组——对某一笔直接动手的入参（全部 changed_by='user' + 审计）。 */
export type TxEditOp =
  | {
      op: 'set'
      fields: { categoryName?: string; amountCents?: number; merchant?: string; note?: string; accountName?: string }
    }
  | { op: 'delete' }
  | { op: 'restore' }
  | { op: 'transferAccounts'; toAccountName: string; fromAccountName?: string }

export interface TransactionCardData {
  kind: 'transaction'
  gateId?: number // needs_review 时 = pending_clarifications.id，UI 确认按钮用
  tx: {
    id: number
    amountCents: number
    type: string
    merchant: string | null
    categoryName: string | null
    accountName: string | null
    toAccountName: string | null
    occurredAt: string
    state: string
    confidenceScore: number | null
    note: string | null
  }
  reviewReason?: string | null
  ruleHit?: { ruleId: number; categoryName: string } | null
}

export interface DeleteGateCardData {
  kind: 'delete-gate'
  gateId: number
  tx: TransactionCardData['tx']
}

export interface RuleCardData {
  kind: 'rule'
  ruleId: number
  merchant: string
  op: string
  categoryName: string
  provenance: string
  hitCount: number
  undone?: boolean
  conflict?: boolean
}

export interface SplitCardData {
  kind: 'split'
  originalId: number
  cards: TransactionCardData[]
}

export interface ReportCardData {
  kind: 'report'
  month: string
  range: [string, string]
  totalExpenseCents: number
  totalIncomeCents: number
  countExpense: number
  countIncome: number
  topCategories: { category: string; totalCents: number; count: number }[]
  compare: { month: string; totalCents: number; deltaCents: number; hasData: boolean }
  budgetCents: number | null
  budgetRemainingCents: number | null
  empty: boolean
  text: string
}

export interface BatchGateCardData {
  kind: 'batch-gate'
  gateId: number
  channel: string | null
  newCount: number
  duplicateCount: number
  unparsedCount: number
  /** 第 8 单：确定性套表才有——材料共几行、其中几行判定为不计收支。 */
  rowsConsidered?: number | null
  skippedCount?: number
  items: {
    status: 'new' | 'duplicate' | 'unparsed'
    merchant: string | null
    amountCents: number | null
    reason: string | null
    rowNo?: number | null
  }[]
}

export interface BatchResultCardData {
  kind: 'batch-result'
  completed: { txId: number; amountCents: number; merchant: string | null; state: string }[]
  duplicates: { merchant: string | null; amountCents: number | null; reason: string }[]
  unparsedKept: number
}

// ---------------------------------------------------------------- D-01 批量归类（② 面板依赖这组冻结契约）

/** 归组建议里的一组（映射表一行）。 */
export interface ClassifyGroupDTO {
  groupKey: string
  merchant: string | null
  txType: 'expense' | 'income'
  txIds: number[]
  count: number
  totalCents: number
  suggestedCategory: string | null
  suggestionSource: 'rule' | 'builtin' | null
}

/** 只读建议：现在有哪些待分类、怎么分组、建议给什么分类。 */
export interface ClassifyProposalDTO {
  generatedAt: string
  batchId: string | null
  pendingCount: number
  groups: ClassifyGroupDTO[]
}

/** 面板映射表的行（②B 渲染用；也可从门 payload 重建）。 */
export interface ClassifyPlanGroupDTO {
  groupKey: string
  merchant: string | null
  txType: 'expense' | 'income'
  txIds: number[]
  count: number
  totalCents: number
  categoryName: string | null
}

/** 门卡：字段名就叫 'classify-plan'。 */
export interface ClassifyPlanCardData {
  kind: 'classify-plan'
  gateId: number
  classifyId: string
  batchId: string | null
  groups: ClassifyPlanGroupDTO[]
  assignedCount: number
  unassignedCount: number
}

/** 面板把用户改选后的最终映射发回来（rows 覆盖项）。 */
export interface ClassifyAssignmentInput {
  groupKey: string
  categoryName: string
}

export interface ClassifyResultDTO {
  gateId: number
  classifyId: string
  batchId: string | null
  appliedCount: number
  appliedGroups: { merchant: string | null; categoryName: string; count: number }[]
  skipped: { txId: number; reason: string }[]
}

export interface ClassifyUndoResultDTO {
  classifyId: string
  revertedCount: number
  skipped: { txId: number; reason: string }[]
}

export type CardData =
  | TransactionCardData
  | QueryResultCardData
  | DeleteGateCardData
  | RuleCardData
  | SplitCardData
  | ReportCardData
  | BatchGateCardData
  | BatchResultCardData
  | ClassifyPlanCardData

export interface QueryResultCardData {
  kind: 'query'
  metric: string
  period: string
  range: [string, string]
  txType: string
  categoryName: string | null
  totalCents: number
  count: number
  byCategory: { category: string; totalCents: number; count: number }[]
  previous?: { range: [string, string]; totalCents: number; count: number; deltaCents: number }
  budgetCents: number | null
  budgetRemainingCents?: number
}

export interface LedgerRow {
  id: number
  amountCents: number
  type: string
  state: string
  merchant: string | null
  categoryName: string | null
  accountName: string | null
  occurredAt: string
  /** 📎 列（规格 §3.2）：来源附件相对文件名（attachments/ 内），无附件 = null。 */
  attachmentRef?: string | null
}

export interface SettingsInfoDTO {
  dataDir: string
  dbFile: string
  portable: boolean
  budgetCents: number
  lastSnapshot: { name: string; mtime: number } | null
  attachmentCount: number
  /** 渲染层保险丝阈值（毫秒）：界面"连续这么久没收到任何引擎事件"才开口提示。
   *  由主进程从引擎侧阈值派生并下发（uiFallbackWaitMs()），避免 UI 写死自己的网。 */
  uiFallbackWaitMs: number
}

export interface PendingItemDTO {
  gateId: number
  field: string
  question: string
  txId: number | null
  createdAt: string
  /** 交易摘要（有 txId 的事项才有；无 txId 事项保持原样不填）。 */
  merchant?: string | null
  amountCents?: number | null
  occurredAt?: string | null
  /** B：来源附件（attachments/ 内的相对文件名）；实图来源事项才有。 */
  attachmentRef?: string | null
  /** 第 6 单 段3：来源分组键（批次派生项 = batchId；其余 'misc'）与人类可读组头。 */
  groupId: string
  groupLabel: string
}

export interface AuditEntryDTO {
  changeType: string
  changedBy: string
  reasoning: string | null
  confidenceScore: number | null
  changedAt: string
  beforeSummary: string | null
  afterSummary: string | null
  /** 原始 before/after（人话化 diff 渲染用；legacy AuditDiff 口径） */
  beforeRaw?: Record<string, unknown> | null
  afterRaw?: Record<string, unknown> | null
}

export interface TxDetailDTO {
  tx: TransactionCardData['tx']
  /** 段4-2：来源附件原图（attachments/ 相对名）+ 入库时间。 */
  attachmentRef?: string | null
  createdAt?: string
  audit: AuditEntryDTO[]
}

export interface PendingGateCardDTO {
  gateId: number
  field: string
  card: CardData
}

/**
 * 第 6 单 段1：执行类操作（确认入账 / 确认门执行 / 取消门）的语义化返回。
 * 渲染层对每种 status 都给可见文案——彻底消除"点了没反应"的静默路径（历史快照点已办结的门 / 已删账）。
 */
export type ExecStatus = 'ok' | 'already_closed' | 'in_flight' | 'not_found' | 'error'
export interface ExecResult {
  status: ExecStatus
  message: string
  /** status='ok' 且是单笔记账时回传当前卡片（供月份可见性/回显）。 */
  card?: TransactionCardData
}

export interface SessionArchiveDTO {
  path: string
  id: string
  firstMessage: string
  modified: string
  messageCount: number
  current: boolean
}

export interface LedgerFilter {
  month?: string // YYYY-MM
  state?: string
  type?: string
  /** 关键词搜索：商户 / 备注 / 分类名（第 3 单：对照 legacy q 参数） */
  q?: string
  /** 分类名精确匹配（categories.name）。空串/不传 = 不限。 */
  category?: string
  /** 账户名：本方账户（accounts.name）或转账对方账户（to_account_id 对应账户）任一命中即算——否则转账记录筛不出来。 */
  account?: string
  /** 金额下限（整数分，含）。按 |amount_cents| 比较：库内支出/收入/转账恒正，仅 adjustment 可负。 */
  amountMinCents?: number
  /** 金额上限（整数分，含）。同上取绝对值比较。 */
  amountMaxCents?: number
  limit?: number
  offset?: number
}

/** 账户下拉/账户屏条目（字段以 accounts 表实际列为准）。
 *  注意：**不含余额** —— accounts 表没有期初余额列（schema 冻结），真实余额无法计算，宁缺勿编。 */
export interface AccountOption {
  id: number
  name: string
  /** 账户类型：cash / bank / alipay / wechat（DDL 列名是 type，DTO 侧改名 kind，与分类侧对齐）。 */
  kind: string
  /** 币种：MVP 恒为 CNY（DDL CHECK 锁死），仍原样返回。 */
  currency: string
  createdAt: string
}

export interface LedgerPageDTO {
  items: LedgerRow[]
  total: number
  /** 第 6 单 段2-4：与分页无关的"筛选口径"聚合（按 月份+类型+关键词，排除已删除）。汇总卡只读这个。 */
  agg: LedgerAgg
}

export interface LedgerAgg {
  /** 生效的月份口径（null = 全部月份）。 */
  month: string | null
  /** 口径内非删除笔数。 */
  count: number
  expenseCents: number
  incomeCents: number
  /** 待确认（needs_review）单列，不计入收支合计。 */
  reviewCount: number
  reviewExpenseCents: number
  /** 已确认支出的分类构成（按金额降序）。 */
  byCategory: { category: string; cents: number; count: number }[]
}

/**
 * 批次结果条数据（D-03a「按批次读回」+ K3 设计 G 组事实条）。
 * 数字口径见 src/main/domain/batch-summary.ts：已入账/待分类查库，重复/不计收支/待核对取 plan。
 */
export interface BatchResultSummaryDTO {
  /** 来源门 id（pending_clarifications.id）。 */
  gateId: number
  /** 批次号（transactions.source_message_id = 该值，可直接反查本批交易）。 */
  batchId: string
  importId: number
  /** 门 resolved 时的 updated_at（批次实际执行时刻）。 */
  executedAt: string
  counts: {
    /** 本批已入账笔数（不含删除；**含**待分类那几笔）。 */
    booked: number
    /** 其中已入账但分类还空着的笔数（⊂ booked）。 */
    needsCategory: number
    /** 方案里按「不计收支」处理的行数。 */
    excluded: number
    /** 与既有交易重复、自动跳过的笔数。 */
    duplicates: number
    /** 方案里标为待核对（信息不足）的笔数。 */
    unparsed: number
  }
  /** 重复行逐行明细（能带出来）。 */
  duplicatesRows: { merchant: string | null; amountCents: number | null; reason: string }[]
  /** 不计收支的逐行明细：本单未实现（D-03b）→ 恒 null。UI 必须显式说明「逐行明细待后端」，不许拿空数组冒充。 */
  excludedRows: null
}

export interface ChatMessageDTO {
  id: string
  role: 'user' | 'assistant' | 'tool'
  text: string
  streaming?: boolean
  card?: CardData
  toolName?: string
  isError?: boolean
  /** 用户消息自带图片（发送时与历史恢复时都保留，气泡内渲染缩略图）。 */
  images?: { previewUrl: string; fileName: string }[]
}

// preload 暴露给渲染层的 API 面
export interface MingZhangApi {
  getState: () => Promise<AppConfigDTO>
  listPresets: () => Promise<ProviderPreset[]>
  /**
   * 供应商探测（测试连接 / 视觉自检）的渲染层入参。
   * 编辑模式下 apiKey 留空即可——主进程会按 providerId 回落取该预设已保存的 Key
   * （缺陷①：老实现拿空 Key 打端点必然 401）。密钥读取口只在主进程注入，不进这一层。
   */
  testConnection: (input: ProviderProbeRequest) => Promise<TestConnectionResult>
  visionCheck: (input: ProviderProbeRequest) => Promise<TestConnectionResult>
  /** 保存 provider（upsert；apiKey 空 = 保留已存密钥）；activate=true 同时切换。 */
  saveProvider: (input: {
    provider: { id: string; name: string; baseUrl: string; model: string; visionCapable: boolean; selfCheckAt?: string | null }
    apiKey?: string
    activate?: boolean
  }) => Promise<void>
  setActiveProvider: (id: string) => Promise<void>
  /** 切换外观主题：只写配置，不重启引擎。 */
  setTheme: (theme: ThemeName) => Promise<void>
  /** 行内视觉自检：读取该 provider 已存密钥发测试图；通过则更新 visionCapable+自检时间。 */
  runVisionCheck: (providerId: string) => Promise<{ ok: boolean; detail: string }>
  deleteProvider: (id: string) => Promise<void>
  sendChat: (text: string, images: { fileName?: string; dataBase64: string; mediaType: string }[]) => Promise<void>
  /** 第 8 单：账单材料逐行入库（首行表头），返回材料 id / 行数 / 列名，供对话里引用。 */
  stageBill: (input: {
    sourceType: 'csv' | 'xlsx'
    cells: string[][]
    fileName?: string | null
  }) => Promise<{ id: number; rows: number; openRows: number; header: string[] }>
  onChatEvent: (listener: (evt: ChatEvent) => void) => () => void
  /** 确认入账（UI 按钮专用）。支出/收入缺分类时必须给 categoryName（UI 下拉选择）。返回语义化结果。 */
  confirmRecord: (txId: number, categoryName?: string) => Promise<ExecResult>
  /** 确认门执行（删除/批次），仅 UI 确认按钮调用。返回语义化结果。 */
  confirmGate: (gateId: number) => Promise<ExecResult>
  cancelGate: (gateId: number) => Promise<ExecResult>
  /** 段4-2：详情抽屉动作组——改字段 / 删除 / 恢复 / 补转账账户（均 changed_by='user' + 审计）。 */
  editTx: (txId: number, op: TxEditOp) => Promise<ExecResult>
  listCategories: () => Promise<{ id: number; name: string; kind: string }[]>
  listPending: () => Promise<PendingItemDTO[]>
  /** 账户列表（账户屏 + 账本屏账户筛选下拉）。不含余额——accounts 表无期初余额列。 */
  listAccounts: () => Promise<AccountOption[]>
  /** 月报：传 'YYYY-MM' 取该月；不传取上一个自然月（收件箱右栏「上月对照」靠这条）。 */
  latestReport: (month?: string) => Promise<ReportCardData | null>
  /** 置信度直通阈值（settings.confidence_threshold，默认 0.7）。改高它才能逼出「待入账·AI 反问」卡。 */
  getConfidenceThreshold: () => Promise<number>
  /** 写置信度阈值；必须是 0~1 的数字，否则抛错且不落盘。 */
  setConfidenceThreshold: (value: number) => Promise<number>
  getSettingsInfo: () => Promise<SettingsInfoDTO>
  setBudget: (cents: number) => Promise<void>
  cleanupAttachments: (keepDays: number) => Promise<number>
  createSnapshotNow: () => Promise<string>
  listSnapshots: () => Promise<{ name: string; size: number; mtime: number }[]>
  restoreSnapshot: (name: string) => Promise<boolean>
  /** 成功恢复后的真实回滚：把 .restore-rollback 旧库换回目标并验证（可测试往返）。 */
  rollbackRestore: () => Promise<boolean>
  /** 新开对话：有内容则归档并新开会话（返回 true）；当前已是空会话则不强制归档（返回 false）。 */
  newConversation: () => Promise<boolean>
  exportBackup: (passphrase: string) => Promise<string | null>
  importBackup: (passphrase: string) => Promise<boolean>
  setMock: (enabled: boolean) => Promise<void>
  listLedger: (filter: LedgerFilter) => Promise<LedgerPageDTO>
  /** D-03a：按批次读回执行结果。传 gateId 取指定批次；不传取最近一次已执行的批次。都没执行过 → null。 */
  getBatchResult: (gateId?: number) => Promise<BatchResultSummaryDTO | null>
  /** D-01：只读归类建议（纯查库，不写任何一行）。 */
  getClassifyProposal: (batchId?: string) => Promise<ClassifyProposalDTO>
  /** D-01：执行归类方案（rows = ②B 面板改选后的最终映射；缺省用方案里的）。 */
  applyClassify: (gateId: number, rows?: ClassifyAssignmentInput[]) => Promise<ClassifyResultDTO | null>
  /** D-01：整体撤销一次批量归类（按 classifyId 定位，只回退没被后续改过的笔）。 */
  undoClassify: (classifyId: string) => Promise<ClassifyUndoResultDTO>
  txDetail: (txId: number) => Promise<TxDetailDTO | null>
  /** A2：open 的 delete/batch gate 就地重建卡片（待收尾直接执行，不依赖对话卡片）。 */
  pendingGateCards: () => Promise<PendingGateCardDTO[]>
  /** A：待收尾就地回答（与对话补答同一条域层续办路径）。 */
  answerPending: (gateId: number, answer: string) => Promise<{ text: string }>
  /** B：读附件原图（返回 dataURL）；路径仅限 app 附件目录内。 */
  readAttachment: (relPath: string) => Promise<string | null>
  /** A4 归档会话：列表（不含当前）+ 只读查看。 */
  listSessions: () => Promise<SessionArchiveDTO[]>
  readArchive: (path: string) => Promise<ChatMessageDTO[]>
  /** 继续一条已归档会话（第 5 单 C4②）：引擎切到该会话文件，对话在其上下文里续写。 */
  continueSession: (path: string) => Promise<boolean>
  /** 加载当前会话历史（重启后可见之前的对话，含工具卡片与图片）。 */
  loadHistory: () => Promise<ChatMessageDTO[]>
}
