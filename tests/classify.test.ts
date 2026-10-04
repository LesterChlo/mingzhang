// D-01 批量归类（引擎＋IPC，两段式确认门）。
//
// 这个文件守住的是**最硬的一条红线**：建议（classify_suggest / buildClassifyProposal）只读不写，
// 落方案（classify_batch / prepareClassify）只落 gate 不写账，
// 真正的入账只发生在用户点确认之后（applyClassify），并且能整体撤销（undoClassify）。
//
// 口径（计划书 §3）：
//   待分类集合 = state='needs_review' AND category_id IS NULL AND type IN ('expense','income')
//   建议来源   = 用户规则(matchRule，纯读) ＞ 常识表(matchBuiltinCategory，纯读)
//   ——**绝不**用 classifyByMerchant（它内部 getOrCreateCategoryId + bumpHit 会写库）。
import { describe, expect, it } from 'vitest'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openSchemaDb } from './helpers'
import * as toolsM5 from '../src/main/engine/tools-m5'
import type { ClassifyGroupDTO, ClassifyProposalDTO } from '../src/shared/types'
import { seed } from '../src/main/db/seed'
import {
  applyClassify,
  buildClassifyProposal,
  prepareClassify,
  undoClassify,
} from '../src/main/domain/classify'
import {
  confirm as confirmTx,
  createTransaction,
  findCategoryId,
  getOrCreateCategoryId,
  requestReview,
  updateFields,
} from '../src/main/domain/ledger'
import { createPending, getPending } from '../src/main/domain/pending'
import { answerPending } from '../src/main/domain/pending-answer'
import { createRule } from '../src/main/domain/rules'

/** 临时数据目录里的账本（绝不碰真实 %APPDATA%\mingzhang）。 */
function tmpFile(): string {
  return join(mkdtempSync(join(tmpdir(), 'mz-cls-')), 'test.db')
}

function mkDb(file: string) {
  const db = openSchemaDb(file)
  seed(db)
  return db
}

/** 造一笔「待分类」：needs_review + 无分类 + 挂一条 confirm_record 待办（与批次入账同形）。 */
function mkPending(db: ReturnType<typeof openSchemaDb>, merchant: string | null, amountCents: number): number {
  const txId = createTransaction(db, { amountCents, txType: 'expense', merchant, changedBy: 'llm' })
  requestReview(db, txId, { reason: '分类未定' })
  createPending(db, {
    txId,
    sessionId: 's1',
    field: 'confirm_record',
    question: '分类未定，待确认',
    payload: { txId, reason: '分类未定' },
  })
  return txId
}

function rowOf(db: ReturnType<typeof openSchemaDb>, txId: number): { category_id: number | null; state: string } {
  return db.prepare('SELECT category_id, state FROM transactions WHERE id=?').get(txId) as {
    category_id: number | null
    state: string
  }
}

function catName(db: ReturnType<typeof openSchemaDb>, txId: number): string | null {
  const r = db.prepare('SELECT category_id FROM transactions WHERE id=?').get(txId) as { category_id: number | null }
  if (r.category_id === null) return null
  return (db.prepare('SELECT name FROM categories WHERE id=?').get(r.category_id) as { name: string }).name
}

