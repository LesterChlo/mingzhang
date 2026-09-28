// 收件箱数据接线（方向 A 第 2 切片）。
//
// 这里是**唯一**的待决数据源：左栏角标、右栏「待决数」、待决卡片队列、今天已记都从它读，
// 天然同源（规格 §1.1 角标 / §3.1 布局）。
//
// 纪律：
//   ① 只用已存在的 IPC 通道（preload 暴露面），不新增通道、不改主进程；
//   ② 任何操作（确认/取消/补答/改字段）执行后**必定** refresh，杜绝"点了界面不动"；
//   ③ 每种 status 都有可见文案（ExecResult 五态），失败不静默；
//   ④ 数据类错误走 §2.4 出错范式（红边 + 重试），并保留恢复入口文案。

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
  BatchResultSummaryDTO,
  ChatEvent,
  ExecResult,
  PendingGateCardDTO,
  PendingItemDTO,
  SettingsInfoDTO,
  TxDetailDTO,
} from '../../../shared/types'
import { LEDGER_CHANGED_EVENT } from './panelStore'

export interface ToastMsg {
  text: string
  tone: 'ok' | 'err' | 'info'
}

/** 提交后正在解析的一轮（速记行 → 收件箱的「待解析卡片」）。 */
export interface InflightTurn {
  text: string
  images: number
  at: number
}

/** 界面保险丝的**兜底**默认值（毫秒）——主进程给值之前的占位。
 *  等于引擎空闲超时（默认 60s）+ 30s 余量，与 uiFallbackWaitMs() 的默认口径一致；
 *  真正的阈值由 mz:getSettingsInfo 随设置信息下发（见 fuseMsRef），不写死在这里。
 *  它是保险丝而不是失败判据：只有"**连续这么久一条引擎事件都没有**"才开口，
 *  每收到一条事件（error 除外）就重新起跳——真机第二轮的教训是模型 thinking 2m05s
 *  时界面全黑、写死的 90 秒盲定时器谎报"引擎没有回应"，而引擎其实一直在干活。 */
const UI_FALLBACK_WAIT_MS = 90_000

/** 剥掉 Electron IPC 给主进程错误套的那层壳，只留引擎给的原因原文。
 *
 *  渲染层调 window.mz.xxx() 时，主进程抛的错会被 Electron 重写成
 *      `Error invoking remote method 'mz:sendChat': TurnTimeoutError: 模型请求超时：60 秒没有响应，可以重试`
 *  直接透出，用户看到的就是这串管道噪声——真正有用的原因被挤到 60 个字符以后，
 *  在速记行的单行状态区里根本看不见。这里**只剥壳，不改写原因**：
 *  拿掉 `Error invoking remote method '<通道>': ` 前缀与构造名（`TurnTimeoutError: `），
 *  剩下的一个字都不动。空字符串则回退原文，绝不显示空白。 */
function engineReason(raw: string): string {
  const stripped = raw
    .replace(/^Error invoking remote method '[^']*':\s*/, '')
    .replace(/^[A-Za-z_$][\w$]*Error:\s*/, '')
    .trim()
  return stripped || raw
}

export interface CaptureImage {
  fileName?: string
  dataBase64: string
  mediaType: string
}

/** 速记行暂存的账单材料（解析后的二维表，首行表头）。提交时逐份 stageBill 入库。 */
export interface CaptureBill {
  sourceType: 'csv' | 'xlsx'
  fileName: string
  cells: string[][]
  /** 表头之下的数据行数（chip 上显示的「N 行」）。 */
  rows: number
}

/** 需要 txDetail 的事项：只有待入账/待核对的分类卡片要看全字段。 */
const DETAIL_FIELDS = new Set(['confirm_record'])

