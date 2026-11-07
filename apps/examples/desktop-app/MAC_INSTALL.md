# AutoCline for macOS — 第二阶段安装说明（Phase 2）

> 本文件对应简报 v1.1 §0.6 / §4.2 的**第二阶段**。
> **第一阶段（在 hp02 上对本机 Cline Hub 验证 SWR 缓存 + 改名）已经完成并通过**，
> 记录见 `~/builds/AutoCline/PHASE1_TEST_RESULTS.md`。
> 本文档只描述如何在 **Mac** 上构建、签名、并安装 `AutoCline.app`。

---

## 0. 一句话

把 AutoCline（fork of Cline）装成 **`/Applications/AutoCline.app`**，
与官方 **`/Applications/Cline.app` 并排共存，绝不覆盖**。
Bundle id 已经是 `bot.autocline.app`（官方是 `bot.cline.app`），因此 macOS
会把它们当作两个独立 App（Dock、通知、LaunchServices 均不冲突）。

---

## 1. 改名清单（已在仓库中落地，Mac 侧无需再改）

| 位置 | 改前 | 改后 | 状态 |
|------|------|------|------|
| `src-tauri/tauri.conf.json` → `productName` | `Cline` | **`AutoCline`** | ✅ 已改 |
| 同上 → `identifier` | `bot.cline.app` | **`bot.autocline.app`** | ✅ 已改 |
| 同上 → `app.windows[0].title` | `Cline` | **`AutoCline`** | ✅ 已改 |
| 同上 → `bundle.shortDescription` | `Cline AI coding agent` | `AutoCline (fork of Cline) …` | ✅ 已改 |
| 同上 → `bundle.longDescription` / `homepage` | cline.bot | fork 说明 / `modalfuse/AutoCline` | ✅ 已改 |
| 同上 → `plugins.updater.endpoints` | 指向 `cline/cline` releases | **`[]`（禁用官方 updater）** | ✅ 已改 |
| `tauri.dev.conf.json` | `Cline Dev` / `bot.cline.app.dev` | **`AutoCline Dev` / `bot.autocline.app.dev`** | ✅ 已改 |
| `tauri.beta.conf.json` | `Cline Beta` / `bot.cline.app.beta` | **`AutoCline Beta` / `bot.autocline.app.beta`** | ✅ 已改 |
| `tauri.nightly.conf.json` | `Cline Nightly` / `bot.cline.app.nightly` | **`AutoCline Nightly` / `bot.autocline.app.nightly`** | ✅ 已改 |
| `src-tauri/src/macos_notification.rs` → `DEV_BUNDLE_NAME` | `Cline.app` | **`AutoCline.app`** | ✅ 已改 |
| `src-tauri/src/main.rs`（资源目录推断测试） | 仅 `/Applications/Cline.app` | 同时覆盖 `/Applications/AutoCline.app` | ✅ 已改 |
| `webview/app/layout.tsx` → `metadata.title` | `Cline` | **`AutoCline`** | ✅ 已改 |
| `src-tauri/app-icon.png` + `icons/**` | 官方 Cline 图标 | **AutoCline 图形**（无字标、无豆包水印） | ✅ 已生成 |
| `Cargo.toml` `name = "cline-app"` | crate 名 | **保留**（用户不可见；产品名以 `productName` 为准） | ⏸ 有意保留 |
| `package.json` `"name": "@cline/code"` | workspace 名 | **保留**（内部包名；用户可见名以 Tauri `productName` 为准） | ⏸ 有意保留 |

`CFBundleName` / `CFBundleDisplayName` / `CFBundleIdentifier` 由 Tauri 依据
`productName` + `identifier` 自动生成，**不需要**手工改 `Info.plist`。

### 上游 updater 为什么必须关掉

官方 updater 的 endpoint 是 `github.com/cline/cline/releases/.../latest.json`，
签名公钥指向官方包。若保留，AutoCline 下一次启动检查更新时会把官方的
`Cline.app` 拉下来覆盖自己（应用名相同）。本轮直接把 `endpoints` 置空：
**AutoCline 永远不会被官方包盖回**。若日后要发 AutoCline 自己的更新，
把 endpoint 改成 `modalfuse/AutoCline` 的 release，并用**自己的** minisign 密钥
替换 `plugins.updater.pubkey`。

