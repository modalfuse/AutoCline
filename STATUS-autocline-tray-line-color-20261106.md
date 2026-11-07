# STATUS — AutoCline macOS 菜单栏托盘图标改为彩色线条版（2026-11-06）

状态：**完成**（已打包并覆盖安装）

## 结果速览

| 项 | 值 |
| --- | --- |
| 新 build 号 | `CFBundleVersion` **37 → 38**（`CFBundleShortVersionString` 仍为 `1.1.0`，marketing 版本未改） |
| 安装路径 | `/Applications/AutoCline.app`（覆盖安装，ad-hoc 签名 `codesign --verify --deep --strict` 通过） |
| 安装后实测 | `PlistBuddy Print :CFBundleVersion` = `38`；应用可正常启动（`cline-app` + 后端 + hub daemon 正常拉起） |
| template 着色 | 已关闭 —— macOS 分支 `icon_as_template(false)` |
| 托盘位图 | 由 `cline-template.png`（黑剪影 32×32）换成彩色线条版 88×88 透明 PNG |

## 改了哪些文件

1. `apps/examples/desktop-app/src-tauri/icons/tray/cline-template.png`
   - 备份：`cline-template.png.bak-filled-20261106`（旧的黑剪影 32×32，839 字节）
   - 新内容：`apps/examples/desktop-app/assets/brand/AutoCline-icon-line-color-transparent.png`（1024×1024、透明底、彩色线条）
     经 `-trim` 去掉原始透明留白后 LANCZOS 缩放到 72×72，再居中放入 88×88 画布（约 8% 边距，避免和相邻菜单栏图标挤在一起）。
     颜色保留原稿：深蓝 `#16273B`、宝蓝 `#1C68D6`、青绿 `#17C0B0`（`magick -colors 6` 直方图可复现）。
   - 顺带把 `cline-template@2x.png` 也换成同款 88×88 彩色线条（当前 `main.rs` 只用 `include_bytes!` 一张，此文件不被引用，仅保持一致；如不需要可删）。
   - `cline-template.original.png`、`preview-128.png` 未改动。
2. `apps/examples/desktop-app/src-tauri/src/main.rs`（仅 `setup_tray_icon` 的 macOS 托盘路径）
   - `let tray = tray.icon_as_template(true);` → `icon_as_template(false)`。
   - 上方注释改写：删掉 “Template mode lets macOS tint it…”，改为说明这是彩色线条版、故意不做 template 着色、仅图标内部透出菜单栏底色。
   - `#[cfg(not(target_os = "macos"))]` 分支（Windows/Linux 用 `default_window_icon()`）**未改**。
3. `apps/examples/desktop-app/src-tauri/Info.plist`
   - `CFBundleVersion` `37` → `38`（其它键、`CFBundleShortVersionString 1.1.0` 未动）。

## 明确没有改的

- 侧栏左上角 logo、Dock / 程序坞图标、About 图标、窗口图标：`icons/*`（`icon.icns`、`32x32.png`、`128x128.png`、`128x128@2x.png`、`icon.ico`）全部未动。
- `assets/brand/AutoCline-icon.png`（原彩色实心标志）与 `AutoCline-logo-docs.png` 未动（本次未修改，仍是原文件）。
- webview 内其它品牌图、可见文案（仍为 AutoCline）、provider（未引入/恢复 Cline、ClinePass 之类）。
- Windows / Linux 托盘图标路径。

## 打包与安装

```
cd /Users/qiang/src/AutoCline/apps/examples/desktop-app
bun run scripts/package-desktop.ts --platform mac --allow-unsigned-mac
```

- 产物：`src-tauri/target/release/bundle/macos/AutoCline.app`、`bundle/dmg/AutoCline_1.1.0_aarch64.dmg`、
  `dist/desktop/AutoCline-1.1.0-macos-arm64-local-unsigned.zip`。
- 脚本提示 “creating a local-only ad-hoc signed macOS package”，符合本机无 Developer ID 的预期。
- 覆盖安装：先退出旧实例（含旧的 hub daemon 进程）→ `rm -rf /Applications/AutoCline.app` →
  `ditto` 新包 → `xattr -cr` → 校验签名 → `open -a /Applications/AutoCline.app`。
- 已在安装后的主二进制里定位到新托盘 PNG 字节（`embedded tray png found: True`），确认彩色线条位图确实进了 app。

## 验收对照

- [x] 已安装应用 `CFBundleVersion` 已增加（37 → 38）
- [x] `main.rs` 中 macOS `icon_as_template(false)`
- [x] `icons/tray/cline-template.png` 为 88×88 RGBA 彩色线条图（`file`/`sips` 显示 88 x 88；像素直方图主色为深蓝/宝蓝/青绿，非纯黑剪影）
- [x] 侧栏左上角、Dock、原 `AutoCline-icon.png` 未改
- [x] 启动正常；菜单栏观感请人工确认：应为彩色描边小人 + 气泡，气泡内部透出菜单栏底色

## 备注

- 图标文件名仍叫 `cline-template.png`（沿用旧路径减少改动），但内容已是彩色线条版，不再作 template 使用。
- 如需让菜单栏观感更清晰，可在保持 ~8% 边距前提下把 72→76 像素的有效图形再放大一点；当前 88×88 中有 72×72 有效图形。
