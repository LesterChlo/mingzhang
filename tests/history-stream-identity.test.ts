// Synthetic, no new pi run: verify complete broadcaster wrapping and stale-source identity.
import { expect, it } from 'vitest'
import { Engine } from '../src/main/engine/engine'
import type { ChatEvent } from '../src/shared/types'

it('既有非聊天广播payload不改写；旧pi来源不能被当前session身份污染', () => {
  const events: ChatEvent[] = []
  const engine = new Engine({} as never, {} as never, {} as never, {} as never, e => events.push(e))
  const internal = engine as unknown as { session: unknown; onPiEvent: (e: any, sessionId: string) => void; broadcast: (e: ChatEvent) => void }
  internal.session = { sessionId: 'current-synthetic' }
  const payload = { gateId: 7, card: { kind: 'batch-result' }, result: '合成' }
  const types: ChatEvent['type'][] = ['record-confirmed', 'gate-executed', 'gate-cancelled', 'tx-deleted', 'tx-restored']
  for (const type of types) internal.broadcast({ type, payload })
  expect(events.every(e => e.sessionId === 'current-synthetic' && e.payload === payload)).toBe(true)
  internal.onPiEvent({ type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta: '旧合成正文' } }, 'old-synthetic')
  internal.onPiEvent({ type: 'message_update', assistantMessageEvent: { type: 'thinking_delta', delta: '旧合成思考' } }, 'old-synthetic')
  internal.onPiEvent({ type: 'tool_execution_start', toolName: 'query' }, 'old-synthetic')
  internal.onPiEvent({ type: 'tool_execution_end', toolName: 'query', result: { content: [{ type: 'text', text: '旧合成结果' }], details: { card: payload.card } } }, 'old-synthetic')
  internal.onPiEvent({ type: 'agent_end' }, 'old-synthetic')
  expect(events.slice(types.length).every(e => e.sessionId === 'old-synthetic')).toBe(true)
  expect(events.map(e => e.eventSeq)).toEqual(events.map((_, i) => i + 1))
  expect(events.every(e => e.streamId === engine.panelHistoryState.streamId)).toBe(true)
  expect(engine.panelHistoryState).toMatchObject({ sessionId: 'current-synthetic', eventCursor: events.length, busy: false })
})
