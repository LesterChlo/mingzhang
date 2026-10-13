import { expect, it } from 'vitest'
import { panelItemsFromHistory, eventsAfterSnapshot } from '../src/renderer/src/lib/panelHistory'

it('历史映射保留两条同文/图片/工具结果，只读完成态，不复活运行或确认门', () => {
  const rows = panelItemsFromHistory([
    { id: 'a', role: 'user', text: '一样', images: [{ previewUrl: 'data:image/png;base64,QUJD', fileName: '截图' }] },
    { id: 'b', role: 'user', text: '一样' },
    { id: 'c', role: 'tool', toolName: 'query', text: '结果', isError: true },
    { id: 'd', role: 'assistant', text: '正文' },
  ])
  expect(rows.filter(r => r.kind === 'user')).toHaveLength(2)
  expect(new Set(rows.map(r => r.id)).size).toBe(4)
  expect(rows[0]).toMatchObject({ kind: 'user', text: '一样', pending: false, images: [{ fileName: '截图' }] })
  expect(rows[2]).toMatchObject({ kind: 'tool', summary: '结果', status: 'error' })
  expect(rows[3]).toMatchObject({ kind: 'assistant', text: '正文' })
})
it('只重放同一流同一会话且在快照cursor之后的新事件，不用文本吞重复发送', () => {
  const events = [
    { type: 'user-message', sessionId: 's', streamId: 'p', eventSeq: 2, payload: { text: '一样' } },
    { type: 'user-message', sessionId: 's', streamId: 'p', eventSeq: 3, payload: { text: '一样' } },
    { type: 'user-message', sessionId: 'old', streamId: 'p', eventSeq: 4, payload: { text: '旧会话' } },
    { type: 'user-message', sessionId: 's', streamId: 'old-process', eventSeq: 5, payload: { text: '旧进程' } },
  ] as const
  expect(eventsAfterSnapshot(events, { sessionId: 's', streamId: 'p', eventCursor: 2 })).toEqual([events[1]])
})
it('历史仅思考消息保留思考正文，但不渲染空助手气泡；后续真实正文原样显示', () => {
  const rows = panelItemsFromHistory([
    { id: 'thinking-only', role: 'assistant', text: '', thinkingText: '真实持久思考正文' },
    { id: 'text', role: 'assistant', text: '真实后续正文', thinkingText: '后续思考' },
  ])
  expect(rows.filter(row => row.kind === 'thinking')).toHaveLength(2)
  expect(rows.filter(row => row.kind === 'assistant')).toEqual([{ id: 'history:text', kind: 'assistant', text: '真实后续正文' }])
  expect(rows[0]).toMatchObject({ kind: 'thinking', text: '真实持久思考正文', historical: true })
})
