// vitest 配置：排除 Playwright 的 UI 用例目录（tests/ui/** 由 `npm run ui-test` 跑）
// 与 .scratch（临时探针，Playwright 规格，不进 vitest 套跑）
import { defineConfig, configDefaults } from 'vitest/config'

export default defineConfig({
  test: {
    // 并行负载下默认 5s 会把重用例(备份/导入/加密等)打出"超时假红"；给全局 30s 余量。
    testTimeout: 30_000,
    exclude: [...configDefaults.exclude, 'tests/ui/**', '.scratch/**'],
  },
})
