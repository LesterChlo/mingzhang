# UI 自动巡检（Playwright × Electron）

## 当前状态

- `shell-smoke.spec.ts` —— **现行**用例，针对方向 A 新外壳（左栏五项导航 / 切屏 / 深浅主题 / 速记行 / 锁标）。
  后续每落地一屏，就在这里追加该屏的巡检用例。
- `ui-inspection.legacy.ts` —— **已冻结**，不被 playwright 收集（文件名不含 `.spec.`）。
  它是旧对话式 UI 的 15 条巡检用例（记一笔/查账卡片、发图、缩放、离线演示、备份等），
  随 UI 重做整体退役。**不要直接删**：新 UI 各屏接线时，从里面挑对应的行为断言迁移过来，
  迁完一批删一批。迁移时注意旧用例依赖的选择器（旧 header 的「对话/账本/待收尾/设置」按钮、
  `.msg-thumb`、`.zoom-overlay`）在新外壳里已不存在。

## 跑法

```bash
npm run ui-test        # electron-vite build && playwright test
```

## 纪律（沿用本项目既有约定）

- 巡检全程走**离线演示 / mock**（`MZ_MOCK` / `mz:setMock`）——不联网、不烧 key、确定性可复现。
- 数据目录必须隔离：环境变量 `MZ_DATA_DIR` 指向临时目录 + 命令行 `--user-data-dir=<临时目录>`，
  单实例锁随之隔离。**绝不允许碰真实账本 `%APPDATA%\mingzhang`。**
- 失败自动截图 + trace 留档；新用例要求「连跑两遍全绿」。
