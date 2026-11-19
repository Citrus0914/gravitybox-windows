# GravityBox 工程架构总览

## 核心定位
GravityBox (`1.1.1`) 原版为面向 macOS 14+ (Apple Silicon `arm64`) 的 Google Antigravity 伴侣工具箱（上游：[`Enzoo404/gravitybox`](https://github.com/Enzoo404/gravitybox)），本仓库 [`Citrus0914/gravitybox-windows`](https://github.com/Citrus0914/gravitybox-windows) 在保留全部核心机制的基础上完成 Windows 10/11 (`x64`) 桌面端移植，提供中英双语界面、持久化独立 Antigravity 汉化开关、输入框实时会话遥测 HUD、双周期配额监控、多账号四阶段原子切换、只读 SQLite 用量核算与回收站安全缓存维护。

## 目录与模块分工
- `desktop/`：Windows 桌面端（Tauri 2 Rust 宿主、Named Pipe IPC 守护、React/TypeScript 5 页控制台与托盘快捷面板）
- `native-win/`：零外部依赖 Win32 Rust 原生辅助程序（`gb-win-helper.exe`，负责凭据管理器、端口属主、进程列表、PE 信息与回收站移除）
- `native/`：macOS 原生 AppKit 前端（源自上游 `Enzoo404/gravitybox`）
- `src/`：Node 22 / TypeScript 核心后端（CDP 注入控制、应用级双语引擎 `i18n.ts`、账号切换事务、双周期配额聚合、`sqlite-worker` 只读投影、时序计费与重估、`metrics-engine` HUD 引擎、IPC 服务）
- `runtime/`：注入 Isolated World 的零侵入 DOM 观察引擎（`engine.js`）与双语会话遥测 HUD 实例（`hud-i18n.js` / `hud-instance.js` / `hud-popover.js` / `hud-styles.js`）
- `dict/` & `ui-strings/`：分层词典与基于官方正式版 SHA-256 指纹提取的界面文案基准（覆盖 `2.23.0` ~ `2.32.2`）
- `assets/`：图标、应用级双语语言包（`i18n/en.json` / `i18n/zh-Hans.json`）、实机截图、公开模型目录与时序定价基准（`model-catalog.json` / `pricing-feed.json`）
- `tools/`：构建（`clean-dist` / `copy-runtime`）、价格同步（`sync-pricing-feed`）、全量门禁（`verify`）及 DMG 打包（`package-mac`）脚本
- `test/`：Node 单元与集成测试、中英双语基础/原生测试（`i18n-foundation` / `native-i18n`）、无头 Chromium 浏览器回归（`test/browser.mjs`）及原生 Swift AppKit 布局断言（`test/native-ui.swift`）
