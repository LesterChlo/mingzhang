import type { Database } from 'better-sqlite3-multiple-ciphers'
import type { AccountSummaryDTO } from '../../shared/types'
import { listAccountOptions } from './ledger-page'

/** 纯读，沿用报告视图的 confirmed expense/income 口径；不计算余额。 */
export function listAccountSummaries(db: Database, month?: string): AccountSummaryDTO {
  const today = new Date()
  const selected = month === undefined
    ? `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}`
    : month
  if (typeof selected !== 'string' || selected.length !== 7 || !/^[0-9]{4}-(0[1-9]|1[0-2])$/.test(selected) || selected.startsWith('0000-')) {
    throw new Error('月份无效，请使用 YYYY-MM（01–12）')
  }
  const rows = db.prepare(
    'SELECT account_id,' +
      " COALESCE(SUM(CASE WHEN type='expense' THEN amount_cents ELSE 0 END),0) AS expense_cents," +
      " COALESCE(SUM(CASE WHEN type='income' THEN amount_cents ELSE 0 END),0) AS income_cents," +
      ' COUNT(*) AS n FROM v_reportable_transactions' +
      ' WHERE substr(occurred_at,1,7)=? GROUP BY account_id',
  ).all(selected) as { account_id: number; expense_cents: number; income_cents: number; n: number }[]
  const byAccount = new Map(rows.map(row => [row.account_id, row]))
  return {
    month: selected,
    accounts: listAccountOptions(db).map(account => {
      const totals = byAccount.get(account.id)
      return {
        ...account,
        expenseCents: Number(totals?.expense_cents ?? 0),
        incomeCents: Number(totals?.income_cents ?? 0),
        count: Number(totals?.n ?? 0),
      }
    }),
  }
}
