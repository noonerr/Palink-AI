# REPORT 包Q —— MVU 变量块别名识别面对齐上游（2026-10-19）

> **状态：已完工待验收（代码已入库，镜像未重建）**
> 交付 commit：`cd89289`（① 别名识别 + 测试）、`c06c252`（② 块体形式清单 + 裸 `<JSONPatch>` 块）。
> **⚠️ 提交 ≠ 上线**：后端改动需主控 `docker compose build backend && up -d backend` 才进镜像。
> 本包**只动后端两个文件**，未碰前端、未碰 DB 数据、未重建镜像。
> 容器内 `/app/app/services/mvu_engine.py` 已逐字节还原为镜像原状（md5 `7b70e18c0c027e7a259c653160df34c2`），
> 验证期没留任何未授权的容器改动。
> 取代关系：无（新文档）。

---

## 0. 一句话结论

上游 MVU 认 **三种别名包裹式**变量块（`<update>` / `<updatevariable>` / `<variableupdate>`，大小写不敏感、
开闭必须同名），Palink 此前只认 `<UpdateVariable>` 一种 —— 别名块**能被"意外"解析**（靠既有的
`[BARE-JSONPATCH]` 裸数组兜底），**但标签始终留在正文**，正是「解析了却没剥」的半半状态。
本包把 `extract` 与 `strip` 的识别面同时补齐，并按 bundle 一手证据补了「裸 `<JSONPatch>` 块」这一
上游确实接受的块体形状；块体的 **YAML/JSON5 语法**与 **`_.set(...)` 脚本形式**经取证确认上游确实接受，
但**本包未跟进**，登记为剩余项（见 §6）。

---

## 1. 上游一手证据

取证文件：`.tmp_probe/mvu_bundle.js` —— 卡侧引用的 `MagicalAstrogy/MagVarUpdate@beta/artifact/bundle.js`
（jsdelivr 公开代码，611598 字节 / 解码后 572327 字符）。**压缩产物全文仅 3 行**，所以引用一律给
「行:列」并附可直接 grep 的字面 needle（主控给的两处偏移 462161/360382 与实测锚点差 63/56 字符，
按 `data.find()` 实测位置订正；见 §7 订正说明）。

