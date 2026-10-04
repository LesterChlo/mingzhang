// IPC 面：渲染层唯一入口。类型化 handler，全部走主进程模块。

import { ipcMain, nativeTheme, type WebContents } from 'electron'
import type { Database } from 'better-sqlite3-multiple-ciphers'
import type { AppConfigDTO, LedgerFilter, ThemeName, TxEditOp } from '../shared/types'
import { normalizeTheme, type ConfigStore, type AppConfig } from './config/store'
import type { SecretsStore } from './secrets/store'
import type { Engine } from './engine/engine'
import type { EngineRegistry } from './engine/registry'
import { PROVIDER_PRESETS, testConnection, visionCheck, type ProviderProbeInput } from './wizard/providers'
import { parseSessionHistory } from './history'
import { buildOpenGateCards } from './domain/gates'
import { stageBill } from './domain/bill'
import { firstAttachmentRef } from './domain/pending'
import { previousMonth } from './domain/queries'
import {
  emptyLedgerAgg,
  listAccountOptions,
  queryLedgerPage,
  readConfidenceThreshold,
  reportForMonth,
  writeConfidenceThreshold,
} from './domain/ledger-page'
import { getBatchSummary, getLatestBatchSummary } from './domain/batch-summary'
import { listMonthSummaries } from './domain/reports'
import { applyClassify, buildClassifyProposal, getClassifyResults, prepareClassify, undoClassify, validateBatchId } from './domain/classify'
import { listCategoryRules, saveCategoryRule, updateCategoryRule, deactivateCategoryRule } from './domain/category-rules'
import type { SaveCategoryRuleInput, UpdateCategoryRuleInput, DeactivateCategoryRuleInput } from '../shared/types'
import type {
  BatchResultSummaryDTO,
  ClassifyAssignmentInput,
  LedgerPageDTO,
  MonthSummaryDTO,
  PendingItemDTO,
} from '../shared/types'

/** 原始审计 JSON → 对象（人话化 diff 用）。 */
function parseRaw(json: string | null): Record<string, unknown> | null {
  if (!json) return null
  try {
    return JSON.parse(json) as Record<string, unknown>
  } catch {
    return null
  }
}

/** 审计 before/after JSON 摘要：挑人能看懂的关键字段。 */
function summarize(json: string | null): string | null {
  if (!json) return null
  try {
    const v = JSON.parse(json) as Record<string, unknown>
    const parts: string[] = []
    if (v.amount_cents !== undefined && v.amount_cents !== null) parts.push(`¥${(Number(v.amount_cents) / 100).toFixed(2)}`)
    if (v.state !== undefined && v.state !== null) parts.push(String(v.state))
    if (v.category_id !== undefined && v.category_id !== null) parts.push(`分类#${v.category_id}`)
    if (v.merchant) parts.push(String(v.merchant))
    if (v.hit_count !== undefined && v.hit_count !== null) parts.push(`命中${String(v.hit_count)}次`)
    if (v.value !== undefined) parts.push(String(v.value))
    return parts.length > 0 ? parts.join(' · ') : '{…}'
  } catch {
    return null
  }
}

export interface IpcContext {
  config: ConfigStore
  secrets: SecretsStore
  /** 普通 IPC 动态解析当前 Engine（恢复重开后自动命中新 Engine，禁止按值捕获旧 Engine）。 */
  engines: EngineRegistry<Engine>
  get engine(): Engine
  getWindowContents: () => WebContents | null
  restartEngine: () => Promise<void>
  getAttachmentsDir: () => string | null
  /** 只读账本连接（无引擎时也可查询）。 */
  getDb: () => Database | null
}

function dto(config: ConfigStore, secrets: SecretsStore, dataDir: string, dbFile: string): AppConfigDTO {
  const cfg: AppConfig = config.load()
  const active = cfg.providers.find((p) => p.id === cfg.activeProviderId) ?? null
  return {
    version: cfg.version,
    onboarded: cfg.onboarded,
    mock: cfg.mock === true,
    theme: normalizeTheme(cfg.theme),
    dataDir,
    dbFile,
    providers: cfg.providers.map((p) => ({
      ...p,
      apiKeySet: secrets.has(`provider-key:${p.id}`),
    })),
    activeProviderId: cfg.activeProviderId,
    provider: active ? { ...active, apiKeySet: secrets.has(`provider-key:${active.id}`) } : null,
  }
}

