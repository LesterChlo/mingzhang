// 批次结果条（K3 设计 G 组事实条 + D-03a「按批次读回」）。
//
// 为什么要有它：用户一键入账 126 笔后界面剩 38 笔「待确认」却**没有任何解释**——
// 第一反应是「是不是 bug」。这条横条用**数据算得出的数字**把「刚才那批发生了什么」说清楚。
//
// 纪律：
//   ① 全部文案是确定性模板句，一个字都不调模型（事实层不给措辞层让位）；
//   ② 四段计数**不是分区**：待分类含在已入账里，所以必须有一行小字说清（br-subset-note），
//      否则用户会拿 126+38 算不平、以为界面在骗人；
//   ③ 后端给不出来的明细就**说出来**：不计收支的逐行明细本单没有（D-03b），
//      写「逐行明细待后端」，绝不拿空数组冒充「没有不计收支的行」；
//   ④ 依赖未实现单子的按钮一律不渲染（对话面板 P 组 / 批量写 D-01 / 思考全文 D-02 /
//      跨重启持久化 D-04）——不放假按钮。
//
// 样式一律走 styles/ 的既有 token，不新增自由配色。

import { useEffect, useRef, useState } from 'react'
import type { ReactElement } from 'react'
import type { BatchResultSummaryDTO } from '../../../shared/types'
import { money } from '../lib/shellFormat'
import { humanError } from '../lib/ledgerFilter'

export interface BatchResultBarProps {
  summary: BatchResultSummaryDTO
  /** ✕ 关闭：由store保存本批次的展示状态。 */
  onDismiss: () => void
}

export function BatchResultBar({ summary, onDismiss }: BatchResultBarProps): ReactElement {
  const [dupOpen, setDupOpen] = useState(false)
  const [exOpen, setExOpen] = useState(false)
  const [stateReady, setStateReady] = useState(false)
  const [stateError, setStateError] = useState<string | null>(null)
  const [retry, setRetry] = useState(0)
  const gateRef = useRef(summary.gateId)
  const writes = useRef(Promise.resolve())
  useEffect(() => {
    let cancelled = false
    gateRef.current = summary.gateId
    setStateReady(false)
    setDupOpen(false)
    setExOpen(false)
    void window.mz.getBatchPresentation(summary.gateId).then(state => {
      if (cancelled) return
      setDupOpen(state.duplicatesOpen)
      setExOpen(state.excludedOpen)
      setStateError(null)
      setStateReady(true)
    }).catch(e => {
      if (!cancelled) setStateError(humanError(e))
    })
    return () => { cancelled = true }
  }, [summary.gateId, retry])
  const toggle = (field: 'duplicatesOpen' | 'excludedOpen', value: boolean): void => {
    const gateId = summary.gateId
    if (field === 'duplicatesOpen') setDupOpen(value)
    else setExOpen(value)
    writes.current = writes.current.then(async () => {
      try {
        await window.mz.setBatchPresentation(gateId, { [field]: value })
        if (gateRef.current === gateId) setStateError(null)
      } catch (e) {
        if (gateRef.current !== gateId) return
        setStateError(`折叠状态未能保存：${humanError(e)}`)
        try {
          const state = await window.mz.getBatchPresentation(gateId)
          if (gateRef.current === gateId) { setDupOpen(state.duplicatesOpen); setExOpen(state.excludedOpen) }
        } catch { /* 原因已可见，保留当前内容供核对。 */ }
      }
    })
  }
  const { booked, needsCategory, excluded, duplicates } = summary.counts

  return (
    <div className="mz-brbar" data-testid="batch-result-bar">
      <div className="mz-br-main">
        <span className="mz-dot mz-dot-blue" aria-hidden="true" />
        <div className="mz-br-segs">
          <span className="mz-br-seg" data-testid="br-booked">
            ✓ {booked} 已入账
          </span>
          <span
            className={`mz-br-seg${needsCategory > 0 ? ' mz-br-seg-warn' : ''}`}
            data-testid="br-needs-category"
          >
            ⏸ {needsCategory} 待分类
          </span>
          <span className="mz-br-seg" data-testid="br-excluded">
            ⊘ {excluded} 不计收支
          </span>
          <span className="mz-br-seg" data-testid="br-duplicates">
            ⧉ {duplicates} 重复跳过
          </span>
        </div>
        {/* UX2 收口：归类入口只剩「检查分类」那一个（收件箱卡片里），
            结果条不再并列「去面板归类 / 逐笔手动」两个入口——三处入口互相打架是上一版的病根。
            这里只留摘要 + ✕。 */}
        <div className="mz-br-actions">
          <button
            type="button"
            className="mz-br-x"
            data-testid="br-dismiss"
            aria-label="关闭批次结果条"
            title="关闭"
            onClick={onDismiss}
          >
            ✕
          </button>
        </div>
      </div>

      {/* 四段不是分区：待分类含在已入账里。这行必须独立成脚注——跟着四段排会被当成"第五段"，
          而且离它要修饰的"已入账"太远，反而加深误读 */}
      {needsCategory > 0 && (
        <div className="mz-br-subline">
          <span className="mz-br-note" data-testid="br-subset-note">
            已入账含 {needsCategory} 笔待分类
          </span>
        </div>
      )}

      {stateError && <p className="mz-ap-error" data-testid="br-state-error" role="alert">{stateError} <button className="mz-btn" data-testid="br-state-retry" onClick={() => setRetry(value => value + 1)}>重新读取</button></p>}
      <div className="mz-br-groups">
        <button
          type="button"
          className="mz-br-toggle"
          data-testid="br-dup-toggle"
          aria-expanded={dupOpen}
          disabled={!stateReady}
          onClick={() => toggle('duplicatesOpen', !dupOpen)}
        >
          <span className={`mz-chev${dupOpen ? ' is-open' : ''}`} aria-hidden="true">
            ▸
          </span>
          {' 重复跳过 '}
          {duplicates} 笔
        </button>
        {dupOpen && (
          <div className="mz-br-rows" data-testid="br-dup-rows">
            {summary.duplicatesRows.length === 0 ? (
              // 空态用**另一个**类名：.mz-br-row 专指"一行重复明细"，空态不是明细行
              <div className="mz-br-empty">这一批没有重复跳过的行</div>
            ) : (
              summary.duplicatesRows.map((r, i) => (
                <div key={i} className="mz-br-row">
                  <span className="mz-br-row-t">
                    {r.merchant ?? '未命名'} · {r.amountCents === null ? '金额未知' : money(r.amountCents)} ·{' '}
                    {r.reason}
                  </span>
                </div>
              ))
            )}
          </div>
        )}

        <button
          type="button"
          className="mz-br-toggle"
          data-testid="br-excluded-toggle"
          aria-expanded={exOpen}
          disabled={!stateReady}
          onClick={() => toggle('excludedOpen', !exOpen)}
        >
          <span className={`mz-chev${exOpen ? ' is-open' : ''}`} aria-hidden="true">
            ▸
          </span>
          {' 不计收支 '}
          {excluded} 行
        </button>
        {exOpen && (
          <div className="mz-br-rows" data-testid="br-excluded-note">
            <div className="mz-br-row">共 {excluded} 行按方案不计收支；逐行明细待后端</div>
            {/* 「全部恢复为正常收支」依赖 D-01（批量写工具），本单未实现 → 不渲染 */}
          </div>
        )}
      </div>
    </div>
  )
}
