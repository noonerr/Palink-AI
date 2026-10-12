# iOS 虚拟键盘适配 · 交接文档 v2（K4→K17 真实调试记录）

> **文档性质**：在 `IOS_KEYBOARD_HANDOVER.md`（v1）基础上的**全面更新**。v1 的核心前提「iOS 把 `position:fixed;bottom:0` 顶到键盘上沿」已被 **iOS 26/27 真机证伪**，v1 的「化繁为简」方案因此在用户设备上**完全失效**。v2 记录从 v1 部署后开始的真实排障过程（K4→K14）、每次真机数据、当前代码真实状态与未解决问题。
> **生成时间**：2026-09-02 02:15（GMT+8）；02:45 K9；03:05 K10；**03:30 K11**；**03:55 更新 K12**；**04:10 K13**；**04:25 K14**；**05:25 K15+沉浸感 meta**；**06:00 K17**
> **作者**：上一轮 agent（接手者请直接读本文 + 以下标出的源码文件，不要翻分散的聊天记录）
> **当前线上版本**：**K17 =** **`index-d_yhXtPw.js`**（已部署，容器 healthy，**真机待验证**）
> **一句话结论（务必先看）**：
>
> 1. 问题根因是 **iOS 26/27 Safari/WebKit 的视口行为回归**（WebKit Bug 304976）：键盘弹起时**只有 visual viewport 收缩，layout viewport 不变**，`position:fixed`/`absolute` 的 `bottom` 继续锚定**原布局视口底部** → 输入框被键盘盖住 → 必须 JS 主动抬升。
> 2. **目标行为（用户 K9 拍板）**：点击输入框 → 渲染区域**一步到位**变成「屏幕高 − 键盘高」，动画期间**零写入、零过渡、零跟随**；**只有角色聊天页适用，登录页与对话主页（ChatViewMobile）明确排除**。
> 3. **K11 判死旧路（用户真机角标数据）**：`cache:312 / kbvh:338 / vv:333` 三个数同屏对不上——键盘高度随输入法切换变化（真机 299/312/322 都出现过），**任何「focus 瞬间估算 + 事后校正」都必然产生多次布局跳动 = 蠕动改不掉**。K8/K9/K10 的估算/缓存/校正链全部废弃。
> 4. **K11 唯一动作**：键盘升起并**静止**（kbvh 数值 200ms 无变化）后，用真实键盘上沿 `round(vv.height+offsetTop)` **一次性**应用布局（变量与 `palink-kb-open` 类原子同写）；升起过程页面保持关闭态、绝不动作（`risenOnce` 门控）；收起（vv 越回阈值上/失焦）一步还原。代价（平台事实）：输入框在键盘升起期间（\~0.3-0.5s）被键盘盖住，键盘到位瞬间整体跳到终位——Safari 不暴露键盘动画事件，「贴着键盘平滑滑」物理上做不到（社区经验一致：只能 vv 监听重定位）。
> 5. 下一步：真机验证 K11（判据见第 6 节）。若仍有可见动作，按第 10 节残余风险逐个排查。

***

## 0. 目标 / 现象（用户要什么）

**K9 拍板后的最终口径（2026-09-02，用户原话）**：
「点击输入框，虚拟键盘弹起来，页面不存在慢慢适应而上下蠕动的效果，而是**一步到位只跟随输入法高度**，而且**实际渲染区域也只有屏幕高度-输入法高度**。**登录页面和对话主页（中间的输入框）排除**。」

K10 前实测反馈：「没区别，还是蠕动降低页面高度」→ 定位到第 3 条真凶并修复。

即（仅角色聊天页适用）：

| # | 目标                 | 说明                          |
| - | ------------------ | --------------------------- |
| ① | 输入框上移并**紧贴键盘上沿**   | 无 Dock 高度缝隙，无键盘遮挡           |
| ② | 正文收缩到「屏幕高度 − 键盘高度」 | 实际渲染区域 = 屏幕高 − 键盘高，一步到位     |
| ③ | Dock 下移消失          | 键盘弹起时 Dock 让位（240ms 淡出动画保留） |
| ④ | 整页不可上下拖            | 只有消息列表内部可滚，顶部栏/输入框永不被划走     |
| ⑤ | 键盘收起后完全恢复          | 无残留偏移                       |
| ⑥ | **零蠕动零过渡**         | 不许有任何「慢慢适应」——全部同帧瞬时到位       |

**硬约束（用户原话）**：实际显示/渲染区域**绝不能大于**「屏幕高度 − 虚拟键盘高度」。

**用户明确否定的东西**（多次强调）：

- 不要「N 毫秒检测一次 / 逐帧跟随」→ 会蠕动（K6/K7 已证实）

- 输入框**不要**停在屏幕底部被键盘盖住（那是 iOS 26/27 默认行为）

- 不要任何渐进过渡/追赶（K7 的 180ms transition 桥接也被否定）

