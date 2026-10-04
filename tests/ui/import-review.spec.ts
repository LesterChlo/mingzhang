// Real Electron / preload / IPC / encrypted isolated file ledger. No window.mz replacement.
// Model stage uses the shipped offline deterministic provider; bill parsing and all writes are real.
import { test, expect, _electron, type ElectronApplication, type Page } from '@playwright/test'
import { mkdirSync, mkdtempSync, writeFileSync, appendFileSync } from 'node:fs'
import { resolve, join } from 'node:path'

const evidence = resolve('.scratch/import-review')
mkdirSync(evidence, { recursive: true })
const merchant = '合成紫岚甲'
const second = '合成紫岚乙'
const csv = [
  '交易时间,交易类型,交易对方,商品,收/支,金额(元),支付方式,当前状态,交易单号,商户单号,备注',
  `2026-10-01 09:00:00,商户消费,${merchant},合成样本甲,支出,11.11,零钱,支付成功,SYN-IR-001,M1,`,
  `2026-10-01 10:00:00,商户消费,${merchant},合成样本乙,支出,22.22,零钱,支付成功,SYN-IR-002,M2,`,
  `2026-10-01 11:00:00,商户消费,${second},合成样本丙,支出,33.33,零钱,支付成功,SYN-IR-003,M3,`,
].join('\n')

async function launch(data: string, profile: string, log: string) {
  const env = { ...process.env, MZ_DATA_DIR: data }
  delete env.ELECTRON_RUN_AS_NODE
  const app = await _electron.launch({ args: ['.', `--user-data-dir=${profile}`], env: env as Record<string,string> })
  app.process().stdout?.on('data', b => appendFileSync(log, b))
  app.process().stderr?.on('data', b => appendFileSync(log, b))
  const page = await app.firstWindow()
  const errors: string[] = []
  page.on('pageerror', e => { errors.push(String(e)); appendFileSync(log, `PAGEERROR ${e}\n`) })
  await page.waitForSelector('.mz-shell')
  expect(await page.getByTestId('lock-badge').getAttribute('data-datadir')).toBe(data)
  expect(await app.evaluate(({ app }) => app.getPath('userData'))).toBe(profile)
  return { app, page, errors }
}
async function fixture(name: string) {
  const dir = mkdtempSync(join(evidence, `e2e-${name}-`))
  const data = join(dir, 'data'), profile = join(dir, 'profile'), log = join(dir, 'electron.log')
  mkdirSync(data); mkdirSync(profile)
  writeFileSync(log, `ISOLATED data=${data} profile=${profile}\n`)
  return { dir, data, profile, log, ...await launch(data, profile, log) }
}
async function importBill(page: Page) {
  await page.evaluate(async () => {
    await window.mz.setMock(true)
    for (let i = 0; i < 40; i++) {
      try { await window.mz.sendChat('待收尾', []); return } catch { await new Promise(r => setTimeout(r, 250)) }
    }
    throw new Error('Offline engine unavailable')
  })
  await page.evaluate(text => {
    const dt = new DataTransfer()
    dt.items.add(new File([text], '微信-全合成分类复核.csv', { type: 'text/csv' }))
    const target = document.querySelector('[data-testid="capture-bar"]')!
    for (const type of ['dragover','drop']) target.dispatchEvent(new DragEvent(type, { bubbles: true, cancelable: true, dataTransfer: dt }))
  }, csv)
  await expect(page.getByTestId('capture-bill')).toHaveCount(1)
  const capture = page.getByLabel('速记行')
  await capture.fill('把这张合成账单记一下'); await capture.press('Enter')
  const gate = page.locator('[data-testid="inbox-card"][data-kind="batch_confirm"]')
  await expect(gate).toBeVisible({ timeout: 30000 })
  await gate.getByTestId('inbox-confirm').click()
  await expect(gate).toHaveCount(0)
  const summary = await page.evaluate(() => window.mz.getBatchResult())
  expect(summary).not.toBeNull()
  expect(summary!.counts.needsCategory).toBe(3)
  const proposal = await page.evaluate(id => window.mz.getClassifyProposal(id), summary!.batchId)
  expect(proposal.groups).toHaveLength(2)
  expect(proposal.groups.find(g => g.merchant === merchant)!.count).toBe(2)
  expect(await page.evaluate(() => window.mz.listCategoryRules())).toEqual([])
  await page.getByTestId('open-import-review').click()
  await expect(page.getByTestId('import-review-workspace')).toBeVisible()
  console.log('IMPORT', JSON.stringify(summary), JSON.stringify(proposal))
  return { summary: summary!, proposal }
}
async function select(page: Page, name = merchant, category = '餐饮') {
  if (await page.getByTestId('review-complete').count()) await page.getByRole('button', {name:'继续检查剩余记录',exact:true}).click()
  await page.getByLabel(`选择 ${name}`, { exact: true }).check()
  await page.getByLabel(`${name}分类`, { exact: true }).selectOption(category)
}

