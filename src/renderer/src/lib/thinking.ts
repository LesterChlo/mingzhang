// 思考正文的按轮累积（T0928 §4，契约A：引擎广播 thinking-delta）。
//
// 为什么单列一个纯函数：累积/截断是面板 Store 里唯一有"算法"味道的逻辑，
// 抽出来 vitest 才能直接钉住（累积拼接 / 超上限截断并标记 / 已满不再追加），
// 不必为了测它去渲染 React 树。

/** 单轮思考正文的字符上限（约 8KB）：长思考不许撑爆面板内存。 */
export const THINK_TEXT_CAP = 8192

export interface ThinkingText {
  text: string
  /** 是否因撞到上限被截断（展开区据此显示"只保留前 N 字"）。 */
  truncated: boolean
}

/** 把一条思考增量追加到当前累积上；超过 THINK_TEXT_CAP 截断并标记，之后到达的增量不再改变内容。 */
export function appendThinkingDelta(cur: ThinkingText, delta: string, cap: number = THINK_TEXT_CAP): ThinkingText {
  if (cur.truncated) return cur
  const next = cur.text + delta
  if (next.length <= cap) return { text: next, truncated: false }
  return { text: next.slice(0, cap), truncated: true }
}
