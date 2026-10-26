import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { expect, it } from 'vitest'
import { AccountsView } from '../src/renderer/src/views/AccountsView'

it('账户页有真实管理根与加载态，不再给占位屏或伪余额', () => {
  const markup = renderToStaticMarkup(createElement(AccountsView))
  expect(markup).toContain('data-testid="accounts-view"')
  expect(markup).toContain('data-testid="accounts-loading"')
  expect(markup).not.toContain('view-placeholder')
  expect(markup).not.toContain('账户 · 待实现')
  expect(markup).not.toContain('data-testid="account-balance"')
  expect(markup).toContain('不把流水当余额')
})
