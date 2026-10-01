# 明账 · MingZhang

**本地优先的 AI 记账桌面应用（Windows）**：把一句话或一张截图丢进来，AI 负责解析、反问、记住习惯；账本全量加密，只存本机。

> A local-first, AI-native expense tracker for Windows.
> One sentence or one screenshot in — the AI parses it, asks back when unsure, and the ledger never leaves your machine.

截图（离线演示模式 + Playwright 驱动真实 Electron 窗口实拍，非设计稿）：

![收件箱：待确认的账都在这里排队](docs/screenshots/01-inbox.png)
![助手面板：可以问它、让它归类，工具调用与思考过程都看得见](docs/screenshots/02-assistant.png)
![账本：筛选、分页、行详情可改分类/金额/账户](docs/screenshots/03-ledger.png)
![模型向导：可选供应商、测连接、视觉自检](docs/screenshots/04-wizard.png)

## 为什么做这个

记账应用的通病是「记一笔」本身太贵：打开 → 选分类 → 填金额 → 保存。四步起步，坚持两周就断了。

明账把入口压到**一句话**或**一张截图**：判断交给模型，习惯交给规则（"以后星巴克都算咖啡"），月底由它来问你——而不是你追着它看。

界面是**收件箱 + 账本 + 报告 + 账户 + 助手面板**：待确认的账在收件箱排队，你逐笔过目；助手面板常驻右侧，随时问、随时让它归类。

## 三个设计决定

### 一、安全做在能力面，不做在半吊子沙盒里

嵌进去的 agent 引擎**没有 bash、没有任意文件读写、没有网页访问**——工具面只有 16 条账务动作。

危险动作（删除、批量入账）必须由 **UI 按钮**放行：模型自己说"用户已确认"不算数——顺带堵住 prompt injection。
出网只有你自己配置的模型 API；账本数据不出本机。

### 二、AI 判断，程序搬运

把整张 CSV/XLSX 塞给模型逐行重述金额，是记账工具不能接受的失效模式——**抄错一位数字，你无从发现**。

所以分工线画在「判断 vs 搬运」上，而不是"AI 用得多还是少"：

- **归 AI**：这列是什么、哪些行不算账、列取值怎么映射成收支方向与账户、分类给什么
- **归程序**：每行的金额与日期解析、去重、笔数对账、落库——**数字和行数一律不经模型输出**
- **程序不猜**：方案没覆盖到的取值 → 整批退回并列出清单；不静默归类、不落默认账户、不虚构时间

### 三、硬对账不变量

一次导入必须满足：`消费行数 = 将入账 + 重复跳过 + 待核对 + 不计收支`。

不相等就整体回滚报错——不会出现"导了一半"的账。

## 技术栈

| | |
|---|---|
| 壳 | Electron 44 + electron-vite（main / preload / renderer 三进程） |
| 界面 | React 18 + TypeScript 5.7 |
| Agent 引擎 | pi（`@earendil-works/pi-coding-agent`）作为 SDK 嵌入，工具面收窄到账务动作 |
| 存储 | 加密 SQLite（better-sqlite3-multiple-ciphers）；密钥走 Electron safeStorage（Windows DPAPI） |
| 规模 | 约 3.0 万行 TypeScript（其中测试 1.17 万行）：主进程 9.3k / 渲染层 8.8k / 共享 0.6k |
| 依赖 | 运行时 7 个、开发 11 个（无 UI 组件库、无图表库） |

## 跑起来

前置：**Node ≥ 22.12**（Electron 44 的要求）、Windows。

```bash
npm install
npm run dev
```

**不配模型也能完整跑一遍**：打开应用 → 点「先开离线演示」→ 输入框里说「麦当劳 26」回车 → 出账卡片。

离线演示是内置的**确定性假模型**（在本机 127.0.0.1 起一个 OpenAI 兼容端点，按规则解析并产出工具调用）：不联网、零成本、逐字可复现，也是下面 UI 巡检的底座。

## 测试

```bash
npm run typecheck   # 类型检查（main + web 双工程，零输出通过）
npm test            # 359 条单测（vitest，38 个文件）
npm run ui-test     # 78 条 UI 巡检（Playwright 驱动真实 Electron 窗口）
npm run dist        # 出包 → release/mingzhang-0.1.0-x64.exe（NSIS）+ .zip（便携）
```

UI 巡检跑的是**真窗口、真 IPC**，不是组件快照；数据目录经 `MZ_DATA_DIR` 指向临时目录，不会碰你本机的账本。

## 数据与隐私

- 账本 = 本机一个**加密** SQLite 文件，默认在 `%APPDATA%\mingzhang`；程序目录旁存在可写 `data/` 时自动切**便携模式**
- **没有账号、没有云同步、没有遥测**；出网只有你自己配置的模型供应商
- API Key 走系统安全存储，**永不进日志 / 崩溃报告 / 导出 / 备份**，也不随备份迁移（换机重填）
- 只读你选中的附件，不碰其他文件

## 已知限制

- 仅 Windows（NSIS 安装版 + zip 便携版）
- 版本 0.1.0：日常可用；**账户屏仍在实现中**（当前为占位页），数据 schema 与工具面仍可能变
- 安装包未做代码签名，Windows SmartScreen 会提示一次
- 图片走多模态直读，主模型需支持视觉（无本地 OCR 兜底）

## 许可

MIT，见 [LICENSE](LICENSE)。