// New UX transitions; only selectors/navigation change, ledger assertions below stay intact.
async function confirmAndExpand(page: Page) {
  await page.getByRole('button',{name:/^确认所选 \d+ 笔$/}).click()
  await expect.poll(async () => (await page.getByTestId('review-complete').count()) > 0 || (await page.getByRole('alert').count()) > 0).toBe(true)
  if (await page.getByTestId('review-complete').count()) {
    await page.getByRole('button',{name:'选择要记住的商户',exact:true}).click()
  }
}
async function openManager(page: Page) {
  await page.getByTestId('nav-settings').click()
  await page.getByTestId('settings-category-rules').click()
  await expect(page.getByTestId('category-rules-manager')).toBeVisible()
}
async function returnToReview(page: Page, withResults = false) {
  await page.getByRole('button',{name:'返回设置',exact:true}).click()
  await page.getByTestId('nav-inbox').click()
  await page.getByTestId('open-import-review').click()
  if (withResults) await showRecoveredResult(page)
}

async function ledger(page: Page) { return (await page.evaluate(() => window.mz.listLedger({}))).items }
async function save(page: Page, name = merchant) {
  const section = page.getByTestId('save-reviewed-rules').filter({ hasText: `${name} →` })
  await expect(section).toBeVisible()
  await section.getByRole('button', { name: '保存这条规则', exact: true }).click()
  await expect(section.getByRole('button', { name: '已保存', exact: true })).toBeDisabled()
  return (await page.evaluate(() => window.mz.listCategoryRules()))[0]
}

test('真实批次 → 展开逐笔排除 → 分类确认 → 独立规则保存 → 管理停用 → 重启持久化', async () => {
  const f = await fixture('journey')
  let app: ElectronApplication = f.app
  try {
    const { page } = f
    const { summary, proposal } = await importBill(page)
    const group = proposal.groups.find(g => g.merchant === merchant)!
    await select(page)
    const block = page.locator('.mz-review-row').filter({ hasText: merchant }).locator('..')
    await block.locator('summary').click()
    await expect(page.getByLabel(`包含交易${group.details[1].txId}`, { exact: true })).toBeVisible()
    await page.getByLabel(`包含交易${group.details[1].txId}`, { exact: true }).uncheck()
    await expect(page.getByTestId('import-review-workspace')).toContainText('已选 1 笔')
    for (const theme of ['dark','light']) {
      if (await page.locator('html').getAttribute('data-theme') !== theme) await page.getByTestId('theme-toggle').click()
      await expect(page.locator('html')).toHaveAttribute('data-theme',theme)
      await page.screenshot({ path: join(evidence,`import-review-${theme}.png`) })
    }
    const geometry = await page.evaluate(() => {
      const row = [...document.querySelectorAll('.mz-review-row')].find(e => e.textContent?.includes('合成紫岚甲'))!
      const box = (e: Element) => { const r=e.getBoundingClientRect(); return {x:r.x,y:r.y,width:r.width,height:r.height} }
      return { merchant:box(row.querySelector('.mz-review-merchant')!), groupCheckbox:box(row.querySelector('input')!), detailCheckboxes:[...document.querySelectorAll('details input')].map(box), viewport:{width:innerWidth,height:innerHeight}, documentHeight:document.documentElement.scrollHeight }
    })
    console.log('GEOMETRY',JSON.stringify(geometry))
    writeFileSync(join(evidence,'e2e-geometry.json'),JSON.stringify(geometry,null,2))
    const before = await ledger(page)
    expect(before.every(t => t.state === 'needs_review' && t.categoryName === null)).toBe(true)
    await confirmAndExpand(page)
    await expect(page.getByTestId('save-reviewed-rules')).toBeVisible()
    const after = await ledger(page)
    expect(after.find(t=>t.id===group.details[0].txId)).toMatchObject({ state:'confirmed',categoryName:'餐饮',amountCents:1111 })
    expect(after.find(t=>t.id===group.details[1].txId)).toMatchObject({ state:'needs_review',categoryName:null,amountCents:2222 })
    expect(after.find(t=>t.merchant===second)).toMatchObject({ state:'needs_review',categoryName:null,amountCents:3333 })
    expect(after.map(t=>[t.id,t.amountCents]).sort()).toEqual(before.map(t=>[t.id,t.amountCents]).sort())
    expect((await page.evaluate(()=>window.mz.getBatchResult()))!.counts.needsCategory).toBe(2)
    expect(await page.evaluate(()=>window.mz.listCategoryRules())).toEqual([])
    const rule = await save(page)
    expect(rule).toMatchObject({merchant,op:'equals',direction:'expense',categoryName:'餐饮',active:true,valid:true})
    const suggested = await page.evaluate(id=>window.mz.getClassifyProposal(id),summary.batchId)
    expect(suggested.groups.find(g=>g.merchant===merchant)).toMatchObject({suggestedCategory:'餐饮',suggestionSource:'rule'})
    await openManager(page)
    await expect(page.getByTestId('category-rules-manager')).toContainText('生效中')
    await page.getByRole('button',{name:'停用规则',exact:true}).click()
    await expect(page.getByTestId('category-rules-manager')).toContainText('已停用')
    expect((await page.evaluate(()=>window.mz.listCategoryRules()))[0].active).toBe(false)
    expect(await ledger(page)).toEqual(after)
    console.log('JOURNEY_READBACK',JSON.stringify({after,rule}))
    expect(f.errors).toEqual([])
    await app.close()
    const restarted = await launch(f.data,f.profile,f.log); app = restarted.app
    expect(await ledger(restarted.page)).toEqual(after)
    expect((await restarted.page.evaluate(()=>window.mz.listCategoryRules()))[0]).toMatchObject({id:rule.id,active:false})
    const again = await restarted.page.evaluate(id=>window.mz.getClassifyProposal(id),summary.batchId)
    expect(again.groups.find(g=>g.merchant===merchant)).toMatchObject({suggestedCategory:null,ruleStatus:'none'})
    await restarted.page.getByTestId('open-import-review').click()
    await expect(restarted.page.getByTestId('import-review-workspace')).toContainText('2 笔')
    await openManager(restarted.page)
    await expect(restarted.page.getByTestId('category-rules-manager')).toContainText('已停用')
    expect(restarted.errors).toEqual([])
    console.log('RESTART_VERIFIED',f.dir)
    expect.soft(geometry.merchant.width, '生产布局缺陷：商户列被压到逐字换行').toBeGreaterThanOrEqual(80)
    expect.soft(geometry.detailCheckboxes[0].width, '生产布局缺陷：明细checkbox被全局input样式拉宽').toBeLessThanOrEqual(24)
  } finally { await app.close() }
})

