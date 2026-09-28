// 测试辅助：内存/临时文件账本 + 域层装配（无 Electron 依赖）。

import Database from 'better-sqlite3-multiple-ciphers'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { runMigrations } from '../src/main/db/migrations'

export function openPlainDb(file: string): Database {
  const db = new Database(file)
  db.pragma('foreign_keys = ON')
  return db
}

export function schemaSql(): string {
  // schema.sql 位于 src/main/db/，从测试目录相对定位
  const here = fileURLToPath(import.meta.url)
  const root = here.lastIndexOf('tests')
  const base = root > 0 ? here.slice(0, root) : here
  return readFileSync(`${base}src/main/db/schema.sql`, 'utf8')
}

/** 与生产 initSchema 同序：schema.sql + 增量迁移（否则测试库缺新表，假绿）。 */
export function openSchemaDb(file: string): Database {
  const db = openPlainDb(file)
  db.exec(schemaSql())
  runMigrations(db)
  return db
}
