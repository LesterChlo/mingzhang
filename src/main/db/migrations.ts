// 增量迁移（spec 裁定：新结构采用保留旧数据的升级方式，不允许"备份后重建空库"）。
// 用 PRAGMA user_version 记版本；每步迁移幂等。

import type { Database } from 'better-sqlite3-multiple-ciphers'

export function runMigrations(db: Database): void {
  const version = db.pragma('user_version', { simple: true }) as number
  if (version < 1) {
    // v1：批次账务委托——交易增加可靠交易标识列（跨批去重 + 来源关联）
    const cols = db.prepare("PRAGMA table_info('transactions')").all() as unknown as { name: string }[]
    if (!cols.some((c) => c.name === 'dedup_key')) {
      db.exec('ALTER TABLE transactions ADD COLUMN dedup_key TEXT NULL')
    }
    db.exec(
      'CREATE INDEX IF NOT EXISTS idx_txn_dedup ON transactions(dedup_key) WHERE dedup_key IS NOT NULL',
    )
    db.pragma('user_version = 1')
  }
  if (version < 2) {
    // v2：账单材料入库（staging）——原表逐行留在本机，模型只交"读表方案"，
    // 金额/日期由代码从原表取（数字不再经模型的手）。disposition 记每行归宿，保证一行不重复处理。
    db.exec(
      'CREATE TABLE IF NOT EXISTS bill_tables (' +
        ' id INTEGER PRIMARY KEY AUTOINCREMENT,' +
        ' source_type TEXT NOT NULL CHECK (source_type IN (\'csv\',\'xlsx\')),' +
        ' file_name TEXT NULL,' +
        ' channel TEXT NULL,' +
        ' header TEXT NOT NULL,' + // JSON string[]
        ' row_count INTEGER NOT NULL,' +
        ' created_at TEXT NOT NULL,' +
        ' updated_at TEXT NOT NULL)',
    )
    db.exec(
      'CREATE TABLE IF NOT EXISTS bill_rows (' +
        ' table_id INTEGER NOT NULL REFERENCES bill_tables(id) ON DELETE CASCADE,' +
        ' row_no INTEGER NOT NULL,' + // 1 起，对用户可说"第 N 行"
        ' cells TEXT NOT NULL,' + // JSON string[]
        ' disposition TEXT NOT NULL DEFAULT \'open\' CHECK (disposition IN (\'open\',\'planned\',\'skipped\',\'review\')),' +
        ' gate_id INTEGER NULL,' +
        ' reason TEXT NULL,' +
        ' PRIMARY KEY (table_id, row_no))',
    )
    db.exec('CREATE INDEX IF NOT EXISTS idx_bill_rows_open ON bill_rows(table_id, disposition)')
    db.pragma('user_version = 2')
  }
}
