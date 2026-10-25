/**
 * ST 兼容斜杠命令 · API-7 第一批（2026-10-24）
 *
 * 背景：`st-compat-commands.ts` 补的是**纯函数**（数学 / 文本 / 数组 / 变量），
 * 这一批补的是「命令表里仍报 Unknown command、但语义可确定」的第二类：
 * 纯逻辑工具 + 聊天消息读取 + 脚本注入。判据同 SPEC API-7：
 * 每条对 ST 1.18 权威名有**确定性返回**，且调用后不再落到 `Unknown command`。
 *
 * 一手来源（逐条对照，不自创语义）：`d:/SillyTavern-release`（只读授权在案）
 *   /test           slash-commands.js:3361 注册，:3366-3381 回调（regexFromString + JSON.stringify(bool)）
 *   /is-mobile      slash-commands.js:3262；isMobile() 见 RossAscends-mods.js:143
 *   /trimtokens     slash-commands.js:2820 注册，:3954-3994 回调（含"估算降级"分支）
 *   /count          extensions/token-counter/index.js:113 注册，:97-112 doCount
 *   /messages       slash-commands.js:2606 注册，:4151-4220 回调（range / names / hidden / role）
 *   /message-role   slash-commands.js:1162 注册，:5820-5858 回调
 *   /message-name   slash-commands.js:1204 注册，:5869-5915 回调
 *   /addswipe       slash-commands.js:2320 注册，:4617-4675 回调
 *   /delswipe       slash-commands.js:2074 注册，:4678-4685 回调 → script.js:9279 deleteSwipe
 *   /delname        slash-commands.js:1704 注册，:5047-5075 回调
 *   /comment        slash-commands.js:1400 注册，:6112-6157 回调
 *   /sendas         slash-commands.js:1254 注册，:5928-5991 回调
 *   /inject         slash-commands.js:2892 注册，:3778-3843 回调
 *   /listinjects    slash-commands.js:2942 注册，:3845-3862 回调
 *   /flushinject    slash-commands.js:2958 注册，:3870-3889 回调
 *
 * 设计红线：
 *   1. 不注册假实现。注入族真写 `promptInjection`（生成管线消费）+ chat_metadata；
 *      消息族真读写当前聊天的原生数组（与 getContext 的 `chat` 同一读源）。
 *   2. ⚠️ **消息写入仅内存态**：Palink 的 `palink:chatMessagesUpdated` 会让宿主
 *      从后端重载消息（CharacterView.tsx:1710），而消息落库属 API-3 未完成项
 *      （`getContext.ts:1839` 已留痕）。因此本文件的消息写入**不派发该事件**
 *      —— 派发只会把刚写的改动立刻冲掉。写入对同进程的卡脚本 / 插件可见，
 *      刷新后丢失。这是平台既有缺口，不是本批新造。
 *   3. 有意偏离全部就地写明（/is-mobile 的口径、/count 与 /trimtokens 的估算、
 *      /listinjects 的缺省返回、/message-name 的 avatar 字段不写）。
 */

import { SlashCommandEngine, ARGUMENT_TYPE } from './index';
import type { CommandDefinition } from './index';
import { getGlobalSillyTavernRuntime } from '../sillytavern/runtime';
import { messageManager } from '@/services/message-manager';
import { promptInjection } from '@/services/prompt-injection';
import { tokenizerService } from '@/lib/tokenizer/service';

const registered = new Set<string>();

/** 幂等注册一条命令；与既有命令重名时跳过（不覆盖）。 */
function register(name: string, def: Omit<CommandDefinition, 'name'>): void {
  if (registered.has(name)) return;
  if (SlashCommandEngine.getCommand(name)) return;
  SlashCommandEngine.register({ ...def, name });
  registered.add(name);
}

// ── ST 工具函数（逐字移植，出处见各函数注释）──────────────────────

/** utils.js:1011 isTrueBoolean：只有 on / true / 1 算真。 */
function isTrueBoolean(value: unknown): boolean {
  return ['on', 'true', '1'].includes(String(value ?? '').trim().toLowerCase());
}

