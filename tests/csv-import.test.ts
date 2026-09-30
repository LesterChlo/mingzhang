// T0929-2010：支付宝账单 CSV 是 GB18030 编码（CaptureBar 过去硬编码 UTF-8 → 中文列名乱码 →
// looksLikeHeader 必然判不中，界面报「没找到账单表头」）。本组用例锁住 decodeBillText 的
// UTF-8 优先 / GB18030 回退行为。
//
// 夹具**冻结**：下面这段 base64 是 GB18030 字节的合成数据（商户/账号均为 example.com 示例值），
// 绝不读也不替换成任何真实账单文件。
import { describe, expect, it } from 'vitest'
import { decodeBillText, parseDelimitedCsv } from '../src/renderer/src/lib/ledgerImport'

/** 冻结夹具：支付宝列名的 12 列 CSV × 3 行数据，GB18030 字节（base64）。 */
const ALIPAY_GB18030_B64 =
  'vbvS18qxvOQsvbvS17fWwOAsvbvS17bUt70sttS3vdXLusUsyczGt8u1w/csytUv1qcsvfC27izK1S+4tr/ut73KvSy9u9LX17TMrCy9u9LXtqm1pbrFLMnMvNK2qbWlusUssbjXog0KMjAyNi0wOS0yNSAxOTowNDozMiy5us7vLMPAzcXGvcyoycy7pyxtdEBleGFtcGxlLmNvbSzNxbm6zNeyzSzWp7P2LDEwLjY5LNPgtu6xpiy9u9LXs8m5piwyMDI2MDkyNTIyMDAxVEVTVDAwMDEsVEVTVC0wMDAxLA0KMjAyNi0wOS0yMiAxMzo0NDoxMCy5us7vLMSzyv3C68bsvaK16ixzaG9wQGV4YW1wbGUuY29tLMr9vt3P3yzWp7P2LDg1LjQwLLuo38IsvbvS17PJuaYsMjAyNjA5MjIyMjAwMVRFU1QwMDAyLFRFU1QtMDAwMiwNCjIwMjYtMDktMTIgMDg6MTg6MDUsubrO7yyx48D7teosZGVtb0BleGFtcGxlLmNvbSzI1dPDxrcs1qez9iwxMi45MCzT4LbuLL270tezybmmLDIwMjYwOTEyMjIwMDFURVNUMDAwMyxURVNULTAwMDMsDQo='

const bytes = (): Uint8Array => new Uint8Array(Buffer.from(ALIPAY_GB18030_B64, 'base64'))

describe('T0929-2010 · 账单 CSV 编码解码（UTF-8 优先，GB18030 回退）', () => {
  it('GB18030 字节的支付宝账单 → 表头判中、3 行数据、中文原样带出', () => {
    const parsed = parseDelimitedCsv(decodeBillText(bytes()))
    expect(parsed.ok).toBe(true)
    expect(parsed.rows).toBe(3)
    const cells = parsed.cells ?? []
    expect(cells[0]).toHaveLength(12)
    expect(cells[0][0]).toBe('交易时间')
    expect(cells[0]).toContain('金额')
    expect(cells[1][2]).toBe('美团平台商户')
    expect(cells[1][6]).toBe('10.69')
  })

  it('同一份文本的 UTF-8 字节同样解析成功（回归：别把正常文件按 GBK 解坏）', () => {
    const text = decodeBillText(bytes())
    const utf8 = new TextEncoder().encode(text)
    const parsed = parseDelimitedCsv(decodeBillText(utf8))
    expect(parsed.ok).toBe(true)
    expect(parsed.rows).toBe(3)
  })

  it('非表格文本 → 明确失败原因（含首行回显，不静默）', () => {
    const parsed = parseDelimitedCsv('hello world')
    expect(parsed.ok).toBe(false)
    expect(parsed.reason).toContain('首行是')
  })

  it('空文本 → 失败', () => {
    expect(parseDelimitedCsv('').ok).toBe(false)
  })

  it('纯 ASCII/中文 UTF-8 字节不被误判为 GBK（BOM 另算）', () => {
    expect(decodeBillText(new TextEncoder().encode('交易时间,金额\n'))).toBe('交易时间,金额\n')
  })
})
