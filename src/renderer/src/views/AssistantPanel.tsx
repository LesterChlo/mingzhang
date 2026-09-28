// 助手面板本体（②B · K3 P 组）：流 + 思考条 + 工具卡 + 归类映射表。
//
// 为什么面板是**第三列**而不是浮层：用户问一句的同时还得看着账本——
// 浮层会把账盖住，用户只能反复开合。推挤式让两件事同屏可见。
//
// 为什么收起时**不卸载**（只 aria-hidden + 视觉隐藏）：面板是"这一轮发生了什么"的唯一现场，
// 关一下再打开就该看到完整历史，而不是被清空重来。
//
// 纪律：
//   ① 全部文案是确定性模板句，一个字都不调模型；
//   ② 数字（笔数/组数/金额/回执）全部来自引擎落的 classify-plan 卡与执行回执，不自己算；
//   ③ 没接上的依赖（思考全文 = D-02）直说"未接"，不渲染假内容；
//   ④ 类名一律 mz-ap-*：.mz-panel / .mz-panel-title 已经被收件箱右栏的月卡占用了。

import { useEffect, useMemo, useRef, useState } from 'react'
import type { FormEvent, ReactElement } from 'react'
import type { ClassifyPlanCardData } from '../../../shared/types'
import { money } from '../lib/shellFormat'
import { renderMarkdown } from '../lib/markdown'
import { THINK_TEXT_CAP } from '../lib/thinking'
import { toolLabel, usePanel } from '../shell/panelStore'
import type { PanelItem } from '../shell/panelStore'

/** 距底多少像素以内算"在底部"（贴底判定阈值：往上翻过这个量就不抢滚）。 */
const STICK_THRESHOLD_PX = 24

export function AssistantPanel(): ReactElement {
  const { open, items, busy, plans, planEdits, outcomes, setPlanValue, applyClassify, undoClassify, send } = usePanel()
  const [text, setText] = useState('')

  // A 单：新消息自动贴底 —— 用户在底部时才贴（往上翻过就不抢）；
  // 自己发新消息时无条件回贴（send 里把 stickRef 置回 true）。
  const streamRef = useRef<HTMLDivElement | null>(null)
  const stickRef = useRef(true)
  const onStreamScroll = (): void => {
    const el = streamRef.current
    if (!el) return
    stickRef.current = el.scrollTop + el.clientHeight >= el.scrollHeight - STICK_THRESHOLD_PX
  }
  useEffect(() => {
    const el = streamRef.current
    if (el && stickRef.current) el.scrollTop = el.scrollHeight
  }, [items])

  /** 当前那张方案：同一 gateId 只渲染一份，以最新为准。 */
  const plan: ClassifyPlanCardData | null = plans.length > 0 ? plans[plans.length - 1] : null
  const gateId = plan?.gateId ?? -1
  const edits = planEdits[gateId] ?? {}
  // 回执按 gateId 分桶：别的门卡的回执不会串到这张表上（同源重复入桶也不该抹掉回执）
  const outcome = plan ? outcomes[gateId] : undefined
  const resolved = outcome !== undefined

  const totalCount = useMemo(() => (plan ? plan.groups.reduce((s, g) => s + g.count, 0) : 0), [plan])
  const assignedCount = useMemo(
    () =>
      plan
        ? plan.groups.filter((g) => (edits[g.groupKey] ?? '').trim() !== '').reduce((s, g) => s + g.count, 0)
        : 0,
    [plan, edits],
  )

  const submit = (e: FormEvent): void => {
    e.preventDefault()
    const t = text
    setText('')
    stickRef.current = true // 自己发话：无论之前翻到哪，都回贴最新
    void send(t)
  }

  return (
    <aside
      className={`mz-ap${open ? '' : ' is-closed'}`}
      data-testid="assistant-panel"
      aria-hidden={!open}
      aria-label="助手面板"
    >
      <header className="mz-ap-head">
        <span className="mz-ap-title">助手</span>
        <span className="mz-ap-state" data-testid="panel-state">
          {busy ? '处理中…' : '就绪'}
        </span>
      </header>

      <div className="mz-ap-stream" data-testid="panel-stream" ref={streamRef} onScroll={onStreamScroll}>
        {items.length === 0 ? (
          <p className="mz-ap-hint">
            问一句，或者点结果条上的「去面板归类」——它会先列出待分类的账，再让你在下面那张表里逐组确认。
          </p>
        ) : (
          items.map((it) => <PanelRow key={it.id} item={it} />)
        )}

        {/* 归类映射表：门卡是数据源，没有卡就是没有待分类——空态直说，不画一张空表 */}
        {!plan && (
          <p className="mz-ap-empty" data-testid="cls-empty">
            现在没有待分类的账
          </p>
        )}
        {plan && !resolved && (
          <div className="mz-cls" data-testid="classify-table">
            <div className="mz-cls-head" data-testid="classify-head">
              归类方案 · {totalCount} 笔 · {plan.groups.length} 组
            </div>
            <div className="mz-cls-cols" aria-hidden="true">
              <span>商户</span>
              <span>笔数</span>
              <span>金额</span>
              <span>分类</span>
            </div>
            {plan.groups.map((g) => (
              <div className="mz-cls-row" data-testid="cls-row" key={g.groupKey}>
                <span className="mz-cls-merchant" data-testid="cls-merchant">
                  {g.merchant ?? '未命名'}
                </span>
                <span className="mz-cls-count" data-testid="cls-count">
                  {g.count} 笔
                </span>
                <span className="mz-cls-amount" data-testid="cls-amount">
                  {money(g.totalCents)}
                </span>
                <input
                  className="mz-cls-cat"
                  data-testid="cls-cat"
                  aria-label={`${g.merchant ?? '未命名'} 的分类`}
                  placeholder="未定"
                  value={edits[g.groupKey] ?? ''}
                  onChange={(e) => setPlanValue(plan.gateId, g.groupKey, e.target.value)}
                />
              </div>
            ))}
            <p className="mz-cls-note">未定分类的组会在确认时跳过</p>
            <button
              type="button"
              className="mz-btn mz-btn-primary mz-cls-apply"
              data-testid="cls-apply"
              onClick={() =>
                void applyClassify(
                  plan.gateId,
                  plan.groups.map((g) => ({
                    groupKey: g.groupKey,
                    // 空输入传空串：引擎会把这组记成跳过，而不是替用户猜一个分类
                    categoryName: (edits[g.groupKey] ?? '').trim(),
                  })),
                )
              }
            >
              确认归类（{assignedCount} 笔）
            </button>
          </div>
        )}

        {outcome?.error && (
          <p className="mz-ap-error" data-testid="cls-error" role="alert">
            {outcome.error}
          </p>
        )}
        {plan && resolved && (
          <div className="mz-cls">
            {outcome?.applied && (
              <p className="mz-cls-result" data-testid="cls-result">
                已归类 {outcome.applied.appliedCount} 笔
                {outcome.applied.skipped.length > 0 ? `，${outcome.applied.skipped.length} 笔跳过` : ''}
              </p>
            )}
            {outcome?.undone && (
              <p className="mz-cls-result" data-testid="cls-undo-result">
                已撤销 {outcome.undone.revertedCount} 笔
              </p>
            )}
            <button
              type="button"
              className="mz-btn mz-cls-undo"
              data-testid="cls-undo"
              onClick={() => void undoClassify(plan.gateId, plan.classifyId)}
            >
              撤销这次归类
            </button>
          </div>
        )}
      </div>

      <form className="mz-ap-composer" onSubmit={submit}>
        <input
          value={text}
          disabled={busy}
          data-testid="panel-input"
          aria-label="给助手下指令"
          placeholder="说一句，或让它去归类 —— 例：把待分类的账按建议归类"
          onChange={(e) => setText(e.target.value)}
        />
        <button type="submit" className="mz-btn mz-btn-primary" data-testid="panel-send" disabled={busy}>
          发送
        </button>
      </form>
    </aside>
  )
}

