# STATUS — AutoCline 侧栏 Home 按钮换成实心品牌标志（2026-11-06）

状态：**完成**（已打包并覆盖安装，截图逐像素验证通过）

## 结果速览

| 项 | 值 |
| --- | --- |
| 新 build 号 | `CFBundleVersion` **38 → 39 → 40**（`CFBundleShortVersionString` 仍为 `1.1.0`） |
| 安装路径 | `/Applications/AutoCline.app`（覆盖安装，ad-hoc 签名 `satisfies its Designated Requirement`） |
| 安装后实测 | `PlistBuddy Print :CFBundleVersion` = `40`；`cline-app` + 后端 + hub daemon 均正常拉起 |
| 托盘 | **未被回退**：`icon_as_template(false)` 仍在（`main.rs` 2 处），`cline-template.png` 未改 |
| Home 按钮 | `<ClineLogo className="size-5" />`（`/icon.svg` 的 CSS mask）→ `<img src="/autocline-brand-icon-transparent.png">` 实心彩标、不用 mask |

> 39 是带白底缺陷的中间产物；发现并修好白底问题后重出 **40**，所以最终安装的是 40。

## 为什么是 40 而不是 39（关键修复）

39 直接用了 `webview/public/autocline-brand-icon.png`。该文件是 **RGB、无 alpha、白底**
（`magick`: `corner=pixel{0,0}=srgb(255,255,255)`，1024×1024）。在侧栏上渲染成一个 44×44 设备的
**白色方块**，等于在侧栏贴了张白色贴纸：

- 浅色主题：侧栏实测 `#f9f9fb`，白块勉强能看但很突兀；
- 深色主题：侧栏 token `--sidebar` → `--surface-2` = `--neutral-2` = **`#18191b`**，白块会非常刺眼。

截图逐像素对比（同一 Home 按钮区域，截图 2x @ `-R0,33,1470,863`）：

| | 近白像素数（min RGB ≥ 250） | 白块 bbox |
| --- | --- | --- |
| build 39（白底 PNG） | **847** | 44×44（`x 23–67, y 45–89`） |
| build 40（透明 PNG） | **2** | 仅按钮边缘高光，无白块 |

## 改了哪些文件

1. `apps/examples/desktop-app/webview/components/agent-sidebar.tsx`（Home 按钮，约 917–944 行）
   - `<ClineLogo className="size-5" />` → `<img className="size-6 shrink-0 select-none object-contain dark:invert" src="/autocline-brand-icon-transparent.png" />`
   - 删掉已不再使用的 `ClineLogo` import。
   - **不用 CSS mask**（用 mask 就只剩单色剪影，填色/彩色会丢）——这是 harness 里明确要求的一条。
   - 注释里写清了为何用透明版、为何 `dark:invert`。
2. `apps/examples/desktop-app/webview/public/autocline-brand-icon-transparent.png`（**新增**）
   - 由现有实心彩标 `webview/public/autocline-brand-icon.png` 加工而来：保留原填色（深蓝头部 + 宝蓝气泡 + 青绿耳麦），
     把外圈白底 flood-fill 成透明，再去掉四周空白、缩放到 640×637、8-bit RGBA（color-type 6）。
   - 原 `autocline-brand-icon.png` **未改**（Dock/About 等仍用它，且它作为 `include_bytes!` 资源一起打包）。
   - 托盘用的线条版 `AutoCline-icon-line-color-transparent.png` **未使用**：线条版在 24 CSS px 下太空、看不清。
3. `apps/examples/desktop-app/webview/components/agent-sidebar.test.tsx`
   - 新增 `renders the filled AutoCline brand mark (img, not a masked glyph)`：断言 Home 里是 `<img>`、`src` 指向透明版、
     `className` 含 `dark:invert`、不存在 `style*=mask`。
4. `apps/examples/desktop-app/src-tauri/Info.plist`
   - `CFBundleVersion` `38` → `39` → `40`。

## 深色主题的对比度（为什么加 `dark:invert`）

标志本身是近似黑（实测实心区均值约 `rgb(35,67,78)`）。在 `#18191b` 侧栏上，按 WCAG 相对亮度算对比度：

| 方案 | 对比度中位数 | 低于 3:1 的像素占比 |
| --- | --- | --- |
| 原色放深色侧栏 | **1.61:1** | **84%**（几乎看不见） |
| 原色放浅色侧栏 | 5.96:1 | 42% |
| `invert` 放深色侧栏 | **10.01:1** | **2%** |

`dark:invert` 只在 `.dark` 下生效（`webview/lib/theme.ts` 用 `document.documentElement.classList.toggle("dark", …)`），
浅色主题完全不受影响；反色后宝蓝气泡变成暖橙，仍是彩色而不是剪影。

## 验证过程（都是实测，不是推断）

1. 单测：`bunx vitest run webview/components/agent-sidebar.test.tsx`
   - 改动后：**31 passed / 2 failed**；改动前（`git stash` 掉这两个文件）：**30 passed / 2 failed**。
     两个失败是既有问题（`groups Cline Account, Local, and BYOK under a Provider row`、
     `uses a compact overlay-friendly width in collapsed settings`），与 Home 按钮无关；新增的那条测试通过。
2. webview 构建：`bunx next build`（`webview/out`）后确认
   - `webview/out/autocline-brand-icon-transparent.png` 存在且是 RGBA 640×637；
   - 编译出的 CSS 里有 `dark\:invert:is(.dark *){--tw-invert:invert(100%);filter:…}`。
3. 打包：`bun run scripts/package-desktop.ts --platform mac --allow-unsigned-mac`（日志 `/tmp/autocline-package-build40b.log`）。
4. 安装后的二进制里逐项核对（Tauri 把资源 brotli 压缩后嵌在 `Contents/MacOS/cline-app`，必须解压后再查）：
   - JS chunk 里：`" select-none object-contain dark:invert",draggable:!1,src:"/autocline-brand-icon-transparent.png"`
   - CSS chunk 里：`dark\:invert:is(.dark *){--tw-invert:invert(100%)…}`
   - 内嵌 PNG：286416 字节、`640×637`、bitDepth 8、**colorType 6（RGBA）**
5. 真机截图（`screencapture -R0,33,1470,863`，Retina 2x）后按像素还原 Home 按钮：深蓝实心头部 + 宝蓝气泡轮廓 + 青绿耳麦，
   四周就是侧栏底色 `#f9f9fb`，**没有白块**（近白像素 847 → 2）。

## 明确没有改的

- 托盘：`src-tauri/src/main.rs` 的 `icon_as_template(false)`、`src-tauri/icons/tray/cline-template.png` 全部保持上次托盘改动的状态。
- Dock / 程序坞 / About / 窗口图标（`icons/*`）、`autocline-brand-icon.png`、`assets/brand/*` 未动。
- 侧栏其它文案、其它按钮、provider、webview 其它品牌图。
- Windows / Linux 分支。

## 已知取舍

- `dark:invert` 是**整图反色**，所以深色主题下宝蓝气泡会变成暖橙色（浅色主题不变）。
  这么做是为了在 24 px 下保住可辨识度：换成“把所有深色像素改成 `currentColor`”的做法，会丢掉气泡和头部的层次。
  若后续想要“深色下也保持宝蓝”，需要另出一份深色专用 SVG/PNG 再按主题切换 `src`。
- Home 按钮实际显示区域仍是 `size-6`（24 CSS px），但透明版裁掉了原图四周留白，
  所以换成透明版后**图案在视觉上比原来略大**（同尺寸下更满）。若要完全还原原来的视觉大小，可加 `p-0.5`。
