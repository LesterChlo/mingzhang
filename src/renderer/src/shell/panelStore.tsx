// 助手面板状态（②B 面板第一版 · K3 设计 P 组）。
//
// 存在的理由：上一单把「去处理 N 笔」做成跳账本——用户自己数、自己分类，
// 而引擎（D-01）早就能给出分组建议并落门确认，界面却没有入口。
// 这一单把面板立起来：能追问、能下指令、看得见它干了什么。
//
// 纪律：
//   ① 面板**关着也订阅**事件：关面板不许打断正在跑的一轮，重开要能看到期间发生的一切；
//   ② 消息流是**进程内**的（本单不做跨重启持久化 = D-04），但组件不卸载，历史不因开合而丢；
//   ③ 归类映射表只认引擎落的真卡：tool-end 的 details.card 与 pendingGateCards 两路同源，
//      绝不自己编一张表出来；
//   ④ 行内改分类**只落本地 state**，只有点确认才走 mz.applyClassify 写库。
//
// 状态一律**按 gateId 分桶**（行内编辑、执行回执、报错）：确认之后还会再拉一次门卡
// （同一轮里更早那张仍然开放的卡也会被拉回来），如果不按 gateId 分桶，
// 一次「同源重复入桶」就会把用户刚看到的「已归类 N 笔」抹掉、表格又变回可编辑——
// 界面在骗人，比不显示更糟。
//
// 引擎契约里两处缺口（上一单核实并上报）——**两处都已修**：
//   - ~~engine.ts 只广播 text-delta / tool-start / tool-end / agent-end / error 等，
//     不广播 user-message、turn-end~~ **已修（T0927-1610）**。现在的分工是：
//       · 用户气泡 = 本地乐观气泡（send() 推进来，pending=true）+ 引擎 user-message 回显确认
//         （同文本的乐观气泡原地转正，不新增）。速记行等非面板发起的轮次没有本地乐观气泡，
//         那条用户气泡就来自回显——这也是从速记行发的消息在面板流里看得见的原因。
//         去重只认 pending：**同一句话连发两次是两个气泡**，第二句是一次真实的发送。
//       · 一轮收尾 = turn-end（引擎在 doSendChat 的 finally 里广播，正常/报错/超时三条路径
//         各一次，且是这一轮最后一个事件）；agent-end 与 sendChat promise resolve 仍作为兜底保留。
//   - ~~classify_suggest 的模型可见文本里没有 group_key~~ **已修（T0927-1530）**：该工具
//     现在逐行输出 `- group_key=… · 商户=… · N 笔 · ¥… · 建议分类=…`，模型能自己读键调
//     classify_batch。面板不需要、也不许替它编指派——映射表一律只认引擎落的真卡。

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react'
import type { ReactNode } from 'react'
import type {
  ChatEvent,
  ClassifyAssignmentInput,
  ClassifyPlanCardData,
  ClassifyResultDTO,
  ClassifyUndoResultDTO,
} from '../../../shared/types'
import { appendThinkingDelta } from '../lib/thinking'

/** 工具名 → 中文标签。认不出来的工具照原名显示，不编一个像模像样的说法。 */
export const TOOL_LABELS: Record<string, string> = {
  classify_suggest: '看有哪些待分类',
  classify_batch: '生成归类方案',
  record: '记一笔',
  query: '查账',
  update: '改一笔',
  delete: '删除（待确认）',
  commit_batch: '批次入账（待确认）',
  apply_bill: '账单入账',
  read_bill: '读账单',
  split: '拆账',
  snapshot: '立即快照',
  settings_update: '改设置',
  teach: '记规则',
}

export function toolLabel(toolName: string): string {
  return TOOL_LABELS[toolName] ?? toolName
}

/** 流里的一项。id 只用于 React key 与「找最后一条同名运行中工具」。 */
export type PanelItem =
  /** 用户气泡。pending = 本地乐观入流、还没等到引擎回显确认（见文件头）。 */
  | { id: number; kind: 'user'; text: string; pending: boolean }
  | { id: number; kind: 'assistant'; text: string }
  /** 思考条：seconds 走秒；text 是这一轮 thinking-delta 累积出的真实正文（契约A），
   *  超 THINK_TEXT_CAP 截断并标记；正文为空时展开区保留"未接"占位（不编内容）。 */
  | { id: number; kind: 'thinking'; seconds: number; running: boolean; text: string; truncated: boolean }
  | { id: number; kind: 'turn-end' }
  | {
      id: number
      kind: 'tool'
      toolName: string
      status: 'running' | 'done' | 'error'
      summary: string
      card?: ClassifyPlanCardData
    }