/** 流里的一项。 */
function PanelRow({ item }: { item: PanelItem }): ReactElement | null {
  switch (item.kind) {
    case 'user':
      // A 单（聊天化）：用户靠右气泡 + 角色标；pending = 本地乐观入流还没等来回显（淡化表示）
      return (
        <div className={`mz-ap-line is-user${item.pending ? ' is-pending' : ''}`} data-testid="panel-msg-user">
          <span className="mz-ap-role" data-testid="panel-msg-role">
            你
          </span>
          <div className="mz-ap-bubble mz-ap-bubble-user">{item.text}</div>
        </div>
      )
    case 'assistant':
      // A 单：助手靠左气泡 + 角色标；正文按 Markdown 白名单渲染（T0928 §3）
      return (
        <div className="mz-ap-line is-assistant" data-testid="panel-msg-assistant">
          <span className="mz-ap-role" data-testid="panel-msg-role">
            助手
          </span>
          <div className="mz-ap-bubble mz-ap-bubble-assistant">{renderMarkdown(item.text)}</div>
        </div>
      )
    case 'turn-end':
      return <hr className="mz-ap-sep" data-testid="panel-turn-sep" />
    case 'tool':
      return (
        <div className={`mz-ap-tool mz-ap-tool-${item.status}`} data-testid="panel-tool" data-status={item.status}>
          <span className="mz-ap-tool-label">{toolLabel(item.toolName)}</span>
          <span className="mz-ap-tool-status">
            {item.status === 'running' ? '运行中…' : item.status === 'error' ? '失败' : '完成'}
          </span>
          {item.summary ? <span className="mz-ap-tool-sum">{item.summary}</span> : null}
        </div>
      )
    case 'thinking':
      return <ThinkRow seconds={item.seconds} running={item.running} text={item.text} truncated={item.truncated} />
  }
}

/** 思考条展开区（导出给 vitest：空正文占位 / 真实正文 / 截断标记三态）。
 *  有正文渲染真实思考全文（弱化/等宽）；没有正文才显示"未接"占位——不编内容。 */
export function ThinkFull({ text, truncated }: { text: string; truncated: boolean }): ReactElement {
  if (!text.trim()) {
    return (
      <p className="mz-ap-think-full" data-testid="panel-think-full">
        思考全文通道未接（D-02），先显示耗时
      </p>
    )
  }
  return (
    <div className="mz-ap-think-full" data-testid="panel-think-full">
      {truncated && <p className="mz-ap-think-trunc">思考较长，只保留前 {THINK_TEXT_CAP} 字</p>}
      <pre className="mz-ap-think-text">{text}</pre>
    </div>
  )
}

/** 思考条：折叠只报这一轮真实耗时；展开显示真实思考正文（T0928 §4 契约A）。 */
function ThinkRow({
  seconds,
  running,
  text,
  truncated,
}: {
  seconds: number
  running: boolean
  text: string
  truncated: boolean
}): ReactElement {
  const [open, setOpen] = useState(false)
  return (
    <div className="mz-ap-think">
      <button
        type="button"
        className="mz-ap-think-btn"
        data-testid="panel-think"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
      >
        {running ? `思考中 · ${seconds}s` : `思考 ${seconds}s`}
      </button>
      {open && <ThinkFull text={text} truncated={truncated} />}
    </div>
  )
}
