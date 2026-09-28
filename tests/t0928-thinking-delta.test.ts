// T0928-1330 契约 A：思考正文推送通道。
//
// 缺陷：src/main/engine/engine.ts 的 thinking_delta 分支只推节流心跳
//   {type:'progress',payload:{phase:'thinking',at}}，**正文（inner.delta）被整段丢弃**——
//   界面在模型 thinking 期间只能看到"还活着"，看不到模型在想什么。
// 本文件用既有假 provider（tests/fake-provider.ts 的 'thinking' 模式：只吐 reasoning_content）
// 驱动真实引擎，锁两件事：
//   ① 每条思考增量都带正文广播为 thinking-delta（不节流、不丢字）；
//   ② 原有 progress 心跳仍在（前端折叠条走秒靠它），且仍然节流。
// 脚手架与 tests/turn-timeout.test.ts 同源（同一份假 provider 语义），刻意不重构它。

import { describe, expect, it, beforeAll, afterAll } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Database } from 'better-sqlite3-multiple-ciphers'

import { Engine } from '../src/main/engine/engine'
import { ConfigStore, CONFIG_VERSION } from '../src/main/config/store'
import { openLedger, initSchema } from '../src/main/db/connection'
import { seed } from '../src/main/db/seed'
import { startFakeProvider, type FakeProvider } from './fake-provider'
import type { ChatEvent } from '../src/shared/types'

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

const THINK_COUNT = 12
const THINK_INTERVAL_MS = 120

let db: Database
let engine: Engine
let provider: FakeProvider
let events: ChatEvent[]

beforeAll(async () => {
  events = []
  const dataDir = mkdtempSync(join(tmpdir(), 'mz-thinking-'))
  for (const d of ['sessions', 'attachments', 'pi', 'secrets', 'backups']) {
    mkdirSync(join(dataDir, d), { recursive: true })
  }
  provider = await startFakeProvider('thinking', { count: THINK_COUNT, intervalMs: THINK_INTERVAL_MS })

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
  const secrets = new FakeSecrets(join(dataDir, 'secrets'))
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

const deltas = (): string[] =>
  events
    .filter((e) => e.type === 'thinking-delta')
    .map((e) => String((e.payload as { delta?: unknown } | undefined)?.delta ?? ''))

describe('契约 A：思考正文推送（thinking-delta）', () => {
  it('假 provider 吐的每条思考增量都带正文广播，且 progress 心跳仍按节流发出', async () => {
    provider.setMode('thinking')
    await engine.sendChat('把这张账单记一下', [])

    // ① 正文不再被丢弃：思考增量条数与假 provider 发的条数同量级，且首尾都在
    const texts = deltas()
    expect(
      texts.length,
      `思考正文没有广播（已广播事件：${JSON.stringify(events.map((e) => e.type))}）`,
    ).toBeGreaterThanOrEqual(THINK_COUNT - 2)
    expect(texts.join('')).toContain('思考第 1 步')
    expect(texts.join('')).toContain(`思考第 ${THINK_COUNT} 步`)
    // 每条都带时间戳（前端按 at 排序/去重）
    for (const e of events.filter((x) => x.type === 'thinking-delta')) {
      expect(typeof (e.payload as { at?: unknown } | undefined)?.at).toBe('number')
    }

    // ② 心跳保留：progress 仍在推、phase 仍是 thinking，且被节流（远少于增量条数）
    const progress = events.filter((e) => e.type === 'progress')
    expect(progress.length, '思考期没有 progress 心跳（前端折叠条走秒靠它）').toBeGreaterThanOrEqual(1)
    expect(String((progress[0].payload as { phase?: string } | undefined)?.phase)).toBe('thinking')
    expect(progress.length, `心跳没有节流（${progress.length} 条 vs ${texts.length} 条增量）`).toBeLessThan(texts.length)
  })
})
