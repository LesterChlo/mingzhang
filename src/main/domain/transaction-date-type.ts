import { createHash } from 'node:crypto'
import type { Database } from 'better-sqlite3-multiple-ciphers'
import type { TransactionDateTypeEditInput, TransactionEditFormDTO } from '../../shared/types'
import { nowIso } from '../db/time'
import { snapshot, writeAudit } from './ledger'

function assertTxId(txId: unknown): asserts txId is number {
  if (!Number.isSafeInteger(txId) || (txId as number) <= 0) throw new Error('交易编号无效')
}

function versionFor(
  tx: Record<string, unknown>,
  audit: Record<string, unknown> | undefined,
  account: Record<string, unknown>,
  category: Record<string, unknown> | undefined,
  toAccount: Record<string, unknown> | undefined,
): string {
  const value = JSON.stringify({ tx, auditId: audit?.id ?? null, account, category: category ?? null, toAccount: toAccount ?? null })
  return `txedit-v1:${createHash('sha256').update(value).digest('hex')}`
}

/** Read-only edit-form snapshot. The token includes the transaction, audit anchor, and referenced facts. */
export function getTransactionEditForm(db: Database, txId: number): TransactionEditFormDTO | null {
  assertTxId(txId)
  const tx = db.prepare('SELECT * FROM transactions WHERE id=?').get(txId) as Record<string, unknown> | undefined
  if (!tx) return null
  const accountId = Number(tx.account_id)
  const account = db.prepare('SELECT * FROM accounts WHERE id=?').get(accountId) as Record<string, unknown> | undefined
  if (!account) throw new Error('交易关联账户不存在')
  const categoryId = tx.category_id == null ? null : Number(tx.category_id)
  const category = categoryId == null
    ? undefined
    : db.prepare('SELECT * FROM categories WHERE id=?').get(categoryId) as Record<string, unknown> | undefined
  const toAccountId = tx.to_account_id == null ? null : Number(tx.to_account_id)
  const toAccount = toAccountId == null
    ? undefined
    : db.prepare('SELECT * FROM accounts WHERE id=?').get(toAccountId) as Record<string, unknown> | undefined
  const audit = db.prepare(
    "SELECT id FROM audit_log WHERE entity_type='transaction' AND entity_id=? ORDER BY id DESC LIMIT 1",
  ).get(txId) as Record<string, unknown> | undefined
  return {
    txId: Number(tx.id),
    version: versionFor(tx, audit, account, category, toAccount),
    occurredAt: String(tx.occurred_at),
    txType: String(tx.type) as TransactionEditFormDTO['txType'],
    state: String(tx.state),
    categoryId,
    accountId,
    toAccountId,
  }
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function assertExactKeys(value: Record<string, unknown>, allowed: readonly string[], label: string): void {
  const unknown = Object.keys(value).filter((key) => !allowed.includes(key))
  if (unknown.length > 0) throw new Error(`${label}包含未知字段：${unknown.join(', ')}`)
}

function isLeapYear(year: number): boolean {
  return year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0)
}

/** Strictly validate a supported user-entered calendar value without Date rollover. */
function assertOccurredAt(value: unknown): asserts value is string {
  if (typeof value !== 'string') throw new Error('发生时间必须是字符串')
  const match = /^(\d{4})-(\d{2})-(\d{2})(?:([ T])(\d{2}):(\d{2})(?::(\d{2}))?(Z|[+-]\d{2}:\d{2})?)?$/.exec(value)
  if (!match) throw new Error('发生时间格式无效')
  const [, yearText, monthText, dayText, separator, hourText, minuteText, secondText, offset] = match
  const year = Number(yearText)
  const month = Number(monthText)
  const day = Number(dayText)
  const hour = hourText === undefined ? 0 : Number(hourText)
  const minute = minuteText === undefined ? 0 : Number(minuteText)
  const second = secondText === undefined ? 0 : Number(secondText)
  const days = [31, isLeapYear(year) ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31]
  if (month < 1 || month > 12 || day < 1 || day > days[month - 1]) throw new Error('发生日期不存在')
  if (hour > 23 || minute > 59 || second > 59) throw new Error('发生时间超出有效范围')
  if (separator === ' ' && offset) throw new Error('本地时间格式不能带时区后缀')
  if (offset && offset !== 'Z') {
    const offsetHour = Number(offset.slice(1, 3))
    const offsetMinute = Number(offset.slice(4, 6))
    if (offsetHour > 23 || offsetMinute > 59) throw new Error('时区偏移无效')
  }
}

