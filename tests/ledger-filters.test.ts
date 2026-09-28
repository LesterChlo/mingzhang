// 账本屏/报告屏/账户屏的四个后端缺口：新增筛选、账户列表、月报月份参数、置信度阈值。
//
// 覆盖口径（对应交付单第 5 条）：
//   ① 分类 / 账户 / 金额区间 各单条件 + 组合条件；
//   ② agg 与筛选同口径（筛选一变，汇总跟着变）；
//   ③ 不传新参数时行为与改动前一致（回归护栏：老筛选的条数/汇总/分页逐字不变）；
//   ④ listAccounts 返回真实账户；latestReport 传月/不传月两种行为；阈值读写与非法值拒绝。
//
// 全部走真库（openSchemaDb + seed），不 mock SQL。

import { describe, expect, it, beforeEach } from 'vitest'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openSchemaDb } from './helpers'
import {
  autoConfirm,
  createTransaction,
  getOrCreateCategoryId,
  recordParse,
  resolveAccountId,
  softDelete,
} from '../src/main/domain/ledger'
import {
  emptyLedgerAgg,
  listAccountOptions,
  parseMonthParam,
  queryLedgerPage,
  rawConfidenceThreshold,
  readConfidenceThreshold,
  reportForMonth,
  writeConfidenceThreshold,
} from '../src/main/domain/ledger-page'
import { previousMonth } from '../src/main/domain/queries'
import { seed } from '../src/main/db/seed'

type Db = ReturnType<typeof openSchemaDb>

let db: Db

const MONTH = '2026-03'
const PREV = { year: 2026, month: 2 }

/** 往库里放一笔已确认交易（occurred_at 固定在 MONTH，避免跨月干扰）。 */
function addConfirmed(input: {
  cents: number
  type?: 'expense' | 'income' | 'transfer'
  account: string
  toAccount?: string
  category?: string
  categoryKind?: 'expense' | 'income'
  merchant?: string
  day?: number
  /** 批次 id（📎 列用例用：imports.source_message_id 与之对齐）。 */
  sourceMessageId?: string
}): number {
  const txType = input.type ?? 'expense'
  const id = createTransaction(db, {
    amountCents: input.cents,
    txType,
    accountId: resolveAccountId(db, input.account),
    toAccountId: input.toAccount ? resolveAccountId(db, input.toAccount) : null,
    occurredAt: `${MONTH}-${String(input.day ?? 10).padStart(2, '0')}T12:00:00+08:00`,
    merchant: input.merchant ?? null,
    sourceMessageId: input.sourceMessageId ?? null,
  })
  const kind = input.categoryKind ?? (txType === 'income' ? 'income' : 'expense')
  recordParse(db, id, {
    categoryId: input.category ? getOrCreateCategoryId(db, input.category, kind) : null,
    confidenceScore: 0.95,
  })
  autoConfirm(db, id)
  return id
}

beforeEach(() => {
  const dir = mkdtempSync(join(tmpdir(), 'mz-ledger-page-'))
  db = openSchemaDb(join(dir, 'test.db'))
  seed(db)
})

