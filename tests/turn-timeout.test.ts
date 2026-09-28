// 一轮对话的"永不结束"收敛（引擎侧，R1）。
//
// 真机缺陷：模型请求卡住时，src/main/engine/engine.ts 的
//   `await this.session.prompt(text, { images })`
// 没有任何超时，pi 的 retry 只对抛错生效、对"挂住"无效 —— 于是整轮永远不结束：
// agent_runs 永远停在 running、界面 10s 后自己谎报"没有回音"。
//
// 本文件用**本地假 provider**（node http server）做故障注入，覆盖三类失效：
//   ① 端点接受连接但永不返回数据（真机同款）；
//   ② 端点返回 200 + 部分 SSE 后突然 destroy socket（对端中途断流）；
//   ③ 端点持续流式但整轮总时长失控（总预算）。
// 另有一条直接驱动 AgentSession 的用例，实测 abort() 之后 prompt() 到底
// reject 还是 resolve（不猜，写进日志）。
//
// 纪律：空闲超时用 process.env.MZ_TURN_IDLE_TIMEOUT_MS 注入小值；快路径用例
// （正常回复、慢但有进展的流式）证明超时逻辑不误伤。

import { describe, expect, it, beforeEach, afterAll } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Database } from 'better-sqlite3-multiple-ciphers'
import {
  createAgentSession,
  createExtensionRuntime,
  ModelRuntime,
  SessionManager,
  SettingsManager,
} from '@earendil-works/pi-coding-agent'
import { InMemoryCredentialStore } from '@earendil-works/pi-ai'

import { Engine } from '../src/main/engine/engine'
import { ConfigStore, CONFIG_VERSION } from '../src/main/config/store'
import { openLedger, initSchema } from '../src/main/db/connection'
import { seed } from '../src/main/db/seed'
import { MINGZHANG_SYSTEM_PROMPT } from '../src/main/engine/system-prompt'
import { startFakeProvider, type FakeProvider } from './fake-provider'
import type { ChatEvent } from '../src/shared/types'

// SecretsStore 结构桩（同 engine.e2e.test.ts：明文落临时目录，不依赖 Electron）
class FakeSecrets {
  private store = new Map<string, string>()
  constructor(private dir: string) {}
  isAvailable() {
    return true
  }
  requireAvailable() {}
  set(name: string, v: string) {
    writeFileSync(join(this.dir, `${name}.fake`), v)
    this.store.set(name, v)
  }
  get(name: string) {
    return this.store.get(name) ?? null
  }
  has(name: string) {
    return this.store.has(name)
  }
  delete(name: string) {
    this.store.delete(name)
  }
  names() {
    return [...this.store.keys()]
  }
}

// ---------- 假 provider（故障注入，实现见 tests/fake-provider.ts） ----------

const delay = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

interface Settled {
  /** false = 超过上限仍未 settle（悬挂） */
  ok: boolean
  value?: unknown
  error?: unknown
}

/** 断言"promise 一定会 settle"：给一个上限，超时即失败（这就是"悬挂"）。 */
async function settleWithin<T>(p: Promise<T>, ms: number): Promise<Settled> {
  const HUNG = 'HUNG'
  const winner = await Promise.race([
    p.then((v) => ({ v } as const), (e: unknown) => ({ e } as const)),
    delay(ms).then(() => HUNG as const),
  ])
  if (winner === HUNG) return { ok: false }
  const w = winner as { v?: T; e?: unknown }
  return { ok: true, value: w.v, error: w.e }
}

// ---------- 引擎装配 ----------

let db: Database
let engine: Engine
let dataDir: string
let events: ChatEvent[]
let secrets: FakeSecrets
let provider: FakeProvider

function latestRunStatus(): string {
  return (db.prepare('SELECT status FROM agent_runs ORDER BY id DESC LIMIT 1').get() as { status: string }).status
}