***

## 1. 根因（已被真机证实的 iOS 26/27 行为变化）

### 1.1 关键机制（v1 结论 → v2 推翻）

| v1 结论                                                  | v2 真机结论                                                                                                             |
| ------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------- |
| iOS 键盘弹起时，`position:fixed;bottom:0` 会被系统顶到键盘上沿（可视视口收缩） | ❌ **iOS 26/27 已改**：键盘弹起只缩 visual viewport，**layout viewport 不变**，fixed/absolute 的 bottom 继续锚定**原布局视口底部** → 输入框被键盘盖住 |
| 哨兵元素（`fixed bottom:0`）能测到键盘上沿                          | ❌ 哨兵测出的是**布局视口底边**（真机 `s:654` ≈ `ih:655`，而非键盘上沿 356）                                                                |
| 背景层恒定 100svh + 输入框 fixed bottom:0 即可                   | ⚠️ 背景层恒定**是对的**（真机 `body/shell:655` 恒定不蠕动），但输入框必须**JS 主动抬升**                                                        |

### 1.2 证据与参考

- **WebKit Bug 304976**（<https://bugs.webkit.org/show_bug.cgi?id=304976，2026-01）：iOS> 26 Safari 键盘弹起时 layout viewport 不变、fixed 底部元素下露出内容。Apple 官方承认「无可靠纯 CSS workaround」。

- **Apple 开发者论坛 800154**：iOS 26 键盘收起后 `visualViewport.offsetTop` 不归零等回归。

- **`interactive-widget`** **meta 在 Safari 始终不支持**（WebKit Bug 259770）——此路不通。

- 真机（iPhone，**iOS 27.0**）：`shrink = innerHeight − vv.height = 655 − 356 = 299` = 键盘高，证明 **vv 数值可靠收缩**，是唯一可靠的测量源。

### 1.3 真机关键数据（iOS 27.0，竖屏）

```
ih(innerHeight)=655  vv(visualViewport.height)=356  ot(offsetTop)=0
shrink=299  →  键盘高 ≈ 299px，键盘上沿（布局 y 坐标）= 356
s(哨兵 fixed bottom:0 顶)=654  →  证实 fixed 不再被顶起（=布局底边）
sy(scrollY)=0  →  文档未滚动（整页锁定有效）
body=655  shell=655  →  背景层恒定，无背景蠕动
```

***

## 2. 完整调试历程（K4→K10，每轮真实代码 + 数据 + 结果）

> v1 部署的是「化繁为简」（旧 `index-BxPLjv6E.js`）。v2 的 K4 起是在其基础上为 iOS 26/27 重构。**所有哈希均为真实构建产物。**

