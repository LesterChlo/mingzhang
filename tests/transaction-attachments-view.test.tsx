import {expect,it,vi} from 'vitest'
import {renderToStaticMarkup} from 'react-dom/server'
import React from 'react'
vi.stubGlobal('React',React)
vi.mock('../src/renderer/src/shell/inboxStore',()=>({useInbox:()=>({categories:[]})}))
import {TransactionAttachments} from '../src/renderer/src/views/TransactionAttachments'
it('详情提供真实本地多图入口与限制/备份边界，没有待后端占位',()=>{
 const html=renderToStaticMarkup(<TransactionAttachments txId={1} deleted={false} onChanged={()=>{}}/>)
 expect(html).toContain('ledger-attachments');expect(html).toContain('type="file"');expect(html).toContain('multiple=""')
 expect(html).toContain('PNG');expect(html).toContain('12');expect(html).toContain('10');expect(html).toContain('40')
 expect(html).toContain('原图');expect(html).toContain('备份');expect(html).not.toContain('待后端')
})