describe('① LedgerFilter 新增：分类 / 账户 / 金额区间', () => {
  // 固定数据集：餐饮 35 元(现金) / 购物 120 元(微信) / 收入 5000 元(银行卡) / 转账 200 元(现金→微信)
  function dataset(): void {
    addConfirmed({ cents: 3500, account: '现金', category: '餐饮', merchant: '星巴克' })
    addConfirmed({ cents: 12000, account: '微信', category: '购物', merchant: '淘宝' })
    addConfirmed({
      cents: 500000,
      type: 'income',
      account: '银行卡',
      category: '生活费',
      categoryKind: 'income',
    })
    addConfirmed({ cents: 20000, type: 'transfer', account: '现金', toAccount: '微信' })
  }

  it('分类单条件：只出该分类，agg 也只算该分类', () => {
    dataset()
    const r = queryLedgerPage(db, { month: MONTH, category: '餐饮' })
    expect(r.total).toBe(1)
    expect(r.items.map((t) => t.merchant)).toEqual(['星巴克'])
    // agg 同口径：分类一变，汇总跟着变
    expect(r.agg.count).toBe(1)
    expect(r.agg.expenseCents).toBe(3500)
    expect(r.agg.byCategory).toEqual([{ category: '餐饮', cents: 3500, count: 1 }])
  })

  it('分类名不命中（不存在的分类）→ 空页，不报错也不放宽', () => {
    dataset()
    const r = queryLedgerPage(db, { month: MONTH, category: '不存在的分类' })
    expect(r.total).toBe(0)
    expect(r.items).toEqual([])
    expect(r.agg.count).toBe(0)
  })

  it('账户单条件：本方账户命中', () => {
    dataset()
    const r = queryLedgerPage(db, { month: MONTH, account: '微信' })
    // 微信本方的购物 + 转账的对方是微信 → 两笔
    expect(r.total).toBe(2)
    expect(r.items.every((t) => t.type === 'expense' || t.type === 'transfer')).toBe(true)
  })

  it('账户单条件：转账的对方账户也算（否则转账记录筛不出来）', () => {
    dataset()
    // 现金是转出方
    const r = queryLedgerPage(db, { month: MONTH, account: '现金' })
    const transfer = r.items.find((t) => t.type === 'transfer')
    expect(transfer).toBeDefined()
    expect(transfer?.amountCents).toBe(20000)
    // 银行卡只有一笔收入
    const bank = queryLedgerPage(db, { month: MONTH, account: '银行卡' })
    expect(bank.total).toBe(1)
    expect(bank.items[0].type).toBe('income')
  })

  it('金额区间单条件：下限 / 上限 / 双端（含边界）', () => {
    dataset()
    // >= 12000：购物 12000 + 收入 500000 + 转账 20000 = 3
    expect(queryLedgerPage(db, { month: MONTH, amountMinCents: 12000 }).total).toBe(3)
    // <= 3500：餐饮 3500 = 1
    expect(queryLedgerPage(db, { month: MONTH, amountMaxCents: 3500 }).total).toBe(1)
    // 区间 3500~12000 含两端 = 2
    expect(queryLedgerPage(db, { month: MONTH, amountMinCents: 3500, amountMaxCents: 12000 }).total).toBe(2)
    // 区间不含端点 = 0
    expect(queryLedgerPage(db, { month: MONTH, amountMinCents: 3501, amountMaxCents: 11999 }).total).toBe(0)
  })

  it('金额区间取绝对值：负数 adjustment 也能按金额大小筛出来', () => {
    // 库内 expense/income/transfer 恒正（DDL CHECK），只有 adjustment 可负
    const neg = createTransaction(db, {
      amountCents: -8000,
      txType: 'adjustment',
      accountId: resolveAccountId(db, '现金'),
      occurredAt: `${MONTH}-11T12:00:00+08:00`,
    })
    recordParse(db, neg, { confidenceScore: 0.99 })
    autoConfirm(db, neg)
    const r = queryLedgerPage(db, { month: MONTH, amountMinCents: 8000, amountMaxCents: 8000 })
    expect(r.total).toBe(1)
    expect(r.items[0].amountCents).toBe(-8000)
  })

  it('组合条件：分类 + 账户 + 金额区间 + 月份 一起收窄', () => {
    dataset()
    const r = queryLedgerPage(db, {
      month: MONTH,
      category: '购物',
      account: '微信',
      amountMinCents: 10000,
      amountMaxCents: 15000,
    })
    expect(r.total).toBe(1)
    expect(r.items[0].merchant).toBe('淘宝')
    // 聚合同口径：byCategory 也只剩这一类
    expect(r.agg.byCategory).toEqual([{ category: '购物', cents: 12000, count: 1 }])
  })

  it('组合条件为空集时 agg 归零（不残留上一次的数字）', () => {
    dataset()
    const r = queryLedgerPage(db, { month: MONTH, category: '购物', account: '现金' })
    expect(r.total).toBe(0)
    expect(r.agg).toEqual({ ...emptyLedgerAgg(MONTH) })
  })

  it('amountMin > amountMax 报错（不静默返回空）', () => {
    dataset()
    expect(() => queryLedgerPage(db, { month: MONTH, amountMinCents: 9000, amountMaxCents: 100 })).toThrow(
      /下限大于上限/,
    )
  })

  it('agg 与 items 同口径：分页不影响 agg', () => {
    dataset()
    const all = queryLedgerPage(db, { month: MONTH })
    const paged = queryLedgerPage(db, { month: MONTH, limit: 1, offset: 0 })
    expect(paged.items).toHaveLength(1)
    expect(paged.agg).toEqual(all.agg)
  })

  it('agg 排除已删除（既有契约），而 items 保留 state 筛选能力', () => {
    dataset()
    const delId = addConfirmed({ cents: 700, account: '现金', category: '餐饮', day: 12 })
    softDelete(db, delId)
    const r = queryLedgerPage(db, { month: MONTH, state: 'deleted' })
    expect(r.items.map((t) => t.id)).toEqual([delId])
    // agg 口径恒定排除 deleted
    expect(r.agg.count).toBe(4)
  })
})

