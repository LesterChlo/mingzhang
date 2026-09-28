// 普通 IPC 的动态 Engine 绑定：长期 IPC context 只持有“解析函数”，
// 不得按值捕获旧 Engine。恢复失败重开后，后续引擎请求命中新 Engine。
// 纯容器（无 Electron 依赖），生产与测试共用同一实现。

export interface EngineRegistry<T> {
  /** 解析当前 Engine；未就绪时抛错（调用方转为“引擎未就绪”）。 */
  get(): T
  tryGet(): T | null
  set(engine: T | null): void
}

export function createEngineRegistry<T>(): EngineRegistry<T> {
  let current: T | null = null
  return {
    get(): T {
      if (!current) throw new Error('引擎未就绪')
      return current
    },
    tryGet(): T | null {
      return current
    },
    set(engine: T | null): void {
      current = engine
    },
  }
}
