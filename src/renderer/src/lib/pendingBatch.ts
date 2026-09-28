// 待收尾面板纯逻辑（无 React 依赖，可单元测试）：
// 交易摘要行 + 同商户批量分组。

import type { PendingItemDTO } from '../../../shared/types'

/** 卡片摘要：如"麦当劳 ¥26.00 · 09-04"。无 txId 事项返回 null（保持原样）。 */
export function txSummary(it: PendingItemDTO): string | null {
  if (it.txId == null) return null
  if (!it.merchant && it.amountCents == null && !it.occurredAt) return null
  const parts: string[] = []
  if (it.merchant) parts.push(it.merchant)
  if (it.amountCents != null) parts.push(`¥${(it.amountCents / 100).toFixed(2)}`)
  if (it.occurredAt) parts.push(it.occurredAt.slice(5, 10))
  return parts.length > 0 ? parts.join(' · ') : null
}

export interface SameMerchantBatch {
  merchant: string
  gateIds: number[]
}

/**
 * 同商户批量条出现条件：同一分组内，相同商户（非空）且 field='confirm_record'
 * 的事项 ≥ 2 条时，为该商户出一批量条。batch_item / 无商户 / 单条都不出。
 */
export function groupSameMerchant(items: PendingItemDTO[]): SameMerchantBatch[] {
  const byMerchant = new Map<string, number[]>()
  for (const it of items) {
    if (it.field !== 'confirm_record') continue
    const m = (it.merchant ?? '').trim()
    if (!m) continue
    const list = byMerchant.get(m) ?? []
    list.push(it.gateId)
    byMerchant.set(m, list)
  }
  const out: SameMerchantBatch[] = []
  for (const [merchant, gateIds] of byMerchant) {
    if (gateIds.length > 1) out.push({ merchant, gateIds })
  }
  return out
}