// ---------------------------------------------------------------------------
// 📎 列（账本屏规格 §3.2 表格列）：LedgerRow.attachmentRef
//
// 这是本单唯一被授权的后端改动：queryLedgerPage 的 SELECT 多取一列 attachmentRef
// （来源附件相对文件名，无则 NULL），供表格画 📎。取数口径必须与 txDetail 逐字一致。
// 用例锁三件事：① 有附件取到相对名；② 无附件是 null（不是空串/undefined）；
//             ③ 加这一列**不改变行数**（标量子查询，不因一个 source_message_id 多条 imports 而扇出）。
// ---------------------------------------------------------------------------
describe('⑤ LedgerRow.attachmentRef（账本屏 📎 列）', () => {
  /** 造一笔带来源附件的交易：imports.source_ref + transactions.source_message_id 关联。 */
  function addWithAttachment(smid: string, sourceRef: string | null, cents = 3500): number {
    const id = createTransaction(db, {
      amountCents: cents,
      txType: 'expense',
      accountId: resolveAccountId(db, '现金'),
      occurredAt: `${MONTH}-15T12:00:00+08:00`,
      merchant: '带票的午饭',
      sourceMessageId: smid,
    })
    recordParse(db, id, { categoryId: getOrCreateCategoryId(db, '餐饮', 'expense'), confidenceScore: 0.95 })
    autoConfirm(db, id)
    db.prepare(
      "INSERT INTO imports (source_type, status, source_ref, source_message_id, created_at, updated_at)" +
        " VALUES ('screenshot', 'pending', ?, ?, 't', 't')",
    ).run(sourceRef, smid)
    return id
  }

  it('有来源附件 → attachmentRef 取到相对文件名', () => {
    const id = addWithAttachment('smid-with-clip', 'bill-2026-03.png')
    const r = queryLedgerPage(db, { month: MONTH })
    const row = r.items.find((t) => t.id === id)
    expect(row?.attachmentRef).toBe('bill-2026-03.png')
  })

  it('无附件 → attachmentRef 为 null（不是空串，也不是 undefined）', () => {
    // 手工记的账：没有 imports 行，也没有 source_message_id
    const plain = addConfirmed({ cents: 3500, account: '现金', category: '餐饮', merchant: '星巴克' })
    // 有 imports 行但 source_ref 为 NULL
    const nullRef = addWithAttachment('smid-null-ref', null, 1200)
    const r = queryLedgerPage(db, { month: MONTH })
    expect(r.items.find((t) => t.id === plain)?.attachmentRef).toBeNull()
    expect(r.items.find((t) => t.id === nullRef)?.attachmentRef).toBeNull()
  })

  it('同一 source_message_id 多条 imports：不扇出（行数与 total 不变），取最近一条非空 source_ref', () => {
    const id = addWithAttachment('smid-multi', 'old-clip.png')
    db.prepare(
      "INSERT INTO imports (source_type, status, source_ref, source_message_id, created_at, updated_at)" +
        " VALUES ('screenshot', 'pending', 'new-clip.png', ?, 't', 't')",
    ).run('smid-multi')
    const r = queryLedgerPage(db, { month: MONTH })
    // 关键回归护栏：标量子查询不能把一笔账变成两行
    expect(r.items.filter((t) => t.id === id)).toHaveLength(1)
    expect(r.total).toBe(1)
    // 取 id 倒序最近的一条非空 source_ref
    expect(r.items[0].attachmentRef).toBe('new-clip.png')
    // 加这一列不能影响汇总口径：还是 1 笔 3500
    expect(r.agg.count).toBe(1)
    expect(r.agg.expenseCents).toBe(3500)
  })
})