| 版本                                  | 核心改动                                                                                                                                                                                                                                                                                                                                                                                                                         | 真机角标数据                                     | 结果 / 教训                                                                                                                                                                       |
| ----------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **K4** `index-vWpvkaJi.js`          | ① `useVirtualKeyboard.ts`：400ms 校正从哨兵改 `vv.height+offsetTop`；② `ChatInputArea`（**仅角色聊天页**）输入框 `bottom: 0→calc(100% - var(--palink-kb-vh))`；③ CSS 兜底同步 calc                                                                                                                                                                                                                                                                   | 未收集到                                       | ❌ 用户：完全没解决。原因：用户测的是**主聊天页**，修复只装在**角色聊天页**；且 `kbvh:NONE`（focusin 用 `activeElement` 在 iOS 延迟一拍 → 误判未聚焦 → 变量从不写入）                                                               |
| **K5** `index-CsgUqm_b.js`          | ① focusin 改 **`e.target`** 判断；② 主聊天页也接入抬升 + 留白修正；③ CSS 变量兜底 300px；④ 角标加 `kbvh/cb/版本号`                                                                                                                                                                                                                                                                                                                                        | `kbvh:423 ≠ vv:356`                        | ⚠️ 400ms 校正采到动画半途值，输入框被挡 67px                                                                                                                                                 |
| **K6** `index-B9bwo_pR.js`          | kbvh 键盘打开期间持续更新（vv resize rAF + 300ms 轮询）                                                                                                                                                                                                                                                                                                                                                                                    | `kbvh` 能到 356                              | ✅ 终值精确，「比之前好得多」；但「依旧有一点小蠕动」——追 vv 阶梯值                                                                                                                                         |
| **K7** `index-B6yJ4A-D.js`          | 给 bottom / max-height 加 180ms transition 桥接                                                                                                                                                                                                                                                                                                                                                                                  | —                                          | ❌ 「依旧如此」。蠕动不是阶梯本身，是「持续追赶」这个行为                                                                                                                                                 |
| **K8** `index-BuZLH-6g.js`          | 「静止 + 稳定校正」：focus 瞬间写估算 `innerHeight−300`，动画期间不写，250ms×2 稳定后写终值                                                                                                                                                                                                                                                                                                                                                              | 需真机再验证                                     | ❌ 「不行，算了」。复盘：输入框被 `:has(:focus)` !important 钉死（React 切 bottom 是死代码）；**稳定检测的收起分支会在键盘起步延迟窗口误触发 → 中途还原再重封顶**（K10 才定位的真凶）；加上 max-height 不可插值瞬跳、dock 动画、瞬移三者相位错开                   |
| **K9** `index-BCXY41pI.js`          | **一步到位（用户拍板）**：① focusin（触屏 only）同帧写 `--palink-kb-vh`（localStorage 缓存 `palink-kb-height`，无缓存 300）+ 同帧挂 `palink-kb-open`；② 删全部键盘 transition；③ 稳定检测仅不一致时改写一次；④ **排除范围**：登录页自然隔离；对话主页——抬升规则限 `body > [data-palink-chat-composer]`、封顶只留 `.rp-chat-area`、`composerBottomStyle` 恒回 dock、adapter 留白冻结、App 不再传 `keyboardHeight`                                                                                                      | 待真机验证                                      | ❌ 用户：「**没区别，还是蠕动降低页面高度**」。复盘：K9 **保留了 K8 的收起分支结构**（kbvh > ih−60 即还原）——键盘起步延迟 >250ms 时检测拍落进该区间 → 中途还原（清变量+摘类 → 消息区解封顶=页面高度回弹）→ 键盘升起后再重封顶 = 「降→回→降」蠕动；且 `:has(:focus)` 兜底与类双轨并存 |
| **K10** `index-B-tUicDq.js`         | **修蠕动真凶**：① 稳定检测加 **`seenOpen`** **门控**——见到键盘升过阈值（kbvh ≤ ih−60）之前只观察绝不动作；见过升起后 vv 退回阈值下才算收起 → 一步还原；focusin 后 1.5s 键盘始终没出现（外接键盘兜底）才撤销估算布局；② **删除** **`:has(:focus)`** **兜底块**（dock 隐藏 + composer 抬升）——「键盘布局唯一开关 = `palink-kb-open` 类」，消除双轨接力跳 + 「收起键盘但焦点仍在」时输入框悬空；③ 消息区底部留白改**类同步**（`html.palink-kb-open .rp-chat-area { padding-bottom: 112px !important }`，React 内联留白随检测链晚 \~100-300ms 会多一步）；④ 角标升 `B:K10`                  | 用户角标：`cache:312 / kbvh:338 / vv:333` 三数对不上 | ❌ 用户：「依旧是蠕动」。**判死估算/缓存/校正整条路**：键盘高度随输入法切换变化（真机 299/312/322 都出现过），任何「先预估再修正」必然多次跳动；且 K10 角标 cb:575 实为量到对话主页被排除的 composer（querySelector 未加 `body >`），误读                         |
| **K11** `index-DgaFAWis.js`（**当前**） | **架构重构：单次写入，删估算/缓存/校正**：① focusin（触屏 only）只启动观察器，**不写任何布局**；② 100ms 轮询 + kbvh 数值静止判定（200ms 无变化）→ 用真实键盘上沿 `round(vv.height+offsetTop)` **一次性**写 `--palink-kb-vh` + 挂 `palink-kb-open`（原子同写）；③ `risenOnce` 门控保留（升起前绝不动作/还原）；④ **localStorage 缓存** **`palink-kb-height`** **已删**、300 估算已删、focusin 估算已删；⑤ 收起：vv 越回阈值上（键盘 \~95% 收回）或失焦 → 一步还原；⑥ 键盘已开着时聚焦（换输入框）同帧直接应用，避免闪烁；⑦ 角标 `B:K11`，cb 改量 `body > [data-palink-chat-composer]` | 待真机验证                                      | ⏳ 已部署（2026-09-02 03:30）。**代价（平台事实）**：输入框在键盘升起期间（\~0.3-0.5s）被键盘盖住，键盘到位瞬间整体一步跳到终位——Safari 不暴露键盘动画事件，社区经验一致只能 vv 监听重定位，「贴着键盘平滑滑」物理上做不到                                           |

