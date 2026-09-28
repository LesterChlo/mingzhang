import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type {
  AppConfigDTO,
  CardData,
  ChatEvent,
  ChatMessageDTO,
  ExecResult,
  PendingItemDTO,
  PendingGateCardDTO,
} from '../../../shared/types'
import { CardView, type LiveCardRefs } from './Cards'
import { parseDelimitedCsv, parseWechatXlsx } from '../lib/ledgerImport'
import { LedgerPanel } from './LedgerPanel'
import { PendingPanel } from './PendingPanel'

interface Props {
  state: AppConfigDTO
  reload: () => Promise<void>
  onOpenSettings: () => void
  onOpenWizard: () => void
  /** 视图保活：true 时隐藏而不卸载（对话状态保留）。 */
  hidden?: boolean
  /** 第 5 单 C4②：设置页「继续此对话」后自增——触发历史重载到新的当前会话。 */
  sessionEpoch?: number
}

interface PendingImage {
  fileName: string
  dataBase64: string
  mediaType: string
  previewUrl: string
}

let itemSeq = 0
const nextId = (): string => `it-${++itemSeq}`

type Flash = { tone: 'err' | 'ok' | 'info'; text: string; actionLabel?: string; action?: () => void } | null

function currentMonth(): string {
  const d = new Date()
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`
}

export function ChatApp({ state, reload, onOpenSettings, onOpenWizard, hidden, sessionEpoch = 0 }: Props) {
  const [items, setItems] = useState<ChatMessageDTO[]>([])
  const [input, setInput] = useState('')
  const [images, setImages] = useState<PendingImage[]>([])
  const [sending, setSending] = useState(false)
  const [tab, setTab] = useState<'chat' | 'ledger' | 'pending'>('chat')
  const [categories, setCategories] = useState<{ id: number; name: string; kind: string }[]>([])
  const [pendingItems, setPendingItems] = useState<PendingItemDTO[]>([])
  const [gateCards, setGateCards] = useState<PendingGateCardDTO[]>([])
  // 第 8 单：账单材料本地拆成二维表待发（发送时逐行入库，整表不再进模型上下文）
  const [bills, setBills] = useState<{ sourceType: 'csv' | 'xlsx'; fileName: string; cells: string[][]; rows: number }[]>([])
  const modelReady = state.mock === true || state.activeProviderId !== null
  const listRef = useRef<HTMLDivElement>(null)
  const visionNoticeShown = useRef(false)
  const [zoomUrl, setZoomUrl] = useState<string | null>(null)
  // 第 6 单 段2-1/2-2：常驻"本次入账"条（不自动消失，可关）+ 账本自动重载 epoch + 新行高亮集合
  const [deposit, setDeposit] = useState<{ count: number; cents: number; months: string[]; ids: number[] } | null>(null)
  const [ledgerEpoch, setLedgerEpoch] = useState(0)

  const noteWrite = useCallback((tx: { id: number; amountCents: number; occurredAt: string }) => {
    const m = (tx.occurredAt ?? '').slice(0, 7)
    setLedgerEpoch((e) => e + 1)
    setDeposit((d) => {
      const months = d?.months ?? []
      const ids = d?.ids ?? []
      return {
        count: (d?.count ?? 0) + 1,
        cents: (d?.cents ?? 0) + tx.amountCents,
        months: m && !months.includes(m) ? [...months, m] : months,
        ids: ids.length >= 200 ? ids : [...ids, tx.id],
      }
    })
  }, [])

  // 第 6 单 段1-2：对话历史卡片 = 当时的快照。用"此刻仍开放"的门/待确认项收敛，
  // 已办结的卡片不再显示"可点但静默"的按钮（渲染为灰条），域层护栏是硬兜底。
  const liveRefs = useMemo<LiveCardRefs>(
    () => ({
      gates: new Set(gateCards.map((g) => g.gateId)),
      pendingTxs: new Set(
        pendingItems.filter((p) => p.field === 'confirm_record' && p.txId != null).map((p) => p.txId as number),
      ),
    }),
    [gateCards, pendingItems],
  )

  // 执行类操作的可见反馈（第 5 单 C1/C2）：失败必须报错、成功明确、跨月入账给跳转
  const [flash, setFlash] = useState<Flash>(null)
  const flashTimer = useRef<number | null>(null)
  const [jumpMonth, setJumpMonth] = useState<string | null>(null)
  const [jumpTx, setJumpTx] = useState<number | null>(null)
  const [newConvBusy, setNewConvBusy] = useState(false)

  function showFlash(f: Flash, ms = 9000): void {
    if (flashTimer.current) window.clearTimeout(flashTimer.current)
    setFlash(f)
    if (f) flashTimer.current = window.setTimeout(() => setFlash(null), ms)
  }

  // 第 5 单 C2：入账月份 ≠ 当前月时提示 + 一键跳转到该月（消除"没进账本"错觉）。
  // 命中跨月返回 true（已给出带跳转提示）；否则 false（调用方给常规成功回执）。
  function monthHint(months: (string | null | undefined)[], label: string): boolean {
    const cm = currentMonth()
    const byMonth: Record<string, number> = {}
    for (const iso of months) {
      const m = (iso ?? '').slice(0, 7)
      if (m && m !== cm) byMonth[m] = (byMonth[m] ?? 0) + 1
    }
    const target = Object.keys(byMonth).sort()[0]
    if (!target) return false
    const n = byMonth[target]
    showFlash(
      {
        tone: 'info',
        text: `${label}有 ${n} 笔记在 ${target}（不是本月）——到账本页把月份切到 ${target} 即可看到`,
        actionLabel: `查看 ${target}`,
        action: () => {
          setTab('ledger')
          setJumpMonth(target)
        },
      },
      12000,
    )
    return true
  }

  const refreshPending = useCallback(() => {
    window.mz.listPending().then(setPendingItems).catch(() => setPendingItems([]))
    window.mz.pendingGateCards().then(setGateCards).catch(() => setGateCards([]))
  }, [])

  useEffect(() => {
    window.mz.listCategories().then(setCategories).catch(() => setCategories([]))
    refreshPending()
    // 试用反馈 #1：进入应用即恢复会话历史（重启后可见之前的对话，含工具卡片与图片）
    window.mz
      .loadHistory()
      .then((history) => {
        if (history.length > 0) setItems(history)
      })
      .catch(() => {})
  }, [refreshPending])

  // C4②：设置页「继续此对话」切换了引擎当前会话 → 重载历史到新会话（epoch=0 的首次加载走上面的 effect）
  useEffect(() => {
    if (sessionEpoch === 0) return
    window.mz
      .loadHistory()
      .then((history) => setItems(history))
      .catch(() => {})
    refreshPending()
    setTab('chat')
  }, [sessionEpoch, refreshPending])

  const refreshLedger = useCallback(() => {
    // 段2-2：任何写操作后让账本重取数（补上面 refreshLedger 曾是空函数的债——就地办完立刻看到）
    setLedgerEpoch((e) => e + 1)
  }, [])

  const handleEvent = useCallback((evt: ChatEvent) => {
    // C1/C2 + 段2-1：批次入账 → 常驻"本次入账"条累计 + 跨月提示 + 账本自动重载（对话/待收尾两个入口都经此广播）
    if (evt.type === 'gate-executed' && evt.payload?.kind === 'batch') {
      const completed = (evt.payload.result?.completed ?? []) as {
        card?: { tx?: { id: number; amountCents: number; occurredAt: string } }
      }[]
      const n = completed.length
      for (const c of completed) {
        if (c.card?.tx) noteWrite(c.card.tx)
      }
      if (!monthHint(completed.map((c) => c.card?.tx?.occurredAt), `批次已入账 ${n} 笔——`)) {
        showFlash({ tone: 'ok', text: `✓ 批次已入账 ${n} 笔` })
      }
    }
    // 段2-1：单笔记账——对话 record 自动确认（tool-end）与界面确认入账（record-confirmed）都计入"本次入账"条
    if (evt.type === 'record-confirmed') {
      const card = evt.payload.card as { tx?: { id: number; amountCents: number; occurredAt: string } }
      if (card?.tx) noteWrite(card.tx)
    }
    if (evt.type === 'tool-end' && String(evt.payload.toolName ?? '') === 'record' && !evt.payload.isError) {
      const card = (evt.payload.details as { card?: { kind?: string; tx?: { id: number; amountCents: number; occurredAt: string; state: string } } })?.card
      if (card?.kind === 'transaction' && card.tx?.state === 'confirmed') noteWrite(card.tx)
    }
    // 段4-2：抽屉里删/恢复/补账户后，账本与待办同步刷新
    if (evt.type === 'tx-deleted' || evt.type === 'tx-restored') {
      setLedgerEpoch((e) => e + 1)
      refreshPending()
    }
    setItems((prev) => {
      const next = [...prev]
      switch (evt.type) {
        case 'text-delta': {
          const a = [...next].reverse().find((i) => i.role === 'assistant' && i.streaming)
          if (a) a.text += evt.payload.delta as string
          break
        }
        case 'tool-start': {
          const a = next.find((i) => i.role === 'assistant' && i.streaming)
          if (a) a.streaming = false
          next.push({
            id: nextId(),
            role: 'tool',
            toolName: String(evt.payload.toolName ?? ''),
            text: '…',
          })
          next.push({ id: nextId(), role: 'assistant', text: '', streaming: true })
          break
        }
        case 'tool-end': {
          const t = [...next].reverse().find((i) => i.role === 'tool' && i.text === '…')
          if (t) {
            t.text = String(evt.payload.text ?? '')
            t.isError = Boolean(evt.payload.isError)
            const card = (evt.payload.details as { card?: unknown } | undefined)?.card
            if (card) t.card = card as CardData
          }
          break
        }
        case 'agent-end': {
          const a = next.find((i) => i.role === 'assistant' && i.streaming)
          if (a) {
            a.streaming = false
            if (!a.text) a.text = '（本轮结束）'
          }
          break
        }
        case 'record-confirmed': {
          const card = evt.payload.card as CardData
          const t = [...next].reverse().find(
            (i) => i.role === 'tool' && i.card && 'kind' in i.card && i.card.kind === 'transaction' && i.card.tx.id === (card as { tx: { id: number } }).tx.id,
          )
          if (t) t.card = card
          break
        }
        case 'gate-executed': {
          const { gateId, kind } = evt.payload as { gateId: number; kind: string; txId?: number }
          if (kind === 'batch') {
            const result = evt.payload.result as {
              completed: { txId: number; card: CardData; needsReview: boolean }[]
              duplicates: { merchant: string | null; amountCents: number | null; reason: string }[]
              unparsedKept: number
            }
            const resultCard: CardData = {
              kind: 'batch-result',
              completed: result.completed.map((c) => {
                const tc = c.card as Extract<CardData, { kind: 'transaction' }>
                return { txId: c.txId, amountCents: tc.tx.amountCents, merchant: tc.tx.merchant, state: tc.tx.state }
              }),
              duplicates: result.duplicates,
              unparsedKept: result.unparsedKept,
            }
            const t = [...next].reverse().find(
              (i) => i.role === 'tool' && i.card && 'kind' in i.card && i.card.kind === 'batch-gate' && i.card.gateId === gateId,
            )
            if (t) t.card = resultCard
            break
          }
          const t = [...next].reverse().find(
            (i) => i.role === 'tool' && i.card && 'kind' in i.card && i.card.kind === 'delete-gate' && i.card.gateId === gateId,
          )
          if (kind === 'delete' && t?.card && t.card.kind === 'delete-gate') {
            t.card = { kind: 'transaction', tx: { ...t.card.tx, state: 'deleted' } }
          }
          break
        }
        case 'gate-cancelled': {
          const { gateId } = evt.payload as { gateId: number }
          const t = [...next].reverse().find(
            (i) => i.role === 'tool' && i.card && 'kind' in i.card && i.card.kind === 'delete-gate' && i.card.gateId === gateId,
          )
          if (t) {
            t.card = undefined
            t.text += '（已取消，账目未变）'
          }
          break
        }
        case 'error': {
          const a = next.find((i) => i.role === 'assistant' && i.streaming)
          if (a) a.streaming = false
          next.push({ id: nextId(), role: 'assistant', text: `⚠ ${evt.payload.message}`, isError: true })
          break
        }
        default:
          break
      }
      return next
    })
  }, [])

  useEffect(() => {
    const off = window.mz.onChatEvent(handleEvent)
    return off
  }, [handleEvent])

  useEffect(() => {
    refreshLedger()
    refreshPending()
  }, [refreshLedger, refreshPending, items.length])

  useEffect(() => {
    listRef.current?.scrollTo({ top: listRef.current.scrollHeight })
  }, [items])

  function noteChat(text: string): void {
    setItems((prev) => [...prev, { id: nextId(), role: 'assistant', text, isError: true }])
  }

  const XLSX_MAX_BYTES = 2_000_000
  function addFiles(files: File[]): void {
    for (const f of files) {
      const isCsv = /\.csv$/i.test(f.name) || f.type === 'text/csv'
      const isXlsx = /\.xlsx$/i.test(f.name) || f.type === 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
      if (isCsv) {
        if (f.size > 400_000) {
          noteChat('⚠ CSV 超过 400KB，暂不支持；请拆分后再试。')
          continue
        }
        const reader = new FileReader()
        reader.onload = () => {
          const parsed = parseDelimitedCsv(String(reader.result))
          if (parsed.ok && parsed.cells) {
            setBills((prev) => [...prev, { sourceType: 'csv', fileName: f.name, cells: parsed.cells!, rows: parsed.rows ?? 0 }])
          } else {
            noteChat(`⚠ 「${f.name}」解析失败：${parsed.reason ?? '未知原因'}`)
          }
        }
        reader.onerror = () => noteChat(`⚠ 「${f.name}」读取失败，请重试。`)
        reader.readAsText(f, 'utf-8')
        continue
      }
      if (isXlsx) {
        if (f.size > XLSX_MAX_BYTES) {
          noteChat(`⚠ 「${f.name}」超过 2MB，暂不支持整表导入；请在微信导出时按更短的时间区间拆分。`)
          continue
        }
        const reader = new FileReader()
        reader.onload = () => {
          const parsed = parseWechatXlsx(reader.result as ArrayBuffer)
          if (parsed.ok && parsed.cells) {
            setBills((prev) => [...prev, { sourceType: 'xlsx', fileName: f.name, cells: parsed.cells!, rows: parsed.rows ?? 0 }])
          } else {
            noteChat(`⚠ 「${f.name}」解析失败：${parsed.reason ?? '未知原因'}`)
          }
        }
        reader.onerror = () => noteChat(`⚠ 「${f.name}」读取失败，请重试。`)
        reader.readAsArrayBuffer(f)
        continue
      }
      if (f.type.startsWith('image/')) {
        const reader = new FileReader()
        reader.onload = () => {
          const dataUrl = String(reader.result)
          setImages((prev) => [
            ...prev,
            {
              fileName: f.name,
              dataBase64: dataUrl.slice(dataUrl.indexOf(',') + 1),
              mediaType: f.type,
              previewUrl: dataUrl,
            },
          ])
        }
        reader.readAsDataURL(f)
        continue
      }
      // 段2：既非图片、又非 CSV/XLSX——不再静默丢弃，明确告知支持范围
      noteChat(`⚠ 暂不支持「${f.name}」这种格式。目前支持：图片截图 / CSV、XLSX 账单。`)
    }
  }

  async function send(): Promise<void> {
    const typed = input.trim()
    if ((!typed && images.length === 0 && bills.length === 0) || sending) return
    setSending(true)
    setInput('')
    const imgs = images
    setImages([])
    const pending = bills
    setBills([])
    let text = typed
    // ② 首次发图一次性提示（软拦）：未过视觉自检 → 结果进待确认，给「现在补测」入口
    const activeProvider = state.providers.find((p) => p.id === state.activeProviderId) ?? null
    if (
      imgs.length > 0 &&
      !state.mock &&
      activeProvider &&
      !activeProvider.visionCapable &&
      !visionNoticeShown.current
    ) {
      visionNoticeShown.current = true
      setItems((prev) => [
        ...prev,
        {
          id: nextId(),
          role: 'assistant',
          text: `ℹ 当前模型「${activeProvider.name}」未通过视觉自检：这次图片来源的记账会进待确认，确认后再入账。可随时补测。`,
          isError: false,
        },
      ])
    }
    // 第 8 单：账单材料逐行入库到本地账本，消息里只带"材料在哪、几行、哪些列"——
    // 整张表不再进模型上下文（原实现要模型逐行重述金额，几百行必漏必错）。
    const promptText = text
    const stagedFiles: string[] = []
    for (let i = 0; i < pending.length; i++) {
      const b = pending[i]
      try {
        const s = await window.mz.stageBill({ sourceType: b.sourceType, cells: b.cells, fileName: b.fileName })
        stagedFiles.push(`「${b.fileName}」${s.openRows} 行`)
        text = `${text}${text ? '\n\n' : ''}（账单材料 #${i + 1}：table_id=${s.id}，来源文件「${b.fileName}」，本次待处理 ${s.openRows} 行。\n列名：${s.header.filter(Boolean).join(' | ')}\n请先 read_bill(table_id=${s.id}) 看开头几十行，确认列含义与列里的取值，再 apply_bill 提交读表方案。禁止自己逐行报金额或报行数——金额与行数由程序从原表逐行取。）`
      } catch (e) {
        noteChat(`⚠ 「${b.fileName}」入库失败：${(e as Error).message}`)
      }
    }
    if (!text && pending.length > 0 && stagedFiles.length === 0) {
      setSending(false)
      return
    }
    setItems((prev) => [
      ...prev,
      {
        id: nextId(),
        role: 'user',
        text: promptText ? `${promptText}${stagedFiles.length ? `\n📄 账单材料：${stagedFiles.join('、')}` : ''}` : stagedFiles.length ? `📄 账单材料：${stagedFiles.join('、')}` : `（发来了 ${imgs.length} 张图片）`,
        streaming: false,
        images: imgs.map(({ previewUrl, fileName }) => ({ previewUrl, fileName })),
      },
      { id: nextId(), role: 'assistant', text: '', streaming: true },
    ])
    try {
      await window.mz.sendChat(text, imgs.map(({ fileName, dataBase64, mediaType }) => ({ fileName, dataBase64, mediaType })))
    } catch (e) {
      setItems((prev) => {
        const next = prev.map((i) => (i.role === 'assistant' && i.streaming ? { ...i, streaming: false } : i))
        return [...next, { id: nextId(), role: 'assistant', text: `⚠ 发送失败：${(e as Error).message}`, isError: true }]
      })
    } finally {
      setSending(false)
    }
  }

  // 第 6 单 段1：语义化执行回执——每种 status 都有可见文案（消除"点了没反应"的静默路径）
  function execNote(r: ExecResult): void {
    showFlash({ tone: r.status === 'error' ? 'err' : 'info', text: r.message })
  }

  async function confirmRecord(txId: number, categoryName?: string): Promise<void> {
    try {
      const r = await window.mz.confirmRecord(txId, categoryName)
      // 执行后刷新：待收尾/账本/徽标立即可见（第 4 单验收：聊天卡片就地执行后，待收尾需同步）
      refreshPending()
      refreshLedger()
      if (r.status === 'ok' && r.card) {
        const label = `已入账 #${txId}（¥${(r.card.tx.amountCents / 100).toFixed(2)}）——`
        if (!monthHint([r.card.tx.occurredAt], label)) {
          showFlash({ tone: 'ok', text: `✓ 已入账 #${txId}（${r.card.tx.merchant ?? ''} ¥${(r.card.tx.amountCents / 100).toFixed(2)}）` })
        }
      } else if (r.status === 'ok') {
        showFlash({ tone: 'ok', text: r.message || `✓ 已确认入账（交易 #${txId}）` })
      } else {
        execNote(r)
      }
    } catch (e) {
      showFlash({ tone: 'err', text: `✗ 操作失败：${(e as Error)?.message ?? String(e)}` })
    }
  }

  async function confirmGate(gateId: number): Promise<void> {
    try {
      const r = await window.mz.confirmGate(gateId)
      refreshPending()
      refreshLedger()
      // 批次成功的"已入账 N 笔"+跨月提示走 gate-executed 事件；非成功态此处可见回执
      if (r.status !== 'ok') execNote(r)
    } catch (e) {
      showFlash({ tone: 'err', text: `✗ 操作失败：${(e as Error)?.message ?? String(e)}（未入账，可重试）` })
    }
  }

  async function cancelGate(gateId: number): Promise<void> {
    try {
      const r = await window.mz.cancelGate(gateId)
      refreshPending()
      refreshLedger()
      if (r.status !== 'ok') execNote(r)
    } catch (e) {
      showFlash({ tone: 'err', text: `✗ 取消失败：${(e as Error)?.message ?? String(e)}` })
    }
  }

  return (
    <div className={`app${hidden ? ' hidden' : ''}`}>
      <header>
        <span className="logo">明账</span>
        <span className="muted model">
          {state.mock
            ? '离线演示（mock · 不联网）'
            : state.provider
              ? `${state.provider.name} / ${state.provider.model}`
              : '未配置模型'}
        </span>
        <span className="grow" />
        <button
          className={`ghost small-btn${newConvBusy ? ' new-conv-busy' : ''}`}
          disabled={newConvBusy}
          title="旧会话归档保留（可在「设置 → 会话归档」查看或继续此对话），从此落新文件；待收尾不受影响"
          onClick={async () => {
            if (newConvBusy) return
            setNewConvBusy(true)
            try {
              const archived = await window.mz.newConversation()
              const history = await window.mz.loadHistory()
              const n = pendingItems.length
              setItems([
                ...history,
                {
                  id: nextId(),
                  role: 'assistant',
                  text:
                    (archived
                      ? '已开启新对话（上一段已归档，可在「设置 → 归档会话」里查看或「继续此对话」）。'
                      : '当前已是新对话（上一段为空，未重复归档）。') +
                    (n > 0
                      ? `有 ${n} 条待收尾，仍可在「待收尾」页处理（可就地执行确认）；关联卡片在上一段对话里。`
                      : '待收尾与未确认事项不受影响（数据保存在账本数据库中）。'),
                },
              ])
              showFlash({ tone: 'ok', text: archived ? '✓ 已开启新对话（上一段已归档）' : '✓ 当前已是新对话' }, 4000)
              refreshPending()
            } catch (e) {
              setItems((prev) => [
                ...prev,
                { id: nextId(), role: 'assistant', text: `⚠ 新开对话失败：${(e as Error).message}`, isError: true },
              ])
            } finally {
              setNewConvBusy(false)
            }
          }}
        >
          {newConvBusy ? '⟳ 开启中…' : '新开对话'}
        </button>
        <button className="ghost small-btn" onClick={onOpenSettings}>
          设置
        </button>
        <div className="tabs">
          <button className={tab === 'chat' ? 'active' : ''} onClick={() => setTab('chat')}>
            对话
          </button>
          <button className={tab === 'ledger' ? 'active' : ''} onClick={() => setTab('ledger')}>
            账本
          </button>
          <button
            className={tab === 'pending' ? 'active' : ''}
            onClick={() => setTab('pending')}
            title="待收尾事项"
          >
            待收尾{pendingItems.length > 0 ? ` (${pendingItems.length})` : ''}
          </button>
        </div>
      </header>

      {/* 第 6 单 段2-1：常驻"本次入账"条——不自动消失，给"记完了东西在哪"一个可回访的落点（替代会过期的 toast） */}
      {deposit && deposit.count > 0 && (
        <div className="deposit-bar" role="status">
          <span className="deposit-ok">✓ 本次入账 {deposit.count} 笔 ¥{(deposit.cents / 100).toFixed(2)}</span>
          <span className="muted small">
            · 记在 {deposit.months.length === 1 ? deposit.months[0] : deposit.months.length > 1 ? `${deposit.months[deposit.months.length - 1]} 等 ${deposit.months.length} 个月份` : '未知月份'}
          </span>
          <span className="grow" />
          <button
            className="ghost small-btn"
            onClick={() => {
              const m = deposit.months[deposit.months.length - 1]
              if (m) setJumpMonth(m)
              setTab('ledger')
            }}
          >
            查看
          </button>
          <button className="ghost small-btn" title="知道了，关掉" onClick={() => setDeposit(null)}>
            ✕
          </button>
        </div>
      )}

      {/* 第 6 单 段4-3：账本保活（月份/筛选/页码切走不丢）；对话/待办仍按 tab 挂载，避免隐藏副本串扰文本断言 */}
      {tab === 'chat' && (
        <>
          <div className="chat-list" ref={listRef}>
            {!modelReady ? (
              <div className="empty-state">
                <h2>先配一个模型，就能开始记账</h2>
                <p className="muted">
                  明账的账本 / 备份 / 待收尾现在就能浏览；配好模型后即可对话记账、拖截图入账。
                </p>
                <div className="empty-actions">
                  <button className="primary" onClick={onOpenWizard}>
                    配置模型
                  </button>
                  <button
                    className="ghost"
                    onClick={() =>
                      void window.mz
                        .setMock(true)
                        .then(reload)
                        .catch((e) => setItems((prev) => [...prev, { id: nextId(), role: 'assistant', text: `⚠ ${(e as Error).message}`, isError: true }]))
                    }
                  >
                    先开离线演示
                  </button>
                  <button className="ghost" onClick={onOpenSettings}>
                    怎么配？看教程
                  </button>
                </div>
              </div>
            ) : items.length === 0 ? (
              <div className="empty-guide" data-testid="empty-guide">
                <h3>从一句话开始记账</h3>
                <p className="muted">
                  试试：「星巴克 35」——点下面任意一个例子，会填入输入框，直接回车就能记：
                </p>
                <div className="guide-examples">
                  <button className="ghost" onClick={() => setInput('麦当劳 26')}>
                    🍔 麦当劳 26
                  </button>
                  <button className="ghost" onClick={() => setInput('星巴克 35')}>
                    ☕ 星巴克 35
                  </button>
                  <button className="ghost" onClick={() => setInput('这个月餐饮花了多少')}>
                    📊 这个月餐饮花了多少
                  </button>
                  <button className="ghost" onClick={() => setInput('上月月报')}>
                    📅 上月月报
                  </button>
                </div>
                <p className="muted small">也可以把一张支付截图直接拖进来，自动识别入账。</p>
              </div>
            ) : null}
            {items.map((it) => (
              <div key={it.id} className={`msg ${it.role} ${it.isError ? 'err' : ''}`}>
                {it.role === 'user' && (
                  <div className="bubble user-bubble">
                    {it.images && it.images.length > 0 && (
                      <div className="msg-thumbs">
                        {it.images.map((img, i) => (
                          // biome-ignore lint/a11y/noStaticElementInteractions: 缩略图点击放大
                          <img
                            key={i}
                            src={img.previewUrl}
                            alt={img.fileName}
                            className="msg-thumb"
                            onClick={() => setZoomUrl(img.previewUrl)}
                          />
                        ))}
                      </div>
                    )}
                    {it.text && !(it.images && it.images.length > 0 && it.text.startsWith('（发来了')) && it.text}
                  </div>
                )}
                {it.role === 'assistant' && (
                  <div className="bubble ai-bubble">
                    {it.text}
                    {it.text.startsWith('ℹ') && (
                      <div className="tx-review">
                        <span />
                        <button className="ghost small-btn" onClick={onOpenSettings}>
                          现在补测
                        </button>
                      </div>
                    )}
                    {it.streaming && <span className="caret">▍</span>}
                  </div>
                )}
                {it.role === 'tool' && (
                  <div
                    className="tool-line"
                    data-gate={
                      it.card && 'gateId' in it.card ? String(it.card.gateId) : undefined
                    }
                    data-tx={it.card && 'tx' in it.card ? String(it.card.tx.id) : undefined}
                  >
                    <span className="tool-name">{it.toolName}</span>
                    {it.card && (
                      <CardView
                        card={it.card}
                        categories={categories}
                        onConfirmRecord={confirmRecord}
                        onConfirmGate={confirmGate}
                        onCancelGate={cancelGate}
                        live={liveRefs}
                        chatContext
                        onOpenTx={(id) => {
                          setJumpTx(id)
                          setTab('ledger')
                        }}
                      />
                    )}
                    <span className={`tool-text ${it.isError ? 'err' : ''}`}>{it.text}</span>
                  </div>
                )}
              </div>
            ))}
          </div>

          {!modelReady ? null : (
          <div className="composer">
            {bills.length > 0 && (
              <div className="thumbs">
                {bills.map((b, i) => (
                  <span key={i} className="csv-chip" title={`${b.fileName}：${b.rows} 行，发送后逐行入库由程序解析`}>
                    {b.sourceType.toUpperCase()} · {b.fileName.slice(0, 18)}（{b.rows} 行）
                    <button className="thumb-x" onClick={() => setBills((prev) => prev.filter((_, j) => j !== i))}>
                      ×
                    </button>
                  </span>
                ))}
              </div>
            )}
            {images.length > 0 && (
              <div className="thumbs">
                {images.map((img, i) => (
                  <span key={i} className="thumb-wrap">
                    <img src={img.previewUrl} alt={img.fileName} className="thumb" />
                    <button className="thumb-x" onClick={() => setImages((prev) => prev.filter((_, j) => j !== i))}>
                      ×
                    </button>
                  </span>
                ))}
              </div>
            )}
            <div
              className="input-row"
              onDragOver={(e) => e.preventDefault()}
              onDrop={(e) => {
                e.preventDefault()
                addFiles(Array.from(e.dataTransfer.files))
              }}
              onPaste={(e) => {
                const files = Array.from(e.clipboardData.files)
                if (files.length > 0) {
                  e.preventDefault()
                  addFiles(files)
                }
              }}
            >
              <label className="attach" title="选择截图 / CSV、XLSX 账单">
                ＋
                <input
                  type="file"
                  accept="image/*,.csv,.xlsx"
                  multiple
                  hidden
                  disabled={sending}
                  onChange={(e) => {
                    addFiles(Array.from(e.target.files ?? []))
                    e.target.value = ''
                  }}
                />
              </label>
              <textarea
                value={input}
                placeholder={sending ? '明账正在处理…' : '说一句账，如「星巴克 35」；或拖入支付截图'}
                onChange={(e) => setInput(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && !e.shiftKey) {
                    e.preventDefault()
                    void send()
                  }
                }}
                disabled={sending}
              />
              <button
                className="primary"
                disabled={sending || (!input.trim() && images.length === 0 && bills.length === 0)}
                onClick={() => void send()}
              >
                发送
              </button>
            </div>
          </div>
          )}
        </>
      )}
      <div className="tabview" style={{ display: tab === 'ledger' ? '' : 'none' }}>
        <LedgerPanel
          pendingItems={pendingItems}
          categories={categories}
          focusMonth={jumpMonth}
          onFocusHandled={() => setJumpMonth(null)}
          focusTxId={jumpTx}
          onFocusTxHandled={() => setJumpTx(null)}
          onOpenPending={() => setTab('pending')}
          dataEpoch={ledgerEpoch}
          highlightIds={deposit ? new Set(deposit.ids) : undefined}
          onExecuted={() => {
            refreshPending()
            refreshLedger()
          }}
        />
      </div>
      {tab === 'pending' && (
        <PendingPanel
          items={pendingItems}
          gateCards={gateCards}
          categories={categories}
          onOpenTx={(id) => {
            setJumpTx(id)
            setTab('ledger')
          }}
          onExecuted={() => {
            refreshPending()
            refreshLedger()
          }}
          onRefresh={refreshPending}
        />
      )}

      {flash && (
        <div className={`action-toast tone-${flash.tone}`} role="status">
          <span>{flash.text}</span>
          {flash.action && flash.actionLabel && (
            <button
              className="ghost small-btn"
              onClick={() => {
                flash.action?.()
                showFlash(null)
              }}
            >
              {flash.actionLabel}
            </button>
          )}
        </div>
      )}

      {zoomUrl && (
        // biome-ignore lint/a11y/noStaticElementInteractions: 点击关闭大图
        <div className="zoom-overlay" onClick={() => setZoomUrl(null)}>
          <img src={zoomUrl} alt="预览大图" />
        </div>
      )}
    </div>
  )
}