/** 某一张方案卡走到哪一步了（按 gateId 分桶，见文件头）。 */
export interface ClassifyOutcome {
  gateId: number
  applied: ClassifyResultDTO | null
  undone: ClassifyUndoResultDTO | null
  error: string | null
}

export interface PanelValue {
  open: boolean
  openPanel: () => void
  closePanel: () => void
  togglePanel: () => void
  items: PanelItem[]
  /** 这一轮还在跑（思考条正在走秒；输入框禁用）。 */
  busy: boolean
  /** 归类方案卡：流里来的与门卡来的同源去重，按到达顺序，最新一张是当前那张。 */
  plans: ClassifyPlanCardData[]
  /** 行内编辑：gateId → (groupKey → 输入值)。只在本进程内存里，点确认前绝不写库。 */
  planEdits: Record<number, Record<string, string>>
  /** 各方案卡的执行回执 / 报错，按 gateId 分桶。 */
  outcomes: Record<number, ClassifyOutcome>
  setPlanValue: (gateId: number, groupKey: string, value: string) => void
  applyClassify: (gateId: number, rows: ClassifyAssignmentInput[]) => Promise<void>
  undoClassify: (gateId: number, classifyId: string) => Promise<void>
  refreshGates: () => Promise<void>
  send: (text: string) => Promise<void>
}

/** 归类写库后告诉收件箱「账变了」：收件箱的待决数与结果条必须跟上（不靠猜）。 */
export const LEDGER_CHANGED_EVENT = 'mz:ledger-changed'

export function notifyLedgerChanged(): void {
  window.dispatchEvent(new CustomEvent(LEDGER_CHANGED_EVENT))
}

const PanelCtx = createContext<PanelValue | null>(null)

export function usePanel(): PanelValue {
  const v = useContext(PanelCtx)
  if (!v) throw new Error('usePanel 必须在 PanelProvider 内使用')
  return v
}