/** utils.js:1020 isFalseBoolean：只有 off / false / 0 算假。 */
function isFalseBoolean(value: unknown): boolean {
  return ['off', 'false', '0'].includes(String(value ?? '').trim().toLowerCase());
}

/**
 * utils.js:279 stringToRange：`5-10` 或单个下标；越界 / 反序 / 非数字一律 null。
 * 照抄 ST 的解析顺序（先看有没有 `-`），负数区间因此天然不被支持。
 */
function stringToRange(input: unknown, min: number, max: number): { start: number; end: number } | null {
  const text = String(input ?? '');
  let start: number;
  let end: number;
  if (text.includes('-')) {
    const parts = text.split('-');
    start = parts[0] ? parseInt(parts[0], 10) : NaN;
    end = parts[1] ? parseInt(parts[1], 10) : NaN;
  } else {
    start = end = parseInt(text, 10);
  }
  if (Number.isNaN(start) || Number.isNaN(end) || start > end || start < min || end > max) return null;
  return { start, end };
}

/**
 * utils.js:1388 regexFromString：支持 `/pattern/flags` 与裸 pattern。
 * 非法的 flags 退回整串当 pattern（`RegExp(input)`），编译失败返回 undefined。
 */
function regexFromString(input: string): RegExp | undefined {
  try {
    const m = input.match(/(\/?)(.+)\1([a-z]*)/i);
    if (!m) return undefined;
    const flags = m[3] ?? '';
    if (flags && !/^(?!.*?(.).*?\1)[gmixXsuUAJ]+$/.test(flags)) return new RegExp(input);
    return new RegExp(m[2] ?? '', flags);
  } catch {
    return undefined;
  }
}

/** 文本命令取值口径：有未命名参数用参数，否则用管道输入。 */
function textOf(unnamedArgs: string[], pipe: string): string {
  const joined = unnamedArgs.join(' ');
  return joined || pipe || '';
}

// ── 当前聊天 / chat_metadata 的读写口径 ───────────────────────────
//
// 读源与 getContext.ts:1642 resolveNativeChat 同口径：优先 ST runtime 的
// `context.chat`（CharacterChat 每次渲染 setContext 喂入），为空才回退
// messageManager。写回也写同一个数组，保证「写完立刻读得到」。

/** 当前 ST runtime 上下文快照（拿不到时返回 null，不抛错）。 */
function runtimeContext(): any {
  try {
    return getGlobalSillyTavernRuntime()?.getContext?.() ?? null;
  } catch {
    return null;
  }
}

/** 当前聊天的原生消息数组（活引用，可直接改）。 */
function resolveChat(): any[] {
  const chat = runtimeContext()?.chat;
  if (Array.isArray(chat) && chat.length > 0) return chat;
  return messageManager.messages as any[];
}

/** 当前 chat_metadata（ST runtime 的 chatMetadata / window.chat_metadata，缺失时就地创建）。 */
function resolveChatMetadata(): Record<string, any> {
  const ctx = runtimeContext();
  let metadata = ctx?.chatMetadata;
  if (!metadata || typeof metadata !== 'object') metadata = ctx?.chat_metadata;
  if ((!metadata || typeof metadata !== 'object') && typeof window !== 'undefined') {
    metadata = (window as any).chat_metadata;
  }
  if (!metadata || typeof metadata !== 'object') {
    metadata = {};
    const runtime: any = getGlobalSillyTavernRuntime();
    if (runtime && runtime.context) runtime.context.chatMetadata = metadata;
  }
  return metadata as Record<string, any>;
}

/** 取指定下标的消息；支持负数深度（-1 = 末条之前那条，ST 口径）。 */
function messageAt(chat: any[], at: unknown): { index: number; message: any } | null {
  const raw = Number(at ?? (chat.length - 1));
  let index = raw;
  if (!Number.isNaN(index) && (index < 0 || Object.is(index, -0))) index = chat.length + index;
  if (!Number.isInteger(index) || index < 0 || index >= chat.length) return null;
  return { index, message: chat[index] };
}

