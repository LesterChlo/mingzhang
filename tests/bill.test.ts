// 第 8 单 段1：账单确定性套表引擎。
// 这组用例守的是一条线：金额与日期只能从原表由代码解析出来，
// 模型只交"读表方案"；方案没覆盖的取值整批退回，绝不静默归类、绝不记成今天。
import { describe, expect, it } from 'vitest'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openSchemaDb } from './helpers'
import { seed } from '../src/main/db/seed'
import { executeBatch } from '../src/main/domain/batch'
import {
  applyBillPlan,
  parseAmountCents,
  parseOccurredAt,
  readBillRows,
  stageBill,
  getBillTable,
  BillPlanError,
  MAX_BILL_ROWS,
  type BillPlanInput,
} from '../src/main/domain/bill'

function mkDb() {
  const db = openSchemaDb(join(mkdtempSync(join(tmpdir(), 'mz-bill-')), 'test.db'))
  seed(db)
  return db
}

const HEADER = ['交易时间', '交易类型', '交易对方', '商品', '收/支', '金额(元)', '支付方式', '当前状态', '交易单号', '备注']

/** 5 行微信账单样式：2 支出（不同支付方式）+ 1 收入 + 1 不计收支（已全额退款）+ 1 金额栏读不出。 */
const CELLS: string[][] = [
  HEADER,
  ['2026-09-12 18:31:05', '餐饮美食', '麦当劳', '巨无霸套餐', '支出', '¥26.00', '零钱', '支付成功', '4200001A', ''],
  ['2026/9/13 09:05', '交通出行', '滴滴出行', '快车', '支出', '1,234.56', '工商银行储蓄卡(1234)', '支付成功', '4200002B', ''],
  ['2026年9月14日 下午3:20', '转账', '张三', '/', '收入', '88.88元', '零钱', '已存入零钱', '4200003C', '红包'],
  ['2026-09-15 12:00:00', '购物', '京东', '退货', '不计收支', '(35.00)', '零钱', '已全额退款', '4200004D', ''],
  ['2026-09-16 07:30:00', '餐饮美食', '全家便利店', '早餐', '支出', '免费', '零钱', '支付成功', '4200005E', ''],
]

const BASE_PLAN: BillPlanInput = {
  table_id: 0,
  channel: '微信支付',
  columns: {
    amount: '金额(元)',
    merchant: '交易对方',
    time: '交易时间',
    id: '交易单号',
    direction: '收/支',
    account: '支付方式',
  },
  account_column_values: [
    { contains: '零钱', account_name: '微信' },
    { contains: '工商银行', account_name: '银行卡' },
  ],
  skip_when: [{ column: '当前状态', contains: '已全额退款' }],
}

function staged(db: ReturnType<typeof mkDb>, cells: string[][] = CELLS) {
  return stageBill(db, { sourceType: 'xlsx', cells, fileName: '假账单.xlsx' })
}

describe('① 金额解析（整数分；不经模型的手）', () => {
  it('货币符号 / 千分位 / 元 / 括号负数 / 正负号都能解', () => {
    expect(parseAmountCents('¥26.00')).toEqual({ cents: 2600, negative: false })
    expect(parseAmountCents('1,234.56')).toEqual({ cents: 123456, negative: false })
    expect(parseAmountCents('88.88元')).toEqual({ cents: 8888, negative: false })
    expect(parseAmountCents('（35.00）')).toEqual({ cents: 3500, negative: true })
    expect(parseAmountCents('-12.3')).toEqual({ cents: 1230, negative: true })
    expect(parseAmountCents(' 45 ')).toEqual({ cents: 4500, negative: false })
  })
  it('解不出一律 null（不猜、不就近取数）', () => {
    expect(parseAmountCents('免费')).toBeNull()
    expect(parseAmountCents('')).toBeNull()
    expect(parseAmountCents('-')).toBeNull()
    expect(parseAmountCents('1.234,56')).toBeNull()
    expect(parseAmountCents('0')).toBeNull()
    expect(parseAmountCents('12.3456789')).toBeNull()
  })
})

