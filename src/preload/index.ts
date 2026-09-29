// contextBridge：把类型化 API 暴露给渲染层（contextIsolation 开启）。

import { contextBridge, ipcRenderer } from 'electron'
import type { ChatEvent, MingZhangApi } from '../shared/types'

const api: MingZhangApi = {
  getState: () => ipcRenderer.invoke('mz:getState'),
  listPresets: () => ipcRenderer.invoke('mz:listPresets'),
  testConnection: (input) => ipcRenderer.invoke('mz:testConnection', input),
  visionCheck: (input) => ipcRenderer.invoke('mz:visionCheck', input),
  saveProvider: (input) => ipcRenderer.invoke('mz:saveProvider', input),
  setActiveProvider: (id) => ipcRenderer.invoke('mz:setActiveProvider', id),
  setTheme: (theme) => ipcRenderer.invoke('mz:setTheme', theme),
  runVisionCheck: (providerId) => ipcRenderer.invoke('mz:runVisionCheck', providerId),
  deleteProvider: (id) => ipcRenderer.invoke('mz:deleteProvider', id),
  sendChat: (text, images) => ipcRenderer.invoke('mz:sendChat', text, images),
  stageBill: (input) => ipcRenderer.invoke('mz:stageBill', input),
  confirmRecord: (txId, categoryName) => ipcRenderer.invoke('mz:confirmRecord', txId, categoryName),
  confirmGate: (gateId) => ipcRenderer.invoke('mz:confirmGate', gateId),
  cancelGate: (gateId) => ipcRenderer.invoke('mz:cancelGate', gateId),
  editTx: (txId, op) => ipcRenderer.invoke('mz:editTx', txId, op),
  listCategories: () => ipcRenderer.invoke('mz:listCategories'),
  listPending: () => ipcRenderer.invoke('mz:listPending'),
  listAccounts: () => ipcRenderer.invoke('mz:listAccounts'),
  latestReport: (month) => ipcRenderer.invoke('mz:latestReport', month),
  reportMonths: (count) => ipcRenderer.invoke('mz:reportMonths', count),
  getConfidenceThreshold: () => ipcRenderer.invoke('mz:getConfidenceThreshold'),
  setConfidenceThreshold: (value) => ipcRenderer.invoke('mz:setConfidenceThreshold', value),
  getSettingsInfo: () => ipcRenderer.invoke('mz:getSettingsInfo'),
  setBudget: (cents) => ipcRenderer.invoke('mz:setBudget', cents),
  cleanupAttachments: (keepDays) => ipcRenderer.invoke('mz:cleanupAttachments', keepDays),
  createSnapshotNow: () => ipcRenderer.invoke('mz:createSnapshotNow'),
  listSnapshots: () => ipcRenderer.invoke('mz:listSnapshots'),
  restoreSnapshot: (name) => ipcRenderer.invoke('mz:restoreSnapshot', name),
  rollbackRestore: () => ipcRenderer.invoke('mz:rollbackRestore'),
  newConversation: () => ipcRenderer.invoke('mz:newConversation'),
  exportBackup: (passphrase) => ipcRenderer.invoke('mz:exportBackup', passphrase),
  importBackup: (passphrase) => ipcRenderer.invoke('mz:importBackup', passphrase),
  setMock: (enabled) => ipcRenderer.invoke('mz:setMock', enabled),
  listLedger: (filter) => ipcRenderer.invoke('mz:listLedger', filter),
  getBatchResult: (gateId) => ipcRenderer.invoke('mz:getBatchResult', gateId),
  getClassifyProposal: (batchId) => ipcRenderer.invoke('mz:getClassifyProposal', batchId),
  applyClassify: (gateId, rows) => ipcRenderer.invoke('mz:applyClassify', gateId, rows),
  undoClassify: (classifyId) => ipcRenderer.invoke('mz:undoClassify', classifyId),
  txDetail: (txId) => ipcRenderer.invoke('mz:txDetail', txId),
  loadHistory: () => ipcRenderer.invoke('mz:loadHistory'),
  pendingGateCards: () => ipcRenderer.invoke('mz:pendingGateCards'),
  answerPending: (gateId, answer) => ipcRenderer.invoke('mz:answerPending', gateId, answer),
  listSessions: () => ipcRenderer.invoke('mz:listSessions'),
  readArchive: (path) => ipcRenderer.invoke('mz:readArchive', path),
  continueSession: (path) => ipcRenderer.invoke('mz:continueSession', path),
  readAttachment: (relPath) => ipcRenderer.invoke('mz:readAttachment', relPath),
  onChatEvent: (listener) => {
    const handler = (_e: unknown, evt: ChatEvent): void => listener(evt)
    ipcRenderer.on('mz:chat-event', handler)
    return () => ipcRenderer.removeListener('mz:chat-event', handler)
  },
}

contextBridge.exposeInMainWorld('mz', api)
