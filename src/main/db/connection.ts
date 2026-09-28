// 加密账本连接（决定记录 §6 第二层锁）：
//   - 随机 32 字节 DEK（hex），由 safeStorage/DPAPI 包裹落 secrets/db.key；
//   - PRAGMA key 必须是连接后第一条语句；显式声明 chacha20；WAL；
//   - DEK 明文只存在于本进程内存，绝不入日志/配置/备份。

import DatabaseCtor from 'better-sqlite3-multiple-ciphers'
import type { Database } from 'better-sqlite3-multiple-ciphers'
import { existsSync, lstatSync } from 'node:fs'
import { randomBytes } from 'node:crypto'
import type { SecretsStore } from '../secrets/store'
import schemaSql from './schema.sql?raw'
import { runMigrations } from './migrations'
import { validateLedgerDatabase, listPendingRestoreArtifacts } from '../domain/backup'

export { schemaSql }

const DB_KEY_FILE = 'db.key'
const CIPHER = 'chacha20'
/** SQLite 在主库文件旁产生的附属文件；主库缺失时它们代表崩溃残留，不得当成首次启动。 */
const SIDECAR_SUFFIXES = ['-wal', '-shm', '-journal']

export function loadOrCreateDek(secrets: SecretsStore): string {
  const existing = secrets.get(DB_KEY_FILE)
  if (existing) return existing
  const dek = randomBytes(32).toString('hex')
  secrets.set(DB_KEY_FILE, dek)
  return dek
}

export function openLedger(dbFile: string, secrets: SecretsStore): Database {
  // B1 根因修复：已存在目标绝不静默新建/补 schema。
  //  - journal / forward / candidate 等**未收敛**工件 → 拒绝：必须先完成中断恢复；
  //  - 目标缺失 + 任何恢复痕迹 → 拒绝新建空账本；
  //  - 目标存在但为空/符号链接/损坏/错 schema → 拒绝：人工介入前绝不补成新空账本。
  // 纯粹首次启动（目标不存在、无任何恢复痕迹）才允许新建，之后由 initSchema+seed 初始化。
  //
  // R5-P0 修复：此前这里按 `${base}.restore-` 前缀**一律**拒启，而 replaceWithRollback /
  // rollbackRestore 成功后按设计保留 `.restore-rollback`（回滚能力本身），前缀正好命中
  // → 每次成功恢复后应用永久无法启动，且文案把用户指向 no-op 的 recoverInterruptedRestore。
  // 现在只对**未收敛**工件拒启；收敛判定复用 backup.ts 的槽位口径（listPendingRestoreArtifacts）。
  const pendingArtifacts = listPendingRestoreArtifacts(dbFile)
  if (pendingArtifacts.length > 0) {
    throw new Error(
      `检测到未完成的账本恢复工件（${pendingArtifacts.join('、')}）：拒绝打开账本，以免在中断的恢复状态上继续写入。` +
        '请先完成中断恢复（重启应用会自动执行一次恢复收敛）；若反复出现，请人工核对该目录下的恢复工件与账本文件后再启动。',
    )
  }
  const existed = existsSync(dbFile)
  if (!existed) {
    // B1 根因（第三轮复核补齐）：正式主库缺失、但残留 SQLite sidecar（Windows 崩溃/强杀残留）。
    // 这种情况绝不能当“首次启动”放行 —— 放行后 SQLite 会静默新建一个空账本，旧数据全部不可见。
    // 必须在触碰 SecretsStore、创建任何库文件之前拒绝。
    const sidecars = SIDECAR_SUFFIXES.filter((suffix) => existsSync(`${dbFile}${suffix}`))
    if (sidecars.length > 0) {
      throw new Error(
        `检测到账本主库文件缺失，但存在残留的 SQLite 附属文件（${sidecars.join('、')}）：` +
          '拒绝新建空账本（若放行，SQLite 会静默建出空库并掩盖旧数据）。' +
          '请先人工核对账本文件是否被移动/删除，恢复原库后再启动。',
      )
    }
  }
  if (existed) {
    // 已存在文件：只读守门，不打开即判空/链接。绝不在此补 schema。
    const st = lstatSync(dbFile)
    if (st.isSymbolicLink()) {
      throw new Error('已存在的账本文件为符号链接：拒绝启动（绝不补成新空账本，请人工核对）。')
    }
    if (!st.isFile() || st.size === 0) {
      throw new Error('已存在的账本文件为空或不是普通文件：拒绝启动（绝不补成新空账本，请人工核对）。')
    }
  }
  const dek = loadOrCreateDek(secrets)
  const db = new DatabaseCtor(dbFile)
  try {
    // 打开/解密探测。note: 损坏或非数据库文件上 **PRAGMA 本身就会先抛**
    // （journal_mode=WAL 早于 prepare 就炸），所以这几行必须在 try 内，
    // 否则抛错时原生句柄永不关闭 → Windows 上锁住账本目录，后续备份/恢复/删除全 EPERM。
    try {
      // 顺序敏感：key → cipher → 其余 PRAGMA
      db.pragma(`key = "x'${dek}'"`)
      db.pragma(`cipher='${CIPHER}'`)
      db.pragma('journal_mode = WAL')
      db.pragma('foreign_keys = ON')
      // 密钥错误 / 文件损坏的确认信号
      db.prepare('SELECT count(*) AS n FROM sqlite_master').get()
    } catch (err) {
      throw new Error(
        `账本数据库无法解密或已损坏（${(err as Error).message}）。` +
          '数据文件可能被移动到其它机器/账户，或 DEK 与库文件不匹配。',
      )
    }
    if (existed) {
      // 已存在库必须符合生产 schema（schema.sql+迁移）：错 schema 直接拒绝，
      // 绝不由启动流程 initSchema 补成看似正常的新空账本。
      validateLedgerDatabase(db, '账本')
    }
    return db
  } catch (err) {
    // 任何拒启路径都必须归还原生句柄。
    try {
      db.close()
    } catch {
      // 关闭失败不得掩盖原始拒启原因
    }
    throw err
  }
}

export function initSchemaIfEmpty(db: Database): void {
  const count = (db.prepare("SELECT count(*) AS n FROM sqlite_master WHERE type = 'table'").get() as { n: number }).n
  if (count > 0) {
    validateLedgerDatabase(db, '账本')
    return
  }
  initSchema(db)
}

export function initSchema(db: Database): void {
  db.exec(schemaSql)
  runMigrations(db)
}