describe('D-01 批量归类 · 建议（纯读分组）', () => {
  it('① 分组：同商户聚一组，无商户单列一组，已入账的不得进 proposal', () => {
    const db = mkDb(tmpFile())
    const a = mkPending(db, '星巴克', 3500)
    const b = mkPending(db, '星巴克', 4200)
    const c = mkPending(db, null, 1200)
    // 已入账（有分类）的一笔：不在待分类集合里
    const done = createTransaction(db, { amountCents: 999, txType: 'expense', merchant: '星巴克' })
    const doneCat = getOrCreateCategoryId(db, '餐饮', 'expense', { changedBy: 'user' })
    updateFields(db, done, { category_id: doneCat })
    confirmTx(db, done)

    const p = buildClassifyProposal(db)

    expect(p.pendingCount).toBe(3)
    expect(p.groups).toHaveLength(2)
    // 排序：count 降序 → 星巴克(2) 在前
    expect(p.groups[0].groupKey).toBe('expense::星巴克')
    expect(p.groups[0].merchant).toBe('星巴克')
    expect(p.groups[0].txType).toBe('expense')
    expect(p.groups[0].txIds).toEqual([a, b].sort((x, y) => x - y))
    expect(p.groups[0].count).toBe(2)
    expect(p.groups[0].totalCents).toBe(7700)

    const unlabeled = p.groups[1]
    expect(unlabeled.groupKey).toBe('expense::__unlabeled__')
    expect(unlabeled.merchant).toBeNull()
    expect(unlabeled.txIds).toEqual([c])
    expect(unlabeled.count).toBe(1)
    expect(unlabeled.totalCents).toBe(1200)

    // 已入账那笔不在任何组里
    expect(p.groups.flatMap((g) => g.txIds)).not.toContain(done)
    expect(p.batchId).toBeNull()
  })

  it('② 建议优先级：规则 ＞ 常识表 ＞ 都没有（null）', () => {
    const db = mkDb(tmpFile())
    mkPending(db, '星巴克', 3500)
    mkPending(db, null, 1200)

    // 无用户规则 → 常识表兜底
    let p = buildClassifyProposal(db)
    expect(p.groups.find((g) => g.merchant === '星巴克')!.suggestedCategory).toBe('餐饮')
    expect(p.groups.find((g) => g.merchant === '星巴克')!.suggestionSource).toBe('builtin')
    // 商户 null → 常识表与规则都命中不了
    const un = p.groups.find((g) => g.merchant === null)!
    expect(un.suggestedCategory).toBeNull()
    expect(un.suggestionSource).toBeNull()

    // 建一条用户规则 → 规则优先于常识表
    createRule(db, { match: 'merchant', op: 'contains', value: '星巴克' }, { set_category: '咖啡' })
    p = buildClassifyProposal(db)
    const sb = p.groups.find((g) => g.merchant === '星巴克')!
    expect(sb.suggestedCategory).toBe('咖啡')
    expect(sb.suggestionSource).toBe('rule')
  })

  it('③ 纯读证明：proposal 前后四张表行数与 rules.hit_count 完全不变', () => {
    const db = mkDb(tmpFile())
    mkPending(db, '星巴克', 3500)
    mkPending(db, '全家', 800)
    mkPending(db, null, 1200)
    createRule(db, { match: 'merchant', op: 'contains', value: '星巴克' }, { set_category: '咖啡' })

    const count = (sql: string): number => (db.prepare(sql).get() as { n: number }).n
    const before = {
      tx: count('SELECT COUNT(*) AS n FROM transactions'),
      cat: count('SELECT COUNT(*) AS n FROM categories'),
      pend: count('SELECT COUNT(*) AS n FROM pending_clarifications'),
      rules: db.prepare('SELECT id, hit_count FROM rules ORDER BY id').all(),
    }

    buildClassifyProposal(db)
    buildClassifyProposal(db, { batchId: 'batch-不存在' })

    expect(count('SELECT COUNT(*) AS n FROM transactions')).toBe(before.tx)
    expect(count('SELECT COUNT(*) AS n FROM categories')).toBe(before.cat)
    expect(count('SELECT COUNT(*) AS n FROM pending_clarifications')).toBe(before.pend)
    expect(db.prepare('SELECT id, hit_count FROM rules ORDER BY id').all()).toEqual(before.rules)
  })
})

describe('D-01 批量归类 · 落方案（绝不写账）', () => {
  it('④ prepare 只落 gate：逐笔 category_id/state 不变；未知分组抛错', () => {
    const db = mkDb(tmpFile())
    const a = mkPending(db, '星巴克', 3500)
    const b = mkPending(db, null, 1200)
    const before = [rowOf(db, a), rowOf(db, b)]

    const p = buildClassifyProposal(db)
    const starGroup = p.groups.find((g) => g.merchant === '星巴克')!
    const res = prepareClassify(db, {
      assignments: [
        { groupKey: starGroup.groupKey, categoryName: '餐饮' },
        { groupKey: 'expense::__unlabeled__', categoryName: '其他' },
      ],
      sessionId: 's1',
    })

    expect(res.classifyId).toMatch(/^cls-/)
    expect(typeof res.gateId).toBe('number')
    expect(res.plan.groups.map((g) => g.categoryName)).toEqual(['餐饮', '其他'])
    expect(res.plan.groups.map((g) => g.groupKey)).toEqual([starGroup.groupKey, 'expense::__unlabeled__'])

    // 交易逐笔没动
    expect([rowOf(db, a), rowOf(db, b)]).toEqual(before)

    // gate 落库
    const gate = getPending(db, res.gateId)!
    expect(gate.field).toBe('batch_classify')
    expect(gate.status).toBe('open')
    const payload = JSON.parse(gate.payload) as { classifyId: string; groups: { groupKey: string; categoryName: string }[] }
    expect(payload.classifyId).toBe(res.classifyId)
    expect(payload.groups.map((g) => g.groupKey)).toContain(starGroup.groupKey)

    // 未知分组 → 直接抛错
    expect(() =>
      prepareClassify(db, { assignments: [{ groupKey: 'expense::不存在的商户', categoryName: '餐饮' }], sessionId: 's1' }),
    ).toThrow(/未知分组/)
    // 空分类名 → 抛错
    expect(() =>
      prepareClassify(db, { assignments: [{ groupKey: starGroup.groupKey, categoryName: '   ' }], sessionId: 's1' }),
    ).toThrow()
  })
})

