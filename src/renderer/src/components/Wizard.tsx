import { useEffect, useRef, useState } from 'react'
import type { AppConfigDTO, ProviderPreset, TestConnectionResult } from '../../../shared/types'

interface Props {
  mode: 'add' | 'edit'
  initial?: import('../../../shared/types').ProviderDTO | null
  onDone: () => void
  onCancel?: () => void
}

type Step = 1 | 2 | 3

export function Wizard({ mode, initial, onDone, onCancel }: Props) {
  const [step, setStep] = useState<Step>(1)
  const [state, setState] = useState<AppConfigDTO | null>(null)
  const [presets, setPresets] = useState<ProviderPreset[]>([])
  const [presetId, setPresetId] = useState<string>('deepseek')
  const [baseUrl, setBaseUrl] = useState('')
  const [model, setModel] = useState('')
  const [apiKey, setApiKey] = useState('')
  const [showKey, setShowKey] = useState(false)
  const [connResult, setConnResult] = useState<TestConnectionResult | null>(null)
  const [visionResult, setVisionResult] = useState<TestConnectionResult | null>(null)
  const [busy, setBusy] = useState(false)
  const [visionSkipped, setVisionSkipped] = useState(false)

  useEffect(() => {
    window.mz.getState().then(setState)
    window.mz.listPresets().then((ps) => {
      setPresets(ps)
      if (mode === 'edit' && initial) {
        setPresetId(initial.id)
        setBaseUrl(initial.baseUrl)
        setModel(initial.model)
      } else {
        applyPreset(ps, 'deepseek')
      }
    })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mode, initial?.id])

  // Esc = 退出向导（可退出性：任何一步都不该是死路）
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onCancel?.()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onCancel])

  // 覆盖层打开期间：打开即入眼 —— 焦点进第一格（Base URL）；背景滚动锁住，
  // 免得滚轮/空格把底下的设置页带跑（关闭后样式还原，滚动位置不跑偏）。
  const baseUrlRef = useRef<HTMLInputElement | null>(null)
  useEffect(() => {
    baseUrlRef.current?.focus()
    const prev = document.documentElement.style.overflow
    document.documentElement.style.overflow = 'hidden'
    return () => {
      document.documentElement.style.overflow = prev
    }
  }, [])

  function applyPreset(ps: ProviderPreset[], id: string) {
    setPresetId(id)
    const p = ps.find((x) => x.id === id)
    if (p) setBaseUrl(p.baseUrl)
  }

  const preset = presets.find((p) => p.id === presetId)
  const visionOk = mode === 'edit' && visionResult === null ? Boolean(initial?.visionCapable) : visionResult?.ok === true
  const selfCheckAt =
    connResult?.ok || visionResult?.ok ? new Date().toISOString() : (initial?.selfCheckAt ?? null)

  async function runConnTest() {
    setBusy(true)
    setConnResult(null)
    try {
      // providerId：编辑模式留空 Key 时，主进程按它回落取该预设已存的 Key（缺陷①契约）
      setConnResult(await window.mz.testConnection({ baseUrl, model, apiKey, providerId: initial?.id }))
    } finally {
      setBusy(false)
    }
  }

  async function runVisionCheck() {
    setBusy(true)
    setVisionResult(null)
    try {
      setVisionResult(await window.mz.visionCheck({ baseUrl, model, apiKey, providerId: initial?.id }))
    } finally {
      setBusy(false)
    }
  }

  // T0928 §2：进入「测试连接」这一步就自动跑一次（新建 Key 已填 / 编辑留空用已存 Key，
  // 两种模式都测）——首次进来不该盯着一颗写着「重新测试」的按钮发愣。
  // 离开这一步再回来会重新自动测（配置可能改了）；进行中不重复触发。
  const autoConnRef = useRef(false)
  useEffect(() => {
    if (step !== 2) {
      autoConnRef.current = false
      return
    }
    if (autoConnRef.current) return
    autoConnRef.current = true
    void runConnTest()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [step])

  async function finish() {
    setBusy(true)
    try {
      let id = presetId
      if (mode === 'edit' && initial) id = initial.id
      else if (initial === null || mode === 'add') {
        // 同 id 冲突时加时间戳后缀
        const state2 = await window.mz.getState()
        if (state2.providers.some((p) => p.id === id)) id = `${presetId}-${Date.now().toString(36)}`
      }
      await window.mz.saveProvider({
        provider: {
          id,
          name: preset?.name ?? presetId,
          baseUrl,
          model,
          visionCapable: visionOk,
          selfCheckAt,
        },
        apiKey: apiKey || undefined,
        activate: true,
      })
      onDone()
    } finally {
      setBusy(false)
    }
  }

  const title = mode === 'edit' ? '编辑模型预设' : '添加模型预设'
  return (
    // 覆盖层：全屏遮罩 + 卡片在可视区内。点遮罩（只有点中遮罩本身）= 退出，与 Esc/✕ 同路。
    <div
      className="wizard"
      data-testid="wizard-overlay"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onCancel?.()
      }}
    >
      <div className="wizard-card" role="dialog" aria-modal="true" aria-label={title} data-testid="wizard-card">
        {onCancel && (
          <button className="ghost wizard-close" title="退出（Esc）" aria-label="关闭向导" onClick={onCancel}>
            ✕
          </button>
        )}
        <h1>{title}</h1>
        <p className="muted">
          {mode === 'edit' ? `修改「${initial?.name ?? ''}」预设，保存后立即生效` : '填入供应商与 API Key，保存后立即生效'}
        </p>

      {step === 1 && (
        <section className="card">
          <h3>选择供应商</h3>
          <div className="preset-grid">
            {presets.map((p) => (
              <button
                key={p.id}
                className={`preset ${presetId === p.id ? 'active' : ''}`}
                onClick={() => applyPreset(presets, p.id)}
              >
                {p.name}
              </button>
            ))}
          </div>
          <p className="muted">{preset?.hint}</p>

          <label>
            Base URL
            <input ref={baseUrlRef} value={baseUrl} onChange={(e) => setBaseUrl(e.target.value)} placeholder="https://…/v1" />
          </label>
          <label>
            模型 ID
            <input value={model} onChange={(e) => setModel(e.target.value)} placeholder="按服务商文档填写当前可用模型" />
          </label>
          <label>
            API Key
            <div className="key-row">
              <input
                type={showKey ? 'text' : 'password'}
                value={apiKey}
                onChange={(e) => setApiKey(e.target.value)}
                placeholder="粘贴你的 Key（将用系统安全存储加密保存）"
              />
              <button className="ghost" onClick={() => setShowKey(!showKey)}>
                {showKey ? '隐藏' : '显示'}
              </button>
            </div>
          </label>

          <p className="muted small">
            数据目录：<code>{state?.dataDir ?? '…'}</code> · 库文件全库加密（拷走即乱码） · 建议为系统开启 BitLocker（可选）
          </p>

          <div className="row">
            <button className="ghost" onClick={() => onCancel?.()}>
              取消
            </button>
            <span className="grow" />
            <button className="primary" disabled={!baseUrl || !model || (!apiKey && mode === 'add')} onClick={() => setStep(2)}>
              测试连接 →
            </button>
            {mode === 'edit' && apiKey === '' && (
              <p className="muted small">留空 Key = 继续使用已保存的 Key。</p>
            )}
          </div>
        </section>
      )}

      {step === 2 && (
        <section className="card">
          <h3>测试连接</h3>
          <p className="muted">
            会用当前配置向 <code>{baseUrl}</code> 发一个最小请求。
          </p>
          {connResult && (
            <p className={connResult.ok ? 'ok' : 'err'}>
              {connResult.ok ? '✓ ' : '✗ '}
              {connResult.detail}
            </p>
          )}
          <div className="row">
            <button className="ghost" onClick={() => setStep(1)}>
              ← 改配置
            </button>
            <span className="grow" />
            <button className="ghost" disabled={busy} onClick={runConnTest}>
              {busy ? '测试中…' : connResult === null ? '测试连接' : '重新测试'}
            </button>
            <button className="primary" disabled={!connResult?.ok} onClick={() => setStep(3)}>
              下一步：视觉自检 →
            </button>
            {mode === 'edit' && (
              <button className="ghost" onClick={() => setStep(3)}>
                跳过测试（配置不变时）
              </button>
            )}
          </div>
        </section>
      )}

      {step === 3 && (
        <section className="card">
          <h3>视觉自检</h3>
          <p className="muted">
            明账支持拖入支付截图直接识别。自检会给模型看一张内置测试图，确认它真的能「看图」（不只是声明支持）。
          </p>
          {visionResult && (
            <p className={visionResult.ok ? 'ok' : 'err'}>
              {visionResult.ok ? '✓ ' : '✗ '}
              {visionResult.detail}
            </p>
          )}
          <label className="muted check">
            <input
              type="checkbox"
              checked={visionSkipped}
              onChange={(e) => setVisionSkipped(e.target.checked)}
              disabled={visionOk}
            />
            跳过视觉自检（截图记账仍可用：结果会进「待确认」；可随时在设置里补测）
          </label>
          <div className="row">
            <button className="ghost" onClick={() => setStep(2)}>
              ← 上一步
            </button>
            <span className="grow" />
            <button className="ghost" disabled={busy || visionOk} onClick={runVisionCheck}>
              {busy ? '检测中…' : visionOk ? '已通过' : '运行视觉自检'}
            </button>
            <button className="primary" disabled={busy || (!visionOk && !visionSkipped)} onClick={finish}>
              完成配置
            </button>
          </div>
        </section>
      )}
      </div>
    </div>
  )
}
