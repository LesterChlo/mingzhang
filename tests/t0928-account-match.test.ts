// T0928-1330 缺陷③：账户名匹配不上不许静默变现金。
//
// 缺陷：domain/ledger.ts 的 resolveAccountId 查不到名字就 `ORDER BY id LIMIT 1`
//   （seed 的第一条 = 现金）——用户说"记在招行卡上"，模型听错写成"招商银行"，
//   账就悄悄记成现金，用户还看不见。
// 修法：resolveAccountId 保持签名与"未提供→默认账户"行为不变（老调用点不破），
//   新增 resolveAccountIdWithMatch(db, name) → { id, matched }：
//   提供了名字但匹配不上 → matched=false（调用点据此在消息里点名，不静默）。
// 调用点：record 工具（tools.ts:105）与 update 工具（tools.ts:331）。
//
// 本文件既锁域层语义（matched 标志），也锁工具真的把话说出来。

import { describe, expect, it } from 'vitest'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { openSchemaDb } from './helpers'
import { seed } from '../src/main/db/seed'
import { resolveAccountId, resolveAccountIdWithMatch, getTransaction } from '../src/main/domain/ledger'
import { createLedgerTools, type TurnContext } from '../src/main/engine/tools'

function mkDb() {
  const file = join(mkdtempSync(join(tmpdir(), 'mz-acct-')), 'test.db')
  const db = openSchemaDb(file)
  seed(db)
  return db
}

const TURN: TurnContext = {
  sessionId: 's1',
  sourceMessageId: 'm1',
  hasImage: false,
  visionUnverified: false,
  attachments: [],
}

type ToolExec = (id: string, params: Record<string, unknown>) => Promise<{ content: { text?: string }[] }>

function toolByName(db: ReturnType<typeof openSchemaDb>, name: string): ToolExec {
  const tools = createLedgerTools({ db, getTurnContext: () => TURN })
  const t = tools.find((x) => x.name === name)
  if (!t) throw new Error(`工具面里没有 ${name}`)
  // pi 的 execute 签名带 signal/onUpdate/ctx，本用例都不需要
  return (id, params) =>
    (t.execute as unknown as ToolExec)(id, params, undefined, undefined, {} as never)
}

describe('缺陷③：域层 resolveAccountIdWithMatch', () => {
  it('① 名字匹配上：matched=true，id 正确', () => {
    const db = mkDb()
    const r = resolveAccountIdWithMatch(db, '支付宝')
    expect(r.matched).toBe(true)
    const row = db.prepare('SELECT id FROM accounts WHERE name=?').get('支付宝') as { id: number }
    expect(r.id).toBe(row.id)
  })

  it('② 名字给了但匹配不上：matched=false（**调用点据此点名，不静默套第一条**）', () => {
    const db = mkDb()
    const r = resolveAccountIdWithMatch(db, '招行卡')
    expect(r.matched).toBe(false)
    // 仍然给了可用 id（默认账户），但调用方必须知道"没匹配上"
    expect(r.id).toBe(resolveAccountId(db))
    expect(r.id).not.toBe(resolveAccountId(db, '支付宝'))
  })

  it('③ 未提供名字：matched=true（默认账户是正常口径，不是"匹配失败"），且行为与老 resolveAccountId 一致', () => {
    const db = mkDb()
    const r = resolveAccountIdWithMatch(db, null)
    expect(r.matched).toBe(true)
    expect(r.id).toBe(resolveAccountId(db))
    expect(r.id).toBe(resolveAccountIdWithMatch(db, '').id)
  })

  it('④ 老签名不动：resolveAccountId(db, 不存在的名字) 仍回落第一条（老调用点不破）', () => {
    const db = mkDb()
    expect(resolveAccountId(db, '招行卡')).toBe(resolveAccountId(db))
  })
})

describe('缺陷③：工具把话说出来（不许静默变现金）', () => {
  it('⑤ record 工具：账户名匹配不上 → 消息点名「账户「X」不存在，已按默认账户记账，可在账本详情改」', async () => {
    const db = mkDb()
    const record = toolByName(db, 'record')
    const res = await record('c1', {
      amount_cents: 3500,
      tx_type: 'expense',
      merchant: '星巴克',
      category_name: '咖啡',
      account_name: '招行卡',
      confidence: 0.95,
    })
    const text = res.content.map((c) => c.text ?? '').join('\n')
    expect(text).toContain('账户「招行卡」不存在')
    expect(text).toContain('默认账户')
    expect(text).toContain('账本详情')
  })

  it('⑥ record 工具：账户名匹配得上 → 不加那句提示（别制造噪音）', async () => {
    const db = mkDb()
    const record = toolByName(db, 'record')
    const res = await record('c2', {
      amount_cents: 3500,
      tx_type: 'expense',
      merchant: '星巴克',
      category_name: '咖啡',
      account_name: '支付宝',
      confidence: 0.95,
    })
    const text = res.content.map((c) => c.text ?? '').join('\n')
    expect(text).not.toContain('不存在')
    expect(text).not.toContain('默认账户')
  })

  it('⑦ update 工具：改成不存在的账户名 → 消息点名，且真的改了（回落默认账户）而不是无声无息', async () => {
    const db = mkDb()
    const record = toolByName(db, 'record')
    const first = await record('c3', {
      amount_cents: 3500,
      tx_type: 'expense',
      merchant: '瑞幸',
      category_name: '咖啡',
      account_name: '支付宝',
      confidence: 0.95,
    })
    const detailsText = first.content.map((c) => c.text ?? '').join('')
    const txId = Number(/交易 #(\d+)/.exec(detailsText)![1])

    const update = toolByName(db, 'update')
    const res = await update('c4', { tx_id: txId, account_name: '招行卡' })
    const text = res.content.map((c) => c.text ?? '').join('\n')
    expect(text).toContain('账户「招行卡」不存在')
    expect(text).toContain('账本详情')
    // 确实落到默认账户了（口径是"说出来"，不是"拒绝"）
    expect(getTransaction(db, txId)?.account_id).toBe(resolveAccountId(db))
  })
})
