# iOS Safari 虚拟键盘适配 · 完整交接文档

> **文档性质**：一次性整合的「非常细致」交接文件，覆盖机制研究、迭代历程、当前源码真实状态、部署状态、部署 runbook、真机验证清单、待清理项与防坑铁律。
> **生成时间**：2026-09-01 17:39（GMT+8）
> **作者**：上一轮负责该问题的 agent（接手者请直接读本文，不要再翻分散的旧笔记）
> **一句话结论（务必先看）**：
> 1. 源码已改到「化繁为简」最终形态，但**从未重新构建部署**。
> 2. 线上容器与本地 `frontend/dist` 当前都还在跑旧的 `index-BxPLjv6E.js`（含 `--palink-vv-h` 蠕动逻辑）。
> 3. 交接时我对源码又清了两处会导致「消息列表仍可能蠕动 / 注释误导」的残留（见第 4 节「我刚做的清理」）。
> 4. 下一步只需「构建 + 提取镜像产物 + 替换本地 dist + 重启容器」，再让用户真机验证三件事。

---

## 0. 目标 / 现象（用户要什么）

移动端（iOS Safari 浏览器模式，iPhone）聊天页，用户点底部输入框、虚拟键盘弹起时，要达成 **ChatGPT / 豆包 App** 式体验：

| # | 目标 | 说明 |
|---|------|------|
| ① | 正文立即收缩到「屏幕高度 − 键盘高度」 | 键盘弹起瞬间，消息列表被压到键盘上方 |
| ② | 输入框紧贴键盘上沿（无空隙） | 不能有 Dock 高度的缝隙 |
| ③ | 整页不可上下拖 | 只有消息列表内部可滚，顶部栏/输入框永不被划走 |
| ④ | 键盘收起后完全恢复 | 无残留偏移 |

**历史现象（用户多次反馈）**：键盘弹起后「视口显示页面顶部」「页面可上下滑、先动再慢慢回弹」「输入框与键盘之间有空隙」「背景层一点一点变矮（蠕动）」。

> ⚠️ 用户的硬要求：**不要任何「N 毫秒检测一次 / 逐帧跟随」**，要一步到位、无蠕动。

---

## 1. 已确认的关键事实（机制基石，勿凭经验推翻）

| 事实 | 说明 / 来源 |
|------|------------|
| 用户在 **Safari 浏览器模式** 访问（非 Web App / 非 PWA） | 地址栏影响视口行为 |
| iOS 把虚拟键盘视为 **overlay** | 键盘弹起时**布局视口恒为 844 不变**，vh / svh / dvh **全部不响应键盘**（CSS 视口单位规范既定行为，非 bug） |
| `position:fixed` 在 iOS 锚定的是**可视视口（visual viewport）** | 键盘弹起后可视视口收缩到键盘上沿，所以 `bottom:0` 自然贴住键盘——**前提是可视视口确实被收缩了** |
| 真机实测 **shrink = 299** | `innerHeight(844) − visualViewport.height(545) = 299`，证明数据源可靠、收缩机制存在 |
| **`interactive-widget=overlays-content` 是禁用开关** | 规范语义＝「键盘不收缩任何视口」，恰好关掉本项目赖以生存的机制；已被移除 |
| MobilePager 槽位有 `transform`/`will-change` | 会创建 fixed 后代的包含块，使 `position:fixed` 失效——输入框必须 Portal 逃离 |
| 项目基础 `body` 规则是 `position:fixed; height:100%` | 全局布局依赖，改动需谨慎 |
| iOS 滚动补偿：`sy`（scrollY）≠ 0 是**正常机制** | iOS 弹键盘时靠滚动文档把输入框带进可视区，**不是故障**，不要针对它加锁 |
| **桌面 DevTools 键盘模拟 = Android 模型** | 它让「布局视口收缩」，与 iOS「布局视口恒定 + 可视视口收缩 + 必要时滚动文档」不同源 → **模拟通过是假阳性，只能真机验证** |