describe('② 交易时间解析（多格式；失败即失败，不默认成今天）', () => {
  it('ISO / 斜杠 / 中文日期 / 12 小时制 / 紧凑 14 位都能解', () => {
    expect(parseOccurredAt('2026-09-12 18:31:05')).toBe('2026-09-12 18:31:05')
    expect(parseOccurredAt('2026/9/3 9:05')).toBe('2026-09-03 09:05:00')
    expect(parseOccurredAt('2026年9月14日 下午3:20')).toBe('2026-09-14 15:20:00')
    expect(parseOccurredAt('20260912183105')).toBe('2026-09-12 18:31:05')
    expect(parseOccurredAt('2026-09-12')).toBe('2026-09-12 00:00:00')
  })
  it('无年份按现在就近取过去月份；非法日期与怪值返回 null', () => {
    const now = new Date(2026, 8, 23) // 2026-09-23
    expect(parseOccurredAt('09-12 18:31', now)).toBe('2026-09-12 18:31:00')
    expect(parseOccurredAt('12-01 08:00', now)).toBe('2025-12-01 08:00:00') // 还没到 → 判为去年
    expect(parseOccurredAt('2026-13-45 10:00')).toBeNull()
    expect(parseOccurredAt('刚刚')).toBeNull()
    expect(parseOccurredAt('')).toBeNull()
  })
})

describe('③ 入库（staging）', () => {
  it('表头 + 数据行入库，行号从 1 起可分页读回', () => {
    const db = mkDb()
    const t = staged(db)
    expect(t.rowCount).toBe(5)
    expect(t.openRows).toBe(5)
    const view = readBillRows(db, t.id, 2, 2)
    expect(view.rows.map((r) => r.no)).toEqual([2, 3])
    expect(view.rows[0].cells[2]).toBe('滴滴出行')
    expect(getBillTable(db, t.id)?.fileName).toBe('假账单.xlsx')
  })
  it('全空行不入库（对账口径只算真数据行）', () => {
    const db = mkDb()
    const t = stageBill(db, { sourceType: 'csv', cells: [HEADER, CELLS[1], ['', '', '', ''], CELLS[2]] })
    expect(t.rowCount).toBe(2)
  })
  it('坏材料明确报错：无表头 / 无数据行 / 超行数上限', () => {
    const db = mkDb()
    expect(() => stageBill(db, { sourceType: 'csv', cells: [['', ''], ['1', '2']] })).toThrow(/表头/)
    expect(() => stageBill(db, { sourceType: 'csv', cells: [HEADER] })).toThrow(/没有数据行/)
    const big = [HEADER, ...Array.from({ length: MAX_BILL_ROWS + 1 }, (_, i) => ['2026-09-12 10:00', 't', `商户${i}`, '', '支出', '1.00', '零钱', '', `id${i}`, ''])]
    expect(() => stageBill(db, { sourceType: 'csv', cells: big })).toThrow(/超过单次上限/)
  })
})