beforeEach(async () => {
  events = []
  dataDir = mkdtempSync(join(tmpdir(), 'mz-turn-'))
  for (const d of ['sessions', 'attachments', 'pi', 'secrets', 'backups']) {
    mkdirSync(join(dataDir, d), { recursive: true })
  }
  provider = await startFakeProvider('hang')

  db = openLedger(join(dataDir, 'mingzhang.db'), new FakeSecrets(join(dataDir, 'secrets')) as never)
  initSchema(db)
  seed(db)

  const configFile = join(dataDir, 'config.json')
  writeFileSync(
    configFile,
    JSON.stringify({
      version: CONFIG_VERSION,
      onboarded: true,
      providers: [{ id: 'fake', name: 'Fake', baseUrl: provider.url, model: 'fake-model', visionCapable: false, selfCheckAt: null }],
      activeProviderId: 'fake',
    }),
  )

  secrets = new FakeSecrets(join(dataDir, 'secrets'))
  secrets.set('provider-key:fake', 'test-key-not-secret')

  engine = new Engine(
    db,
    {
      dataDir,
      dbFile: join(dataDir, 'mingzhang.db'),
      sessionsDir: join(dataDir, 'sessions'),
      attachmentsDir: join(dataDir, 'attachments'),
      secretsDir: join(dataDir, 'secrets'),
      piDir: join(dataDir, 'pi'),
      backupsDir: join(dataDir, 'backups'),
      configFile,
      portable: false,
    },
    new ConfigStore(configFile),
    secrets as never,
    (evt) => events.push(evt),
  )
  await engine.start()
})

afterAll(async () => {
  await engine?.dispose()
  db?.close()
  await provider?.close()
})

const errorMessages = (): string[] =>
  events.filter((e) => e.type === 'error').map((e) => String((e.payload as { message?: string } | undefined)?.message ?? ''))

describe('R1 一轮永不结束 → 空闲超时收敛', () => {
  it('① 端点永不返回：空闲超时后 sendChat 一定 settle、run 落 failed、广播真实原因，之后能立刻再发一轮', async () => {
    process.env.MZ_TURN_IDLE_TIMEOUT_MS = '2000'
    try {
      const t0 = Date.now()
      const first = await settleWithin(engine.sendChat('把这张账单记一下', []), 20_000)
      const elapsed = Date.now() - t0

      // ①a 不许悬挂
      expect(first.ok, `sendChat 在 ${elapsed}ms 内没有 settle（悬挂）`).toBe(true)
      // ①b agent_runs 不能永远停在 running
      expect(latestRunStatus()).toBe('failed')
      // ①c 有 error 事件广播，且说的是真实原因（含"超时"）
      const errs = errorMessages()
      expect(errs.length).toBeGreaterThan(0)
      expect(errs.join(' | ')).toContain('超时')
      // ①d 超时确实来自空闲阈值（不是立刻失败）
      expect(elapsed).toBeGreaterThanOrEqual(1500)

      // ①e 不留僵尸轮：provider 恢复后，下一轮必须能正常跑完
      provider.setMode('ok')
      const second = await settleWithin(engine.sendChat('你好', []), 20_000)
      expect(second.ok, '超时之后再发一轮也悬挂了 → 引擎留下僵尸轮').toBe(true)
      expect(second.error).toBeUndefined()
      expect(latestRunStatus()).toBe('success')
    } finally {
      delete process.env.MZ_TURN_IDLE_TIMEOUT_MS
    }
  })

  it('② 对端中途断流（200 + 部分 SSE 后 destroy）：同样收敛，不悬挂', async () => {
    process.env.MZ_TURN_IDLE_TIMEOUT_MS = '2000'
    try {
      provider.setMode('truncate')
      const r = await settleWithin(engine.sendChat('记一笔', []), 30_000)
      expect(r.ok, '对端断流后 sendChat 悬挂（既没成功也没失败）').toBe(true)
      // 收敛到终态：不是 running
      expect(latestRunStatus()).not.toBe('running')
    } finally {
      delete process.env.MZ_TURN_IDLE_TIMEOUT_MS
    }
  })

  it('③ 端点持续流式但整轮不结束：总预算到期走同一条 abort 号路径', async () => {
    process.env.MZ_TURN_IDLE_TIMEOUT_MS = '60000' // 空闲不触发（事件一直在来）
    process.env.MZ_TURN_TOTAL_BUDGET_MS = '2500' // 总预算触发
    try {
      provider.setMode('drip')
      const r = await settleWithin(engine.sendChat('一直说话别停', []), 20_000)
      expect(r.ok, '总预算到期后 sendChat 仍悬挂').toBe(true)
      expect(latestRunStatus()).toBe('failed')
      const errs = errorMessages()
      expect(errs.join(' | ')).toMatch(/超时|未结束|中止/)
    } finally {
      delete process.env.MZ_TURN_IDLE_TIMEOUT_MS
      delete process.env.MZ_TURN_TOTAL_BUDGET_MS
    }
  })

  it('④ 快路径不受影响：正常回复在注入了 2s 空闲阈值的情况下依然成功，且不产生超时错误', async () => {
    process.env.MZ_TURN_IDLE_TIMEOUT_MS = '2000'
    try {
      provider.setMode('ok')
      const r = await settleWithin(engine.sendChat('你好', []), 20_000)
      expect(r.ok).toBe(true)
      expect(r.error).toBeUndefined()
      expect(latestRunStatus()).toBe('success')
      expect(errorMessages().join(' | ')).not.toContain('超时')
    } finally {
      delete process.env.MZ_TURN_IDLE_TIMEOUT_MS
    }
  })

  it('⑤ 慢但有进展的流式：事件持续到达时不得被空闲阈值误杀（预算足够时正常收敛）', async () => {
    process.env.MZ_TURN_IDLE_TIMEOUT_MS = '1500' // 比 120ms 的 drip 间隔宽，但比"永不结束"窄
    process.env.MZ_TURN_TOTAL_BUDGET_MS = '60000'
    try {
      provider.setMode('drip')
      // drip 永不结束，所以这里只断言"在总预算内不会因为空闲而误报"：
      // 起手 3.5s（> 2 个空闲窗口）时还没有任何超时广播。
      const p = engine.sendChat('一直说话别停', [])
      p.catch(() => undefined)
      await delay(3500)
      expect(errorMessages().join(' | ')).not.toContain('超时')
      expect(latestRunStatus()).toBe('running') // 仍在跑 = 没被误杀
      await engine.dispose() // 收尾：把这条 drip 轮次拆掉
    } finally {
      delete process.env.MZ_TURN_IDLE_TIMEOUT_MS
      delete process.env.MZ_TURN_TOTAL_BUDGET_MS
    }
  })
})