describe('D-01 批量归类 · 执行与撤销', () => {
  it('⑤ apply 写入：逐笔确认+分类、待办全关、审计按 classifyId 可查', () => {
    const db = mkDb(tmpFile())
    const a = mkPending(db, '星巴克', 3500)
    const b = mkPending(db, '星巴克', 4200)
    const c = mkPending(db, null, 1200)
    const p = buildClassifyProposal(db)
    const starGroup = p.groups.find((g) => g.merchant === '星巴克')!
    const { gateId, classifyId } = prepareClassify(db, {
      assignments: [
        { groupKey: starGroup.groupKey, categoryName: '餐饮' },
        { groupKey: 'expense::__unlabeled__', categoryName: '其他' },
      ],
      sessionId: 's1',
    })

    const result = applyClassify(db, gateId)
    expect(result).not.toBeNull()
    expect(result!.classifyId).toBe(classifyId)
    expect(result!.gateId).toBe(gateId)
    expect(result!.appliedCount).toBe(3)
    expect(result!.skipped).toEqual([])
    expect(result!.appliedGroups).toEqual([
      { merchant: '星巴克', categoryName: '餐饮', count: 2 },
      { merchant: null, categoryName: '其他', count: 1 },
    ])

    for (const id of [a, b]) {
      expect(catName(db, id)).toBe('餐饮')
      expect(rowOf(db, id).state).toBe('confirmed')
    }
    expect(catName(db, c)).toBe('其他')
    expect(rowOf(db, c).state).toBe('confirmed')

    // 三笔的 confirm_record 待办全关
    const open = db
      .prepare("SELECT COUNT(*) AS n FROM pending_clarifications WHERE field='confirm_record' AND status='open'")
      .get() as { n: number }
    expect(open.n).toBe(0)

    // gate 收口 + 幂等
    expect(getPending(db, gateId)!.status).toBe('resolved')
    expect(applyClassify(db, gateId)).toBeNull()

    // 审计可按 source_message_id=classifyId 定位到每一笔
    const audited = db
      .prepare("SELECT DISTINCT entity_id AS id FROM audit_log WHERE entity_type='transaction' AND source_message_id=?")
      .all(classifyId) as { id: number }[]
    expect(audited.map((r) => r.id).sort((x, y) => x - y)).toEqual([a, b, c].sort((x, y) => x - y))
  })

  it('⑥ rows 覆盖：用户改选后的分类为准（不是方案里那个）', () => {
    const db = mkDb(tmpFile())
    const a = mkPending(db, '星巴克', 3500)
    mkPending(db, null, 1200)
    const p = buildClassifyProposal(db)
    const starGroup = p.groups.find((g) => g.merchant === '星巴克')!
    const { gateId } = prepareClassify(db, {
      assignments: [{ groupKey: starGroup.groupKey, categoryName: '餐饮' }],
      sessionId: 's1',
    })

    // 分类必须已存在；覆写不能偷偷新建分类。
    getOrCreateCategoryId(db, '咖啡茶饮', 'expense', { changedBy: 'user' })
    const result = applyClassify(db, gateId, [{ groupKey: starGroup.groupKey, categoryName: '咖啡茶饮' }])
    expect(result!.appliedCount).toBe(1)
    expect(catName(db, a)).toBe('咖啡茶饮')
    expect(findCategoryId(db, '咖啡茶饮', 'expense')).not.toBeNull()
  })

  it('⑦ undo 回到 needs_review + 待办重建；重复撤销幂等', () => {
    const db = mkDb(tmpFile())
    const a = mkPending(db, '星巴克', 3500)
    const b = mkPending(db, '星巴克', 4200)
    const c = mkPending(db, null, 1200)
    const p = buildClassifyProposal(db)
    const starGroup = p.groups.find((g) => g.merchant === '星巴克')!
    const { gateId, classifyId } = prepareClassify(db, {
      assignments: [
        { groupKey: starGroup.groupKey, categoryName: '餐饮' },
        { groupKey: 'expense::__unlabeled__', categoryName: '其他' },
      ],
      sessionId: 's1',
    })
    applyClassify(db, gateId)

    const undo = undoClassify(db, classifyId)
    expect(undo.classifyId).toBe(classifyId)
    expect(undo.revertedCount).toBe(3)
    expect(undo.skipped).toEqual([])
    for (const id of [a, b, c]) {
      expect(rowOf(db, id)).toEqual({ category_id: null, state: 'needs_review' })
      const open = db
        .prepare("SELECT COUNT(*) AS n FROM pending_clarifications WHERE tx_id=? AND field='confirm_record' AND status='open'")
        .get(id) as { n: number }
      expect(open.n).toBe(1)
    }

    // 幂等：再撤一次不再回退
    const again = undoClassify(db, classifyId)
    expect(again.revertedCount).toBe(0)
    expect(again.skipped.length).toBe(3)
    expect(rowOf(db, a).state).toBe('needs_review')
  })

  it('⑧ undo 保护：这之后被改过的笔不撤销，其余照撤', () => {
    const db = mkDb(tmpFile())
    const a = mkPending(db, '星巴克', 3500)
    const b = mkPending(db, '星巴克', 4200)
    const c = mkPending(db, null, 1200)
    const p = buildClassifyProposal(db)
    const starGroup = p.groups.find((g) => g.merchant === '星巴克')!
    const { gateId, classifyId } = prepareClassify(db, {
      assignments: [
        { groupKey: starGroup.groupKey, categoryName: '餐饮' },
        { groupKey: 'expense::__unlabeled__', categoryName: '其他' },
      ],
      sessionId: 's1',
    })
    applyClassify(db, gateId)

    // 事后手工改了 a 的分类（这条审计不带 classifyId）
    const other = getOrCreateCategoryId(db, '购物', 'expense', { changedBy: 'user' })
    updateFields(db, a, { category_id: other }, { reasoning: '用户手工改的' })

    const undo = undoClassify(db, classifyId)
    expect(undo.revertedCount).toBe(2)
    expect(undo.skipped).toEqual([{ txId: a, reason: expect.stringContaining('未撤销') }])
    // a 保持用户改的分类与已入账状态
    expect(catName(db, a)).toBe('购物')
    expect(rowOf(db, a).state).toBe('confirmed')
    // b / c 回到待分类
    expect(rowOf(db, b)).toEqual({ category_id: null, state: 'needs_review' })
    expect(rowOf(db, c)).toEqual({ category_id: null, state: 'needs_review' })
  })

  it('⑨ 空态与非法 gate：空库 proposal 为空；applyClassify(99999) → null', () => {
    const db = mkDb(tmpFile())
    const p = buildClassifyProposal(db)
    expect(p.pendingCount).toBe(0)
    expect(p.groups).toEqual([])
    expect(applyClassify(db, 99999)).toBeNull()

    // 按批次过滤：非本批的一笔都不进 proposal
    const mine = mkPending(db, '星巴克', 3500)
    db.prepare('UPDATE transactions SET source_message_id=? WHERE id=?').run('batch-A', mine)
    const other = mkPending(db, '全家', 800)
    db.prepare('UPDATE transactions SET source_message_id=? WHERE id=?').run('batch-B', other)
    const scoped = buildClassifyProposal(db, { batchId: 'batch-A' })
    expect(scoped.batchId).toBe('batch-A')
    expect(scoped.pendingCount).toBe(1)
    expect(scoped.groups[0].txIds).toEqual([mine])
  })

  it('⑩ 门不可被对话关闭：对 batch_classify 门用补答作答 → 抛错，门仍 open、账未动', () => {
    const db = mkDb(tmpFile())
    const a = mkPending(db, '星巴克', 3500)
    const p = buildClassifyProposal(db)
    const { gateId } = prepareClassify(db, {
      assignments: [{ groupKey: p.groups[0].groupKey, categoryName: '餐饮' }],
      sessionId: 's1',
    })

    // 模型侧补答（对话/面板都算）必须被拒——归类门只能由用户点按钮
    expect(() => answerPending(db, gateId, '确认', { sessionId: 's1', via: 'chat' })).toThrow(
      /只能由用户在界面上点按钮/,
    )
    expect(getPending(db, gateId)?.status).toBe('open') // 门没被悄悄关掉
    expect(rowOf(db, a)).toEqual({ category_id: null, state: 'needs_review' }) // 账没动

    // 用户点确认后照常执行
    expect(applyClassify(db, gateId)?.appliedCount).toBe(1)
  })
})