describe('④ 套表入账：行数与金额都不靠模型报', () => {
  it('5 行材料 → 入账 3 笔 + 不计收支 1 行 + 待核对 1 行，相加正好等于 5', () => {
    const db = mkDb()
    const t = staged(db)
    const r = applyBillPlan(db, { ...BASE_PLAN, table_id: t.id }, { sessionId: 's1' })
    expect(r.rowsConsidered).toBe(5)
    expect(r.newCount).toBe(3)
    expect(r.skippedCount).toBe(1)
    expect(r.reviewCount).toBe(1)
    expect(r.newCount + r.duplicateCount + r.reviewCount + r.skippedCount).toBe(5)
    expect(r.gateId).not.toBeNull()
    expect(r.skippedSamples[0].reason).toMatch(/不计收支/)
    expect(r.reviewSamples[0].reason).toMatch(/金额「免费」解析不出/)
    // 每行都有归宿：不再有 open 行
    expect(getBillTable(db, t.id)?.openRows).toBe(0)
  })

  it('执行确认后：金额逐笔等于原表值，账户按支付方式列分开落', () => {
    const db = mkDb()
    const t = staged(db)
    const r = applyBillPlan(db, { ...BASE_PLAN, table_id: t.id }, { sessionId: 's1' })
    const exec = executeBatch(db, r.gateId!)
    expect(exec?.completed).toHaveLength(3)

    const rows = db
      .prepare(
        'SELECT t.amount_cents cents, t.type, t.merchant, t.occurred_at at, a.name acc' +
          ' FROM transactions t JOIN accounts a ON a.id=t.account_id ORDER BY t.id',
      )
      .all() as unknown as { cents: number; type: string; merchant: string; at: string; acc: string }[]
    expect(rows.map((x) => x.cents)).toEqual([2600, 123456, 8888])
    expect(rows.map((x) => x.type)).toEqual(['expense', 'expense', 'income'])
    expect(rows.map((x) => x.at.slice(0, 10))).toEqual(['2026-09-12', '2026-09-13', '2026-09-14'])
    expect(rows.map((x) => x.acc)).toEqual(['微信', '银行卡', '微信'])
    // 不计收支与待核对都没进账（不是"悄悄记一笔"）
    expect(rows.find((x) => x.merchant === '京东')).toBeUndefined()
    expect(rows.find((x) => x.merchant === '全家便利店')).toBeUndefined()
  })

  it('同一交易号重复出现 → 判重跳过，且仍计入对账', () => {
    const db = mkDb()
    const t = staged(db)
    const first = applyBillPlan(db, { ...BASE_PLAN, table_id: t.id }, { sessionId: 's1' })
    executeBatch(db, first.gateId!)
    // 再拖一次同样的材料（全新入库，交易号相同）
    const t2 = staged(db)
    const second = applyBillPlan(db, { ...BASE_PLAN, table_id: t2.id }, { sessionId: 's1' })
    expect(second.duplicateCount).toBe(3)
    expect(second.newCount).toBe(0)
    expect(second.newCount + second.duplicateCount + second.reviewCount + second.skippedCount).toBe(5)
    const n = db.prepare('SELECT COUNT(*) n FROM transactions').get() as { n: number }
    expect(n.n).toBe(3) // 没有重复入账
  })

  it('row_overrides 例外逐行裁决：整段排除 + 指定分类', () => {
    const db = mkDb()
    const t = staged(db)
    const r = applyBillPlan(
      db,
      {
        ...BASE_PLAN,
        table_id: t.id,
        skip_when: [],
        row_overrides: [
          { rows: [4], type: 'skip' },
          { from_row: 1, to_row: 2, category_name: '交通' },
        ],
      },
      { sessionId: 's1' },
    )
    expect(r.newCount).toBe(3)
    expect(r.skippedCount).toBe(1)
    executeBatch(db, r.gateId!)
    const cats = db
      .prepare('SELECT c.name n FROM transactions t LEFT JOIN categories c ON c.id=t.category_id ORDER BY t.id')
      .all() as unknown as { n: string | null }[]
    expect(cats.map((c) => c.n)).toEqual(['交通', '交通', null]) // 收入那笔商户「张三」没人教过 → 不猜分类（转待确认）
  })

  it('分类方案由模型给、程序套用（categories 命中商户关键词）', () => {
    const db = mkDb()
    const t = staged(db)
    const r = applyBillPlan(
      db,
      { ...BASE_PLAN, table_id: t.id, categories: [{ match: '滴滴', category_name: '交通' }] },
      { sessionId: 's1' },
    )
    executeBatch(db, r.gateId!)
    const cat = db
      .prepare('SELECT c.name n FROM transactions t LEFT JOIN categories c ON c.id=t.category_id WHERE t.merchant=?')
      .get('滴滴出行') as { n: string | null }
    expect(cat.n).toBe('交通')
  })
})

