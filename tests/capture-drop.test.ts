// 拖入文件分类（速记行缺陷单）——纯函数单测。
//
// 缺陷：新外壳 CaptureBar 的 addFiles() 只认 image/*，其余文件 `if (list.length === 0) return`
// 静默丢弃（用户实拖 XLSX 账单进窗口，界面毫无反应）。本测试锁住"任何拖入文件都有明确归属"：
//   图片 / CSV / XLSX → 放行；超限或不支持 → 返回带用户可读 reason 的 unsupported，不静默。
import { describe, expect, it } from 'vitest'
import { classifyDroppedFile } from '../src/renderer/src/lib/captureFiles'

const PNG = { name: '截图.png', type: 'image/png', size: 120_000 }
const XLSX_MIME = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'

describe('拖入文件分类 · 速记行不再静默丢弃', () => {
  it('图片放行：image/* 直接判 image', () => {
    expect(classifyDroppedFile(PNG)).toEqual({ kind: 'image' })
    expect(classifyDroppedFile({ name: '无扩展名', type: 'image/jpeg', size: 1 })).toEqual({ kind: 'image' })
  })

  it('图片超 8MB：判 unsupported 并给出超限原因（不是静默跳过）', () => {
    const r = classifyDroppedFile({ ...PNG, size: 8 * 1024 * 1024 + 1 })
    expect(r.kind).toBe('unsupported')
    expect(r.reason).toContain('截图.png')
    expect(r.reason).toContain('8MB')
    // 正好 8MB 仍放行
    expect(classifyDroppedFile({ ...PNG, size: 8 * 1024 * 1024 })).toEqual({ kind: 'image' })
  })

  it('CSV 放行：.csv 扩展名与 text/csv MIME 都认；大小写不敏感', () => {
    expect(classifyDroppedFile({ name: '账单.csv', type: '', size: 2048 })).toEqual({ kind: 'csv' })
    expect(classifyDroppedFile({ name: '账单', type: 'text/csv', size: 2048 })).toEqual({ kind: 'csv' })
    expect(classifyDroppedFile({ name: 'BILL.CSV', type: 'text/plain', size: 2048 })).toEqual({ kind: 'csv' })
  })

  it('CSV 超 400KB：判 unsupported，沿用老版文案', () => {
    const r = classifyDroppedFile({ name: '大账单.csv', type: 'text/csv', size: 400 * 1024 + 1 })
    expect(r.kind).toBe('unsupported')
    expect(r.reason).toContain('400KB')
    // 正好 400KB 仍放行
    expect(classifyDroppedFile({ name: '大账单.csv', type: 'text/csv', size: 400 * 1024 })).toEqual({ kind: 'csv' })
  })

  it('XLSX 放行：.xlsx 扩展名与表格 MIME 都认；大小写不敏感', () => {
    expect(classifyDroppedFile({ name: '账单.xlsx', type: XLSX_MIME, size: 40_000 })).toEqual({ kind: 'xlsx' })
    expect(classifyDroppedFile({ name: 'BILL.XLSX', type: '', size: 40_000 })).toEqual({ kind: 'xlsx' })
    expect(classifyDroppedFile({ name: '微信账单', type: XLSX_MIME, size: 40_000 })).toEqual({ kind: 'xlsx' })
  })

  it('XLSX 超 2MB：判 unsupported，沿用老版拆分提示', () => {
    const r = classifyDroppedFile({ name: '大账单.xlsx', type: XLSX_MIME, size: 2 * 1024 * 1024 + 1 })
    expect(r.kind).toBe('unsupported')
    expect(r.reason).toContain('2MB')
    expect(r.reason).toContain('大账单.xlsx')
    // 正好 2MB 仍放行
    expect(classifyDroppedFile({ name: '大账单.xlsx', type: XLSX_MIME, size: 2 * 1024 * 1024 })).toEqual({
      kind: 'xlsx',
    })
  })

  it('其余格式：unsupported + 老版那句「暂不支持」文案（含文件名）', () => {
    const r = classifyDroppedFile({ name: '笔记.txt', type: 'text/plain', size: 10 })
    expect(r.kind).toBe('unsupported')
    expect(r.reason).toBe('⚠ 暂不支持「笔记.txt」这种格式。目前支持：图片截图 / CSV、XLSX 账单。')
    // pdf / zip / 无扩展名 同样有明确归属
    expect(classifyDroppedFile({ name: 'a.pdf', type: 'application/pdf', size: 1 }).kind).toBe('unsupported')
    expect(classifyDroppedFile({ name: 'a.zip', type: 'application/zip', size: 1 }).kind).toBe('unsupported')
    expect(classifyDroppedFile({ name: '无扩展名', type: '', size: 1 }).kind).toBe('unsupported')
  })

  it('任何输入都带 kind，永不返回 undefined（不静默的底线）', () => {
    const probes = [PNG, { name: 'a.csv', type: 'text/csv', size: 1 }, { name: 'a.xlsx', type: XLSX_MIME, size: 1 }, { name: 'a.txt', type: 'text/plain', size: 1 }]
    for (const p of probes) {
      const r = classifyDroppedFile(p)
      expect(['image', 'csv', 'xlsx', 'unsupported']).toContain(r.kind)
      if (r.kind === 'unsupported') expect(typeof r.reason).toBe('string')
    }
  })
})
