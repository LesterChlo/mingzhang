import { afterEach, expect, it } from 'vitest'
import { openSchemaDb } from './helpers'
import { seed } from '../src/main/db/seed'
import { createRule, matchRule, applyRules, resolveRuleMatch } from '../src/main/domain/rules'
import { classifyByMerchant } from '../src/main/domain/builtin-categories'
const db = openSchemaDb(':memory:')
seed(db)
afterEach(() => db.exec('DELETE FROM rules'))
it('不同分类多命中是可见冲突，导入兜底不得覆盖冲突', () => {
  createRule(db, { match: 'merchant', op: 'contains', value: '星巴克' }, { set_category: '咖啡' })
  createRule(db, { match: 'merchant', op: 'equals', value: '星巴克' }, { set_category: '餐饮' })
  expect(resolveRuleMatch(db, '星巴克', 'expense').status).toBe('conflict')
  expect(matchRule(db, '星巴克', 'expense')).toBeNull()
  expect(classifyByMerchant(db, { merchant: '星巴克', kind: 'expense' }).categoryId).toBeNull()
  expect(db.prepare('SELECT hit_count FROM rules').all()).toEqual([{ hit_count: 0 }, { hit_count: 0 }])
})
it('同分类多命中保留确定来源，旧 contains 兼容且建议读取不写业务表', () => {
  const first=createRule(db, { match: 'merchant', op: 'contains', value: '合成' }, { set_category: '餐饮' })
  const second=createRule(db, { match: 'merchant', op: 'equals', value: '合成 多命中', direction: 'expense' }, { set_category: '餐饮' })
  const before=db.prepare('SELECT COUNT(*) n FROM audit_log').get()
  const result=resolveRuleMatch(db, ' 合成　多命中 ', 'expense')
  expect(result.status).toBe('matched')
  expect(result.ruleIds).toEqual([second,first])
  expect(result.rule?.id).toBe(second)
  expect(resolveRuleMatch(db,'其他合成分店','expense').rule?.id).toBe(first)
  expect(db.prepare('SELECT COUNT(*) n FROM audit_log').get()).toEqual(before)
  expect(db.prepare('SELECT hit_count FROM rules').all()).toEqual([{hit_count:0},{hit_count:0}])
})
it('精确规则隔离收支方向且仅归一空白', () => {
  createRule(db, { match: 'merchant', op: 'equals', value: ' 合成　商户 ', direction: 'expense' }, { set_category: '餐饮' })
  expect(matchRule(db, '合成 商户', 'expense')).not.toBeNull()
  expect(matchRule(db, '合成 商户', 'income')).toBeNull()
  expect(matchRule(db, '合成 商户分店', 'expense')).toBeNull()
})
