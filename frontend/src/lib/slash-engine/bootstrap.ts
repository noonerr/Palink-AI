/**
 * 斜杠命令引擎启动器（幂等）。
 *
 * 背景（2026-10-18 实测，包 B B-1 开工核查）：
 *   `lib/slash-engine/commands.ts`（31 处 register）与 `extended-commands.ts`（48 处 register）
 *   共 79 处注册**全部写在函数体内**，模块加载时不执行；而唯一调用它们的
 *   `initSlashCommands()`（`./mod.ts:48`）此前**全仓 0 个调用点**，`mod.ts` 也 0 个 importer
 *   ⇒ 生产运行时 `SlashCommandEngine` 只有插件运行时注册的命令，内置命令为 **0 条**。
 *
 * 后果：卡脚本 / ST 插件调 `executeSlashCommands('/echo x')`、`/abs`、`/let`、`/if` 等
 * 一律拿不到结果，与「Palink 有 92 条命令」的源码印象不符。
 *
 * 本模块在应用入口调用一次，把内置命令真正注册进引擎。幂等：重复调用直接返回。
 */

import { initSlashCommands } from './mod';
import { registerStCompatCommands } from './st-compat-commands';
import { registerStChatCommands } from './st-compat-commands-chat';

let bootstrapped = false;

/**
 * 注册内置斜杠命令 + ST 兼容补充命令。幂等，可在任意入口重复调用。
 *
 * @returns 本次调用是否真的执行了注册（首次 true，之后 false）
 */
export function ensureSlashCommandsBootstrapped(): boolean {
  if (bootstrapped) return false;
  bootstrapped = true;
  try {
    initSlashCommands();
    // ST 数学 / 文本 / 数组类命令（Palink 内置集里没有对应物，见 st-compat-commands.ts）
    registerStCompatCommands();
    // [API-7 第一批 2026-10-24 / 第二批 2026-10-26] 纯逻辑工具 + 消息读写 + 脚本注入
    // + 元数据（/note 族）+ 人设读取（/persona-get），见 st-compat-commands-chat.ts
    registerStChatCommands();
  } catch (e) {
    // 注册失败不能拦住应用启动：引擎空着时行为等同修复前（命令返回空串）。
    bootstrapped = false;
    console.warn('[Palink slash-engine] 内置命令注册失败：', e);
    return false;
  }
  return true;
}

/** 仅测试用：重置幂等标记（生产代码不要调用）。 */
export function __resetSlashCommandsBootstrapForTests(): void {
  bootstrapped = false;
}
