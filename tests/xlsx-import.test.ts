// 第 7 单 段1：微信账单 XLSX 解析单测（真实断言，夹具由 tests/xlsx-fixture.ts 脚本合成，绝不读真实账单）。
import { describe, expect, it } from 'vitest'
import { parseWechatXlsx } from '../src/renderer/src/lib/ledgerImport'
import { makeWechatXlsxBuffer, makeJunkXlsxBuffer, WECHAT_HEADER } from './xlsx-fixture'

describe('第7单 段1 · 微信账单 XLSX 解析', () => {
  it('跳过表头前的说明行，定位真实表头并解析数据行为与 CSV 同构的文本', () => {
    const r = parseWechatXlsx(makeWechatXlsxBuffer())
    expect(r.ok).toBe(true)
    expect(r.rows).toBe(4)
    const lines = (r.csvText ?? '').split('\r\n')
    // 第一行就是真实表头（说明行被跳过）
    expect(lines[0]).toContain('交易时间')
    expect(lines[0]).toContain('金额')
    // 数据行内容保留
    const body = r.csvText ?? ''
    expect(body).toContain('星巴克咖啡')
    expect(body).toContain('全家便利店')
    expect(body).toContain('¥35.00')
    // 尾部落款行（表头后的空行之后）被丢弃，不混进数据
    expect(body).not.toContain('以上为账单内容')
  })

  it('表头列齐全：11 列原样带出（喂模型/管线同构 CSV）', () => {
    const r = parseWechatXlsx(makeWechatXlsxBuffer())
    const headerLine = (r.csvText ?? '').split('\r\n')[0]
    for (const col of WECHAT_HEADER) {
      expect(headerLine).toContain(col)
    }
  })

  it('非账单表格（找不到表头）→ 明确失败原因，不静默', () => {
    const r = parseWechatXlsx(makeJunkXlsxBuffer())
    expect(r.ok).toBe(false)
    expect(r.reason).toContain('表头')
  })
})