---

## 2. 品牌资源（已进仓库）

| 用途 | 仓库路径 | 来源 |
|------|----------|------|
| 文档 / README / About | `apps/examples/desktop-app/assets/brand/AutoCline-logo-docs.png` | `AutoCline-logo-docs.png`（含「AutoCline」字标；**保留青绿聊天气泡**；无水印） |
| App 图标源图 | `apps/examples/desktop-app/assets/brand/AutoCline-icon.png`（同时拷到 `src-tauri/app-icon.png`） | `AutoCline-icon.png`（**仅图形**，无字标、无水印） |
| 生成出的平台图标 | `apps/examples/desktop-app/src-tauri/icons/**`（含 `icon.icns` / `icon.ico` / 32/128/128@2x / Square* / Android / iOS） | 由 Tauri CLI 从 `app-icon.png` 生成 |

`AutoCline-logo.png`（用户原始上传、含水印）**未**入库，仅作存档对照，不用于 docs 或 App 图标。

重新生成图标（如换了源图）：

```bash
cd apps/examples/desktop-app/src-tauri
cp ../assets/brand/AutoCline-icon.png ./app-icon.png
bunx @tauri-apps/cli icon app-icon.png -o icons
```

---

## 3. 在 Mac 上构建

前提：macOS（建议 14+）、Xcode Command Line Tools、Rust ≥ 1.85、Bun 1.4.x、Node ≥ 22。

```bash
# 0) 取得代码
git clone https://github.com/modalfuse/AutoCline.git
cd AutoCline
git checkout feat/remote-session-swr-cache      # 或 main（若已合并）

# 1) 安装依赖（整个 monorepo 用 bun；Node 只是运行时）
bun install

# 2) 构建 SDK 产物（apps 通过 dist/ 解析 @cline/*）
bun run build:sdk

# 3) 打 Mac 包（DMG + .app）
cd apps/examples/desktop-app
bun run package:desktop:mac
```

产物位置（Tauri 惯例）：

```
apps/examples/desktop-app/src-tauri/target/release/bundle/
├── macos/AutoCline.app                 ← 应用包
└── dmg/AutoCline_<version>_<arch>.dmg  ← 安装镜像
```

期望文件名带 **AutoCline** 前缀（由 `productName` 决定），例如
`AutoCline_0.0.49_aarch64.dmg`。若看到 `Cline_*.dmg`，说明 `productName` 没生效，
请检查 `src-tauri/tauri.conf.json`。

只想要 `.app` 不打 DMG：

```bash
cd apps/examples/desktop-app/src-tauri
bunx @tauri-apps/cli build            # 等价：cargo tauri build
# 或开发态运行（窗口标题应为 AutoCline Dev）
bun run dev
```

> **注意**：`package:desktop:mac` 会在 `beforeBuildCommand` 里跑
> `bun run dmg:background && bun run build`，即先构建 webview 再打包 sidecar，
> 首次执行耗时较长属正常。

---

## 4. 安装为 `/Applications/AutoCline.app`

### 方式 A：DMG（推荐）

1. 双击 `AutoCline_<version>_<arch>.dmg`。
2. 把 **AutoCline** 拖到 **Applications**。
   - 如果 `/Applications` 里已经有 `AutoCline.app`，选「替换」只替换 AutoCline，
     **不会**影响 `Cline.app`。
3. 打开「启动台」或 Finder → 应用程序 → **AutoCline**。

### 方式 B：直接拷贝 .app

```bash
# 目标路径固定为 /Applications/AutoCline.app
# 千万不要写到 /Applications/Cline.app
sudo rm -rf /Applications/AutoCline.app      # 仅在升级时
cp -R "apps/examples/desktop-app/src-tauri/target/release/bundle/macos/AutoCline.app" /Applications/

# 首次运行前去掉隔离属性
xattr -dr com.apple.quarantine /Applications/AutoCline.app
```

### 校验并排共存

