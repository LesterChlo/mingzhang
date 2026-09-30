// 账单 CSV 导入（GB18030 编码）UI 巡检 —— T0929-2010。
//
// 覆盖：
//   ① 拖入 **GB18030 编码**的支付宝格式 CSV → 解析成速记行 chip、不出现红字
//      （这正是用户报的缺陷：读文件曾硬编码 UTF-8 → 中文列名乱码 → 表头判不中）
//   ② 拖入非表格 CSV → 仍明确报错，且文案带「已自动尝试 UTF-8/GBK 解码」与首行回显（不静默）
//
// 数据纪律：
//   ① 隔离：MZ_DATA_DIR 与 --user-data-dir 都是 mkdtemp 临时目录，真实账本 %APPDATA% 全程不碰。
//   ② 夹具是**冻结的合成数据**（12 列 × 3 行、商户/账号均为 example.com 示例值），
//      绝不读也不替换成任何真实账单文件。

import { test, expect, _electron, type ElectronApplication, type Page } from '@playwright/test'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/** 冻结夹具：支付宝列名的 12 列 CSV × 3 行数据，GB18030 字节（base64）。合成数据。 */
const ALIPAY_GB18030_B64 =
  'vbvS18qxvOQsvbvS17fWwOAsvbvS17bUt70sttS3vdXLusUsyczGt8u1w/csytUv1qcsvfC27izK1S+4tr/ut73KvSy9u9LX17TMrCy9u9LXtqm1pbrFLMnMvNK2qbWlusUssbjXog0KMjAyNi0wOS0yNSAxOTowNDozMiy5us7vLMPAzcXGvcyoycy7pyxtdEBleGFtcGxlLmNvbSzNxbm6zNeyzSzWp7P2LDEwLjY5LNPgtu6xpiy9u9LXs8m5piwyMDI2MDkyNTIyMDAxVEVTVDAwMDEsVEVTVC0wMDAxLA0KMjAyNi0wOS0yMiAxMzo0NDoxMCy5us7vLMSzyv3C68bsvaK16ixzaG9wQGV4YW1wbGUuY29tLMr9vt3P3yzWp7P2LDg1LjQwLLuo38IsvbvS17PJuaYsMjAyNjA5MjIyMjAwMVRFU1QwMDAyLFRFU1QtMDAwMiwNCjIwMjYtMDktMTIgMDg6MTg6MDUsubrO7yyx48D7teosZGVtb0BleGFtcGxlLmNvbSzI1dPDxrcs1qez9iwxMi45MCzT4LbuLL270tezybmmLDIwMjYwOTEyMjIwMDFURVNUMDAwMyxURVNULTAwMDMsDQo='

/** 起一个独立 Electron 实例：账本数据目录与 user-data-dir 都是临时目录。 */
async function launchIsolated(): Promise<{ app: ElectronApplication; page: Page }> {
  const dataDir = mkdtempSync(join(tmpdir(), 'mz-csv-data-'))
  const userDataDir = mkdtempSync(join(tmpdir(), 'mz-csv-udd-'))
  const app = await _electron.launch({
    args: ['.', `--user-data-dir=${userDataDir}`],
    env: { ...process.env, MZ_DATA_DIR: dataDir } as Record<string, string>,
  })
  const page = await app.firstWindow()
  await page.waitForSelector('.mz-shell', { timeout: 30_000 })
  return { app, page }
}

/** 合成一次「拖文件进速记行」：base64 → File → DataTransfer → dragover + drop。 */
async function dropFile(page: Page, name: string, type: string, b64: string): Promise<void> {
  await page.evaluate(
    ({ name, type, data }) => {
      const bin = atob(data)
      const bytes = new Uint8Array(bin.length)
      for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i)
      const dt = new DataTransfer()
      dt.items.add(new File([bytes], name, { type }))
      const el = document.querySelector('[data-testid="capture-bar"]')
      if (!el) throw new Error('拖拽目标不存在：capture-bar')
      for (const t of ['dragover', 'drop']) {
        el.dispatchEvent(new DragEvent(t, { bubbles: true, cancelable: true, dataTransfer: dt }))
      }
    },
    { name, type, data: b64 },
  )
}

test.describe('账单 CSV 导入（GB18030 编码）', () => {
  let app: ElectronApplication
  let page: Page

  test.beforeAll(async () => {
    const launched = await launchIsolated()
    app = launched.app
    page = launched.page
  })

  test.afterAll(async () => {
    await app?.close()
  })

  test('GB18030 编码的支付宝 CSV 能拖进来并成为速记行 chip（不报错）', async () => {
    await page.getByTestId('nav-inbox').click()
    const capture = page.getByLabel('速记行')
    await capture.press('Escape')
    await dropFile(page, '支付宝交易明细.csv', 'text/csv', ALIPAY_GB18030_B64)
    await expect(page.getByTestId('capture-bill').first(), '没解析成速记行 chip').toBeVisible()
    await expect(page.getByTestId('capture-error'), '不该出现红字').toHaveCount(0)
  })

  test('非表格 CSV 仍明确失败（带编码提示与首行回显，不静默）', async () => {
    await dropFile(page, '乱七八糟.csv', 'text/csv', Buffer.from('hello world\n').toString('base64'))
    const err = page.getByTestId('capture-error')
    await expect(err, '非表格文件必须报错').toBeVisible()
    await expect(err).toContainText('已自动尝试 UTF-8/GBK 解码')
    await expect(err).toContainText('首行是')
  })
})
