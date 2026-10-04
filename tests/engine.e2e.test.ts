// 引擎端到端（脚本化）：本地 OpenAI 兼容 SSE 服务器按剧本返回工具调用与文本，
// 驱动真实 pi 会话 + 真实工具 + 真实加密账本。不依赖 Electron（SecretsStore 用测试桩）。

import { describe, expect, it, beforeEach, afterAll } from 'vitest'
import http from 'node:http'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { AddressInfo } from 'node:net'
import DatabaseCtor, { type Database } from 'better-sqlite3-multiple-ciphers'

import { Engine } from '../src/main/engine/engine'
import { ConfigStore, CONFIG_VERSION } from '../src/main/config/store'
import { openLedger, initSchema } from '../src/main/db/connection'
import { seed } from '../src/main/db/seed'
import { makeSolidColorPngBase64 } from '../src/main/wizard/png'
import { GATE_FIELDS } from '../src/main/domain/pending'
import type { ChatEvent } from '../src/shared/types'

// SecretsStore 结构桩（测试专用：明文落临时目录；生产 safeStorage 版在 Electron 内另行验证）
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

// ---------- 脚本化 OpenAI 兼容服务器 ----------

interface ScriptedStep {
  kind: 'text' | 'tool'
  text?: string
  tool?: { name: string; args: Record<string, unknown> }
}

function sse(res: http.ServerResponse, obj: unknown): void {
  res.write(`data: ${JSON.stringify(obj)}\n\n`)
}

function chunkObj(id: string, model: string, delta: Record<string, unknown>, finish: string | null) {
  return {
    id,
    object: 'chat.completion.chunk',
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [{ index: 0, delta, finish_reason: finish }],
  }
}

function createScriptedServer(script: ScriptedStep[], captured: unknown[]): Promise<string> {
  let step = 0
  return new Promise((resolvePort) => {
    const server = http.createServer((req, res) => {
      const chunks: Buffer[] = []
      req.on('data', (c: Buffer) => chunks.push(c))
      req.on('end', () => {
        captured.push(JSON.parse(Buffer.concat(chunks).toString('utf8')))
        res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' })
        const id = `chatcmpl-${step}`
        const current = script[Math.min(step, script.length - 1)]
        step += 1
        if (current.kind === 'tool') {
          sse(res, chunkObj(id, 'mock-model', { role: 'assistant', content: null }, null))
          sse(
            res,
            chunkObj(id, 'mock-model', {
              tool_calls: [{ index: 0, type: 'function', id: `call_${step}`, function: { name: current.tool!.name, arguments: '' } }],
            }, null),
          )
          sse(
            res,
            chunkObj(id, 'mock-model', {
              tool_calls: [{ index: 0, function: { arguments: JSON.stringify(current.tool!.args) } }],
            }, null),
          )
          sse(res, chunkObj(id, 'mock-model', {}, 'tool_calls'))
        } else {
          const text = current.text ?? '好的。'
          sse(res, chunkObj(id, 'mock-model', { role: 'assistant', content: '' }, null))
          for (const piece of text.match(/.{1,8}/gs) ?? []) {
            sse(res, chunkObj(id, 'mock-model', { content: piece }, null))
          }
          sse(res, chunkObj(id, 'mock-model', {}, 'stop'))
        }
        res.write('data: [DONE]\n\n')
        res.end()
      })
    })
    server.listen(0, '127.0.0.1', () => resolvePort(`http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`))
  })
}

// ---------- 测试本体 ----------

let db: Database
let engine: Engine
let dataDir: string
let configFile: string
let events: ChatEvent[]
let captured: unknown[]
let baseUrl: string
let testSecrets: FakeSecrets
const script: ScriptedStep[] = []

function queue(step: ScriptedStep): void {
  script.push(step)
}

beforeEach(async () => {
  dataDir = mkdtempSync(join(tmpdir(), 'mz-e2e-'))
  for (const d of ['sessions', 'attachments', 'pi', 'secrets']) {
    mkdirSync(join(dataDir, d), { recursive: true })
  }
  captured = []
  events = []
  script.length = 0
  baseUrl = await createScriptedServer(script, captured)

  db = openLedger(join(dataDir, 'mingzhang.db'), new FakeSecrets(join(dataDir, 'secrets')) as never)
  initSchema(db)
  seed(db)

  configFile = join(dataDir, 'config.json')
  writeFileSync(
    configFile,
    JSON.stringify({
      version: CONFIG_VERSION,
      onboarded: true,
      providers: [
        { id: 'mocklocal', name: 'Mock', baseUrl, model: 'mock-model', visionCapable: true, selfCheckAt: null },
      ],
      activeProviderId: 'mocklocal',
    }),
  )

  const paths = {
    dataDir,
    dbFile: join(dataDir, 'mingzhang.db'),
    sessionsDir: join(dataDir, 'sessions'),
    attachmentsDir: join(dataDir, 'attachments'),
    secretsDir: join(dataDir, 'secrets'),
    piDir: join(dataDir, 'pi'),
    backupsDir: join(dataDir, 'backups'),
    configFile,
    portable: false,
  }
  testSecrets = new FakeSecrets(join(dataDir, 'secrets'))
  testSecrets.set('provider-key:mocklocal', 'test-key-not-secret')
  engine = new Engine(
    db,
    paths,
    new ConfigStore(configFile),
    testSecrets as never,
    (evt) => events.push(evt),
  )
  await engine.start()
})

