// 账单文件解析（第 7 单 段1；第 8 单 段2 改为产出二维表）。
// 产出的 cells（首行表头）交给主进程逐行入库，之后由 Agent 读表、程序解析金额与日期——
// 整张表不再进模型上下文。纯函数、无 React/Electron 依赖 → 渲染层与 vitest 共用。
import * as XLSX from 'xlsx'

export interface LedgerFileParse {
  ok: boolean
  /** 二维表：首行为表头，其余为数据行（已去掉首尾空白与整行空行）。 */
  cells?: string[][]
  /** 解析出的、与 CSV 同构的表格文本（给用户回看用，不再喂模型）。 */
  csvText?: string
  /** 表头之下的数据行数。 */
  rows?: number
  /** 失败原因（给用户看，含可读定位）。 */
  reason?: string
}

/** 表头判定：含"金额"，且含"交易时间/日期"或"交易对方/商户/商品"之一。 */
function looksLikeHeader(cells: string[]): boolean {
  const hasAmount = cells.some((c) => c.includes('金额'))
  const hasTimeOrParty = cells.some((c) => /交易时间|日期|时间|交易对方|商户|商品|付款/.test(c))
  return hasAmount && hasTimeOrParty
}

function csvCell(v: string): string {
  return /[",\r\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v
}

function toParse(header: string[], rows: string[][]): LedgerFileParse {
  const dataRows = rows.filter((r) => r.some((c) => c !== ''))
  if (dataRows.length === 0) return { ok: false, reason: '表头下没有数据行' }
  const cells = [header, ...dataRows]
  return { ok: true, cells, csvText: cells.map((r) => r.map(csvCell).join(',')).join('\r\n'), rows: dataRows.length }
}

/**
 * CSV/表格文本 → 二维表（RFC4180 风格：双引号包裹、"" 转义、支持 CRLF 与内嵌换行）。
 * 找不到表头时返回失败原因（不猜列）。
 */
export function parseDelimitedCsv(text: string, sep = ','): LedgerFileParse {
  const rows: string[][] = []
  let field = ''
  let row: string[] = []
  let quoted = false
  const src = text.replace(/\r\n?/g, '\n')
  const pushField = (): void => {
    row.push(field)
    field = ''
  }
  const pushRow = (): void => {
    pushField()
    rows.push(row.map((c) => c.trim()))
    row = []
  }
  for (let i = 0; i < src.length; i++) {
    const ch = src[i]
    if (quoted) {
      if (ch === '"') {
        if (src[i + 1] === '"') {
          field += '"'
          i++
        } else quoted = false
      } else field += ch
      continue
    }
    if (ch === '"') quoted = true
    else if (ch === sep) pushField()
    else if (ch === '\n') pushRow()
    else field += ch
  }
  if (field !== '' || row.length) pushRow()
  const cells = rows.filter((r) => r.some((c) => c !== ''))
  if (cells.length === 0) return { ok: false, reason: '文件是空的或全是空行' }
  const headerIdx = cells.findIndex(looksLikeHeader)
  if (headerIdx < 0) {
    return { ok: false, reason: `没找到账单表头（需包含"金额"以及"交易时间/交易对方"等列）。首行是：${cells[0].join(' | ').slice(0, 200)}` }
  }
  return toParse(cells[headerIdx], cells.slice(headerIdx + 1))
}

export function parseWechatXlsx(buf: ArrayBuffer | Uint8Array): LedgerFileParse {
  let wb: XLSX.WorkBook
  try {
    wb = XLSX.read(buf, { type: 'array' })
  } catch (e) {
    return { ok: false, reason: `无法打开工作簿（可能已损坏）：${(e as Error).message}` }
  }
  const first = wb.SheetNames[0]
  if (!first) return { ok: false, reason: '工作簿里没有工作表' }
  const ws = wb.Sheets[first]
  // raw:false → 取"显示值"，避免日期变成 Excel 序列号；defval:'' 补齐空单元格
  const aoa = XLSX.utils.sheet_to_json<unknown[]>(ws, { header: 1, defval: '', raw: false, blankrows: true })

  let headerIdx = -1
  for (let i = 0; i < aoa.length; i++) {
    const cells = (aoa[i] ?? []).map((c) => String(c ?? '').trim())
    if (looksLikeHeader(cells)) {
      headerIdx = i
      break
    }
  }
  if (headerIdx < 0) {
    return { ok: false, reason: '没找到账单表头（需包含"金额"以及"交易时间/交易对方"等列）——请确认这是微信账单导出的表格' }
  }

  const rows: string[][] = []
  for (let i = headerIdx; i < aoa.length; i++) {
    const cells = (aoa[i] ?? []).map((c) => String(c ?? '').trim())
    if (cells.every((c) => c === '')) {
      if (rows.length > 1) break // 表头后的首个整行空 = 数据结束（丢弃尾部空行/落款）
      continue
    }
    rows.push(cells)
  }
  return toParse(rows[0] ?? [], rows.slice(1))
}