function validateInput(input: unknown): asserts input is TransactionDateTypeEditInput {
  if (!isPlainRecord(input)) throw new Error('日期与类型编辑参数无效')
  assertExactKeys(input, ['txId', 'expectedVersion', 'fields'], '编辑参数')
  assertTxId(input.txId)
  if (typeof input.expectedVersion !== 'string' || input.expectedVersion.length === 0) throw new Error('编辑版本缺失')
  if (!isPlainRecord(input.fields)) throw new Error('编辑字段无效')
  const fields = input.fields
  assertExactKeys(fields, ['occurredAt', 'txType', 'categoryId'], '编辑字段')
  const keys = Object.keys(fields)
  if (keys.length === 0) throw new Error('没有要改的字段')
  if (Object.hasOwn(fields, 'occurredAt')) assertOccurredAt(fields.occurredAt)
  if (Object.hasOwn(fields, 'txType') && fields.txType !== 'expense' && fields.txType !== 'income') {
    throw new Error('收支类型只支持支出或收入')
  }
  if (Object.hasOwn(fields, 'categoryId')) {
    const id = fields.categoryId
    if (id !== null && (!Number.isSafeInteger(id) || (id as number) <= 0)) throw new Error('分类编号无效')
  }
}

/** Atomically apply the user's date/type/category edit with optimistic concurrency and audit. */
export function applyTransactionDateTypeEdit(db: Database, input: TransactionDateTypeEditInput): TransactionEditFormDTO {
  validateInput(input)
  const { txId, expectedVersion, fields } = input

  const apply = db.transaction(() => {
    const form = getTransactionEditForm(db, txId)
    if (!form) throw new Error(`交易 #${txId} 不存在`)
    if (form.version !== expectedVersion) throw new Error('交易已变化，请重新读取后再试')
    if (form.state === 'deleted') throw new Error('这笔已删除，请先恢复再修改')

    const tx = db.prepare('SELECT * FROM transactions WHERE id=?').get(txId) as Record<string, unknown> | undefined
    if (!tx) throw new Error(`交易 #${txId} 不存在`)
    const oldType = String(tx.type)
    const nextType = fields.txType ?? oldType
    const oldCategoryId = tx.category_id == null ? null : Number(tx.category_id)
    const nextCategoryId = Object.hasOwn(fields, 'categoryId') ? fields.categoryId! : oldCategoryId
    const nextOccurredAt = Object.hasOwn(fields, 'occurredAt') ? fields.occurredAt! : String(tx.occurred_at)

    if (oldType !== 'expense' && oldType !== 'income') {
      if (Object.hasOwn(fields, 'txType') || Object.hasOwn(fields, 'categoryId')) {
        throw new Error('转账或调整只能修改发生时间')
      }
    } else {
      if (nextType !== 'expense' && nextType !== 'income') throw new Error('收支类型无效')
      if (fields.txType !== undefined && fields.txType !== oldType && nextCategoryId == null) {
        throw new Error('变更收支类型必须选择对应方向的分类')
      }
      if (nextCategoryId != null) {
        const category = db.prepare('SELECT id, kind FROM categories WHERE id=?').get(nextCategoryId) as
          | { id: number; kind: string }
          | undefined
        if (!category || category.kind !== nextType) throw new Error('所选分类与收支方向不匹配')
      }
      if (form.state === 'confirmed' && nextCategoryId == null) throw new Error('已确认收支必须保留对应方向的分类')
    }

    if (nextOccurredAt === String(tx.occurred_at) && nextType === oldType && nextCategoryId === oldCategoryId) return form

    const before = snapshot(db, txId)
    db.prepare('UPDATE transactions SET occurred_at=?, type=?, category_id=?, updated_at=? WHERE id=?')
      .run(nextOccurredAt, nextType, nextCategoryId, nowIso(), txId)
    writeAudit(db, {
      entity_type: 'transaction',
      entity_id: txId,
      changed_by: 'user',
      change_type: 'update',
      before_value: before,
      after_value: snapshot(db, txId),
      source_message_id: (tx.source_message_id as string | null) ?? null,
      reasoning: '用户在账本详情修改发生时间或收支类型',
    })
    const result = getTransactionEditForm(db, txId)
    if (!result) throw new Error(`交易 #${txId} 不存在`)
    return result
  })

  // The local SQLite declaration exposes transaction() as void-returning despite preserving callback results at runtime.
  return (apply as unknown as () => TransactionEditFormDTO)()
}

export type { TransactionDateTypeEditInput }
