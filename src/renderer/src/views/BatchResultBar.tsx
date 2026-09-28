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

import { useState } from 'react'
import type { ReactElement } from 'react'
import type { BatchResultSummaryDTO } from '../../../shared/types'
import { money } from '../lib/shellFormat'

export interface BatchResultBarProps {
  summary: BatchResultSummaryDTO
  /** 次级链接「逐笔手动」：带上 needs_review 筛选跳账本（筛选条件由调用方组装）。 */
  onGoLedger: () => void
  /** ②B G-03 主按钮：开面板并自动发出归类指令（走模型，不是跳账本）。 */
  onGoHandle: () => void
  /** ✕ 关闭：本单仅内存态（持久化 = D-04）。 */
  onDismiss: () => void
}

export function BatchResultBar({ summary, onGoLedger, onGoHandle, onDismiss }: BatchResultBarProps): ReactElement {
  const [dupOpen, setDupOpen] = useState(false)
  const [exOpen, setExOpen] = useState(false)
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
        {/* 主按钮与 ✕ 同属一个操作簇：分开排会被 584px 的收件箱列挤到下一行、
            ✕ 单独吊在左边像"删这一条"。成簇则要么都在右上行、要么整簇换行仍靠右。
            ②B G-03：主按钮走模型（开面板发指令），次级链接「逐笔手动」走人手动（跳账本） */}
        <div className="mz-br-actions">
          {/* 待分类清零 → 整条退化为摘要行，不留一个点了没用的按钮 */}
          {needsCategory > 0 && (
            <>
              <button
                type="button"
                className="mz-btn mz-btn-primary"
                data-testid="br-go-handle"
                onClick={onGoHandle}
              >
                去面板归类 {needsCategory} 笔 →
              </button>
              <button type="button" className="mz-br-link" data-testid="br-go-ledger" onClick={onGoLedger}>
                逐笔手动
              </button>
            </>
          )}
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

      <div className="mz-br-groups">
        <button
          type="button"
          className="mz-br-toggle"
          data-testid="br-dup-toggle"
          aria-expanded={dupOpen}
          onClick={() => setDupOpen((v) => !v)}
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
          onClick={() => setExOpen((v) => !v)}
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
