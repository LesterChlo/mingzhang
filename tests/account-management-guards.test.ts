import { describe, expect, it } from 'vitest'
import { openSchemaDb } from './helpers'
import { seed } from '../src/main/db/seed'
import { createAccount } from '../src/main/domain/accounts'

function fixture() {
  const db = openSchemaDb(':memory:')
  seed(db)
  return db
}
function state(db: ReturnType<typeof fixture>) {
  return ['accounts', 'categories', 'transactions', 'rules', 'audit_log', 'settings', 'sqlite_sequence']
    .map(table => db.prepare(`SELECT * FROM ${table}`).all())
}

describe('账户新增参数守卫', () => {
  it('名称 trim 后落库，审计记录同一规范名称', () => {
    const db = fixture()
    try {
      const id = createAccount(db, { name: '  合成新卡  ', type: 'bank' })
      expect(db.prepare('SELECT name,type,currency FROM accounts WHERE id=?').get(id))
        .toEqual({ name: '合成新卡', type: 'bank', currency: 'CNY' })
      const audit = db.prepare("SELECT after_value FROM audit_log WHERE entity_type='account' AND entity_id=?").get(id) as { after_value: string }
      expect(JSON.parse(audit.after_value)).toEqual({ name: '合成新卡', type: 'bank' })
    } finally { db.close() }
  })
  it.each(['', '   ', '合成\n卡', '\t合成卡', '合成\u007f卡', '合成\u0085卡', '名'.repeat(101)])('拒绝非法名称 %# 且全库不变', name => {
    const db = fixture()
    try {
      const before = state(db)
      expect(() => createAccount(db, { name, type: 'cash' })).toThrow()
      expect(state(db)).toEqual(before)
    } finally { db.close() }
  })
  it.each([null, [], {}, { name: 42, type: 'cash' }, { name: '合成', type: 'credit' }, { name: '合成', type: null }])('运行时拒绝非法创建输入 %#', input => {
    const db = fixture()
    try {
      const before = state(db)
      expect(() => createAccount(db, input as never)).toThrow()
      expect(state(db)).toEqual(before)
    } finally { db.close() }
  })
  it('trim 后重名拒绝且不写审计或序列', () => {
    const db = fixture()
    try {
      const before = state(db)
      expect(() => createAccount(db, { name: ' 现金 ', type: 'cash' })).toThrow(/已存在/)
      expect(state(db)).toEqual(before)
    } finally { db.close() }
  })
})