describe('③ 向后兼容：不传新参数 = 改动前的行为（回归护栏）', () => {
  function dataset(): void {
    addConfirmed({ cents: 3500, account: '现金', category: '餐饮', merchant: '星巴克' })
    addConfirmed({ cents: 12000, account: '微信', category: '购物', merchant: '淘宝' })
    addConfirmed({ cents: 500000, type: 'income', account: '银行卡', category: '生活费' })
    addConfirmed({ cents: 20000, type: 'transfer', account: '现金', toAccount: '微信' })
  }

  it('空筛选 = 全量 4 笔，agg 含全部（排除已删除）', () => {
    dataset()
    const r = queryLedgerPage(db, {})
    expect(r.total).toBe(4)
    expect(r.items).toHaveLength(4)
    expect(r.agg).toEqual({
      month: null,
      count: 4,
      expenseCents: 15500,
      incomeCents: 500000,
      reviewCount: 0,
      reviewExpenseCents: 0,
      byCategory: [
        { category: '购物', cents: 12000, count: 1 },
        { category: '餐饮', cents: 3500, count: 1 },
      ],
    })
  })

  it('老筛选 month/state/type/q 逐字不变', () => {
    dataset()
    const byMonth = queryLedgerPage(db, { month: MONTH })
    expect(byMonth.total).toBe(4)
    expect(byMonth.agg.month).toBe(MONTH)

    const byType = queryLedgerPage(db, { month: MONTH, type: 'expense' })
    expect(byType.total).toBe(2)
    expect(byType.agg.expenseCents).toBe(15500)

    const byState = queryLedgerPage(db, { month: MONTH, state: 'confirmed' })
    expect(byState.total).toBe(4)

    const byQ = queryLedgerPage(db, { month: MONTH, q: '淘宝' })
    expect(byQ.total).toBe(1)
    expect(byQ.items[0].merchant).toBe('淘宝')

    // 关键词命中分类名（既有口径）
    const byCatQ = queryLedgerPage(db, { month: MONTH, q: '购物' })
    expect(byCatQ.total).toBe(1)
  })

  it('分页边界不变：limit 夹在 1~500，offset 不为负', () => {
    dataset()
    expect(queryLedgerPage(db, { month: MONTH, limit: 0 }).items.length).toBeGreaterThan(0)
    expect(queryLedgerPage(db, { month: MONTH, limit: 9999 }).total).toBe(4)
    expect(queryLedgerPage(db, { month: MONTH, limit: 10, offset: -5 }).items).toHaveLength(4)
  })

  it('state 仍不进 agg 口径（汇总卡要在按状态筛选时显示待确认数）', () => {
    // 一笔 needs_review 支出
    const id = createTransaction(db, {
      amountCents: 4200,
      txType: 'expense',
      accountId: resolveAccountId(db, '现金'),
      occurredAt: `${MONTH}-20T12:00:00+08:00`,
    })
    recordParse(db, id, { categoryId: getOrCreateCategoryId(db, '餐饮', 'expense'), confidenceScore: 0.3 })
    db.prepare("UPDATE transactions SET state='needs_review' WHERE id=?").run(id)

    const byState = queryLedgerPage(db, { month: MONTH, state: 'needs_review' })
    expect(byState.total).toBe(1)
    // 聚合口径与 state 无关：待确认笔数照样在
    expect(byState.agg.reviewCount).toBe(1)
    expect(byState.agg.reviewExpenseCents).toBe(4200)
  })
})

describe('② 账户列表通道', () => {
  it('返回 seed 的 4 个真实账户，字段取自 accounts 表实际列', () => {
    const list = listAccountOptions(db)
    expect(list).toHaveLength(4)
    expect(list.map((a) => a.name)).toEqual(['现金', '银行卡', '支付宝', '微信'])
    expect(list.map((a) => a.kind)).toEqual(['cash', 'bank', 'alipay', 'wechat'])
    expect(list.every((a) => a.currency === 'CNY')).toBe(true)
    expect(list.every((a) => typeof a.id === 'number' && a.id > 0)).toBe(true)
    expect(list.every((a) => typeof a.createdAt === 'string' && a.createdAt.length > 0)).toBe(true)
  })

  it('不含余额字段（accounts 表无期初余额列，算不出就不给）', () => {
    const one = listAccountOptions(db)[0]
    expect(Object.keys(one).sort()).toEqual(['createdAt', 'currency', 'id', 'kind', 'name'])
    expect('balanceCents' in one).toBe(false)
  })

  it('新增账户后立即出现在列表里（不缓存快照）', () => {
    db.prepare("INSERT INTO accounts (name, type, currency, created_at, updated_at) VALUES ('零钱','cash','CNY','t','t')").run()
    expect(listAccountOptions(db).map((a) => a.name)).toContain('零钱')
  })
})