| # | 上游实现 | 位置 (行:列) | needle（grep 锚点） |
|---|---|---|---|
| U1 | **展示层剥离正则**（函数 `Dr`），逐字 `/\n<(update(?:variable)?\|variableupdate)>(?:(?!<\1>).)*<\/\1?>/gis` | `bundle.js:2:462098` | `/\n<(update(?:variable)?` |
| U2 | **解析层标签记号正则**（函数 `Ut`）`/^<(\/?)\s*(updatevariable\|variableupdate\|update\|json_?patch\|think\|…)\b[^>]*>/i` | `bundle.js:2:360326` | `updatevariable\|variableupdate\|update\|json_?patch` |
| U3 | 按桶分派 `/^json/.test(e)?'patch':'update'` | `bundle.js:2:360600` | `/^json/.test(e)?'patch':'update'` |
| U4 | **块配对**（函数 `Rt`）：开标签入栈、闭标签出栈；未闭合块也返回（`closed:false`，体到文末） | `bundle.js:2:361540` | `function Rt(` |
| U5 | **命令解析器**（函数 `tn`）：`Rt(e,'patch')` 取 **全文** patch 块，过滤 `closed && !discarded` | `bundle.js:2:365913` | `Rt(e,'patch').filter(e=>e.closed&&!e.discarded)` |
| U6 | 渲染时用 `Ut().visible` 把 patch 标签**从正文抹掉**（`fill(' ', start, end)`） | `bundle.js:2:366950` | `for(const t of Rt(e,'patch'))n.fill(' ',t.start,t.end)` |
| U7 | **块体去围栏**（函数 `Lt`）`e.trim().replace(/^```(?:json5?\|ya?ml)?\s*/i,'').replace(/\s*```$/,'').trim()` | `bundle.js:2:362766` | `function Lt(` |
| U8 | **块体解析阶梯**（模块 8490 的 `$l`，即 `Ft` 的兜底）：YAML 文档 → JSON5 → 宽松修复 JSON → YAML 再兜底 | `bundle.js:2:340455` | `function u(e){const t=/^[[{]/s.test(e.trimStart())` |
| U9 | **patch 数组校验**（函数 `Mt`）：必须数组；每项 plain object、`op` 为字符串、`path` 为字符串（`op==='move'` 时允许 `to`） | `bundle.js:2:358549` | `function Mt(e){return!!Array.isArray(e)` |
| U10 | **op → 命令映射**：`replace→set`、`delta→add`、`insert/add→insert`、`remove→delete`、`move→move(用 from)`；其余 op 静默丢弃 | `bundle.js:2:366186`～`2:366763` | `case'replace':t.push({type:'set'` |
| U11 | **`_.set` 脚本形式**扫描（`tn` 后半）：`/_\.(set\|insert\|assign\|remove\|unset\|delete\|add)\(/`，要求 `)` 后**紧跟** `;`，可带 `// 注释`；实参数 set/assign/insert≥2、remove/unset/delete≥1、add==2 | `bundle.js:2:367088` | `_(set\|insert\|assign\|remove\|unset\|delete\|add)\(` |
| U12 | **副模型规范化**（函数 `Do`）：把回复归一成 `<UpdateVariable><JSONPatch>…</JSONPatch></UpdateVariable>`；块内无 patch 时依次尝试 `_.set` 脚本、以及 `Tn` 的**对象包装体** | `bundle.js:2:409170` | `function Do(` |
| U13 | `Tn`：接受对象体 `{analysis?, json_patch\|jsonPatch\|patch\|delta: […]}` | `bundle.js:2:388565` | `function Tn(` |
| U14 | `<initvar>` 初始变量正则 `/<(initvar)>(?:\s*```.*)?([\s\S]*?)(?:```\s*)?<\/\1>/gim` | `bundle.js:2:382110` | `/<(initvar)>` |
| U15 | 值合法性校验 `Wt`（null/字符串/布尔/有限数/plain object/数组，拒绝循环引用）——`Do` 用它拦非数值 | `bundle.js:2:362947` | `function Wt(` |
| U16 | `<!-- mvu:discard-incomplete-json-patch -->` 哨兵：带此注释的 patch 块被丢弃 | `bundle.js:2:358898` | `mvu:discard-incomplete-json-patch` |

### 1.1 别名识别面（回答"上游认哪些标签"）

- **三种别名**：`<update>`、`<updatevariable>`、`<variableupdate>`（U1 展示层三选一；U2 解析层同一组 + `json_?patch`）。
- **大小写不敏感**（`/i`）。
- **包裹式**：`\n<别名> … </别名?>` —— 闭标签走**反引用** `\1?`（同名，或上游允许的裸 `</>`），
  块内禁止再出现同名开标签 `(?!<\1>)`。**不是属性式、不是自闭合式**（U1 的 `<(name)>` 紧跟 `>`）。
  解析层 U2 虽然用 `\b[^>]*>` 容忍属性，但自闭合 `<update …/>` 在 U4 里只算**开标签**、永不闭合，
  而 U5 又要求 `closed` ⇒ 属性式/自闭合式在上游同样产不出命令。
- ⚠️ **上游自相矛盾之处**（如实记录）：解析层 U3/U4 按**桶**（`update`/`patch`）配对，
  `<update>…</UpdateVariable>` 这种**跨别名**也能配上；展示层 U1 按**反引用**要求同名。
  Palink 的 `extract` 与 `strip` 共用同一条正则（分开就会「剥了但没解析」），按主控规格取**严格的反引用语义**。
- ⚠️ **别名是防御性支持，不是当前病灶**：库里 `<update>` / `<variableupdate>` / `<json_patch>` 命中数均为 **0**
  （`character_chat_messages` 13 条含 `<UpdateVariable>`，`world_book_stages` 14 条含 `<UpdateVariable>`，
  别名全为 0；`regex_scripts` 0 条、`plugin_scripts` 0 条引用该标签）。bundle 自身也只出现
  `<UpdateVariable>` 字面量 14 次、`<update>` 0 次（`RESULT alias=` 计数见 §5.1）。

### 1.2 块体形式清单（回答"上游接受哪几种块体"）

上游一条回复里的命令来源共 **4 类**（不是"只有 JSON 数组一种"）：

| 形状 | 上游证据 | Palink 现状（本包后） |
|---|---|---|
| B1 `<JSONPatch>` / `<json_patch>` 块，体为 **JSON 数组** `[{op,path,value},…]`，可被 `<UpdateVariable>` 包裹 | U5+U9+U10 | ✅ 一直支持 |
| B2 **裸 `<JSONPatch>` 块**（不被 `<UpdateVariable>` 包裹，任意位置） | U5（`Rt(e,'patch')` 取全文）+ U6（渲染时抹掉标签） | ✅ **本包补齐**（改前只靠兜底捞第一个数组、标签留正文） |
| B3 块体写成 **YAML / JSON5 / 带注释 / ```围栏```** | U7（去 ```json/```yaml 围栏）+ U8（YAML→JSON5→修复 JSON→YAML 四级阶梯）+ U2 的 `yaml` 状态机 | ❌ 仍只认 JSON 数组（`_safe_json_loads_list` 的宽松修复=去尾逗号/单引号转双引号/删 `${…}` 行，**不含 YAML**）。登记剩余项 R1 |
| B4 **`_.set(...);` 脚本调用**（可散落在正文任意处，也可写在 `<UpdateVariable>` 内） | U11 + U12 | ❌ 未支持。登记剩余项 R2 |
| B5 对象包装体 `{analysis?, json_patch\|patch\|delta: […]}`（仅副模型/`Do`→`Tn` 路径） | U13 | ◐ 间接可用：`_find_first_json_array` 会在对象文本里找到那个数组 |
| （B6 `<initvar>` 是初始变量，不属"更新块"） | U14 | ✅ 另有 `_INITVAR_RE` |

⇒ 结论：**上游不止接受 JSON 数组一种**，故 §1.2 逐条列了清单；本包只把 **B2** 补齐
（它是"剥/解必须一致"这条硬约束直接要求的形状），**B3/B4 不做**（见 §6 理由）。

---

## 2. 改了哪几处（共 2 文件，其余一律未动）

### `backend/app/services/mvu_engine.py`

| 位置 | 改动 |
|---|---|
| `:5-6` 模块 docstring | 职责描述补别名与裸 patch 块 |
| `:63-79`（原 `:41-46`） | `_UPDATE_VAR_RE` 由字面 `<UpdateVariable>([\s\S]*?)</UpdateVariable>` 改为由 `_MVU_UPDATE_TAG_ALIAS = r"update(?:variable)?|variableupdate"` + 反引用 `\1?` + 禁嵌套 `(?!<\1>)` 生成的模式；`_JSONPATCH_RE` 同步接受上游 `json_?patch`；新增 `_UPDATE_VAR_LINE_RE` / `_JSONPATCH_LINE_RE`（行锚定剥离用）。**块体索引由 group(1) 下移到 group(2)**（上游剥离正则不捕内容，Palink 必须捕） |
| `extract_update_variable_blocks`（原 `:196`） | ① 读 `m.group(2)`；② 新增"不被包裹的裸 `<JSONPatch>` 块"识别，已被外层包裹块消化的内层块跳过（防同一补丁重复计数）；③ 多块按正文出现顺序返回（对齐上游 `sortBy('$index')`）；④ `[BARE-JSONPATCH]` 裸数组兜底的触发条件**逐字保持** `if not blocks`，未收紧 |
| `strip_update_variable_blocks`（原 `:231`） | ① 第一遍行锚定改用与 `_UPDATE_VAR_RE` 同源的 `_UPDATE_VAR_LINE_RE`；② 新增裸 patch 块剥离（行锚定 + 内联两遍）。**与 extract 同一套正则**，杜绝「剥了但没解析 / 解析了但留在正文」 |

### `backend/tests/test_mvu_variable_block_aliases.py`（新增，43 例）

四种标签别名 + 大小写混写各自「解析成功 / 正文剥离 / `stat_data` 正确变化」；
裸 `<JSONPatch>` 块 8 例；反引用严格性（不同名、未闭合、属性式、自闭合式、禁同名嵌套）；
既有包 JSON 形式与 `extra` 落库形状零回归。

⚠️ **判据防假阳性设计**（本轮踩过的坑，写进测试文件头）：`extract` 有 `[BARE-JSONPATCH]`
裸数组兜底，任何"正文里出现合法 patch 数组"的用例在**改动前也会解析成功**。
故别名/裸块判据一律用 **`op:"add"`**（不在 `_JSONPATCH_OPS` 白名单 ⇒ 兜底必定不采纳）
或**一条消息两个块**（兜底最多给 1 个）——否则「解析成功」是自证。

---

## 3. 按字面匹配 `<UpdateVariable>` 的全仓位置清单（**只登记，本包只改了 mvu_engine.py**）

### 3.1 正则/字面匹配（会随识别面变化而行为不一致的）

| # | 位置 | 形态 | 是否受本包影响 | 建议 |
|---|---|---|---|---|
| 1 | `backend/app/services/mvu_engine.py:63-79/234/288` | `_UPDATE_VAR_RE` / `_JSONPATCH_RE` / strip 两遍 | **已改** | — |
| 2 | `backend/app/utils.py:237` | `re.sub(r"<UpdateVariable(?:\s[^>]*)?[\s\S]*?</UpdateVariable\s*>")`（记忆入库清洗） | ❌ 不认别名；⚠️ 它**已容忍属性式**（`\s[^>]*`），与上游/Palink 识别面不一致 | 下一批：复用 mvu_engine 的常量，或直接调 `strip_update_variable_blocks` |
| 3 | `backend/app/utils.py:241` | `re.sub(r"</?(?:UpdateVariable\|Analysis\|JSONPatch\|Patch\|think\|thinking)\b[^>]*>")`（孤立残标签清扫） | ❌ 别名 `<update>`/`<variableupdate>` 不在集合 ⇒ 别名残标签会进记忆库 | 同上 |
| 4 | `backend/app/services/status_bar_detector.py:365` | `"UpdateVariable" in _fr`（判定卡是否 MVU 体系） | ❌ 别名不被认 ⇒ 用别名写指令的卡可能不走 MVU 分支 | 改成检测别名集合 |
| 5 | `backend/app/services/roleplay_prompt_assembly.py:3355` | `"<UpdateVariable>" not in content`（卡自带格式说明探测） | ❌ 卡若用别名写说明 ⇒ 重复注入 | 改成别名集合 |
| 6 | `frontend/src/components/ui/custom/Message.tsx:913-914` | 展示层两步剥离（对齐后端旧实现） | ❌ **前端不认别名**：别名块即便后端已剥，历史消息/流式中间态仍会整块显示 | **本包不动前端**（纪律）；下一批同步这两行 |
| 7 | `frontend/src/utils/sillyTavernDisplayPipeline.ts:221` | `/<\/?(?:start\|now_plot\|sakura_status\|GameStart\|UpdateVariable\|StatusPlaceHolderImpl)\b/i` | ❌ 别名不在白名单 | 同上 |
| 8 | `frontend/src/utils/sillyTavernDisplayPipeline.ts:568 / :744` | `/StatusPlaceHolderImpl\|sakura_status\|now_plot\|<GameStart\|UpdateVariable/i` | ❌ 同上 | 同上 |
| 9 | `backend/scripts/_archive/probe_mvu_block_origin.py:196` | 归档探针脚本里的 `re.sub` | ◐ 一次性脚本、在 `_archive` | 不改（归档） |

### 3.2 调用点（走 `mvu_engine` 共享函数 ⇒ **自动继承本包修复**，无需改动）

- `backend/app/api/character_ext.py` SSE 四入口：`:4863-4866`、`:6112-6113`、`:6253-6254`、`:6600-6611`
- `backend/app/api/websocket.py:789-794`
- `backend/app/services/mvu_secondary.py:121-123`（副模型剧情剥离）
- `backend/app/services/character_message_builder.py:555-568`（MVU 共用入口，解析侧）
- `backend/app/api/chat.py:435`（记忆侧引用 `clean_memory_content` ⇒ 回到 §3.1 #2/#3）

### 3.3 提示词字面量（教模型输出哪一种标签 —— 与识别面无关，但决定"别名会不会真的出现"）

- `backend/app/services/mvu_secondary.py:70-88`（副 AI 系统指令，写死 `<UpdateVariable>`）
- `backend/app/services/macro_service.py:38`、`backend/app/core/default_prompts.py:275/281`、
  `backend/app/services/roleplay_prompt_assembly.py:3367/3372/3380`
⇒ 结论：Palink 自己只**要求** `<UpdateVariable>`；别名只可能来自模型自发行为或卡/世界书说明，
识别面补齐属"接得住"，不改生成侧口径（改生成侧属另一议题）。

### 3.4 命名陷阱（grep 命中但**不是**标签匹配，勿误删/勿误改）

`updateVariablesWith`（`frontend/.../smart-card-runtime/runtime-body/part-07.ts:311/327/331/338/596`、
`st-plugins/third-party/JS-Slash-Runner-main/@types/**`、`mvu_cleanup.py:340` 注释）、
`runtime.extraModel.updateTagMissing` 等 i18n 文案、`update_variables` 端点名。

### 3.5 数据侧（只读取证，未改动）

`regex_scripts.find_regex` 命中 `UpdateVariable` **0 条**；`plugin_scripts.content` 命中 **0 条**
⇒ 没有用户正则依赖旧字面，本包不会打断任何卡正则。

---

## 4. 门禁数字（只认 `failed=0` 且 `errors=0`）

容器内全量（`docker exec -w /app palink-ai-backend-1 python -m pytest tests/ -q -p no:cacheprovider`）：

```
2160 passed, 16 skipped, 374 warnings in 172.50s (0:02:52)
退出码 0
```

- 基线（本包改动前，同容器同命令）：`2152 passed, 16 skipped … RC=0`
- **+8 = 本包新增裸 `<JSONPatch>` 块 8 例**（别名 43 例里其余 35 例在基线计数之后入库，
  两次全量的差值只反映"最后一批新增"，不是验收线）。
- 守卫误伤自查：`grep -c "SystemExit\|safe-delete" .tmp_probe/包Q_full_container3.txt` = **0**。
- 未使用 `|| true` / `--continue-on-collection-errors` / `--basetemp` 指进仓库 / 新增 skip。
- 后端 16 条 skipped 为存量既有（本包一条没加）。

---

## 5. 反证（原始输出，两次成对）

### 5.1 反证①：把别名改回单一名 → 必红；还原 → 必绿

改的是 `mvu_engine.py` 一行：`_MVU_UPDATE_TAG_ALIAS = r"update(?:variable)?|variableupdate"`
→ `r"updatevariable"  # [REFUTE-TEMP]`。

**红（13 failed）**：

```
FAILED TestAliasRecognition::test_alias_parsed_via_block_path[update_lower-<update>-</update>]
FAILED TestAliasRecognition::test_alias_parsed_via_block_path[variableupdate-<variableupdate>-</variableupdate>]
FAILED TestAliasRecognition::test_alias_parsed_via_block_path[update_upper-<UPDATE>-</UPDATE>]
FAILED TestAliasRecognition::test_alias_parsed_via_block_path[mixed_case_short-<UpDaTe>-</UPDATE>]
FAILED TestAliasRecognition::test_alias_stripped_from_body[update_lower-<update>-</update>]
FAILED TestAliasRecognition::test_alias_stripped_from_body[variableupdate-<variableupdate>-</variableupdate>]
FAILED TestAliasRecognition::test_alias_stripped_from_body[update_upper-<UPDATE>-</UPDATE>]
FAILED TestAliasRecognition::test_alias_stripped_from_body[mixed_case_short-<UpDaTe>-</UPDATE>]
FAILED TestAliasRecognition::test_two_alias_blocks_are_two_blocks
FAILED TestAliasRecognition::test_alias_block_with_inner_jsonpatch
FAILED TestAliasRecognition::test_alias_inline_without_leading_newline
FAILED TestAliasRecognition::test_bare_close_tag_matches_upstream_backref
FAILED TestBackreferenceStrictness::test_no_nesting_same_name
13 failed, 22 passed, 2 warnings in 1.35s
```

（`mixed_case-<uPdAteVaRiAbLe>` 4 例此时仍绿属预期：它逐字就是 `updatevariable` 的大小写变体。）

**绿（还原后）**：

```
80 passed, 2 warnings in 1.52s
```

### 5.2 反证②：关掉裸 `<JSONPatch>` 块的识别与剥离两处 → 必红；还原 → 必绿

**红（5 failed）**：

```
FAILED TestBareJsonPatchBlock::test_bare_patch_block_parsed_and_stripped
FAILED TestBareJsonPatchBlock::test_bare_patch_block_alias_underscore
FAILED TestBareJsonPatchBlock::test_two_bare_patch_blocks_both_parsed
FAILED TestBareJsonPatchBlock::test_bare_patch_block_document_order
FAILED TestBareJsonPatchBlock::test_markdown_fenced_bare_patch_block
5 failed, 38 passed, 2 warnings in 1.40s
```

**绿（还原后）**：

```
88 passed, 2 warnings in 1.62s
```

（`test_bare_patch_block_stat_data_changes` 在反证态仍绿 —— 它用 `delta`，兜底能捞到数组，
正是"必须用 `op:"add"` 当判据"的理由；`test_unclosed_bare_patch_block_not_stripped` 断言的是不匹配，
反证态同样成立。两者都不作为红/绿判据。）

### 5.3 离线可复跑判定行

探针脚本 `.tmp_probe/包Q_alias_probe.py`（**该目录被 .gitignore，脚本不随提交走，全文内联如下**）。
容器内复跑：

```bash
cd /d/项目/Palink-AI && export MSYS_NO_PATHCONV=1 \
  && docker exec -i -w /app palink-ai-backend-1 python - < .tmp_probe/包Q_alias_probe.py
echo "退出码=$?"     # 期望 0；判定行全部为 RESULT 开头的 ASCII 行
```

**改前（基线）→ 改后 对照**（`tag_left` = 剥离后正文里是否还有变量块/patch 标签残留）：

```
RESULT case=alias_update                       改前 parsed_blocks=1 tag_left=True   改后 parsed_blocks=1 tag_left=False
RESULT case=alias_variableupdate               改前 parsed_blocks=1 tag_left=True   改后 parsed_blocks=1 tag_left=False
RESULT case=alias_update_upper                 改前 parsed_blocks=1 tag_left=True   改后 parsed_blocks=1 tag_left=False
RESULT case=alias_update_jsonpatch             改前 parsed_blocks=1 tag_left=True   改后 parsed_blocks=1 tag_left=False
RESULT case=alias_empty_close                  改前 parsed_blocks=1 tag_left=True   改后 parsed_blocks=1 tag_left=False
RESULT case=bare_jsonpatch_tag                 改前 parsed_blocks=1 tag_left=True   改后 parsed_blocks=1 tag_left=False
RESULT case=wrapped_json_array                 改前 parsed_blocks=1 tag_left=False  改后 parsed_blocks=1 tag_left=False   （零回归）
RESULT case=wrapped_jsonpatch_tag              改前 parsed_blocks=1 tag_left=False  改后 parsed_blocks=1 tag_left=False   （零回归）
RESULT case=wrapped_analysis_jsonpatch         改前 parsed_blocks=1 tag_left=False  改后 parsed_blocks=1 tag_left=False   （零回归）
RESULT case=bare_array                         改前 parsed_blocks=1 tag_left=False  改后 parsed_blocks=1 tag_left=False   （零回归）
RESULT case=mixed_case                         改前 parsed_blocks=1 tag_left=False  改后 parsed_blocks=1 tag_left=False   （零回归）
RESULT case=jsonpatch_alias_underscore         改前 parsed_blocks=1 tag_left=False  改后 parsed_blocks=1 tag_left=False
RESULT case=mismatch_update_vs_updatevariable  改前 parsed_blocks=1 tag_left=True   改后 parsed_blocks=1 tag_left=True    （上游同名要求，故意不匹配）
RESULT case=mismatch_updatevariable_vs_update  改前 parsed_blocks=1 tag_left=True   改后 parsed_blocks=1 tag_left=True    （同上）
RESULT case=unclosed                           改前 parsed_blocks=1 tag_left=True   改后 parsed_blocks=1 tag_left=True    （未闭合不剥）
RESULT case=attr_style                         改前 parsed_blocks=0 tag_left=True   改后 parsed_blocks=0 tag_left=True    （属性式不认，与上游一致）
RESULT case=self_closing                       改前 parsed_blocks=1 tag_left=True   改后 parsed_blocks=1 tag_left=True    （自闭合不认；parsed=1 是裸数组兜底，非别名识别）
RESULT apply case=wrapped_json_array     好感度=55 applied=1 logs=1
RESULT apply case=alias_update           改前 55（靠兜底）→ 改后 55（走块路径且剥离）
RESULT apply case=alias_variableupdate   同上
RESULT apply case=alias_update_upper     同上
```

⚠️ 对照里两处**改前既有事实订正**（主控规格写"其它写法既解析不到、标签还留在正文里"）：
别名/未闭合/自闭合这些写法**改前也能"解析到"** —— 但那是 `[BARE-JSONPATCH]` 裸数组兜底在起作用
（它不看标签，只扫正文里结构像 patch 的数组），**不是**识别到了变量块；
真正"既解析不到、标签又留着"的是**属性式**（`parsed_blocks=0`）。
所以准确表述是：**改前别名块处于「靠兜底意外解析到、标签却留在正文」的半半状态**。

<details>
<summary>`.tmp_probe/包Q_alias_probe.py` 全文（供复跑，.tmp_probe 被 gitignore 不随提交走）</summary>

```python
"""包Q 探针：MVU 变量块各种写法在 Palink 后端的识别结果（解析 / 剥离）。"""
import re
import sys

sys.path.insert(0, '/app')
from app.services.mvu_engine import (
    extract_update_variable_blocks, strip_update_variable_blocks, MvuEngine,
)

PATCH = '[{"op":"delta","path":"/桃汐/好感度","value":5}]'

CASES = {
    'wrapped_json_array': '正文。\n<UpdateVariable>\n%s\n</UpdateVariable>\n后续。' % PATCH,
    'wrapped_jsonpatch_tag': '正文。\n<UpdateVariable>\n<JSONPatch>\n%s\n</JSONPatch>\n</UpdateVariable>\n后续。' % PATCH,
    'wrapped_analysis_jsonpatch': ('正文。\n<UpdateVariable>\n<Analysis>想想</Analysis>\n'
                                   '<JSONPatch>\n%s\n</JSONPatch>\n</UpdateVariable>\n后续。' % PATCH),
    'bare_array': '正文。\n%s\n后续。' % PATCH,
    'bare_jsonpatch_tag': '正文。\n<JSONPatch>\n%s\n</JSONPatch>\n后续。' % PATCH,
    'mixed_case': '正文。\n<uPDaTeVaRiAbLe>\n%s\n</updATEvARIABLE>\n后续。' % PATCH,
    'alias_update': '正文。\n<update>\n%s\n</update>\n后续。' % PATCH,
    'alias_variableupdate': '正文。\n<variableupdate>\n%s\n</variableupdate>\n后续。' % PATCH,
    'alias_update_upper': '正文。\n<UPDATE>\n%s\n</UPDATE>\n后续。' % PATCH,
    'alias_update_jsonpatch': '正文。\n<Update>\n<JSONPatch>\n%s\n</JSONPatch>\n</Update>\n后续。' % PATCH,
    'alias_empty_close': '正文。\n<update>\n%s\n</>\n后续。' % PATCH,
    'mismatch_update_vs_updatevariable': '正文。\n<update>\n%s\n</UpdateVariable>\n后续。' % PATCH,
    'mismatch_updatevariable_vs_update': '正文。\n<UpdateVariable>\n%s\n</update>\n后续。' % PATCH,
    'unclosed': '正文。\n<UpdateVariable>\n%s\n' % PATCH,
    'attr_style': '正文。 <UpdateVariable name="好感度" value="5" op="delta"/> 结束。',
    'self_closing': '正文。 <UpdateVariable %s /> 结束。' % PATCH,
    'jsonpatch_alias_underscore': '正文。\n<UpdateVariable>\n<json_patch>\n%s\n</json_patch>\n</UpdateVariable>\n后续。' % PATCH,
}

TAG_ANY = re.compile(r'<\s*/?\s*(?:update|updatevariable|variableupdate|json_?patch)', re.I)

for name, text in CASES.items():
    blocks = extract_update_variable_blocks(text)
    stripped = strip_update_variable_blocks(text)
    tag_left = bool(TAG_ANY.search(stripped))
    ops = [p.get('op') for b in blocks for p in b]
    print('RESULT case=%-34s parsed_blocks=%d patches=%d ops=%s tag_left=%s' % (
        name, len(blocks), sum(len(b) for b in blocks), ops, tag_left))

base = {'stat_data': {'桃汐': {'好感度': 50}}}
for name in ('wrapped_json_array', 'alias_update', 'alias_variableupdate', 'alias_update_upper'):
    new, logs, applied = MvuEngine.update_from_reply(base, CASES[name], {})
    print('RESULT apply case=%-22s 好感度=%s applied=%d logs=%d' % (
        name, new['stat_data']['桃汐']['好感度'], len(applied), len(logs)))
```

</details>

---

## 6. 剩余项（本包**故意不做**，附取证与理由）

| # | 项 | 取证 | 不做的理由 / 下一步 |
|---|---|---|---|
| R1 | 块体的 **YAML / JSON5 语法**（`- op: delta` 列表式、注释、无引号 key、```yaml 围栏） | U7 `bundle.js:2:362766`、U8 `2:340455`（YAML→JSON5→修复 JSON→YAML 四级） | 上游确实接受，但 Palink 的块体形状**有意停在 JSON 数组**：`_looks_like_stat_data_patch` / `_find_first_json_array` 整套下游都建立在"数组"上，改 YAML 要同时定 YAML 解析器（容器已带 PyYAML 6.0.3，依赖不是障碍）与"多行标量/锚点引用"的接受边界，属**块体语法扩容**而非识别面对齐，本包范围外。⚠️ 我**没有**统计过库内有多少条是 YAML 块体（只统计到 233 条消息里 13 条含 `<UpdateVariable>`、其中 8 条含 `<JSONPatch>`）⇒ 真要扩容，先补这条底数 |
| R2 | **`_.set/insert/assign/remove/unset/delete/add(路径,值);` 脚本形式** | U11 `bundle.js:2:367088`、U12 `2:409170` | 要复刻 `nn()` 括号配对 + `on()` 顶层逗号切分 + `rn()` lodash 路径归一 + `substitudeMacros` 宏替换 + zod/clamp 后处理，量级是"再造一个 MVU 解析器"。底数实测：`world_book_stages` 有 **2** 条含 `_.set(` 字样（属卡自带说明文本），但 233 条消息里 **0** 条真正输出该形式 ⇒ 扩容前要先确认这 2 条是不是在要求模型这么写；单列议题再开 |
| R3 | **前端识别面**（§3.1 #6/#7/#8） | `Message.tsx:913-914` 等 | 本包纪律明令不动前端。⚠️ 不改的后果：卡/模型自发输出别名块时后端已剥，但**历史消息与流式中间态**在前端仍会整块显示 |
| R4 | **记忆入库清洗不认别名**（§3.1 #2/#3 `utils.py:237/241`） | 同左 | 别名块仍可能整块进向量记忆（正是 2026-09-23 那轮"残缺标签进记忆→推理模型反复自我审查"的同型问题）。改法是复用 `strip_update_variable_blocks`，属同族连带修复，本包未扩范围 |
| R5 | **状态栏/MVU 卡判定与"卡自带格式说明"探测不认别名**（§3.1 #4/#5） | `status_bar_detector.py:365`、`roleplay_prompt_assembly.py:3355` | 字面 `in` 判断；别名写法会漏判（前者可能不走 MVU 分支，后者可能重复注入说明） |
| R6 | 上游 `<UpdateVariable>` 内 **`<Analysis>` 抢先兜底**风险 | U6 之前 `tn` 先把 reasoning/analysis 标签连同内容从 `visible` 里抹掉再找数组 | Palink `_find_first_json_array` **不抹 `<Analysis>` 内容**：包裹块里没有 `<JSONPatch>` 而正文分析里恰好有个 `[…]` 时可能误采纳。本包未动该路径（改动会牵动既有"Analysis + 数组"用例的判据），登记观察 |
| R7 | 上游的 `<!-- mvu:discard-incomplete-json-patch -->` 丢弃哨兵 | U16 `bundle.js:2:358898` | Palink 无对应机制；出现该注释时上游丢块、Palink 照收。属行为差异，非本包范围 |
| R8 | **上线** | — | 归主控：`docker compose build backend && up -d backend`；上线后请复跑 §5.3 判定行 + 真机看别名块是否还留在正文 |

---

## 7. 订正说明（对主控给定的两条取证口径）

1. 提示词给的偏移 `462161` / `360382` 与实测锚点相差 63 / 56 字符（那两个数是
   needle `variableupdate)` 在文件中的位置，不是正则 `/` 起始位置）。本包一律按
   `data.find(字面 needle)` 的实测位置引用，并附 needle 便于复核：
   `Dr` 剥离正则起点 `2:462098`，`Ut` 记号正则起点 `2:360326`。
2. 「其它写法既解析不到、标签还留在正文里」只对**属性式**成立；
   别名/未闭合/自闭合改前**能**解析到，但走的是 `[BARE-JSONPATCH]` 裸数组兜底
   （它压根不看标签，只要正文里有结构像 patch 的数组）。准确口径见 §5.3 的订正块。

---

## 8. 复核方法（下一个人怎么自己验一遍）

```bash
cd /d/项目/Palink-AI
# ① 43 例（别名 35 + 裸 patch 块 8）应全绿
export MSYS_NO_PATHCONV=1
docker cp backend/app/services/mvu_engine.py palink-ai-backend-1:/app/app/services/mvu_engine.py
docker exec -w /app palink-ai-backend-1 python -m pytest \
  tests/test_mvu_variable_block_aliases.py tests/test_mvu_engine.py -q -p no:cacheprovider
# 期望：88 passed，退出码 0
# ② 全量
docker exec -w /app palink-ai-backend-1 python -m pytest tests/ -q -p no:cacheprovider
# 期望：2160 passed / 16 skipped，退出码 0；failed=0 errors=0
# ③ 验完把容器还原（本包交付时已还原，容器内 md5 应等于 HEAD 版本）
docker exec palink-ai-backend-1 python -c "import hashlib;print(hashlib.md5(open('/app/app/services/mvu_engine.py','rb').read()).hexdigest())"
```

⚠️ 第 ① 步的 `docker cp` 是**临时**把宿主机代码塞进运行中的容器做验证，不是上线；
验完必须还原（否则容器代码与镜像不一致，且容器重启策略会把它带进下一次启动）。