export interface InboxValue {
  items: PendingItemDTO[]
  /** 待决数（左栏角标 / 右栏「待决数」与卡片流同源）。 */
  pendingCount: number
  gateCards: PendingGateCardDTO[]
  categories: { id: number; name: string; kind: string }[]
  /** txId → 详情（分类/账户/备注/审计），供待入账卡片渲染内联字段与依据。 */
  details: Record<number, TxDetailDTO>
  /** 锁标与右栏共用的本机数据信息。 */
  settings: SettingsInfoDTO | null
  /** 批次结果条数据（D-03a）：最近一次**已执行**批次的结果；没执行过 / 用户已关闭 → null。 */
  batchResult: BatchResultSummaryDTO | null
  snapshots: { name: string; size: number; mtime: number }[]
  loading: boolean
  error: string | null
  /** 正在执行的门/交易 id（按钮禁用 + 防连点）。 */
  busy: number | null
  refresh: () => Promise<void>
  notify: (m: ToastMsg) => void
  toast: ToastMsg | null
  dismissToast: () => void
  inflight: InflightTurn | null
  /** 当前这一轮已用秒数（inflight 为 null 时为 0）。等待期间每秒刷新，让用户知道它还活着。 */
  inflightSeconds: number
  progress: string
  /** 界面**自己**的提示（保险丝开口等），不是引擎给的失败原因。
   *  与 progress 分开走：progress 在非等待态会被渲染成红字报错（capture-error），
   *  而"界面先解除等待"这句话不是引擎失败，不该穿红字。 */
  notice: string | null
  setProgress: (s: string) => void
  clearInflight: () => void
  /** 速记行提交：返回 true = 本轮成功（调用方据此清空输入）。失败已在状态区可见。 */
  submitCapture: (text: string, images: CaptureImage[], bills?: CaptureBill[]) => Promise<boolean>
  /** 执行类动作（确认/取消/改字段）——执行后自动刷新 + 可见回执。 */
  runExec: (key: number, fn: () => Promise<ExecResult>) => Promise<ExecResult | null>
  /** 待收尾就地补答。 */
  runAnswer: (gateId: number, answer: string) => Promise<boolean>
  /** 立即快照（规格 §3.1 右栏卡）。 */
  runSnapshot: () => Promise<void>
  /** 进入收件箱时按批次读回结果条（重载后靠这条恢复；被 ✕ 关掉的那批不会因此复活）。 */
  refreshBatchResult: () => Promise<void>
  /** 关闭批次结果条：本单仅内存态（跨重启持久化 = D-04），不写库。 */
  dismissBatchResult: () => void
  reloadLocal: () => Promise<void>
}

const InboxCtx = createContext<InboxValue | null>(null)

export function useInbox(): InboxValue {
  const v = useContext(InboxCtx)
  if (!v) throw new Error('useInbox 必须在 InboxProvider 内使用')
  return v
}

