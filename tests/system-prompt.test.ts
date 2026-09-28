// 回归：T0922-2145 CSV 流水粘贴空回复 —— system prompt 必须含账单材料处理规则。
// 根因：send() 把粘贴的流水包成“请用 commit_batch 处理”喂模型，但 prompt 从未教过
// 模型收到账单材料该怎么做 → 弱模型只 thinking、无工具调用、无文本，前端兜底显示“（本轮结束）”。
import { describe, expect, it } from 'vitest'
import { MINGZHANG_SYSTEM_PROMPT } from '../src/main/engine/system-prompt'

describe('system prompt 账单材料规则（T0922-2145）', () => {
  it('含 CSV/XLSX 材料 → commit_batch 的处理规则', () => {
    expect(MINGZHANG_SYSTEM_PROMPT).toContain('commit_batch')
    expect(MINGZHANG_SYSTEM_PROMPT).toContain('CSV')
    expect(MINGZHANG_SYSTEM_PROMPT).toContain('XLSX')
  })
  it('强调两段式：不宣称已入账，结果逐项交代', () => {
    expect(MINGZHANG_SYSTEM_PROMPT).toContain('确认入账')
    expect(MINGZHANG_SYSTEM_PROMPT).toMatch(/逐项/)
  })
  it('缺金额不猜：省略 amount_cents 而非臆造', () => {
    expect(MINGZHANG_SYSTEM_PROMPT).toContain('amount_cents')
  })
})