describe('⑤ 程序不猜：方案不合格就整批退回，一行都不消费', () => {
  it('列名对不上 → 报错并回显真实列名，材料保持可重提', () => {
    const db = mkDb()
    const t = staged(db)
    // 唯一包含匹配是允许的（「金额」→「金额(元)」），不算猜
    expect(() =>
      applyBillPlan(db, { ...BASE_PLAN, table_id: t.id, columns: { ...BASE_PLAN.columns, amount: '金额' } }, { sessionId: 's1' }),
    ).not.toThrow()
    const t2 = staged(db)
    try {
      applyBillPlan(db, { ...BASE_PLAN, table_id: t2.id, columns: { ...BASE_PLAN.columns, amount: '不存在列' } }, { sessionId: 's1' })
      throw new Error('应当整批退回')
    } catch (e) {
      expect(e).toBeInstanceOf(BillPlanError)
      expect((e as Error).message).toMatch(/金额\(元\)/) // 回了真实列名
    }
    expect(getBillTable(db, t2.id)?.openRows).toBe(5)
  })

  it('方向列有没覆盖的取值 → 整批退回并列出该取值', () => {
    const db = mkDb()
    const cells = [HEADER, [...CELLS[1]], ['2026-09-20 10:00', '其他', '某商户', '/', '神秘方向', '9.90', '零钱', '支付成功', 'X1', '']]
    const t = stageBill(db, { sourceType: 'csv', cells })
    try {
      applyBillPlan(db, { ...BASE_PLAN, table_id: t.id }, { sessionId: 's1' })
      throw new Error('应当整批退回')
    } catch (e) {
      expect((e as Error).message).toMatch(/神秘方向/)
      expect((e as Error).message).toMatch(/direction_column_values/)
    }
    expect(getBillTable(db, t.id)?.openRows).toBe(2)
  })

  it('账户列取值对不上账本 → 不静默落默认账户，退回要映射', () => {
    const db = mkDb()
    const t = staged(db)
    try {
      applyBillPlan(
        db,
        { ...BASE_PLAN, table_id: t.id, account_column_values: [{ contains: '零钱', account_name: '微信' }] },
        { sessionId: 's1' },
      )
      throw new Error('应当整批退回')
    } catch (e) {
      expect((e as Error).message).toMatch(/工商银行储蓄卡\(1234\)/)
      expect((e as Error).message).toMatch(/account_column_values/)
    }
    expect(getBillTable(db, t.id)?.openRows).toBe(5)
  })

  it('没指定交易时间列 → 直接拒（不许把整批记成今天）', () => {
    const db = mkDb()
    const t = staged(db)
    expect(() =>
      applyBillPlan(db, { ...BASE_PLAN, table_id: t.id, columns: { ...BASE_PLAN.columns, time: null } }, { sessionId: 's1' }),
    ).toThrow(/必须指定交易时间列/)
  })

  it('时间列选错（半数以上解析不出）→ 整批退回', () => {
    const db = mkDb()
    const t = staged(db)
    expect(() =>
      applyBillPlan(db, { ...BASE_PLAN, table_id: t.id, columns: { ...BASE_PLAN.columns, time: '商品' } }, { sessionId: 's1' }),
    ).toThrow(/解析不出来/)
    expect(getBillTable(db, t.id)?.openRows).toBe(5)
  })

  it('同一份材料不能二次消费（防重复入账）', () => {
    const db = mkDb()
    const t = staged(db)
    applyBillPlan(db, { ...BASE_PLAN, table_id: t.id }, { sessionId: 's1' })
    expect(() => applyBillPlan(db, { ...BASE_PLAN, table_id: t.id }, { sessionId: 's1' })).toThrow(/都处理过了/)
  })
})

describe('⑥ 大批量（模型不参与逐行搬运，行数不是瓶颈）', () => {
  it('1200 行材料：逐行金额与原表一致、行数分文不差', () => {
    const db = mkDb()
    const cells = [HEADER]
    for (let i = 0; i < 1200; i++) {
      cells.push([
        `2026-09-${String((i % 28) + 1).padStart(2, '0')} 10:00:00`,
        '餐饮美食',
        `商户${i}`,
        '/',
        '支出',
        `${(i % 97) + 1}.${String(i % 100).padStart(2, '0')}`,
        '零钱',
        '支付成功',
        `BULK-${i}`,
        '',
      ])
    }
    const t = stageBill(db, { sourceType: 'csv', cells })
    const r = applyBillPlan(db, { ...BASE_PLAN, table_id: t.id }, { sessionId: 's1' })
    expect(r.newCount).toBe(1200)
    const exec = executeBatch(db, r.gateId!)
    expect(exec?.completed).toHaveLength(1200)
    const sum = db.prepare("SELECT SUM(amount_cents) c, COUNT(*) n FROM transactions WHERE type='expense'").get() as {
      c: number
      n: number
    }
    let expectSum = 0
    for (let i = 0; i < 1200; i++) expectSum += ((i % 97) + 1) * 100 + (i % 100)
    expect(sum.n).toBe(1200)
    expect(sum.c).toBe(expectSum)
  })
})
