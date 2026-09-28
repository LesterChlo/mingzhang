// 应用配置（config.json）：schema 带 version（决定记录 §4：多预设，2026-09-19 试用反馈修订）。
// v2 = providers[]（各自带自检状态）+ activeProviderId；v1 单槽在 load 时自动迁移，不丢数据。
// 本文件不含任何密钥。

import { readFileSync, writeFileSync, existsSync } from 'node:fs'

export const CONFIG_VERSION = 2

export interface ProviderConfig {
  /** 稳定唯一键：预设 id 或 custom-<时间戳>；密钥文件名与之绑定（provider-key:<id>）。 */
  id: string
  name: string
  baseUrl: string
  model: string
  /** 视觉自检实测通过 = true；未检测/失败 = false。拖图前据此拦截（决定记录 §2.1）。 */
  visionCapable: boolean
  /** 最近一次「测试连接/视觉自检」通过时间（列表展示用）。 */
  selfCheckAt?: string | null
}

export type ThemeName = 'dark' | 'light'

/** 全新安装的默认主题：深色（与设计预览一致）。 */
export const DEFAULT_THEME: ThemeName = 'dark'

/**
 * 归一化配置里的 theme 字段：
 *   - 历史值 'mint'（旧命名的薄荷浅色）等价迁移为 'light'——用户原先看到的是浅色，继续是浅色；
 *   - 缺字段或任何非法值（如 'blue'）回退新默认 'dark'。
 * 迁移只发生在读取时（load/save 的入参出口），下次写盘自然落成新枚举；
 * 既有 config.json 不被就地改写。
 */
export function normalizeTheme(raw: unknown): ThemeName {
  if (raw === 'dark') return 'dark'
  if (raw === 'light') return 'light'
  if (raw === 'mint') return 'light' // 旧命名：仅作历史值兼容读取，现行枚举里已无 mint
  return DEFAULT_THEME
}

export interface AppConfig {
  version: number
  /** 兼容字段：首个 provider 保存后置 true；不再用于拦截主界面（决定记录 §4：向导不拦路）。 */
  onboarded: boolean
  /** 离线演示（mock）：true 时引擎使用内置确定性假模型，忽略 provider。 */
  mock?: boolean
  /** 外观主题：纯视觉层，缺失/非法回退 dark（历史值 'mint' 迁移为 light）；切换不重启引擎、不进 schema 版本。 */
  theme?: ThemeName
  providers: ProviderConfig[]
  activeProviderId: string | null
}

const EMPTY: AppConfig = {
  version: CONFIG_VERSION,
  onboarded: false,
  mock: false,
  theme: DEFAULT_THEME,
  providers: [],
  activeProviderId: null,
}

export class ConfigStore {
  constructor(private readonly file: string) {}

  load(): AppConfig {
    if (!existsSync(this.file)) return { ...EMPTY }
    try {
      const raw = JSON.parse(readFileSync(this.file, 'utf8')) as Record<string, unknown>
      if (raw.version === CONFIG_VERSION) {
        return {
          version: CONFIG_VERSION,
          onboarded: Boolean(raw.onboarded),
          mock: Boolean(raw.mock),
          theme: normalizeTheme(raw.theme),
          providers: Array.isArray(raw.providers) ? (raw.providers as ProviderConfig[]) : [],
          activeProviderId: (raw.activeProviderId as string | null) ?? null,
        }
      }
      if (raw.version === 1) {
        // v1 单槽 → v2 多预设：字段一个不丢
        const p = raw.provider as Partial<ProviderConfig> | null | undefined
        const providers: ProviderConfig[] = p
          ? [
              {
                id: String(p.id ?? 'custom'),
                name: String(p.name ?? '自定义'),
                baseUrl: String(p.baseUrl ?? ''),
                model: String(p.model ?? ''),
                visionCapable: Boolean(p.visionCapable),
                selfCheckAt: null,
              },
            ]
          : []
        return {
          version: CONFIG_VERSION,
          onboarded: Boolean(raw.onboarded),
          mock: Boolean(raw.mock),
          theme: normalizeTheme(raw.theme),
          providers,
          activeProviderId: providers[0]?.id ?? null,
        }
      }
      return { ...EMPTY }
    } catch {
      return { ...EMPTY }
    }
  }

  save(config: AppConfig): void {
    const payload: AppConfig = {
      version: CONFIG_VERSION,
      onboarded: Boolean(config.onboarded),
      mock: Boolean(config.mock),
      theme: normalizeTheme(config.theme),
      providers: config.providers,
      activeProviderId: config.activeProviderId,
    }
    writeFileSync(this.file, JSON.stringify(payload, null, 2), 'utf8')
  }

  activeProvider(config: AppConfig): ProviderConfig | null {
    return config.providers.find((p) => p.id === config.activeProviderId) ?? null
  }
}
