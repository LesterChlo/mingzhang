import type { Database, Statement } from 'better-sqlite3-multiple-ciphers'

interface Column { name: string; column: string | null; table: string | null; database: string | null }
type Mode = 'flat' | 'raw' | 'pluck' | 'expand'
type NativeStatement = Statement & {
  reader: boolean; columns(): Column[]; raw(value?: boolean): NativeStatement
  pluck(value?: boolean): NativeStatement; expand(value?: boolean): NativeStatement
  iterate(...args: unknown[]): IterableIterator<unknown[]>
}

/** Locate explicit projection aliases, including aliases identical to their origin name.
 * Metadata alone cannot distinguish SELECT id from SELECT id AS ID on an uppercase table.
 * Keep strings/comments opaque; nested SELECT/CAST aliases are not outer result aliases.
 */
function projectionAliases(sql: string, columns: Column[]): Set<number> | null {
  const width = columns.length
  const tokens = sql.match(/--[^\n]*|\/\*[\s\S]*?\*\/|'(?:[^']|'')*'|"(?:[^"]|"")*"|`(?:[^`]|``)*`|\[[^\]]*\]|[\w$]+|[^\s]/g) ?? []
  const expressions: string[][] = [[]]
  let depth = 0, projecting = false
  for (const token of tokens) {
    if (token.startsWith('--') || token.startsWith('/*')) continue
    const word = token.toLowerCase()
    if (!projecting) {
      if (depth === 0 && (word === 'select' || word === 'returning')) projecting = true
      else if (token === '(') depth++
      else if (token === ')') depth--
      continue
    }
    if (depth === 0 && ['from', 'where', 'group', 'order', 'limit', 'union', 'intersect', 'except', ';'].includes(word)) break
    if (depth === 0 && token === ',') { expressions.push([]); continue }
    expressions[expressions.length - 1].push(token)
    if (token === '(') depth++
    else if (token === ')') depth--
  }
  if (!projecting) return new Set()
  if (['distinct', 'all'].includes(expressions[0][0]?.toLowerCase())) expressions[0].shift()
  const stars = expressions.filter(e => e[e.length - 1] === '*').length
  // Multiple wildcard projections are deliberately left native if positions cannot be proven.
  if (stars > 1) return null
  const aliases = new Set<number>()
  let index = 0
  for (const expr of expressions) {
    if (expr[expr.length - 1] === '*') { index += width - expressions.length + 1; continue }
    let level = 0
    for (let i = 0; i < expr.length; i++) {
      if (expr[i] === '(') level++
      else if (expr[i] === ')') level--
      else if (level === 0 && expr[i].toLowerCase() === 'as') aliases.add(index)
    }
    const tail = expr[expr.length - 1]
    const alias = tail?.startsWith('[') ? tail.slice(1, -1) :
      tail && ['"', '`', "'"].includes(tail[0]) ? tail.slice(1, -1).split(tail[0] + tail[0]).join(tail[0]) : tail
    // For a direct origin column, a trailing identifier not following '.' is an implicit alias.
    if (expr.length > 1 && expr[expr.length - 2] !== '.' && alias === columns[index]?.name) aliases.add(index)
    index++
  }
  return index === width ? aliases : null
}

/** Adapt only this application's connection; keep the actual native database/statement
 * objects (and hence binding, transactions, busy checks and close ownership) intact.
 * Read raw positional values so renaming cannot lose duplicate-column collision order.
 */
export function installResultShape(db: Database, schema: Record<string, string[]>): void {
  const prepare = db.prepare
  db.prepare = function (sql: string): Statement {
    const s = prepare.call(this, sql) as NativeStatement
    if (!s.reader) return s
    const columns = s.columns()
    const aliases = projectionAliases(sql, columns)
    if (aliases === null) return s
    const names = columns.map((c, i) => {
      const name = c.column?.toLowerCase()
      return !aliases.has(i) && c.database === 'main' && c.table && name &&
        c.name === c.column && schema[c.table.toLowerCase()]?.includes(name) ? name : c.name
    })
    if (names.every((name, i) => name === columns[i].name)) return s
    const get = s.get, all = s.all, iterate = s.iterate
    const modes = { raw: s.raw, pluck: s.pluck, expand: s.expand }
    let mode: Mode = 'flat'
    modes.raw.call(s, true)
    const set = (row: Record<string, unknown>, key: string, value: unknown): void => {
      Object.defineProperty(row, key, { value, enumerable: true, writable: true, configurable: true })
    }
    const shape = (values: unknown[] | undefined): unknown => {
      if (values === undefined || mode === 'raw') return values
      if (mode === 'pluck') return values[0]
      const row: Record<string, unknown> = {}
      columns.forEach((c, i) => {
        let target = row
        if (mode === 'expand') {
          const table = c.table ?? '$' // expand's table keys remain native, not renamed.
          if (!Object.hasOwn(row, table)) set(row, table, {})
          target = row[table] as Record<string, unknown>
        }
        set(target, names[i], values[i])
      })
      return row
    }
    Object.defineProperties(s, {
      get: { value: (...args: unknown[]) => shape(get.apply(s, args) as unknown as unknown[] | undefined) },
      all: { value: (...args: unknown[]) => (all.apply(s, args) as unknown as unknown[][]).map(shape) },
      iterate: { value: (...args: unknown[]) => {
        const iterator = iterate.apply(s, args)
        const next = iterator.next
        Object.defineProperty(iterator, 'next', { value: (...input: [] | [undefined]) => {
          const result = next.apply(iterator, input)
          return result.done ? result : { done: false, value: shape(result.value) }
        } })
        return iterator // native return() unlocks even before the first next()/on early break.
      } },
    })
    for (const key of ['raw', 'pluck', 'expand'] as const) {
      Object.defineProperty(s, key, { value: (...args: [boolean?]) => {
        modes[key].apply(s, args) // retain native argument and active-iterator validation.
        modes.raw.call(s, true)
        if (args[0] !== false) mode = key
        else if (mode === key) mode = 'flat'
        return s
      } })
    }
    return s
  }
}
