// 商品经营 IPC handlers（第三/四/五/六/七阶段）。独立于 ipc.ts，便于维护。
// 渲染层通过 window.mz 调用，preload 暴露对应方法。

import { ipcMain, dialog } from 'electron'
import { writeFileSync } from 'node:fs'
import type { Database } from 'better-sqlite3-multiple-ciphers'
import {
  listProducts, listProductsWithVariants, getProduct, getProductProfile, updateProductPrice,
  listVariants, getVariant, getVariantProfile, createVariant, updateVariant, deleteVariant, updateVariantPrice,
  recordSale, recordPurchase, recordRefund, recordCSIncome, recordOther, recordExpense,
  getBusinessOverview, calculateProfit,
  getMonthlyReport, listBusinessMonths, getTrend,
  INCOME_CHANNELS, EXPENSE_CHANNELS, REFUND_CHANNELS, EXPENSE_CATEGORIES,
} from './domain/business'
import { buildBusinessWorkbook, businessExportFileName } from './domain/business-export'
import { snapshot, listSnapshots } from './domain/backup'
import {
  listTemplates, getTemplate, createTemplate, updateTemplate, deleteTemplate, touchTemplate, templateCounts,
  type TemplateKind,
} from './domain/templates'

export function registerBusinessIpc(getDb: () => Database | null, getBackupsDir?: () => string | null): void {
  const db = (): Database => {
    const d = getDb()
    if (!d) throw new Error('数据库未就绪')
    return d
  }

  // 商品
  ipcMain.handle('mz:listProducts', () => listProducts(db()))
  ipcMain.handle('mz:listProductsWithVariants', () => listProductsWithVariants(db()))
  ipcMain.handle('mz:getProduct', (_e, id: number) => getProduct(db(), id))
  ipcMain.handle('mz:getProductProfile', (_e, id: number) => getProductProfile(db(), id))
  ipcMain.handle('mz:updateProductPrice', (_e, id: number, cents: number) => {
    updateProductPrice(db(), id, cents)
    return true
  })

  // 规格
  ipcMain.handle('mz:listVariants', (_e, productId: number) => listVariants(db(), productId))
  ipcMain.handle('mz:getVariant', (_e, id: number) => getVariant(db(), id))
  ipcMain.handle('mz:getVariantProfile', (_e, id: number) => getVariantProfile(db(), id))
  ipcMain.handle('mz:createVariant', (_e, input: Parameters<typeof createVariant>[1]) => createVariant(db(), input))
  ipcMain.handle('mz:updateVariant', (_e, input: Parameters<typeof updateVariant>[1]) => {
    updateVariant(db(), input)
    return true
  })
  ipcMain.handle('mz:deleteVariant', (_e, id: number) => {
    deleteVariant(db(), id)
    return true
  })
  ipcMain.handle('mz:updateVariantPrice', (_e, id: number, cents: number) => {
    updateVariantPrice(db(), id, cents)
    return true
  })

  // 记账
  ipcMain.handle('mz:recordSale', (_e, input: Parameters<typeof recordSale>[1]) => recordSale(db(), input))
  ipcMain.handle('mz:recordPurchase', (_e, input: Parameters<typeof recordPurchase>[1]) => recordPurchase(db(), input))
  ipcMain.handle('mz:recordRefund', (_e, input: Parameters<typeof recordRefund>[1]) => recordRefund(db(), input))
  ipcMain.handle('mz:recordCSIncome', (_e, input: Parameters<typeof recordCSIncome>[1]) => recordCSIncome(db(), input))
  ipcMain.handle('mz:recordOther', (_e, input: Parameters<typeof recordOther>[1]) => recordOther(db(), input))
  ipcMain.handle('mz:recordExpense', (_e, input: Parameters<typeof recordExpense>[1]) => recordExpense(db(), input))

  ipcMain.handle('mz:listChannels', () => ({
    income: INCOME_CHANNELS,
    expense: EXPENSE_CHANNELS,
    refund: REFUND_CHANNELS,
    expenseCategories: EXPENSE_CATEGORIES,
  }))

  // 第五阶段：经营概览 + 实时盈亏测算
  ipcMain.handle('mz:getBusinessOverview', (_e, range?: Parameters<typeof getBusinessOverview>[1]) =>
    getBusinessOverview(db(), range),
  )
  ipcMain.handle('mz:calculateProfit', (_e, input: Parameters<typeof calculateProfit>[1]) =>
    calculateProfit(db(), input),
  )

  // 第六阶段：月度经营报表 + 趋势
  ipcMain.handle('mz:getMonthlyReport', (_e, month: string) => getMonthlyReport(db(), month))
  ipcMain.handle('mz:listBusinessMonths', (_e, limit?: number) => listBusinessMonths(db(), limit))
  ipcMain.handle('mz:getTrend', (_e, months?: number, endMonth?: string) => getTrend(db(), months, endMonth))

  // 第七阶段：经营报表 Excel 导出（路径只由主进程保存对话框产生，渲染层不能传任意路径）
  ipcMain.handle('mz:exportBusinessExcel', async (_e, month?: string | null): Promise<string | null> => {
    const m = month ?? null
    if (m !== null && !/^\d{4}-\d{2}$/.test(m)) throw new Error('月份格式应为 YYYY-MM')
    const result = await dialog.showSaveDialog({
      title: '导出经营报表',
      defaultPath: businessExportFileName(m),
      filters: [{ name: 'Excel 工作簿', extensions: ['xlsx'] }],
    })
    if (result.canceled || !result.filePath) return null
    writeFileSync(result.filePath, buildBusinessWorkbook(db(), { month: m }))
    return result.filePath
  })

  // 第七阶段：备份管理
  ipcMain.handle('mz:createBusinessSnapshot', (): string | null => {
    const dir = getBackupsDir?.()
    if (!dir) throw new Error('备份目录未就绪')
    return snapshot(db(), dir)
  })
  ipcMain.handle('mz:listBusinessSnapshots', () => {
    const dir = getBackupsDir?.()
    if (!dir) return []
    return listSnapshots(dir).map((s) => ({ name: s.name, size: s.size, mtime: s.mtime }))
  })
  ipcMain.handle('mz:getBackupsDir', () => getBackupsDir?.() ?? null)

  // 第八阶段：快捷记账模板
  ipcMain.handle('mz:listTemplates', (_e, kind?: TemplateKind) => listTemplates(db(), kind))
  ipcMain.handle('mz:getTemplate', (_e, id: number) => getTemplate(db(), id))
  ipcMain.handle('mz:createTemplate', (_e, input: Parameters<typeof createTemplate>[1]) => createTemplate(db(), input))
  ipcMain.handle('mz:updateTemplate', (_e, input: Parameters<typeof updateTemplate>[1]) => {
    updateTemplate(db(), input)
    return true
  })
  ipcMain.handle('mz:deleteTemplate', (_e, id: number) => {
    deleteTemplate(db(), id)
    return true
  })
  ipcMain.handle('mz:touchTemplate', (_e, id: number) => {
    touchTemplate(db(), id)
    return true
  })
  ipcMain.handle('mz:templateCounts', () => templateCounts(db()))
}