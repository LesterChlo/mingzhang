import { expect, it, vi } from 'vitest'
const { handlers, invokes, expose } = vi.hoisted(() => ({handlers:new Map<string,(...args:any[])=>any>(),invokes:vi.fn(),expose:vi.fn()}))
vi.mock('electron', () => ({ipcMain:{handle:(name:string,fn:(...args:any[])=>any)=>handlers.set(name,fn)},nativeTheme:{},ipcRenderer:{invoke:invokes,on:vi.fn(),removeListener:vi.fn()},contextBridge:{exposeInMainWorld:expose}}))
import { registerIpc } from '../src/main/ipc'
import { openSchemaDb } from './helpers'
import { seed } from '../src/main/db/seed'
import { prepareBatch, executeBatch } from '../src/main/domain/batch'
import { describeImportException } from '../src/main/domain/import-exceptions'

it('preload精确转发冻结的异常读取与结构化输入，不改名不增诊断通道', async () => {
  await import('../src/preload/index')
  const api = expose.mock.calls[0][1]
  const input = {gateId:123,expectedVersion:'opaque-token',fields:{amountCents:1234}}
  api.getImportException(123); expect(invokes).toHaveBeenLastCalledWith('mz:getImportException',123)
  api.resolveImportException(input); expect(invokes).toHaveBeenLastCalledWith('mz:resolveImportException',input)
})

it('真实IPC按当前动态DB附领域DTO，严格参数拒绝零写，提交只处理原行', () => {
  const first = openSchemaDb(':memory:'), second = openSchemaDb(':memory:');seed(first);seed(second)
  let current = first
  try {
    registerIpc({getDb:()=>current} as never,{dataDir:'synthetic',dbFile:':memory:'})
    const batch = prepareBatch(second,{sourceType:'csv',sessionId:'synthetic',items:[{amount_cents:null,tx_type:'income',occurred_at:'2026-10-08 09:15:00',account_name:'银行卡',merchant:'合成IPC'}]})
    executeBatch(second,batch.gateId)
    const gate = (second.prepare("SELECT id FROM pending_clarifications WHERE field='batch_item'").get() as {id:number}).id
    const read = handlers.get('mz:getImportException')!, write = handlers.get('mz:resolveImportException')!
    expect(read({},gate)).toBeNull();current=second
    const dto = read({},gate)
    expect(dto).toEqual(describeImportException(second,gate))
    expect(handlers.get('mz:listPending')!({})[0]).toMatchObject({gateId:gate,revision:1,importException:dto})
    const categoryId = (second.prepare("SELECT id FROM categories WHERE kind='income' AND name='其他'").get() as {id:number}).id
    const input = {gateId:gate,expectedVersion:dto.version,fields:{amountCents:1234,categoryId}}
    expect(()=>read({},String(gate))).toThrow()
    expect(()=>write({}, {...input,extra:true})).toThrow()
    expect(()=>write({}, {...input,fields:{...input.fields,accountName:'现金'}})).toThrow()
    expect(second.prepare('SELECT COUNT(*) n FROM transactions').get()).toEqual({n:0})
    expect(write({},input)).toMatchObject({card:{tx:{type:'income',state:'confirmed',amountCents:1234}}})
    expect(first.prepare('SELECT COUNT(*) n FROM transactions').get()).toEqual({n:0})
  } finally {first.close();second.close()}
})
