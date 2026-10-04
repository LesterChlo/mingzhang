import { expect, it } from 'vitest'
import { openSchemaDb } from './helpers'
import { seed } from '../src/main/db/seed'
import { createTransaction, requestReview, updateFields } from '../src/main/domain/ledger'
import { prepareClassify, applyClassify } from '../src/main/domain/classify'
import { createRule, bumpHit } from '../src/main/domain/rules'
import { updateCategoryRule, deactivateCategoryRule } from '../src/main/domain/category-rules'
import { saveCategoryRule, listCategoryRules } from '../src/main/domain/category-rules'

function fixture() {
  const db = openSchemaDb(':memory:'); seed(db)
  const tx = createTransaction(db, { amountCents: 100, txType: 'expense', merchant: '合成严格保存' })
  requestReview(db, tx, { reason: 'synthetic' })
  const gate = prepareClassify(db, { sessionId: 'ui', assignments: [{ groupKey: 'expense::合成严格保存', categoryName: '餐饮' }] })
  applyClassify(db, gate.gateId)
  const categoryId = (db.prepare("SELECT id FROM categories WHERE name='餐饮' AND kind='expense'").get() as { id: number }).id
  return { db, tx, input: { requestId: 'strict-save', gateId: gate.gateId, groupKey: 'expense::合成严格保存', categoryId, expectedRules: [], replaceConflicts: false } }
}
it('成功回执绑定完整请求，改变冲突决策或版本快照不得复用幂等键', () => {
  const { db, input } = fixture()
  try {
    const saved = saveCategoryRule(db, input)
    const auditCount = (db.prepare('SELECT COUNT(*) n FROM audit_log').get() as { n: number }).n
    expect(saveCategoryRule(db, input)).toEqual(saved)
    expect(() => saveCategoryRule(db, { ...input, replaceConflicts: true })).toThrow(/请求/)
    expect(() => saveCategoryRule(db, { ...input, expectedRules: listCategoryRules(db).map(({ id, version }) => ({ id, version })) })).toThrow(/请求/)
    expect((db.prepare('SELECT COUNT(*) n FROM audit_log').get() as { n: number }).n).toBe(auditCount)
  } finally { db.close() }
})
it('交易后来改过再改回也不能作为旧确认门的规则保存来源', () => {
  const { db, tx, input } = fixture()
  try {
    updateFields(db, tx, { merchant: '合成后来修改' })
    updateFields(db, tx, { merchant: '合成严格保存' })
    expect(() => saveCategoryRule(db, input)).toThrow(/来源/)
    expect(listCategoryRules(db)).toEqual([])
  } finally { db.close() }
})
it('命中计数不使编辑版本过期，用户修改再改回使旧版本过期', () => {
  const { db, input } = fixture()
  try {
    const saved=saveCategoryRule(db,input).rule!
    bumpHit(db,saved.id)
    expect(listCategoryRules(db)[0].version).toBe(saved.version)
    const coffee=(db.prepare("SELECT id FROM categories WHERE name='咖啡' AND kind='expense'").get() as {id:number}).id
    const changed=updateCategoryRule(db,{ruleId:saved.id,expectedVersion:saved.version,categoryId:coffee,expectedRules:[saved],replaceConflicts:false}).rule!
    updateCategoryRule(db,{ruleId:saved.id,expectedVersion:changed.version,categoryId:input.categoryId,expectedRules:[changed],replaceConflicts:false})
    expect(()=>deactivateCategoryRule(db,{ruleId:saved.id,expectedVersion:saved.version})).toThrow(/版本/)
  } finally {db.close()}
})
it('过期全量规则快照拒绝保存，替换发生错误时停用与审计全回滚', () => {
  const { db, input }=fixture()
  try {
    createRule(db,{match:'merchant',op:'contains',value:'合成'},{set_category:'咖啡'})
    expect(()=>saveCategoryRule(db,input)).toThrow(/版本/)
    const rows=listCategoryRules(db)
    const request={...input,expectedRules:rows.map(({id,version})=>({id,version})),replaceConflicts:true}
    const before=db.prepare('SELECT COUNT(*) n FROM audit_log').get()
    db.exec("CREATE TRIGGER synthetic_fail_receipt BEFORE INSERT ON settings WHEN NEW.key LIKE 'category-rule-receipt:%' BEGIN SELECT RAISE(ABORT,'synthetic-fail'); END")
    expect(()=>saveCategoryRule(db,request)).toThrow(/synthetic-fail/)
    expect(listCategoryRules(db)).toEqual(rows)
    expect(db.prepare('SELECT COUNT(*) n FROM audit_log').get()).toEqual(before)
  } finally {db.close()}
})
it('已有回执仍严格验证请求形状，不把缺少版本数组视为合法重试', () => {
  const { db, input } = fixture()
  try {
    saveCategoryRule(db, input)
    expect(() => saveCategoryRule(db, { ...input, expectedRules: null as never })).toThrow(/参数/)
  } finally { db.close() }
})