test('失败态：未选分类与错误方向不能记成功，真实后端拒绝过期组内选择', async () => {
  const f = await fixture('stale')
  try {
    const {page}=f
    const {proposal}=await importBill(page)
    const group=proposal.groups.find(g=>g.merchant===merchant)!
    await page.getByLabel(`选择 ${merchant}`,{exact:true}).check()
    await confirmAndExpand(page)
    await expect(page.getByRole('alert')).toContainText('请为选中商户指定分类')
    const income=(await page.evaluate(()=>window.mz.listCategories())).find(c=>c.kind==='income')!
    await page.getByLabel(`${merchant}分类`,{exact:true}).selectOption(income.name)
    await confirmAndExpand(page)
    await expect(page.getByRole('alert')).toContainText('与交易方向不符')
    expect((await ledger(page)).every(t=>t.categoryName===null)).toBe(true)
    // Concurrent real user mutation invalidates the renderer's txIds. No IPC interception.
    await page.evaluate(id=>window.mz.confirmRecord(id,'餐饮'),group.details[0].txId)
    await page.getByLabel(`${merchant}分类`,{exact:true}).selectOption('餐饮')
    await confirmAndExpand(page)
    await expect(page.getByRole('alert')).toBeVisible()
    await expect(page.getByTestId('save-reviewed-rules')).toHaveCount(0)
    expect((await ledger(page)).find(t=>t.id===group.details[1].txId)).toMatchObject({state:'needs_review',categoryName:null})
    expect(await page.evaluate(()=>window.mz.listCategoryRules())).toEqual([])
    console.log('STALE_REAL_IPC_ERROR',await page.getByRole('alert').innerText())
    expect.soft(await page.getByRole('alert').innerText(), '生产缺陷：用户错误文案不应泄露IPC包装').not.toContain('Error invoking remote method')
    expect(f.errors).toEqual([])
  } finally { await f.app.close() }
})

test('失败态：规则保存来源过期、重新准备、规则管理版本过期均不假报成功', async () => {
  const f=await fixture('save-errors')
  try {
    const {page}=f
    const {proposal}=await importBill(page)
    await select(page)
    await confirmAndExpand(page)
    await expect(page.getByTestId('save-reviewed-rules')).toBeVisible()
    const tx=proposal.groups.find(g=>g.merchant===merchant)!.details[0].txId
    const edit = await page.evaluate(id=>window.mz.editTx(id,{op:'set',fields:{categoryName:'购物'}}),tx)
    expect(edit.status).toBe('ok')
    const section=page.getByTestId('save-reviewed-rules')
    await section.getByRole('button',{name:'保存这条规则',exact:true}).click()
    await expect(section.getByRole('button',{name:'重新准备',exact:true})).toBeVisible()
    await expect(section.getByRole('button',{name:'已保存',exact:true})).toHaveCount(0)
    expect(await page.evaluate(()=>window.mz.listCategoryRules())).toEqual([])
    console.log('SAVE_SOURCE_ERROR',await section.innerText())
    await section.getByRole('button',{name:'重新准备',exact:true}).click()
    await expect(section).toContainText('已清除旧请求')
    await section.getByRole('button',{name:'保存这条规则',exact:true}).click()
    expect(await page.evaluate(()=>window.mz.listCategoryRules())).toEqual([])
    // A distinct still-pending merchant provides a valid save provenance for stale management.
    await closeReview(page)
    await page.getByTestId('open-import-review').click()
    await select(page,second)
    await confirmAndExpand(page)
    const rule=await save(page,second)
    await openManager(page)
    await expect(page.getByTestId('category-rules-manager')).toContainText('生效中')
    await page.evaluate(r=>window.mz.deactivateCategoryRule({ruleId:r.id,expectedVersion:r.version}),rule)
    await page.getByRole('button',{name:'停用规则',exact:true}).click()
    await expect(page.getByRole('alert')).toContainText('规则版本已变更')
    console.log('MANAGER_VERSION_ERROR',await page.getByRole('alert').innerText())
    expect((await page.evaluate(()=>window.mz.listCategoryRules()))[0].active).toBe(false)
    expect(f.errors).toEqual([])
  } finally { await f.app.close() }
})