export function InboxProvider({ children }: { children: ReactNode }): ReactNode {
  const [items, setItems] = useState<PendingItemDTO[]>([])
  const [gateCards, setGateCards] = useState<PendingGateCardDTO[]>([])
  const [categories, setCategories] = useState<{ id: number; name: string; kind: string }[]>([])
  const [details, setDetails] = useState<Record<number, TxDetailDTO>>({})
  const [settings, setSettings] = useState<SettingsInfoDTO | null>(null)
  const [batchResult, setBatchResult] = useState<BatchResultSummaryDTO | null>(null)
  /** 被 ✕ 关掉的那一批（gateId）：关掉后同一批不再自动冒出来，
   *  但**新执行**的批次照常显示（用户关的是"刚才那条"，不是这个功能本身）。 */
  const dismissedGateIdRef = useRef<number | null>(null)
  const [snapshots, setSnapshots] = useState<{ name: string; size: number; mtime: number }[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState<number | null>(null)
  const [toast, setToast] = useState<ToastMsg | null>(null)
  const [inflight, setInflight] = useState<InflightTurn | null>(null)
  const [inflightSeconds, setInflightSeconds] = useState(0)
  // 基础文案（引擎进展/失败原因）。对外的 progress 由它 + 已用时长合成，见下方 useMemo。
  const [progressBase, setProgressBase] = useState('')
  // 界面自己的提示（保险丝开口）。与 progressBase 分开：它不是引擎的失败原因。
  const [notice, setNotice] = useState<string | null>(null)
  const toastTimer = useRef<number | null>(null)
  const inflightTimer = useRef<number | null>(null)
  /** 保险丝阈值（毫秒）：默认占位，收到 mz:getSettingsInfo 后换成主进程给的值。 */
  const fuseMsRef = useRef(UI_FALLBACK_WAIT_MS)
  /** 本轮提交的时间戳（null = 当前没有在等）：保险丝只为"这一轮"武装。 */
  const inflightAtRef = useRef<number | null>(null)
  /** 保险丝上一跳的时刻：文案里的"已 N 秒没有任何新动静"按它算（不是本轮总时长）。 */
  const lastSignalAtRef = useRef<number>(0)

  // 对外的 progress：等待期间 = 基础文案 + 已用时长（每秒刷新）。
  // 收件箱「待解析」卡片与速记行状态区都读这一个字段，所以两处都会如实显示"还在处理 · Ns"；
  // 失败后（inflight 已清）progress 就是引擎给的失败原因原文，不再有任何秒数后缀。
  const progress = useMemo(
    () => (inflight ? `${progressBase || '还在处理…'} · ${inflightSeconds}s` : progressBase),
    [inflight, progressBase, inflightSeconds],
  )

  const notify = useCallback((m: ToastMsg) => {
    if (toastTimer.current) window.clearTimeout(toastTimer.current)
    setToast(m)
    // §2.5：停留 3s 自动收起
    toastTimer.current = window.setTimeout(() => setToast(null), 3000)
  }, [])

  const dismissToast = useCallback(() => {
    if (toastTimer.current) window.clearTimeout(toastTimer.current)
    setToast(null)
  }, [])

  const clearInflight = useCallback(() => {
    if (inflightTimer.current) window.clearTimeout(inflightTimer.current)
    inflightTimer.current = null
    inflightAtRef.current = null
    setInflight(null)
    setInflightSeconds(0)
    setProgressBase('')
    setNotice(null)
  }, [])

  /** 武装保险丝：连续 fuseMsRef.current 毫秒内一条引擎事件都没有，才解除等待并说清事实。
   *  每收到一条引擎事件（error 除外）就重新调它——"引擎还活着"由引擎自己说，
   *  界面不再用自己的定时器猜它死没死（真机第二轮：thinking 2m05s 被 90s 盲兜底误杀）。 */
  const armFuse = useCallback(() => {
    if (inflightAtRef.current === null) return // 没有在等这一轮，别武装
    if (inflightTimer.current) window.clearTimeout(inflightTimer.current)
    lastSignalAtRef.current = Date.now()
    inflightTimer.current = window.setTimeout(() => {
      inflightTimer.current = null
      const at = inflightAtRef.current
      inflightAtRef.current = null
      const silentFor = Math.round((Date.now() - lastSignalAtRef.current) / 1000)
      const waited = at === null ? silentFor : Math.round((Date.now() - at) / 1000)
      setInflight(null)
      setInflightSeconds(0)
      // 走 notice 而不是 progress：这不是引擎的失败（引擎还在跑），不该穿红字报错。
      setProgressBase('')
      setNotice(
        `引擎已 ${silentFor} 秒没有任何新动静（这一轮共等了 ${waited} 秒）。界面先解除等待——如果它其实还在跑，结果稍后会自己出现。`,
      )
    }, fuseMsRef.current)
  }, [])

  /** 本机数据（锁标 + 右栏共用）：设置信息 + 快照列表。 */
  const reloadLocal = useCallback(async () => {
    const [info, snaps] = await Promise.all([
      window.mz.getSettingsInfo().catch(() => null),
      window.mz.listSnapshots().catch(() => [] as { name: string; size: number; mtime: number }[]),
    ])
    if (info) {
      setSettings(info)
      // 保险丝阈值跟着设置信息一起下发：UI 不再自己写死"90 秒"（那条盲定时器谎报过）
      if (Number.isFinite(info.uiFallbackWaitMs) && info.uiFallbackWaitMs > 0) {
        fuseMsRef.current = info.uiFallbackWaitMs
      }
    }
    setSnapshots(snaps)
  }, [])

  /**
   * 按批次读回结果条数据（D-03a）。
   * 为什么每次都问后端、而不是拿对话事件里的 result：那只在内存里活一轮，
   * 应用一重启就什么都没了，而"刚才那批入账了吗"恰恰是用户重启后最想知道的。
   * 读不到（没执行过批次 / 账本未就绪）→ null，界面据此不显示，**绝不编数字**。
   */
  const refreshBatchResult = useCallback(async () => {
    try {
      const s = await window.mz.getBatchResult()
      setBatchResult(s && s.gateId !== dismissedGateIdRef.current ? s : null)
    } catch {
      // 读不出来就不显示：结果条是补充说明，缺了不该把整个收件箱拖进错误态
      setBatchResult(null)
    }
  }, [])

  const dismissBatchResult = useCallback(() => {
    dismissedGateIdRef.current = batchResult?.gateId ?? null
    setBatchResult(null)
  }, [batchResult])

  const refresh = useCallback(async () => {
    try {
      const [pending, gates, cats, batch] = await Promise.all([
        window.mz.listPending(),
        window.mz.pendingGateCards(),
        window.mz.listCategories(),
        // ③ 待决列表刷新后一并读回：待分类被定掉 → needsCategory 变 0 → 主按钮消失
        window.mz.getBatchResult(),
      ])
      setItems(pending)
      setGateCards(gates)
      setCategories(cats)
      setError(null)
      setBatchResult(batch && batch.gateId !== dismissedGateIdRef.current ? batch : null)
      // 待入账卡片要显示账户/分类/备注/审计：只对 confirm_record 事项取详情
      const ids = [
        ...new Set(
          pending
            .filter((p) => p.txId != null && DETAIL_FIELDS.has(p.field))
            .map((p) => p.txId as number),
        ),
      ]
      if (ids.length > 0) {
        const loaded = await Promise.all(
          ids.map((id) => window.mz.txDetail(id).catch(() => null) as Promise<TxDetailDTO | null>),
        )
        const map: Record<number, TxDetailDTO> = {}
        loaded.forEach((d, i) => {
          if (d) map[ids[i]] = d
        })
        setDetails(map)
      } else {
        setDetails({})
      }
      await reloadLocal()
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setLoading(false)
    }
  }, [reloadLocal])

  useEffect(() => {
    void refresh()
  }, [refresh])

  // ②B：面板里直接确认/撤销归类走的是 mz.applyClassify / mz.undoClassify，
  // 那两条 IPC **不发引擎事件**（gate-executed 只在对话里确认门时才发），
  // 所以由面板通知这里刷新——否则结果条的待分类数会停在旧值上，界面就在骗人。
  useEffect(() => {
    const onChanged = (): void => {
      void refresh()
      void refreshBatchResult()
    }
    window.addEventListener(LEDGER_CHANGED_EVENT, onChanged)
    return () => window.removeEventListener(LEDGER_CHANGED_EVENT, onChanged)
  }, [refresh, refreshBatchResult])

  // 主→渲染事件流：AI 进展 + 任何会改账的动作都触发刷新（保证界面不落后于账本）
  useEffect(() => {
    const off = window.mz.onChatEvent((evt: ChatEvent) => {
      switch (evt.type) {
        case 'tool-start':
          setProgressBase(`处理中：${String(evt.payload?.toolName ?? 'AI')}`)
          break
        case 'tool-end':
          setProgressBase(
            evt.payload?.isError
              ? `⚠ ${String(evt.payload?.text ?? '这一步没成功')}`
              : String(evt.payload?.text ?? '已完成').slice(0, 48),
          )
          break
        case 'text-delta':
          break
        case 'error': {
          // 真实失败信号（引擎超时 / 引擎报错）：立刻退出"处理中"，并把**引擎给的原文**
          // 留在状态区。不再用 UI 盲定时器自己编失败原因（见 armFuse）。
          const message = String(evt.payload?.message ?? '出错了')
          if (inflightTimer.current) window.clearTimeout(inflightTimer.current)
          inflightTimer.current = null
          inflightAtRef.current = null
          setInflight(null)
          setInflightSeconds(0)
          setNotice(null)
          setProgressBase(message)
          break
        }
        case 'record-confirmed':
        case 'gate-executed':
          // ② 批次门执行完（payload.kind==='batch'）→ 立刻按批次读回结果条
          if (evt.payload?.kind === 'batch') void refreshBatchResult()
          void refresh()
          break
        case 'gate-cancelled':
        case 'tx-deleted':
        case 'tx-restored':
        case 'turn-end':
        case 'agent-end':
          void refresh()
          break
        default:
          break
      }
      // **每一条引擎事件（error 分支除外，它自己已经退出了）都算"引擎还活着"**：
      // 重新起跳保险丝。progress（思考期的存活信号）也走这里——这正是真机第二轮
      // 缺的那根线：模型 thinking 2m05s 期间界面全黑，写死的 90s 盲兜底就误报了。
      if (evt.type !== 'error') armFuse()
    })
    return off
  }, [armFuse, refresh, refreshBatchResult])

  // 等待期间的"已用时长"：每秒一跳。规格 §3.1 写的是"超过 10s 自动转失败态"——
  // 本轮**有意偏离**那条：真模型 + 159 行账单本来就要十几秒以上，10s 判失败是把
  // "还在处理"误报成"没有回音"（界面凭空下结论、还把锅推给用户去重发）。
  // 现在失败态只由真实信号驱动（见下面的 error 分支与 submitCapture 的 catch）；
  // 这里只负责如实报时，让用户看得见这一轮还活着。
  useEffect(() => {
    if (!inflight) return
    setInflightSeconds(0)
    const tick = window.setInterval(() => {
      setInflightSeconds(Math.floor((Date.now() - inflight.at) / 1000))
    }, 1000)
    return () => window.clearInterval(tick)
  }, [inflight])

  // 保险丝不在这里武装：它在 submitCapture（这一轮开始）与每条引擎事件（armFuse）两处起跳。
  // 旧实现那条"提交时武装一次、永不重置"的 useEffect 已删除——真机第二轮它把 thinking 了
  // 2m05s 的活轮在 90 秒上误报成"引擎没有回应"，而引擎当时正在流式思考。

  const submitCapture = useCallback(
    async (text: string, images: CaptureImage[], bills: CaptureBill[] = []): Promise<boolean> => {
      if (inflight) return false
      setInflight({ text, images: images.length, at: Date.now() })
      // 这一轮开始：武装保险丝（此后每条引擎事件都会重新起跳）
      inflightAtRef.current = Date.now()
      armFuse()
      setNotice(null)
      setProgressBase('解析中…')
      try {
        // 第 8 单：账单材料逐行入库到本地账本，消息里只带"材料在哪、几行、哪些列"——
        // 整张表不再进模型上下文（老版 ChatApp 的同一条管线，措辞逐字照搬）。
        let outgoing = text
        const failed: string[] = []
        for (let i = 0; i < bills.length; i++) {
          const b = bills[i]
          try {
            const s = await window.mz.stageBill({
              sourceType: b.sourceType,
              cells: b.cells,
              fileName: b.fileName,
            })
            outgoing = `${outgoing}${outgoing ? '\n\n' : ''}（账单材料 #${i + 1}：table_id=${s.id}，来源文件「${b.fileName}」，本次待处理 ${s.openRows} 行。\n列名：${s.header.filter(Boolean).join(' | ')}\n请先 read_bill(table_id=${s.id}) 看开头几十行，确认列含义与列里的取值，再 apply_bill 提交读表方案。禁止自己逐行报金额或报行数——金额与行数由程序从原表逐行取。）`
          } catch (e) {
            // 入库失败不静默：原因留在状态区，用户看得见、可以重试
            failed.push(`「${b.fileName}」入库失败：${(e as Error).message}`)
          }
        }
        if (failed.length > 0) setProgressBase(`⚠ ${failed.join('；')}`)
        // 账单全入库失败且没有别的内容 → 不空发一轮（原因已写在状态区）
        if (!outgoing && images.length === 0) {
          if (inflightTimer.current) window.clearTimeout(inflightTimer.current)
          inflightTimer.current = null
          inflightAtRef.current = null
          setInflight(null)
          setInflightSeconds(0)
          if (failed.length === 0) setProgressBase('没有可发送的内容')
          return false
        }
        await window.mz.sendChat(outgoing, images)
        await refresh()
        clearInflight()
        // 部分账单入库失败时，成功也要如实报出来（clearInflight 清过状态区）
        if (failed.length > 0) setProgressBase(`⚠ ${failed.join('；')}`)
        return true
      } catch (e) {
        // 失败不静默：立刻退出"处理中"（别把输入框锁住），但把**原因原文**留在状态区。
        // sendChat 的 rejection 就是引擎给的真实原因（超时/未就绪/模型报错），逐字透出，
        // 界面不另编一套说法。
        if (inflightTimer.current) window.clearTimeout(inflightTimer.current)
        inflightTimer.current = null
        inflightAtRef.current = null
        setInflight(null)
        setInflightSeconds(0)
        setProgressBase(`没提交成功：${engineReason((e as Error).message)}`)
        return false
      }
    },
    [armFuse, clearInflight, inflight, refresh],
  )

  const runExec = useCallback(
    async (key: number, fn: () => Promise<ExecResult>): Promise<ExecResult | null> => {
      if (busy !== null) return null
      setBusy(key)
      try {
        const r = await fn()
        notify({ text: r.message, tone: r.status === 'ok' ? 'ok' : r.status === 'error' ? 'err' : 'info' })
        await refresh()
        return r
      } catch (e) {
        notify({ text: `执行失败：${engineReason((e as Error).message)}`, tone: 'err' })
        await refresh()
        return null
      } finally {
        setBusy(null)
      }
    },
    [busy, notify, refresh],
  )

  const runAnswer = useCallback(
    async (gateId: number, answer: string): Promise<boolean> => {
      if (busy !== null) return false
      setBusy(gateId)
      try {
        const r = await window.mz.answerPending(gateId, answer)
        notify({ text: `✓ ${r.text}`, tone: 'ok' })
        await refresh()
        return true
      } catch (e) {
        notify({ text: `✗ ${engineReason((e as Error).message)}`, tone: 'err' })
        return false
      } finally {
        setBusy(null)
      }
    },
    [busy, notify, refresh],
  )

  const runSnapshot = useCallback(async () => {
    if (busy !== null) return
    setBusy(-1)
    try {
      const name = await window.mz.createSnapshotNow()
      await reloadLocal()
      notify({ text: `✓ 已快照：${name}`, tone: 'ok' })
    } catch (e) {
      notify({ text: `✗ 快照失败：${(e as Error).message}`, tone: 'err' })
    } finally {
      setBusy(null)
    }
  }, [busy, notify, reloadLocal])

  const value = useMemo<InboxValue>(
    () => ({
      items,
      pendingCount: items.length,
      gateCards,
      categories,
      details,
      settings,
      batchResult,
      snapshots,
      loading,
      error,
      busy,
      refresh,
      notify,
      toast,
      dismissToast,
      inflight,
      inflightSeconds,
      progress,
      notice,
      setProgress: setProgressBase,
      clearInflight,
      submitCapture,
      runExec,
      runAnswer,
      runSnapshot,
      refreshBatchResult,
      dismissBatchResult,
      reloadLocal,
    }),
    [
      items,
      gateCards,
      categories,
      details,
      settings,
      batchResult,
      snapshots,
      loading,
      error,
      busy,
      refresh,
      notify,
      toast,
      dismissToast,
      inflight,
      inflightSeconds,
      progress,
      notice,
      setProgressBase,
      clearInflight,
      submitCapture,
      runExec,
      runAnswer,
      runSnapshot,
      refreshBatchResult,
      dismissBatchResult,
      reloadLocal,
    ],
  )

  // 供巡检/调试读的稳定引用（不参与渲染）
  useEffect(() => {
    ;(window as unknown as { __mzInbox?: InboxValue }).__mzInbox = value
  }, [value])

  return <InboxCtx.Provider value={value}>{children}</InboxCtx.Provider>
}