describe('③ 不传月份时 latestReport 行为不变（收件箱右栏依赖）', () => {
  beforeEach(() => {
    // 2026-02 一笔已确认支出 + 一笔收入；2026-03 一笔更大的支出
    addConfirmed({ cents: 8000, account: '现金', category: '餐饮', merchant: '麦当劳' })
    const inc = createTransaction(db, {
      amountCents: 300000,
      txType: 'income',
      accountId: resolveAccountId(db, '银行卡'),
      occurredAt: `${MONTH}-05T12:00:00+08:00`,
    })
    recordParse(db, inc, { categoryId: getOrCreateCategoryId(db, '生活费', 'income'), confidenceScore: 0.99 })
    autoConfirm(db, inc)
    const feb = createTransaction(db, {
      amountCents: 12345,
      txType: 'expense',
      accountId: resolveAccountId(db, '现金'),
      occurredAt: '2026-02-14T12:00:00+08:00',
    })
    recordParse(db, feb, { categoryId: getOrCreateCategoryId(db, '餐饮', 'expense'), confidenceScore: 0.99 })
    autoConfirm(db, feb)
  })

  it("不传月份 = 上一个自然月（收件箱右栏依赖的既有行为)", () => {
    const r = reportForMonth(db, undefined, PREV)
    expect(r?.month).toBe('2026-02')
    expect(r?.totalExpenseCents).toBe(12345)
    expect(r?.text).toContain('2026-02 月报')
  })

  it("传 '2026-03' = 该月月报，month 字段可区分是哪个月", () => {
    const r = reportForMonth(db, '2026-03', PREV)
    expect(r?.month).toBe('2026-03')
    expect(r?.range).toEqual(['2026-03-01', '2026-03-31'])
    expect(r?.totalExpenseCents).toBe(8000)
    expect(r?.totalIncomeCents).toBe(300000)
    expect(r?.countExpense).toBe(1)
    expect(r?.countIncome).toBe(1)
  })

  it("传 '2026-01'（空月）：返回带 month 的空报告，不与 null 混淆", () => {
    const r = reportForMonth(db, '2026-01', PREV)
    expect(r).not.toBeNull()
    expect(r?.month).toBe('2026-01')
    expect(r?.empty).toBe(true)
    expect(r?.totalExpenseCents).toBe(0)
  })

  it("不传月份且上月为空 → null（既有契约，收件箱右栏据此显示「无数据」）", () => {
    const r = reportForMonth(db, undefined, { year: 2025, month: 1 })
    expect(r).toBeNull()
  })

  it('月份格式非法 → 报错，不静默回退', () => {
    expect(() => reportForMonth(db, '2026', PREV)).toThrow(/YYYY-MM/)
    expect(() => reportForMonth(db, '2026-13', PREV)).toThrow(/范围/)
    expect(() => parseMonthParam('三月')).toThrow(/YYYY-MM/)
    expect(parseMonthParam('2026-3')).toEqual({ year: 2026, month: 3 })
  })

  it('previousMonth 与 reportForMonth 的默认值同源（回退口径不漂移）', () => {
    const now = new Date(2026, 0, 15) // 2026-01-15 → 上月 2025-12
    const p = previousMonth(now)
    expect(p).toEqual({ year: 2025, month: 12 })
    // 库里没数据 → 空月走 null 分支
    expect(reportForMonth(db, undefined, p)).toBeNull()
  })
})

describe('④ 置信度阈值通道', () => {
  it('默认值 0.7（seed 写进 settings）', () => {
    expect(readConfidenceThreshold(db)).toBe(0.7)
    expect(rawConfidenceThreshold(db)).toBe('0.7')
  })

  it('写入后可读回，落的是 settings 表', () => {
    expect(writeConfidenceThreshold(db, 0.95)).toBe(0.95)
    expect(readConfidenceThreshold(db)).toBe(0.95)
    expect(rawConfidenceThreshold(db)).toBe('0.95')
  })

  it('写操作带审计（R3）', () => {
    writeConfidenceThreshold(db, 0.5)
    const row = db
      .prepare("SELECT change_type, changed_by, before_value, after_value FROM audit_log WHERE entity_type='setting' ORDER BY id DESC LIMIT 1")
      .get() as { change_type: string; changed_by: string; before_value: string; after_value: string }
    expect(row.change_type).toBe('update')
    expect(row.changed_by).toBe('user')
    expect(JSON.parse(row.after_value)).toEqual({ key: 'confidence_threshold', value: '0.5' })
  })

  it('非法值被拒且不落盘（0~1 之外 / NaN / 非数字）', () => {
    writeConfidenceThreshold(db, 0.42)
    for (const bad of [1.5, -0.1, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(() => writeConfidenceThreshold(db, bad)).toThrow(/0~1/)
    }
    expect(() => writeConfidenceThreshold(db, '0.8' as unknown as number)).toThrow(/0~1 之间的数字/)
    // 值没被污染
    expect(readConfidenceThreshold(db)).toBe(0.42)
  })

  it('边界值 0 与 1 合法', () => {
    expect(writeConfidenceThreshold(db, 0)).toBe(0)
    expect(writeConfidenceThreshold(db, 1)).toBe(1)
  })
})