```bash
ls -d /Applications/Cline.app /Applications/AutoCline.app 2>&1
/usr/libexec/PlistBuddy -c 'Print :CFBundleIdentifier' /Applications/AutoCline.app/Contents/Info.plist
# 期望：bot.autocline.app
/usr/libexec/PlistBuddy -c 'Print :CFBundleIdentifier' /Applications/Cline.app/Contents/Info.plist
# 期望：bot.cline.app（保持不变）
```

### Gatekeeper

未做代码签名/公证的构建，首次打开会被拦下：

- **右键 → 打开 → 再次「打开」**（最常用）；或
- 系统设置 → 隐私与安全性 → 底部「仍要打开」；或
- `xattr -dr com.apple.quarantine /Applications/AutoCline.app`

有 Developer ID 证书时，在 `TAURI_SIGNING_IDENTITY` / `APPLE_ID` 等环境变量
下重新打包即可得到签名版本（本轮未做签名，属第二阶段可选项）。

> ⚠️ **禁止**：任何步骤都不要把产物拷成/覆盖 `/Applications/Cline.app`。
> 上面所有命令的目标路径都写死为 `AutoCline.app`。

---

## 5. 数据目录（重要）

| 内容 | 路径 | 说明 |
|------|------|------|
| 全局配置 / 密钥 / 会话 | `~/.cline/`（`CLINE_DIR` 可覆盖） | **与官方 Cline 共用**。两边的 API Key、设置会互相可见/互相影响——这是有意的（fork 语义），介意的话用 `CLINE_DIR=~/.cline-autocline` 单独启动 |
| 本地会话正文 | `~/.cline/data/sessions/<sessionId>/` | 只放**本地**会话 |
| 远程（SSH / Hub）会话正文 | Hub 上，Mac 侧**不落盘** | 与上游 Cline 一致：打开远程会话时向 Hub `readMessages` 全量拉取 |

> **1.1.0（build 34）起已移除 Mac 侧 SWR 远程缓存**：
> `~/.cline/data/remote-cache/`、`sidecar/session-data/remote-cache.ts`、
> `remote-session-swa.ts` 以及配套 smoke 脚本全部删除，远程会话的
> 列表/正文/发送一律以 Hub 为唯一来源（上游 Cline 行为）。
> 旧版本残留的 `~/.cline/data/remote-cache/` 目录可以直接删除，不再被读取。

**远程正文永不写入 `~/.cline/data/sessions/`**：本地会话按裸 `sessionId` 索引，
若远程正文写进去会串台（源码中已有 warning）。

---

## 6. 故障排查

| 现象 | 原因 / 处理 |
|------|-------------|
| 打开后窗口标题还是 `Cline` | 用的是旧构建：`bun run build:sdk` + 重新 `package:desktop:mac` |
| Finder 里图标还是旧 Cline 图标 | `src-tauri/icons/icon.icns` 没更新，或 Finder 图标缓存：`killall Dock` / `touch /Applications/AutoCline.app` |
| 和 Cline 抢同一个 Dock 位置 / 通知串了 | 检查 `CFBundleIdentifier` 是否为 `bot.autocline.app`（见 §4） |
| 启动后提示要更新，更新后变回 Cline | updater 没关：确认 `plugins.updater.endpoints` 为 `[]` |
| 远程会话打开很慢 | 与上游 Cline 一致：每次打开都向 Hub 全量 `readMessages`。先确认 Hub 可连（`~/.cline/data/debug-*` 日志），Mac 侧不再有本地缓存加速 |
| `remote-cache` 目录不存在 | 说明还没打开过任何远程会话，属正常 |

---

## 7. 第一阶段验收（已在 hp02 完成，供 Mac 侧对照）

```bash
# 纯函数级单测（15 项）
cd apps/examples/desktop-app
./node_modules/.bin/vitest run sidecar/session-data/remote-cache.test.ts \
                              sidecar/session-data/remote-session-swa.test.ts

# 对本机 Cline Hub 的端到端 smoke（11 项，含 warm/refresh/delete/改名）
cd ~/src/AutoCline
bun apps/examples/desktop-app/scripts/smoke-remote-cache-live.ts \
    --hub ws://127.0.0.1:25463/hub
```

结果与逐项输出见 `~/builds/AutoCline/PHASE1_TEST_RESULTS.md`。
