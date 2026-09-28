// 恢复安全协调器：Agent 执行轮次与账本替换的互斥门。
// 恢复不能与正在跑的 Agent 轮次并发替换账本；两次恢复也不能并发。
// 纯协调器（无 Electron 依赖），生产与测试共用同一实现。
// Round2 根因修复：
//   - B2：轮次计数（不再是布尔值）：任一 endTurn 只结束一轮，全部轮次结束才允许恢复；嵌套 begin/end 正确。
//   - B3：门拒绝异常可识别（RestoreGateRefusedError/code），IPC 只在确实经过 close 且需要恢复连接时重开，保留原错误。

export interface RestoreSteps {
  /** 只读/结构/迁移验证：必须在关闭当前连接前完成；失败时不得关闭连接。 */
  validate: () => Promise<unknown>
  /** 关闭当前连接，为原子替换让路。 */
  close: () => Promise<void>
  /** 已验证候选的提交替换。 */
  commit: () => Promise<void>
}

/** 恢复门拒绝：发生在任何 close 之前，调用方不得关闭/重开连接，必须原样上浮。 */
export class RestoreGateRefusedError extends Error {
  readonly code = 'RESTORE_GATE_REFUSED'
  constructor(message: string) {
    super(message)
    this.name = 'RestoreGateRefusedError'
  }
}

export function isRestoreGateRefusal(err: unknown): boolean {
  if (err instanceof RestoreGateRefusedError) return true
  return (err as { code?: unknown } | null)?.code === 'RESTORE_GATE_REFUSED'
}

export type RestoreTurnToken = symbol & { readonly __restoreTurn?: unique symbol }

export class RestoreGate {
  private turns = new Set<RestoreTurnToken>()
  private restoring = false

  get inTurn(): boolean {
    return this.turns.size > 0
  }

  /** 当前未结束的轮次数（并发轮次可审计）。 */
  get activeTurns(): number {
    return this.turns.size
  }

  get isRestoring(): boolean {
    return this.restoring
  }

  /** 取得不可伪造的一次轮次令牌；恢复中返回 null。 */
  beginTurnToken(): RestoreTurnToken | null {
    if (this.restoring) return null
    const token = Symbol('restore-turn') as RestoreTurnToken
    this.turns.add(token)
    return token
  }

  /** 兼容旧调用：只负责登记一轮，调用方必须在本轮 finally 结束它。 */
  beginTurn(): boolean {
    return this.beginTurnToken() !== null
  }

  /** 令牌结束；重复/伪造令牌是 no-op，不能误结束其它轮次。 */
  endTurn(token?: RestoreTurnToken | null): void {
    if (token) this.turns.delete(token)
    else if (this.turns.size > 0) {
      const first = this.turns.values().next().value as RestoreTurnToken | undefined
      if (first) this.turns.delete(first)
    }
  }

  /** 恢复入口：顺序固定为 验证 → 关闭 → 提交；任一步失败都不继续下一步。 */
  async runRestore(steps: RestoreSteps): Promise<void> {
    if (this.restoring) throw new RestoreGateRefusedError('已有账本恢复正在进行，拒绝并发恢复（互斥）')
    if (this.turns.size > 0) throw new RestoreGateRefusedError('Agent 执行轮次进行中，拒绝并发替换账本（互斥）')
    this.restoring = true
    try {
      await steps.validate()
      await steps.close()
      await steps.commit()
    } finally {
      this.restoring = false
    }
  }
}

/** 生产全局门：Engine.sendChat 登记轮次，设置页恢复入口走 runRestore。 */
export const globalRestoreGate = new RestoreGate()

/**
 * B3 生产 IPC 统一入口：门拒绝（发生在 close 之前）直接上浮原错误，
 * close/commit 均 0 次、不重开；只有确实经过 close 后的失败才重开连接，且保留原错误。
 */
export async function runRestoreWithReconnect(
  gate: Pick<RestoreGate, 'runRestore'>,
  steps: RestoreSteps,
  reconnect: () => Promise<void>,
): Promise<void> {
  let closed = false
  try {
    await gate.runRestore({
      validate: steps.validate,
      close: async () => {
        await steps.close()
        closed = true
      },
      commit: steps.commit,
    })
  } catch (err) {
    if (isRestoreGateRefusal(err)) throw err
    if (closed) {
      try {
        await reconnect()
      } catch {
        // 重开失败不得覆盖原始错误
      }
    }
    throw err
  }
}
