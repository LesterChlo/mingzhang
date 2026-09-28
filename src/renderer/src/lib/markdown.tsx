// 助手回复的 Markdown 渲染（T0928 §3：程序兜底，提示词规范由主线在后端单落地）。
//
// 安全模型（工单硬要求，一条都不许松）：
//   - **不做 HTML 转义拼接** —— 输出的是 React 节点树，源文本一律进文本节点，
//     由 React 负责转义：`<img onerror=…>` / `<script>` 这类输入天生按纯文本显示，
//     不存在"先转义再白名单套标签"的拼接面，也没有 innerHTML / dangerouslySetInnerHTML。
//   - 白名单语法只有：粗体 / 斜体 / 行内代码 / 代码块 / 有序无序列表 / 标题 / 链接。
//   - 链接只放行 http/https，强制 target="_blank" rel="noreferrer"；
//     其余协议（javascript: 等）按原样文本显示，不成链。
//   - 零新依赖：自研小渲染器（本文件即全部），不引 Markdown 库。
//
// 解析取向：行级块解析 + 行内扁平扫描。**刻意不做嵌套语法**（粗斜体套叠、链接套格式）——
// 助手回复用得到的是扁平结构，可预期 > 功能全。

import { createElement, Fragment } from 'react'
import type { ReactNode } from 'react'

/** 行内 token：`行内代码`、**粗体**、*斜体*、_斜体_、[文字](链接)。顺序即优先级（代码最先，免被再解析）。 */
const INLINE_RE = /(`[^`\n]+`)|(\*\*[^*\n]+\*\*)|(\*[^*\n]+\*)|(_[^_\n]+_)|(\[[^\]\n]+\]\([^)\n]+\))/g
const LINK_RE = /^\[([^\]\n]+)\]\(([^)\n]+)\)$/

function renderInline(text: string, keyPrefix: string): ReactNode[] {
  const out: ReactNode[] = []
  let last = 0
  let n = 0
  for (const m of text.matchAll(INLINE_RE)) {
    const at = m.index ?? 0
    if (at > last) out.push(text.slice(last, at))
    const tok = m[0]
    const key = `${keyPrefix}-${n++}`
    if (m[1]) {
      // 行内代码：内容不再解析
      out.push(
        createElement('code', { key, className: 'mz-md-code' }, tok.slice(1, -1)),
      )
    } else if (m[2]) {
      out.push(createElement('strong', { key }, tok.slice(2, -2)))
    } else if (m[3] || m[4]) {
      out.push(createElement('em', { key }, tok.slice(1, -1)))
    } else if (m[5]) {
      const lm = LINK_RE.exec(tok)
      const label = lm?.[1] ?? tok
      const url = lm?.[2] ?? ''
      if (/^https?:\/\//i.test(url)) {
        out.push(
          createElement(
            'a',
            { key, className: 'mz-md-link', href: url, target: '_blank', rel: 'noreferrer' },
            label,
          ),
        )
      } else {
        // 非 http/https 协议：按原文本显示，不成链
        out.push(tok)
      }
    }
    last = at + tok.length
  }
  if (last < text.length) out.push(text.slice(last))
  return out
}

const UL_ITEM = /^\s*[-*]\s+(.*)$/
const OL_ITEM = /^\s*(\d+)[.)]\s+(.*)$/
const HEADING = /^(#{1,6})\s+(.*)$/

/** 把一段 Markdown 源渲染成 React 节点（块级数组，由调用方放进容器）。 */
export function renderMarkdown(src: string): ReactNode {
  const lines = src.replace(/\r\n/g, '\n').split('\n')
  const blocks: ReactNode[] = []
  let key = 0
  let i = 0
  while (i < lines.length) {
    const line = lines[i]
    if (!line.trim()) {
      i++
      continue
    }

    // 代码块：``` 起，``` 止（语言标注忽略）；内容一行都不解析
    if (/^```/.test(line.trim())) {
      const buf: string[] = []
      i++
      while (i < lines.length && !/^```/.test(lines[i].trim())) {
        buf.push(lines[i])
        i++
      }
      i++ // 跳过收尾围栏（没有收尾就到文末为止）
      blocks.push(
        createElement(
          'pre',
          { key: key++, className: 'mz-md-pre' },
          createElement('code', null, buf.join('\n')),
        ),
      )
      continue
    }

    // 标题：# ~ ######（面板里压成 h4~h6，CSS 再统一收尺寸）
    const h = HEADING.exec(line)
    if (h) {
      const level = Math.min(h[1].length + 3, 6)
      blocks.push(
        createElement(`h${level}`, { key: key++, className: 'mz-md-h' }, renderInline(h[2], `h${key}`)),
      )
      i++
      continue
    }

    // 无序列表：连续 - / * 行归一组
    if (UL_ITEM.test(line)) {
      const items: ReactNode[] = []
      while (i < lines.length && UL_ITEM.test(lines[i])) {
        const body = UL_ITEM.exec(lines[i])![1]
        items.push(createElement('li', { key: `li-${key}-${items.length}` }, renderInline(body, `ul${key}-${items.length}`)))
        i++
      }
      blocks.push(createElement('ul', { key: key++, className: 'mz-md-list' }, items))
      continue
    }

    // 有序列表：连续 数字+./) 行归一组（保留首项编号）
    if (OL_ITEM.test(line)) {
      const items: ReactNode[] = []
      const start = Number(OL_ITEM.exec(line)![1])
      while (i < lines.length && OL_ITEM.test(lines[i])) {
        const body = OL_ITEM.exec(lines[i])![2]
        items.push(createElement('li', { key: `li-${key}-${items.length}` }, renderInline(body, `ol${key}-${items.length}`)))
        i++
      }
      blocks.push(
        createElement('ol', { key: key++, className: 'mz-md-list', start: Number.isFinite(start) ? start : 1 }, items),
      )
      continue
    }

    // 段落：连续普通行归一段（段内仍走行内解析；行尾两个空格的软换行不做，合并为空格）
    const buf: string[] = []
    while (
      i < lines.length &&
      lines[i].trim() &&
      !/^```/.test(lines[i].trim()) &&
      !HEADING.test(lines[i]) &&
      !UL_ITEM.test(lines[i]) &&
      !OL_ITEM.test(lines[i])
    ) {
      buf.push(lines[i])
      i++
    }
    blocks.push(
      createElement('p', { key: key++, className: 'mz-md-p' }, renderInline(buf.join(' '), `p${key}`)),
    )
  }
  return createElement(Fragment, null, blocks)
}