\| **K12** `index-BsNByJOE.js`（**当前**） | **用户澄清后修正**：「主页=最下面是输入框的页面」也要跟键盘弹起（K9 的「对话主页排除」被 K12 对话推翻）；且 iOS 键盘顶起页面时底部露出的条必须跟主页主题色。① 抬升规则放宽回 `html.palink-kb-open [data-palink-chat-composer]`（两个页面底部 composer 都命中；登录页无该属性自然排除）；② 消息区封顶/留白加回 `[data-palink-msg-scroll]`（padding 96）；③ **html/body 背景色跟主题**（coarse 限定：亮 #F8FAFC / 暗 #020617，与 MobilePager 画布同源）——iOS 滚动补偿露出的「页面底下」不再是不跟主题的白底；④ **t=0 记忆值落位**：focusin 同帧用 localStorage `palink-kb-vh-last`（上次应用的键盘上沿 y）落位 + 挂类（同键盘=精确零校正；首次用 300+16 估算）→ 输入框全程高于键盘上沿 → iOS 无东西可露 → 零自动滚动/零视角漂移；静止（200ms）后按实测单次校正并更新记忆；risenOnce 门控与 1.5s 外接键盘兜底保留；⑤ 角标 `B:K12` | 待真机验证 | ⏳ 已部署（2026-09-02 03:55）。同键盘常规路径预期：点输入框 → 布局同帧到位（精确）→ 键盘升起 → 零漂移零露色；换键盘时可能有一次 ≤20px 的静止校正 |

\| **K13** `index-TaJnI-v-.js`（**当前**） | **原始基线（用户拍板「回到最原始的地方」）**：① useVirtualKeyboard 的键盘几何 effect 整体移除（无变量/无类/无 t=0 落位/无静止校正/无记忆缓存），滚动压制（scrollTo(0,0)）也移除——不再对抗系统，保留：检测链（仅供角标读数）、touchmove 手势阻断、⌨ 标题标记；② 聚焦态改纯 CSS：`:has(:focus)` → 输入框落到最底 bottom:0 + dock 下移淡出（无 JS 参与）；③ ChatInputArea/CharacterChat 的 isKeyboardOpen 内联分支冻结为关闭态；④ 保留：背景层恒定 100svh、全局滚动锁、touchmove、html/body 主题底色（#F8FAFC/#020617）；⑤ 角标 `B:K13` | 待真机观察 | ⏳ 已部署（2026-09-02 04:10）。**本版目的 = 观察 iOS 27 原生行为**：系统是否把 fixed bottom:0 顶到键盘上沿（v1 记录为被 Bug 304976 证伪）；页面是否被系统自动滚动/顶起；底部露色是否跟主题。用户看效果后再定方向 |

| **K14** `index-BDCYCUcE.js`（**当前**） | **修键盘区域染色断层（K13 真机截图定位）**：用户截图采样显示键盘配件条区域被染成 #26293a 而页面画布是 #020617。根因 = App.tsx 运行时仍把 html/body 内联背景设为旧渐变时代的 **#1a1a2e/#f5f5f5**，而 iOS 26/27 采样 html/body background-color 给顶部工具条与键盘区域（含配件条）染色 → 染色与页面画布不一致 = 断层。修复：① App.tsx themeBackground → **#020617/#F8FAFC**（与 MobilePager 容器同源）；② index.html 启动脚本 launchBackground 同步；③ index.html 静态 theme-color meta → #020617；④ manifest.json theme_color → #020617。**K13 原始基线其余一切未动**（无 JS 键盘布局代码） | 待真机验证 | ⏳ 已部署（2026-09-02 04:25）。K13 同时证实：**iOS 27.0 原生会把 fixed bottom:0 顶到键盘上沿**（系统行为可用，v1 的 Bug 304976 结论在 27.0 上不成立或已修复） |

> ⚠️ **注意**：**当前最新已部署** = **K17** `index-d_yhXtPw.js`（角标 `⌨K17`，键盘弹出时标题栏可见）。K13 原始基线（无 JS 键盘布局代码）一路保留至今，K14 只修染色源，K15 删角标 + 沉浸感 meta，K17 补 dock 安全区。

***

## 3. 当前源码真实状态（K11 快照，已部署）

