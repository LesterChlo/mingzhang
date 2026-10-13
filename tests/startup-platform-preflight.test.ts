// Platform identity preflight, no filesystem writes; production helper remains real.
import { afterEach, describe, expect, it, vi } from 'vitest'
import { dirname, join } from 'node:path'
const state = vi.hoisted(() => ({ dir: '', names: [] as string[] }))
vi.mock('node:fs', async () => ({
  ...await vi.importActual<any>('node:fs'),
  existsSync: (file: string) => file === state.dir,
  readdirSync: () => state.names,
}))
import { readStartupDek } from '../src/main/db/connection'
const realPlatform = Object.getOwnPropertyDescriptor(process, 'platform')!
afterEach(() => { Object.defineProperty(process, 'platform', realPlatform) })
function check(platform: string, name: string) {
  Object.defineProperty(process, 'platform', { ...realPlatform, value: platform })
  const file = join('synthetic-only', 'mingzhang.db'); state.dir = dirname(file); state.names = [name]
  return () => readStartupDek(file, { get: () => null, has: () => false, set: () => { throw Error('unexpected set') } } as never)
}
describe('startup evidence matching follows filesystem identity', () => {
  it.each(['MINGZHANG.DB.restore-journal.json', 'mingzhang.db.RESTORE-ROLLBACK', 'MiNgZhAnG.Db.ReStOrE-candidate-1'])
    ('Windows missing DEK rejects %s before recovery', name => {
      expect(check('win32', name)).toThrow(/密钥|恢复/)
    })
  it('case-sensitive platform preserves exact-name evidence detection', () => {
    expect(check('linux', 'mingzhang.db.restore-journal.json')).toThrow(/密钥|恢复/)
    expect(check('linux', 'MINGZHANG.DB.restore-journal.json')()).toBeNull()
  })
  it('unrelated Windows filename does not become a recovery artifact', () => {
    expect(check('win32', 'OTHER.DB.restore-journal.json')()).toBeNull()
  })
})