### 1.1 铁律（任何改动前先背下来）
1. `interactive-widget=overlays-content` 永远不该留（禁用视口收缩）。
2. 不要用「文档能否滚动」判断对错（`sy≠0` 正常）。
3. body 的定位**不能**随键盘状态切换（切换本身就是跳变源）。
4. 不要加 `mousedown preventDefault` + 手动 focus（阻断 iOS 可见性检查，反而藏起输入框）。
5. 不要加 JS 滚动锁 / 定期 `scrollTo(0,0)`（与 iOS 键盘滚动对抗）。
6. 不要 JS 硬算 body/root/shell 高度（副作用严重）。
7. **不要跟随 `visualViewport.height`**（iOS 阶梯式报告，任何跟随都蠕动）。
8. **只能用真机验证**。

---

## 2. 迭代历程（时间线，含每步结果 + 教训）

> 这一段是血泪史，接手者务必读完——里面的每一条「❌」都是用户实测否定的方案，不要再重蹈。

| # | 方案 | 结果 | 教训 |
|---|------|------|------|
| 3.1 | CSS 变量 `--palink-kb-vh` 驱动整链收缩 | ❌ | iOS 上 `visualViewport` 数值延迟/漏触发，检测失败不生效 |
| 3.2 | `visualViewport` resize 监听 + focus 后 150/250ms 轮询 | ❌ | 事件延迟或根本不触发；「要划一下才生效」 |
| 3.3 | body 转 `position:fixed + bottom:0`（靠 iOS 顶起） | ⚠️ 部分 | 成功让页面「下沉」到键盘上方，但仍全高、可上下滑、有空隙 |
| 3.4 | **哨兵元素实测高度**（`fixed bottom:0` 1px 隐藏元素，`getBoundingClientRect().top` = 键盘上沿） | ✅ 检测可靠 | 目前唯一在真机验证可靠的键盘检测手段，保留 |
| 3.5 | JS 直接 inline 锁 body/root/shell 高度 | ⚠️ | 桌面模拟正确，真机「视口显示顶部、滑动先动再归位」——与 iOS 键盘滚动对抗 |
| 3.6 | `mousedown preventDefault` + 滚动锁 | ❌ 严重 | **正是「视口显示顶部」元凶**，已回滚 |
| 3.7 | 输入框 React `createPortal` 到 `document.body` | ✅ | 逃离 MobilePager 的 transform 包含块，fixed 真正锚定视口——解决「输入框与键盘空隙」关键修复，保留 |
| 3.8 | 移动端 app-shell 改 `position:fixed + inset:0` | ✅ 方向对 | 桌面模拟正确，但 iOS 上 fixed 锚定哪个视口随版本变化、表现不一致 |
| 3.9 | 根因定位：移除 `interactive-widget` + 移除 body 定位抖动兜底 | ✅ 已改 | 解释「早期能测到→后期失效→视口显示顶部」；已部署 |
| 3.10 | 放弃 fixed，改「实测可视高度 → CSS 变量 → 容器高度」（100ms 写入 `--palink-vv-h`） | ⚠️ | 数据源可靠，但**背景层开始蠕动** |
| 4.0 | 高度状态机：预测终值 + 450ms 锁定窗口（试图消灭蠕动） | ❌ 仍蠕动 | iOS 键盘动画后 `vv.height` **阶梯式报告**（844→700→545），每级停留 >100ms，「锁定窗口」仍被逐级爬穿，**背景层一级一级变矮** |
| **最终** | **化繁为简：背景层恒定高度（100svh），正文用 `--palink-kb-vh` 仅两次离散写入，输入框退回 iOS 原生 `fixed bottom:0`** | ✅ 设计上排除蠕动 | 见第 4 节 |

### 2.1 「蠕动」根因（最重要的一课）
iOS 在键盘动画**之后**对 `visualViewport.height` / fixed 测量是**阶梯状分步报告**的（844→700→545，每级停留 >100ms）。**任何「跟随」数据源的方案**（轮询 / 逐帧 / 连续 N 帧稳定检测 / 锁定窗口）都会一级一级爬。
**通用结论**：对付阶梯数据源，「连续 N 帧不变」的稳定启发式在「台阶间距 ≥ N 帧」时必失效，必须用「背景层恒定 + 只做离散单跳校正」。

