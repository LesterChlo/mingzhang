import { useEffect, useState } from 'react'
import type {
  AppConfigDTO,
  ChatMessageDTO,
  SessionArchiveDTO,
  SettingsInfoDTO,
} from '../../../shared/types'

import { useEffect as useFx } from 'react'

interface Props {
  state: AppConfigDTO
  reload: () => Promise<void>
  onDone: () => void
  onAddProvider: () => void
  /** T0928 §1：编辑按行落点——传入该行预设 id（此前两路合一，新增会被开成编辑当前预设）。 */
  onEditProvider: (id: string) => void
  /** C4②：续接一条归档会话成功后回调（切回对话并刷新历史）。 */
  onContinueSession?: () => void
}

function SnapshotList({ onRestored }: { onRestored: () => void }) {
  const [snaps, setSnaps] = useState<{ name: string; size: number; mtime: number }[]>([])
  const load = (): void => {
    window.mz.listSnapshots().then(setSnaps).catch(() => setSnaps([]))
  }
  useFx(load, [])
  return (
    <div className="muted small">
      {snaps.length > 0 && (
        <select
          onChange={(e) => {
            const name = e.target.value
            if (!name) return
            if (confirm(`恢复快照将替换当前全部账目（当前库会被覆盖）。确定恢复 ${name}？应用将重启。`)) {
              void window.mz.restoreSnapshot(name).then(() => onRestored())
            }
          }}
          className="cat-select"
          defaultValue=""
        >
          <option value="" disabled>
            选择一个快照恢复…
          </option>
          {snaps.map((s) => (
            <option key={s.name} value={s.name}>
              {s.name}（{(s.size / 1024).toFixed(0)} KB）
            </option>
          ))}
        </select>
      )}
    </div>
  )
}

