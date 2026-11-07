# STATUS — AutoCline 可见品牌文案「Cline」→「AutoCline」

日期：2026-11-06（Asia/Shanghai）
仓库：`/Users/qiang/src/AutoCline`
任务书：`/Users/qiang/works/12-AutoResearch/Harness/31_Cursor任务_AutoCline可见品牌文案Cline改AutoCline_v1.0-20261106.md`

## 结论

- 截图两处用户可见文案已改：Home 悬浮卡标题 **AutoCline**、状态 **AutoCline Hub @<port>**；窗口标题 / Dock 窗口列表 **AutoCline v1.1.0**。
- `/Applications/AutoCline.app` 已用新构建覆盖安装：marketing **1.1.0**，`CFBundleVersion` **37**。
- App 已打开并在运行；窗口标题实测为 `AutoCline v1.1.0`。
- 未改 `cline://` 等协议 / URL scheme，未改 provider id，未重新引入 Cline / ClinePass 登录提供方；未打印任何密钥。

## 改动文件（均在 `apps/examples/desktop-app/`）

品牌文案主体：

1. `webview/lib/app-channel.ts`
   - `STABLE_PRODUCT_NAME`：`"Cline"` → `"AutoCline"`
   - `BETA_PRODUCT_NAME`：`"Cline Beta"` → `"AutoCline Beta"`
   - 该常量驱动 Home 悬浮卡标题、`buildDesktopWindowTitle(...)`（Dock 窗口列表）、About 等所有 `productNameForVersion(...)` 调用处。
2. `webview/components/agent-sidebar.tsx`
   - `Cline Hub @{...}` → `AutoCline Hub @{...}`
   - 失败文案：`Cline Hub is not connected.` / `Unable to read Cline Hub status.` → AutoCline Hub 版本
   - `aria-label="Cline home"` → `"AutoCline home"`（辅助功能可见）
   - 无账号时的默认名 `"Cline Desktop"` → `"AutoCline Desktop"`
   - 工具栏 title `Customize Cline with plugins, ...` → `Customize AutoCline with plugins, ...`
3. `webview/components/session-command-bar.tsx`
   - 搜索对话框描述 `Search messages across all Cline sessions` → `... all AutoCline sessions`（同一侧栏必然可见的文案）
4. `src-tauri/Info.plist`
   - `CFBundleVersion`：`36` → `37`（marketing 保持 `1.1.0`）

单测同步：

5. `webview/lib/desktop-window-title.test.ts` — beta 期望 `AutoCline Beta v0.0.14-beta.1`
6. `webview/components/agent-sidebar.test.tsx` — `AutoCline Hub @25463`、`[aria-label="AutoCline home"]`

构建阻塞修复（打包前就已存在于工作树的破损，非本次文案改动引入）：

7. `webview/hooks/chat-session/constants.ts` — 仍从 `@cline/shared/browser` 导入 `isClineProvider`，但该导出（以及 `sdk/packages/shared/src/providers/utils.ts`）已在“移除 cline / cline-pass 提供方”的改动中删除，导致 `next build`（Turbopack）失败。现改为不再依赖该导出：Cloud 初始模型只取云端记忆选择，否则 `CLINE_DEFAULT_MODEL_ID`。
8. `webview/lib/model-selection.test.ts` — 同步该行为（cline / cline-pass / 其他 provider 均回落到默认模型）。

## 验证

单测（vitest，`apps/examples/desktop-app`）：

```
bunx vitest run webview/lib/app-channel.test.ts webview/lib/desktop-window-title.test.ts \
  webview/components/agent-sidebar.test.tsx webview/lib/model-selection.test.ts --config vitest.config.ts
→ Test Files 1 failed | 3 passed (4)
  Tests 46 passed, 2 failed
```

失败的 2 条是**改动前就已失败**的既有测试（已用 `git show HEAD:` 还原源码复跑确认，同样 2 条失败），与品牌文案无关：

- `groups Cline Account, Local, and BYOK under a Provider row` — 本 fork 已移除该 Provider 行/BYOK 入口
- `uses a compact overlay-friendly width in collapsed settings` — 同一原因（找不到 `Provider` 按钮）

打包：

- `bun run --cwd apps/examples/desktop-app package:desktop:mac` 首次因本机无 Developer ID/公证凭据被脚本主动拒绝；按脚本提示以本地未签名方式打包：`bun run scripts/package-desktop.ts --platform mac --allow-unsigned-mac`（产物 `AutoCline-1.1.0-macos-arm64-local-unsigned.zip`，ad-hoc 签名，仅供本机安装）。
- 产物：`apps/examples/desktop-app/src-tauri/target/release/bundle/macos/AutoCline.app`（及 `bundle/dmg/AutoCline_1.1.0_aarch64.dmg`）

安装与验收：

| 检查项 | 结果 |
|---|---|
| `PlistBuddy -c 'Print CFBundleShortVersionString' /Applications/AutoCline.app/Contents/Info.plist` | `1.1.0` |
| 同上 `CFBundleVersion` | `37` |
| 同上 `CFBundleName` / `CFBundleIdentifier` | `AutoCline` / `bot.autocline.app` |
| 窗口标题（AppleScript `name of every window`） | `AutoCline v1.1.0` |
| CGWindowList（Dock 窗口列表所用 owner/title） | `AutoCline \| AutoCline v1.1.0` |
| 菜单栏应用名 / Window 菜单项 | `AutoCline` / `AutoCline v1.1.0` |
| About 菜单项 | `About AutoCline`、`Quit AutoCline` |
| 侧栏 Home 按钮 `aria-label` | `AutoCline home` |
| 全窗口 Accessibility 树中剩余非 AutoCline 的 "Cline" 文本 | 0 条 |
| 安装包内已编译的 webview 资源（`tauri-codegen-assets`，brotli） | 含 `AutoCline Hub @`、`AutoCline Hub is not connected.`、`Unable to read AutoCline Hub status.`、`AutoCline home`、`AutoCline sessions`；**不含** `"Cline Hub @`、`"Cline"`、`Cline Beta` |

Hub：本地 Hub 守护进程（`cline-cli --cline-hub-daemon ... --port 25463`）未重启/未杀，Home 卡片照常连接并显示 **AutoCline Hub @25463**（端口取运行时 hub URL）。

## 未做的事（按任务约束）

- 未 `git commit` / `push`（改动保持未提交）。
- 未重命名 `cline://` 等内部 scheme、未改 provider id、未恢复 Cline/ClinePass 登录提供方。
- 未把内部日志/错误码/注释里的 “Cline Hub” 全量替换（仅用户可见 UI 字符串）。
- 未使用 Cursor Cloud Agent；未输出任何密钥/令牌/口令。
- 未动 NSCLC 中转或其他无关进程。

## 备注

- 截图文件无法在本会话中直接读图（当前模型不支持图像输入），改动依据任务书中的逐条描述 + 源码定位（`STABLE_PRODUCT_NAME` / `productNameForVersion` / 硬编码 `Cline Hub @{port}`）+ 上述运行时与产物级断言完成。
- `Info.plist` 的 `CFBundleVersion` 固定为 37；再次执行打包脚本不会自动再 +1。
