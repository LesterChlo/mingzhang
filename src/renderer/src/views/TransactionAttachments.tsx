import {useCallback,useEffect,useRef,useState} from 'react'
import type {ReactElement} from 'react'
import type {AddTxAttachmentsInput,TxAttachmentListDTO} from '../../../shared/types'
import {humanError} from '../lib/ledgerFilter'
import '../styles/transaction-attachments.css'

const media=['image/png','image/jpeg','image/webp','image/gif']
function fileData(file:File):Promise<string>{
  return new Promise((resolve,reject)=>{const r=new FileReader();r.onerror=()=>reject(Error(`无法读取「${file.name}」`));r.onload=()=>{if(typeof r.result!=='string'||!r.result.includes(','))reject(Error('图片读取结果无效'));else resolve(r.result.slice(r.result.indexOf(',')+1))};r.readAsDataURL(file)})
}
function imageUrl(value:string|null):string|null{
  return value&&/^data:image\/(?:png|jpeg|webp|gif);base64,[A-Za-z0-9+/=]+$/.test(value)?value:null
}
export function TransactionAttachments({txId,deleted,onChanged}:{txId:number;deleted:boolean;onChanged:()=>void}):ReactElement{
  const [list,setList]=useState<TxAttachmentListDTO|null>(null)
  const [urls,setUrls]=useState<Record<string,string|null>>({})
  const [error,setError]=useState<string|null>(null)
  const [busy,setBusy]=useState(false)
  const [loading,setLoading]=useState(true)
  const [preview,setPreview]=useState<string|null>(null)
  const [notice,setNotice]=useState<string|null>(null)
  const input=useRef<HTMLInputElement>(null),closed=useRef(false),locked=useRef(false),loadSeq=useRef(0)
  const trigger=useRef<HTMLButtonElement|null>(null)
  const dialog=useRef<HTMLDivElement>(null)
  useEffect(()=>{closed.current=false;return()=>{closed.current=true;loadSeq.current++}},[])
  const load=useCallback(async()=>{
    const seq=++loadSeq.current;setLoading(true)
    try{const next=await window.mz.listTransactionAttachments(txId);if(closed.current||seq!==loadSeq.current)return;setList(next);setError(null)
      const all=await Promise.all(next.items.map(async item=>[item.ref,item.available?imageUrl(await window.mz.readAttachment(item.ref).catch(()=>null)):null] as const))
      if(!closed.current&&seq===loadSeq.current)setUrls(Object.fromEntries(all))
    }catch(e){if(!closed.current&&seq===loadSeq.current)setError(humanError(e))}finally{if(!closed.current&&seq===loadSeq.current)setLoading(false)}
  },[txId])
  useEffect(()=>{void load()},[load])
  function closePreview():void{setPreview(null);trigger.current?.focus()}
  useEffect(()=>{
    if(!preview)return
    dialog.current?.querySelector<HTMLButtonElement>('button')?.focus()
    const key=(e:KeyboardEvent):void=>{
      if(e.key==='Escape'){e.preventDefault();closePreview()}
      if(e.key==='Tab'){const buttons=Array.from(dialog.current?.querySelectorAll<HTMLButtonElement>('button')??[]);const index=buttons.indexOf(document.activeElement as HTMLButtonElement);e.preventDefault();buttons[(index+(e.shiftKey?-1:1)+buttons.length)%buttons.length]?.focus()}
    }
    window.addEventListener('keydown',key);return()=>window.removeEventListener('keydown',key)
  },[preview])
  async function add(files:File[]):Promise<void>{
    if(locked.current||deleted||!list||!files.length)return
    locked.current=true;setBusy(true);setNotice(null);setError(null)
    try{
      if(files.length>list.limits.maxCount)throw Error(`一次最多选择 ${list.limits.maxCount} 张图片`)
      for(const file of files){if(!media.includes(file.type))throw Error(`「${file.name}」格式不支持，请选择 PNG、JPEG、WebP 或 GIF`);if(!file.size||file.size>list.limits.maxFileBytes)throw Error(`「${file.name}」为空或超过 10MiB`)}
      if(files.reduce((n,f)=>n+f.size,0)>list.limits.maxTotalBytes)throw Error('本次所选图片超过合计 40MiB')
      const payload:AddTxAttachmentsInput={txId,expectedVersion:list.version,files:await Promise.all(files.map(async file=>({fileName:file.name,mediaType:file.type,dataBase64:await fileData(file)})))}
      if(closed.current)return
      const next=await window.mz.addTransactionAttachments(payload)
      if(closed.current)return
      setNotice(next.version===list.version?'所选图片已经在这笔交易中，未重复添加':`已添加 ${next.items.length-list.items.length} 张图片`)
      await load();if(!closed.current)onChanged()
    }catch(e){if(!closed.current)setError(humanError(e))}finally{locked.current=false;if(!closed.current)setBusy(false);if(input.current)input.current.value=''}
  }
  async function remove(ref:string):Promise<void>{
    if(locked.current||deleted||!list)return
    locked.current=true;setBusy(true);setNotice(null);setError(null)
    try{await window.mz.removeTransactionAttachment({txId,expectedVersion:list.version,ref});if(closed.current)return;setNotice('已从这笔交易移除引用，原图文件仍保留');await load();if(!closed.current)onChanged()}
    catch(e){if(!closed.current)setError(humanError(e))}finally{locked.current=false;if(!closed.current)setBusy(false)}
  }
  const current=list?.items.find(item=>item.ref===preview)
  return <section className="mz-tx-attachments" data-testid="ledger-attachments" aria-busy={busy||loading}>
    <div className="mz-tx-attachments-head"><h3>交易附件{list&&<span>{list.items.length} 张</span>}</h3>
      <button type="button" className="mz-btn mz-btn-ghost" data-testid="ledger-attachment-add" disabled={busy||loading||deleted||!list} onClick={()=>input.current?.click()}>＋ 添加图片</button>
      <input ref={input} type="file" multiple accept="image/png,image/jpeg,image/webp,image/gif" aria-label="选择交易附件" data-testid="ledger-attachment-input" onChange={e=>void add(Array.from(e.target.files??[]))} hidden/>
    </div>
    <p className="mz-tx-attachment-limits">PNG / JPEG / WebP / GIF · 最多12张 · 单张10MiB · 合计40MiB</p>
    {error&&<div className="mz-tx-attachment-error" data-testid="ledger-attachment-error" role="alert">{error}<button type="button" className="mz-btn mz-btn-ghost" disabled={busy} onClick={()=>void load()}>刷新附件</button></div>}
    {notice&&<div className="mz-tx-attachment-notice" data-testid="ledger-attachment-notice" role="status">{notice}</div>}
    {loading&&!list&&<p className="mz-text-3">正在读取附件…</p>}
    {list?.items.length===0&&<p className="mz-text-3" data-testid="ledger-attach-empty">这笔没有附件，可以从本机选择图片。</p>}
    <div className="mz-tx-attachment-list">
      {list?.items.map(item=><div className="mz-tx-attachment-row" key={item.ref} data-testid="ledger-attachment-item" data-ref={item.ref}>
        <button type="button" className="mz-tx-attachment-preview" data-testid="ledger-attachment-preview" disabled={!urls[item.ref]||busy} onClick={e=>{trigger.current=e.currentTarget;setPreview(item.ref)}} aria-label={`查看附件 ${item.fileName}`}>
          {urls[item.ref]?<img src={urls[item.ref]!} alt=""/>:<span>原图<br/>不可用</span>}
        </button>
        <div className="mz-tx-attachment-name"><span title={item.fileName}>{item.fileName}</span><small>{!item.available?'文件缺失或路径不可用':urls[item.ref]?'点击查看原图':'原图无法预览'} · {(item.byteLength/1024).toFixed(1)} KB</small></div>
        <button type="button" className="mz-icon-btn" data-testid="ledger-attachment-remove" aria-label={`移除附件 ${item.fileName}`} title="只移除本交易的引用，不删除原图" disabled={busy||deleted} onClick={()=>void remove(item.ref)}>×</button>
      </div>)}
    </div>
    <p className="mz-tx-attachment-boundary" data-testid="ledger-attachment-backup-note">仅在本机管理，不调用或上传给模型。移除只断开这笔交易的引用。数据库快照和口令备份包含引用，不含原图；原图仍是本地文件，换机请另备份 attachments 目录。</p>
    {preview&&current&&urls[preview]&&<div className="mz-image-overlay" role="presentation" onClick={e=>{if(e.target===e.currentTarget)closePreview()}}>
      <div className="mz-image-dialog" ref={dialog} role="dialog" aria-modal="true" aria-label={`附件原图 ${current.fileName}`} data-testid="ledger-attachment-dialog">
        <div className="mz-image-dialog-head"><span>{current.fileName}</span><button type="button" className="mz-btn mz-btn-ghost" onClick={closePreview} aria-label="关闭附件原图">关闭 ×</button></div>
        <img src={urls[preview]!} alt={current.fileName}/>
      </div>
    </div>}
  </section>
}
