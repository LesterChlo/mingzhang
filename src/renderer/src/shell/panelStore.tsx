// 助手面板状态（②B 面板第一版 · K3 设计 P 组）。
//
// 存在的理由：上一单把「去处理 N 笔」做成跳账本——用户自己数、自己分类，
// 而引擎（D-01）早就能给出分组建议并落门确认，界面却没有入口。
// 这一单把面板立起来：能追问、能下指令、看得见它干了什么。
//
// 纪律：
//   ① 面板**关着也订阅**事件：关面板不许打断正在跑的一轮，重开要能看到期间发生的一切；
//   ② 消息流从真实会话历史读回；初始化与实时流按进程、会话和序号分桶，历史不另存副本；
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
import { eventsAfterSnapshot, panelItemsFromHistory } from '../lib/panelHistory'

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
  | { id: number | string; kind: 'user'; text: string; pending: boolean; images?: { previewUrl: string; fileName: string }[] }
  | { id: number | string; kind: 'assistant'; text: string }
  | { id: number | string; kind: 'notice'; text: string }
  /** 思考条：seconds 走秒；text 是这一轮 thinking-delta 累积出的真实正文（契约A），
   *  超 THINK_TEXT_CAP 截断并标记；正文为空时展开区保留"未接"占位（不编内容）。 */
  | { id: number | string; kind: 'thinking'; seconds: number; running: boolean; text: string; truncated: boolean; historical?: boolean }
  | { id: number | string; kind: 'turn-end' }
  | {
      id: number | string
      kind: 'tool'
      toolCallId?: string
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
  historyLoading: boolean
  historyError: string | null
  reloadHistory: () => Promise<void>
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
  const [historyLoading, setHistoryLoading] = useState(true)
  const [historyError, setHistoryError] = useState<string | null>(null)
  const loadHistoryRef = useRef<() => Promise<void>>(async () => {})
  const reloadHistory = useCallback(() => loadHistoryRef.current(), [])
  const [plans, setPlans] = useState<ClassifyPlanCardData[]>([])
  const [planEdits, setPlanEdits] = useState<Record<number, Record<string, string>>>({})
  const [outcomes, setOutcomes] = useState<Record<number, ClassifyOutcome>>({})

  const seq = useRef(0)
  const nextId = useCallback(() => ++seq.current, [])
  const busyRef = useRef(false)
  const thinkIdRef = useRef<number | string | null>(null)
  const thinkStartRef = useRef(0)
  const resolvedPlans = useRef(new Set<number>())
  const gateEpoch = useRef(0)
  const failureNoticeId = useRef<number | null>(null)
  const localSendNoticeId = useRef<number | null>(null)
  const showFailure = useCallback((id: number, text: string) => {
    setItems(previous => {
      const index = previous.findIndex(item => item.id === id && item.kind === 'notice')
      const notice: PanelItem = { id, kind: 'notice', text }
      if (index < 0) return [...previous, notice]
      const next = previous.slice()
      next[index] = notice
      return next
    })
  }, [])

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
      const epoch = gateEpoch.current
      const gates = await window.mz.pendingGateCards()
      if (epoch !== gateEpoch.current) return
      const live = new Set(gates.filter(g => g.field === 'batch_classify' && g.card.kind === 'classify-plan').map(g => g.gateId))
      setPlans(prev => prev.filter(p => live.has(p.gateId) || resolvedPlans.current.has(p.gateId)))
      for (const g of gates) {
        if (g.field === 'batch_classify' && g.card.kind === 'classify-plan') addPlan(g.card)
      }
    } catch {
      // 门卡拉不到不是致命错：流里那张卡仍然能确认，不静默改口径（面板会照常显示已有那张）
    }
  }, [addPlan])

  // 先订阅再读快照；快照等待期间的新事件按流身份/序号缓冲，而不是靠相同文本去重。
  useEffect(() => {
    let disposed = false
    let generation = 0
    let syncing = false
    let deferredSnapshot = false
    let identity: { sessionId: string | null; streamId: string | null } = { sessionId: null, streamId: null }
    let cursor = 0
    let buffered: ChatEvent[] = []
    const resetSession = (): void => {
      gateEpoch.current += 1
      setItems([])
      setPlans([])
      setPlanEdits({})
      setOutcomes({})
      resolvedPlans.current.clear()
      failureNoticeId.current = null
      localSendNoticeId.current = null
      thinkIdRef.current = null
      setBusyBoth(false)
    }
    const consume = (evt: ChatEvent): void => {
      if (identity.streamId === null && evt.streamId && evt.sessionId) identity = { streamId: evt.streamId, sessionId: evt.sessionId }
      if (evt.sessionId !== identity.sessionId || evt.streamId !== identity.streamId) return
      if (typeof evt.eventSeq === 'number') {
        if (evt.eventSeq <= cursor) return
        cursor = evt.eventSeq
      }
      switch (evt.type) {
        case 'user-message': {
          failureNoticeId.current = localSendNoticeId.current ?? nextId()
          localSendNoticeId.current = null
          if (evt.payload?.hasImage) deferredSnapshot = true
          confirmUser(String(evt.payload?.text ?? ''))
          break
        }
        case 'text-delta': {
          const delta = String(evt.payload?.delta ?? '')
          if (!delta) break
          if (!busyRef.current || thinkIdRef.current === null) beginTurn() // 速记行发起的轮：这里补起思考条
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
          if (!busyRef.current || thinkIdRef.current === null) beginTurn()
          const id = thinkIdRef.current
          setItems((prev) =>
            prev.map((it) =>
              it.id === id && it.kind === 'thinking' ? { ...it, ...appendThinkingDelta(it, delta) } : it,
            ),
          )
          break
        }
        case 'tool-start': {
          if (!busyRef.current || thinkIdRef.current === null) beginTurn()
          setItems((prev) => [
            ...prev,
            {
              id: ++seq.current,
              kind: 'tool',
              toolName: String(evt.payload?.toolName ?? ''),
              toolCallId: evt.payload?.toolCallId,
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
              if (it.kind === 'tool' && it.toolName === toolName && it.status === 'running' && (!evt.payload?.toolCallId || it.toolCallId === evt.payload.toolCallId)) {
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
          if (evt.type === 'turn-end' && deferredSnapshot) {
            deferredSnapshot = false
            queueMicrotask(() => { if (!disposed) void loadHistoryRef.current() })
          }
          break
        }
        case 'error': {
          // 引擎失败是本地发送状态，不冒充模型生成的答复。
          const id = failureNoticeId.current ?? nextId()
          failureNoticeId.current = id
          showFailure(id, `发送失败：${String(evt.payload?.message ?? '出错了')}`)
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
    }
    const load = async (): Promise<void> => {
      const request = ++generation
      syncing = true
      setHistoryLoading(true)
      try {
        const snapshot = await window.mz.getPanelHistory()
        if (disposed || request !== generation) return
        if (identity.sessionId !== snapshot.sessionId || identity.streamId !== snapshot.streamId) {
          resetSession()
          cursor = 0
        }
        identity = { sessionId: snapshot.sessionId, streamId: snapshot.streamId }
        if (!snapshot.busy) {
          const recovered = panelItemsFromHistory(snapshot.messages)
          setItems(previous => {
            const optimistic = previous.filter(item => item.kind === 'user' && item.pending)
            const thinking = optimistic.length ? previous.filter(item => item.kind === 'thinking' && item.running) : []
            return [...recovered, ...thinking, ...optimistic]
          })
          cursor = snapshot.eventCursor
          if (!busyRef.current || !thinkIdRef.current) {
            thinkIdRef.current = null
            setBusyBoth(false)
          }
        } else {
          // 正在写入的一轮不拿半轮快照冒充最终历史；最后turn-end再读取完整JSONL。
          deferredSnapshot = true
          setBusyBoth(true)
        }
        setHistoryError(null)
        const queued = snapshot.busy
          ? buffered.filter(event => event.sessionId === snapshot.sessionId && event.streamId === snapshot.streamId)
          : eventsAfterSnapshot(buffered, snapshot)
        buffered = []
        syncing = false
        for (const event of queued) consume(event)
        void refreshGates()
      } catch (error) {
        if (disposed || request !== generation) return
        setHistoryError(String(error).replace(/^Error: /, '').replace(/^Error invoking remote method '[^']*':\s*/, ''))
        syncing = false
        const queued = buffered
        buffered = []
        for (const event of queued) consume(event)
      } finally {
        if (!disposed && request === generation) setHistoryLoading(false)
      }
    }
    const off = window.mz.onChatEvent((evt: ChatEvent) => {
      if (evt.type === 'session-changed') {
        identity = { sessionId: evt.sessionId ?? null, streamId: evt.streamId ?? null }
        cursor = 0
        buffered = []
        resetSession()
        void load()
        return
      }
      if (syncing) buffered.push(evt)
      else consume(evt)
    })
    loadHistoryRef.current = load
    void load()
    return () => {
      disposed = true
      generation += 1
      off()
      loadHistoryRef.current = async () => {}
    }
  }, [addPlan, beginTurn, confirmUser, endTurn, nextId, refreshGates, setBusyBoth, showFailure])

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
      if (!t || historyLoading || busyRef.current) return
      const sessionEpoch = gateEpoch.current
      const noticeId = nextId()
      localSendNoticeId.current = noticeId
      failureNoticeId.current = noticeId
      beginTurn()
      pushUserLocal(t)
      try {
        await window.mz.sendChat(t, [])
        if (sessionEpoch !== gateEpoch.current) return
        // sendChat 的 promise 在整轮结束时 resolve——与 turn-end / agent-end 三重保险收尾，
        // 免得引擎哪天少发一个事件就把输入框永久锁死
        endTurn()
      } catch (e) {
        if (sessionEpoch !== gateEpoch.current) return
        // IPC reject 与事件可能以任一顺序到达，同一发送用同一ID回填。
        showFailure(noticeId, `没发出去：${String(e)}`)
        endTurn()
      }
    },
    [beginTurn, endTurn, nextId, pushUserLocal, historyLoading, showFailure],
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
        resolvedPlans.current.add(gateId)
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
        resolvedPlans.current.add(gateId)
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
      historyLoading,
      historyError,
      reloadHistory,
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
      historyLoading,
      historyError,
      reloadHistory,
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