---

## 3. 最终架构（化繁为简）— 设计总览

把「收缩」拆成**不可蠕动**与**可单次校正**两部分：

| 职责 | 交给谁 | 为什么不可蠕动 |
|------|--------|----------------|
| 背景层（html/body/#root/.palink-app-shell）高度 | **恒定 `100svh`** | 不消费任何键盘数据，物理上无蠕动可能 |
| 正文消息列表收缩 | `.rp-chat-area { max-height: var(--palink-kb-vh) }` | 变量只写**两次**（focus 估算 + 400ms 哨兵校正），单跳非跟随 |
| 输入框贴键盘上沿 | iOS 原生 `position:fixed; bottom:0`（Portal 到 body 逃出 MobilePager 包含块） | 浏览器内部行为，零 JS 参与 |
| dock 栏隐藏 | `html.palink-kb-open`（JS 检测）+ `html:has(:focus)`（CSS 纯兜底）双保险，淡出动画 | 与布局无关 |
| 整页不可滚 | `html/body/#root { overflow:hidden; overscroll-behavior:none }` + touchmove 手势阻断 | 滑动只发生在消息列表内部 |

配套约束：`html, body, #root { height:100%; overflow:hidden; overscroll-behavior:none }` —— 文档整体不可滚，顶部栏和输入框永不被划走。

---

## 4. 当前源码真实状态（最终快照）

> ⚠️ **部署状态**：下列源码改动**全部未构建部署**（见第 6 节）。线上跑的是旧 `index-BxPLjv6E.js`。

| 文件 | 精确路径 | 关键改动 | 状态 |
|------|----------|---------|------|
| 入口 HTML | `frontend/index.html` | viewport **已移除 `interactive-widget=overlays-content`**（仅留注释说明为何移除） | ✅ 核心 |
| 高度 Hook（核心） | `frontend/src/hooks/useVirtualKeyboard.ts` | ① 哨兵检测 + `palink-kb-open` 类；② **`--palink-kb-vh` 仅在 focus 写一次估算值 + 400ms 哨兵校正一次**（两次离散写入，无跟随）；③ 滚动压制（事件驱动，非轮询）；④ touchmove 手势级阻断（文档纹丝不动，不影响 MobilePager 切页 / dock 拖动） | ✅ 核心 |
| 移动端样式 | `frontend/src/index.css` | `@media (hover:none) and (pointer:coarse)` 下：背景/shell 恒定 `100svh`；`.rp-chat-area { max-height: var(--palink-kb-vh) }`；dock 隐藏动画；`touch-action:none`；`html:has(:focus)` 兜底 | ✅ 核心 |
| 输入框 | `frontend/src/components/views/character/chat/ChatInputArea.tsx` | 移动端 **`createPortal(..., document.body)` + `fixed left-0 right-0 bottom:0`** | ✅ 核心 |
| Dock 栏 | `frontend/src/components/ui/custom/Sidebar.tsx` | dock 由 `fixed` 改为 **`absolute bottom-0`**，锚定 shell（shell 满屏，视觉等价；避免与输入框坐标系冲突） | ✅ 核心 |
| 诊断角标（临时） | `frontend/src/App.tsx` | 左上角 5 行数字角标（`kb/o/f/sy/vv/ih/s/var/body/shell/os/shrink`） | ⚠️ 临时，待删 |
| 构建忽略 | `frontend/.dockerignore` | 补 `dist_*` `dist.*` `dist-*`，排除 97 个 / 3.9GB 历史产物目录 | ✅ 构建提速 |

