// 常识分类兜底（本地静态表，不联网、断网设计不变）。
// 顺序：模型显式分类 ＞ 用户规则 ＞ 常识表 ＞ 再缺才转待确认。
// 命中常识表的交易直接 autoConfirm（置信 0.75，reason=常识分类）；
// 用户觉得错了去账本改——前期大量导入时流畅优先。
// 映射全部是 expense；income 不走常识表。
// T0923-0017 模糊策略：Agent 先定清的再导入——159 行实测缺口里确定的进表；
// 不确定的故意不进表（个人名/财政缴费/邮政到付等）→ 转待确认交用户定夺。
// 个人名永不进代码表（隐私）；用户改一次即学 merchant-contains 规则，
// 后续同商户按历史自动（用户规则优先于常识）或再问用户。

import type { Database } from 'better-sqlite3-multiple-ciphers'
import { getOrCreateCategoryId } from './ledger'
import { applyRules, resolveRuleMatch } from './rules'

/** 商户关键词（含即命中，大小写不敏感）→ 分类名。 */
const BUILTIN: { keys: string[]; category: string }[] = [
  { keys: ['拼多多', '京东', '淘宝', '天猫', '抖音', '闲鱼', '咸鱼', '唯品会', '苏宁', '当当', '得物', '小红书'], category: '购物' },
  // T0923-0017 补：便利（天天/乐淘便利变体）、赵一鸣/零食（零食连锁归餐饮，与便利店一致）
  { keys: ['蜜雪', '麦当劳', '肯德基', '星巴克', '瑞幸', '便利店', '便利', '赵一鸣', '零食', '全家', '罗森', '美宜佳', '美团', '饿了么', '海底捞', '奶茶', '咖啡', '饭店', '餐厅', '小吃', '面馆', '快餐', '食堂', '外卖'], category: '餐饮' },
  { keys: ['医院', '药店', '药房', '挂号', '诊所', '体检', '牙科'], category: '医疗' },
  // T0923-0017 补：鸿易博/先乘后付（出行代扣归交通）
  { keys: ['单车', '停车', '加油', '地铁', '公交', '打车', '滴滴', '高铁', '火车票', '机票', '高速', '充电', '鸿易博', '先乘后付'], category: '交通' },
  // T0923-0017 补：网咖（网吧一字之差）、猫眼（电影票）、打赏/直播（娱乐）
  { keys: ['steam', '鹰角', '米哈游', '腾讯视频', '爱奇艺', '电影', '影院', 'ktv', '网吧', '网咖', '猫眼', '打赏', '直播', '游戏', '剧本杀', '密室'], category: '娱乐' },
  // T0923-0017 补：深度求索/deepseek/api（API 消费归订阅，数字服务）
  { keys: ['apple', 'icloud', '会员', '订阅', '网盘', 'wps', '深度求索', 'deepseek', 'api'], category: '订阅' },
  { keys: ['物业', '水电', '燃气', '话费', '宽带', '房租'], category: '居住' },
  { keys: ['学校', '学费', '培训', '课程', '书店', '文具'], category: '教育' },
]

/** 常识表命中 → 分类名；未命中 → null。income 永不命中（表内全是 expense）。 */
export function matchBuiltinCategory(merchant: string | null, kind: 'expense' | 'income' = 'expense'): string | null {
  if (kind !== 'expense') return null
  const m = (merchant ?? '').trim().toLowerCase()
  if (!m) return null
  for (const group of BUILTIN) {
    if (group.keys.some((k) => m.includes(k.toLowerCase()))) return group.category
  }
  return null
}

export interface MerchantClassification {
  categoryId: number | null
  ruleHit: { ruleId: number; categoryName: string } | null
  /** 常识表命中的分类名（规则命中时为 null——用户规则优先于常识）。 */
  builtinName: string | null
}

/**
 * 按"用户规则 ＞ 常识表"顺序给商户定分类（调用方保证：模型显式分类已优先处理）。
 * 返回 categoryId + 命中来源；都没命中则 categoryId=null（调用方转待确认）。
 */
export function classifyByMerchant(
  db: Database,
  input: {
    merchant: string | null
    kind: 'expense' | 'income'
    txId?: number | null
    sourceMessageId?: string | null
    changedBy?: 'user' | 'llm' | 'rule_engine'
  },
): MerchantClassification {
  const empty: MerchantClassification = { categoryId: null, ruleHit: null, builtinName: null }
  if (input.kind !== 'expense' && input.kind !== 'income') return empty
  const resolution = resolveRuleMatch(db, input.merchant, input.kind)
  if (resolution.status === 'conflict' || resolution.status === 'invalid') return empty
  const hit = applyRules(db, {
    merchant: input.merchant,
    kind: input.kind,
    txId: input.txId ?? null,
    sourceMessageId: input.sourceMessageId ?? null,
  })
  if (hit.categoryId && hit.ruleId) {
    const rule = db.prepare('SELECT action FROM rules WHERE id=?').get(hit.ruleId) as { action: string }
    const catName = (JSON.parse(rule.action) as { set_category: string }).set_category
    return { categoryId: hit.categoryId, ruleHit: { ruleId: hit.ruleId, categoryName: catName }, builtinName: null }
  }
  const builtin = matchBuiltinCategory(input.merchant, input.kind)
  if (!builtin) return empty
  const categoryId = getOrCreateCategoryId(db, builtin, input.kind, {
    sourceMessageId: input.sourceMessageId ?? null,
    changedBy: input.changedBy ?? 'llm',
  })
  return { categoryId, ruleHit: null, builtinName: builtin }
}

/** 常识命中的置信度（记 reason=常识分类）。 */
export const BUILTIN_CONFIDENCE = 0.75