// ---------------------------------------------------------------------------
// abort() 之后 prompt() 到底 reject 还是 resolve —— 实测，不猜。
// 直接驱动 AgentSession（不经过 Engine），把结论打进日志。
// ---------------------------------------------------------------------------
describe('实测：abort() 之后 prompt() 的收敛行为', () => {
  it('直接对 AgentSession 调 abort()，记录 prompt() 的 settle 方式', async () => {
    process.env.MZ_TURN_IDLE_TIMEOUT_MS = '2000'
    const dir = mkdtempSync(join(tmpdir(), 'mz-abort-probe-'))
    for (const d of ['sessions', 'pi']) mkdirSync(join(dir, d), { recursive: true })
    const fake = await startFakeProvider('hang')
    const modelsJson = join(dir, 'pi', 'models.json')
    writeFileSync(
      modelsJson,
      JSON.stringify({
        providers: {
          probe: { baseUrl: fake.url, api: 'openai-completions', models: [{ id: 'fake-model', name: 'fake-model', reasoning: false, input: ['text'], contextWindow: 128000, maxTokens: 8192 }] },
        },
      }),
    )
    const modelRuntime = await ModelRuntime.create({
      credentials: new InMemoryCredentialStore(),
      authPath: join(dir, 'pi', 'auth.json'),
      modelsPath: modelsJson,
      modelsStorePath: join(dir, 'pi', 'models-store.json'),
    })
    await modelRuntime.setRuntimeApiKey('probe', 'k')
    const { session } = await createAgentSession({
      cwd: dir,
      agentDir: join(dir, 'pi'),
      model: modelRuntime.getModel('probe', 'fake-model')!,
      modelRuntime,
      noTools: 'builtin',
      customTools: [],
      resourceLoader: {
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
      } as never,
      settingsManager: SettingsManager.inMemory({
        compaction: { enabled: true },
        retry: { enabled: true, maxRetries: 2 },
        httpIdleTimeoutMs: 60_000,
      }),
      sessionManager: SessionManager.create(dir, join(dir, 'sessions')),
    })

    let settle: 'pending' | 'resolved' | 'rejected' = 'pending'
    let errText = ''
    const p = session.prompt('喂').then(
      () => {
        settle = 'resolved'
      },
      (e: unknown) => {
        settle = 'rejected'
        errText = String((e as Error)?.message ?? e)
      },
    )
    p.catch(() => undefined)
    await delay(1200)
    const abortStart = Date.now()
    await session.abort()
    const abortMs = Date.now() - abortStart
    await Promise.race([p, delay(5000)])
    // eslint-disable-next-line no-console
    console.log(
      `[abort-probe] abort() 耗时 ${abortMs}ms；abort 之后 prompt() 的 settle = ${settle}` +
        (settle === 'rejected' ? `（rejection: ${errText}）` : ''),
    )
    // 实测结论（写死以防回归）：prompt() 不会悬挂；abort 后它 resolve。
    expect(settle).not.toBe('pending')
    expect(abortMs).toBeLessThan(5000)

    // abort 之后同一个 session 还能再发一轮（不留僵尸轮）
    fake.setMode('ok')
    const again = await Promise.race([
      session.prompt('再来一次').then(() => 'done' as const, (e: unknown) => `err:${String((e as Error)?.message ?? e)}`),
      delay(15_000).then(() => 'hung' as const),
    ])
    // eslint-disable-next-line no-console
    console.log(`[abort-probe] abort 之后同一 session 再发一轮 = ${again}`)
    expect(again).toBe('done')

    session.dispose()
    await fake.close()
    delete process.env.MZ_TURN_IDLE_TIMEOUT_MS
  })
})

