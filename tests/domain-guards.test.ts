// 第 6 单 段1-1：域层状态护栏——历史快照/重复操作不得把已删账改活，重复确认/删除幂等不炸。
import { describe, expect, it } from 'vitest'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openSchemaDb } from './helpers'
import { seed } from '../src/main/db/seed'
import {
  createTransaction,
  recordParse,
  getOrCreateCategoryId,
  confirm,
  softDelete,
  restore,
  updateFields,
  getTransaction,
  auditChain,
} from '../src/main/domain/ledger'

function mkDb() {
  const db = openSchemaDb(join(mkdtempSync(join(tmpdir(), 'mz-guard-')), 'test.db'))
  seed(db)
  return db
}

// 建一笔已解析待确认的支出（needs_review 前置：parsed + 分类）
function mkReviewTx(db: ReturnType<typeof mkDb>): number {
  const cat = getOrCreateCategoryId(db, '餐饮', 'expense')
  const id = createTransaction(db, { amountCents: 1500, txType: 'expense', accountId: undefined, occurredAt: null })
  recordParse(db, id, { amountCents: 1500, txType: 'expense', categoryId: cat })
  return id
}

describe('第6单 段1 · 域层状态护栏', () => {
  it('对已删除交易 confirm 必须报错（不是悄悄改活）', () => {
    const db = mkDb()
    const id = mkReviewTx(db)
    confirm(db, id)
    softDelete(db, id)
    expect(getTransaction(db, id)?.state).toBe('deleted')
    expect(() => confirm(db, id)).toThrow(/已删除/)
    // 状态仍是 deleted——旧快照没能把它改活
    expect(getTransaction(db, id)?.state).toBe('deleted')
  })

  it('重复 confirm 幂等：不报错、不重复写 confirm 审计', () => {
    const db = mkDb()
    const id = mkReviewTx(db)
    confirm(db, id)
    const chainAfter1 = auditChain(db, id).filter((c) => c === 'confirm').length
    confirm(db, id) // 再确认一次
    const chainAfter2 = auditChain(db, id).filter((c) => c === 'confirm').length
    expect(chainAfter1).toBe(1)
    expect(chainAfter2).toBe(1)
    expect(getTransaction(db, id)?.state).toBe('confirmed')
  })

  it('重复 softDelete 幂等：只写一次 delete 审计', () => {
    const db = mkDb()
    const id = mkReviewTx(db)
    softDelete(db, id)
    softDelete(db, id)
    expect(auditChain(db, id).filter((c) => c === 'delete').length).toBe(1)
    expect(getTransaction(db, id)?.state).toBe('deleted')
  })

  it('restore 仅对 deleted 有效：未删的 restore 报错；重复 restore 报错', () => {
    const db = mkDb()
    const live = mkReviewTx(db)
    expect(() => restore(db, live)).toThrow(/未处于删除状态/)

    const id = mkReviewTx(db)
    confirm(db, id)
    softDelete(db, id)
    const target = restore(db, id)
    expect(target).toBe('confirmed')
    expect(getTransaction(db, id)?.state).toBe('confirmed')
    expect(() => restore(db, id)).toThrow(/未处于删除状态/) // 已恢复，再 restore 报错
  })

  it('updateFields 不得改已删除交易（须先恢复）', () => {
    const db = mkDb()
    const id = mkReviewTx(db)
    softDelete(db, id)
    expect(() => updateFields(db, id, { merchant: 'X' })).toThrow(/已删除/)
  })
})