// classify_suggest 的**模型可见文本**（D-01 两段式的接缝，②B 验收查出的断点）。
//
// 为什么单独锁这一段文本：`details` 不进模型上下文（pi-ai 的 openai-completions
// 只把 content 里的文本块喂给模型，已实测），所以 group_key 只能出现在这段文本里，
// 模型才可能回填 classify_batch 的 assignments。文本里没有键 = 两步式在真机上等于断了。
describe('classify_suggest 模型可见文本', () => {
  it('① 有建议的组：group_key 与建议分类逐字可见', () => {
    const db = mkDb(tmpFile())
    mkPending(db, '星巴克咖啡', 3500)
    // 常识表把星巴克系归「餐饮」；这里要断言的是「建议分类=咖啡」，
    // 所以按建议优先级（规则 ＞ 常识表）先教一条用户规则——不是改断言迁就实现。
    createRule(db, { match: 'merchant', op: 'contains', value: '星巴克咖啡' }, { set_category: '咖啡' })

    const text = toolsM5.formatClassifySuggest(buildClassifyProposal(db))

    expect(text).toContain('- group_key=expense::星巴克咖啡')
    expect(text).toContain('1 笔')
    expect(text).toContain('建议分类=咖啡')
    expect(text).toContain('¥35.00')
  })

  it('② 没把握的组：明写「无建议，请自行判断」（留空模型会当成缺字段自己编一个）', () => {
    const db = mkDb(tmpFile())
    mkPending(db, '小明', 1200) // 常识表与规则都命中不了

    const p = buildClassifyProposal(db)
    const g = p.groups[0]
    expect(g.suggestedCategory, '夹具前提不成立：小明本该没有建议').toBeNull()

    const text = toolsM5.formatClassifySuggest(p)

    expect(text).toContain(`- group_key=${g.groupKey}`)
    expect(text).toContain('（无建议，请自行判断）')
  })

  it('③ 每一个分组的键都在（逐个断言，不是只数个数）', () => {
    const db = mkDb(tmpFile())
    mkPending(db, '星巴克', 3500)
    mkPending(db, '全家', 800)
    mkPending(db, '小明', 1200)

    const p = buildClassifyProposal(db)
    expect(p.groups).toHaveLength(3)

    const text = toolsM5.formatClassifySuggest(p)

    for (const g of p.groups) {
      expect(text, `分组 ${g.groupKey} 的键没进模型可见文本`).toContain(`- group_key=${g.groupKey}`)
    }
  })

  it('④ 超过上限：截断到前 limit 组并说清口径（第 limit+1 组不许出现）', () => {
    const mk = (merchant: string, cents: number, category: string | null): ClassifyGroupDTO => ({
      groupKey: `expense::${merchant}`,
      merchant,
      txType: 'expense',
      txIds: [1],
      count: 1,
      totalCents: cents,
      suggestedCategory: category,
      suggestionSource: category ? 'builtin' : null,
    })
    const p: ClassifyProposalDTO = {
      proposalVersion: 'synthetic-format-only',
      generatedAt: '2026-01-01T00:00:00.000Z',
      batchId: null,
      pendingCount: 4,
      groups: [mk('甲', 100, '餐饮'), mk('乙', 200, '餐饮'), mk('丙', 300, '餐饮'), mk('丁', 400, null)],
    }

    const text = toolsM5.formatClassifySuggest(p, 3)

    expect(text).toContain('- group_key=expense::甲')
    expect(text).toContain('- group_key=expense::乙')
    expect(text).toContain('- group_key=expense::丙')
    expect(text, '第 4 组不该出现在截断后的清单里').not.toContain('expense::丁')
    expect(text).toContain('共 4 组')
    expect(text).toContain('只列出前 3 组')
  })

  it('⑤ 空集：不编键、不提 classify_batch', () => {
    const db = mkDb(tmpFile())
    const p = buildClassifyProposal(db)
    expect(p.groups).toEqual([])

    const text = toolsM5.formatClassifySuggest(p)

    expect(text).toContain('没有待分类的账目。')
    expect(text, '没有分组却编出了 group_key').not.toContain('group_key')
    expect(text, '没有分组却教模型去调 classify_batch').not.toContain('classify_batch')
  })
})
