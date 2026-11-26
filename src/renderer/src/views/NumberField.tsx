// 金额/数值输入框（第十阶段修复）：替代原生 type="number"。
//
// 为什么不用 type="number"：
//   1. 中文输入法（微软拼音等）在 number 框里会吞键——先落到输入法组合窗口，
//      字符被过滤掉，用户表现为「打不了字」；
//   2. 鼠标滚轮在 number 框上会静默改值，表格里滚动页面时误改价格；
//   3. 部分键盘布局/输入法下，小数点、退格被拦；
//   4. number 框的浏览器自校验会在输入中间态（如 "1." ）判非法，视觉上像坏了。
//
// 本组件的做法：
//   * 用 type="text" + inputMode="decimal"，移动端仍弹数字键盘；
//   * 只做轻量字符过滤（数字 + 一个小数点），不干预光标、不重排输入；
//   * 关闭滚轮改值（onWheel blur 掉，避免误改）；
//   * 保留 value/onChange 受控语义，调用方写法基本不变。
//
// 注意：过滤只在「会产生非法字符」时拒绝这次变更，绝不 setState 回写，
// 否则会打断输入法组合与光标位置（那正是原来「打不了字」的另一半原因）。

import { useCallback, useRef } from 'react'
import type { ReactElement, WheelEvent } from 'react'

export interface NumberFieldProps {
  value: string
  onChange: (value: string) => void
  /** 占位提示。 */
  placeholder?: string
  /** 允许小数（默认 true）。不允时只留整数。 */
  decimal?: boolean
  /** 允许负数（默认 false）。 */
  negative?: boolean
  /** 额外 class。 */
  className?: string
  /** 是否自动聚焦。 */
  autoFocus?: boolean
  /** 无障碍标签。 */
  ariaLabel?: string
  /** 回车提交。 */
  onEnter?: () => void
  /** Esc 取消。 */
  onEscape?: () => void
  /** 最大小数位（默认 2，金额够用）。 */
  maxDecimals?: number
}

/** 判断一次输入是否可接受（只挡明显非法的字符，不做规范化）。 */
function isAcceptable(next: string, decimal: boolean, negative: boolean): boolean {
  if (next === '') return true
  // 允许前导负号
  const body = negative && next.startsWith('-') ? next.slice(1) : next
  if (body === '') return negative && next === '-'
  // 只允许数字和最多一个小数点
  const pattern = decimal ? /^\d*\.?\d*$/ : /^\d*$/
  return pattern.test(body)
}

export function NumberField({
  value,
  onChange,
  placeholder,
  decimal = true,
  negative = false,
  className,
  autoFocus,
  ariaLabel,
  onEnter,
  onEscape,
  maxDecimals = 2,
}: NumberFieldProps): ReactElement {
  const ref = useRef<HTMLInputElement>(null)

  const handleChange = useCallback(
    (raw: string) => {
      if (!isAcceptable(raw, decimal, negative)) return // 拒绝非法字符，但不动当前值
      // 小数位超限时截断（只在用户继续往后打时生效，粘贴也不会炸）
      if (decimal) {
        const dot = raw.indexOf('.')
        if (dot >= 0 && raw.length - dot - 1 > maxDecimals) {
          onChange(raw.slice(0, dot + maxDecimals + 1))
          return
        }
      }
      onChange(raw)
    },
    [onChange, decimal, negative, maxDecimals],
  )

  // 滚轮不要改值：在 number 时代这是最常见的"莫名改了价格"来源
  const handleWheel = useCallback((e: WheelEvent<HTMLInputElement>) => {
    e.currentTarget.blur()
  }, [])

  return (
    <input
      ref={ref}
      type="text"
      inputMode={decimal ? 'decimal' : 'numeric'}
      autoComplete="off"
      spellCheck={false}
      className={className}
      value={value}
      placeholder={placeholder}
      aria-label={ariaLabel ?? placeholder}
      autoFocus={autoFocus}
      onWheel={handleWheel}
      onChange={(e) => handleChange(e.target.value)}
      onKeyDown={(e) => {
        if (e.key === 'Enter' && onEnter) {
          e.preventDefault()
          onEnter()
        } else if (e.key === 'Escape' && onEscape) {
          e.preventDefault()
          onEscape()
        }
      }}
    />
  )
}