async function closeReview(page: Page) {
  if (await page.getByTestId('review-complete').count()) await page.getByRole('button', {name:'返回这批账单',exact:true}).click()
  else {
    const accept = (dialog: import('@playwright/test').Dialog) => void dialog.accept()
    page.once('dialog', accept)
    await page.getByLabel('关闭分类复核', { exact: true }).click()
    page.off('dialog', accept)
  }
  await expect(page.getByTestId('import-review-workspace')).toHaveCount(0)
}
async function showRecoveredResult(page: Page) {
  await page.getByRole('button',{name:'查看已确认结果 / 撤销',exact:true}).click()
  await expect(page.getByTestId('review-complete')).toBeVisible()
  await expect(page.getByTestId('save-reviewed-rules')).toHaveCount(0)
  await page.getByRole('button',{name:'选择要记住的商户',exact:true}).click()
  await page.getByText('本次结果与撤销',{exact:true}).click()
}

async function assertRecovered(page: Page, batchId: string, candidateCount: number, undoCount: number) {
  if (!(await page.getByTestId('review-complete').count())) await showRecoveredResult(page)
  const recovered = await page.evaluate(id => window.mz.getClassifyResults(id), batchId)
  expect(recovered.flatMap(r => r.candidates)).toHaveLength(candidateCount)
  expect(recovered.reduce((n,r) => n + r.undo.revertibleCount,0)).toBe(undoCount)
  expect(await page.evaluate(() => window.mz.listCategoryRules())).toEqual([])
  await expect(page.getByTestId('save-reviewed-rules').filter({hasText: `${merchant} →`})).toHaveCount(1)
  await expect(page.getByTestId('save-reviewed-rules').filter({hasText: `${second} →`})).toHaveCount(1)
  if (!(await page.locator('[data-testid="review-complete"] > details').getAttribute('open') !== null)) await page.getByText('本次结果与撤销',{exact:true}).click()
  await expect(page.getByRole('button',{name:/^撤销这次分类/})).toHaveCount(2)
  console.log('RECOVERY_READBACK',JSON.stringify(recovered))
  return recovered
}

