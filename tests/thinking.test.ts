// T0928 §4：思考正文累积与展开区三态的契约测试。
// 验收口径（工单原文）：vitest 覆盖累积 / 截断 / 空正文占位。

import { describe, expect, it } from 'vitest'
import { createElement, Fragment } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { appendThinkingDelta, THINK_TEXT_CAP, type ThinkingText } from '../src/renderer/src/lib/thinking'
import { ThinkFull } from '../src/renderer/src/views/AssistantPanel'

function html(node: Parameters<typeof renderToStaticMarkup>[0]): string {
  return renderToStaticMarkup(createElement(Fragment, null, node))
}

describe('思考正文累积（T0928 §4）', () => {
  it('增量按序追加拼成正文', () => {
    let cur: ThinkingText = { text: '', truncated: false }
    cur = appendThinkingDelta(cur, '先看列含义，')
    cur = appendThinkingDelta(cur, '再按商户分组')
    expect(cur).toEqual({ text: '先看列含义，再按商户分组', truncated: false })
  })

  it('超过上限截断到 THINK_TEXT_CAP 并标记 truncated', () => {
    const head = '甲'.repeat(THINK_TEXT_CAP - 10)
    let cur: ThinkingText = { text: head, truncated: false }
    cur = appendThinkingDelta(cur, '乙'.repeat(100))
    expect(cur.text.length).toBe(THINK_TEXT_CAP)
    expect(cur.text.endsWith('乙'.repeat(10))).toBe(true)
    expect(cur.truncated).toBe(true)
  })

  it('截断后到达的增量不再改变内容（保持前 N 字）', () => {
    let cur: ThinkingText = { text: '甲'.repeat(THINK_TEXT_CAP), truncated: true }
    const before = cur
    cur = appendThinkingDelta(cur, '后来的话')
    expect(cur).toBe(before)
    expect(cur.text.length).toBe(THINK_TEXT_CAP)
  })

  it('自定义上限同样生效', () => {
    let cur: ThinkingText = { text: 'ab', truncated: false }
    cur = appendThinkingDelta(cur, 'cdef', 4)
    expect(cur).toEqual({ text: 'abcd', truncated: true })
  })
})

describe('思考条展开区（T0928 §4）', () => {
  it('空正文 → 保留"未接"占位（不编内容）', () => {
    const out = html(createElement(ThinkFull, { text: '', truncated: false }))
    expect(out).toContain('思考全文通道未接（D-02）')
    expect(out).toContain('data-testid="panel-think-full"')
  })

  it('只有空白字符的正文 → 同样按空正文处理', () => {
    const out = html(createElement(ThinkFull, { text: '   \n  ', truncated: false }))
    expect(out).toContain('思考全文通道未接（D-02）')
  })

  it('有正文 → 渲染真实文本，不出占位', () => {
    const out = html(createElement(ThinkFull, { text: '先看列含义，再按商户分组', truncated: false }))
    expect(out).toContain('先看列含义，再按商户分组')
    expect(out).not.toContain('思考全文通道未接')
  })

  it('截断的正文 → 显示"只保留前 N 字"标记', () => {
    const out = html(createElement(ThinkFull, { text: '正文', truncated: true }))
    expect(out).toContain(`只保留前 ${THINK_TEXT_CAP} 字`)
    expect(out).toContain('正文')
  })
})