// ---------------------------------------------------------------------------
// R3/R4（真机第二轮，09-26 23:12–23:15 的现场）：模型"想很久"时界面全黑，
// 90 秒盲兜底于是又一次谎报"引擎没有回应"。
//
// 真机证据：159 行微信账单提交后，会话 JSONL 显示引擎从 23:12:38 一直干到 23:15:27
// （其中 thinking 了 2m05s），而界面在 90 秒（≈23:14:08）就写"引擎 90 秒没有回应，
// 这一轮已停止等待"——引擎在干活，界面却宣布它死了。根因两条：
//   a) 引擎在 thinking 阶段**一个事件都不往界面推**（message_update 只转发 text_delta），
//      界面这段时间全黑，只能靠自己的定时器瞎猜；
//   b) 渲染层那条 90 秒兜底是**盲定时器**（提交时武装一次、永不重置），阈值还写死，
//      测不出来。
// 本段锁三件事：
//   ⑥ 思考增量持续流动时：整轮不算卡死（不被空闲阈值误杀），且引擎把"还活着"如实
//      广播给界面（progress 事件，节流到每秒最多一条）；
//   ⑦ 思考到一半彻底静默（连接还开着、不报错）：引擎照样收敛，界面拿到引擎的真实原因；
//   ⑧ abort 卡住不返回、prompt 永不 settle：这一轮仍必须在"空闲阈值 + abort 上限"内
//      有结论——否则界面只能再退回自己的盲定时器。
// ---------------------------------------------------------------------------
describe('R3/R4 思考期的存活信号与无条件收敛', () => {
  const progressEvents = (): ChatEvent[] => events.filter((e) => e.type === 'progress')

  it('⑥ 只吐思考增量（不出正文）：整轮不算卡死，且把"还活着"广播给界面（有节流）', async () => {
    process.env.MZ_TURN_IDLE_TIMEOUT_MS = '1500'
    try {
      provider.setMode('thinking') // 20 条 × 200ms ≈ 4s 的思考流，然后正常收尾
      const p = engine.sendChat('把这张账单记一下', [])
      p.catch(() => undefined)

      // 越过两个空闲窗口（3s）：还在思考 = 不许被判死
      await delay(3000)
      expect(errorMessages().join(' | '), '思考期被空闲阈值误判成超时').not.toContain('超时')
      expect(latestRunStatus()).toBe('running')

      // 引擎必须把存活信号推给界面，否则界面全黑（真机上就是这段全黑把 90s 盲兜底逼出来的）
      const progress = progressEvents()
      expect(
        progress.length,
        `思考期没有向界面广播任何存活信号（已广播事件：${JSON.stringify(events.map((e) => e.type))}）`,
      ).toBeGreaterThanOrEqual(2)
      expect(String((progress[0].payload as { phase?: string } | undefined)?.phase)).toBe('thinking')
      // 节流：~4s 的思考流有 20 条 delta，不该原样转 20 条给界面
      expect(progress.length, `存活信号没有节流（${progress.length} 条）`).toBeLessThanOrEqual(8)

      // 想完了照常收尾
      const r = await settleWithin(p, 20_000)
      expect(r.ok, '思考流结束后没有正常收敛').toBe(true)
      expect(r.error).toBeUndefined()
      expect(latestRunStatus()).toBe('success')
    } finally {
      delete process.env.MZ_TURN_IDLE_TIMEOUT_MS
    }
  })

  it('⑦ 思考到一半彻底静默（连接不断、不报错）：引擎照样收敛，界面拿到真实原因', async () => {
    process.env.MZ_TURN_IDLE_TIMEOUT_MS = '1500'
    try {
      provider.setMode('stall') // 两口思考增量后彻底静默
      const r = await settleWithin(engine.sendChat('记一笔', []), 20_000)
      expect(r.ok, '对端静默后 sendChat 悬挂（既没成功也没失败）').toBe(true)
      expect(latestRunStatus()).toBe('failed')
      expect(errorMessages().join(' | ')).toContain('超时')
      // 静默之前那两口思考增量照样推给了界面（界面不会从现在起全黑）
      expect(progressEvents().length, '静默前的思考增量没有推给界面').toBeGreaterThanOrEqual(1)
    } finally {
      delete process.env.MZ_TURN_IDLE_TIMEOUT_MS
    }
  })

  it('⑧ abort 不返回、prompt 永不 settle：这一轮仍必须在"空闲阈值 + abort 上限"内给出结论', async () => {
    process.env.MZ_TURN_IDLE_TIMEOUT_MS = '1500'
    process.env.MZ_TURN_ABORT_WAIT_MS = '800'
    // 故障注入：abort 挂住不返回（pi 的 abort 实测 3ms——但"实测通常很快"不等于"一定有上限"，
    // 而 abort 一旦不返回，老实现里 sendChat 就永远不 settle，界面又只能靠盲定时器瞎猜）。
    const session = (engine as unknown as { session: { abort: () => Promise<void> } }).session
    const realAbort = session.abort.bind(session)
    session.abort = (): Promise<void> => new Promise<void>(() => {})
    try {
      provider.setMode('hang')
      const t0 = Date.now()
      const r = await settleWithin(engine.sendChat('记一笔', []), 10_000)
      const elapsed = Date.now() - t0
      expect(r.ok, `abort 卡住时 sendChat 悬挂了（等了 ${elapsed}ms）`).toBe(true)
      expect(String((r.error as Error)?.message ?? '')).toContain('超时')
      expect(elapsed, '没有按 abort 上限收敛（等了太久）').toBeLessThan(8000)
      expect(latestRunStatus()).toBe('failed')
      expect(errorMessages().join(' | ')).toContain('超时')
    } finally {
      session.abort = realAbort
      delete process.env.MZ_TURN_IDLE_TIMEOUT_MS
      delete process.env.MZ_TURN_ABORT_WAIT_MS
    }
  })
})

