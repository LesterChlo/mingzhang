// User-only rule mutations. No model-tool entry. Existing rules/audit/settings storage only.
import { createHash } from 'node:crypto'
import type { Database } from 'better-sqlite3-multiple-ciphers'
import type { CategoryRuleDTO, CategoryRuleSaveResultDTO, SaveCategoryRuleInput, UpdateCategoryRuleInput, DeactivateCategoryRuleInput, RuleVersionDTO, ClassifyPlanGroupDTO } from '../../shared/types'
import { listRules, createRule, updateRuleAction, deactivateRule, normalizeRuleMerchant, type RuleRow } from './rules'
import { getPending } from './pending'
import { getTransaction } from './ledger'
import { CLASSIFY_GATE_FIELD } from './classify'
import { nowIso } from '../db/time'

function atomic<T>(db: Database, fn: () => T): T {
  let result!: T
  db.transaction(() => { result = fn() })()
  return result
}
function positiveId(id: unknown): asserts id is number {
  if (!Number.isSafeInteger(id) || Number(id) <= 0) throw new Error('ID 参数无效')
}
function hash(value: unknown): string { return createHash('sha256').update(JSON.stringify(value)).digest('hex') }
function category(db: Database, id: number, direction: string): {id:number;name:string} {
  positiveId(id)
  const row = db.prepare('SELECT id,name FROM categories WHERE id=? AND kind=?').get(id, direction) as {id:number;name:string}|undefined
  if (!row) throw new Error('分类不存在或收支方向不符')
  return row
}
function ruleDto(db: Database, row: RuleRow): CategoryRuleDTO {
  const revision = db.prepare("SELECT MAX(id) AS id FROM audit_log WHERE entity_type='rule' AND entity_id=? AND changed_by='user'").get(row.id) as {id:number|null}
  const dto: CategoryRuleDTO = {id:row.id,version:hash([row.condition,row.action,row.active,revision.id]),merchant:null,op:null,direction:null,categoryId:null,categoryName:null,active:row.active===1,valid:false,hitCount:row.hit_count}
  try {
    const c = JSON.parse(row.condition); const a = JSON.parse(row.action)
    if (c?.match !== 'merchant' || !['equals','contains'].includes(c.op) || typeof c.value !== 'string' || !normalizeRuleMerchant(c.value) || (c.direction !== undefined && !['expense','income'].includes(c.direction)) || typeof a?.set_category !== 'string') return dto
    dto.merchant=normalizeRuleMerchant(c.value); dto.op=c.op; dto.direction=c.direction ?? null; dto.categoryName=a.set_category.trim()
    const cats = db.prepare('SELECT id FROM categories WHERE name=?' + (dto.direction ? ' AND kind=?' : '')).all(...(dto.direction ? [dto.categoryName,dto.direction] : [dto.categoryName])) as {id:number}[]
    dto.categoryId=cats.length===1 ? cats[0].id : null; dto.valid=cats.length>0
  } catch { /* malformed legacy rows remain visible and can be disabled */ }
  return dto
}
export function listCategoryRules(db: Database): CategoryRuleDTO[] { return listRules(db,{activeOnly:false}).map(r=>ruleDto(db,r)) }
function validateVersions(expected: RuleVersionDTO[]): void {
  if (!Array.isArray(expected) || expected.some(x => !x || !Number.isSafeInteger(x.id) || x.id <= 0 || typeof x.version !== 'string' || !/^[a-f0-9]{64}$/.test(x.version)) || new Set(expected.map(x => x.id)).size !== expected.length) throw new Error('规则版本参数无效')
}
function versions(db:Database, expected:RuleVersionDTO[]): void {
  validateVersions(expected)
  const sort=(v:RuleVersionDTO[])=>v.map(x=>({id:x.id,version:x.version})).sort((a,b)=>a.id-b.id)
  if (JSON.stringify(sort(expected))!==JSON.stringify(sort(listCategoryRules(db).filter(x=>x.active)))) throw new Error('规则版本已变更，请刷新后重新确认')
}
function current(db:Database,id:number,version:string):CategoryRuleDTO {
  positiveId(id)
  const row=listCategoryRules(db).find(r=>r.id===id)
  if (!row || typeof version!=='string' || row.version!==version) throw new Error('规则版本已变更或规则不存在')
  return row
}
function conflicts(db:Database, merchant:string, direction:string, name:string, exclude?:number):CategoryRuleDTO[] {
  return listCategoryRules(db).filter(r=>r.active && r.id!==exclude && (!r.valid || ((!r.direction || r.direction===direction) && (r.op==='equals' ? r.merchant===merchant : merchant.includes(r.merchant!)) && r.categoryName!==name)))
}
function decision(value:unknown): asserts value is boolean { if(typeof value!=='boolean') throw new Error('冲突决策参数无效') }
/** Shared pure-read source guard: recovery and save must agree on eligibility. */
export function isCategoryRuleSourceCurrent(db: Database, classifyId: string, group: ClassifyPlanGroupDTO, categoryId: number): boolean {
  if (!group.merchant || !normalizeRuleMerchant(group.merchant) || !group.txIds.length) return false
  return group.txIds.every(id => {
    const tx = getTransaction(db, id)
    const audit = db.prepare("SELECT source_message_id,change_type FROM audit_log WHERE entity_type='transaction' AND entity_id=? ORDER BY id DESC LIMIT 1").get(id) as {source_message_id:string|null;change_type:string}|undefined
    return !!audit && audit.source_message_id === classifyId && audit.change_type === 'confirm' && !!tx && tx.state === 'confirmed' && tx.category_id === categoryId && tx.type === group.txType && normalizeRuleMerchant(tx.merchant ?? '') === normalizeRuleMerchant(group.merchant!)
  })
}
export function saveCategoryRule(db:Database,input:SaveCategoryRuleInput):CategoryRuleSaveResultDTO {
  if (!input || typeof input.requestId!=='string' || !/^[A-Za-z0-9_-]{1,100}$/.test(input.requestId) || typeof input.groupKey!=='string') throw new Error('保存请求参数无效')
  positiveId(input.gateId); positiveId(input.categoryId); decision(input.replaceConflicts)
  validateVersions(input.expectedRules)
  // A conflict consumes no key; a successful receipt binds all validated parameters.
  const intent=hash([input.gateId,input.groupKey,input.categoryId,input.replaceConflicts,[...input.expectedRules].sort((a,b)=>a.id-b.id).map(({id,version})=>({id,version}))]); const key=`category-rule-receipt:${input.requestId}`
  return atomic(db, ():CategoryRuleSaveResultDTO=>{
    const receipt=db.prepare('SELECT value FROM settings WHERE key=?').get(key) as {value:string}|undefined
    if(receipt){const prior=JSON.parse(receipt.value); if(prior.intent!==intent) throw new Error('请求 ID 已用于不同保存内容'); return prior.result}
    const gate=getPending(db,input.gateId)
    if(!gate || gate.field!==CLASSIFY_GATE_FIELD || gate.status!=='resolved') throw new Error('规则保存来源尚未成功归类')
    const payload=JSON.parse(gate.payload) as {classifyId:string;groups:ClassifyPlanGroupDTO[]}
    const group=payload.groups?.find(g=>g.groupKey===input.groupKey)
    if(!group || !group.merchant || !normalizeRuleMerchant(group.merchant) || !group.txIds.length) throw new Error('规则保存来源无商户或分组无效')
    const cat=category(db,input.categoryId,group.txType)
    if (!isCategoryRuleSourceCurrent(db, payload.classifyId, group, cat.id)) throw new Error('规则保存来源已经变更或分类不符')
    versions(db,input.expectedRules)
    const merchant=normalizeRuleMerchant(group.merchant); const bad=conflicts(db,merchant,group.txType,cat.name)
    if(bad.length && !input.replaceConflicts) return {status:'conflict',rule:null,conflicts:bad}
    if(bad.some(r=>!r.valid)) throw new Error('请先停用损坏规则再保存')
    for(const r of bad) deactivateRule(db,r.id,{reasoning:'用户明确确认替换冲突规则',sourceMessageId:payload.classifyId})
    const same=listCategoryRules(db).find(r=>r.active && r.op==='equals' && r.merchant===merchant && r.direction===group.txType && r.categoryId===cat.id)
    const dormant=listCategoryRules(db).find(r=>!r.active && r.op==='equals' && r.merchant===merchant && r.direction===group.txType)
    if (!same && dormant) {
      updateRuleAction(db,dormant.id,{set_category:cat.name},{reasoning:'用户显式保存并重新启用规则',sourceMessageId:payload.classifyId})
      db.prepare('UPDATE rules SET active=1,updated_at=? WHERE id=?').run(nowIso(),dormant.id)
    }
    const id=same?.id ?? dormant?.id ?? createRule(db,{match:'merchant',op:'equals',value:merchant,direction:group.txType},{set_category:cat.name},{reasoning:'批量归类后用户显式保存',sourceMessageId:payload.classifyId})
    const result:CategoryRuleSaveResultDTO={status:same?'reused':'saved',rule:listCategoryRules(db).find(r=>r.id===id)!,conflicts:[]}
    db.prepare('INSERT INTO settings (key,value,updated_at) VALUES (?,?,?)').run(key,JSON.stringify({intent,result}),nowIso())
    return result
  })
}
export function updateCategoryRule(db:Database,input:UpdateCategoryRuleInput):CategoryRuleSaveResultDTO {
  if(!input) throw new Error('修改参数无效')
  decision(input.replaceConflicts)
  return atomic(db, ():CategoryRuleSaveResultDTO=>{
    const row=current(db,input.ruleId,input.expectedVersion); versions(db,input.expectedRules)
    if(!row.active || !row.valid || !row.direction || !row.merchant) throw new Error('旧无方向或无效规则请停用后重新保存')
    const cat=category(db,input.categoryId,row.direction)
    // Two contains predicates can both match a concatenated merchant, even if neither text contains the other.
    const bad = row.op === 'contains'
      ? listCategoryRules(db).filter(r => r.active && r.id !== row.id && (!r.valid || ((!r.direction || r.direction === row.direction) && (r.op === 'contains' || r.merchant!.includes(row.merchant!)) && r.categoryName !== cat.name)))
      : conflicts(db,row.merchant,row.direction,cat.name,row.id)
    if(bad.length && !input.replaceConflicts) return {status:'conflict',rule:null,conflicts:bad}
    if(bad.some(r=>!r.valid)) throw new Error('请先停用损坏规则')
    for(const r of bad) deactivateRule(db,r.id,{reasoning:'用户明确确认修改并替换冲突规则'})
    if(row.categoryId!==cat.id) updateRuleAction(db,row.id,{set_category:cat.name},{reasoning:'用户在规则管理中修改分类'})
    return {status:'saved',rule:listCategoryRules(db).find(r=>r.id===row.id)!,conflicts:[]}
  })
}
export function deactivateCategoryRule(db:Database,input:DeactivateCategoryRuleInput):CategoryRuleDTO {
  if(!input) throw new Error('停用参数无效')
  return atomic(db, ()=>{ const row=current(db,input.ruleId,input.expectedVersion); if(row.active) deactivateRule(db,row.id); return listCategoryRules(db).find(r=>r.id===row.id)! })
}
