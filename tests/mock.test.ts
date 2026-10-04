// ⑤ 离线演示（mock）测试：规则解析单测 + 真引擎全链路离线冒烟（不触网）。

import { describe, expect, it, beforeEach, afterAll } from 'vitest'
import http from 'node:http'
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import DatabaseCtor, { type Database } from 'better-sqlite3-multiple-ciphers'

import { decide, startMockServer, type MockServer } from '../src/main/mock/server'
import { Engine } from '../src/main/engine/engine'
import { ConfigStore, CONFIG_VERSION } from '../src/main/config/store'
import { openLedger, initSchema } from '../src/main/db/connection'
import { seed } from '../src/main/db/seed'
import type { ChatEvent } from '../src/shared/types'

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

describe('mock 规则解析（确定性）', () => {
  it('「星巴克 35」→ record + 咖啡', () => {
    const d = decide([{ role: 'user', content: '星巴克 35' }])
    expect(d).toMatchObject({ kind: 'tool', name: 'record', args: { amount_cents: 3500, merchant: '星巴克', category_name: '咖啡' } })
  })
  it.each([
    ['麦当劳 26', '餐饮'],
    ['肯德基 42', '餐饮'],
    ['瑞幸 12', '咖啡'],
    ['星巴克 35', '咖啡'],
    ['打车 30', '交通'],
    ['地铁 5', '交通'],
    ['超市 20', '购物'],
  ])('常见商户不再落「其他」：%s → %s', (input, cat) => {
    const d = decide([{ role: 'user', content: input }])
    expect(d).toMatchObject({ kind: 'tool', name: 'record', args: { category_name: cat } })
  })
  it('「零钱通转出 1000 到银行卡」→ transfer + to_account', () => {
    const d = decide([{ role: 'user', content: '零钱通转出 1000 到银行卡' }])
    expect(d).toMatchObject({ kind: 'tool', name: 'record', args: { tx_type: 'transfer', to_account_name: '银行卡' } })
  })
  it('「这个月餐饮花了多少」→ query 餐饮', () => {
    const d = decide([{ role: 'user', content: '这个月餐饮花了多少' }])
    expect(d).toMatchObject({ kind: 'tool', name: 'query', args: { category_name: '餐饮' } })
  })
  it('「以后星巴克都算咖啡」→ teach', () => {
    const d = decide([{ role: 'user', content: '以后星巴克都算咖啡' }])
    expect(d).toMatchObject({ kind: 'tool', name: 'teach', args: { match_merchant: '星巴克', category_name: '咖啡' } })
  })
  it('「上月月报」→ month_report；闲聊 → 引导话术', () => {
    expect(decide([{ role: 'user', content: '上月月报' }])).toMatchObject({ kind: 'tool', name: 'month_report' })
    expect(decide([{ role: 'user', content: '你好' }]).kind).toBe('text')
  })
  it('有工具结果 → 回复模板话术', () => {
    const d = decide([
      { role: 'user', content: '星巴克 35' },
      { role: 'tool', content: '已入账：交易 #1，¥35.00 · 星巴克 · 餐饮（confirmed）' },
    ])
    expect(d).toMatchObject({ kind: 'text', text: expect.stringContaining('已入账') })
  })
})

