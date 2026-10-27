import {useEffect,useRef,useState} from 'react'
import type {ReactElement} from 'react'
import type {AccountOption,ImportExceptionDTO,ImportExceptionTxType,ResolveImportExceptionInput} from '../../../shared/types'
import {useInbox} from '../shell/inboxStore'
import {humanError} from '../lib/ledgerFilter'
import {money,txTypeLabel} from '../lib/shellFormat'
import '../styles/import-exceptions.css'

/** Only the user-supplied missing fields go to the frozen original-row API. */
export function ImportExceptionForm({value,disabled}:{value:ImportExceptionDTO;disabled:boolean}):ReactElement {
  const {categories,runExec}=useInbox()
  const [accounts,setAccounts]=useState<AccountOption[]>([])
  const [accountsError,setAccountsError]=useState<string|null>(null)
  const [fields,setFields]=useState<Record<string,string>>({})
  const [error,setError]=useState<string|null>(null)
  const [sending,setSending]=useState(false)
  const latch=useRef(false)
  const [reload,setReload]=useState(0)
  useEffect(()=>{
    let active=true
    void window.mz.listAccounts().then(a=>{if(active){setAccounts(a);setAccountsError(null)}}).catch(e=>{if(active)setAccountsError(humanError(e))})
    return()=>{active=false}
  },[reload])
  const missing=new Set(value.missingFields)
  const kind=value.values.txType ?? fields.txType as ImportExceptionTxType|undefined
  const set=(key:string,v:string):void=>{setFields(old=>({...old,[key]:v,...(key==='txType'?{categoryId:'',toAccountId:''}:{})}));setError(null)}
  const knownAccount=(id:number|null):string=>accounts.find(a=>a.id===id)?.name ?? value.source.accountName ?? '原账户已保留'
  async function submit():Promise<void>{
    if(latch.current||disabled)return
    const input:ResolveImportExceptionInput['fields']={}
    try{
      if(missing.has('amountCents')){
        const raw=(fields.amountCents??'').trim(), m=/^(-?)(\d+)(?:\.(\d{1,2}))?$/.exec(raw)
        if(!m)throw Error('请填写金额，最多两位小数')
        const cents=Number(m[2])*100+Number((m[3]??'').padEnd(2,'0'))
        input.amountCents=m[1]?-cents:cents
        if(!Number.isSafeInteger(input.amountCents)||input.amountCents===0||(kind!=='adjustment'&&input.amountCents<0))throw Error('金额必须有效；收入、支出和转账需大于零')
      }
      if(missing.has('txType')){
        if(!fields.txType)throw Error('请选择原交易方向')
        input.txType=fields.txType as ImportExceptionTxType
      }
      if(missing.has('occurredAt')){
        if(!fields.occurredAt)throw Error('请选择原交易日期，不自动使用今天')
        input.occurredAt=fields.occurredAt
      }
      if(missing.has('accountId')){
        if(!fields.accountId)throw Error('请选择已有账户')
        input.accountId=Number(fields.accountId)
      }
      if(kind==='transfer'&&(missing.has('toAccountId')||value.values.toAccountId===null)){
        if(!fields.toAccountId)throw Error('请选择转入账户')
        input.toAccountId=Number(fields.toAccountId)
        if(input.toAccountId===(input.accountId??value.values.accountId))throw Error('转出和转入账户不能相同')
      }
      if(fields.categoryId)input.categoryId=Number(fields.categoryId)
      latch.current=true;setSending(true);setError(null)
      const result=await runExec(value.gateId,async()=>{
        const r=await window.mz.resolveImportException({gateId:value.gateId,expectedVersion:value.version,fields:input})
        return {status:'ok',message:r.text,card:r.card}
      })
      if(!result)setError('未提交成功，请查看回执；先刷新原待办，再重新核对提交')
    }catch(e){setError(humanError(e))}finally{latch.current=false;setSending(false)}
  }
  const locked=disabled||sending
  const selectAccount=(key:'accountId'|'toAccountId',label:string):ReactElement=>(
    <label className="mz-exception-field"><span>{label}</span><select className="mz-select" data-testid={key==='accountId'?'exception-account':'exception-to-account'} aria-label={label} value={fields[key]??''} disabled={locked||!!accountsError} onChange={e=>set(key,e.target.value)}>
      <option value="">选择已有账户</option>{accounts.map(a=><option value={a.id} key={a.id}>{a.name}</option>)}
    </select></label>
  )
  return <div className="mz-exception" data-testid="exception-form" data-version={value.version}>
    <div className="mz-exception-source">
      <strong>{value.source.merchant??'原导入行'}</strong>
      {value.source.rowNo!==null&&<span>第 {value.source.rowNo} 行</span>}
      {value.source.sourceText&&<p>{value.source.sourceText}</p>}
      <span>{value.reason}</span>
    </div>
    <div className="mz-exception-preserved" data-testid="exception-preserved">
      {value.values.amountCents!==null&&<span>{money(value.values.amountCents)}</span>}
      {value.values.txType&&<span>{txTypeLabel(value.values.txType)}</span>}
      {value.values.occurredAt&&<span>{value.values.occurredAt}</span>}
      {value.values.accountId!==null&&<span>{kind==='transfer'?'转出：':''}{knownAccount(value.values.accountId)}</span>}
      {value.values.toAccountId!==null&&<span>转入：{knownAccount(value.values.toAccountId)}</span>}
      {value.values.categoryId!==null&&<span>{categories.find(c=>c.id===value.values.categoryId)?.name??'原分类已保留'}</span>}
    </div>
    {accountsError&&<div className="mz-exception-error" role="alert">账户读取失败：{accountsError} <button className="mz-btn mz-btn-ghost" type="button" onClick={()=>setReload(n=>n+1)}>重试</button></div>}
    <div className="mz-exception-grid">
      {missing.has('amountCents')&&<label className="mz-exception-field"><span>金额（元）</span><input className="mz-input" data-testid="exception-amount" aria-label="补录金额（元）" inputMode="decimal" value={fields.amountCents??''} disabled={locked} placeholder="填写原金额" onChange={e=>set('amountCents',e.target.value)}/></label>}
      {missing.has('txType')&&<label className="mz-exception-field"><span>原交易方向</span><select className="mz-select" data-testid="exception-type" aria-label="原交易方向" value={fields.txType??''} disabled={locked} onChange={e=>set('txType',e.target.value)}><option value="">选择方向</option>{(['expense','income','transfer','adjustment'] as const).map(t=><option value={t} key={t}>{txTypeLabel(t)}</option>)}</select></label>}
      {missing.has('occurredAt')&&<label className="mz-exception-field"><span>原交易日期</span><input type="date" className="mz-input" data-testid="exception-date" aria-label="原交易日期" value={fields.occurredAt??''} disabled={locked} onChange={e=>set('occurredAt',e.target.value)}/></label>}
      {missing.has('accountId')&&selectAccount('accountId',kind==='transfer'?'转出账户':'入账账户')}
      {kind==='transfer'&&(missing.has('toAccountId')||value.values.toAccountId===null)&&selectAccount('toAccountId','转入账户')}
      {(kind==='income'||kind==='expense')&&value.values.categoryId===null&&<label className="mz-exception-field"><span>分类</span><select className="mz-select" data-testid="exception-category" aria-label="补录分类" value={fields.categoryId??''} disabled={locked} onChange={e=>set('categoryId',e.target.value)}><option value="">暂不分类，补录后再确认</option>{categories.filter(c=>c.kind===kind).map(c=><option key={c.id} value={c.id}>{c.name}</option>)}</select></label>}
    </div>
    {error&&<div className="mz-exception-error" role="alert" data-testid="exception-error">{error}</div>}
    <div className="mz-exception-footer"><span>只续办这笔原行。有效原值不变，不调用模型。</span><button type="button" className="mz-btn mz-btn-primary" data-testid="exception-submit" disabled={locked||!!accountsError} onClick={()=>void submit()}>{sending?'正在补录…':'确认补录原行'}</button></div>
  </div>
}