### 4.1 「我刚做的清理」（本次交接时新增，确保源码干净可构建）
1. **`useVirtualKeyboard.ts`**：删除了旧的 `commitKeyboardState` 里**连续写 `--palink-kb-vh` 的代码**（300ms 轮询每拍写成当前实测值 → 消息列表阶梯式变矮）。现在该变量**只**由下方的独立 `useEffect` 写两次（focus 估算 + 400ms 校正）。失焦时仍清理变量。⇒ 消息列表蠕动从机制上消除。
2. **`index.css`**：修正了 1338 行附近一段**过期注释**（仍写着「每 100ms 把 visualViewport 写进 `--palink-vv-h`」），改为准确描述「背景恒定 + 正文两次离散写入」的最终方案。

> 注意：源码中已**无任何 `--palink-vv-h`**（`App.tsx` 角标里读它只会显示 `NONE`，属已知小瑕疵，不影响功能，清理时一并处理）。

---

## 5. 文件位置索引（精确路径）

```
D:\项目\Palink-AI\
├── IOS_KEYBOARD_HANDOVER.md                                  ← 本文（完整交接）
├── frontend\
│   ├── index.html                                            ← 已移除 interactive-widget
│   ├── .dockerignore                                         ← 已补 dist_* 排除
│   └── src\
│       ├── hooks\useVirtualKeyboard.ts                       ← 核心 Hook（已清理冗余写入）
│       ├── index.css                                         ← 移动端键盘适配样式（约 1338–1463 行）
│       ├── App.tsx                                           ← 临时诊断角标（待删）
│       └── components\
│           ├── views\character\chat\ChatInputArea.tsx        ← 输入框 Portal + fixed
│           └── ui\custom\Sidebar.tsx                         ← dock 改 absolute
├── frontend\dist\                                            ← 【当前仍是旧构建 index-BxPLjv6E.js，未更新】
│   └── index.html 引用 index-BxPLjv6E.js
└── (容器) palink-ai-frontend-1                               ← 【当前也跑 index-BxPLjv6E.js】
```

> 旧版源码快照（若需对照）可能在 `backup/mobile-kb-20260831-183245/` 与 `backup/newapi-gateway-20260831-172355/`，但**不要**从这些目录恢复键盘适配逻辑——它们比当前源码旧。

---

## 6. 部署状态（最关键的一块）

### 6.1 事实核查（2026-09-01 17:39 实测）
- 本地 `frontend/dist/index.html` → 引用 **`index-BxPLjv6E.js`**
- 该旧包内 **仍含 `--palink-vv-h`**（蠕动逻辑）→ 确认是旧版
- 容器 `palink-ai-frontend-1`（Up / healthy）经 `http://localhost:3000/` 探测 → 同样返回 **`index-BxPLjv6E.js`**
- 源码 `git diff` 显示 `useVirtualKeyboard.ts`(+252)/`index.css`(+151)/`ChatInputArea.tsx`/`App.tsx`/`index.html` 均有未提交改动，但 **dist 哈希未变 ⇒ 从未重新构建**

**结论：修复源码已就绪，但线上 = 旧蠕动版本。必须构建部署后用户才能真机验证。**

### 6.2 部署 Runbook（按顺序，缺一不可）
> 教训：本项目前端**有遗留 bind mount** `frontend/dist → /usr/share/nginx/html`（ro），所以只 `docker compose up -d` 不生效，**必须把新产物落到本地 `frontend/dist` 再重启容器**。

```powershell
# 1) 进入项目（用 PowerShell，docker 在 cmd 可能找不到）
cd D:\项目\Palink-AI

# 2) 重新构建前端镜像（必须 --no-cache，BuildKit 常缓存住 COPY 层导致产物是旧的）
docker compose build --no-cache frontend

# 3) 从镜像提取真身产物（create 不带 compose 的 volume，取到的是镜像内真身）
docker create --name tmp palink-ai-frontend:latest
docker cp tmp:/usr/share/nginx/html/. ./dist_new_$(Get-Date -Format yyyyMMdd_HHmmss)
docker rm tmp

# 4) 替换本地 dist 并重启容器
docker stop palink-ai-frontend-1
Rename-Item frontend\dist "dist_bak_$(Get-Date -Format yyyyMMdd_HHmmss)"
Rename-Item "dist_new_XXXX" frontend\dist     # 用上面实际生成的目录名
docker start palink-ai-frontend-1

# 5) 验证 HTTP 返回内容（务必验证，别只看 Build 成功）
docker exec palink-ai-frontend-1 curl -s http://localhost:8080/ | Select-String "index-"
#    确认返回的 index-*.js 是【新哈希】，不再是 BxPLjv6E
```