| 文件          | 精确路径                                                             | 关键改动（K10 状态）                                                                                                                                                                                                                                                                                                                                                                                                        | 角色      |
| ----------- | ---------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------- |
| 键盘 Hook（核心） | `frontend/src/hooks/useVirtualKeyboard.ts`                       | ① `commitKeyboardState`：300ms 轮询 + rAF 检测键盘开关，只管 `keyboardHeight`/`isKeyboardOpen`，不碰 `--palink-kb-vh`；② **K10 几何 effect（触屏 only，coarse matchMedia 守卫）**：focusin（`e.target`）同帧写 `--palink-kb-vh`（localStorage 缓存 `palink-kb-height`，无缓存 300）+ 同帧挂 `palink-kb-open`；**`seenOpen`** **门控的稳定检测**（升起前只观察；见过升起后 vv 退回阈值下 → 还原；1.5s 未升起 → 撤销估算布局；升起后稳定且与当前值不一致才改写一次 + 更新缓存）；③ 失焦 → 一步还原；④ 滚动压制；⑤ touchmove 手势级阻断；⑥ ⌨ 标题标记 | 核心      |
| 输入框（角色聊天页）  | `frontend/src/components/views/character/chat/ChatInputArea.tsx` | 移动端 `createPortal` 到 body（**body 直接子级**，类门控抬升规则的命中前提）+ `fixed`；inline `bottom` 双态保留（聚焦期间被类门控 CSS 规则接管，取值一致）                                                                                                                                                                                                                                                                                                         | 核心      |
| 输入框（主聊天页）   | `frontend/src/components/views/ChatViewMobile.tsx`               | **排除**：`composerBottomStyle` 恒 = dock 高（或欢迎动画锁定值），不消费 `--palink-kb-vh`；`keyboardHeight` prop 已删；留白恒按 dock 态（`useMobileKeyboardAdapter.ts`）                                                                                                                                                                                                                                                                          | 排除      |
| 移动端样式       | `frontend/src/index.css`                                         | 键盘布局**唯一开关 =** **`html.palink-kb-open`**（focusin 同帧挂载/收起同帧摘除）。类门控规则：`.rp-chat-area { max-height: var(--palink-kb-vh,100%) !important; padding-bottom:112px !important }`（留白 112 = ChatInputArea 的 92+20，改常数记得同步）；`body > [data-palink-chat-composer="true"] { bottom: calc(100% - var(--palink-kb-vh,300px)) !important }`；dock 隐藏动画；overflow 锁定。**无任何 transition**；**`:has(:focus)`** **兜底块已删**（原地留「已移除·勿恢复」注释）    | 核心      |
| 诊断角标（临时）    | `frontend/src/App.tsx`                                           | 左上角 5 行角标，首字段 `B:K10`；含 `kb/o/f/sy`、`vv/ot/ih/s`、`kbvh/cb/cache`、`body/shell`、`os/shrink`                                                                                                                                                                                                                                                                                                                           | ⚠️ 临时待删 |
| 入口 HTML     | `frontend/index.html`                                            | viewport **无** **`interactive-widget`**（Safari 不支持，留着无害）                                                                                                                                                                                                                                                                                                                                                            | 已定      |

### 3.1 输入框抬升公式（仅角色聊天页）

```
类开着（palink-kb-open，= 键盘布局生效期）：
bottom = calc(100% - var(--palink-kb-vh, 300px))    ← 类门控 CSS !important
类关了：
bottom = var(--palink-dock-height, 90px)            ← React inline
```

- `--palink-kb-vh` focusin 时 = `innerHeight − 缓存键盘高`（无缓存 300）；稳定后 = `vv.height + offsetTop` 实测值（不一致才改写）

- `palink-kb-height`（localStorage）= 上次实测键盘高（≈299）→ 第二次打开起 focusin 一步写中终值，稳定检测零改写

### 3.2 消息区封顶 + 留白（仅角色聊天页）

```
html.palink-kb-open .rp-chat-area {
  max-height: var(--palink-kb-vh, 100%) !important;   /* 渲染区域 = 屏幕高 − 键盘高 */
  min-height: 0 !important;
  padding-bottom: 112px !important;                   /* 输入框 92 + 间距 20，与类同帧 */
}
```

- 主聊天页**已排除**：`[data-palink-msg-scroll]` 不封顶，留白恒按 dock 态（`useMobileKeyboardAdapter.ts`）

***

## 4. 诊断角标（`App.tsx`，问题解决后删除）

```
B:K15 已删角标 o:1 f:1 sy:0       ← 版本号 / 检测键盘高 / 开关 / 聚焦 / 文档滚动
vv:356 ot:0 ih:655 s:654        ← visualViewport高 / offsetTop / innerHeight / 哨兵实测
kbvh:356 cb:356 cache:299       ← CSS变量实测 / 输入框底边 / localStorage键盘高缓存
body:655 shell:655              ← body 实际高 / app-shell 实际高
os:27.0 shrink:299              ← iOS 版本 / innerHeight−vv.height(=键盘高)
```

**判据**（键盘完全升起后）：

1. `shrink` ≈ 299 → vv 收缩正常；≈0 → 视口没收缩（查 meta/媒体查询）
2. **`kbvh`** **≈** **`vv`** **≈** **`cb`** → 三值相等 = 输入框精确贴键盘
3. **`cache`** **≈** **`shrink`** → 缓存命中，focusin 一步写中的就是终值（后续零改写）
4. `shell` 恒 = 655 不变矮 → 背景层不蠕动 ✅
5. `sy:0` → 文档没被顶跑 ✅

***

## 5. 部署状态

- **当前线上**：`palink-ai-frontend-1` 容器 + 本地 `frontend/dist` = **`index-d_yhXtPw.js`（K17）**，容器 healthy（2026-09-02 06:00 部署）。

- 历史产物：`frontend/dist_bak_*` 多份（K4\~K10 各版 dist 备份），以及 `dist_new_*`（镜像提取中间目录，已用完可删）。

- K8→K10 的源码改动**均未 commit**（用户未要求，交接前请确认是否要提交）。

### 5.1 部署 Runbook（已实践验证）

