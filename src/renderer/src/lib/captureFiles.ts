// 拖入文件的分类（速记行缺陷单）。
//
// 缺陷背景：新外壳 CaptureBar.addFiles() 只筛 image/*，其余 `if (list.length === 0) return`
// —— 拖任何 CSV/XLSX/文本进窗口都静默无反应。这个纯函数把"该文件归谁"从组件里抽出来，
// 判定顺序与老版 ChatApp.tsx 完全一致（image → csv → xlsx → 兜底），并对**超限**同样给
// 可见原因：任何拖入的文件都有明确归属，没有"悄悄丢掉"这条路径。
//
// 纯函数、无 React/Electron 依赖 → 渲染层与 vitest 共用。

export type DroppedKind = 'image' | 'csv' | 'xlsx' | 'unsupported'

export interface DroppedVerdict {
  kind: DroppedKind
  /** kind='unsupported' 时必填：可直接显示给用户的原因（超限 / 格式不支持）。 */
  reason?: string
}

/** 上限与老版 ChatApp.tsx 一致：图片 8MB、CSV 400KB、XLSX 2MB。 */
export const MAX_IMAGE_BYTES = 8 * 1024 * 1024
export const MAX_CSV_BYTES = 400 * 1024
export const MAX_XLSX_BYTES = 2 * 1024 * 1024

const XLSX_MIME = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
/** 旧版 Excel 的表格 MIME：扩展名可能被浏览器抹掉，只剩 MIME 可判。 */
const XLS_MIME = 'application/vnd.ms-excel'

/**
 * 判定一个拖入/选入的文件属于哪条管线。
 * 顺序：image/* → .csv/text-csv → .xlsx/表格 MIME → 其余 unsupported（带可读原因）。
 */
export function classifyDroppedFile(f: { name: string; type: string; size: number }): DroppedVerdict {
  if (f.type.startsWith('image/')) {
    if (f.size > MAX_IMAGE_BYTES) {
      return { kind: 'unsupported', reason: `⚠ 「${f.name}」超过 8MB，暂不支持；请压缩后再试。` }
    }
    return { kind: 'image' }
  }
  if (/\.csv$/i.test(f.name) || f.type === 'text/csv') {
    if (f.size > MAX_CSV_BYTES) {
      return { kind: 'unsupported', reason: '⚠ CSV 超过 400KB，暂不支持；请拆分后再试。' }
    }
    return { kind: 'csv' }
  }
  if (/\.xlsx$/i.test(f.name) || f.type === XLSX_MIME || f.type === XLS_MIME) {
    if (f.size > MAX_XLSX_BYTES) {
      return {
        kind: 'unsupported',
        reason: `⚠ 「${f.name}」超过 2MB，暂不支持整表导入；请在微信导出时按更短的时间区间拆分。`,
      }
    }
    return { kind: 'xlsx' }
  }
  // 段2：既非图片、又非 CSV/XLSX——不再静默丢弃，明确告知支持范围
  return {
    kind: 'unsupported',
    reason: `⚠ 暂不支持「${f.name}」这种格式。目前支持：图片截图 / CSV、XLSX 账单。`,
  }
}
