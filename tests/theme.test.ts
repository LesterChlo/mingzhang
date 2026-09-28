// 主题持久化（dark / light 新枚举，默认深色）：
//   - 全新安装 → dark；缺字段/非法值 → dark；
//   - 历史值 'mint'（旧命名的薄荷浅色）读出为 'light'（保真：原先是浅色的继续是浅色）；
//   - dark/light 往返稳定；主题不升 CONFIG_VERSION。
import { describe, expect, it } from 'vitest'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ConfigStore, CONFIG_VERSION, DEFAULT_THEME, type AppConfig } from '../src/main/config/store'

function freshFile(): string {
  return join(mkdtempSync(join(tmpdir(), 'mz-theme-cfg-')), 'config.json')
}

describe('主题配置（theme）', () => {
  it('全新安装（无 config.json）→ 默认 dark，且 CONFIG_VERSION 仍为 2（主题不升版本）', () => {
    const f = freshFile()
    const store = new ConfigStore(f)
    expect(store.load().theme).toBe('dark')
    expect(DEFAULT_THEME).toBe('dark')
    expect(CONFIG_VERSION).toBe(2)
  })

  it('老 config.json 没有 theme 字段 → 读出 dark（回退新默认），其余字段一个不动', () => {
    const f = freshFile()
    writeFileSync(
      f,
      JSON.stringify({
        version: CONFIG_VERSION,
        onboarded: true,
        mock: true,
        providers: [{ id: 'deepseek', name: 'DeepSeek', baseUrl: 'https://api.deepseek.com', model: 'deepseek-chat', visionCapable: false }],
        activeProviderId: 'deepseek',
      }),
    )
    const cfg = new ConfigStore(f).load()
    expect(cfg.theme).toBe('dark')
    expect(cfg.mock).toBe(true)
    expect(cfg.providers).toHaveLength(1)
    expect(cfg.activeProviderId).toBe('deepseek')
  })

  it("历史旧值 'mint' → 无损读出 'light'（原先浅色的用户继续是浅色），写盘后落成新枚举", () => {
    const f = freshFile()
    writeFileSync(
      f,
      JSON.stringify({
        version: CONFIG_VERSION,
        onboarded: true,
        mock: false,
        theme: 'mint',
        providers: [],
        activeProviderId: null,
      }),
    )
    const store = new ConfigStore(f)
    expect(store.load().theme).toBe('light')

    // 下次写盘自然落成新枚举——迁移只在读取侧生效，不就地改用户的 config.json
    store.save(store.load())
    expect((JSON.parse(readFileSync(f, 'utf8')) as { theme: string }).theme).toBe('light')
  })

  it('v1 单槽迁移也走主题归一（迁移路径不漏字段）', () => {
    const f = freshFile()
    writeFileSync(f, JSON.stringify({ version: 1, onboarded: true, provider: { id: 'x', name: 'X', baseUrl: '', model: 'm' } }))
    expect(new ConfigStore(f).load().theme).toBe('dark')

    // v1 里带历史 'mint' 的老配置，迁移后同样是 light
    const f2 = freshFile()
    writeFileSync(f2, JSON.stringify({ version: 1, onboarded: true, theme: 'mint', provider: { id: 'x', name: 'X', baseUrl: '', model: 'm' } }))
    const cfg = new ConfigStore(f2).load()
    expect(cfg.theme).toBe('light')
    expect(cfg.providers).toHaveLength(1)
  })

  it('dark/light 往返稳定（两个方向 + 落盘值都是新枚举）', () => {
    const f = freshFile()
    const store = new ConfigStore(f)
    const base: AppConfig = { ...store.load(), providers: [{ id: 'p', name: 'P', baseUrl: '', model: 'm', visionCapable: false }], activeProviderId: 'p' }
    const onDisk = () => (JSON.parse(readFileSync(f, 'utf8')) as { theme: string }).theme

    store.save({ ...base, theme: 'dark' })
    expect(store.load().theme).toBe('dark')
    expect(onDisk()).toBe('dark')

    store.save({ ...base, theme: 'light' })
    expect(store.load().theme).toBe('light')
    expect(onDisk()).toBe('light')

    // 切回 dark 仍稳定（往返两个方向都验）
    store.save({ ...base, theme: 'dark' })
    expect(store.load().theme).toBe('dark')
    expect(onDisk()).toBe('dark')
    expect(store.load().providers).toHaveLength(1)
  })

  it("非法值（如 'blue'）回退 dark 并写回新枚举", () => {
    const f = freshFile()
    const store = new ConfigStore(f)
    const base: AppConfig = { ...store.load(), providers: [{ id: 'p', name: 'P', baseUrl: '', model: 'm', visionCapable: false }], activeProviderId: 'p' }

    store.save({ ...base, theme: 'blue' as unknown as AppConfig['theme'] })
    expect(store.load().theme).toBe('dark')
    expect((JSON.parse(readFileSync(f, 'utf8')) as { theme: string }).theme).toBe('dark')
    expect(store.load().providers).toHaveLength(1)
  })
})
