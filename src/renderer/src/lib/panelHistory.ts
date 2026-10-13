import type { ChatEvent, ChatMessageDTO } from '../../../shared/types'
import type { PanelItem } from '../shell/panelStore'

/** 历史只是展示。可操作确认方案另从当前开放门读取，不能从旧工具卡复活。 */
export function panelItemsFromHistory(messages: ChatMessageDTO[]): PanelItem[] {
  const out: PanelItem[] = []
  for (const message of messages) {
    if (message.role === 'user') out.push({ id: `history:${message.id}`, kind: 'user', text: message.text, pending: false, images: message.images })
    else if (message.role === 'assistant') {
      if (message.thinkingText) out.push({ id: `history:${message.id}:thinking`, kind: 'thinking', seconds: 0, running: false, text: message.thinkingText, truncated: false, historical: true })
      if (message.text) out.push({ id: `history:${message.id}`, kind: message.isError ? 'notice' : 'assistant', text: message.text })
    } else out.push({ id: `history:${message.id}`, kind: 'tool', toolName: message.toolName ?? '', status: message.isError ? 'error' : 'done', summary: message.text, toolCallId: message.toolCallId })
  }
  return out
}

/** 身份和序号是去重依据；相同文本的另一次真实发送不能被吞掉。 */
export function eventsAfterSnapshot<T extends Pick<ChatEvent, 'sessionId' | 'streamId' | 'eventSeq'>>(events: readonly T[], snapshot: { sessionId: string | null; streamId: string | null; eventCursor: number }): T[] {
  return events.filter(event => event.sessionId === snapshot.sessionId && event.streamId === snapshot.streamId && typeof event.eventSeq === 'number' && event.eventSeq > snapshot.eventCursor)
}