test('B1/B2/B3：分批候选累积、关闭重开和重启恢复、清零管理可达、撤销保留规则', async () => {
  const f=await fixture('recovery-final'); let app=f.app
  try {
    let page=f.page
    const {summary,proposal}=await importBill(page)
    await select(page)
    await confirmAndExpand(page)
    await expect(page.getByTestId('save-reviewed-rules')).toContainText(`${merchant} → 餐饮`)
    expect((await page.evaluate(id=>window.mz.getClassifyResults(id),summary.batchId))[0].appliedCount).toBe(2)
    await select(page,second,'购物')
    await confirmAndExpand(page)
    await expect(page.getByTestId('save-reviewed-rules')).toHaveCount(2)
    const recovered=await assertRecovered(page,summary.batchId,2,3)
    expect(recovered.map(r=>r.gateId)).toEqual([...recovered.map(r=>r.gateId)].sort((a,b)=>b-a))
    expect(recovered.map(r=>r.appliedCount).sort()).toEqual([1,2])
    await expect(page.getByTestId('review-complete')).toContainText('这批账处理好了')
    expect((await page.evaluate(()=>window.mz.getBatchResult()))!.counts.needsCategory).toBe(0)
    const confirmed=await ledger(page)
    expect(confirmed).toHaveLength(3)
    expect(confirmed.every(t=>t.state==='confirmed')).toBe(true)
    await closeReview(page)
    await expect(page.getByTestId('open-import-review')).toBeVisible()
    await page.getByTestId('open-import-review').click()
    await assertRecovered(page,summary.batchId,2,3)
    expect(await ledger(page)).toEqual(confirmed)
    await closeReview(page)
    await app.close()
    const restarted=await launch(f.data,f.profile,f.log); app=restarted.app; page=restarted.page
    await expect(page.getByTestId('open-import-review')).toBeVisible()
    await page.getByTestId('open-import-review').click()
    await assertRecovered(page,summary.batchId,2,3)
    expect(await ledger(page)).toEqual(confirmed)
    const rule=await save(page,merchant)
    expect(rule).toMatchObject({merchant,categoryName:'餐饮',active:true})
    const savedRecovery=await page.evaluate(id=>window.mz.getClassifyResults(id),summary.batchId)
    expect(savedRecovery.flatMap(r=>r.candidates).map(c=>c.merchant)).toEqual([second])
    await openManager(page)
    await expect(page.getByTestId('category-rules-manager')).toContainText(merchant)
    await returnToReview(page,true)
    const firstGate=savedRecovery.find(r=>r.appliedCount===2)!
    // Locate undo by its gate's uniquely recovered merchant candidate before save, then by chronology readback.
    const buttons=page.getByRole('button',{name:/^撤销这次分类/})
    await expect(buttons).toHaveCount(2)
    const idx=savedRecovery.findIndex(r=>r.classifyId===firstGate.classifyId)
    let undoMessage=''
    page.once('dialog', dialog => { undoMessage=dialog.message(); void dialog.accept() })
    await buttons.nth(idx).click()
    await expect.poll(()=>undoMessage).toContain('独立保存的规则仍保留')
    expect(undoMessage).toContain('"revertedCount":2')
    const undone=await ledger(page)
    for (const detail of proposal.groups.find(g=>g.merchant===merchant)!.details) {
      expect(undone.find(t=>t.id===detail.txId)).toMatchObject({state:'needs_review',categoryName:null,amountCents:detail.amountCents})
    }
    expect(undone.find(t=>t.merchant===second)).toMatchObject({state:'confirmed',categoryName:'购物',amountCents:3333})
    expect((await page.evaluate(()=>window.mz.listCategoryRules()))[0]).toMatchObject({id:rule.id,active:true})
    const finalRecovery=await page.evaluate(id=>window.mz.getClassifyResults(id),summary.batchId)
    expect(finalRecovery.find(r=>r.classifyId===firstGate.classifyId)!.undo).toMatchObject({status:'reverted',revertedCount:2,revertibleCount:0})
    expect(f.errors).toEqual([]); expect(restarted.errors).toEqual([])
    console.log('B1_B2_B3_VERIFIED',JSON.stringify({dir:f.dir,finalRecovery,undone,rule}))
  } finally {await app.close()}
})

test('B4：展示后金额变化拒绝过期proposal，不创建分类成功候选、不改剩余账', async () => {
  const f=await fixture('proposal-b4')
  try {
    const {page}=f; const {summary,proposal}=await importBill(page)
    await select(page)
    const group=proposal.groups.find(g=>g.merchant===merchant)!
    const edit=await page.evaluate(id=>window.mz.editTx(id,{op:'set',fields:{amountCents:999}}),group.details[0].txId)
    expect(edit.status).toBe('ok')
    const before=await ledger(page)
    await confirmAndExpand(page)
    await expect(page.getByRole('alert')).toContainText('过期')
    expect(await ledger(page)).toEqual(before)
    expect(before.every(t=>t.state==='needs_review' && t.categoryName===null)).toBe(true)
    expect(await page.evaluate(id=>window.mz.getClassifyResults(id),summary.batchId)).toEqual([])
    await expect(page.getByTestId('save-reviewed-rules')).toHaveCount(0)
    expect(await page.evaluate(()=>window.mz.listCategoryRules())).toEqual([])
    console.log('B4_REJECTED',await page.getByRole('alert').innerText(),JSON.stringify(before))
    expect(f.errors).toEqual([])
  } finally {await f.app.close()}
})

