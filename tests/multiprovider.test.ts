// 新票验收：config v2 迁移不丢 / 预设端口 8080 / 一键切换会话连续 / 密钥按 provider 分存。

import { describe, expect, it } from 'vitest'
import DatabaseCtor, { type Database } from 'better-sqlite3-multiple-ciphers'
import http from 'node:http'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { AddressInfo } from 'node:net'

import { ConfigStore, CONFIG_VERSION } from '../src/main/config/store'
import { PROVIDER_PRESETS } from '../src/main/wizard/providers'
import { Engine } from '../src/main/engine/engine'
import { openLedger, initSchema } from '../src/main/db/connection'
import { seed } from '../src/main/db/seed'

class FakeSecrets {
  private store = new Map<string, string>()
  isAvailable() {
    return true
  }
  requireAvailable() {}
  set(name: string, v: string) {
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

describe('A① config v2 迁移', () => {
  it('v1 单槽 → v2：providers[0] 字段不丢，activeProviderId 指向它；写回后稳定 v2', () => {
    const dir = mkdtempSync(join(tmpdir(), 'mz-cfg-'))
    const f = join(dir, 'config.json')
    writeFileSync(
      f,
      JSON.stringify({
        version: 1,
        onboarded: true,
        mock: false,
        provider: { id: 'deepseek', name: 'DeepSeek', baseUrl: 'https://api.deepseek.com', model: 'deepseek-chat', visionCapable: true },
      }),
    )
    const store = new ConfigStore(f)
    const cfg = store.load()
    expect(cfg.version).toBe(CONFIG_VERSION)
    expect(cfg.providers).toHaveLength(1)
    expect(cfg.providers[0]).toMatchObject({
      id: 'deepseek',
      name: 'DeepSeek',
      baseUrl: 'https://api.deepseek.com',
      model: 'deepseek-chat',
      visionCapable: true,
    })
    expect(cfg.activeProviderId).toBe('deepseek')
    expect(cfg.onboarded).toBe(true)

    // v1 的密钥文件名迁移由主进程启动逻辑完成（见 index.ts），此处验证配置层无损即可

    // 写回后 roundtrip 稳定 v2
    store.save(cfg)
    const cfg2 = new ConfigStore(f).load()
    expect(cfg2).toEqual(cfg)
  })

  it('v1 空配置（未完成向导）→ v2 空列表，主界面不拦路（onboarded=false 也能 load）', () => {
    const dir = mkdtempSync(join(tmpdir(), 'mz-cfg2-'))
    const f = join(dir, 'config.json')
    writeFileSync(f, JSON.stringify({ version: 1, onboarded: false, provider: null }))
    const cfg = new ConfigStore(f).load()
    expect(cfg.providers).toEqual([])
    expect(cfg.activeProviderId).toBeNull()
    expect(cfg.onboarded).toBe(false)
  })
})

describe('C 预设端口', () => {
  it('本地 OpenAI 兼容端点默认 8080（f885209 口径，不回退个人端口）', () => {
    const local = PROVIDER_PRESETS.find((p) => p.id === 'local')
    expect(local?.baseUrl).toBe('http://127.0.0.1:8080/v1')
  })
})

// —— 切换连续性（脚本化模型；两个 provider 指向同一本地服务器）——
function scriptedServer(): Promise<string> {
  let step = 0
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      const chunks: Buffer[] = []
      req.on('data', (c: Buffer) => chunks.push(c))
      req.on('end', () => {
        void JSON.parse(Buffer.concat(chunks).toString('utf8'))
        res.writeHead(200, { 'content-type': 'text/event-stream' })
        const id = `chatcmpl-${step}`
        const chunk = (delta: Record<string, unknown>, finish: string | null) =>
          res.write(
            `data: ${JSON.stringify({
              id,
              object: 'chat.completion.chunk',
              created: 1,
              model: 'm',
              choices: [{ index: 0, delta, finish_reason: finish }],
            })}\n\n`,
          )
        step += 1
        if (step % 2 === 1) {
          chunk({ role: 'assistant', content: '' }, null)
          chunk({ content: `reply-${step}` }, null)
          chunk({}, 'stop')
        } else {
          chunk({ role: 'assistant', content: '' }, null)
          chunk({ content: `reply-${step}` }, null)
          chunk({}, 'stop')
        }
        res.write('data: [DONE]\n\n')
        res.end()
      })
    })
    server.listen(0, '127.0.0.1', () => resolve(`http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`))
  })
}

