import { expect, it, vi } from 'vitest'
const { handlers, invokes, exposed } = vi.hoisted(() => ({ handlers: new Map<string, (...args: any[]) => any>(), invokes: vi.fn(), exposed: vi.fn() }))
vi.mock('electron', () => ({ ipcMain: { handle: (name: string, fn: (...args: any[]) => any) => handlers.set(name, fn) }, nativeTheme: {}, ipcRenderer: { invoke: invokes, on: vi.fn(), removeListener: vi.fn() }, contextBridge: { exposeInMainWorld: exposed } }))
import { registerIpc } from '../src/main/ipc'
import { openSchemaDb } from './helpers'

it('展示IPC无引擎也可持久化；严格目标/patch校验且零模型零审计零账务', () => {
  const db = openSchemaDb(':memory:')
  try {
    const gateId = Number(db.prepare('INSERT INTO pending_clarifications(session_id,field,question,status,created_at,updated_at) VALUES (?,?,?,?,?,?)').run('synthetic', 'batch_confirm', '合成门', 'resolved', 'synthetic', 'synthetic').lastInsertRowid)
    const model = vi.fn(() => { throw new Error('must not use engine') })
    let currentDb: typeof db | null = db
    registerIpc({ getDb: () => currentDb, engines: { get: model, tryGet: model }, restartEngine: model } as never, { dataDir: 'synthetic', dbFile: 'synthetic' })
    for (const name of ['getBatchPresentation', 'setBatchPresentation']) expect(handlers.has('mz:' + name)).toBe(true)
    const read = (id: unknown = gateId) => handlers.get('mz:getBatchPresentation')!({}, id)
    const save = (patch: unknown, id: unknown = gateId) => handlers.get('mz:setBatchPresentation')!({}, id, patch)
    const baseline = ['pending_clarifications', 'transactions', 'audit_log', 'agent_runs'].map(t => db.prepare(`SELECT * FROM ${t}`).all())
    expect(read()).toEqual({ dismissed: false, duplicatesOpen: false, excludedOpen: false })
    expect(save({ duplicatesOpen: true })).toEqual({ dismissed: false, duplicatesOpen: true, excludedOpen: false })
    expect(read()).toEqual({ dismissed: false, duplicatesOpen: true, excludedOpen: false })
    const settings = db.prepare('SELECT * FROM settings').all()
    expect(() => save({ dismissed: true, excludedOpen: 'true' })).toThrow()
    expect(() => save({ dismissed: true }, String(gateId))).toThrow()
    expect(() => read(999999)).toThrow()
    expect(db.prepare('SELECT * FROM settings').all()).toEqual(settings)
    expect(['pending_clarifications', 'transactions', 'audit_log', 'agent_runs'].map(t => db.prepare(`SELECT * FROM ${t}`).all())).toEqual(baseline)
    expect(model).not.toHaveBeenCalled()
    currentDb = null
    expect(() => read()).toThrow('账本未就绪')
    expect(() => save({ dismissed: true })).toThrow('账本未就绪')
  } finally { db.close() }
})

it('preload只按冻结参数顺序转发展示状态接口', async () => {
  await import('../src/preload/index')
  const api = exposed.mock.calls[0][1]
  expect(typeof api.getBatchPresentation).toBe('function')
  expect(typeof api.setBatchPresentation).toBe('function')
  api.getBatchPresentation(7)
  expect(invokes).toHaveBeenLastCalledWith('mz:getBatchPresentation', 7)
  const patch = { dismissed: true, excludedOpen: false }
  api.setBatchPresentation(7, patch)
  expect(invokes).toHaveBeenLastCalledWith('mz:setBatchPresentation', 7, patch)
})