describe('mock 全链路（真引擎 + 内置假模型，离线）', () => {
  let db: Database
  let engine: Engine
  let dataDir: string
  let events: ChatEvent[]

  beforeEach(async () => {
    dataDir = mkdtempSync(join(tmpdir(), 'mz-mock-'))
    for (const d of ['sessions', 'attachments', 'pi', 'secrets']) mkdirSync(join(dataDir, d), { recursive: true })
    events = []
    db = openLedger(join(dataDir, 'mingzhang.db'), new FakeSecrets() as never)
    initSchema(db)
    seed(db)
    const configFile = join(dataDir, 'config.json')
    writeFileSync(
      configFile,
      JSON.stringify({
        version: CONFIG_VERSION,
        onboarded: true,
        mock: true,
        providers: [
          { id: 'deepseek', name: 'DeepSeek', baseUrl: 'https://api.example.invalid', model: 'x', visionCapable: false, selfCheckAt: null },
        ],
        activeProviderId: 'deepseek',
      }),
    )
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
      new FakeSecrets() as never,
      (evt) => events.push(evt),
    )
    await engine.start()
  })

  afterAll(async () => {
    await engine?.dispose()
    db?.close()
  })

  it('「麦当劳 26」离线跑通：落盘分类 ≠ 其他（= 餐饮）', async () => {
    await engine.sendChat('麦当劳 26', [])
    const row = db
      .prepare('SELECT t.amount_cents c, t.state s, t.merchant m, c.name cat FROM transactions t JOIN categories c ON c.id=t.category_id')
      .get() as { c: number; s: string; m: string; cat: string }
    expect(row.c).toBe(2600)
    expect(row.s).toBe('needs_review')
    expect(row.m).toBe('麦当劳')
    expect(row.cat).toBe('餐饮')
    expect(row.cat).not.toBe('其他')
  })

  it('「星巴克 35」离线跑通：先待确认，点击确认幂等且统计只计一次', async () => {
    await engine.sendChat('星巴克 35', [])
    const row = db
      .prepare('SELECT amount_cents c, state s, merchant m FROM transactions')
      .get() as { c: number; s: string; m: string }
    expect(row.c).toBe(3500)
    expect(row.s).toBe('needs_review')
    expect(row.m).toBe('星巴克')
    // 未点确认时统计为零；mock 不会自动调用确认入口。
    const { aggregate } = await import('../src/main/domain/queries')
    expect(aggregate(db, { metric: 'total_expense', period: 'this_month' }).totalCents).toBe(0)
    const gate = db.prepare("SELECT id, status FROM pending_clarifications WHERE field='confirm_record'").get() as { id: number; status: string }
    expect(gate.status).toBe('open')
    const tx = db.prepare('SELECT id FROM transactions').get() as { id: number }
    expect((await engine.confirmRecord(tx.id)).status).toBe('ok')
    expect((await engine.confirmRecord(tx.id)).status).toBe('already_closed')
    expect((db.prepare('SELECT status FROM pending_clarifications WHERE id=?').get(gate.id) as { status: string }).status).toBe('resolved')
    expect(aggregate(db, { metric: 'total_expense', period: 'this_month' })).toMatchObject({ totalCents: 3500, count: 1 })
    expect(db.prepare("SELECT * FROM audit_log WHERE change_type='confirm'").all()).toHaveLength(1)
    expect(db.prepare("SELECT * FROM audit_log WHERE change_type='auto_confirm'").all()).toHaveLength(0)
    // 第二轮：查询（mock 走 query 工具）
    await engine.sendChat('这个月花了多少', [])
    const q = events.filter((e) => e.type === 'tool-end').map((e) => (e.payload as { toolName?: string }).toolName)
    expect(q).toContain('query')
    expect((db.prepare('SELECT COUNT(*) n FROM transactions').get() as { n: number }).n).toBe(1)
  })

  it('② e) mock 放开附件通道：带图可解析但仍需显式确认', async () => {
    const { makeSolidColorPngBase64 } = await import('../src/main/wizard/png')
    const png = makeSolidColorPngBase64(8, 8, [10, 200, 10])
    await engine.sendChat('瑞幸 12', [{ fileName: 'pay.png', dataBase64: png, mediaType: 'image/png' }])
    console.log('EVENTS:', JSON.stringify(events.map((e) => ({ t: e.type, p: e.payload?.isError, msg: String(e.payload?.message ?? e.payload?.text ?? '').slice(0, 120) }))))
    const row = db.prepare('SELECT state s, merchant m FROM transactions').get() as { s: string; m: string }
    expect(row.s).toBe('needs_review') // mock 只免视觉软拦，不豁免单笔确认门
    expect(row.m).toBe('瑞幸')
  })

  it('mock 服务器监听 127.0.0.1 随机端口、可关闭', async () => {
    const s: MockServer = await startMockServer()
    expect(s.port).toBeGreaterThan(0)
    const body = JSON.stringify({ messages: [{ role: 'user', content: '星巴克 12' }] })
    const reply: string = await new Promise((resolve, reject) => {
      const req = http.request(
        { host: '127.0.0.1', port: s.port, path: '/v1/chat/completions', method: 'POST', headers: { 'content-type': 'application/json' } },
        (res) => {
          let data = ''
          res.on('data', (c) => (data += String(c)))
          res.on('end', () => resolve(data))
        },
      )
      req.on('error', reject)
      req.end(body)
    })
    expect(reply).toContain('record')
    expect(reply).toContain('1200')
    await s.close()
  })
})
