# PROMPT — 对话派包 · 批次 P（预设分身）/ Q（卡片读主页面 + 凭据加固）/ R（插件启用与安装）2026-10-20

> ## ⛔ 主脑订正（2026-10-20 晚 · 本件写完后一手复核否证了自己的一条前提）
>
> **Q-1「先把 JS 可读的 cookie 挪出可达范围，否则默认放开=交出凭据」这个前提不成立，整批 Q 已停手待用户裁决。**
> 下面第 2 条裁定与 Q-1 的原文**保留不删**（本仓规矩：只进不出，纠错加订正），但**不得照做**。一手事实（主脑本会话逐行读过）：
> - 访问令牌 `palink_session` 一直就是 `httponly=True`：`backend/app/api/dependencies.py:19-28`（`set_session_cookie`，
>   登录 `auth.py:152` 与续期 `auth.py:382` 共用这一函数）。
> - JS 可读的那枚是 **CSRF 双提交随机值**，不是令牌：`backend/app/api/auth.py:153-160` 与 `:383-389`
>   两处 `httponly=False` 设的都是 `CSRF_COOKIE_NAME`（`secrets.token_urlsafe(32)`）。
>   ⇒ 把它改成 HttpOnly **救不了**"卡片能读主页面"这件事，只会把前端 CSRF 注入路径打断。
> - 真正的暴露面是**同源**，与 cookie 属性无关：srcdoc 帧继承父站点 origin；全站无 CSP；
>   帧内 `fetch` 对未白名单路径**直接落到真实 API**（`frontend/src/components/ui/custom/smart-card-runtime/runtime-body/part-06.ts:714-720`，
>   `handleStApiFetchCompat` 返回 null ⇒ `nativeFetchCompat(input, init)` 原样转发）；
>   而 CSRF 判定**只凭 Origin 同源就放行**（`backend/app/core/csrf_guard.py:28-31`，`origin_host == site_host → True`）。
>   ⇒ 一旦 `allow-same-origin` 默认放开，卡在同一 origin 里就能带着 cookie 打任何写端点，且中间件不会拦。
> - 复核全文与"整批停手"记录见 `docs/_active/report/REPORT_包AH_Q_沙箱放开前置加固复核与整批停手_2026-10-20.md`，提交 `b40a8b9`。
>
> **Q 已定档（2026-10-20 深夜用户第三次裁定）：选第一档 = 分场合放开**（本机/内网默认给同源、公网访客仍走逐卡信任）。
> ⇒ **执行件换成 `PROMPT_对话包_批次Q1_本机默认放开卡片读主页面_2026-10-20.md`，本件 Q-1/Q-2 一律不再照做。**
> 裁定与连带后果（含"同站点卡落到同一 origin ⇒ 卡间只剩命名空间一层"这条新暴露面）登记在
> `docs/_active/spec/SPEC_向ST学习的子系统缺口与标记方案_2026-10-19.md` **§2.4**。
> **P 与 R 的落点没变**；R 排在 Q1 之后（两批都改 `part-07.ts` ⇒ 严禁并行）。

> 零上下文执行件。复核方 = Qoder「分配分包派遣任务」会话（主脑）。
> 通用红线读 `docs/_active/HANDOFF_提示词_已授权批次_写桥与人设角色库与getContext与服务端留痕_2026-10-20.md` §0；
> 并行施工纪律（共享 git 索引）读 `PROMPT_对话包_批次F总账对账与批次G模板串守卫_2026-10-20.md` 同名一节。
> **三批都要改 `runtime-body/part-07.ts` ⇒ 严禁并行，一次只开一批，前一批主脑复验入库后才能开下一批。顺序：Q → P → R。**

## 用户 2026-10-20 的三条裁定（覆盖此前所有相反记录，含"冲突以 ST 为准"这条总则）
1. 预设改成**每对话一份分身**：进卡时默认取用户在设置里选的那份（= 全局默认）；卡片可改"本对话这份"；
   **改了不回写全局**；卡片只能读写自己这份。**默认放开 = 写时复制**（未改过就不产生副本，见 P-1）。
2. 卡片读主页面 **默认全放开**（不再要求用户逐卡点信任）。
   ⚠️ 前提加固由主脑写死在本批 Q-2：登录凭据目前有一枚 cookie 是 `httponly=False`
   （`backend/app/api/auth.py:153-158`，同文件 `:310-315` 那枚才是 `httponly=True`），
   **不先把它挪出 JS 可达范围，"默认全放开"就等于把会话凭据交给任何一张导入的卡**（本站注册开关仍开、公网可达）。
   若主脑不同意改 cookie，则本条自动降级为"仅本机/内网站点默认放开，公网访客仍走信任开关"。
3. 插件两档都做：① 启用/停用已在本库的插件；② 从地址安装（**限定白名单源 + 每次显式确认**），并把 `isAdmin` 做成真值。

---

## 批次 Q — 卡片读主页面（默认放开）+ 凭据加固

### Q-1 先做加固（**不通则整批停手回报**）
- 核清三枚 cookie 的用途与可达性：`grep -n "set_cookie" backend/app/api/auth.py`，逐处确认哪个是访问令牌、
  哪个是刷新/CSRF；再核前端怎么带它（`frontend/src/services/api*.ts` 读的是 `document.cookie` 还是内存）。
