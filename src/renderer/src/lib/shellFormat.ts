// 收件箱屏的纯展示格式化（无 React / 无 IPC 依赖，可单测）。
//
// 口径纪律：一切格式化只做「原始值 → 人话」，不改数据、不猜。

/** 金额：整数分 → ¥1,234.50（渲染侧一律配 .mz-num 做 tabular-nums）。 */
export function money(cents: number): string {
  return `¥${(cents / 100).toFixed(2)}`
}

/** 交易类型中文名（与后端 tx_type 字面量一一对应，未知值原样透出，不猜）。 */
export function txTypeLabel(type: string): string {
  switch (type) {
    case 'expense':
      return '支出'
    case 'income':
      return '收入'
    case 'transfer':
      return '转账'
    case 'adjustment':
      return '调整'
    default:
      return type
  }
}

/** ISO 本地时间（…+08:00）→ 本地 Date；解析失败返回 null（不编造时间）。 */
export function parseIso(iso: string | null | undefined): Date | null {
  if (!iso) return null
  const d = new Date(iso)
  return Number.isNaN(d.getTime()) ? null : d
}

const p2 = (n: number): string => String(n).padStart(2, '0')

/** 卡片头部时间：今天 → HH:MM，昨天 → 昨天 HH:MM，更早 → MM-DD HH:MM。 */
export function relTime(iso: string | null | undefined, now: Date = new Date()): string {
  const d = parseIso(iso)
  if (!d) return ''
  const hm = `${p2(d.getHours())}:${p2(d.getMinutes())}`
  const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime()
  const dayMs = 86_400_000
  if (d.getTime() >= startOfToday) return hm
  if (d.getTime() >= startOfToday - dayMs) return `昨天 ${hm}`
  return `${p2(d.getMonth() + 1)}-${p2(d.getDate())} ${hm}`
}

/** 快照时间（mtime 毫秒）→ 09-25 21:00（规格 §2.3 锁标口径）。 */
export function snapshotStamp(mtime: number | null | undefined): string {
  if (typeof mtime !== 'number' || !Number.isFinite(mtime)) return ''
  const d = new Date(mtime)
  if (Number.isNaN(d.getTime())) return ''
  return `${p2(d.getMonth() + 1)}-${p2(d.getDate())} ${p2(d.getHours())}:${p2(d.getMinutes())}`
}

/** 快照新鲜度（规格 §2.3 异常态）：>7 天转黄，文案「N 天未快照」。 */
export function snapshotFreshness(
  mtime: number | null | undefined,
  now: Date = new Date(),
): { text: string; stale: boolean; days: number | null } {
  if (typeof mtime !== 'number' || !Number.isFinite(mtime)) {
    return { text: '尚未快照', stale: true, days: null }
  }
  const days = Math.floor((now.getTime() - mtime) / 86_400_000)
  if (days >= 7) return { text: `${days} 天未快照`, stale: true, days }
  return { text: `快照 ${snapshotStamp(mtime)}`, stale: false, days }
}

/** 数据目录只留末两段（208px 侧栏放得下；完整路径走 title）。 */
export function shortPath(dataDir: string): string {
  if (!dataDir) return '数据目录未知'
  const parts = dataDir.split(/[\\/]/).filter(Boolean)
  if (parts.length <= 2) return dataDir
  return `…\\${parts[parts.length - 2]}\\${parts[parts.length - 1]}`
}

/** 本地 YYYY-MM-DD / YYYY-MM。 */
export function localDay(d: Date = new Date()): string {
  return `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())}`
}

export function localMonth(d: Date = new Date()): string {
  return `${d.getFullYear()}-${p2(d.getMonth() + 1)}`
}
