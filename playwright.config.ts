import { defineConfig } from '@playwright/test'

export default defineConfig({
  testDir: './tests/ui',
  // Electron + 共享应用实例：单 worker 串行（单实例锁也要求如此）
  workers: 1,
  fullyParallel: false,
  timeout: 90_000,
  expect: { timeout: 20_000 },
  retries: 0,
  outputDir: './tests/ui/results',
  reporter: [['list'], ['html', { outputFolder: './tests/ui/report', open: 'never' }]],
  use: {
    screenshot: 'only-on-failure',
    trace: 'retain-on-failure',
    viewport: { width: 1280, height: 860 },
  },
})