export function registerIpc(ctx: IpcContext, meta: { dataDir: string; dbFile: string }): void {
  ipcMain.handle('mz:getState', () => dto(ctx.config, ctx.secrets, meta.dataDir, meta.dbFile))

  ipcMain.handle('mz:listPresets', () => PROVIDER_PRESETS)

  // 编辑模式回落：apiKey 空 + 给了 providerId 时取该预设已存密钥（缺陷①，治裸 401）。
  // getSavedKey 只在主进程注入，渲染层拿不到密钥读取口。
  const getSavedKey = (providerId: string): string | null => ctx.secrets.get(`provider-key:${providerId}`)

  ipcMain.handle('mz:testConnection', (_e, input: ProviderProbeInput) => testConnection({ ...input, getSavedKey }))

  ipcMain.handle('mz:visionCheck', (_e, input: ProviderProbeInput) => visionCheck({ ...input, getSavedKey }))

  ipcMain.handle(
    'mz:saveProvider',
    async (
      _e,
      input: {
        provider: { id: string; name: string; baseUrl: string; model: string; visionCapable: boolean; selfCheckAt?: string | null }
        apiKey?: string
        activate?: boolean
      },
    ) => {
      ctx.secrets.requireAvailable()
      const cfg: AppConfig = ctx.config.load()
      const id = input.provider.id
      const existing = cfg.providers.find((p) => p.id === id)
      if (input.apiKey) {
        ctx.secrets.set(`provider-key:${id}`, input.apiKey)
      } else if (!existing && !ctx.secrets.has(`provider-key:${id}`)) {
        throw new Error('请填写 API Key')
      }
      const entry = {
        id,
        name: input.provider.name,
        baseUrl: input.provider.baseUrl,
        model: input.provider.model,
        visionCapable: input.provider.visionCapable,
        selfCheckAt: input.provider.selfCheckAt ?? existing?.selfCheckAt ?? null,
      }
      if (existing) {
        cfg.providers = cfg.providers.map((p) => (p.id === id ? entry : p))
      } else {
        cfg.providers.push(entry)
      }
      if (input.activate !== false || !cfg.activeProviderId) cfg.activeProviderId = id
      cfg.onboarded = true
      ctx.config.save(cfg)
      await ctx.restartEngine()
    },
  )

  ipcMain.handle('mz:setActiveProvider', async (_e, id: string) => {
    const cfg: AppConfig = ctx.config.load()
    if (!cfg.providers.some((p) => p.id === id)) throw new Error('预设不存在')
    cfg.activeProviderId = id
    ctx.config.save(cfg)
    await ctx.restartEngine() // continueRecent：同一会话续聊不丢
  })

  // 外观主题：纯视觉层，只写配置，不重启引擎、不动会话。参数按现行枚举归一（历史 'mint' → light）。
  // 同步原生标题栏（见 index.ts 启动处的同款设置）：设置页切浅色时，标题栏不能还是黑条。
  ipcMain.handle('mz:setTheme', (_e, theme: ThemeName) => {
    const cfg: AppConfig = ctx.config.load()
    cfg.theme = normalizeTheme(theme)
    ctx.config.save(cfg)
    nativeTheme.themeSource = cfg.theme
  })

  ipcMain.handle('mz:deleteProvider', async (_e, id: string) => {
    const cfg: AppConfig = ctx.config.load()
    cfg.providers = cfg.providers.filter((p) => p.id !== id)
    if (cfg.activeProviderId === id) cfg.activeProviderId = cfg.providers[0]?.id ?? null
    ctx.config.save(cfg)
    ctx.secrets.delete(`provider-key:${id}`) // 密钥随预设删除（换机/重填口径一致）
    await ctx.restartEngine()
  })

  // （原 mz:testConnectionFor 已删：全仓无调用方——preload 未暴露、渲染层未用。
  //  它与 mz:testConnection 完全同签名，留着只会让人以为"编辑模式要走这条"；
  //  编辑模式的空 Key 回落已由上面 mz:testConnection 一并处理。）

  ipcMain.handle('mz:confirmRecord', (_e, txId: number, categoryName?: string) =>
    ctx.engines.get().confirmRecord(txId, categoryName),
  )

  // 第 8 单：账单材料逐行入库（渲染层只负责把表格拆成二维数组，之后由 Agent 读、程序套表解析）
  ipcMain.handle(
    'mz:stageBill',
    (_e, input: { sourceType: 'csv' | 'xlsx'; cells: string[][]; fileName?: string | null }) => {
      const db = ctx.getDb()
      if (!db) throw new Error('账本未就绪')
      const t = stageBill(db, input)
      return { id: t.id, rows: t.rowCount, openRows: t.openRows, header: t.header }
    },
  )

  ipcMain.handle(
    'mz:sendChat',
    async (
      _e,
      text: string,
      images: { fileName: string; dataBase64: string; mediaType: string }[],
    ) => {
      await ctx.engines.get().sendChat(text, images)
    },
  )

  ipcMain.handle('mz:confirmGate', (_e, gateId: number) => ctx.engines.get().confirmGate(gateId))
  ipcMain.handle('mz:cancelGate', (_e, gateId: number) => ctx.engines.get().cancelGate(gateId))
  ipcMain.handle('mz:editTx', (_e, txId: number, op: TxEditOp) => ctx.engines.get().editTx(txId, op))

  ipcMain.handle('mz:listCategories', () => {
    const db = ctx.getDb()
    if (!db) return []
    return db.prepare('SELECT id, name, kind FROM categories ORDER BY kind, id').all()
  })

  ipcMain.handle('mz:pendingGateCards', () => buildOpenGateCards(ctx.getDb() as never))

  ipcMain.handle('mz:answerPending', async (_e, gateId: number, answer: string) => {
    const db = ctx.getDb()
    if (!db) throw new Error('账本未就绪')
    const { answerPending } = await import('./domain/pending-answer')
    return answerPending(db, gateId, answer, { sessionId: ctx.engines.get().sessionId, via: 'panel' })
  })

  ipcMain.handle('mz:txDetail', (_e, txId: number) => {
    const db = ctx.getDb()
    if (!db) return null
    const tx = db.prepare(
      'SELECT t.*, a.name AS account_name, c.name AS category_name, ta.name AS to_account_name' +
        ' FROM transactions t JOIN accounts a ON a.id=t.account_id' +
        ' LEFT JOIN categories c ON c.id=t.category_id' +
        ' LEFT JOIN accounts ta ON ta.id=t.to_account_id WHERE t.id=?',
    ).get(txId) as Record<string, unknown> | undefined
    if (!tx) return null
    const smid = (tx.source_message_id as string | null) ?? null
    const imp = smid
      ? (db.prepare('SELECT source_ref FROM imports WHERE source_message_id = ? AND source_ref IS NOT NULL ORDER BY id DESC LIMIT 1').get(smid) as
          | { source_ref: string | null }
          | undefined)
      : undefined
    const audits = db
      .prepare("SELECT change_type, changed_by, reasoning, confidence_score, changed_at, before_value, after_value" +
        " FROM audit_log WHERE entity_type='transaction' AND entity_id=? ORDER BY id")
      .all(txId) as unknown as { change_type: string; changed_by: string; reasoning: string | null; confidence_score: number | null; changed_at: string; before_value: string | null; after_value: string | null }[]
    return {
      tx: {
        id: Number(tx.id),
        amountCents: Number(tx.amount_cents),
        type: String(tx.type),
        merchant: (tx.merchant as string | null) ?? null,
        categoryName: (tx.category_name as string | null) ?? null,
        accountName: (tx.account_name as string | null) ?? null,
        toAccountName: (tx.to_account_name as string | null) ?? null,
        occurredAt: String(tx.occurred_at),
        state: String(tx.state),
        confidenceScore: (tx.confidence_score as number | null) ?? null,
        note: (tx.note as string | null) ?? null,
      },
      /** 段4-2：来源附件原图（attachments/ 相对名，可点开）+ 入库时间。 */
      attachmentRef: imp?.source_ref ?? null,
      createdAt: String(tx.created_at ?? ''),
      audit: audits.map((a) => ({
        changeType: a.change_type,
        changedBy: a.changed_by,
        reasoning: a.reasoning,
        confidenceScore: a.confidence_score,
        changedAt: a.changed_at,
        beforeSummary: summarize(a.before_value),
        afterSummary: summarize(a.after_value),
        beforeRaw: parseRaw(a.before_value),
        afterRaw: parseRaw(a.after_value),
      })),
    }
  })

  ipcMain.handle('mz:listPending', (): PendingItemDTO[] => {
    const db = ctx.getDb()
    if (!db) return []
    const rows = db
      .prepare("SELECT id, field, question, tx_id, created_at, payload FROM pending_clarifications WHERE status='open' ORDER BY id DESC")
      .all() as unknown as { id: number; field: string; question: string; tx_id: number | null; created_at: string; payload: string | null }[]
    // 交易摘要：一次按 tx_id 批量查 transactions（无 txId 事项保持原样不填）
    const txIds = [...new Set(rows.map((r) => r.tx_id).filter((v): v is number => v !== null))]
    const txMap = new Map<number, { merchant: string | null; amountCents: number; occurredAt: string }>()
    if (txIds.length > 0) {
      const placeholders = txIds.map(() => '?').join(',')
      const txRows = db
        .prepare(`SELECT id, merchant, amount_cents, occurred_at FROM transactions WHERE id IN (${placeholders})`)
        .all(...txIds) as unknown as { id: number; merchant: string | null; amount_cents: number; occurred_at: string }[]
      for (const t of txRows) {
        txMap.set(t.id, { merchant: t.merchant ?? null, amountCents: Number(t.amount_cents), occurredAt: String(t.occurred_at) })
      }
    }
    return rows.map((r) => {
      let batchId: string | null = null
      let channel: string | null = null
      try {
        const p = JSON.parse(r.payload ?? '{}') as { batchId?: string; channel?: string; plan?: { batchId?: string; channel?: string } }
        batchId = p.batchId ?? p.plan?.batchId ?? null
        channel = p.channel ?? p.plan?.channel ?? null
      } catch {
        // payload 非 JSON：归到杂项
      }
      const groupLabel = batchId ? `${channel || '未命名'} 账单` : '其他事项'
      const tx = r.tx_id !== null ? txMap.get(r.tx_id) : undefined
      return {
        gateId: r.id,
        field: r.field,
        question: r.question,
        txId: r.tx_id,
        createdAt: r.created_at,
        // 无 txId 事项保持原样：字段留 undefined，渲染层不显示摘要行
        merchant: tx?.merchant ?? undefined,
        amountCents: tx?.amountCents ?? undefined,
        occurredAt: tx?.occurredAt ?? undefined,
        attachmentRef: firstAttachmentRef(r.payload),
        groupId: batchId ?? 'misc',
        groupLabel,
      }
    })
  })

  ipcMain.handle('mz:latestReport', (_e, month?: string) => {
    const db = ctx.getDb()
    if (!db) return null
    // 不传月份 = 上一个自然月（既有行为，收件箱右栏「上月对照」依赖）；传 'YYYY-MM' = 该月月报。
    const report = reportForMonth(db, month, previousMonth(new Date()))
    return report
  })

  // 报告屏「过去几个月」网格：一条聚合 SQL 出近 N 个月（含空月），免得进屏打 12 发 latestReport。
  // 账本未就绪 → 抛错（渲染层据此显示「报告生成失败 + 重新生成」，不拿空数组冒充"没有数据"）。
  ipcMain.handle('mz:reportMonths', (_e, count?: number): MonthSummaryDTO[] => {
    const db = ctx.getDb()
    if (!db) throw new Error('账本未就绪')
    return listMonthSummaries(db, count ?? 12)
  })

  // 账户列表（账户屏 + 账本屏账户筛选下拉）。accounts 表无期初余额列 → 不返回余额字段。
  ipcMain.handle('mz:listAccounts', () => {
    const db = ctx.getDb()
    if (!db) return []
    return listAccountOptions(db)
  })

  // 置信度直通阈值（巡检/设置用；改它才能构造出「待入账·AI 反问」卡）
  ipcMain.handle('mz:getConfidenceThreshold', (): number => {
    const db = ctx.getDb()
    if (!db) throw new Error('账本未就绪')
    return readConfidenceThreshold(db)
  })

  ipcMain.handle('mz:setConfidenceThreshold', (_e, value: number): number => {
    const db = ctx.getDb()
    if (!db) throw new Error('账本未就绪')
    return writeConfidenceThreshold(db, value)
  })

  ipcMain.handle('mz:listLedger', (_e, filter: LedgerFilter): LedgerPageDTO => {
    const db = ctx.getDb()
    if (!db) return { items: [], total: 0, agg: emptyLedgerAgg(filter.month || null) }
    return queryLedgerPage(db, filter)
  })

  // D-03a: 批次结果按批次读回（不传 gateId = 最近一次已执行的批次）。
  // 账本未就绪 / 没执行过批次 → null，界面据此不显示结果条（不编数字）。
  ipcMain.handle('mz:getBatchResult', (_e, gateId?: number): BatchResultSummaryDTO | null => {
    const db = ctx.getDb()
    if (!db) return null
    return gateId === undefined ? getLatestBatchSummary(db) : getBatchSummary(db, gateId)
  })

  // D-01 批量归类：只读建议 / 执行 / 整体撤销。执行入口 = 界面确认按钮（工具侧只能落方案）。
  ipcMain.handle('mz:getClassifyProposal', (_e, batchId?: string) => {
    validateBatchId(batchId)
    const db = ctx.getDb()
    if (!db) throw new Error('账本未就绪')
    return buildClassifyProposal(db, { batchId: batchId ?? null })
  })

  const requireDb = (): Database => {
    const db = ctx.getDb()
    if (!db) throw new Error('账本未就绪')
    return db
  }
  ipcMain.handle('mz:prepareClassify', (_e, input: { batchId?: string | null; assignments: ClassifyAssignmentInput[]; expectedProposalVersion?: string }) => {
    if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('归类参数无效')
    if (typeof input.expectedProposalVersion !== 'string' || !input.expectedProposalVersion) throw new Error('归类建议版本缺失，请重新读取并复核')
    return prepareClassify(requireDb(), { assignments: input.assignments, batchId: input.batchId, expectedProposalVersion: input.expectedProposalVersion, sessionId: 'ui-import-review' })
  })
  ipcMain.handle('mz:getClassifyResults', (_e, batchId?: string) => {
    validateBatchId(batchId)
    return getClassifyResults(requireDb(), batchId)
  })
  ipcMain.handle('mz:listCategoryRules', () => listCategoryRules(requireDb()))
  ipcMain.handle('mz:saveCategoryRule', (_e, input: SaveCategoryRuleInput) => saveCategoryRule(requireDb(), input))
  ipcMain.handle('mz:updateCategoryRule', (_e, input: UpdateCategoryRuleInput) => updateCategoryRule(requireDb(), input))
  ipcMain.handle('mz:deactivateCategoryRule', (_e, input: DeactivateCategoryRuleInput) => deactivateCategoryRule(requireDb(), input))

  ipcMain.handle('mz:applyClassify', (_e, gateId: number, rows?: ClassifyAssignmentInput[]) => {
    if (!Number.isSafeInteger(gateId) || gateId <= 0) throw new Error('确认门参数无效')
    const db = ctx.getDb()
    if (!db) return null
    return applyClassify(db, gateId, rows)
  })

  ipcMain.handle('mz:undoClassify', (_e, classifyId: string) => {
    if (typeof classifyId !== 'string' || !classifyId.startsWith('cls-') || classifyId.length > 300) throw new Error('撤销参数无效')
    const db = ctx.getDb()
    if (!db) throw new Error('账本未就绪')
    return undoClassify(db, classifyId)
  })

  ipcMain.handle('mz:loadHistory', () => {
    const file = ctx.engines.tryGet()?.sessionFile
    return file ? parseSessionHistory(file) : []
  })

}