afterAll(async () => {
  await engine?.dispose()
  db?.close()
})

const txCount = (): number => (db.prepare('SELECT COUNT(*) n FROM transactions').get() as { n: number }).n

describe('引擎端到端（脚本化模型）', () => {
  it('E4 工具面断言：运行时可见工具恰为账务工具，内置工具全关', () => {
    const names = engine.visibleToolNames().sort()
    expect(names).toEqual([
      'accounts', 'apply_bill', 'classify_batch', 'classify_suggest', 'commit_batch', 'delete', 'list_bills',
      'month_report', 'pending', 'query', 'read_bill', 'record', 'restore', 'split', 'teach', 'update',
    ])
    expect(names).not.toContain('bash')
    expect(names).not.toContain('read')
    expect(names).not.toContain('write')
    expect(names).not.toContain('edit')
    expect(names).not.toContain('grep')
  })

  it('「星巴克 35」→ record 落库 → needs_review 确认门卡片', async () => {
    queue({ kind: 'tool', tool: { name: 'record', args: { amount_cents: 3500, tx_type: 'expense', merchant: '星巴克', category_name: '餐饮', confidence: 0.95 } } })
    queue({ kind: 'text', text: '记好了：¥35.00 · 星巴克 · 餐饮。' })

    await engine.sendChat('星巴克 35', [])

    const row = db
      .prepare('SELECT t.amount_cents c, t.state s, t.merchant m, c.name cat, a.name acc FROM transactions t' +
        ' JOIN categories c ON c.id=t.category_id JOIN accounts a ON a.id=t.account_id')
      .get() as { c: number; s: string; m: string; cat: string; acc: string }
    expect(row.c).toBe(3500)
    expect(row.s).toBe('needs_review')
    expect(row.m).toBe('星巴克')
    expect(row.cat).toBe('餐饮')
    expect(row.acc).toBe('现金') // 默认账户回落

    // 审计链完整（R3）
    const chain = (
      db.prepare("SELECT change_type c FROM audit_log WHERE entity_type='transaction' ORDER BY id").all() as { c: string }[]
    ).map((r) => r.c)
    expect(chain).toEqual(['create', 'parse', 'request_review'])

    // imports + agent_runs 落库
    expect((db.prepare("SELECT COUNT(*) n FROM imports WHERE source_type='text'").get() as { n: number }).n).toBe(1)
    const run = db.prepare('SELECT status s, tool_calls t FROM agent_runs').get() as { s: string; t: string }
    expect(run.s).toBe('success')
    expect(run.t).toContain('record')

    // 事件里有卡片
    const toolEnd = events.find((e) => e.type === 'tool-end') as { payload: { details: { card: { tx: { state: string; amountCents: number } } } } } | undefined
    expect(toolEnd?.payload.details.card.tx.state).toBe('needs_review')
    expect(toolEnd?.payload.details.card.tx.amountCents).toBe(3500)
  })

  it('「这个月餐饮花了多少」→ query 聚合（代码算数）', async () => {
    // 先落一笔
    queue({ kind: 'tool', tool: { name: 'record', args: { amount_cents: 3500, tx_type: 'expense', merchant: '星巴克', category_name: '餐饮', confidence: 0.95 } } })
    queue({ kind: 'text', text: 'ok' })
    await engine.sendChat('星巴克 35', [])
    // 查询用例仍验证已确认账的原金额：显式点击既有确认入口。
    queue({ kind: 'text', text: '已确认入账。' })
    expect((await engine.confirmRecord(1)).status).toBe('ok')

    queue({ kind: 'tool', tool: { name: 'query', args: { metric: 'total_expense', period: 'this_month', category_name: '餐饮' } } })
    queue({ kind: 'text', text: '这个月餐饮花了 35 元。' })
    await engine.sendChat('这个月餐饮花了多少', [])

    const toolEnds = events.filter((e) => e.type === 'tool-end') as { payload: { details: { card?: { totalCents?: number; categoryName?: string | null } } } }[]
    const q = toolEnds.map((t) => t.payload.details.card).find((c) => c && 'totalCents' in c)
    expect(q?.totalCents).toBe(3500)
    expect(txCount()).toBe(1) // 查询不写交易
  })

  it('低置信度 → needs_review 待确认 → UI 确认（确认门桥）', async () => {
    queue({ kind: 'tool', tool: { name: 'record', args: { amount_cents: 4200, tx_type: 'expense', merchant: '无名小店', confidence: 0.5 } } })
    queue({ kind: 'text', text: '分类没把握，请在卡片上确认。' })
    await engine.sendChat('记一笔 42 元', [])

    const row = db.prepare('SELECT id, state FROM transactions').get() as { id: number; state: string }
    expect(row.state).toBe('needs_review')
    const pending = db.prepare("SELECT id, status FROM pending_clarifications WHERE field='confirm_record'").get() as { id: number; status: string }
    expect(pending.status).toBe('open')

    queue({ kind: 'text', text: '已确认入账。' })
    // 无分类的支出必须带分类确认（DDL：confirmed 的支出需分类）；分类由 UI 下拉给出
    await engine.confirmRecord(row.id, '餐饮')

    expect((db.prepare('SELECT state s FROM transactions WHERE id=?').get(row.id) as { s: string }).s).toBe('confirmed')
    expect((db.prepare('SELECT status s FROM pending_clarifications WHERE id=?').get(pending.id) as { s: string }).s).toBe('resolved')
    const lastAudit = db
      .prepare("SELECT change_type c, changed_by b FROM audit_log WHERE entity_type='transaction' ORDER BY id DESC LIMIT 1")
      .get() as { c: string; b: string }
    expect(lastAudit.c).toBe('confirm')
    expect(lastAudit.b).toBe('user')
  })

  it('截图链路：图片直进对话 + imports 记 screenshot', async () => {
    const png = makeSolidColorPngBase64(16, 16, [220, 38, 38])
    queue({ kind: 'tool', tool: { name: 'record', args: { amount_cents: 2300, tx_type: 'expense', merchant: '瑞幸咖啡', category_name: '餐饮', confidence: 0.93 } } })
    queue({ kind: 'text', text: '记好了 ¥23。' })
    await engine.sendChat('帮我记一下这笔', [{ fileName: 'pay.png', dataBase64: png, mediaType: 'image/png' }])

    // 模型收到的请求体里带 image_url（多模态直看）
    const withImage = captured.find((b) => JSON.stringify(b).includes('image_url')) as Record<string, unknown> | undefined
    expect(withImage).toBeTruthy()
    expect(JSON.stringify(withImage)).toContain('data:image/png;base64')

    expect((db.prepare("SELECT COUNT(*) n FROM imports WHERE source_type='screenshot'").get() as { n: number }).n).toBe(1)
    expect((db.prepare('SELECT state s FROM transactions').get() as { s: string }).s).toBe('needs_review')
  })

  it('会话落自定义目录 + 模型清单落 pi/（~/.pi 零接触由 app 层测试另证）', async () => {
    queue({ kind: 'text', text: '在的。' })
    await engine.sendChat('你好', [])
    expect(existsSync(join(dataDir, 'sessions'))).toBe(true)
    const files = readdirSync(join(dataDir, 'sessions'))
    expect(files.some((f) => f.endsWith('.jsonl'))).toBe(true)
    expect(JSON.parse(readFileSync(join(dataDir, 'pi', 'models.json'), 'utf8')).providers.mocklocal.models[0].id).toBe('mock-model')
  })

  it('M1 teach不写规则；界面显式保存后再记账命中规则', async () => {
    queue({ kind: 'tool', tool: { name: 'teach', args: { action: 'set_category', match_merchant: '星巴克', category_name: '咖啡' } } })
    queue({ kind: 'text', text: '学会了。' })
    await engine.sendChat('以后星巴克都算咖啡', [])
    expect(db.prepare('SELECT * FROM rules').all()).toHaveLength(0)
    const { createTransaction, requestReview } = await import('../src/main/domain/ledger')
    const { prepareClassify, applyClassify } = await import('../src/main/domain/classify')
    const { saveCategoryRule } = await import('../src/main/domain/category-rules')
    const tx = createTransaction(db, { amountCents: 100, txType: 'expense', merchant: '星巴克咖啡(太和店)' })
    requestReview(db, tx, { reason: '合成显式来源' })
    const gate = prepareClassify(db, { sessionId: 'ui', assignments: [{ groupKey: 'expense::星巴克咖啡(太和店)', categoryName: '咖啡' }] })
    applyClassify(db, gate.gateId)
    const categoryId = (db.prepare("SELECT id FROM categories WHERE name='咖啡'").get() as { id: number }).id
    saveCategoryRule(db, { requestId: 'engine-explicit-save', gateId: gate.gateId, groupKey: 'expense::星巴克咖啡(太和店)', categoryId, expectedRules: [], replaceConflicts: false })
    const rule = db.prepare('SELECT id, hit_count FROM rules').get() as { id: number; hit_count: number }
    expect(rule.hit_count).toBe(0)

    queue({ kind: 'tool', tool: { name: 'record', args: { amount_cents: 3500, tx_type: 'expense', merchant: '星巴克咖啡(太和店)', confidence: 0.95 } } })
    queue({ kind: 'text', text: '记好了，命中规则。' })
    await engine.sendChat('星巴克 35', [])
    const row = db
      .prepare('SELECT t.state s, c.name cat FROM transactions t JOIN categories c ON c.id=t.category_id ORDER BY t.id DESC LIMIT 1')
      .get() as { s: string; cat: string }
    expect(row.s).toBe('needs_review')
    expect(row.cat).toBe('咖啡') // 规则自动落的分类（预置分类里没有"咖啡"）
    expect((db.prepare('SELECT hit_count FROM rules WHERE id=?').get(rule.id) as { hit_count: number }).hit_count).toBe(1)
    const toolEnd = events.filter((e) => e.type === 'tool-end').at(-1) as { payload: { details: { card: { ruleHit: { ruleId: number } | null } } } }
    expect(toolEnd.payload.details.card.ruleHit?.ruleId).toBe(rule.id)
    // 规则命中审计（changed_by=rule_engine）
    const hitAudit = db
      .prepare("SELECT COUNT(*) n FROM audit_log WHERE entity_type='rule' AND changed_by='rule_engine'")
      .get() as { n: number }
    expect(hitAudit.n).toBe(1)
  })

  it('M1 删除两段式：gate 未决不删账 → UI 确认后软删 + 可恢复', async () => {
    // 落一笔
    queue({ kind: 'tool', tool: { name: 'record', args: { amount_cents: 5000, tx_type: 'expense', merchant: '书店', category_name: '购物', confidence: 0.9 } } })
    queue({ kind: 'text', text: 'ok' })
    await engine.sendChat('书店 50', [])
    queue({ kind: 'text', text: '已确认入账。' })
    expect((await engine.confirmRecord(1)).status).toBe('ok')

    // 模型调 delete：只生成 gate，不执行
    queue({ kind: 'tool', tool: { name: 'delete', args: { tx_id: 1 } } })
    queue({ kind: 'text', text: '请在界面上确认删除。' })
    await engine.sendChat('删掉这笔', [])
    const gate = db
      .prepare("SELECT id, status FROM pending_clarifications WHERE field='delete_confirm'")
      .get() as { id: number; status: string }
    expect(gate.status).toBe('open')
    expect((db.prepare('SELECT state s FROM transactions WHERE id=1').get() as { s: string }).s).not.toBe('deleted')

    // UI 确认按钮 → 域层执行
    queue({ kind: 'text', text: '已删除。' })
    await engine.confirmGate(gate.id)
    expect((db.prepare('SELECT state s FROM transactions WHERE id=1').get() as { s: string }).s).toBe('deleted')
    const delAudit = db
      .prepare("SELECT changed_by b FROM audit_log WHERE change_type='delete' ORDER BY id DESC LIMIT 1")
      .get() as { b: string }
    expect(delAudit.b).toBe('user') // 确认信号只认 UI 按钮：执行者必为 user

    // 恢复
    queue({ kind: 'tool', tool: { name: 'restore', args: { tx_id: 1 } } })
    queue({ kind: 'text', text: '已恢复。' })
    await engine.sendChat('恢复刚才删的', [])
    expect((db.prepare('SELECT state s FROM transactions WHERE id=1').get() as { s: string }).s).toBe('confirmed')
  })

  it('M1 拆账：金额和不符拒绝；正确拆分 = 原笔软删 + 子项 confirmed', async () => {
    queue({ kind: 'tool', tool: { name: 'record', args: { amount_cents: 10000, tx_type: 'expense', merchant: '超市', category_name: '购物', confidence: 0.9 } } })
    queue({ kind: 'text', text: 'ok' })
    await engine.sendChat('超市 100', [])

    // 错误拆分 → 工具抛错（isError），账目不变
    queue({ kind: 'tool', tool: { name: 'split', args: { tx_id: 1, items: [{ amount_cents: 6000 }, { amount_cents: 3000 }] } } })
    queue({ kind: 'text', text: '拆分金额对不上，请确认。' })
    await engine.sendChat('拆成 60 + 30', [])
    const errEnd = events.filter((e) => e.type === 'tool-end').at(-1) as { payload: { isError: boolean } }
    expect(errEnd.payload.isError).toBe(true)
    expect(txCount()).toBe(1)

    // 正确拆分
    queue({ kind: 'tool', tool: { name: 'split', args: { tx_id: 1, items: [{ amount_cents: 6000, category_name: '餐饮' }, { amount_cents: 4000, category_name: '购物' }] } } })
    queue({ kind: 'text', text: '拆好了。' })
    await engine.sendChat('拆成 60 餐饮 + 40 购物', [])
    expect(txCount()).toBe(3)
    expect((db.prepare("SELECT state s FROM transactions WHERE id=1").get() as { s: string }).s).toBe('deleted')
    const subs = db.prepare("SELECT id, state, amount_cents c FROM transactions WHERE id>1 ORDER BY id").all() as unknown as { id: number; state: string; c: number }[]
    expect(subs.map((r) => [r.state, r.c])).toEqual([['confirmed', 6000], ['confirmed', 4000]])
  })

  it('M1 update：改分类留 before→after 审计', async () => {
    queue({ kind: 'tool', tool: { name: 'record', args: { amount_cents: 3500, tx_type: 'expense', merchant: '星巴克', category_name: '餐饮', confidence: 0.95 } } })
    queue({ kind: 'text', text: 'ok' })
    await engine.sendChat('星巴克 35', [])
    queue({ kind: 'tool', tool: { name: 'update', args: { tx_id: 1, category_name: '交通' } } })
    queue({ kind: 'text', text: '已改成交通。' })
    await engine.sendChat('这笔改成交通', [])
    const row = db
      .prepare('SELECT c.name cat FROM transactions t JOIN categories c ON c.id=t.category_id WHERE t.id=1')
      .get() as { cat: string }
    expect(row.cat).toBe('交通')
    const upd = db
      .prepare("SELECT before_value b, after_value a FROM audit_log WHERE change_type='update' AND entity_type='transaction'")
      .get() as { b: string; a: string }
    expect(JSON.parse(upd.b).category_id).not.toBe(JSON.parse(upd.a).category_id)
  })

  it('M2 accounts：list/add/rename 走审计', async () => {
    queue({ kind: 'tool', tool: { name: 'accounts', args: { action: 'add', name: '零钱通', type: 'wechat' } } })
    queue({ kind: 'text', text: '加好了。' })
    await engine.sendChat('加一个零钱通账户', [])
    const acc = db.prepare("SELECT id, type FROM accounts WHERE name='零钱通'").get() as { id: number; type: string }
    expect(acc.type).toBe('wechat')
    const audit = db
      .prepare("SELECT change_type c FROM audit_log WHERE entity_type='account' AND entity_id=?")
      .get(acc.id) as { c: string }
    expect(audit.c).toBe('create')

    queue({ kind: 'tool', tool: { name: 'accounts', args: { action: 'rename', name: '零钱通', new_name: '微信零钱通' } } })
    queue({ kind: 'text', text: '改好了。' })
    await engine.sendChat('把零钱通改名叫微信零钱通', [])
    expect(db.prepare("SELECT COUNT(*) n FROM accounts WHERE name='零钱通'").get() as { n: number }).toMatchObject({ n: 0 })
  })

  it('M2 month_report：模板生成、空月如实说明、不写审计', async () => {
    const prevMonth = new Date()
    prevMonth.setMonth(prevMonth.getMonth() - 1)
    const mm = `${prevMonth.getFullYear()}-${String(prevMonth.getMonth() + 1).padStart(2, '0')}`
    const accId = (db.prepare("SELECT id FROM accounts WHERE name='现金'").get() as { id: number }).id
    // 上月两笔支出
    db.prepare(
      "INSERT INTO transactions (account_id, category_id, amount_cents, type, occurred_at, state, merchant, source_message_id, created_at, updated_at)" +
        " VALUES (?, 1, 5000, 'expense', ?, 'confirmed', '面馆', 'seed', '2020-01-01T00:00:00+08:00', '2020-01-01T00:00:00+08:00')",
    ).run(accId, `${mm}-05T12:00:00+08:00`)
    db.prepare(
      "INSERT INTO transactions (account_id, category_id, amount_cents, type, occurred_at, state, merchant, source_message_id, created_at, updated_at)" +
        " VALUES (?, 1, 3000, 'expense', ?, 'confirmed', '早餐', 'seed', '2020-01-01T00:00:00+08:00', '2020-01-01T00:00:00+08:00')",
    ).run(accId, `${mm}-06T12:00:00+08:00`)

    queue({ kind: 'tool', tool: { name: 'month_report', args: {} } })
    queue({ kind: 'text', text: '这是上月的月报。' })
    await engine.sendChat('上月月报', [])
    const toolEnd = events.filter((e) => e.type === 'tool-end').at(-1) as { payload: { details: { card: { kind: string; text: string; totalExpenseCents: number } } } }
    expect(toolEnd.payload.details.card.kind).toBe('report')
    expect(toolEnd.payload.details.card.totalExpenseCents).toBe(8000)
    expect(toolEnd.payload.details.card.text).toContain('月报')
    // A7 落库纪律：月报不写 audit_log
    const n = db.prepare('SELECT COUNT(*) n FROM audit_log WHERE changed_at > ?').get('2020-01-02') as { n: number }
    expect(n.n).toBe(0)
  })

  it('M2 启动月报检查：有数据的上月自动补生成（幂等）；空月不生成', () => {
    const prevMonth = new Date()
    prevMonth.setMonth(prevMonth.getMonth() - 1)
    const mm = `${prevMonth.getFullYear()}-${String(prevMonth.getMonth() + 1).padStart(2, '0')}`
    const accId = (db.prepare("SELECT id FROM accounts WHERE name='现金'").get() as { id: number }).id
    db.prepare(
      "INSERT INTO transactions (account_id, category_id, amount_cents, type, occurred_at, state, merchant, source_message_id, created_at, updated_at)" +
        " VALUES (?, 1, 2000, 'expense', ?, 'confirmed', '面馆', 'seed', '2020-01-01T00:00:00+08:00', '2020-01-01T00:00:00+08:00')",
    ).run(accId, `${mm}-05T12:00:00+08:00`)

    const r1 = engine.startupReport()
    expect(r1).not.toBeNull()
    const run = db
      .prepare("SELECT trigger, status FROM agent_runs WHERE trigger='scheduled'")
      .get() as { trigger: string; status: string }
    expect(run.status).toBe('success')
    const r2 = engine.startupReport()
    expect(r2).toBeNull() // 幂等

    // 空月：清标记后、把数据移到更早月份 → 不生成
    db.prepare("DELETE FROM settings WHERE key LIKE 'report_generated_%'").run()
    db.prepare("DELETE FROM agent_runs WHERE trigger='scheduled'").run()
    const r3 = engine.startupReport(new Date('2030-06-15'))
    expect(r3).toBeNull()
  })

  it('M2 pending answer：新单笔补答不能入账；对删除 gate 拒绝作答', async () => {
    // 低置信度 → confirm_record
    queue({ kind: 'tool', tool: { name: 'record', args: { amount_cents: 4200, tx_type: 'expense', merchant: '无名小店', confidence: 0.5 } } })
    queue({ kind: 'text', text: '分类没把握。' })
    await engine.sendChat('记一笔 42 元', [])
    const pend = db
      .prepare("SELECT id, tx_id FROM pending_clarifications WHERE field='confirm_record'")
      .get() as { id: number; tx_id: number }
    queue({ kind: 'tool', tool: { name: 'pending', args: { action: 'answer', gate_id: pend.id, answer: '餐饮' } } })
    queue({ kind: 'text', text: '请在界面选择分类后确认。' })
    await engine.sendChat('是餐饮', [])
    const answerEnd = events.filter((e) => e.type === 'tool-end').at(-1) as { payload: { isError: boolean } }
    expect(answerEnd.payload.isError).toBe(true)
    expect((db.prepare('SELECT state FROM transactions WHERE id=?').get(pend.tx_id) as { state: string }).state).toBe('needs_review')
    expect((db.prepare('SELECT status FROM pending_clarifications WHERE id=?').get(pend.id) as { status: string }).status).toBe('open')
    queue({ kind: 'text', text: '已确认入账。' })
    expect((await engine.confirmRecord(pend.tx_id, '餐饮')).status).toBe('ok')
    const row = db
      .prepare('SELECT t.state s, c.name cat FROM transactions t JOIN categories c ON c.id=t.category_id WHERE t.id=?')
      .get(pend.tx_id) as { s: string; cat: string }
    expect(row.s).toBe('confirmed')
    expect(row.cat).toBe('餐饮')

    // 删除 gate 拒绝对话作答
    queue({ kind: 'tool', tool: { name: 'delete', args: { tx_id: 1 } } })
    queue({ kind: 'text', text: '请在界面确认。' })
    await engine.sendChat('删掉这笔', [])
    const gate = db
      .prepare("SELECT id FROM pending_clarifications WHERE field='delete_confirm'")
      .get() as { id: number }
    queue({ kind: 'tool', tool: { name: 'pending', args: { action: 'answer', gate_id: gate.id, answer: '确认' } } })
    queue({ kind: 'text', text: '被拒绝了。' })
    await engine.sendChat('确认', [])
    const errEnd = events.filter((e) => e.type === 'tool-end').at(-1) as { payload: { isError: boolean } }
    expect(errEnd.payload.isError).toBe(true)
    expect((db.prepare('SELECT state s FROM transactions WHERE id=1').get() as { s: string }).s).not.toBe('deleted')
  })

  it('M3 批次：混合批次逐项交代 + 缺金额转待收尾 + 批次收口', async () => {
    const csv = [
      '交易时间,商户,金额,订单号',
      '2026-09-01 10:00,便利店,12.50,ORD-001',
      '2026-09-02 11:00,面馆,23.00,ORD-002',
      '2026-09-03 12:00,信息不全的条目,,ORD-003',
    ].join('\n')
    queue({
      kind: 'tool',
      tool: {
        name: 'commit_batch',
        args: {
          source_type: 'csv',
          channel: '支付宝',
          items: [
            { amount_cents: 1250, tx_type: 'expense', merchant: '便利店', reliable_id: 'ORD-001', occurred_at: '2026-09-01T10:00:00+08:00' },
            { amount_cents: 2300, tx_type: 'expense', merchant: '面馆', reliable_id: 'ORD-002', occurred_at: '2026-09-02T11:00:00+08:00' },
            { merchant: '信息不全的条目', reliable_id: 'ORD-003', source_text: '2026-09-03 12:00,信息不全的条目,,ORD-003' },
          ],
        },
      },
    })
    queue({ kind: 'text', text: '批次已生成，请在界面确认。' })
    await engine.sendChat(`拖入了一份账单：
${csv}`, [])
    expect(txCount()).toBe(0) // 未确认前不落账
    const gate = db
      .prepare("SELECT id, payload FROM pending_clarifications WHERE field='batch_confirm'")
      .get() as { id: number; payload: string }
    const plan = JSON.parse(gate.payload).plan
    expect(plan.newCount).toBe(2)
    expect(plan.unparsedCount).toBe(1)

    // UI 确认 → 执行
    queue({ kind: 'text', text: '批次处理完成。' })
    await engine.confirmGate(gate.id)
    expect(txCount()).toBe(2)
    const imp = db.prepare("SELECT status FROM imports WHERE source_type='csv'").get() as { status: string }
    expect(imp.status).toBe('pending') // 有缺金额项未办结
    const kept = db
      .prepare("SELECT COUNT(*) n FROM pending_clarifications WHERE field='batch_item' AND status='open'")
      .get() as { n: number }
    expect(kept.n).toBe(1)

    // 补答金额 → 入账 + 批次收口
    const item = db
      .prepare("SELECT id FROM pending_clarifications WHERE field='batch_item' AND status='open'")
      .get() as { id: number }
    queue({ kind: 'tool', tool: { name: 'pending', args: { action: 'answer', gate_id: item.id, answer: '15 餐饮' } } })
    queue({ kind: 'text', text: '补上了。' })
    await engine.sendChat('那笔是 15 块，餐饮', [])
    expect(txCount()).toBe(3)
    const imp2 = db.prepare("SELECT status FROM imports WHERE source_type='csv'").get() as { status: string }
    expect(imp2.status).toBe('confirmed') // 全部办结才收口
  })

  it('M3 去重：同渠道同交易号跨批只计一次；同商户同金额不同号不合并；gate 不可重复执行', async () => {
    const batch = (orderId: string) => ({
      kind: 'tool' as const,
      tool: {
        name: 'commit_batch',
        args: {
          source_type: 'csv',
          channel: '支付宝',
          items: [{ amount_cents: 2300, tx_type: 'expense', merchant: '面馆', reliable_id: orderId }],
        },
      },
    })
    // 第一批
    queue(batch('ORD-A'))
    queue({ kind: 'text', text: '请确认。' })
    await engine.sendChat('账单一', [])
    const gate1 = db.prepare("SELECT id FROM pending_clarifications WHERE field='batch_confirm'").get() as { id: number }
    queue({ kind: 'text', text: 'done' })
    await engine.confirmGate(gate1.id)
    expect(txCount()).toBe(1)

    // 第二批：同订单号 → duplicate；不同订单号同商户同金额 → new
    queue({
      kind: 'tool',
      tool: {
        name: 'commit_batch',
        args: {
          source_type: 'csv',
          channel: '支付宝',
          items: [
            { amount_cents: 2300, tx_type: 'expense', merchant: '面馆', reliable_id: 'ORD-A' },
            { amount_cents: 2300, tx_type: 'expense', merchant: '面馆', reliable_id: 'ORD-B' },
          ],
        },
      },
    })
    queue({ kind: 'text', text: '请确认第二批。' })
    await engine.sendChat('账单二（含一笢单号重复 + 一笔相似的新交易）', [])
    const gate2 = db
      .prepare("SELECT id, payload FROM pending_clarifications WHERE field='batch_confirm' ORDER BY id DESC LIMIT 1")
      .get() as { id: number; payload: string }
    const plan = JSON.parse(gate2.payload).plan
    expect(plan.newCount).toBe(1) // 相似项不合并、仍入账
    expect(plan.duplicateCount).toBe(1) // 同号幂等
    queue({ kind: 'text', text: 'done' })
    await engine.confirmGate(gate2.id)
    expect(txCount()).toBe(2)

    // C7：已关闭的 gate 再次确认无效——返回语义化 already_closed（不再是静默 false）
    const again = await engine.confirmGate(gate1.id)
    expect(again.status).toBe('already_closed')
    expect(txCount()).toBe(2)
  })

  it('② 视觉软拦：未自检模型的图片来源强制进待确认（不自动确认）', async () => {
    // 换一个未过视觉自检的 provider 并重启引擎
    writeFileSync(
      configFile,
      JSON.stringify({
        version: CONFIG_VERSION,
        onboarded: true,
        providers: [
          { id: 'novision', name: 'NoVision', baseUrl, model: 'mock-model', visionCapable: false, selfCheckAt: null },
        ],
        activeProviderId: 'novision',
      }),
    )
    testSecrets.set('provider-key:novision', 'test-key-not-secret')
    await engine.start()

    const png = makeSolidColorPngBase64(8, 8, [30, 30, 220])
    queue({ kind: 'tool', tool: { name: 'record', args: { amount_cents: 1800, tx_type: 'expense', merchant: '截图店', category_name: '餐饮', confidence: 0.98 } } })
    queue({ kind: 'text', text: '请在界面确认。' })
    await engine.sendChat('记一下截图这笔', [{ fileName: 'pay.png', dataBase64: png, mediaType: 'image/png' }])
    const row = db.prepare('SELECT state s FROM transactions').get() as { s: string }
    expect(row.s).toBe('needs_review') // 高置信也拦：图片来源未自检
    const review = db
      .prepare('SELECT question q FROM pending_clarifications WHERE field=? ORDER BY id DESC LIMIT 1')
      .get('confirm_record') as { q: string }
    expect(review.q).toContain('视觉自检')
  })

  it('GATE_FIELDS 常量：gate 类 pending 不允许对话补答（域层约束的实现锚点）', () => {
    expect([...GATE_FIELDS].sort()).toEqual(['batch_classify', 'batch_confirm', 'delete_confirm'])
  })
})