// ---------------------------------------------------------------------------
// T0927-1610：超时轮的收尾信号（本单的重点）。
//
// 超时轮从前**一个"轮结束"信号都没有**：agent_end 不会来（agent 被 abort 了），
// 界面只剩一条 error，连"这一轮结束了"都只能自己猜。引擎现在在 doSendChat 的
// finally 里广播 turn-end，三条路径（正常 / 抛错 / 超时）都覆盖到。
// 搭法照抄本文件既有的故障注入（idle 阈值压小 + 端点不回），不重构脚手架。
// ---------------------------------------------------------------------------
describe('T0927-1610 超时轮的收尾信号', () => {
  it('超时轮同样广播 user-message 与 turn-end，且 turn-end 是最后一个事件', async () => {
    process.env.MZ_TURN_IDLE_TIMEOUT_MS = '2000'
    try {
      provider.setMode('hang')
      const r = await settleWithin(engine.sendChat('把这张账单记一下', []), 20_000)
      expect(r.ok, '超时轮悬挂了').toBe(true)

      const types = events.map((e) => e.type)
      // 这一轮从速记行/面板发出去的话，用户气泡是回显来的 —— 超时也必须已经落地
      expect(types.filter((t) => t === 'user-message').length, `回显次数不对（事件序列：${JSON.stringify(types)}）`).toBe(1)
      // 超时轮从前一个"轮结束"信号都没有（只有 error）：agent-end 只是碰巧赶上，
      // 真正保证三条路径都收口的是 turn-end。
      expect(types.filter((t) => t === 'turn-end').length, `超时轮没有 turn-end（事件序列：${JSON.stringify(types)}）`).toBe(1)
      expect(types[types.length - 1], 'turn-end 之后不许再有任何事件').toBe('turn-end')
      // 语义不变：仍然是真实原因的超时报错 + run 落 failed
      expect(errorMessages().join(' | ')).toContain('超时')
      expect(latestRunStatus()).toBe('failed')
    } finally {
      delete process.env.MZ_TURN_IDLE_TIMEOUT_MS
    }
  })
})