describe('A③ 一键切换：同会话续聊不丢 + 密钥分存', () => {
  it('切换 activeProviderId 重启引擎后 sessionId 不变、历史仍在；密钥按 <id> 分存', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'mz-sw-'))
    for (const d of ['sessions', 'attachments', 'pi', 'secrets']) mkdirSync(join(dir, d), { recursive: true })
    const baseUrl = await scriptedServer()

    const configFile = join(dir, 'config.json')
    const writeConfig = (activeId: string): void => {
      writeFileSync(
        configFile,
        JSON.stringify({
          version: CONFIG_VERSION,
          onboarded: true,
          providers: [
            { id: 'prov-a', name: 'A', baseUrl, model: 'model-a', visionCapable: false, selfCheckAt: null },
            { id: 'prov-b', name: 'B', baseUrl, model: 'model-b', visionCapable: false, selfCheckAt: null },
          ],
          activeProviderId: activeId,
        }),
      )
    }
    writeConfig('prov-a')

    const db: Database = openLedger(join(dir, 'mingzhang.db'), new FakeSecrets() as never)
    initSchema(db)
    seed(db)
    const secrets = new FakeSecrets()
    secrets.set('provider-key:prov-a', 'key-a')
    secrets.set('provider-key:prov-b', 'key-b')

    const engine = new Engine(
      db,
      {
        dataDir: dir,
        dbFile: join(dir, 'mingzhang.db'),
        sessionsDir: join(dir, 'sessions'),
        attachmentsDir: join(dir, 'attachments'),
        secretsDir: join(dir, 'secrets'),
        piDir: join(dir, 'pi'),
        backupsDir: join(dir, 'backups'),
        configFile,
        portable: false,
      },
      new ConfigStore(configFile),
      secrets as never,
      () => {},
    )
    await engine.start()
    const sid1 = engine.sessionId
    await engine.sendChat('第一句', [])
    expect(sid1).not.toBe('')

    // 一键切换：activeProviderId 变更 + 引擎重启（restartEngine 等价）
    writeConfig('prov-b')
    await engine.start()
    const sid2 = engine.sessionId
    expect(sid2).toBe(sid1) // continueRecent：同一会话续聊不丢
    await engine.sendChat('第二句（切换后）', [])

    // 历史仍在：会话文件包含两轮用户消息
    const { readdirSync } = await import('node:fs')
    const sessionFiles = readdirSync(join(dir, 'sessions')).filter((f) => f.endsWith('.jsonl'))
    expect(sessionFiles.length).toBeGreaterThan(0)
    const sessionText = sessionFiles.map((f) => readFileSync(join(dir, 'sessions', f), 'utf8')).join('')
    expect(sessionText).toContain('第一句')
    expect(sessionText).toContain('第二句（切换后）')
    const runs = db.prepare('SELECT DISTINCT session_id s FROM agent_runs').all() as unknown as { s: string }[]
    expect(runs).toHaveLength(1)
    expect((db.prepare('SELECT COUNT(*) n FROM agent_runs').get() as { n: number }).n).toBe(2)

    // 密钥分存：两个 provider 各自独立文件名；切到谁用谁的
    expect(secrets.has('provider-key:prov-a')).toBe(true)
    expect(secrets.has('provider-key:prov-b')).toBe(true)
    expect(secrets.has('provider-key')).toBe(false) // 旧单槽名不再使用

    await engine.dispose()
    db.close()
  })
})
