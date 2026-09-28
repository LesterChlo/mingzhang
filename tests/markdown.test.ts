// T0928 §3：助手回复 Markdown 渲染器的契约测试（渲染器：src/renderer/src/lib/markdown.tsx）。
// 验收口径（工单原文）：
//   **加粗** → <strong>；- a 换行 - b → 列表；行内代码 → <code>；
//   安全用例：回复含 <img src=x onerror=…> / <script> → 按纯文本显示，页面无注入节点、无脚本执行。
// 这里用 renderToStaticMarkup 在 node 环境直接断言产物 HTML —— 产物是 React 节点树，
// 源文本一律走文本节点转义，不存在 innerHTML 拼接面（这也是安全用例能成立的机理）。

import { describe, expect, it } from 'vitest'
import { createElement, Fragment } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { renderMarkdown } from '../src/renderer/src/lib/markdown'

function html(src: string): string {
  // 不用 JSX（本文件 .ts、不进 tsconfig.web）：等价于 <>{renderMarkdown(src)}</>
  return renderToStaticMarkup(createElement(Fragment, null, renderMarkdown(src)))
}

describe('Markdown 渲染（T0928 §3）', () => {
  it('**加粗** → <strong>', () => {
    const out = html('这笔是 **重要支出** 别忘了')
    expect(out).toContain('<strong>重要支出</strong>')
  })

  it('*斜体* / _斜体_ → <em>', () => {
    expect(html('说 *慢一点*')).toContain('<em>慢一点</em>')
    expect(html('说 _慢一点_')).toContain('<em>慢一点</em>')
  })

  it('行内代码 → <code>，且内容不再被解析', () => {
    const out = html('命令是 `npm run **build**`')
    expect(out).toContain('<code class="mz-md-code">npm run **build**</code>')
  })

  it('代码块 → <pre><code>，内容一行都不解析', () => {
    const out = html('```\n- **不是列表也不是粗体**\n<img src=x>\n```')
    expect(out).toContain('<pre class="mz-md-pre"><code>')
    expect(out).toContain('- **不是列表也不是粗体**')
    expect(out).toContain('&lt;img src=x&gt;')
    expect(out).not.toContain('<img')
  })

  it('- a 换行 - b → 无序列表', () => {
    const out = html('- 餐饮\n- 交通')
    expect(out).toContain('<ul class="mz-md-list">')
    expect(out).toContain('<li>餐饮</li>')
    expect(out).toContain('<li>交通</li>')
  })

  it('1. a 换行 2. b → 有序列表；非 1 起始保留首项编号', () => {
    const out = html('1. 第一步\n2. 第二步')
    expect(out).toContain('<ol class="mz-md-list" start="1">')
    expect(out).toContain('<li>第一步</li>')
    const out2 = html('3. 接着来\n4. 最后')
    expect(out2).toContain('start="3"')
  })

  it('标题 → 标题标签（面板内压级：## → h5）', () => {
    const out = html('## 本月概览')
    expect(out).toContain('<h5 class="mz-md-h">本月概览</h5>')
  })

  it('http/https 链接 → <a target="_blank" rel="noreferrer">', () => {
    const out = html('见 [官方文档](https://example.com/docs) 这里')
    expect(out).toContain('href="https://example.com/docs"')
    expect(out).toContain('target="_blank"')
    expect(out).toContain('rel="noreferrer"')
    expect(out).toContain('>官方文档</a>')
  })

  it('非 http/https 链接（javascript: 等）不成链，按原文本显示', () => {
    const out = html('[点我](javascript:alert(1))')
    expect(out).not.toContain('<a ')
    expect(out).toContain('[点我](javascript:alert(1))')
  })

  it('安全：含 <img src=x onerror=…> 的回复按纯文本显示，无注入节点', () => {
    const out = html('看图 <img src=x onerror="alert(1)"> 完')
    // 没有 <img 标签节点；onerror 字样只是转义后的惰性文本（不会被解析为属性）
    expect(out).not.toContain('<img')
    expect(out).toContain('&lt;img src=x onerror=&quot;alert(1)&quot;&gt;')
  })

  it('安全：含 <script> 的回复按纯文本显示，无脚本节点', () => {
    const out = html('注意 <script>alert(1)</script> 完毕')
    expect(out).not.toContain('<script>')
    expect(out).toContain('&lt;script&gt;alert(1)&lt;/script&gt;')
  })

  it('普通多行文本：同段合并、分段成 <p>', () => {
    const out = html('第一行\n第二行\n\n新段落')
    expect(out).toContain('<p class="mz-md-p">第一行 第二行</p>')
    expect(out).toContain('<p class="mz-md-p">新段落</p>')
  })
})