export function SettingsView({ state, reload, onDone, onAddProvider, onEditProvider, onContinueSession }: Props) {
  const [info, setInfo] = useState<SettingsInfoDTO | null>(null)
  const [budgetYuan, setBudgetYuan] = useState('')
  const [budgetSaved, setBudgetSaved] = useState(false)
  const [cleanupDays, setCleanupDays] = useState('30')
  const [msg, setMsg] = useState<string | null>(null)
  const [pass, setPass] = useState('')
  const [pass2, setPass2] = useState('')
  const [busy, setBusy] = useState(false)
  // 第 7 单 段3：设置页分 3 个子分类（只归组，不删改任何 section 功能）；默认「模型服务」。
  const [tab, setTab] = useState<'model' | 'billing' | 'storage'>('model')

  function reloadInfo(): void {
    window.mz.getSettingsInfo().then((i) => {
      setInfo(i)
      setBudgetYuan(i.budgetCents ? (i.budgetCents / 100).toFixed(2) : '')
    })
  }
  useEffect(() => reloadInfo(), [])

  function run(fn: () => Promise<string | void>, okText: string): void {
    setBusy(true)
    setMsg(null)
    fn()
      .then((r) => setMsg(r ? `${okText}：${r}` : okText))
      .catch((e) => setMsg(`✗ ${(e as Error).message}`))
      .finally(() => {
        setBusy(false)
        reload()
      })
  }

  return (
    <div className="settings">
      <div className="settings-bar">
        <h2>设置</h2>
        <span className="grow" />
        <button className="primary" onClick={onDone}>
          返回收件箱
        </button>
      </div>

      <div className="settings-tabs" role="tablist">
        <button role="tab" aria-selected={tab === 'model'} className={`seg ${tab === 'model' ? 'active' : ''}`} onClick={() => setTab('model')}>
          模型服务
        </button>
        <button role="tab" aria-selected={tab === 'billing'} className={`seg ${tab === 'billing' ? 'active' : ''}`} onClick={() => setTab('billing')}>
          账单与备份
        </button>
        <button role="tab" aria-selected={tab === 'storage'} className={`seg ${tab === 'storage' ? 'active' : ''}`} onClick={() => setTab('storage')}>
          数据储存
        </button>
      </div>

      {tab === 'model' && (
        <section className="card">
          <h3>模型服务</h3>
          <p className="muted small">可保存多个预设，点「启用」一键切换（当前对话续聊不丢）；每个预设各自带密钥与自检状态。</p>
          <div className="provider-list">
            {state.providers.length === 0 && (
              <p className="muted">还没有预设。点下方「新增预设」配置一个，或直接开离线演示。</p>
            )}
            {state.providers.map((p) => {
              const active = p.id === state.activeProviderId
              return (
                <div key={p.id} className={`provider-row ${active ? 'active' : ''}`}>
                  <div className="provider-info">
                    <span className="provider-name">
                      {p.name} <span className="muted small">{p.model}</span>
                    </span>
                    <span
                      className={`badge ${p.visionCapable ? 'ok' : ''}`}
                      title={p.selfCheckAt ? `自检时间 ${p.selfCheckAt}` : '未通过视觉自检'}
                    >
                      {p.visionCapable ? '视觉 ✓' : '未验视觉'}
                    </span>
                    {!p.apiKeySet && <span className="badge warn">缺 Key</span>}
                  </div>
                  <div className="provider-actions">
                    {active ? (
                      <span className="badge ok">当前</span>
                    ) : (
                      <button
                        className="primary small-btn"
                        disabled={busy}
                        onClick={() =>
                          run(async () => {
                            await window.mz.setActiveProvider(p.id)
                          }, `已切换到 ${p.name}（对话续聊不丢）`)
                        }
                      >
                        启用
                      </button>
                    )}
                    <button
                      className="ghost small-btn"
                      disabled={busy}
                      title="发一张内置测试图验证该模型能否看图（需已存 Key）"
                      onClick={() =>
                        run(async () => {
                          const r = await window.mz.runVisionCheck(p.id)
                          if (!r.ok) throw new Error(r.detail)
                          return '视觉自检通过'
                        }, `${p.name} 视觉自检`)
                      }
                    >
                      运行视觉自检
                    </button>
                    <button className="ghost small-btn" onClick={() => onEditProvider(p.id)}>
                      编辑
                    </button>
                    <button
                      className="ghost small-btn danger-text"
                      onClick={() => {
                        if (confirm(`删除预设「${p.name}」？其保存的密钥一并删除（供应商后台可重新签发）。`)) {
                          void window.mz
                            .deleteProvider(p.id)
                            .then(reload)
                            .catch((e) => setMsg(`✗ ${(e as Error).message}`))
                        }
                      }}
                    >
                      删除
                    </button>
                  </div>
                </div>
              )
            })}
            <button className="ghost" onClick={onAddProvider}>
              ＋ 新增预设
            </button>
          </div>

          <details className="tutorial">
            <summary className="muted">怎么配？看教程（常见供应商填法 / 视觉自检说明）</summary>
            <div className="left tutorial-body">
              <p>
                <b>四步：</b>① 选供应商（或自定义端点）→ ② 贴 API Key（服务商后台获取，存本机加密）→ ③
                测试连接 → ④ 视觉自检（想拖截图记账就测）。
              </p>
              <table>
                <thead>
                  <tr>
                    <th>供应商</th>
                    <th>Base URL</th>
                    <th>模型 ID 填法</th>
                  </tr>
                </thead>
                <tbody>
                  <tr>
                    <td>DeepSeek</td>
                    <td>https://api.deepseek.com</td>
                    <td>如 deepseek-chat（按官方文档填当前可用模型）</td>
                  </tr>
                  <tr>
                    <td>智谱 GLM</td>
                    <td>https://open.bigmodel.cn/api/paas/v4</td>
                    <td>如 glm-4 系列（docs.bigmodel.cn）</td>
                  </tr>
                  <tr>
                    <td>通义千问（百炼）</td>
                    <td>https://dashscope.aliyuncs.com/compatible-mode/v1</td>
                    <td>百炼「支持的模型」列表里的 ID</td>
                  </tr>
                  <tr>
                    <td>本地 llama.cpp / vLLM</td>
                    <td>http://127.0.0.1:8080/v1（llama.cpp 默认端口）</td>
                    <td>本地 hub 里的模型别名</td>
                  </tr>
                </tbody>
              </table>
              <p className="muted small">
                视觉自检：会发一张内置测试图让模型认颜色，答对才标记「视觉 ✓」——拖截图记账需要视觉模型。
                未开视觉也能纯文字记账。另外随时可用「离线演示」（不联网的确定性假模型）先把流程走熟。
              </p>
            </div>
          </details>

          <label className="check muted">
            <input
              type="checkbox"
              checked={state.mock === true}
              onChange={(e) =>
                run(() => window.mz.setMock(e.target.checked), e.target.checked ? '已开启离线演示' : '已关闭离线演示')
              }
              disabled={busy}
            />
            离线演示（mock）——内置确定性假模型，不联网、零成本，全部对话流可演示
          </label>
        </section>
      )}

      {tab === 'billing' && (
        <>
          <section className="card">
            <h3>备份</h3>
            <p className="muted small">
              本机快照：自动（超过 24h 启动时补一份，保留最近 7 份）——防误操作。
              <br />
              跨机口令包：手动导出整库，口令 + Argon2id + AES-256-GCM 加密。忘口令 = 不可恢复（无后门）。
            </p>
            <p className="muted small">
              最近快照：{info?.lastSnapshot ? `${info.lastSnapshot.name}（${new Date(info.lastSnapshot.mtime).toLocaleString()}）` : '还没有'}
            </p>
            <div className="row">
              <button className="ghost" disabled={busy} onClick={() => run(() => window.mz.createSnapshotNow(), '快照已创建')}>
                立即快照
              </button>
              <span className="grow" />
            </div>
            <SnapshotList onRestored={onDone} />
            <label>
              备份口令（≥ 8 位）
              <input type="password" value={pass} onChange={(e) => setPass(e.target.value)} />
            </label>
            <label>
              再输一遍
              <input type="password" value={pass2} onChange={(e) => setPass2(e.target.value)} />
            </label>
            <div className="row">
              <button
                className="primary"
                disabled={busy}
                onClick={() => {
                  if (pass !== pass2) {
                    setMsg('✗ 两次口令不一致')
                    return
                  }
                  run(async () => (await window.mz.exportBackup(pass)) ?? '已取消', '备份包已导出')
                }}
              >
                导出跨机备份包…
              </button>
              <button
                className="ghost"
                disabled={busy || !pass}
                onClick={() => {
                  if (confirm('导入将替换当前全部账目数据（当前数据保留在备份快照里）。继续？')) {
                    run(() => window.mz.importBackup(pass).then((ok) => (ok ? '即将重启应用' : '已取消')), '导入完成')
                  }
                }}
              >
                从备份包导入…
              </button>
            </div>
          </section>

          <section className="card">
            <h3>记账偏好</h3>
            <label>
              月度预算（元，被动参照，仅用于查账对比）
              <div className="key-row">
                <input
                  type="number"
                  min="0"
                  step="0.01"
                  value={budgetYuan}
                  placeholder="不设置则留空"
                  onChange={(e) => {
                    setBudgetYuan(e.target.value)
                    setBudgetSaved(false)
                  }}
                />
                <button
                  className="primary"
                  disabled={busy}
                  onClick={() =>
                    run(async (): Promise<string | void> => {
                      const cents = budgetYuan.trim() === '' ? 0 : Math.round(Number(budgetYuan) * 100)
                      if (Number.isNaN(cents) || cents < 0) throw new Error('金额无效')
                      await window.mz.setBudget(cents)
                      setBudgetSaved(true)
                    }, '预算已保存')
                  }
                >
                  保存
                </button>
              </div>
            </label>
            {budgetSaved && <p className="ok small">已保存（写入账本设置，留痕审计）。</p>}
          </section>
        </>
      )}

      {tab === 'storage' && (
        <>
          <section className="card">
            <h3>数据与隐私</h3>
            <ul className="left muted">
              <li>
                当前数据目录：<code>{info?.dataDir ?? '…'}</code>
                {info?.portable && <span className="badge ok">便携模式</span>}
              </li>
              <li>
                账本数据库：<code>{info?.dbFile ?? '…'}</code>（全库加密；拷走即乱码）
              </li>
              <li>出网仅限你配置的模型供应商（{state.provider ? `${state.provider.name} / ${state.provider.baseUrl}` : '未配置'}）。</li>
              <li>API Key 用系统安全存储（DPAPI）加密，永不进日志/导出/备份。</li>
            </ul>
          </section>

          <section className="card">
            <h3>附件</h3>
            <p className="muted small">截图原图默认保留在 attachments/（当前 {info?.attachmentCount ?? 0} 个文件）。旧附件可安全清理——账目数据在数据库里。</p>
            <div className="key-row">
              <input
                type="number"
                min="1"
                value={cleanupDays}
                onChange={(e) => setCleanupDays(e.target.value)}
                style={{ maxWidth: 120 }}
              />
              <span className="muted small">天前的附件</span>
              <button
                className="ghost"
                disabled={busy}
                onClick={() => run(() => window.mz.cleanupAttachments(Number(cleanupDays) || 30).then((n) => `已清理 ${n} 个`), '清理完成')}
              >
                清理旧附件
              </button>
            </div>
          </section>

          <ArchiveSection onContinued={onContinueSession} />
        </>
      )}

      {msg && <p className={msg.startsWith('✗') ? 'err' : 'ok'}>{msg}</p>}
    </div>
  )
}