export function PanelProvider({ children }: { children: ReactNode }): ReactNode {
  const [open, setOpen] = useState(false)
  const [items, setItems] = useState<PanelItem[]>([])
  const [busy, setBusy] = useState(false)
  const [plans, setPlans] = useState<ClassifyPlanCardData[]>([])
  const [planEdits, setPlanEdits] = useState<Record<number, Record<string, string>>>({})
  const [outcomes, setOutcomes] = useState<Record<number, ClassifyOutcome>>({})

  const seq = useRef(0)
  const nextId = useCallback(() => ++seq.current, [])
  const busyRef = useRef(false)
  const thinkIdRef = useRef<number | null>(null)
  const thinkStartRef = useRef(0)

  const setBusyBoth = useCallback((v: boolean) => {
    busyRef.current = v
    setBusy(v)
  }, [])

  /** 一轮开始：起一个思考条，从这里开始走秒。 */
  const beginTurn = useCallback(() => {
    const id = nextId()
    thinkIdRef.current = id
    thinkStartRef.current = Date.now()
    setBusyBoth(true)
    setItems((prev) => [...prev, { id, kind: 'thinking', seconds: 0, running: true, text: '', truncated: false }])
  }, [nextId, setBusyBoth])

  /** 一轮结束：思考条定稿（不是删掉——用户还要看它想了多久）。 */
  const endTurn = useCallback(() => {
    const id = thinkIdRef.current
    if (id === null) {
      setBusyBoth(false)
      return
    }
    const secs = Math.max(0, Math.floor((Date.now() - thinkStartRef.current) / 1000))
    setItems((prev) =>
      prev.map((it) => (it.id === id && it.kind === 'thinking' ? { ...it, seconds: secs, running: false } : it)),
    )
    thinkIdRef.current = null
    setBusyBoth(false)
  }, [setBusyBoth])

  // 走秒：报的是这一轮真实过了多久。展开态会说明「思考全文通道未接」，
  // 不拿一句编出来的思考内容糊弄用户（那属于 D-02 的活）。
  useEffect(() => {
    if (!busy) return
    const t = window.setInterval(() => {
      const id = thinkIdRef.current
      if (id === null) return
      const secs = Math.max(0, Math.floor((Date.now() - thinkStartRef.current) / 1000))
      setItems((prev) => prev.map((it) => (it.id === id && it.kind === 'thinking' ? { ...it, seconds: secs } : it)))
    }, 1000)
    return () => window.clearInterval(t)
  }, [busy])

  /** 本地乐观气泡：send() 推的那一条（pending=true，等引擎回显来确认）。
   *  引擎回显之前界面不能空着——用户点了发送就得看见自己那句话。 */
  const pushUserLocal = useCallback((text: string) => {
    setItems((prev) => [...prev, { id: ++seq.current, kind: 'user', text, pending: true }])
  }, [])

  /** 引擎回显确认（user-message 事件）：
   *  最后一条是同文本的本地乐观气泡 → **原地**转正，不新增（面板自己发的那句只该有一条）；
   *  其它情况（速记行等不是面板发起的轮次，面板本地没有乐观气泡）→ 追加一条。
   *  刻意不用"最后一条同文本就跳过"那套去重：同一句话**连发两次**是两个气泡，
   *  第二句是该被看见的一次发送，不是重复。 */
  const confirmUser = useCallback((text: string) => {
    setItems((prev) => {
      const last = prev[prev.length - 1]
      if (last && last.kind === 'user' && last.pending && last.text === text) {
        const next = prev.slice()
        next[next.length - 1] = { ...last, pending: false }
        return next
      }
      return [...prev, { id: ++seq.current, kind: 'user', text, pending: false }]
    })
  }, [])

  /**
   * 收一张方案卡。同一个 gateId 重复入桶（流里来一次、门卡再拉一次）是常态：
   * 卡片内容原地替换，**行内编辑与执行回执一个字都不动**。
   */
  const addPlan = useCallback((card: ClassifyPlanCardData) => {
    setPlans((prev) => {
      const i = prev.findIndex((p) => p.gateId === card.gateId)
      if (i < 0) return [...prev, card]
      const next = prev.slice()
      next[i] = card
      return next
    })
    setPlanEdits((prev) =>
      prev[card.gateId]
        ? prev
        : {
            ...prev,
            [card.gateId]: Object.fromEntries(card.groups.map((g) => [g.groupKey, g.categoryName ?? ''])),
          },
    )
  }, [])

  const refreshGates = useCallback(async () => {
    try {
      const gates = await window.mz.pendingGateCards()
      for (const g of gates) {
        if (g.field === 'batch_classify' && g.card.kind === 'classify-plan') addPlan(g.card)
      }
    } catch {
      // 门卡拉不到不是致命错：流里那张卡仍然能确认，不静默改口径（面板会照常显示已有那张）
    }
  }, [addPlan])

  // 事件流：**面板关着也订阅**（关面板不打断任务，期间发生的一切重开都还在）
  useEffect(() => {
    const off = window.mz.onChatEvent((evt: ChatEvent) => {
      switch (evt.type) {
        case 'user-message': {
          confirmUser(String(evt.payload?.text ?? ''))
          break
        }
        case 'text-delta': {
          const delta = String(evt.payload?.delta ?? '')
          if (!delta) break
          if (!busyRef.current) beginTurn() // 速记行发起的轮：这里补起思考条
          setItems((prev) => {
            const last = prev[prev.length - 1]
            if (last && last.kind === 'assistant') {
              return [...prev.slice(0, -1), { ...last, text: last.text + delta }]
            }
            return [...prev, { id: ++seq.current, kind: 'assistant', text: delta }]
          })
          break
        }
        case 'thinking-delta': {
          // 契约A：模型 thinking 期间的正文增量。按轮累积到当前思考条（带上限），
          // 轮结束后留在条上供展开查看；没有现成思考条就补起一轮（与 text-delta 同口径）。
          const delta = String(evt.payload?.delta ?? '')
          if (!delta) break
          if (!busyRef.current) beginTurn()
          const id = thinkIdRef.current
          setItems((prev) =>
            prev.map((it) =>
              it.id === id && it.kind === 'thinking' ? { ...it, ...appendThinkingDelta(it, delta) } : it,
            ),
          )
          break
        }
        case 'tool-start': {
          if (!busyRef.current) beginTurn()
          setItems((prev) => [
            ...prev,
            {
              id: ++seq.current,
              kind: 'tool',
              toolName: String(evt.payload?.toolName ?? ''),
              status: 'running',
              summary: '运行中…',
            },
          ])
          break
        }
        case 'tool-end': {
          const toolName = String(evt.payload?.toolName ?? '')
          const isError = Boolean(evt.payload?.isError)
          const summary = String(evt.payload?.text ?? '').trim()
          setItems((prev) => {
            // 找最后一条同名、还在 running 的工具项（嵌套调用时不会串行）
            for (let i = prev.length - 1; i >= 0; i--) {
              const it = prev[i]
              if (it.kind === 'tool' && it.toolName === toolName && it.status === 'running') {
                const next = prev.slice()
                next[i] = { ...it, status: isError ? 'error' : 'done', summary: summary || it.summary }
                return next
              }
            }
            return [
              ...prev,
              {
                id: ++seq.current,
                kind: 'tool',
                toolName,
                status: isError ? 'error' : 'done',
                summary,
              },
            ]
          })
          const card = evt.payload?.details?.card
          if (card && card.kind === 'classify-plan') addPlan(card as ClassifyPlanCardData)
          break
        }
        case 'turn-end':
        case 'agent-end': {
          endTurn()
          // 引擎现在一轮会发 turn-end（权威收尾）**和** agent-end（兜底）两个信号，
          // 两个都收口，但一轮只画一条分隔线——否则每轮之间会多出一道空 hr。
          setItems((prev) => {
            const last = prev[prev.length - 1]
            if (last && last.kind === 'turn-end') return prev
            return [...prev, { id: ++seq.current, kind: 'turn-end' }]
          })
          break
        }
        case 'error': {
          // 失败不静默：把引擎给的原文说清楚
          setItems((prev) => [
            ...prev,
            { id: ++seq.current, kind: 'assistant', text: `⚠ ${String(evt.payload?.message ?? '出错了')}` },
          ])
          endTurn()
          break
        }
        case 'gate-executed':
        case 'record-confirmed': {
          void refreshGates()
          break
        }
        default:
          break
      }
    })
    return off
  }, [addPlan, beginTurn, confirmUser, endTurn, refreshGates])

  // 打开面板时拉一次开放门卡：重载、切屏、关着面板跑完一轮之后靠它把方案找回来
  useEffect(() => {
    if (!open) return
    void refreshGates()
  }, [open, refreshGates])

  const openPanel = useCallback(() => setOpen(true), [])
  const closePanel = useCallback(() => setOpen(false), [])
  const togglePanel = useCallback(() => setOpen((v) => !v), [])

  const send = useCallback(
    async (text: string) => {
      const t = text.trim()
      if (!t) return
      beginTurn()
      pushUserLocal(t)
      try {
        await window.mz.sendChat(t, [])
        // sendChat 的 promise 在整轮结束时 resolve——与 turn-end / agent-end 三重保险收尾，
        // 免得引擎哪天少发一个事件就把输入框永久锁死
        endTurn()
      } catch (e) {
        setItems((prev) => [
          ...prev,
          { id: ++seq.current, kind: 'assistant', text: `⚠ 没发出去：${String(e)}` },
        ])
        endTurn()
      }
    },
    [beginTurn, endTurn, pushUserLocal],
  )

  const setPlanValue = useCallback((gateId: number, groupKey: string, value: string) => {
    setPlanEdits((prev) => ({ ...prev, [gateId]: { ...(prev[gateId] ?? {}), [groupKey]: value } }))
  }, [])

  const applyClassify = useCallback(
    async (gateId: number, rows: ClassifyAssignmentInput[]) => {
      const fail = (error: string): void =>
        setOutcomes((prev) => ({ ...prev, [gateId]: { gateId, applied: null, undone: null, error } }))
      try {
        const r = await window.mz.applyClassify(gateId, rows)
        if (r === null) {
          // 门被处理过了：如实说，绝不假装成功
          fail('这道门已经处理过了（可能刚才已确认）')
          return
        }
        setOutcomes((prev) => ({ ...prev, [gateId]: { gateId, applied: r, undone: null, error: null } }))
        if (r.appliedCount > 0) {
          // 账真的动了 → 收件箱的待决数与结果条必须跟上
          notifyLedgerChanged()
        }
        void refreshGates()
      } catch (e) {
        fail(`归类没成功：${String(e)}`)
      }
    },
    [refreshGates],
  )

  const undoClassify = useCallback(
    async (gateId: number, classifyId: string) => {
      try {
        const r = await window.mz.undoClassify(classifyId)
        setOutcomes((prev) => ({ ...prev, [gateId]: { gateId, applied: null, undone: r, error: null } }))
        notifyLedgerChanged()
        void refreshGates()
      } catch (e) {
        setOutcomes((prev) => ({
          ...prev,
          [gateId]: { gateId, applied: null, undone: null, error: `撤销没成功：${String(e)}` },
        }))
      }
    },
    [refreshGates],
  )

  const value = useMemo<PanelValue>(
    () => ({
      open,
      openPanel,
      closePanel,
      togglePanel,
      items,
      busy,
      plans,
      planEdits,
      outcomes,
      setPlanValue,
      applyClassify,
      undoClassify,
      refreshGates,
      send,
    }),
    [
      open,
      openPanel,
      closePanel,
      togglePanel,
      items,
      busy,
      plans,
      planEdits,
      outcomes,
      setPlanValue,
      applyClassify,
      undoClassify,
      refreshGates,
      send,
    ],
  )

  // 供巡检/调试读的稳定引用（不参与渲染）
  useEffect(() => {
    ;(window as unknown as { __mzPanel?: PanelValue }).__mzPanel = value
  }, [value])

  return <PanelCtx.Provider value={value}>{children}</PanelCtx.Provider>
}
