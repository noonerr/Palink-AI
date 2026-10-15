# ST 上游源码锚定与 docs 引用可复核性

> 日期：2026-10-15
> 结论：**docs/ 里 404 处 `文件:行号` 引用已全部定性完毕，0 处陈旧**。
> 配套脚本：`scripts/check_st_citations.py`（`failed` 必须为 0），已接入 `scripts/gate.sh docs`
> 参考副本：`_reference/sillytavern-1.18.0/`（**不入库**，见 `.gitignore` 2026-10-15 条目）

## 一、为什么要做这件事

本项目的 ST 兼容准确性，一直是靠一条闭环挣来的：

```
读上游源码  ->  引用 文件:行号  ->  修偏差  ->  回归测试
```

这条闭环不是推测，有据可查。`docs/DEEP_AUDIT_REPORT_2026-08-09.md` 的「依据」栏直接写着
本地 ST 1.18.0 官方源码路径；`docs/` 里共 25 份文档在用 `上游文件:行号` 粒度做论证。
它产出过真实的 P0 修复：

| 文档引用 | 上游实际内容（本次逐行复核） | 判定 |
|---|---|---|
| `world-info.js:855-864` | `world_info_position = {before:0, after:1, ANTop:2, ANBottom:3, atDepth:4, EMTop:5, EMBottom:6, outlet:7}` | 8 位置枚举属实 ⇒「position 整体偏移 1」是真 bug，修对了 |
| `script.js:3359-3362` | `jailbreak: () => {...character.data?.post_history_instructions...}` | `{{jailbreak}}` 宏确实存在 ⇒「漏实现」是真漏 |
| `openai.js:107` | `default_new_chat_prompt = '[Start a new Chat]'` | 命中 |
| `openai.js:1069-1070` | `insertAtStart(newChatMessage, 'chatHistory')` | 「无条件插入」命中 |
| `personas.js:88-97` | `IN_PROMPT:0, AFTER_CHAR:1, TOP_AN:2, BOTTOM_AN:3, AT_DEPTH:4, NONE:9` | 枚举真值命中 |

**问题在于：闭环的第 1 环断了。** 审计报告所引用的 `SillyTavern-1.18.0/` 副本
**已从项目里消失**（`ls` 实测不存在）。D 盘另有一份 `D:\SillyTavern-release`
（`package.json` version = 1.18.0），但它在项目外、非 git 仓库、无 tag 锁定、
不在任何人的认知里。后果是：那批引用**在项目内无法复核** —— 换台机器、换个人，
`world-info.js:855-864` 就成了一句无法验证的话。

> 顺带记录：曾评估用 GitHub 开源项目 REA（Reverse Engineer Anything）做逆向。
> **不采纳**。ST 前端是未打包的 ES module（`public/script.js`、`public/scripts/*.js`），
> 不是压缩产物，REA 的 JS 恢复能力没有作用对象；其原生二进制能力对 Node 应用亦无对象。
> 缺的是锚，不是逆向工具。评估结论见 `.workbuddy-ai/memory/2026-10-15.md`。

## 二、锚定了什么

`_reference/sillytavern-1.18.0/`：ST 1.18.0 源码，保留 `public/`、`src/`、`default/`、
`package.json`、`LICENSE`、`README.md`；裁剪纯资源目录（`public/webfonts`、`public/img`、
`public/sounds`、`src/tokenizers`、`default/content`、`*.ico/*.png/*.jpg/*.webp`）。

**61M → 17M / 544 文件**。裁剪的只有资源，没有可被 `file:line` 引用的源码。

**该目录不入库、不进镜像、不进构建**（`.gitignore`）。入库的是锚定说明（本文）与校验脚本。
这与 `_BACKUPS/` 的「台账入库、大产物排除」同一口径。

## 三、当前校验结果（2026-10-15）

```
py scripts/check_st_citations.py        # 或 bash scripts/gate.sh docs

  文档中 file:line 引用总数        : 404
  OK -> ST 上游                    : 321
  OK -> Palink 本仓                : 40
  两棵树都没有该文件名             : 32
  未定位（文档只写了裸文件名）     : 11
  失败（行号超出文件总行数）       : 0

failed = 0
```

（本文自身也被校验，所以计数会随本文修订而变；`failed` 恒须为 0。）

### 引用引的是两棵树（实测发现）

校验器一开始只认上游，结果把 `index.js:524` 判成失效。查证后发现它指的是
**本仓** `st-plugins/memory/index.js:524`：

```js
return removeReasoningFromString(await generateRaw({ prompt: text, systemPrompt: prompt,
  responseLength: extension_settings.memory.overrideResponseLength }));
```

正是文档所说的「memory 插件以单对象调用 `generateRaw`」。所以校验器分两棵树：
**ST 上游**（`_reference/`）与 **Palink 本仓**（`st-plugins/ frontend/src/ backend/app/ scripts/`）。

### 11 处「未定位」是什么

`engine.js`（5 处）、`index.js`（6 处）—— 文档只写了裸文件名，而两棵树里各有多个同名文件
（`index.js` 有 16 个以上）。**校验器不猜**：同名文件超过 6 个就不做统计裁决，
报「未定位」而不是给一个可能错误的 OK。

要让它们变成可复核，只需在文档里写全路径，例如把 `index.js:979` 写成
`src/endpoints/chats.js:979`。这类改写属文档修订，未在本批施工范围内。

### 32 处「两棵树都没有」

多为第三方插件文件（`st-plugins/third-party/` 已按 `.gitignore` 排除，非本仓可复核范围）
或已删文件。不计入失败。

## 四、校验器怎么裁决同名文件（不猜的设计）

文档写裸文件名是常态，所以裁决规则必须明确且可辩护：

1. **文档写全了路径** → 直接采信（如 `src/endpoints/chats.js:483`）
2. **markdown 链接给了完整 URL** → 从 URL 取路径
3. **路径后缀唯一匹配** → `vectors/manifest.json` 落到
   `public/scripts/extensions/vectors/manifest.json`
4. **同一文档内该文件名只有唯一一种显式写法** → 沿用
   （反例已实测：`架构审查与缺陷总表_2026-10-03.md` 同一行里同时写了
   `memory/index.js:1127` 与 `stable-diffusion/index.js:5989`，
   此时任何"文档默认值"都是错的，必须放弃沿用）
5. **同名文件 ≤6 个** → 按引用覆盖度裁决（胜者须覆盖 ≥90% 且严格优于次席）
6. 以上都不成立 → **报「未定位」，不给假 OK**

最后一条是本脚本的核心纪律：**假 OK 比漏报危险得多** —— 它会让读者误信引用已核。

## 五、维护纪律

- **已接入门禁**：`scripts/gate.sh docs` 会跑本校验。
  但 `_reference/` 不入库，故该目录缺失时门禁**跳过并提示**，而不是报红 ——
  否则会重蹈「恒红的门禁等于没有门禁」（见 gate.sh 头部 2026-10-10 教训）。
- **改动 docs/ 里的引用后**跑一次 `py scripts/check_st_citations.py`，`failed` 必须为 0。
- **升级对齐的 ST 版本时**：换掉 `_reference/sillytavern-1.18.0/`，重跑校验。
  预期会有若干引用因上游行号漂移而 `OUT_OF_RANGE` —— 那正是需要人工复核的清单，
  不要为了让脚本变绿去调脚本。
- **换机器**：`_reference/` 不入库，按 `_reference/README.md` 重新锚定。
- 脚本里的人工裁定表 `CITATION_OVERRIDES` 只收录证据充分的疑难引用，
  每条都在注释里写明判定依据；新增条目必须附证据，不接受「看起来像」。