test('B5：真实旧规则冲突与损坏原因可见，默认不选且管理入口可达', async () => {
  const f=await fixture('conflict-b5')
  try {
    const {page}=f; const {summary}=await importBill(page)
    await closeReview(page)
    // Seed legacy conflict only inside this proven isolated encrypted ledger. No fake preload/IPC.
    // The real application then reads proposals/rules through its unchanged production IPC.
    const ruleIds=await f.app.evaluate(async ({safeStorage}, data) => {
      const fs=process.getBuiltinModule('fs')!; const path=process.getBuiltinModule('path')!; const mod=process.getBuiltinModule('module')!
      const req=mod.createRequire(path.join(process.cwd(),'package.json'))
      const Database=req('better-sqlite3-multiple-ciphers')
      const key=safeStorage.decryptString(fs.readFileSync(path.join(data,'secrets','db.key')))
      const file=path.join(data,'mingzhang.db')
      if (!fs.existsSync(file)) throw new Error('Isolated fixture ledger missing')
      const db=new Database(file,{fileMustExist:true})
      try {
        db.pragma(`key = "x'${key}'"`); db.pragma("cipher='chacha20'")
        const insert=db.prepare("INSERT INTO rules(condition,action,provenance,active,hit_count,created_at,updated_at) VALUES(?,?,'manual',1,0,datetime('now'),datetime('now'))")
        return ['餐饮','购物'].map((name,i)=>Number(insert.run(JSON.stringify({match:'merchant',op:i===0?'equals':'contains',value:'合成紫岚甲',direction:'expense'}),JSON.stringify({set_category:name})).lastInsertRowid)).reverse()
      } finally {db.close()}
    }, f.data)
    const conflict=await page.evaluate(id=>window.mz.getClassifyProposal(id),summary.batchId)
    expect(conflict.groups.find(g=>g.merchant===merchant)).toMatchObject({ruleStatus:'conflict',suggestedCategory:null,ruleIds})
    await page.getByTestId('open-import-review').click()
    const row=page.getByTestId('import-review-workspace').locator('.mz-review-row').filter({hasText:merchant})
    await expect(row).toContainText(`规则冲突（${ruleIds.join('、')}），请管理规则`)
    await expect(page.getByLabel(`选择 ${merchant}`,{exact:true})).not.toBeChecked()
    await expect(page.getByLabel(`${merchant}分类`,{exact:true})).toHaveValue('')
    await openManager(page)
    await expect(page.getByTestId('category-rules-manager')).toContainText('餐饮')
    await expect(page.getByTestId('category-rules-manager')).toContainText('购物')
    const rules=await page.evaluate(()=>window.mz.listCategoryRules())
    expect(rules.filter(r=>r.active)).toHaveLength(2)
    await returnToReview(page)
    await closeReview(page)
    await f.app.evaluate(async ({safeStorage},data)=>{
      const fs=process.getBuiltinModule('fs')!; const path=process.getBuiltinModule('path')!; const mod=process.getBuiltinModule('module')!
      const Database=mod.createRequire(path.join(process.cwd(),'package.json'))('better-sqlite3-multiple-ciphers')
      const key=safeStorage.decryptString(fs.readFileSync(path.join(data,'secrets','db.key')))
      const file=path.join(data,'mingzhang.db')
      if (!fs.existsSync(file)) throw new Error('Isolated fixture ledger missing')
      const db=new Database(file,{fileMustExist:true})
      try {db.pragma(`key = "x'${key}'"`);db.pragma("cipher='chacha20'");db.prepare("UPDATE rules SET action=? WHERE id=(SELECT max(id) FROM rules)").run('{broken-json')} finally {db.close()}
    },f.data)
    expect((await page.evaluate(id=>window.mz.getClassifyProposal(id),summary.batchId)).groups.find(g=>g.merchant===merchant)!.ruleStatus).toBe('invalid')
    await page.getByTestId('open-import-review').click()
    await expect(page.getByTestId('import-review-workspace')).toContainText('规则损坏，请管理规则')
    await expect(page.getByLabel(`选择 ${merchant}`,{exact:true})).not.toBeChecked()
    expect((await ledger(page)).every(t=>t.state==='needs_review'&&t.categoryName===null)).toBe(true)
    console.log('B5_CONFLICT_INVALID_VERIFIED',JSON.stringify({ruleIds,rules}))
    expect(f.errors).toEqual([])
  } finally {await f.app.close()}
})


test('恢复撤销的部分结果：后续人工修改跳过原因可见且不会误撤销', async () => {
  const f=await fixture('partial-undo')
  try {
    const {page}=f; const {summary,proposal}=await importBill(page)
    await select(page)
    await confirmAndExpand(page)
    await expect(page.getByTestId('save-reviewed-rules')).toBeVisible()
    const group=proposal.groups.find(g=>g.merchant===merchant)!
    expect((await page.evaluate(id=>window.mz.editTx(id,{op:'set',fields:{categoryName:'购物'}}),group.details[0].txId)).status).toBe('ok')
    await closeReview(page); await page.getByTestId('open-import-review').click()
    await showRecoveredResult(page)
    const recovery=await page.evaluate(id=>window.mz.getClassifyResults(id),summary.batchId)
    expect(recovery).toHaveLength(1)
    expect(recovery[0].undo).toMatchObject({status:'partial',revertibleCount:1})
    expect(recovery[0].undo.skipped).toHaveLength(1)
    expect(recovery[0].undo.skipped[0].txId).toBe(group.details[0].txId)
    expect(recovery[0].undo.skipped[0].reason).toBeTruthy()
    let message='';page.once('dialog',d=>{message=d.message();void d.accept()})
    await page.getByRole('button',{name:'撤销这次分类',exact:true}).click()
    await expect.poll(()=>message).toContain('"revertedCount":1')
    const result=JSON.parse(message.slice(message.indexOf('{'),message.lastIndexOf('}')+1))
    expect(result.skipped).toHaveLength(1)
    expect(result.skipped[0].txId).toBe(group.details[0].txId)
    expect(result.skipped[0].reason).toBeTruthy()
    const rows=await ledger(page)
    expect(rows.find(t=>t.id===group.details[0].txId)).toMatchObject({state:'confirmed',categoryName:'购物',amountCents:1111})
    expect(rows.find(t=>t.id===group.details[1].txId)).toMatchObject({state:'needs_review',categoryName:null,amountCents:2222})
    console.log('PARTIAL_UNDO_READBACK',JSON.stringify({recovery,result,rows}))
    expect(f.errors).toEqual([])
  } finally {await f.app.close()}
})