> 容器内 **有 curl**（healthcheck 用它）；`busybox wget` 参数不兼容，用 curl。
> nginx 正则 `{n}` 量词会静默失效，路由用前缀 `location /xxx/` 而非正则。
> 磁盘：`frontend/dist*` 历史目录已 97 个 / 3.9GB，**定期手动清理**（本环境禁 `rm -rf`，用 PowerShell `Remove-Item` 逐目录）。

### 6.3 验证部署成功的最小判据
- `docker exec ... curl` 返回的新 `index-*.js` 哈希 ≠ `BxPLjv6E`
- 新包内**不再含** `--palink-vv-h`（grep 空）
- 让用户**无痕模式**硬刷新访问 `http://<电脑IP>:3000`，进角色聊天页点输入框

---

## 7. 真机验证清单（让用户测这三件事）

让用户在 **iPhone Safari** 上（无痕标签，避免缓存）打开聊天页，点输入框弹键盘：

| 验证项 | 期望表现 | 若不符合 → 排查 |
|--------|----------|----------------|
| ① 输入框贴键盘 | 输入框紧贴键盘上沿，无 dock 高度缝隙 | 看角标 `o`(应=1) / `s`(应<ih)；检查 ChatInputArea Portal + fixed 是否生效 |
| ② 正文一步收缩 | 键盘弹起瞬间消息列表**直接**压到键盘上方，**不逐级变矮** | 看角标 `shell`（应恒=844，不变矮=背景不蠕动）；`--palink-kb-vh` 由两次写入驱动 |
| ③ 整页不可滑 | 手指拖非列表区，页面纹丝不动；只有列表内可滚 | 看 `sy`（非0正常）；检查 touchmove 手势阻断 + overflow 锁定 |
| ④ 收起恢复 | 键盘收起后页面完全复原 | 检查 `onFocusOut` 清理 `--palink-kb-vh` |

### 7.1 诊断角标 5 行解读（来自 `App.tsx`，问题解决后删除）
```
kb:键盘高度 o:检测开关(1=开) f:输入框聚焦(1=是) sy:文档滚动(非0正常)
vv:visualViewport高 ih:window.innerHeight s:哨兵实测可用高
var:--palink-vv-h(现为NONE,源码已不写) body:body实际高 shell:app-shell实际高
os:iOS版本 shrink:innerHeight-visualViewport.height (关键判据,≈键盘高)
```
**判断顺序**：
1. `shrink` ≈ 299 → 可视视口已收缩（数据源正常）；≈0 → 视口没收缩（查 interactive-widget 是否残留、媒体查询是否匹配）。
2. **`shell` 是否恒 = 844（不变矮）** → 这是化繁为简的核心判据：背景层不蠕动。
3. `o`/`s` → 检测链是否工作。

---

## 8. 待清理项（问题彻底解决后执行）

- [ ] 删除 `frontend/src/App.tsx` 诊断角标（`kbDebugText` 状态 + `[data-palink-kb-debug]` JSX + 读取 `--palink-vv-h` 那行）
- [ ] 删除 `useVirtualKeyboard.ts` 中 `KbTitleMark ⌨` 标题诊断标记
- [ ] 复核 `commitKeyboardState` 旧轮询 machinery 是否还有必要（当前它仍驱动 `palink-kb-open` 类；若保留，确保它**不再写** `--palink-kb-vh`——本次已处理）
- [ ] 复核 `index.css` 媒体查询块与 `html.palink-kb-open` 各规则最终去留
- [ ] 清理 `frontend/dist*` 历史目录释放磁盘（97 个 / 3.9GB）

---