- 落地方案二选一（**先回报方案再动手**）：
  (a) 把 JS 可读的那枚改成 `httponly=True`，前端改为内存持有 + 请求拦截注入；
  (b) 保留 cookie 但把"卡片可读的父页面范围"限制在不含凭据的展示区（脱敏/影子 DOM）。
  判据：加固后跑一次真实登录 + 刷新 + 一次生成流程仍可用（不许把用户自己锁在外面）。

### Q-2 默认放开沙箱
- `CharacterCardRenderer.tsx:1379-1382` 的 sandbox 计算改为**默认含 `allow-same-origin`**（保留 `allow-scripts`，
  仍**不给** `allow-top-navigation`）；`trusted-native` 模式与信任开关**保留但不再是前提**（防回退用）。
- 帧内把 `retrieveDisplayedMessage` 接到真实现：读主文档里那条消息的 DOM（一手核酒馆助手
  `@types/function/` 的签名与返回形状），拿不到就诚实返回 `null`/抛错并留痕。
- ⚠️ 放开后必须自查：新会话导入一张陌生卡，它在帧内**读不到**任何 cookie / localStorage 里的令牌
  （用 Q-1 加固后的事实写断言，而不是写"应该读不到"）。
- 反证：把 Q-1 的加固回退 ⇒ "读不到凭据"那条必须红。

## 批次 P — 预设分身（写时复制）

- **P-1 模型**：给会话级预设覆盖层做落点。首选**不新建"每对话一份副本"**，而是
  `session 只存"我在哪份之上做了哪些改动"` 或 `fork 时按需复制`（copy-on-write）：
  未改动 ⇒ 读全局默认；改一次 ⇒ 生成本对话私有份。**先出字段与迁移方案给主脑审，再写码**（表结构改动属不可逆项）。
- **P-2 卡片面**：预设 19 键逐键定性（读类先做：`getPresetNames`/`getLoadedPresetName`/`getPreset`/
  `isPresetSystemPrompt`/`isPresetPlaceholderPrompt`/`isPresetNormalPrompt`；写类后做：`create/replace/updateWith/
  createOrReplace/delete/rename/load/setPreset`）。写类**只作用于本对话那份**，永不回写全局；越权（改别人的）要有失败测试。
- **P-3 可见性**：卡片设置里要能看出"当前用的是全局默认 还是 本对话副本"，并显示副本内容（这是用户点名要的功能）。
- **P-4 ST 偏离登记**：本条**故意偏离 ST**（ST 是全局内容 + 每对话记选择），必须在台账与代码注释里写明
  "用户 2026-10-20 裁定覆盖总则"，并说明取舍：换来多对话隔离，代价是与 ST 语义不同。
  ⚠️ ST 侧那半我这轮没一手核到，**执行方必须先一手核**（`_reference/sillytavern-1.18.0` 里预管理器的真实路径与
  "选中的预设记在哪"），把 `文件:行号` 写进报告；核不到就按本件描述实现并如实标注"ST 侧未核实"。
- 破甲槽顺带定案：装配里已有 `context_template` 的 `system_prompt / jailbreak` 槽位
  （`roleplay_prompt_assembly.py:4145-4160`）⇒ 先核"卡覆盖破甲"是否已可达，缺再补，不许另造第二套。

## 批次 R — 插件启用/停用 + 白名单安装

- R-1 先一手核我们已有落点：`backend/app/models/plugin.py`、`character_plugin_storage.py`、`plugin_scripts` 存储，
  以及帧内现有的扩展读面（`getExtensionStatus`/`getExtensionType`/`isInstalledExtension` 等 9 键当前全是 D）。
  **能映射到"启用/停用本用户已有插件"的先做**；`isAdmin` 给真值（从 user 角色取），⛔ 不许恒 true/false。
- R-2 "从地址安装"：只接受**你手工维护的白名单源**（配置项，默认空 = 该能力存在但无处可装），
  且必须走一次用户显式确认（复用信任/授权那套交互），装进来的东西**只对该用户生效**。
  ⛔ 禁止服务端 git clone / 任意 URL 拉代码执行（这是 ST 单机假设，我们是多人公网服务）。
- R-3 台账：`ext_install` 行改判并写清"允许到什么程度"，9 键逐键给"做了/降级/不做"。

---

## 每批交回必给（主脑独立复跑）
门禁退出码 + `failed=0/errors=0` 原始行；新测试逐文件单跑用例数（0 用例=不存在）；**两组反证**原始输出
（Q 批必含"回退加固 ⇒ 读不到凭据那条红"）；`git show --stat` 边界比对；
真机读数（`http://localhost:16000`，禁点生成/禁花 API 余额；要新代码上线用旁路 `VITE_OUT_DIR=dist_p|dist_q|dist_r`
+ dev 探针端口 5221/5222/5223，会话名 `-s=pkg-q|pkg-p|pkg-r`）；
零回归基线读数：`Object.keys(TavernHelper)=144`、`getContext()=196`、`Object.keys(commands)=509`、每帧插件 CSS 5/5
（Q 批放开沙箱后这三项**必须仍成立**，且 `window.context` 仍为 `undefined`）；
报告落 `docs/_active/report/REPORT_包(AH|AI|AJ)_(Q|P|R)主题_2026-10-20.md`，首部写状态，末尾列"未做/做不到"。

## 预算与停机
每批最多 60 次工具调用；前 8 次落地第一个可执行文件；到 45 次转收尾（门禁、报告、提交）；
被截断前**必须先提交已完成部分**。涉及表结构/迁移/凭据的改动：**先出方案等主脑点头再写码**，这条不给预算豁免。
