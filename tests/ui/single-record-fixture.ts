import { expect, type Page } from '@playwright/test'

/** 单笔夹具必须经过用户确认门；不通过补答或直接改状态制造正式账。 */
export async function confirmSingleRecord(page: Page, merchant: string): Promise<number> {
  await page.getByTestId('nav-inbox').click()
  const card = page.locator('[data-testid="inbox-card"][data-kind="confirm_record"]').filter({ hasText: merchant })
  await expect(card).toHaveCount(1)
  const pending = await page.evaluate(async name => {
    const ledger = await window.mz.listLedger({ state: 'needs_review', limit: 100 })
    return ledger.items.find(t => t.merchant === name)
  }, merchant)
  expect(pending, '确认前必须是真实待核对交易').toBeTruthy()
  expect(pending!.state).toBe('needs_review')
  await card.getByTestId('inbox-confirm').click()
  await expect(card).toHaveCount(0)
  await expect.poll(async () => {
    const rows = await page.evaluate(() => window.mz.listLedger({ state: 'confirmed', limit: 100 }))
    return rows.items.find(t => t.id === pending!.id)?.state
  }).toBe('confirmed')
  return pending!.id
}
