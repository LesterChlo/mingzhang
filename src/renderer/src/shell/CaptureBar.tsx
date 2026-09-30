// 速记行（§2.1）：五屏共享、钉在内容区顶部。本单完成数据接线——
// 去掉 readOnly、回车提交走 sendChat、拖图随文提交、提交中/失败/成功三态可见、成功后清空。
//
// 拖拽单（缺陷修复）：老版 ChatApp 的 CSV/XLSX 账单管线在 UI 重做时没搬过来，addFiles()
// 只筛 image/*，其余 `if (list.length === 0) return` —— 拖账单进窗口静默无反应。
// 现在：分类交给 lib/captureFiles（image/csv/xlsx/unsupported，**没有静默这条路**），
// 账单用现成的 lib/ledgerImport 解析，提交时走既有 window.mz.stageBill 管线；
// 拖拽目标从速记行那条窄栏扩到整个窗口。
//
// 五态对应（规格原文）：
//   空态 = placeholder；输入中 = 边框转 accent（CSS :focus-within）；
//   解析中 = 右侧状态区转圈 + 「解析中…」；成功 = 打勾后回空态；
//   失败 = 输入内容保留 + 红字提示（不静默）。

import { useCallback, useEffect, useRef, useState } from 'react'
import type { DragEvent as ReactDragEvent, KeyboardEvent as ReactKeyboardEvent, ReactElement } from 'react'
import { useInbox, type CaptureBill, type CaptureImage } from './inboxStore'
import { usePanel } from './panelStore'
import { classifyDroppedFile } from '../lib/captureFiles'
import { decodeBillText, parseDelimitedCsv, parseWechatXlsx } from '../lib/ledgerImport'

interface PendingImage extends CaptureImage {
  previewUrl: string
}

