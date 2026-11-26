import React from 'react'
import { createRoot } from 'react-dom/client'
import { App } from './App'
import './styles.css'
// UI 重做 token 层 + 外壳样式（新旧并存，前缀隔离，互不污染）
import './styles/tokens.css'
import './styles/shell.css'
import './styles/finance-theme.css'
// Creamy Cozy 奶油治愈风覆盖层：必须最后加载，才能统合上面各层的视觉细节。
// 纯样式/变量层，不含任何业务逻辑。
import './styles/cream-theme.css'

createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
)
