// 数据备份管理（第七阶段）：
//   立即备份 + 快照列表（时间/大小/相对时间）+ 打开备份目录 + 一键导出 Excel。
// 恢复能力沿用既有「设置 → 数据与安全」的快照恢复流程（那里有完整的加密校验与回滚保护），
// 这里只提供「看 + 建 + 定位」，避免出现第二套恢复入口造成口径分裂。

import { useCallback, useEffect, useState } from 'react'
import type { ReactElement } from 'react'
import type { SnapshotDTO } from '../../../shared/types'
import {
  createBusinessSnapshot, listBusinessSnapshots, getBackupsDir,
  exportBusinessExcel, bytesText, timeText, relativeTime, humanError,
} from '../lib/business'

export interface BackupManagerProps {
  onError: (msg: string) => void
  onToast: (msg: string) => void
}

/** 快照保留份数（与主进程 SNAPSHOT_KEEP 一致）。 */
const KEEP = 10

export function BackupManager({ onError, onToast }: BackupManagerProps): ReactElement {
  const [snapshots, setSnapshots] = useState<SnapshotDTO[]>([])
  const [dir, setDir] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  const load = useCallback(async () => {
    try {
      const [list, d] = await Promise.all([listBusinessSnapshots(), getBackupsDir()])
      setSnapshots(list)
      setDir(d)
    } catch (e) {
      onError(humanError(e))
    }
  }, [onError])

  useEffect(() => { void load() }, [load])

  const createNow = useCallback(async () => {
    setBusy(true)
    try {
      const path = await createBusinessSnapshot()
      onToast(path ? '备份已创建' : '备份已创建')
      await load()
    } catch (e) {
      onError(humanError(e))
    } finally {
      setBusy(false)
    }
  }, [onToast, onError, load])

  const exportAll = useCallback(async () => {
    setBusy(true)
    try {
      const path = await exportBusinessExcel(null)
      if (path) onToast(`报表已导出：${path}`)
    } catch (e) {
      onError(humanError(e))
    } finally {
      setBusy(false)
    }
  }, [onToast, onError])

  return (
    <div className="mz-biz-backup">
      <h3>数据备份与导出</h3>
      <p className="mz-biz-hint">
        数据库为本地加密文件。备份为完整数据库快照，恢复请到「设置 → 数据与安全」（那里有加密校验与回滚保护）。
      </p>

      {/* 操作区 */}
      <div className="mz-biz-backup-actions">
        <button type="button" className="mz-biz-btn is-primary" onClick={() => void createNow()} disabled={busy}>
          {busy ? '处理中…' : '立即备份'}
        </button>
        <button type="button" className="mz-biz-btn" onClick={() => void exportAll()} disabled={busy}>
          导出全部经营报表（Excel）
        </button>
        {dir && (
          <span className="mz-biz-backup-dir" title={dir}>
            备份目录：{dir}
          </span>
        )}
      </div>

      {/* 策略说明 */}
      <div className="mz-biz-backup-policy">
        <div>
          <b>自动备份</b>
          <span>软件启动时检查，距上次超过 24 小时自动补一份</span>
        </div>
        <div>
          <b>保留份数</b>
          <span>最多保留最近 {KEEP} 份，超出自动清理最旧</span>
        </div>
        <div>
          <b>快捷联动</b>
          <span>顶部「速记行」与「设置 → 数据与安全」共用同一套快照目录</span>
        </div>
      </div>

      {/* 快照列表 */}
      <div className="mz-biz-subsection">
        <h3>已有快照（{snapshots.length} / {KEEP}）</h3>
        {snapshots.length === 0 ? (
          <div className="mz-biz-empty">还没有备份，点「立即备份」创建第一份</div>
        ) : (
          <table className="mz-biz-table">
            <thead>
              <tr>
                <th>#</th>
                <th>时间</th>
                <th>相对</th>
                <th className="mz-num">大小</th>
                <th>文件名</th>
              </tr>
            </thead>
            <tbody>
              {snapshots.map((s, i) => (
                <tr key={s.name}>
                  <td>{i + 1}</td>
                  <td className="mz-num">{timeText(s.mtime)}</td>
                  <td>{relativeTime(s.mtime)}</td>
                  <td className="mz-num">{bytesText(s.size)}</td>
                  <td className="mz-biz-backup-name" title={s.name}>{s.name}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      <div className="mz-biz-backup-note">
        提示：恢复备份会替换当前账本，操作前建议先「立即备份」当前状态。恢复入口在「设置 → 数据与安全 → 快照恢复」。
      </div>
    </div>
  )
}