/** 插入位置：`at` 合法（含负数深度）则插到该处，否则追加到末尾。 */
function insertMessage(chat: any[], message: any, at: unknown): number {
  const raw = Number(at);
  let index = raw;
  if (!Number.isNaN(index) && (index < 0 || Object.is(index, -0))) index = chat.length + index;
  if (Number.isInteger(index) && index >= 0 && index <= chat.length) {
    chat.splice(index, 0, message);
    return index;
  }
  chat.push(message);
  return chat.length - 1;
}

// ST system-messages.js:18 system_message_types（只用到这两个）
const SYSTEM_MESSAGE_NARRATOR = 'narrator';
const SYSTEM_MESSAGE_COMMENT = 'comment';
// slash-commands.js:3770 COMMENT_NAME_DEFAULT
const COMMENT_NAME_DEFAULT = 'Note';
// slash-commands.js:3771 SCRIPT_PROMPT_KEY
const SCRIPT_PROMPT_KEY = 'script_inject_';

/**
 * 注册 API-7 第一批命令。幂等，可重复调用。
 * @returns 本次实际新增的命令名
 */
export function registerStChatCommands(): string[] {
  const before = new Set(SlashCommandEngine.getAllCommands().map((c) => c.name));
  const strArg = (name: string, description: string, required = false) => ({
    name,
    description,
    type: [ARGUMENT_TYPE.STRING],
    isRequired: required,
  });

  // ── 纯函数 / 工具 ──────────────────────────────────────────────

  // slash-commands.js:3361-3381：pattern 为空或非法抛错，否则 JSON.stringify(bool)。
  register('test', {
    description: 'Test text against a regular expression (true/false)',
    namedArgs: [strArg('pattern', 'pattern to find', true)],
    unnamedArgs: [strArg('text', 'text to test (or pipe)')],
    callback: (n, u, c) => {
      const pattern = String(n.pattern ?? '');
      if (!pattern.trim()) throw new Error("Argument of 'pattern=' cannot be empty");
      const re = regexFromString(pattern);
      if (!re) throw new Error("The value of 'pattern' argument is not a valid regular expression.");
      return JSON.stringify(re.test(textOf(u, c?.pipe ?? '')));
    },
  });

  // slash-commands.js:3262-3266。⚠️ 有意偏离：ST 的 isMobile() 读 UA 平台类型
  // （RossAscends-mods.js:143 mobile / tablet）；Palink 的 `{{isMobile}}` 与
  // getContext().isMobile 一律是「视口 ≤ 767px」媒体查询（getContext.ts:2920），
  // 命令帮助原文写的就是 "Equivalent to {{isMobile}} macro" ⇒ 这里跟 Palink 既有口径，
  // 保证同一进程里宏与命令不打架。
  register('is-mobile', {
    description: 'Return true when the viewport is a mobile layout (same rule as {{isMobile}})',
    callback: () => {
      try {
        const matches = typeof window !== 'undefined' && typeof window.matchMedia === 'function'
          ? window.matchMedia('(max-width: 767px)').matches
          : false;
        return String(Boolean(matches));
      } catch {
        return 'false';
      }
    },
  });

  // slash-commands.js:3954-3994。ST 的精确分支要 tokenizer 词表（getTextTokens），
  // 拿不到时走它自己的「估算降级」分支（:3980-3986）——本实现即该分支，
  // 并对齐三个前置判据：无文本 → ''；limit 非数字 → 原样返回；limit ≤ 0 → ''。
  register('trimtokens', {
    description: 'Trim the start or end of text to the specified number of tokens (local estimate)',
    namedArgs: [
      { name: 'limit', description: 'number of tokens to keep', type: [ARGUMENT_TYPE.NUMBER], isRequired: true },
      { name: 'direction', description: 'trim direction: start or end', type: [ARGUMENT_TYPE.STRING], isRequired: false, defaultValue: 'end' },
    ],
    unnamedArgs: [strArg('text', 'text to trim (or pipe)')],
    callback: (n, u, c) => {
      const value = textOf(u, c?.pipe ?? '');
      if (!value) {
        console.warn('WARN: No argument provided for /trimtokens command');
        return '';
      }
      const limit = Number(n.limit);
      if (Number.isNaN(limit)) {
        console.warn(`WARN: Invalid limit provided for /trimtokens command: ${n.limit}`);
        return value;
      }
      if (limit <= 0) return '';
      const tokenCount = tokenizerService.estimate(value);
      if (tokenCount <= limit) return value;
      const direction = String(n.direction || 'end');
      const percentage = limit / tokenCount;
      const trimIndex = Math.floor(value.length * percentage);
      return direction === 'start' ? value.substring(trimIndex) : value.substring(0, value.length - trimIndex);
    },
  });

  // extensions/token-counter/index.js:97-112 doCount：只统计非 system 且有正文的消息。
  // ⚠️ 有意偏离：ST 用 getTokenCountAsync（真实词表）；本实现用本地估算
  // （tokenizerService.estimate，与 ST 的 estimation 降级口径同型），不触发网络。
  register('count', {
    description: 'Count tokens of the current chat (local estimate, non-system messages only)',
    callback: () => {
      const chat = resolveChat();
      const allMessages = chat
        .filter((m: any) => m && m.mes && !m.is_system)
        .map((m: any) => m.mes)
        .join(' ');
      return String(tokenizerService.estimate(allMessages));
    },
  });

  // ── 消息读取 ──────────────────────────────────────────────────

  // slash-commands.js:4151-4220。names 缺省 off（不带作者名）、hidden 缺省 on、
  // role 三值过滤；range 非法 → warn + ''；多段之间用两个换行拼接。
  register('messages', {
    description: 'Return the specified message or range as text (names/hidden/role filters)',
    namedArgs: [
      { name: 'names', description: 'show message author names', type: [ARGUMENT_TYPE.BOOLEAN], isRequired: false, defaultValue: 'off' },
      { name: 'hidden', description: 'include hidden (system) messages', type: [ARGUMENT_TYPE.BOOLEAN], isRequired: false, defaultValue: 'on' },
      { name: 'role', description: 'filter messages by role: system / assistant / user', type: [ARGUMENT_TYPE.STRING], isRequired: false },
    ],
    unnamedArgs: [strArg('range', 'message index (starts with 0) or inclusive range', true)],
    callback: (n, u, c) => {
      const chat = resolveChat();
      const includeNames = !isFalseBoolean(n.names ?? 'off');
      const includeHidden = isTrueBoolean(n.hidden ?? 'on');
      const role = n.role ? String(n.role).trim().toLowerCase() : '';
      const range = stringToRange(textOf(u, c?.pipe ?? ''), 0, chat.length - 1);
      if (!range) {
        console.warn(`WARN: Invalid range provided for /messages command: ${textOf(u, c?.pipe ?? '')}`);
        return '';
      }
      const filterByRole = (message: any): boolean => {
        if (!role) return true;
        const isNarrator = message?.extra?.type === SYSTEM_MESSAGE_NARRATOR;
        if (role === 'system') return isNarrator && !message.is_user;
        if (role === 'assistant') return !isNarrator && !message.is_user;
        if (role === 'user') return !isNarrator && message.is_user;
        throw new Error(`Invalid role provided. Expected one of: system, assistant, user. Got: ${role}`);
      };
      const parts: string[] = [];
      for (let index = range.start; index <= range.end; index += 1) {
        const message = chat[index];
        if (!message) {
          console.warn(`WARN: No message found with ID ${index}`);
          continue;
        }
        if (role && !filterByRole(message)) continue;
        if (!includeHidden && message.is_system) continue;
        parts.push(includeNames ? `${message.name}: ${message.mes}` : String(message.mes ?? ''));
      }
      return parts.join('\n\n');
    },
  });

  // slash-commands.js:5820-5858：无 role 时只读；有 role 时改写消息角色。
  register('message-role', {
    description: 'Get or set the role of a message sender (user/assistant/system)',
    namedArgs: [
      { name: 'at', description: 'message index; negative counts from the end; defaults to the last message', type: [ARGUMENT_TYPE.NUMBER], isRequired: false },
    ],
    unnamedArgs: [strArg('role', 'role to set: user / assistant / system')],
    callback: (n, u) => {
      const chat = resolveChat();
      const target = messageAt(chat, n.at);
      if (!target) {
        console.warn('No message found at the specified index.');
        return '';
      }
      const message = target.message;
      const role = String(u[0] ?? '').trim().toLowerCase();
      if (!role || !['user', 'assistant', 'system'].includes(role)) {
        if (message?.extra?.type === SYSTEM_MESSAGE_NARRATOR) return 'system';
        return message?.is_user ? 'user' : 'assistant';
      }
      message.extra = message.extra && typeof message.extra === 'object' ? message.extra : {};
      if (role === 'system') message.extra.type = SYSTEM_MESSAGE_NARRATOR;
      else delete message.extra.type;
      message.is_user = role === 'user';
      return role;
    },
  });

  // slash-commands.js:5869-5915。⚠️ 有意偏离：ST 还会按角色/人设解析 avatar 并写
  // force_avatar / original_avatar；Palink 的角色头像目录与 ST 不同源，这里只改
  // name（返回新的 name），不写 avatar 字段 —— 免得写进一个错误的缩略图路径。
  register('message-name', {
    description: 'Get or set the name of a message sender',
    namedArgs: [
      { name: 'at', description: 'message index; negative counts from the end; defaults to the last message', type: [ARGUMENT_TYPE.NUMBER], isRequired: false },
    ],
    unnamedArgs: [strArg('name', 'new display name for the message sender')],
    callback: (n, u) => {
      const chat = resolveChat();
      const target = messageAt(chat, n.at);
      if (!target) {
        console.warn('No message found at the specified index.');
        return '';
      }
      const message = target.message;
      const name = String(u[0] ?? '').trim();
      if (!name) return String(message?.name ?? '');
      message.name = name;
      return name;
    },
  });

  // ── 消息写入（仅内存态，见文件头红线 2）─────────────────────────

  // slash-commands.js:4617-4675：只操作最后一条；user / system 消息不给加；
  // 缺 swipes 时用当前正文补第一条；返回新 swipe 的下标。
  register('addswipe', {
    description: 'Add a swipe to the last chat message (in-memory only)',
    namedArgs: [
      { name: 'switch', description: 'switch to the new swipe', type: [ARGUMENT_TYPE.BOOLEAN], isRequired: false },
    ],
    unnamedArgs: [strArg('text', 'swipe text', true)],
    callback: (n, u, c) => {
      const chat = resolveChat();
      const lastMessage = chat[chat.length - 1];
      const value = textOf(u, c?.pipe ?? '');
      if (!lastMessage) {
        console.warn('No messages to add swipes to.');
        return '';
      }
      if (!value) {
        console.warn('WARN: No argument provided for /addswipe command');
        return '';
      }
      if (lastMessage.is_user) {
        console.warn("Can't add swipes to user messages.");
        return '';
      }
      if (lastMessage.is_system) {
        console.warn("Can't add swipes to system messages.");
        return '';
      }
      if (!Array.isArray(lastMessage.swipes)) {
        lastMessage.swipes = [lastMessage.mes ?? ''];
        lastMessage.swipe_info = [{}];
        lastMessage.swipe_id = 0;
      }
      if (!Array.isArray(lastMessage.swipe_info)) {
        lastMessage.swipe_info = lastMessage.swipes.map(() => ({}));
      }
      lastMessage.swipes.push(value);
      lastMessage.swipe_info.push({
        send_date: Date.now(),
        gen_started: null,
        gen_finished: null,
        extra: { gen_id: Date.now(), api: 'manual', model: 'slash command' },
      });
      const newSwipeId = lastMessage.swipes.length - 1;
      if (isTrueBoolean(n.switch ?? '')) {
        lastMessage.swipe_id = newSwipeId;
        lastMessage.mes = lastMessage.swipes[newSwipeId];
        lastMessage.extra = (lastMessage.swipe_info?.[newSwipeId]?.extra ?? lastMessage.extra ?? {});
      }
      return String(newSwipeId);
    },
  });

  // slash-commands.js:4678-4685 → script.js:9279 deleteSwipe：参数是 1-based，
  // 缺省删当前 swipe；只剩一条时拒绝；返回新的（选中）swipe 下标。
  register('delswipe', {
    description: 'Delete a swipe from the last chat message; returns the new swipe id (in-memory only)',
    unnamedArgs: [
      { name: 'swipeId', description: '1-based swipe id (defaults to the current swipe)', type: [ARGUMENT_TYPE.NUMBER], isRequired: false },
    ],
    callback: (_n, u) => {
      const arg = u[0];
      const requested = arg && !Number.isNaN(Number(arg)) ? Number(arg) - 1 : null;
      const chat = resolveChat();
      const message = chat[chat.length - 1];
      if (!message || !Array.isArray(message.swipes) || !message.swipes.length) {
        console.warn('No messages to delete swipes from.');
        return '';
      }
      if (message.swipes.length <= 1) {
        console.warn("Can't delete the last swipe.");
        return '';
      }
      let swipeId = Number(requested ?? message.swipe_id ?? 0);
      const currentSwipeId = Math.min(Math.max(Number(message.swipe_id ?? 0), 0), message.swipes.length - 1);
      if (!Number.isInteger(swipeId) || swipeId < 0 || swipeId >= message.swipes.length) {
        console.warn(`Invalid swipe ID: ${swipeId + 1}`);
        return '';
      }
      message.swipes.splice(swipeId, 1);
      if (Array.isArray(message.swipe_info) && message.swipe_info.length) {
        message.swipe_info.splice(swipeId, 1);
      }
      let newSwipeId: number;
      if (swipeId < currentSwipeId) newSwipeId = currentSwipeId - 1;
      else if (swipeId > currentSwipeId) newSwipeId = currentSwipeId;
      else newSwipeId = Math.min(swipeId, message.swipes.length - 1);
      message.swipe_id = newSwipeId;
      message.mes = message.swipes[newSwipeId] ?? message.mes;
      return String(newSwipeId);
    },
  });

  // slash-commands.js:5047-5075：删掉所有 name 相同的消息。ST 返回 undefined ⇒ ''。
  register('delname', {
    description: 'Delete all messages attributed to the specified name (in-memory only)',
    unnamedArgs: [strArg('name', 'character or persona name', true)],
    callback: (_n, u) => {
      const name = textOf(u, '').trim();
      if (!name) {
        console.warn('WARN: No name provided for /delname command');
        return '';
      }
      const chat = resolveChat();
      for (let index = chat.length - 1; index >= 0; index -= 1) {
        if (chat[index]?.name === name) chat.splice(index, 1);
      }
      return '';
    },
  });

  // slash-commands.js:6112-6157：注释消息（is_system + extra.type=comment）。
  register('comment', {
    description: 'Add a note/comment message not part of the chat (in-memory only)',
    namedArgs: [
      { name: 'compact', description: 'use a compact layout', type: [ARGUMENT_TYPE.BOOLEAN], isRequired: false, defaultValue: 'false' },
      { name: 'at', description: 'insert position; negative counts from the end', type: [ARGUMENT_TYPE.NUMBER], isRequired: false },
    ],
    unnamedArgs: [strArg('text', 'comment text')],
    callback: (n, u, c) => {
      const text = textOf(u, c?.pipe ?? '').trim();
      const message = {
        name: COMMENT_NAME_DEFAULT,
        is_user: false,
        is_system: true,
        send_date: Date.now(),
        mes: text,
        extra: {
          type: SYSTEM_MESSAGE_COMMENT,
          gen_id: Date.now(),
          isSmallSys: isTrueBoolean(n.compact ?? 'false'),
          api: 'manual',
          model: 'slash command',
        },
      };
      insertMessage(resolveChat(), message, n.at);
      return '';
    },
  });

  // slash-commands.js:5928-5991。⚠️ 有意偏离：ST 还会跑 regex、抽 bias、解析
  // avatar 覆盖；Palink 这边只落 name / 正文 / 基础 extra。`avatar` 参数接受但被忽略
  // （Palink 角色头像目录与 ST 不同源，写错路径比不写更糟）。
  register('sendas', {
    description: 'Send a message as the given character without generating (in-memory only)',
    namedArgs: [
      { name: 'name', description: 'character name (defaults to the current character)', type: [ARGUMENT_TYPE.STRING], isRequired: false },
      { name: 'compact', description: 'use a compact layout', type: [ARGUMENT_TYPE.BOOLEAN], isRequired: false, defaultValue: 'false' },
      { name: 'at', description: 'insert position; negative counts from the end', type: [ARGUMENT_TYPE.NUMBER], isRequired: false },
      { name: 'return', description: 'none (default) or pipe', type: [ARGUMENT_TYPE.STRING], isRequired: false, defaultValue: 'none' },
    ],
    unnamedArgs: [strArg('text', 'message text')],
    callback: (n, u, c) => {
      const ctx = runtimeContext();
      const name = String(n.name ?? '').trim() || String(ctx?.character?.name ?? '').trim();
      if (!name) {
        console.warn('WARN: /sendas needs a name (no current character available)');
        return '';
      }
      const mes = textOf(u, c?.pipe ?? '').trim();
      const compact = isTrueBoolean(n.compact ?? 'false');
      const sendDate = Date.now();
      const message = {
        name,
        is_user: false,
        is_system: false,
        send_date: sendDate,
        mes,
        swipes: [mes],
        swipe_id: 0,
        swipe_info: [{ send_date: sendDate, gen_started: null, gen_finished: null, extra: {} }],
        extra: { gen_id: sendDate, isSmallSys: compact, api: 'manual', model: 'slash command' },
      };
      insertMessage(resolveChat(), message, n.at);
      return String(n.return ?? 'none') === 'pipe' ? mes : '';
    },
  });

  // ── 脚本注入（真写 promptInjection + chat_metadata）──────────────
  //
  // slash-commands.js:3778-3843 / :3845-3862 / :3870-3889。
  // ST extension_prompt_types：NONE -1 / IN_PROMPT 0 / IN_CHAT 1 / BEFORE_PROMPT 2
  // （script.js:483-488，与 services/prompt-injection.ts:37 INJECTION_POSITION 同值）；
  // extension_prompt_roles：SYSTEM 0 / USER 1 / ASSISTANT 2。
  // 注入落点用 Palink 的 promptInjection.setExtensionPrompt（:247），
  // 它登记进当前角色的沙箱分区，生成时由 getPromptsForGeneration 消费。
  const INJECT_POSITIONS: Record<string, number> = { before: 2, after: 0, chat: 1, none: -1 };
  const INJECT_ROLES: Record<string, number> = { system: 0, user: 1, assistant: 2 };

  register('inject', {
    description: 'Add a script injection for the current chat; returns the injection id',
    namedArgs: [
      { name: 'id', description: 'injection ID', type: [ARGUMENT_TYPE.STRING], isRequired: false },
      { name: 'position', description: 'before / after / chat / none', type: [ARGUMENT_TYPE.STRING], isRequired: false, defaultValue: 'after' },
      { name: 'depth', description: 'injection depth', type: [ARGUMENT_TYPE.NUMBER], isRequired: false, defaultValue: '4' },
      { name: 'scan', description: 'include injection content into World Info scans', type: [ARGUMENT_TYPE.BOOLEAN], isRequired: false, defaultValue: 'false' },
      { name: 'role', description: 'role for in-chat injections: system / user / assistant', type: [ARGUMENT_TYPE.STRING], isRequired: false },
    ],
    unnamedArgs: [strArg('value', 'injection text (empty removes the injection)')],
    callback: (n, u, c) => {
      const id = String(n.id ?? '') || Math.random().toString(36).substring(2);
      const positionName = String(n.position ?? 'after');
      const position = INJECT_POSITIONS[positionName] ?? INJECT_POSITIONS.after;
      const depthValue = Number(n.depth ?? 4);
      const depth = Number.isNaN(depthValue) ? 4 : depthValue;
      const roleName = String(n.role ?? 'system').trim().toLowerCase();
      const role = INJECT_ROLES[roleName] ?? INJECT_ROLES.system;
      const scan = isTrueBoolean(n.scan ?? 'false');
      const value = textOf(u, c?.pipe ?? '');
      const metadata = resolveChatMetadata();
      if (!metadata.script_injects || typeof metadata.script_injects !== 'object') metadata.script_injects = {};
      if (value) metadata.script_injects[id] = { value, position, depth, scan, role };
      else delete metadata.script_injects[id];
      promptInjection.setExtensionPrompt(SCRIPT_PROMPT_KEY + id, String(value), position, depth, scan, role);
      return id;
    },
  });

  register('flushinject', {
    description: 'Remove one script injection, or all of them when no id is given',
    unnamedArgs: [strArg('id', 'injection ID to remove (default: all)')],
    callback: (_n, u) => {
      const metadata = resolveChatMetadata();
      const injects = metadata.script_injects;
      if (!injects || typeof injects !== 'object') return '';
      const onlyId = textOf(u, '').trim();
      for (const [id, inject] of Object.entries<any>(injects)) {
        if (onlyId && id !== onlyId) continue;
        promptInjection.setExtensionPrompt(
          SCRIPT_PROMPT_KEY + id,
          '',
          inject?.position,
          inject?.depth,
          inject?.scan,
          inject?.role,
        );
        delete injects[id];
      }
      return '';
    },
  });

  // ⚠️ 有意偏离：ST 缺省 return=popup-html（走弹窗、返回空串）。Palink 引擎没有
  // popup 返回通道，缺省改为直接返回可读文本；`return=object|pipe` 返回 JSON。
  register('listinjects', {
    description: 'List script injections (JSON when return=object|pipe, readable text otherwise)',
    namedArgs: [
      { name: 'return', description: 'object / pipe / text', type: [ARGUMENT_TYPE.STRING], isRequired: false, defaultValue: 'text' },
    ],
    callback: (n) => {
      const metadata = resolveChatMetadata();
      const injects = (metadata.script_injects && typeof metadata.script_injects === 'object')
        ? metadata.script_injects
        : {};
      const mode = String(n.return ?? 'text').trim().toLowerCase();
      if (mode === 'object' || mode === 'pipe') return JSON.stringify(injects);
      const positionNames: Record<number, string> = { '-1': 'NONE', 0: 'IN_PROMPT', 1: 'IN_CHAT', 2: 'BEFORE_PROMPT' };
      const lines = Object.entries<any>(injects).map(([id, inject]) => (
        `* **${id}**: <code>${String(inject?.value ?? '')}</code> `
        + `(${positionNames[Number(inject?.position)] ?? 'unknown'}, depth: ${inject?.depth}, `
        + `scan: ${inject?.scan ?? false}, role: ${inject?.role ?? 0})`
      ));
      return `### Script injections:\n${lines.length ? lines.join('\n') : 'No script injections for the current chat'}`;
    },
  });

  const after = SlashCommandEngine.getAllCommands().map((c) => c.name);
  return after.filter((name) => !before.has(name));
}
