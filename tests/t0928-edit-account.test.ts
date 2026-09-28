// T0928-1330 契约 B：账本详情里改账户（TxEditOp.set.fields.accountName）。
//
// 缺陷：TxEditOp.set.fields 只有 categoryName/amountCents/merchant/note，**没有账户**；
//   doEditTx 的 set 分支也不处理账户名，用户在账本详情改不了付款账户。
// 口径（工单 §2）：账户名**精确匹配** accounts.name，匹配不上直接报错，
//   不许走 resolveAccountId 的"回落第一条账户"（= 静默变现金）。
//   匹配上则 updateFields(..., {changedBy:'user', reasoning:'用户在账本详情改账户'})，
//   account_id 前后值自然进审计。
//
// 引擎装配照抄 tests/turn-timeout.test.ts 的脚手架（同源假 provider 语义），不重构它。

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
import { createTransaction, recordParse, autoConfirm, getOrCreateCategoryId } from '../src/main/domain/ledger'
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

let db: Database
let engine: Engine
let provider: FakeProvider
let events: ChatEvent[]

beforeAll(async () => {
  events = []
  const dataDir = mkdtempSync(join(tmpdir(), 'mz-edit-acct-'))
  for (const d of ['sessions', 'attachments', 'pi', 'secrets', 'backups']) {
    mkdirSync(join(dataDir, d), { recursive: true })
  }
  provider = await startFakeProvider('ok')

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

/** 一笔已确认的支出，落在"现金"账户上。 */
function confirmedExpense(merchant: string): number {
  const txId = createTransaction(db, { amountCents: 3500, txType: 'expense', merchant, changedBy: 'user' })
  recordParse(db, txId, {
    txType: 'expense',
    categoryId: getOrCreateCategoryId(db, '餐饮', 'expense'),
    confidenceScore: 0.95,
  })
  autoConfirm(db, txId, { confidenceScore: 0.95 })
  return txId
}

const accountIdOf = (txId: number): number | null =>
  (db.prepare('SELECT account_id FROM transactions WHERE id=?').get(txId) as { account_id: number | null }).account_id

const accountNameOf = (id: number | null): string | null =>
  id == null ? null : ((db.prepare('SELECT name FROM accounts WHERE id=?').get(id) as { name: string }).name)

describe('契约 B：账本详情改账户', () => {
  it('① 改账户成功：account_id 变、卡片账户名跟着变、审计留痕（前后值 + user + 口径）', async () => {
    const txId = confirmedExpense('星巴克改账户')
    const before = accountIdOf(txId)
    expect(accountNameOf(before)).toBe('现金') // seed 第一条账户

    const res = await engine.editTx(txId, { op: 'set', fields: { accountName: '支付宝' } })

    expect(res.status).toBe('ok')
    const after = accountIdOf(txId)
    expect(after).not.toBe(before)
    expect(accountNameOf(after)).toBe('支付宝')
    expect(res.card?.tx.accountName).toBe('支付宝')

    const audit = db
      .prepare(
        "SELECT changed_by, reasoning, before_value, after_value FROM audit_log" +
          " WHERE entity_type='transaction' AND entity_id=? AND change_type='update' ORDER BY id DESC LIMIT 1",
      )
      .get(txId) as { changed_by: string; reasoning: string | null; before_value: string; after_value: string } | undefined
    expect(audit, '改账户没有写审计').toBeTruthy()
    expect(audit!.changed_by).toBe('user')
    expect(audit!.reasoning).toBe('用户在账本详情改账户')
    expect(JSON.parse(audit!.before_value).account_id).toBe(before)
    expect(JSON.parse(audit!.after_value).account_id).toBe(after)
  })

  it('② 账户名不存在 → 报错，且**不静默回落**成第一条账户（不许变现金）', async () => {
    const txId = confirmedExpense('星巴克错账户')
    const before = accountIdOf(txId)

    const res = await engine.editTx(txId, { op: 'set', fields: { accountName: '不存在的账户' } })

    expect(res.status).toBe('error')
    expect(res.message).toContain('找不到账户')
    expect(res.message).toContain('不存在的账户')
    expect(accountIdOf(txId), '匹配不上却把账户改了（= 静默变现金）').toBe(before)
  })

  it('③ 改账户 + 改其他字段可同批生效（accountName 不是独占分支）', async () => {
    const txId = confirmedExpense('星巴克组合改')
    const res = await engine.editTx(txId, { op: 'set', fields: { accountName: '微信', note: '组合改测试' } })
    expect(res.status).toBe('ok')
    expect(accountNameOf(accountIdOf(txId))).toBe('微信')
    const row = db.prepare('SELECT note FROM transactions WHERE id=?').get(txId) as { note: string | null }
    expect(row.note).toBe('组合改测试')
  })
})