```powershell
cd D:\项目\Palink-AI

# 1) 重新构建前端镜像
docker compose build --no-cache frontend

# 2) 从镜像提取真身产物（create 不带 compose volume，取镜像内真身）
docker create --name tmp palink-ai-frontend:latest
docker cp tmp:/usr/share/nginx/html/. ./dist_new_$(Get-Date -Format yyyyMMdd_HHmmss)
docker rm tmp

# 3) 替换本地 dist 并重启容器（必须先停再改名，避免 Docker 重建空 dist 导致目录嵌套）
docker stop palink-ai-frontend-1
Rename-Item frontend\dist "frontend\dist_bak_$(Get-Date -Format yyyyMMdd_HHmmss)"
Rename-Item "dist_new_XXXX" frontend\dist        # 用实际目录名
docker start palink-ai-frontend-1

# 4) 验证（务必验证，别只看 Build 成功）
(Invoke-WebRequest -UseBasicParsing http://localhost:3000/).Content | Select-String "index-.*\.js"
docker ps --filter name=palink-ai-frontend-1 --format "{{.Names}} {{.Status}}"
```

**坑**：容器有 bind mount `frontend/dist → /usr/share/nginx/html`（ro），必须更新本地 dist 再重启；停容器后再改名，防止 Docker 重建空 dist 把新产物变成子目录。Git Bash 下 `docker cp` 需加 `MSYS_NO_PATHCONV=1` 防路径转换。

### 5.2 缓存

- nginx 对 JS/CSS 为 `no-cache`；但 iOS Safari 内存缓存仍可能命中旧 JS → **务必无痕模式测试**，或清除网站数据。

- 用角标首字段 `B:Kx` 判断是否加载到新代码（不是 K10 = 缓存了旧包）。

***

## 6. 真机验证清单（K10）

让用户在 iPhone Safari **无痕标签**打开 `http://<电脑IP>:3000`，进**角色聊天页**点输入框（对话主页/登录页已排除）：

| 验证项    | 期望                                            | 角标判据                                    |
| ------ | --------------------------------------------- | --------------------------------------- |
| 一步到位   | 点输入框后输入框/正文/dock **同帧瞬时到位**，无渐进适应             | 键盘升起期间页面无任何追赶动作                         |
| 零蠕动    | 升起过程**什么都不动**（除键盘本体与 dock 淡出）；**页面高度绝不能降了又回** | `kbvh` 全程恒定；第二次开合应完全静止                  |
| 输入框贴键盘 | 键盘升满后紧贴上沿无缝隙                                  | `cb ≈ vv ≈ kbvh`                        |
| 正文收缩   | 渲染区域 = 屏幕高 − 键盘高                              | `shell` 恒 655；`.rp-chat-area` 裁到 `kbvh` |
| 整页不可拖  | 非列表区拖不动                                       | `sy:0`；touchmove 阻断                     |
| 排除生效   | 对话主页/登录页点输入框：布局不动（iOS 默认行为）                   | 对话主页 `cb` 不抬升                           |
| 收起恢复   | 键盘收起完全复原                                      | 失焦/vv 退回阈值下 → 清变量 + 摘类                  |

***

## 7. 已确认「有效」的东西（别再推翻）

1. **背景层恒定**：`html/body/#root/.palink-app-shell` 恒定 `100svh`、不可滚 → 真机无背景蠕动。保留。
2. **vv 数值测量**：`vv.height + offsetTop` = 键盘上沿布局 y 值，真机可靠（356）。
3. **focusin 用** **`e.target`** 判断输入框（不能用 `activeElement`，iOS 延迟一拍）。
4. **检测链**：`o/kb` 工作正常（299 检测到）。
5. **输入框 JS 主动抬升**：`bottom: calc(100% - var(--palink-kb-vh))` 方向正确。
6. **dock 隐藏 + 整页锁定 + touchmove 阻断**：v1 已验证有效，保留。
7. **键盘高度 localStorage 缓存**（`palink-kb-height`）：同一设备键盘高度几乎恒定 → 常规路径一步写中终值、零后续改写。
8. **键盘布局唯一开关 =** **`palink-kb-open`** **类**（K10）：单轨、focusin 同帧挂载、收起同帧摘除，变量与类永远原子同动（`openKeyboardLayout`/`closeKeyboardLayout`）。
9. **升起前绝不动作（seenOpen 门控）**（K10）：任何「检测拍落在键盘起步延迟窗口」都不会再触发还原。

## 8. 已证伪 / 无效的东西（别再重蹈）