// ---------------------------------------------------------------------------
// T0927-1610：一轮的收尾信号（user-message 回显 / turn-end 收尾）。
//
// ChatEvent 的联合类型里早就有这两个事件，引擎这前**从不广播**——后果是面板只看
// 得见"自己发出去"的消息（速记行发的那句在面板流里没有用户气泡），而一轮的收尾
// 只能靠 agent-end 猜（超时轮连它都没有）。本段锁住"引擎真的广播、且广播得准"：
//   ① 轮开始恰好一次回显（text 逐字、hasImage 如实）；
//   ② 正常轮收尾恰好一次、且是这一轮最后一个事件；
//   ③ 抛错轮同样有回显与收尾。
// 超时轮那一条放在 tests/turn-timeout.test.ts（那套假 provider 脚手架就在那儿，
// 不为了"放在一起"去重构它）。
// ---------------------------------------------------------------------------
describe('一轮的收尾信号（user-message / turn-end）', () => {
  const typeSeq = (): string[] => events.map((e) => e.type)

  it('轮开始有回显：user-message 恰好一次，text 逐字、hasImage 如实', async () => {
    queue({ kind: 'text', text: '记好了：¥35.00。' })
    await engine.sendChat('星巴克 35', [])

    const echoes = events.filter((e) => e.type === 'user-message') as { payload: { text: string; hasImage: boolean } }[]
    expect(echoes.length, `这一轮没有广播用户消息回显（事件序列：${JSON.stringify(typeSeq())}）`).toBe(1)
    expect(echoes[0].payload.text).toBe('星巴克 35')
    expect(echoes[0].payload.hasImage).toBe(false)

    // 带图那轮：hasImage 必须为 true（截图直进对话那条链路）
    const png = makeSolidColorPngBase64(8, 8, [30, 30, 220])
    queue({ kind: 'text', text: '看到了。' })
    await engine.sendChat('  帮我记一下这张  ', [{ fileName: 'pay.png', dataBase64: png, mediaType: 'image/png' }])

    const echoes2 = events.filter((e) => e.type === 'user-message') as { payload: { text: string; hasImage: boolean } }[]
    expect(echoes2.length, '两轮之后回显应当恰好两条').toBe(2)
    expect(echoes2[1].payload.text, '回显的 text 必须是入参原文（不许 trim、不许改写）').toBe('  帮我记一下这张  ')
    expect(echoes2[1].payload.hasImage).toBe(true)
  })

  it('收尾恰好一次且排最后：turn-end 只来一次，且是这一轮最后一个事件', async () => {
    queue({ kind: 'tool', tool: { name: 'record', args: { amount_cents: 3500, tx_type: 'expense', merchant: '星巴克', category_name: '餐饮', confidence: 0.95 } } })
    queue({ kind: 'text', text: '记好了。' })
    await engine.sendChat('星巴克 35', [])

    const types = typeSeq()
    expect(types.filter((t) => t === 'turn-end').length, `turn-end 次数不对（事件序列：${JSON.stringify(types)}）`).toBe(1)
    expect(types.indexOf('agent-end'), '这一轮没有 agent-end').toBeGreaterThanOrEqual(0)
    expect(types.indexOf('agent-end'), 'agent-end 必须排在 turn-end 之前').toBeLessThan(types.length - 1)
    expect(types[types.length - 1], 'turn-end 之后不许再有任何事件').toBe('turn-end')
  })

  it('报错轮也要有收尾：这一轮压根发不出去时，user-message / error / turn-end 各一次', async () => {
    // 实测（一次性探针）：脚本化 HTTP 报错**不会**让 prompt reject —— pi 把它折成一条
    // stopReason=error 的助手消息，run 照样落 success，压根不进 catch。所以这里用
    // "provider 没配密钥"制造真正的 catch 分支：不联网、不烧 key，原因由 pi 如实给出。
    writeFileSync(
      configFile,
      JSON.stringify({
        version: CONFIG_VERSION,
        onboarded: true,
        providers: [{ id: 'nokey', name: 'NoKey', baseUrl, model: 'mock-model', visionCapable: false, selfCheckAt: null }],
        activeProviderId: 'nokey',
      }),
    )
    await engine.start()

    await expect(engine.sendChat('这一轮没有密钥', [])).rejects.toThrow()

    const types = typeSeq()
    expect(types.filter((t) => t === 'user-message').length, `回显次数不对（事件序列：${JSON.stringify(types)}）`).toBe(1)
    expect(types.filter((t) => t === 'error').length, `error 次数不对（事件序列：${JSON.stringify(types)}）`).toBe(1)
    expect(types.filter((t) => t === 'turn-end').length, `报错轮没有收尾信号（事件序列：${JSON.stringify(types)}）`).toBe(1)
    expect(types[types.length - 1], '报错轮的 turn-end 必须是最后一个事件').toBe('turn-end')
    expect((db.prepare('SELECT status FROM agent_runs ORDER BY id DESC LIMIT 1').get() as { status: string }).status).toBe('failed')
  })
})