async function shots(page: Page, label: string) {
  for (const theme of ['dark','light']) {
    if (await page.locator('html').getAttribute('data-theme') !== theme) await page.getByTestId('theme-toggle').click()
    await expect(page.locator('html')).toHaveAttribute('data-theme', theme)
    await page.screenshot({path:join(evidence, `ux2-recheck-${label}-${theme}.png`)})
  }
}

test('UX2：部分确认→结果默认折叠→继续→全部完成→这次就好不保存', async () => {
  const f=await fixture('ux2-skip')
  try {
    const {page}=f; const {summary}=await importBill(page)
    const original=await ledger(page)
    await closeReview(page)
    await expect(page.getByTestId('open-import-review')).toBeVisible()
    await expect(page.getByTestId('br-go-handle')).toHaveCount(0)
    await expect(page.getByTestId('br-go-ledger')).toHaveCount(0)
    await shots(page,'inbox-duplicate-entries')
    expect.soft(await page.getByTestId('br-go-handle').count(),'UX阻断：新检查入口仍与旧面板归类入口重复').toBe(0)
    await page.getByTestId('open-import-review').click()
    await expect(page.getByRole('button',{name:'确认所选 0 笔',exact:true})).toBeDisabled()
    await select(page)
    await expect(page.getByRole('button',{name:'确认所选 2 笔',exact:true})).toBeEnabled()
    await page.getByRole('button',{name:'确认所选 2 笔',exact:true}).click()
    await expect(page.getByTestId('review-complete')).toContainText('还有 1 笔待检查')
    await expect(page.getByTestId('import-review-workspace')).toHaveCount(0)
    await expect(page.getByTestId('save-reviewed-rules')).toHaveCount(0)
    expect(await page.evaluate(()=>window.mz.listCategoryRules())).toEqual([])
    await shots(page,'partial-result')
    await page.getByRole('button',{name:'继续检查剩余记录',exact:true}).click()
    await expect(page.getByTestId('import-review-workspace')).toContainText('1 组商户')
    await shots(page,'continue-check')
    // Frozen UX contract: remember belongs to result, not the check step.
    expect.soft(await page.getByTestId('save-reviewed-rules').count(),'UX阻断：继续检查页仍直接显示长期保存区').toBe(0)
    await select(page,second,'购物')
    await page.getByRole('button',{name:'确认所选 1 笔',exact:true}).click()
    await expect(page.getByTestId('review-complete')).toContainText('这批账处理好了')
    await expect(page.getByRole('button',{name:'继续检查剩余记录',exact:true})).toHaveCount(0)
    await expect(page.getByTestId('save-reviewed-rules')).toHaveCount(0)
    await shots(page,'complete-result')
    await page.getByRole('button',{name:'这次就好',exact:true}).click()
    await expect(page.getByTestId('inbox-view')).toBeVisible()
    await expect(page.getByTestId('br-go-handle')).toHaveCount(0)
    expect(await page.evaluate(()=>window.mz.listCategoryRules())).toEqual([])
    const final=await ledger(page)
    expect(final).toHaveLength(3)
    expect(final.every(t=>t.state==='confirmed')).toBe(true)
    expect(final.filter(t=>t.merchant===merchant).every(t=>t.categoryName==='餐饮')).toBe(true)
    expect(final.find(t=>t.merchant===second)!.categoryName).toBe('购物')
    expect(final.map(t=>[t.id,t.amountCents]).sort()).toEqual(original.map(t=>[t.id,t.amountCents]).sort())
    expect((await page.evaluate(()=>window.mz.getBatchResult()))!.counts.needsCategory).toBe(0)
    expect((await page.evaluate(id=>window.mz.getClassifyResults(id),summary.batchId)).flatMap(r=>r.candidates)).toHaveLength(2)
    await shots(page,'inbox-finished')
    await expect(page.getByTestId('br-go-handle')).toHaveCount(0)
  } finally {await f.app.close()}
})