1. **靠 iOS 原生把 fixed bottom:0 顶到键盘上沿** → iOS 26/27 已失效（Bug 304976）。
2. **哨兵元素测量键盘上沿** → 测到的是布局底边。
3. **动画期间持续跟随 vv**（每帧/300ms 轮询/transition 桥接）→ 蠕动。
4. **一次性 400ms 快照校正** → 采到动画半途值（423 vs 终值 356）。
5. **`interactive-widget`** **meta** → Safari 从不支持。
6. **body 定位随键盘切换 / mousedown preventDefault + 手动 focus / JS 滚动锁** → v1 已证伪。
7. **键盘相关 CSS transition** → K9 已全部删除；过渡 = 「慢慢适应」。
8. **`:has(:focus)`** **纯 CSS 兜底（dock 隐藏/composer 抬升）** → K10 已删：与类双轨接力跳；「收起键盘但焦点仍在」时 :focus 仍匹配 → 输入框悬空、dock 消失，页面状态与键盘脱节。
9. **稳定检测的收起分支无门控**（K8/K9 蠕动真凶）→ 键盘起步延迟 100-250ms，250ms 检测拍落在「kbvh ≈ innerHeight」区间误判收起 → 中途还原整页再重封顶 = 页面高度降→回→降。K10 用 seenOpen 门控修复，**任何未来改动不得移除该门控**。

***

## 9. 防坑铁律（接手者背下来）

1. **只能真机验证**，桌面 DevTools 键盘模拟是 Android 模型 = 假阳性。
2. 不要加 `interactive-widget`（Safari 不支持，白费）。
3. 不要随键盘状态切换 `body` 的 `position`（跳变源）。
4. 不要 `mousedown preventDefault` + 手动 focus（藏输入框）。
5. 不要 JS 滚动锁 / 定期 `scrollTo(0,0)` 与 iOS 键盘滚动对抗（「事件驱动 sy 归零」仅兜底）。
6. **不要**在键盘动画期间写 `--palink-kb-vh`；**稳定检测在 seenOpen 之前绝不触发还原**（K8/K9 蠕动真凶，勿回退）。
7. focusin 判断输入框**必须用** **`e.target`**。
8. 背景层恒定、输入框 JS 抬升、vv 数值测量——三根支柱保留。
9. **排除范围别动**：登录页、对话主页（ChatViewMobile）不参与键盘抬升/封顶，用户明确拍板（类门控抬升规则的 `body >` 前缀是排除机制载体）。
10. **键盘布局唯一开关 =** **`palink-kb-open`** **类**，别再加第二轨（`:has(:focus)` 兜底已证伪删除）。
11. iOS 版本差异极大，改完必须确认用户真实 iOS 版本。

***

## 10. K11 待验证 + 残余风险

**K11 已部署，等真机验证。** 预期：点输入框 → 输入框/正文/dock 同帧跳到终态布局，键盘本体在下方升起（iOS 原生动画），全程页面零追赶、高度绝不来回弹。

**若真机仍有可见动作，按残余风险排查（一次只试一个）：**

### 风险 1：首开无缓存的估算偏差（预期内，仅一次）

第一次打开（无 `palink-kb-height` 缓存）用 300 估算，真实 299 → 稳定检测 \~750ms 改写一次（1px）。第二次打开起应零改写。验证：角标 `cache` ≈ `shrink` 后重复开合，看 `kbvh` 是否恒定。

### 风险 2：iOS 对 fixed 元素的动画中间态残余偏移

kbvh 静止但 iOS 27 在动画期间对 fixed 容器本身有部分上推/偏移（Bug 304976 中间态）。验证：动画期间连拍 `cb`，看 `kbvh` 恒定而 `cb` 仍动。修法：输入框改正常文档流底部（shell 内 flex）。

### 风险 3：iOS 补偿滚动与 press 归零的对抗

`press`（scrollTo(0,0)）与 iOS 键盘补偿滚动打架 → 整页微幅弹跳。K10 的 overflow 锁定自 focusin 同帧生效，理论上已无滚动窗口；若动画期间 `sy` 仍非 0 抖动，查此链。

### 风险 4：vv 阶梯中间值被误判「稳定」

两次连续采样（250ms 间隔）恰逢动画停顿 → 写入中间值一次，之后校正。表现：kbvh 跳两次。验证：角标 `kbvh` 在升起过程中的采样值。若频发，把稳定阈值从 250ms×2 提到 400ms×2。

### 风险 5：对话主页排除后的回泄

类门控抬升规则若被改回无 `body >` 前缀，或有人给主聊天页 composer 加 portal → 主聊天页被重新卷入。改 CSS 前先看第 9 节铁律 9。

***

## 11. 待清理项（问题彻底解决后执行）

- [x] ~~删除诊断角标~~（K15 已删；真机版本确认改用键盘弹出时标题栏 ⌨K15 标记）

- [ ] 删除 `useVirtualKeyboard.ts` 中 `⌨` 标题诊断标记

- [ ] 复核 `useVirtualKeyboard.ts` 滚动压制 / touchmove 阻断 / `palink-kb-open` 类双写者（K10 effect 提前挂 + 检测链幂等）是否收敛为单写者