/** A4 归档会话：列表 + 只读查看 + 继续此对话（第 5 单 C4②）。 */
function ArchiveSection({ onContinued }: { onContinued?: () => void }) {
  const [sessions, setSessions] = useState<SessionArchiveDTO[]>([])
  const [viewing, setViewing] = useState<{ name: string; messages: ChatMessageDTO[] } | null>(null)
  const [loaded, setLoaded] = useState(false)
  const [msg, setMsg] = useState<string | null>(null)
  const [continuing, setContinuing] = useState<string | null>(null)

  function load(): void {
    window.mz
      .listSessions()
      .then((list) => {
        setSessions(list)
        setLoaded(true)
      })
      .catch((e) => setMsg(`✗ ${(e as Error).message}`))
  }
  useEffect(() => {
    load()
  }, [])

  async function open(path: string, name: string): Promise<void> {
    try {
      const messages = await window.mz.readArchive(path)
      setViewing({ name, messages })
    } catch (e) {
      setMsg(`✗ ${(e as Error).message}`)
    }
  }

  async function continueSession(s: SessionArchiveDTO): Promise<void> {
    const name = s.firstMessage.slice(0, 40) || '这段对话'
    if (!window.confirm(`继续「${name}」？当前这段对话会保留在归档里，随时可再切回。`)) return
    setContinuing(s.path)
    setMsg(null)
    try {
      await window.mz.continueSession(s.path)
      onContinued?.()
    } catch (e) {
      setMsg(`✗ 继续失败：${(e as Error).message}`)
    } finally {
      setContinuing(null)
    }
  }

  return (
    <section className="card">
      <h3>会话归档</h3>
      <p className="muted small">
        「新开对话」后旧对话归档在这里，可只读查看（含你发的截图与明账的回复），也能「继续此对话」把引擎切回那段会话接着聊；账务数据不受影响。
      </p>
      {loaded && sessions.length === 0 && <p className="muted">还没有归档会话。</p>}
      {!loaded && <p className="muted">加载中…</p>}
      <div className="archive-list">
        {sessions.map((s) => (
          <div key={s.path} className="provider-row">
            <div className="provider-info">
              <span className="provider-name">{s.firstMessage.slice(0, 40) || '（空会话）'}</span>
              <span className="muted small">
                {new Date(s.modified).toLocaleString()} · {s.messageCount} 条
              </span>
            </div>
            <button
              className="primary small-btn"
              disabled={continuing !== null}
              onClick={() => void continueSession(s)}
            >
              {continuing === s.path ? '切换中…' : '继续此对话'}
            </button>
            <button className="ghost small-btn" onClick={() => void open(s.path, s.firstMessage.slice(0, 40))}>
              查看
            </button>
          </div>
        ))}
      </div>
      {msg && <p className="err">{msg}</p>}
      {viewing && (
        <div className="drawer" onClick={() => setViewing(null)}>
          <div className="drawer-body" onClick={(e) => e.stopPropagation()}>
            <div className="drawer-head">
              <strong>归档对话 · {viewing.name || '（未命名）'}</strong>
              <button onClick={() => setViewing(null)}>关闭</button>
            </div>
            <p className="muted small">只读归档；要继续处理其中的事项，可点上方「继续此对话」，或到「待收尾」页/直接在对话里说明。</p>
            <div className="archive-msgs">
              {viewing.messages.length === 0 && <p className="muted">（这个会话没有可见消息）</p>}
              {viewing.messages.map((m) => (
                <div key={m.id} className={`msg ${m.role}`}>
                  {m.role === 'user' && (
                    <div className="bubble user-bubble">
                      {m.images && m.images.length > 0 && (
                        <div className="msg-thumbs">
                          {m.images.map((img, i) => (
                            <img key={i} src={img.previewUrl} alt={img.fileName} className="msg-thumb" />
                          ))}
                        </div>
                      )}
                      {m.text}
                    </div>
                  )}
                  {m.role === 'assistant' && <div className="bubble ai-bubble">{m.text}</div>}
                  {m.role === 'tool' && (
                    <div className="tool-line">
                      <span className="tool-name">{m.toolName}</span>
                      <span className={`tool-text ${m.isError ? 'err' : ''}`}>{m.text}</span>
                    </div>
                  )}
                </div>
              ))}
            </div>
          </div>
        </div>
      )}
    </section>
  )
}