export function CaptureBar({ onSubmitted }: { onSubmitted?: () => void }): ReactElement {
  const { inflight, progress, notice, setProgress, submitCapture } = useInbox()
  // ②B：星标从装饰转成面板开关（图标一个字没改，只给了它该有的职责）
  const { open: panelOpen, togglePanel } = usePanel()
  const [text, setText] = useState('')
  const [images, setImages] = useState<PendingImage[]>([])
  const [bills, setBills] = useState<CaptureBill[]>([])
  const [dragOver, setDragOver] = useState(false)
  const inputRef = useRef<HTMLInputElement>(null)
  const barRef = useRef<HTMLDivElement>(null)
  // 同一 tick 内的双击保护（state 更新是异步的，光看 inflight 挡不住连点）
  const sendingRef = useRef(false)

  // §2.1：应用启动即聚焦；Ctrl+K 从任意位置聚焦
  useEffect(() => {
    inputRef.current?.focus()
  }, [])

  useEffect(() => {
    function onKey(e: KeyboardEvent): void {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault()
        inputRef.current?.focus()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  const busy = inflight !== null

  const addFiles = useCallback(
    (files: FileList | File[]) => {
      for (const f of Array.from(files)) {
        // 判定顺序与老版 ChatApp 一致：image → csv → xlsx → 兜底「暂不支持」
        const v = classifyDroppedFile({ name: f.name, type: f.type, size: f.size })
        if (v.kind === 'unsupported') {
          // 不静默：原因写进状态区红字（data-testid="capture-error"）
          setProgress(v.reason ?? `⚠ 暂不支持「${f.name}」。`)
          continue
        }
        if (v.kind === 'image') {
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
          reader.onerror = () => setProgress(`⚠ 「${f.name}」读取失败，请重试。`)
          reader.readAsDataURL(f)
          continue
        }
        if (v.kind === 'csv') {
          const reader = new FileReader()
          reader.onload = () => {
            const parsed = parseDelimitedCsv(decodeBillText(reader.result as ArrayBuffer))
            if (parsed.ok && parsed.cells) {
              setBills((prev) => [
                ...prev,
                { sourceType: 'csv', fileName: f.name, cells: parsed.cells!, rows: parsed.rows ?? 0 },
              ])
            } else {
              setProgress(`⚠ 「${f.name}」解析失败：${parsed.reason ?? '未知原因'}`)
            }
          }
          reader.onerror = () => setProgress(`⚠ 「${f.name}」读取失败，请重试。`)
          // 读字节而非文本：支付宝导出的 CSV 是 GB18030，硬编码 UTF-8 会让中文列名乱码 → 表头判不中
          reader.readAsArrayBuffer(f)
          continue
        }
        // xlsx
        const reader = new FileReader()
        reader.onload = () => {
          const parsed = parseWechatXlsx(reader.result as ArrayBuffer)
          if (parsed.ok && parsed.cells) {
            setBills((prev) => [
              ...prev,
              { sourceType: 'xlsx', fileName: f.name, cells: parsed.cells!, rows: parsed.rows ?? 0 },
            ])
          } else {
            setProgress(`⚠ 「${f.name}」解析失败：${parsed.reason ?? '未知原因'}`)
          }
        }
        reader.onerror = () => setProgress(`⚠ 「${f.name}」读取失败，请重试。`)
        reader.readAsArrayBuffer(f)
      }
    },
    [setProgress],
  )

  // 拖拽目标扩到整窗：拖到窗口任何位置都等同拖到速记行（否则用户拖到空白处就没反应）。
  // dragover 必须 preventDefault，否则浏览器不会派发 drop。
  useEffect(() => {
    function hasFiles(e: DragEvent): boolean {
      return Array.from(e.dataTransfer?.types ?? []).includes('Files')
    }
    function onWindowDragOver(e: DragEvent): void {
      if (!hasFiles(e)) return
      e.preventDefault()
      if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy'
      if (!busy) setDragOver(true)
    }
    function onWindowDrop(e: DragEvent): void {
      if (!hasFiles(e)) return
      e.preventDefault()
      setDragOver(false)
      if (busy) {
        // 「绝不静默」的最后一处：上一轮还在跑时拖进来也要有可见反馈（否则用户以为又没反应）
        setProgress('⚠ 正在处理上一条，稍候再把文件拖进来。')
        return
      }
      // 落在速记行自己身上时交给它自己的 onDrop，避免同一份文件解析两次
      const bar = barRef.current
      const target = e.target as Node | null
      if (bar && target && bar.contains(target)) return
      const files = e.dataTransfer?.files
      if (files && files.length > 0) addFiles(files)
    }
    function onWindowDragLeave(e: DragEvent): void {
      if (e.relatedTarget === null) setDragOver(false) // relatedTarget 为空 = 真拖出了窗口
    }
    window.addEventListener('dragover', onWindowDragOver)
    window.addEventListener('drop', onWindowDrop)
    window.addEventListener('dragleave', onWindowDragLeave)
    return () => {
      window.removeEventListener('dragover', onWindowDragOver)
      window.removeEventListener('drop', onWindowDrop)
      window.removeEventListener('dragleave', onWindowDragLeave)
    }
  }, [addFiles, busy])

  async function submit(): Promise<void> {
    const typed = text.trim()
    if ((!typed && images.length === 0 && bills.length === 0) || busy || sendingRef.current) return
    const payload: CaptureImage[] = images.map(({ fileName, dataBase64, mediaType }) => ({
      fileName,
      dataBase64,
      mediaType,
    }))
    const billPayload: CaptureBill[] = bills.map(({ sourceType, fileName, cells, rows }) => ({
      sourceType,
      fileName,
      cells,
      rows,
    }))
    sendingRef.current = true
    const ok = await submitCapture(typed, payload, billPayload)
    sendingRef.current = false
    // §2.1 失败态：内容保留不清空（submitCapture 已把原因写到状态区）
    if (ok) {
      setText('')
      setImages([])
      setBills([])
      onSubmitted?.()
    }
  }

  function onDrop(e: ReactDragEvent<HTMLDivElement>): void {
    e.preventDefault()
    e.stopPropagation()
    setDragOver(false)
    if (busy) {
      setProgress('⚠ 正在处理上一条，稍候再把文件拖进来。')
      return
    }
    addFiles(e.dataTransfer.files)
  }

  function onKeyDown(e: ReactKeyboardEvent<HTMLInputElement>): void {
    if (e.key === 'Enter') {
      e.preventDefault()
      void submit()
    } else if (e.key === 'Escape') {
      // §2.1：Esc 清空
      setText('')
      setImages([])
      setBills([])
    }
  }

  return (
    <div className="mz-capture-wrap">
      <div
        ref={barRef}
        className={`mz-capture${dragOver ? ' is-drop' : ''}`}
        data-testid="capture-bar"
        onDragOver={(e) => {
          e.preventDefault()
          if (!busy) setDragOver(true)
        }}
        onDragLeave={() => setDragOver(false)}
        onDrop={onDrop}
      >
        <button
          type="button"
          className="mz-capture-ai"
          data-testid="panel-toggle"
          aria-expanded={panelOpen}
          aria-label="打开/收起助手面板"
          title="打开/收起助手面板"
          onClick={togglePanel}
        >
          <svg
            width="16"
            height="16"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.5"
            strokeLinecap="round"
            strokeLinejoin="round"
            aria-hidden="true"
          >
            <path d="M12 4l1.9 5.1L19 11l-5.1 1.9L12 18l-1.9-5.1L5 11l5.1-1.9L12 4z" />
            <path d="M19 3l.7 1.8L21.5 5.5l-1.8.7L19 8l-.7-1.8-1.8-.7 1.8-.7L19 3z" />
          </svg>
        </button>

        {images.length > 0 && (
          <div className="mz-capture-thumbs" data-testid="capture-thumbs">
            {images.map((im, i) => (
              <img
                key={`${im.fileName ?? 'img'}-${i}`}
                src={im.previewUrl}
                alt={im.fileName ?? '截图'}
                className="mz-capture-thumb"
              />
            ))}
          </div>
        )}

        <input
          ref={inputRef}
          value={text}
          disabled={busy}
          aria-label="速记行"
          placeholder="说一句，或把截图拖进来 —— 例：午饭 35 微信"
          onChange={(e) => setText(e.target.value)}
          onKeyDown={onKeyDown}
        />

        {/* 账单材料：与缩略图并列的回车前暂存区（解析成功的 CSV/XLSX，提交时随文入库） */}
        {bills.length > 0 && (
          <div className="mz-capture-bills" data-testid="capture-bills">
            {bills.map((b, i) => (
              <span
                key={`${b.fileName}-${i}`}
                className="mz-capture-bill"
                data-testid="capture-bill"
                title={`账单材料：${b.fileName}`}
              >
                <span className="mz-capture-bill-name">{b.fileName}</span>
                <span className="mz-capture-bill-rows">{b.rows} 行</span>
                <button
                  type="button"
                  className="mz-capture-bill-x"
                  aria-label={`移除账单材料 ${b.fileName}`}
                  onClick={() => setBills((prev) => prev.filter((_, k) => k !== i))}
                >
                  ×
                </button>
              </span>
            ))}
          </div>
        )}

        {/* §2.1 右侧状态区：解析中转圈 / 失败红字；待命时给 Ctrl K 提示（常驻，不被状态挤掉） */}
        <span
          className="mz-capture-status"
          data-testid="capture-status"
          role="status"
          aria-live="polite"
          // 错误文案较长（「暂不支持…目前支持：…」），默认 320px 会把后半句截掉 ——
          // 报错时放宽上限让用户看全原因（只放宽不换行，速记行仍是 56px 单行）。
          style={!busy && progress ? { maxWidth: 460 } : undefined}
        >
          {busy ? (
            <>
              <span className="mz-spinner" data-testid="capture-busy" aria-hidden="true" />
              {/* 等待期间如实报时（每秒刷新）：让用户看得见"还在处理"而不是界面在编失败。
                  秒数由 store 合成的 progress 带（收件箱卡片读的是同一个字段）。 */}
              <span data-testid="capture-busy-text">{progress}</span>
            </>
          ) : notice ? (
            // 界面**自己**的提示（保险丝开口）：不是引擎的失败，穿中性色不穿红字。
            <span data-testid="capture-notice">{notice}</span>
          ) : progress ? (
            <span className="mz-capture-err" data-testid="capture-error">
              {progress}
            </span>
          ) : null}
          <kbd
            style={{
              font: '11.5px Inter, monospace',
              color: 'var(--text-3)',
              border: '1px solid var(--line-strong)',
              borderBottomWidth: 2,
              borderRadius: 4,
              padding: '2px 6px',
              flex: 'none',
            }}
          >
            Ctrl K
          </kbd>
        </span>
      </div>
      {dragOver && <div className="mz-capture-hint">松开导入：截图 / 账单 CSV、XLSX</div>}
    </div>
  )
}
