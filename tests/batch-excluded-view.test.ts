import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { expect, it } from 'vitest'
import { ExcludedRows } from '../src/renderer/src/views/BatchResultBar'

it('来源明细完整上屏且转义内容；旧缺明细null与完整零行分开', () => {
  const rows = [{ tableId: 2, rowNo: 4, sourceText: '<img src=x onerror=alert(1)>', merchant: '合成退回', amountCents: 825, occurredAt: '2026-06-02 10:00:00', reason: '按方案排除' }]
  const out = renderToStaticMarkup(createElement(ExcludedRows, { rows, count: 1 }))
  expect(out).toContain('data-testid="br-excluded-row"')
  expect(out).toContain('第 4 行')
  expect(out).toContain('合成退回')
  expect(out).toContain('8.25')
  expect(out).toContain('2026-06-02')
  expect(out).toContain('按方案排除')
  expect(out).toContain('&lt;img')
  expect(out).not.toContain('<img src=x')
  const old = renderToStaticMarkup(createElement(ExcludedRows, { rows: null, count: 3 }))
  expect(old).toContain('旧导入未保存逐行明细')
  expect(old).not.toContain('br-excluded-row"')
  const empty = renderToStaticMarkup(createElement(ExcludedRows, { rows: [], count: 0 }))
  expect(empty).toContain('这一批没有不计收支的行')
  expect(empty).not.toContain('旧导入未保存')
})
