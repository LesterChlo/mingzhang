// 模板套用条（第八阶段）：表单顶部一排快捷模板按钮，点一下把字段填进表单。
// 只在有对应类型模板时渲染，无模板时不占位。

import type { ReactElement } from 'react'
import type { QuickTemplateDTO, TemplateKindDTO } from '../../../shared/types'
import { touchTemplate, TEMPLATE_KIND_LABEL } from '../lib/business'

export interface TemplateBarProps {
  kind: TemplateKindDTO
  templates: QuickTemplateDTO[]
  /** 套用回调：把模板字段写进表单。 */
  onApply: (t: QuickTemplateDTO) => void
  onError: (msg: string) => void
}

export function TemplateBar({ kind, templates, onApply, onError }: TemplateBarProps): ReactElement | null {
  const list = templates.filter((t) => t.kind === kind)
  if (list.length === 0) return null

  return (
    <div className="mz-biz-tpl-bar">
      <span className="mz-biz-tpl-bar-label">快捷套用</span>
      {list.slice(0, 6).map((t) => (
        <button
          key={t.id}
          type="button"
          className="mz-biz-tpl-chip"
          title={`${TEMPLATE_KIND_LABEL[t.kind]}${t.channel ? ` · ${t.channel}` : ''}${t.use_count > 0 ? ` · 用过 ${t.use_count} 次` : ''}`}
          onClick={() => {
            onApply(t)
            // 累加使用次数（失败不打断填表）
            void touchTemplate(t.id).catch((e) => onError(String(e)))
          }}
        >
          {t.name}
        </button>
      ))}
      {list.length > 6 && <span className="mz-biz-tpl-bar-more">还有 {list.length - 6} 个</span>}
    </div>
  )
}