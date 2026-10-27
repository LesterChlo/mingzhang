// Failpoints around real SessionManager public APIs; synthetic files only.
import { expect, it, vi } from 'vitest'
import * as fs from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
vi.mock('node:fs', async importOriginal => {
  const actual = await importOriginal<typeof import('node:fs')>()
  return { ...actual, writeFileSync: vi.fn(actual.writeFileSync), readFileSync: vi.fn(actual.readFileSync) }
})
import { SessionManager } from '@earendil-works/pi-coding-agent'
import { preserveFailedSend, parseSessionHistory } from '../src/main/history'

function manager() {
  const dir = fs.mkdtempSync(join(tmpdir(), 'mz-preflight-storage-'))
  return SessionManager.create(dir, join(dir, 'sessions'))
}

it('canonical文件在检查与wx之间被抢占：EEXIST必须可见，原字节不能覆写或假称保存', () => {
  const session = manager(), file = session.getSessionFile()!
  const original = fs.writeFileSync
  const winner = Buffer.from('synthetic concurrent file\n')
  const spy = vi.spyOn(fs, 'writeFileSync').mockImplementation((...args: Parameters<typeof fs.writeFileSync>) => {
    if (args[0] === file) original(file, winner, { flag: 'wx' })
    return original(...args)
  })
  try {
    expect(() => preserveFailedSend(session, '合成抢占失败', [], 'synthetic auth failure')).toThrow(/EEXIST/)
    expect(fs.readFileSync(file).equals(winner)).toBe(true)
    expect(parseSessionHistory(file)).toEqual([])
    expect(spy.mock.calls.filter(c => c[0] === file)[0]?.[2]).toMatchObject({ flag: 'wx' })
    console.log('[wx collision]', JSON.stringify({ error: 'EEXIST', winnerBytes: winner.length, overwrites: 0 }))
  } finally { spy.mockRestore() }
})

it('首写之后公开setSessionFile失败：不能吞错或另建聊天；磁盘原custom仍可读', () => {
  const session = manager(), file = session.getSessionFile()!
  const spy = vi.spyOn(session, 'setSessionFile').mockImplementationOnce(() => { throw new Error('synthetic reindex EIO') })
  try {
    expect(() => preserveFailedSend(session, '合成重新索引失败', [], 'synthetic auth failure')).toThrow('synthetic reindex EIO')
    expect(session.getSessionFile()).toBe(file)
    expect(parseSessionHistory(file).filter(m => m.role === 'user').map(m => m.text)).toEqual(['合成重新索引失败'])
    const reopened = SessionManager.open(file)
    expect(reopened.buildSessionContext().messages).toEqual([])
    expect(reopened.getEntries().filter(e => e.type === 'custom')).toHaveLength(1)
    console.log('[reindex failure]', JSON.stringify({ errorVisible: true, customEntries: 1, sdkMessages: 0 }))
  } finally { spy.mockRestore() }
})

it('已有file native append落盘后readback失败：向调用方报错；strict读取仍抛真实I/O错误', () => {
  const session = manager(), file = session.getSessionFile()!
  preserveFailedSend(session, '合成已存失败一', [], 'synthetic auth failure')
  const prefix = fs.readFileSync(file), original = fs.readFileSync
  const denied = Object.assign(new Error('synthetic history EACCES'), { code: 'EACCES' })
  const spy = vi.spyOn(fs, 'readFileSync').mockImplementation((...args: Parameters<typeof fs.readFileSync>) => {
    if (args[0] === file) throw denied
    return original(...args)
  })
  try {
    expect(() => preserveFailedSend(session, '合成已存失败二', [], 'synthetic auth failure')).toThrow(denied)
    expect(() => parseSessionHistory(file, 300, { strict: true })).toThrow(denied)
    expect(parseSessionHistory(file)).toEqual([])
  } finally { spy.mockRestore() }
  expect(fs.readFileSync(file).subarray(0, prefix.length).equals(prefix)).toBe(true)
  expect(parseSessionHistory(file).filter(m => m.role === 'user').map(m => m.text)).toEqual(['合成已存失败一', '合成已存失败二'])
  console.log('[readback I/O failure]', JSON.stringify({ error: 'EACCES', prefixBytes: prefix.length, durableAttempts: 2 }))
})

it('已有file native append失败：原字节保持，失败记录不得假出现在strict历史', () => {
  const session = manager(), file = session.getSessionFile()!
  preserveFailedSend(session, '合成原始已存失败', [], 'synthetic auth failure')
  const bytes = fs.readFileSync(file), saved = `${file}.preserved`
  fs.renameSync(file, saved)
  fs.mkdirSync(file)
  expect(() => preserveFailedSend(session, '合成追加失败', [], 'synthetic auth failure')).toThrow()
  expect(fs.readFileSync(saved).equals(bytes)).toBe(true)
  expect(parseSessionHistory(saved).filter(m => m.role === 'user').map(m => m.text)).toEqual(['合成原始已存失败'])
  expect(() => parseSessionHistory(file, 300, { strict: true })).toThrow()
  console.log('[native append failure]', JSON.stringify({ bytesPreserved: bytes.length, durableAttempts: 1 }))
})

it('已持久化失败会话的文件意外消失时拒绝再次保存，不让native append新建缺header残片', () => {
  const session = manager(), file = session.getSessionFile()!
  preserveFailedSend(session, '合成已有失败历史', [], 'synthetic auth failure')
  const bytes = fs.readFileSync(file), saved = `${file}.preserved`
  fs.renameSync(file, saved)
  expect(() => preserveFailedSend(session, '合成消失后失败', [], 'synthetic auth failure')).toThrow(/会话文件缺失/)
  expect(fs.existsSync(file)).toBe(false)
  expect(fs.readFileSync(saved).equals(bytes)).toBe(true)
  expect(session.getEntries().filter(e => e.type === 'custom')).toHaveLength(1)
  console.log('[missing persisted file]', JSON.stringify({ canonicalExists: false, bytesPreserved: bytes.length, attemptedRewrite: false }))
})

it('非持久化manager公开API不具备canonical文件时明确拒绝，不创建隐藏聊天store', () => {
  const dir = fs.mkdtempSync(join(tmpdir(), 'mz-preflight-memory-')), session = SessionManager.inMemory(dir)
  expect(() => preserveFailedSend(session, '合成内存会话失败', [], 'synthetic auth failure')).toThrow('会话没有可持久化的本地文件')
  expect(session.getEntries()).toEqual([])
  expect(fs.readdirSync(dir)).toEqual([])
})