test('UX2：明确展开并保存；重启后候选、撤销和账目恢复不自动保存',async()=>{
  const f=await fixture('ux2-explicit');let app=f.app
  try {
    let page=f.page;const {summary,proposal}=await importBill(page)
    await select(page)
    await page.getByRole('button',{name:'确认所选 2 笔',exact:true}).click()
    await expect(page.getByTestId('review-complete')).toBeVisible()
    await expect(page.getByTestId('save-reviewed-rules')).toHaveCount(0)
    expect(await page.evaluate(()=>window.mz.listCategoryRules())).toEqual([])
    await page.getByRole('button',{name:'选择要记住的商户',exact:true}).click()
    const rule=await save(page)
    expect(rule).toMatchObject({merchant,categoryName:'餐饮',active:true})
    await page.getByRole('button',{name:'继续检查剩余记录',exact:true}).click()
    await select(page,second,'购物')
    await page.getByRole('button',{name:'确认所选 1 笔',exact:true}).click()
    await expect(page.getByTestId('review-complete')).toBeVisible()
    await page.getByRole('button',{name:'这次就好',exact:true}).click()
    const confirmed=await ledger(page)
    await app.close()
    const restarted=await launch(f.data,f.profile,f.log);app=restarted.app;page=restarted.page
    expect(await ledger(page)).toEqual(confirmed)
    const results=await page.evaluate(id=>window.mz.getClassifyResults(id),summary.batchId)
    expect(results.flatMap(r=>r.candidates).map(c=>c.merchant)).toEqual([second])
    expect(results.reduce((n,r)=>n+r.undo.revertibleCount,0)).toBe(3)
    expect((await page.evaluate(()=>window.mz.listCategoryRules())).map(r=>r.id)).toEqual([rule.id])
    await page.getByTestId('open-import-review').click()
    await expect(page.getByTestId('save-reviewed-rules')).toHaveCount(0)
    await showRecoveredResult(page)
    await expect(page.getByTestId('save-reviewed-rules').filter({hasText:`${second} →`})).toBeVisible()
    await shots(page,'restart-candidates')
    const groupResult=results.find(r=>r.appliedCount===2)!
    const undo=page.getByRole('button',{name:'撤销这次分类',exact:true})
    page.once('dialog',d=>void d.accept())
    await undo.nth(results.findIndex(r=>r.classifyId===groupResult.classifyId)).click()
    await expect.poll(async()=> (await ledger(page)).filter(t=>t.state==='needs_review').length).toBe(2)
    const after=await ledger(page)
    for(const d of proposal.groups.find(g=>g.merchant===merchant)!.details) expect(after.find(t=>t.id===d.txId)).toMatchObject({state:'needs_review',categoryName:null,amountCents:d.amountCents})
    expect(after.find(t=>t.merchant===second)).toMatchObject({state:'confirmed',categoryName:'购物',amountCents:3333})
    expect((await page.evaluate(()=>window.mz.listCategoryRules()))[0]).toMatchObject({id:rule.id,active:true})
    await app.close()
    const twice=await launch(f.data,f.profile,f.log);app=twice.app
    expect(await ledger(twice.page)).toEqual(after)
    expect((await twice.page.evaluate(id=>window.mz.getClassifyResults(id),summary.batchId)).find(r=>r.classifyId===groupResult.classifyId)!.undo).toMatchObject({status:'reverted',revertedCount:2,revertibleCount:0})
  }finally{await app.close()}
})

test('UX2：设置独立空态、返回语义、管理页不带速记与顶部红提示',async()=>{
  const f=await fixture('ux2-empty-settings')
  try {
    const {page}=f
    await page.getByTestId('nav-settings').click()
    await page.getByTestId('settings-category-rules').click()
    await expect(page.getByTestId('category-rules-manager')).toContainText('还没有保存分类习惯')
    expect(await ledger(page)).toEqual([])
    expect(await page.evaluate(()=>window.mz.listCategoryRules())).toEqual([])
    await shots(page,'settings-empty')
    expect.soft(await page.getByTestId('capture-bar').isVisible(),'UX阻断：独立管理页不应带速记条').toBe(false)
    expect.soft(await page.getByRole('button',{name:'返回复核',exact:true}).count(),'UX阻断：从设置进入，返回应标为返回设置而非复核').toBe(0)
    await page.getByRole('button',{name:'返回设置',exact:true}).click()
    await expect(page.getByTestId('settings-category-rules')).toBeVisible()
    await expect(page.getByTestId('category-rules-manager')).toHaveCount(0)
    // Real unsupported-file event leaves a truthful capture error; it must not leak onto manager.
    await page.getByTestId('nav-inbox').click()
    await page.evaluate(()=>{
      const dt=new DataTransfer();dt.items.add(new File(['synthetic'],'synthetic.unsupported',{type:'application/octet-stream'}))
      document.querySelector('[data-testid="capture-bar"]')!.dispatchEvent(new DragEvent('drop',{bubbles:true,cancelable:true,dataTransfer:dt}))
    })
    await expect(page.getByTestId('capture-error')).toBeVisible()
    await openManager(page)
    await shots(page,'settings-error-leak')
    expect.soft(await page.getByTestId('capture-error').isVisible(),'UX阻断：管理页不应出现上一屏速记红提示').toBe(false)
    expect(await ledger(page)).toEqual([])
  }finally{await f.app.close()}
})
