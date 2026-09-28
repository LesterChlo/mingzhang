// pi 引擎宿主：装配 ModelRuntime / ResourceLoader / SessionManager / 自定义工具，
// 把 pi 事件流转成 IPC 广播，并把每轮执行过程记入 agent_runs。
// 隔离要点（方案 §2.2）：~/.pi 零接触（authPath/modelsPath/modelsStorePath/agentDir 全指 app 数据目录）；
// 凭据用 InMemoryCredentialStore + setRuntimeApiKey 运行时注入（不落 pi 任何文件）；
// noTools:'builtin' 关闭全部内置工具，工具面 = 账务工具。

import {
  createAgentSession,
  createExtensionRuntime,
  ModelRuntime,
  SessionManager,
  SettingsManager,
  type AgentSession,
  type ResourceLoader,
} from '@earendil-works/pi-coding-agent'
import { InMemoryCredentialStore, type ImageContent } from '@earendil-works/pi-ai'
import { existsSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import type { Database } from 'better-sqlite3-multiple-ciphers'
import type { ResolvedPaths } from '../paths'
import { parseSessionHistory } from '../history'
import type { ConfigStore, AppConfig, ProviderConfig } from '../config/store'
import type { SecretsStore } from '../secrets/store'
import { MINGZHANG_SYSTEM_PROMPT } from './system-prompt'
import { globalRestoreGate } from '../domain/restore-gate'
import { createLedgerTools, type TurnContext } from './tools'
import {
  confirm as confirmTx,
  getTransaction,
  getOrCreateCategoryId,
  updateFields,
  softDelete,
  restore,
} from '../domain/ledger'
import { buildCard, txOf } from '../domain/cards'
import { findOpenByTxAndField, closePending } from '../domain/pending'
import { executeDeleteGate, cancelGate as cancelGateInDb } from '../domain/gates'
import { executeBatch, batchFollowUpSummary } from '../domain/batch'
import { applyClassify } from '../domain/classify'
import { getPending } from '../domain/pending'
import { startupReportCheck, type MonthReport } from '../domain/reports'
import { nowIso } from '../db/time'
import { startMockServer, type MockServer } from '../mock/server'
import { join as joinPath } from 'node:path'
import type { ChatEvent, ExecResult, TransactionCardData, TxEditOp } from '../../shared/types'

export type Broadcaster = (evt: ChatEvent) => void

/** 一轮对话的空闲超时（毫秒）：超过这么久没收到任何 pi 事件即判模型卡死。
 *  默认 60s；测试/排障可用 process.env.MZ_TURN_IDLE_TIMEOUT_MS 注入小值。
 *  这个值同时喂给 pi 原生的 httpIdleTimeoutMs（库层 HTTP 空闲超时，见 start()）。 */
export function turnIdleTimeoutMs(): number {
  const raw = Number(process.env.MZ_TURN_IDLE_TIMEOUT_MS)
  return Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : 60_000
}

/** 一轮对话的总预算（毫秒）：无论有没有进展，整轮最多跑这么久。默认 10 分钟。
 *  覆盖"事件一直在来但整轮永不结束"（空闲超时管不到）；同样允许环境变量注入。 */
export function turnTotalBudgetMs(): number {
  const raw = Number(process.env.MZ_TURN_TOTAL_BUDGET_MS)
  return Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : 10 * 60_000
}

/** abort 的等待上限（毫秒）：abort 是异步收尾清理，卡住不该拖死这一轮。
 *  默认 5s；测试/排障可用 process.env.MZ_TURN_ABORT_WAIT_MS 注入小值。 */
export function turnAbortWaitMs(): number {
  const raw = Number(process.env.MZ_TURN_ABORT_WAIT_MS)
  return Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : 5_000
}

/** 渲染层保险丝（毫秒）：界面"多久没有任何引擎动静"才开口。
 *  由主进程统一给值，避免 UI 的网和引擎的契约各说各话；默认 = 引擎空闲阈值 + 30s 余量。 */
export function uiFallbackWaitMs(): number {
  const raw = Number(process.env.MZ_UI_FALLBACK_WAIT_MS)
  if (Number.isFinite(raw) && raw > 0) return Math.floor(raw)
  return turnIdleTimeoutMs() + 30_000
}

/** 思考增量推给界面的节流窗口（毫秒）：模型可能每秒吐几十条 delta，
 *  原样转发会刷爆 IPC 与界面；界面需要的只是"还活着"的节奏。 */
const THINKING_BROADCAST_THROTTLE_MS = 1000

/** 等一段时间（不依赖 pi 的任何 promise 先 settle）。 */
const delayMs = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

/** 一轮因超时被中止（区别于模型自己报错）。渲染层据此显示"引擎的真实原因"。 */
export class TurnTimeoutError extends Error {
  readonly code = 'TURN_TIMEOUT'
  constructor(message: string) {
    super(message)
    this.name = 'TurnTimeoutError'
  }
}

/** 算作"这一轮在向前走"的 pi 事件（空闲看门狗只认这些）。
 *
 *  刻意**只认产出数据的事件**：模型在吐字（message_update）、工具在跑（tool_execution_*）。
 *  会话级记账事件（agent_start / turn_start / message_start / entry_appended /
 *  auto_retry_* / summarization_retry_* / compaction_* / session_* / agent_settled …）
 *  一律不算进展——它们只说明"管线还在跳"。这不是洁癖，是实测出来的必要条件：
 *  端点持续不回时，pi 会 库层HTTP超时 → auto_retry_start → 退避 → 再超时 → …，
 *  每轮尝试都在 turn_start/message_start 处把空闲计时清零，于是空闲阈值永远攒不满，
 *  整轮被 retry 预算拖成"3 次 × 超时 + 退避"（实测 18s 阈值下 60s 仍未收敛）。
 *  真正的进展只有"有字节在动 / 有工具在跑"，按这个判，阈值攒得满、且不误伤真流式。 */
const PROGRESS_EVENTS: ReadonlySet<string> = new Set([
  'message_update',
  'tool_execution_start',
  'tool_execution_update',
  'tool_execution_end',
])

export class Engine {
  private session: AgentSession | null = null
  private turn: TurnContext = { sessionId: '', sourceMessageId: '', hasImage: false, visionUnverified: false, attachments: [] }
  private toolCalls: { name: string }[] = []
  private assistantText = ''
  private runId: number | null = null
  private mockServer: MockServer | null = null
  /** 最近一次 pi 事件的时间戳：一轮对话的空闲判定基准（onPiEvent 里刷新）。 */
  private lastEventAt = 0
  /** 最近一次把"思考中"推给界面的时间戳（节流用；每轮开始重置）。 */
  private lastThinkingBroadcastAt = 0
  // 执行反馈与防重（第 5 单 C1）：同一 gate/交易的确认只允许一个在执行，拦下连点与并发。
  private readonly confirming = new Set<string>()

  constructor(
    private readonly db: Database,
    private readonly paths: ResolvedPaths,
    private readonly config: ConfigStore,
    private readonly secrets: SecretsStore,
    private readonly broadcast: Broadcaster,
  ) {}

  get ready(): boolean {
    return this.session !== null
  }

  get sessionId(): string {
    return this.session?.sessionId ?? ''
  }

  get attachmentsDir(): string {
    return this.paths.attachmentsDir
  }

  /** 当前会话文件路径（历史加载用）。 */
  get sessionFile(): string | undefined {
    return this.session?.sessionFile
  }

  /** A4 归档会话列表（不含当前会话）。 */
  async listArchivedSessions(): Promise<{
    path: string
    id: string
    firstMessage: string
    modified: string
    messageCount: number
    current: boolean
  }[]> {
    const current = this.sessionFile
    const list = await SessionManager.list(this.paths.dataDir, this.paths.sessionsDir)
    return list
      .filter((s) => s.path !== current)
      .map((s) => ({
        path: s.path,
        id: s.id,
        firstMessage: s.firstMessage,
        modified: s.modified.toISOString(),
        messageCount: s.messageCount,
        current: false,
      }))
  }

  /** 启动检查：上月月报未生成则后台补一次（A7；只记 agent_runs，不打扰）。返回生成的报告（可 null）。 */
  startupReport(today?: Date): MonthReport | null {
    return startupReportCheck(this.db, today)
  }

  /** 按 provider 配置写 models.json（pi 兼容结构，不含密钥）并启动会话。
   *  fresh=true 新开会话文件（"新开对话"）；openPath 续接指定归档会话（"继续此对话"）；
   *  默认续接最近一条连续对话。 */
  async start(opts: { fresh?: boolean; openPath?: string } = {}): Promise<void> {
    const cfg: AppConfig = this.config.load()
    if (!cfg.mock && !cfg.activeProviderId) throw new Error('未配置模型供应商（可在设置里选择离线演示）')

    const mock = cfg.mock === true
    const active = cfg.providers.find((p) => p.id === cfg.activeProviderId) ?? null
    let pid = active?.id ?? 'mock-local'
    let modelId = active?.model ?? 'mock-mingzhang'
    const modelsJsonPath = join(this.paths.piDir, 'models.json')
    if (mock) {
      // 离线演示：内置确定性假模型（127.0.0.1 随机端口），不触网
      if (!this.mockServer) this.mockServer = await startMockServer()
      pid = 'mock-local'
      modelId = 'mock-mingzhang'
      writeModelsJson(
        modelsJsonPath,
        { id: pid, name: '离线演示', baseUrl: `http://127.0.0.1:${this.mockServer.port}/v1`, model: modelId, visionCapable: false },
      )
    } else {
      if (!active) throw new Error('未配置模型供应商（可在设置里选择离线演示）')
      if (this.mockServer) {
        await this.mockServer.close()
        this.mockServer = null
      }
      writeModelsJson(modelsJsonPath, active)
    }

    const modelRuntime = await ModelRuntime.create({
      credentials: new InMemoryCredentialStore(),
      authPath: join(this.paths.piDir, 'auth.json'),
      modelsPath: modelsJsonPath,
      modelsStorePath: join(this.paths.piDir, 'models-store.json'),
    })

    // 密钥按 provider 分存（决定记录 §4 多预设修订）：provider-key:<id>
    const apiKey = (mock ? 'mock-key' : null) ?? this.secrets.get(`provider-key:${pid}`)
    if (apiKey) {
      // 运行时注入（优先级最高），不持久化到 pi 任何文件
      await modelRuntime.setRuntimeApiKey(pid, apiKey)
    }
    const model = modelRuntime.getModel(pid, modelId)
    if (!model) throw new Error(`模型未找到：${pid}/${modelId}`)

    const resourceLoader: ResourceLoader = {
      getExtensions: () => ({ extensions: [], errors: [], runtime: createExtensionRuntime() }),
      getSkills: () => ({ skills: [], diagnostics: [] }),
      getPrompts: () => ({ prompts: [], diagnostics: [] }),
      getThemes: () => ({ themes: [], diagnostics: [] }),
      getAgentsFiles: () => ({ agentsFiles: [] }),
      getSystemPrompt: () => MINGZHANG_SYSTEM_PROMPT,
      getSystemPromptSource: () => undefined,
      getAppendSystemPrompt: () => [],
      getAppendSystemPromptSources: () => [],
      extendResources: () => {},
      reload: async () => {},
    }

    const { session } = await createAgentSession({
      cwd: this.paths.dataDir,
      agentDir: this.paths.piDir,
      model,
      modelRuntime,
      noTools: 'builtin',
      customTools: createLedgerTools({
        db: this.db,
        getTurnContext: () => this.turn,
      }),
      resourceLoader,
      settingsManager: SettingsManager.inMemory({
        compaction: { enabled: true },
        retry: { enabled: true, maxRetries: 2 },
        // 库原生 HTTP 空闲超时（pi → settingsManager.getHttpIdleTimeoutMs() → streamSimple({timeoutMs})
        // → OpenAI SDK 的 timeout）。这一层负责"对端连上了但一个字节都不回"这类硬卡死：
        // 请求自己会抛错，pi 的 retry 也能接手。与下面的引擎级看门狗分工见 doSendChat 注释。
        httpIdleTimeoutMs: turnIdleTimeoutMs(),
      }),
      sessionManager: opts.openPath
        ? SessionManager.open(opts.openPath, this.paths.sessionsDir)
        : opts.fresh
          ? SessionManager.create(this.paths.dataDir, this.paths.sessionsDir)
          : SessionManager.continueRecent(this.paths.dataDir, this.paths.sessionsDir),
    })

    this.session = session
    this.turn.sessionId = session.sessionId
    session.subscribe((evt) => this.onPiEvent(evt))
  }

  async dispose(): Promise<void> {
    this.session?.dispose()
    this.session = null
    if (this.mockServer) {
      await this.mockServer.close()
      this.mockServer = null
    }
  }

  /**
   * 新开对话（第 5 单 C4①：不强制归档空会话）。
   * 当前会话若还没有任何消息（空/刚开），直接沿用——不再无谓地新建并归档一个空文件；
   * 否则旧会话文件保留在磁盘上（可在「设置 → 会话归档」查看/继续），从此落新文件。
   * 返回是否真正归档并新开了会话。
   */
  async newConversation(): Promise<boolean> {
    const file = this.sessionFile
    const empty = !file || !existsSync(file) || parseSessionHistory(file).length === 0
    if (empty) return false
    await this.dispose()
    await this.start({ fresh: true })
    return true
  }

  /** 继续一条已归档会话（第 5 单 C4②）：引擎切到该会话文件，之后对话在其上下文里续写。 */
  async resumeSession(path: string): Promise<void> {
    await this.dispose()
    await this.start({ openPath: path })
  }

  private onPiEvent(evt: { type: string; [k: string]: unknown }): void {
    // 空闲看门狗的"有进展"判定：**只认真正向前走的事件**（模型在说话 / 在调工具 / 一轮开收）。
    // 刻意**不**把 auto_retry_* / summarization_retry_* / entry_appended / queue_update /
    // compaction_* / session_* / agent_settled 算作进展——它们是"管线还在跳、但这一轮没前进"，
    // 其中 auto_retry_* 尤其致命：端点一直不回 → 库层 HTTP 超时 → pi 发 auto_retry_start →
    // 退避 2s → 再试 18s → …… 若把它们当进展，空闲计时会被无限重置，整轮照样永不结束
    // （实测：18s 阈值下这样跑满 60s 仍未收敛）。
    if (PROGRESS_EVENTS.has(evt.type)) this.lastEventAt = Date.now()
    switch (evt.type) {
      case 'message_update': {
        const inner = evt.assistantMessageEvent as { type: string; delta?: string } | undefined
        if (inner?.type === 'text_delta' && inner.delta) {
          this.assistantText += inner.delta
          this.broadcast({ type: 'text-delta', payload: { delta: inner.delta } })
        } else if (inner?.type === 'thinking_delta' && inner.delta) {
          // 真机第二轮：模型"想很久"的这段时间界面一个事件都收不到（全黑），
          // 只能靠自己的定时器猜——90 秒时就会谎报"引擎没有回应"。
          // 契约 A（T0928-1330）：思考**正文**（inner.delta）如实广播出去，
          // 不节流、不丢字——界面据此把"模型在想什么"流式显示出来。
          // 心跳保留（折叠条走秒靠它），仍按每秒最多一条节流。
          const now = Date.now()
          this.broadcast({ type: 'thinking-delta', payload: { delta: inner.delta, at: now } })
          if (now - this.lastThinkingBroadcastAt >= THINKING_BROADCAST_THROTTLE_MS) {
            this.lastThinkingBroadcastAt = now
            this.broadcast({ type: 'progress', payload: { phase: 'thinking', at: now } })
          }
        }
        break
      }
      case 'tool_execution_start':
        this.toolCalls.push({ name: String(evt.toolName ?? '') })
        this.broadcast({ type: 'tool-start', payload: { toolName: evt.toolName } })
        break
      case 'tool_execution_end': {
        const result = evt.result as { isError?: boolean; content?: { type: string; text?: string }[]; details?: Record<string, unknown> } | undefined
        const text = (result?.content ?? [])
          .filter((c) => c.type === 'text')
          .map((c) => c.text ?? '')
          .join('')
        this.broadcast({
          type: 'tool-end',
          payload: {
            toolName: evt.toolName,
            isError: Boolean(evt.isError ?? result?.isError),
            text: text || (evt.isError ? String((evt.result as { Error?: string; message?: string } | undefined)?.message ?? (evt.result as { Error?: string } | undefined)?.Error ?? '工具执行失败') : ''),
            details: result?.details ?? {},
          },
        })
        break
      }
      case 'agent_end':
        this.broadcast({ type: 'agent-end' })
        break
      default:
        break
    }
  }

  /** 发送一条用户消息（可带图片）。阻塞到整轮 agent 结束。 */
  async sendChat(
    text: string,
    images: { fileName?: string; dataBase64: string; mediaType: string }[],
  ): Promise<void> {
    if (!this.session) throw new Error('引擎未就绪')
    const turnToken = globalRestoreGate.beginTurnToken()
    if (!turnToken) throw new Error('账本恢复进行中，本轮对话被拒绝（互斥），请稍后重试')
    try {
      await this.doSendChat(text, images)
    } finally {
      globalRestoreGate.endTurn(turnToken)
    }
  }

  private async doSendChat(
    text: string,
    images: { fileName?: string; dataBase64: string; mediaType: string }[],
  ): Promise<void> {
    if (!this.session) throw new Error('引擎未就绪')
    // B：附件原图落 attachments/（原图默认保留），文件名随 turn 传给工具（imports.source_ref）
    const savedAttachments: string[] = []
    for (const img of images) {
      try {
        const safe = (img.fileName ?? 'image.png').replace(/[\/:*?"<>|]/g, '_')
        const name = `${Date.now().toString(36)}-${safe}`
        writeFileSync(joinPath(this.paths.attachmentsDir, name), Buffer.from(img.dataBase64, 'base64'))
        savedAttachments.push(name)
      } catch {
        // 原图保存失败不阻塞对话
      }
    }
    const cfgNow = this.config.load()
    const activeNow = cfgNow.providers.find((p) => p.id === cfgNow.activeProviderId) ?? null
    this.turn = {
      sessionId: this.session.sessionId,
      sourceMessageId: `msg-${randomUUID()}`,
      hasImage: images.length > 0,
      // 视觉软拦：图片来源 + 非离线演示 + 该模型未通过视觉自检 → record 强制转待确认
      visionUnverified: images.length > 0 && cfgNow.mock !== true && activeNow?.visionCapable !== true,
      attachments: savedAttachments,
    }
    this.toolCalls = []
    this.assistantText = ''
    this.lastThinkingBroadcastAt = 0
    this.runId = this.insertRun(text)
    // 轮开始的用户消息回显（ChatEvent 里早有这个事件，引擎这前从不广播）：
    // 插完 run 行、发 prompt **之前**广播——速记行/面板发的消息都走这一条，
    // 所以面板流里拿得到自己那条用户气泡（哪怕这一轮稍后超时或报错，回显也已落地）。
    // text 逐字用入参：不 trim、不改写（改写的是模型上下文，不是用户看到的那句）。
    this.broadcast({ type: 'user-message', payload: { text, hasImage: images.length > 0 } })

    const imageContent: ImageContent[] = images.map((img) => ({
      type: 'image',
      data: img.dataBase64,
      mimeType: img.mediaType,
    }))

    // ---- 一轮的执行上限（两层超时，职责不重叠） --------------------------------
    // ① 库原生 HTTP 空闲超时（start() 里的 httpIdleTimeoutMs）：管"请求挂在 HTTP 层"——
    //    对端连上不返回、或中途断流不报错，OpenAI SDK 自己会抛错，pi 的 retry 照常接手。
    // ② 引擎级看门狗（这里）：管库层管不到的两类——
    //    a) 空闲：迟迟没有任何 pi 事件（库层可能正卡在重试退避、或 provider 反复快速失败）；
    //    b) 总预算：事件一直在来但整轮永不结束（纯流式不收敛）。
    //    两类都走同一条收敛路径：await session.abort() → run 落 failed → 广播真实原因 →
    //    sendChat 的 promise 一定 settle（不留悬挂的轮次）。
    const idleMs = turnIdleTimeoutMs()
    const budgetMs = turnTotalBudgetMs()
    const startedAt = Date.now()
    this.lastEventAt = startedAt
    let timedOut = false
    let timeoutMessage = ''
    // abort 是异步的：先记下 promise，等 prompt() 返回后再 await 它 —— 否则下一轮
    // 可能在 agent 还没 idle 时就发 prompt（pi 会拒："Cannot submit a prompt while ..."）。
    let abortTask: Promise<void> | null = null
    // 这一轮"已经判死"的信号：watchdog 判超时后立刻放行，不等 prompt() 自己 settle
    // （abort 卡住时 prompt() 可能永远 pending——真机第三轮的教训）。
    let turnOver: () => void = () => {}
    const overPromise = new Promise<void>((resolve) => {
      turnOver = resolve
    })
    const fire = (message: string): void => {
      if (timedOut) return
      timedOut = true
      timeoutMessage = message
      abortTask = this.abortTurn(message)
      // 这一轮已经判死：不依赖 prompt() 自己 settle（abort 卡住时它可能永远 pending）
      turnOver()
    }
    const watchdog = setInterval(() => {
      if (timedOut) return
      const idleFor = Date.now() - Math.max(this.lastEventAt, startedAt)
      const totalFor = Date.now() - startedAt
      if (idleFor >= idleMs) {
        fire(`模型请求超时：${Math.round(idleMs / 1000)} 秒没有响应，可以重试`)
      } else if (totalFor >= budgetMs) {
        fire(`这一轮超过 ${Math.round(budgetMs / 60000)} 分钟仍未结束，已中止，可以重试`)
      }
    }, Math.max(100, Math.min(1000, Math.floor(idleMs / 4))))

    const promptTask = this.session.prompt(text, { images: imageContent })
    // 被放弃的轮次不许变成 unhandledRejection（下面的 race 走的是 promptTask 派生 promise）
    promptTask.catch(() => undefined)
    try {
      await Promise.race([promptTask, overPromise])
      // 实测（tests/turn-timeout.test.ts 的 abort 探针）：abort() 之后 prompt() 是 **resolve**
      // 而不是 reject —— 所以这里必须靠 timedOut 标志判定，不能靠 catch。
      if (timedOut) {
        // abort 只是收尾清理：正常 3ms 就回来；卡住也不能让这一轮没有结论（上限内等它，等不到就放行）
        await Promise.race([abortTask ?? Promise.resolve(), delayMs(turnAbortWaitMs())])
        throw new TurnTimeoutError(timeoutMessage)
      }
      this.finishRun('success')
    } catch (err) {
      // 超时路径的 run 状态与广播已由 abortTurn 负责（这里只补 settle，不重复报错）
      if (timedOut) {
        await Promise.race([abortTask ?? Promise.resolve(), delayMs(turnAbortWaitMs())])
        throw err instanceof TurnTimeoutError ? err : new TurnTimeoutError(timeoutMessage)
      }
      this.finishRun('failed')
      this.broadcast({ type: 'error', payload: { message: (err as Error).message } })
      throw err
    } finally {
      clearInterval(watchdog)
      // 一轮收尾信号（ChatEvent 里早有这个事件，引擎这前从不广播）。
      // 位置就在这里：包住"prompt → 结论"的那段 try/catch 的 finally，正常结束、
      // 抛错、TurnTimeoutError（超时/abort）三条路径全部汇聚于此 —— 恰好一次，
      // 且是这一轮最后一个事件（在 agent-end / error 之后）。
      // 超时轮尤其需要它：那一轮是 abort 收尾的，agent_end 只是"碰巧赶上"的兜底
      // （实测 hang 模式下它会来，但那是 abort 恰好触发的副产物，不是契约），
      // 从前界面只能靠一条 error 去猜这一轮完了没有。
      // 刻意**不**放进 sendChat 的 finally：那个 finally 只负责放掉恢复互斥令牌
      // （globalRestoreGate.endTurn），beginTurnToken() 返回空时根本没有轮。
      this.broadcast({ type: 'turn-end' })
    }
  }

  /** 空闲/总预算到期：中止当前轮、落 failed、广播真实原因。
   *  abortRetry() 必须先叫：端点持续不回时 pi 正在退避重试（auto_retry_start），
   *  只 agent.abort() 停不掉那个退避定时器，这一轮就还会被拖下去（实测 18s 阈值下 60s 未收敛）。 */
  private async abortTurn(message: string): Promise<void> {
    // 先把结论落下来：这一轮已判定超时/失败。abort 只是收尾清理——它要是卡住
    // （实测通常 3ms，但没有上限），"这一轮失败了"这个事实不该跟着缺席，
    // 否则界面只能退回自己的盲定时器（真机第二轮的教训）。
    this.finishRun('failed')
    this.broadcast({ type: 'error', payload: { message } })
    try {
      this.session?.abortRetry()
      await this.session?.abort()
    } catch {
      // abort 失败（引擎已销毁等）不改变结论：这一轮已经超时
    }
  }

  private insertRun(userInput: string): number {
    const cur = this.db
      .prepare(
        'INSERT INTO agent_runs (session_id, user_input, llm_provider, trigger, status, created_at, updated_at)' +
          " VALUES (?, ?, ?, 'user', 'running', ?, ?)",
      )
      .run(this.session?.sessionId ?? '', userInput, this.config.load().activeProviderId ?? (this.config.load().mock ? 'mock-local' : null), nowIso(), nowIso())
    return Number(cur.lastInsertRowid)
  }

  private finishRun(status: 'success' | 'failed' | 'aborted'): void {
    if (this.runId === null) return
    this.db
      .prepare('UPDATE agent_runs SET tool_calls=?, output_summary=?, status=?, updated_at=? WHERE id=?')
      .run(
        JSON.stringify(this.toolCalls),
        this.assistantText.slice(0, 2000) || null,
        status,
        nowIso(),
        this.runId,
      )
    this.runId = null
  }

  /**
   * 确认门执行入口（仅 UI 按钮调用）：needs_review → confirmed，并关闭挂起事项。
   * 支出/收入缺分类时必须先给 categoryName（DDL：confirmed 的支出/收入必须有分类）。
   * 第 6 单 段1：返回语义化 ExecResult，每种状态渲染层都有可见文案（不再有静默路径）。
   */
  async confirmRecord(txId: number, categoryName?: string): Promise<ExecResult> {
    const key = `record:${txId}`
    if (this.confirming.has(key)) return { status: 'in_flight', message: '这笔正在处理，请稍候…' }
    this.confirming.add(key)
    try {
      return await this.doConfirmRecord(txId, categoryName)
    } catch (e) {
      return { status: 'error', message: `确认失败：${(e as Error).message}` }
    } finally {
      this.confirming.delete(key)
    }
  }

  private async doConfirmRecord(txId: number, categoryName?: string): Promise<ExecResult> {
    const tx = getTransaction(this.db, txId)
    if (!tx) return { status: 'not_found', message: `交易 #${txId} 不存在（可能已被清理）` }
    if (tx.state === 'deleted') return { status: 'error', message: `#${txId} 已删除，请先在账本恢复后再操作` }
    if (tx.state === 'confirmed') return { status: 'already_closed', message: `#${txId} 已入账，无需重复确认` }

    if ((tx.type === 'expense' || tx.type === 'income') && tx.category_id === null) {
      if (!categoryName) {
        return { status: 'error', message: '这笔还没有分类，请先在卡片上选择分类再确认。' }
      }
      const categoryId = getOrCreateCategoryId(this.db, categoryName, tx.type as 'expense' | 'income', {
        changedBy: 'user',
      })
      updateFields(this.db, txId, { category_id: categoryId }, { reasoning: '用户确认时在卡片上选择分类' })
    }

    const pending = findOpenByTxAndField(this.db, txId, 'confirm_record')
    if (pending) closePending(this.db, pending.id, 'resolved')

    confirmTx(this.db, txId, { reasoning: '用户在界面上点击确认' })

    // 重新取一次（分类/状态已更新）
    const fresh = getTransaction(this.db, txId) ?? tx

    // 通知模型（尽力而为）：结果以 DB 为准，模型只需知会用户
    try {
      await this.session?.followUp(`系统通知：用户已在界面确认入账（交易 #${txId}，现状态 confirmed）。请用一句话知会用户即可。`)
    } catch {
      // 引擎未就绪/正在流式时不强求
    }

    const card: TransactionCardData = {
      kind: 'transaction',
      tx: {
        id: fresh.id,
        amountCents: fresh.amount_cents,
        type: fresh.type,
        merchant: fresh.merchant,
        categoryName: fresh.category_id
          ? ((this.db.prepare('SELECT name FROM categories WHERE id=?').get(fresh.category_id) as { name: string } | undefined)?.name ?? null)
          : null,
        accountName: (this.db.prepare('SELECT name FROM accounts WHERE id=?').get(fresh.account_id) as { name: string } | undefined)?.name ?? null,
        toAccountName: null,
        occurredAt: fresh.occurred_at,
        state: fresh.state,
        confidenceScore: fresh.confidence_score,
        note: fresh.note,
      },
    }
    this.broadcast({ type: 'record-confirmed', payload: { card } })
    return { status: 'ok', message: `已入账 #${txId}`, card }
  }

  /** 删除/批次确认门执行（仅 UI 按钮调用）。返回语义化 ExecResult。 */
  async confirmGate(gateId: number): Promise<ExecResult> {
    const key = `gate:${gateId}`
    if (this.confirming.has(key)) return { status: 'in_flight', message: '这道确认正在处理，请稍候…' }
    this.confirming.add(key)
    try {
      return await this.doConfirmGate(gateId)
    } catch (e) {
      return { status: 'error', message: `执行失败：${(e as Error).message}` }
    } finally {
      this.confirming.delete(key)
    }
  }

  private async doConfirmGate(gateId: number): Promise<ExecResult> {
    const gateRow = getPending(this.db, gateId)
    if (!gateRow) return { status: 'not_found', message: `确认门 #${gateId} 不存在` }
    if (gateRow.field === 'batch_confirm') {
      const result = executeBatch(this.db, gateId)
      if (!result) return { status: 'already_closed', message: '这道批次确认门已处理过（已入账或已取消），无需重复。' }
      this.broadcast({ type: 'gate-executed', payload: { kind: 'batch', gateId, result } })
      try {
        await this.session?.followUp(batchFollowUpSummary(result))
      } catch {
        // 忽略
      }
      return { status: 'ok', message: `已入账 ${result.completed.length} 笔` }
    } else if (gateRow.field === 'batch_classify') {
      // D-01 批量归类：执行入口唯一 = UI 按钮 → IPC → applyClassify（工具侧只能 prepare）
      const result = applyClassify(this.db, gateId)
      if (!result) return { status: 'already_closed', message: '这道归类确认门已处理过（已入账或已取消），无需重复。' }
      this.broadcast({ type: 'gate-executed', payload: { kind: 'classify', gateId, result } })
      try {
        await this.session?.followUp(
          `系统通知：用户已在界面确认批量归类，${result.appliedCount} 笔入账（${result.appliedGroups.length} 组）。请用一句话知会用户即可。`,
        )
      } catch {
        // 引擎未就绪/正在流式时不强求
      }
      return { status: 'ok', message: `已归类 ${result.appliedCount} 笔` }
    }
    const deleted = executeDeleteGate(this.db, gateId)
    if (!deleted) return { status: 'already_closed', message: '这道删除确认门已处理过，无需重复。' }
    this.broadcast({ type: 'gate-executed', payload: { kind: 'delete', gateId, txId: deleted.txId } })
    try {
      await this.session?.followUp(
        `系统通知：用户已在界面确认删除（交易 #${deleted.txId}，现状态 deleted）。请用一句话知会用户，并提醒可随时恢复。`,
      )
    } catch {
      // 引擎未就绪/正在流式时不强求
    }
    return { status: 'ok', message: `已删除 #${deleted.txId}，可随时恢复` }
  }

  async cancelGate(gateId: number): Promise<ExecResult> {
    const key = `gate-cancel:${gateId}`
    if (this.confirming.has(key)) return { status: 'in_flight', message: '正在处理，请稍候…' }
    this.confirming.add(key)
    try {
      const ok = cancelGateInDb(this.db, gateId)
      if (!ok) return { status: 'already_closed', message: '这道确认门已处理过，无需重复取消。' }
      this.broadcast({ type: 'gate-cancelled', payload: { gateId } })
      try {
        await this.session?.followUp('系统通知：用户取消了刚才的删除操作，账目未变。')
      } catch {
        // 忽略
      }
      return { status: 'ok', message: '已取消，账目未变' }
    } catch (e) {
      return { status: 'error', message: `取消失败：${(e as Error).message}` }
    } finally {
      this.confirming.delete(key)
    }
  }

  /**
   * 详情抽屉动作组（第 6 单 段4-2）：对已入账的账直接动手——改字段 / 删除 / 恢复 / 补转账账户。
   * 全部走既有域层，changed_by='user' + 审计（不违背"确认只认 UI 信号"——按钮本身就是最强 UI 信号）。
   * 返回当前卡片供"已改 · 撤销"回填。
   */
  async editTx(txId: number, op: TxEditOp): Promise<ExecResult> {
    const key = `edit:${txId}`
    if (this.confirming.has(key)) return { status: 'in_flight', message: '这笔正在处理，请稍候…' }
    this.confirming.add(key)
    try {
      return this.doEditTx(txId, op)
    } catch (e) {
      return { status: 'error', message: `操作失败：${(e as Error).message}` }
    } finally {
      this.confirming.delete(key)
    }
  }

  private doEditTx(txId: number, op: TxEditOp): ExecResult {
    const tx = getTransaction(this.db, txId)
    if (!tx) return { status: 'not_found', message: `交易 #${txId} 不存在` }

    if (op.op === 'delete') {
      if (tx.state === 'deleted') return { status: 'already_closed', message: '这笔已经是删除状态' }
      softDelete(this.db, txId, { reasoning: '用户在账本详情里删除' })
      const review = findOpenByTxAndField(this.db, txId, 'confirm_record')
      if (review) closePending(this.db, review.id, 'cancelled')
      this.broadcast({ type: 'tx-deleted', payload: { txId } })
      return { status: 'ok', message: `已删除 #${txId}，可随时恢复` }
    }

    if (op.op === 'restore') {
      if (tx.state !== 'deleted') return { status: 'already_closed', message: '这笔未处于删除状态' }
      restore(this.db, txId, { reasoning: '用户在账本详情里恢复' })
      this.broadcast({ type: 'tx-restored', payload: { txId } })
      return { status: 'ok', message: `已恢复 #${txId}` }
    }

    if (op.op === 'transferAccounts') {
      if (tx.state === 'deleted') return { status: 'error', message: '这笔已删除，先恢复再补账户' }
      const exact = (name: string): number | null =>
        (this.db.prepare('SELECT id FROM accounts WHERE name = ?').get(name) as { id: number } | undefined)?.id ?? null
      const fromId = op.fromAccountName ? exact(op.fromAccountName) : tx.account_id
      if (op.fromAccountName && fromId == null) return { status: 'error', message: `找不到账户「${op.fromAccountName}」` }
      const toId = exact(op.toAccountName)
      if (toId == null) return { status: 'error', message: `找不到账户「${op.toAccountName}」` }
      if (toId === fromId) return { status: 'error', message: '转出与转入账户不能相同' }
      const fields: Record<string, unknown> = { to_account_id: toId }
      if (fromId !== tx.account_id) fields.account_id = fromId
      updateFields(this.db, txId, fields, { changedBy: 'user', reasoning: '用户在账本详情补转账账户' })
      if (tx.state !== 'confirmed') confirmTx(this.db, txId, { reasoning: '用户补齐转入账户后确认' })
      const card = buildCard(this.db, txOf(this.db, txId))
      this.broadcast({ type: 'record-confirmed', payload: { card } })
      return { status: 'ok', message: `转账账户已补齐，入账 #${txId}`, card }
    }

    // op.op === 'set'：改分类/金额/商户/备注/账户
    if (tx.state === 'deleted') return { status: 'error', message: '这笔已删除，先恢复再改' }
    const fields: Record<string, unknown> = {}
    // 契约 B（T0928-1330）：账本详情里改账户。
    // 账户名**精确匹配** accounts.name，匹配不上直接报错——
    // 不许走 resolveAccountId 的"回落第一条账户"（那会让用户以为改成功、实际记到现金上）。
    if (op.fields.accountName !== undefined && op.fields.accountName !== '') {
      const acc = this.db.prepare('SELECT id FROM accounts WHERE name = ?').get(op.fields.accountName) as
        | { id: number }
        | undefined
      if (!acc) return { status: 'error', message: `找不到账户「${op.fields.accountName}」` }
      fields.account_id = acc.id
    }
    if (op.fields.categoryName !== undefined && op.fields.categoryName !== '') {
      const kind = tx.type === 'income' ? 'income' : 'expense'
      fields.category_id = getOrCreateCategoryId(this.db, op.fields.categoryName, kind, { changedBy: 'user' })
    }
    if (op.fields.amountCents !== undefined) fields.amount_cents = op.fields.amountCents
    if (op.fields.merchant !== undefined) fields.merchant = op.fields.merchant
    if (op.fields.note !== undefined) fields.note = op.fields.note
    if (Object.keys(fields).length === 0) return { status: 'error', message: '没有要改的字段' }
    // 改账户的审计口径单列一句（account_id 前后值自然进 before/after）
    const reasoning = op.fields.accountName ? '用户在账本详情改账户' : '用户在账本详情修改这笔'
    updateFields(this.db, txId, fields, { changedBy: 'user', reasoning })
    const fresh = getTransaction(this.db, txId)
    // 改后仍是待确认且补齐了分类 → 顺手不自动确认（尊重状态机）；仅在 confirmed/needs_review 间保持原状态
    void fresh
    const card = buildCard(this.db, txOf(this.db, txId))
    return { status: 'ok', message: `已修改 #${txId}`, card }
  }

  /** 技术验收钩子：当前会话可见工具名集合（应恰为账务工具）。 */
  visibleToolNames(): string[] {
    return this.session?.agent.state.tools.map((t) => t.name).filter((n): n is string => typeof n === 'string') ?? []
  }
}

/** models.json（pi 兼容结构）：供应商 baseUrl + 模型条目；密钥永不写入。 */
function writeModelsJson(file: string, provider: ProviderConfig): void {
  const payload = {
    providers: {
      [provider.id]: {
        baseUrl: provider.baseUrl,
        api: 'openai-completions',
        models: [
          {
            id: provider.model,
            name: provider.model,
            reasoning: false,
            input: provider.visionCapable ? ['text', 'image'] : ['text'],
            contextWindow: 128000,
            maxTokens: 8192,
          },
        ],
      },
    },
  }
  writeFileSync(file, JSON.stringify(payload, null, 2), 'utf8')
}
