// 测试辅助：内存/临时文件账本 + 域层装配（无 Electron 依赖）。

import Database from 'better-sqlite3-multiple-ciphers'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { runMigrations } from '../src/main/db/migrations'
import { nowIso } from '../src/main/db/time'

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

/**
 * 测试夹具专用：显式建几个历史/自定义分类名。
 * 这些用例验证的是分类规则、导入异常、日期编辑等逻辑，不是预置分类清单；
 * 用显式建类模拟"用户已自定义过分类"的历史账本，避免把旧名字塞回生产预置。
 */
export function seedCustomCategories(db: Database): void {
  const ts = nowIso()
  const insert = db.prepare(
    'INSERT OR IGNORE INTO categories (name, kind, parent_id, created_at, updated_at) VALUES (?, ?, NULL, ?, ?)',
  )
  for (const [name, kind] of [
    ['咖啡', 'expense'],
    ['生活费', 'income'],
    ['其他', 'expense'],
    ['其他', 'income'],
  ] as const) insert.run(name, kind, ts, ts)
}