## 9. 防坑铁律（写在代码注释里也行，但先记心里）

1. **不要**加 `interactive-widget=overlays-content`（禁用视口收缩，见 1.1）。
2. **不要**随键盘状态切换 `body` 的 `position`（跳变源，见 1.1）。
3. **不要** `mousedown preventDefault` + 手动 focus（藏起输入框，见 3.6）。
4. **不要** JS 滚动锁 / 定期 `scrollTo(0,0)`（与 iOS 键盘滚动对抗，见 3.5）。
5. **不要** JS 硬算 body/root/shell 高度（见 3.5）。
6. **不要**跟随 `visualViewport.height`（阶梯式报告→蠕动，见 2.1）。
7. **不要**用桌面 DevTools 键盘模拟当验证（Android 模型，假阳性，见 1）。
8. **只能真机验证**。
9. 修改涉及 `index.css` 时注意 `html/body/#root` 全局高度、`.palink-app-shell` 定位影响所有移动端页面，改动需回归。
10. 每次**只改一件事**，真机验证后再改下一件；不要一次叠加多个机制。

---

## 10. 给下一个 AI 的接手提示词（直接复制）

> 请先阅读 `D:\项目\Palink-AI\IOS_KEYBOARD_HANDOVER.md`（完整交接，含机制、迭代史、当前源码状态、部署 runbook），然后接手以下任务。
>
> **背景**：Palink-AI 前端（React + Vite + Tailwind），移动端 iOS Safari 浏览器模式，聊天页输入框聚焦、虚拟键盘弹起时，需同时成立：① 正文立即收缩到「屏幕高度−键盘高度」；② 输入框紧贴键盘上沿无空隙；③ 整页不可上下拖，只有消息列表内部可滚。
>
> **当前状态**：源码已改到「化繁为简」最终形态（背景层恒定 100svh；正文 `--palink-kb-vh` 仅两次离散写入；输入框 Portal 到 body + fixed bottom:0；dock absolute + 隐藏）。**但从未构建部署**，线上 `palink-ai-frontend-1` 仍跑旧的 `index-BxPLjv6E.js`（含 `--palink-vv-h` 蠕动逻辑）。
>
> **你的任务**：
> 1. 按文档第 6.2 节 runbook 构建并部署（build --no-cache → 提取镜像产物 → 替换本地 dist → 重启容器 → curl 验证新哈希）。
> 2. 让用户无痕模式访问 `http://<电脑IP>:3000`，进角色聊天页点输入框弹键盘。
> 3. 报左上角角标数字（重点 `shrink` 与 `shell`）。判据见第 7.1 节。
> 4. 验证三件事（贴键盘 / 一步收缩不蠕动 / 整页不可滑）后，按第 8 节清理诊断角标与临时逻辑。
>
> **铁律**：不要加 `interactive-widget=overlays-content`；不要切 body position；不要 mousedown preventDefault；不要 JS 滚动锁；不要跟随 visualViewport.height；只能真机验证。

---

## 11. 参考链接（研究产出）

- agent-portal PR #644（fixed inset:0 跟踪 visual viewport）：https://github.com/meawoppl/agent-portal/pull/644
- ios-pwa-keyboard-fix ARCHITECTURE.md：https://github.com/Crscristi28/ios-pwa-keyboard-fix/blob/main/docs/ARCHITECTURE.md
  - 核心观点：**Layout matters as much as the hooks——不改布局，装库也没用**
- ios-pwa-keyboard-fix COMMON-MISTAKES.md：https://github.com/Crscristi28/ios-pwa-keyboard-fix/blob/main/docs/COMMON-MISTAKES.md
- iOS 软键盘遮挡底部输入框解决报告（jishuzhan）：https://jishuzhan.net/article/2091345902165180418
  - 备选终极公式（若 fixed 仍无效）：`keyboardInset = max(0, inputRoot.bottom - (vv.offsetTop + vv.height))` 作输入框动态 `padding-bottom`

---

*— 文档结束。接手者务必先读完第 0/1/2/4/6 节再动手。*