- [x] ~~复核~~ ~~`index.css`~~ ~~180ms transition~~（K9 已删）

- [x] ~~复核~~ ~~`html:has(:focus)`~~ ~~兜底去留~~（K10 已删，原地留勿恢复注释）

- [ ] 清理 `frontend/dist_bak_*` / `dist_new_*` 历史目录释放磁盘

- [ ] 确认是否提交本轮源码改动（当前未 commit）
- [x] Phase 0 真机验证已完成（2026-09-02）：四种可编辑元素辅助条**全弹** → contenteditable 改造**证伪封存**，结论已回填 ChatInput-contenteditable改造调研.md；辅助条唯一根治 = 原生壳（超范围）
- [x] K16 沉浸感解锁（2026-09-02）：index.html 增加 `apple-mobile-web-app-status-bar-style=black-translucent`（viewport-fit=cover 原本就有，各移动端顶栏均已用 env(safe-area-inset-top) 避让）→ 主屏幕 web app 模式下页面延伸到灵动岛/状态栏背后。iOS 26 起任何网站加主屏幕默认即 web app（WebKit 官方）。**待用户真机验证**；注意 iOS 26/26.1 有 meta 行为变化的社区报告（Reddit r/Frontend），以实机为准；亮色模式状态栏文字为白色，浅色画布上对比度待观察
- [x] K17 兜底安全区（2026-09-02）：dock（Sidebar.tsx 的 `nav[data-dock="true"]`）style 增加 `paddingBottom: env(safe-area-inset-bottom, 0px)`——沉浸式（standalone web app）模式下 dock 上移到 Home 指示条之上，不被手势条遮挡；dock 高度变化由既有 ResizeObserver 测量 `--palink-dock-height` 自动传播给 composer，无需改 CSS 常数。同一轮：manifest.json `background_color` `#1a1a2e` → `#020617`（启动闪屏底色与深色画布同源）。**待用户真机验证**

***

## 12. 给下一个 AI 的接手提示词（直接复制）

> 请先读 `D:\项目\Palink-AI\IOS_KEYBOARD_HANDOVER_v2.md`（完整交接：根因、K4→K10 调试史、真机数据、当前代码状态、部署 runbook、残余风险）。旧版 `IOS_KEYBOARD_HANDOVER.md` 仅作历史参考。
>
> **背景**：Palink-AI 前端（React + Vite + Tailwind），移动端 iOS Safari 浏览器模式。用户 K9 拍板的最终口径：**点输入框 → 渲染区域一步到位 = 屏幕高 − 键盘高，零过渡零跟随；仅角色聊天页适用；登录页与对话主页（ChatViewMobile）排除**。
>
> **当前状态**：线上已部署 **K17 =** **`index-d_yhXtPw.js`**（键盘弹出时标题栏 `⌨K17` 标记；诊断角标已删）。实现 = **K13 原始基线**：无任何 JS 键盘布局代码，聚焦态纯 CSS（`:has(:focus)` → 输入框 bottom:0 + dock 下移淡出），html/body 背景色跟主题（#F8FAFC/#020617），沉浸感 meta（black-translucent），dock 安全区（env(safe-area-inset-bottom)）。**待真机验证**。
>
> **你的任务**：
>
> 1. 让用户 iPhone 无痕模式验证（第 6 节清单），重点：一步到位、零蠕动（页面高度绝不能降了又回）、排除页不抬升、收起复原。
> 2. 若仍有可见动作，按第 10 节风险 1→5 逐个排查，一次只改一件事，构建部署（第 5.1 节 runbook）。
> 3. 每轮让用户报角标数字（`cache`/`kbvh`/`cb`/`sy`/`ot`），用数据定位，不猜。
> 4. 彻底解决后按第 11 节清理诊断角标与临时逻辑。
>
> **铁律**：只能真机验证；不要动画期间写 `--palink-kb-vh`；**seenOpen 门控勿回退**；focusin 用 `e.target`；背景层恒定不可动；不要 `interactive-widget`；不要切 body position；不要 mousedown preventDefault；**唯一开关 = 类，别加第二轨**；**排除范围（登录页/对话主页）是用户拍板，别动**。

***

## 13. 参考链接

- WebKit Bug 304976（iOS 26 Safari 键盘弹起 layout viewport 不变）：<https://bugs.webkit.org/show_bug.cgi?id=304976>

- Apple 开发者论坛 800154（iOS 26 visualViewport.offsetTop 回归）：<https://developer.apple.com/forums/thread/800154>

- WebKit Bug 259770（interactive-widget 未实现）：<https://bugs.webkit.org/show_bug.cgi?id=259770>

- v1 交接文档（历史，前提已证伪）：`D:\项目\Palink-AI\IOS_KEYBOARD_HANDOVER.md`

***

*— 文档结束。接手者务必先读完第 0 / 1 / 2 / 3 / 5 / 10 节再动手。*
