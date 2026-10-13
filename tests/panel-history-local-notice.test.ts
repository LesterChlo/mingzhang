import { it, expect } from 'vitest'
import { panelItemsFromHistory } from '../src/renderer/src/lib/panelHistory'

it('本地失败历史显示为发送记录，不冒充模型答复，保真实原因', () => {
  const rows = panelItemsFromHistory([
    { id: 'failed-user', role: 'user', text: '没有发给模型' },
    { id: 'failed-notice', role: 'assistant', text: '本地发送失败（未送达模型）：No API key', isError: true },
    { id: 'normal', role: 'assistant', text: '真实正常答复' },
  ])
  expect(rows[1]).toMatchObject({ kind: 'notice', text: '本地发送失败（未送达模型）：No API key' })
  expect(rows[2]).toMatchObject({ kind: 'assistant', text: '真实正常答复' })
  expect(rows.filter(row => row.kind === 'assistant')).toHaveLength(1)
})
