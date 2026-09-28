// T0928-1330 缺陷④（#6-A）：提示词规范输出。
//
// 试用反馈：模型的回复里带 Markdown 装饰符号（**加粗**、`代码`、### 标题），
// 渲染层没有富文本管线，显示成一串裸符号。渲染兜底由前端单（K3）做，
// 引擎这一侧先把"说话口径"写进系统提示：简洁纯文本；确需结构用简短列表。
// 渲染层渲染兜底不在本单范围（见工单 §6）。

import { describe, expect, it } from 'vitest'
import { MINGZHANG_SYSTEM_PROMPT } from '../src/main/engine/system-prompt'

describe('缺陷④：系统提示的输出规范（简洁纯文本）', () => {
  it('说话口径段写明：面向用户的回复用简洁纯文本', () => {
    expect(MINGZHANG_SYSTEM_PROMPT).toMatch(/简洁纯文本|纯文本/)
  })
  it('写明：确需结构时用简短列表', () => {
    expect(MINGZHANG_SYSTEM_PROMPT).toMatch(/简短列表|列表/)
  })
  it('写明：避免 Markdown 装饰符号', () => {
    expect(MINGZHANG_SYSTEM_PROMPT).toContain('Markdown')
    expect(MINGZHANG_SYSTEM_PROMPT).toMatch(/避免.*Markdown|Markdown.*避免/)
  })
  it('原有口径不回归：语气段仍在，且工具纪律段完整', () => {
    expect(MINGZHANG_SYSTEM_PROMPT).toContain('# 语气')
    expect(MINGZHANG_SYSTEM_PROMPT).toContain('账房先生')
    expect(MINGZHANG_SYSTEM_PROMPT).toContain('# 工具使用规则')
    expect(MINGZHANG_SYSTEM_PROMPT).toContain('# 边界')
  })
})
