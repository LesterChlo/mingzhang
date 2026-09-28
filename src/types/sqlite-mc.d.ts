// better-sqlite3-multiple-ciphers 的 package.json exports 未暴露类型入口（库自身问题）。
// 这里按实际用到的 API 面写最小声明；默认导出 = 构造器，`Database` 接口 = 实例类型。
declare module 'better-sqlite3-multiple-ciphers' {
  export interface RunResult {
    changes: number
    lastInsertRowid: number | bigint
  }
  export interface Statement {
    get(...args: unknown[]): { [key: string]: unknown } | undefined
    all(...args: unknown[]): { [key: string]: unknown }[]
    run(...args: unknown[]): RunResult
  }
  export interface Database {
    prepare(sql: string): Statement
    exec(sql: string): void
    pragma(source: string, options?: { simple?: boolean }): unknown
    close(): void
    open: boolean
    inTransaction: boolean
    transaction<TArgs extends unknown[]>(fn: (...args: TArgs) => void): (...args: TArgs) => void
  }
  const Database: new (
    path: string,
    options?: { readonly?: boolean; fileMustExist?: boolean },
  ) => Database
  export default Database
}
