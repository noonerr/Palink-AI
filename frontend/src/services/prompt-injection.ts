/**
 * 提示词注入服务
 *
 * 提供 ST 兼容的扩展提示词注入接口，供 getContext.ts、sandbox.ts、useCharacterChat.ts
 * 和 smart-card iframe 使用。
 *
 * 多 source 分区（[EP-BRIDGE]）：
 * - `sandbox:<characterId>`：父页面插件沙箱 / getContext / 世界书等现有写入方
 *   （setExtensionPrompt 默认源，**按角色分区**）
 * - `frame:<frameId>`：smart-card iframe 经 postMessage 上报（setSourcePrompts）
 * getPromptsForGeneration(characterId) 返回该角色 sandbox 分区 + 全部 frame 分区的
 * 聚合视图（后写覆盖先写，对齐 ST 同 identifier 覆盖语义）。
 * removeSource() 供 iframe 卸载 / 切卡时精确清理，避免跨角色/跨卡污染。
 *
 * [XCHAR-PROMPT-BLEED 2026-10-03] sandbox 分区的角色维度：
 * 修复前分区键恒为 'sandbox'（全局单池），而清理只发生在 iframe 卸载时
 * （CharacterCardRenderer.tsx removeSource('frame:<id>')）—— **'sandbox' 分区切卡
 * 永不清**。用户从卡 A 切到卡 B，B 的生成仍聚合到 A 残留的沙箱注册项，这就是
 * 「在角色 A 的卡上生成、提示词里混进角色 B 的内容」的前端一半根因。
 * 改法：分区键带角色 id，取用时按当前角色取，切卡时显式清旧角色的分区。
 *
 * 方法签名与 ST 1.18.0 对齐。
 */

/**
 * 扩展提示词插入位置枚举
 *
 * 与 ST 1.18.0 的 extension_prompt_types（script.js:491-496）完全对齐：
 *   NONE: -1          不注入
 *   IN_PROMPT: 0      作为 system prompt 追加到末尾（position='end'），不按 depth
 *   IN_CHAT: 1        按 depth 插入到 chat history
 *   BEFORE_PROMPT: 2  作为 system prompt 插入到最前（position='start'），不按 depth
 *
 * ST extension_prompt_roles（script.js:501-505）：
 *   SYSTEM: 0 / USER: 1 / ASSISTANT: 2
 */
export const INJECTION_POSITION = {
  /** 不注入 */
  NONE: -1,
  /** 作为 system prompt 追加到末尾（不按 depth） */
  IN_PROMPT: 0,
  /** 按 depth 插入到 chat history */
  IN_CHAT: 1,
  /** 作为 system prompt 插入到最前（不按 depth） */
  BEFORE_PROMPT: 2,
  /** @deprecated 使用 IN_CHAT 代替（值相同，保留向后兼容） */
  AFTER: 1,
} as const;

/**
 * 扩展提示词条目结构
 *
 * 与 ST 1.18.0 的 extension_prompts 字段对齐（script.js:8904-8912）。
 */
export interface ExtensionPromptEntry {
  /** 提示词内容 */
  content: string;
  /** 插入位置（ST extension_prompt_types 枚举值：-1/0/1/2） */
  position?: number;
  /** 插入深度（从消息末尾往回数的位置，仅 IN_CHAT 生效） */
  depth?: number;
  /** 是否扫描该提示词中的宏 */
  scan?: boolean;
  /** 角色标识（ST extension_prompt_roles：0=system/1=user/2=assistant，或字符串） */
  role?: number | string;
  /** 过滤函数或过滤配置（character_ids/session_ids） */
  filter?: any;
}

/** 单个 source 的提示词映射（identifier -> entry） */
type PromptSource = Record<string, ExtensionPromptEntry>;

/**
 * [B4-SHARED-PARTITION 2026-10-03] 对外暴露的「一个分区的条目映射」类型。
 * snapshotSandbox / rebindSandboxEntries 往返搬运用，与内部 PromptSource 同构。
 */
export type ExtensionPromptEntryMap = Record<string, ExtensionPromptEntry>;

/**
 * 沙箱分区键前缀。
 *
 * [XCHAR-PROMPT-BLEED 2026-10-03] 修复前 DEFAULT_SOURCE 恒为 'sandbox'（全局单池）；
 * 现改为 `sandbox:<characterId>`。**无角色上下文时**（拿不到 characterId）落到
 * 无角色分区 `sandbox:` —— 该分区不参与按角色取用（见 getPromptsForGeneration），
 * 避免「拿不到角色就全量聚合」退化成串味。
 */
const SANDBOX_SOURCE_PREFIX = 'sandbox:';

/** 显式空角色分区：无角色上下文的写入方使用，不参与按角色聚合 */
const SANDBOX_NO_CHARACTER = SANDBOX_SOURCE_PREFIX;

/** 取某角色的沙箱分区键 */
export function sandboxSourceKey(characterId: string | number | null | undefined): string {
  const id = characterId == null ? '' : String(characterId);
  return id ? `${SANDBOX_SOURCE_PREFIX}${id}` : SANDBOX_NO_CHARACTER;
}

/**
 * 当前沙箱分区键（模块级）。
 *
 * 由 setExtensionPrompt / getContext 的 setExtensionPrompt 写入时使用。
 * ⚠️ 必须在**插件注册之前**由当前角色设好。CharacterChat 在切卡 effect 里同步
 * 调用 setActiveCharacter()，插件 runtime 注入与卡脚本执行都在其之后，故成立。
 */
let activeCharacterId: string | number | null | undefined = null;

/** 设置当前角色（决定 setExtensionPrompt 写入哪个沙箱分区） */
export function setActivePromptCharacter(characterId: string | number | null | undefined): void {
  const next = characterId == null ? '' : String(characterId);
  if (next === (activeCharacterId == null ? '' : String(activeCharacterId))) return;
  activeCharacterId = characterId ?? null;
}

/** 读当前角色（供调试/测试） */
export function getActivePromptCharacter(): string {
  return activeCharacterId == null ? '' : String(activeCharacterId);
}

/** 当前沙箱分区键（供插件 runtime 记账「这条注册写在哪个分区」） */
export function activeSandboxPartitionKey(): string {
  return sandboxSourceKey(activeCharacterId);
}

/**
 * 提示词注入服务单例
 *
 * 维护按 source 分区的扩展提示词映射，提供 ST 兼容的提示词注入接口。
 *
 * 使用场景：
 * - getContext.ts: getPromptsForGeneration(characterId) 获取扩展提示词用于生成，
 *   setExtensionPrompt() 设置扩展提示词，getDepthPrompt() 获取深度提示词
 * - sandbox.ts: setExtensionPrompt() 插件设置扩展提示词，
 *   removeExtensionPrompt() 插件卸载时清理
 * - useCharacterChat.ts: getPromptsForGeneration(characterId) 获取扩展提示词注入到生成请求
 * - smart-card iframe: setSourcePrompts('frame:<frameId>', prompts) 上报注入内容，
 *   removeSource('frame:<frameId>') iframe 卸载时清理
 */
export const promptInjection = {
  /** 按 source 分区的扩展提示词映射 */
  _sources: {} as Record<string, PromptSource>,

  /**
   * [B4-SHARED-PARTITION] 已删除分区的快照留存（见 detachSandbox 的时序契约）。
   * 键与 _sources 同构，值是该分区被删前的内容拷贝。
   */
  _detached: {} as Record<string, ExtensionPromptEntryMap>,

  /**
   * 获取用于生成的扩展提示词。
   *
   * [XCHAR-PROMPT-BLEED 2026-10-03] 按**当前角色**取用：
   *   - `sandbox:<characterId>`：只取入参角色的那一个分区（不取别的卡残留）
   *   - `sandbox:`（无角色分区）：不取 —— 拿不到角色时宁可空，不要全量聚合
   *   - `frame:<frameId>`：全部取用（iframe 源自带 frameId 生命周期隔离，
   *     且由 CharacterCardRenderer 卸载时 removeSource 精确清理）
   *
   * @param characterId 当前角色 id（生成/读取时的角色）
   * @returns 扩展提示词映射（identifier -> entry），后写覆盖先写
   */
  getPromptsForGeneration(characterId?: string | number | null): Record<string, any> {
    const merged: Record<string, any> = {};
    const ownSandbox = characterId == null || characterId === ''
      ? null
      : sandboxSourceKey(characterId);
    for (const source of Object.keys(this._sources)) {
      const isSandbox = source.startsWith(SANDBOX_SOURCE_PREFIX);
      if (isSandbox) {
        // 沙箱分区一律按角色取：
        //  - 无角色分区（'sandbox:'）不参与聚合
        //  - 取不到 characterId 时（ownSandbox 为 null）**全部沙箱分区都不取** ——
        //    宁可本次生成少注入，也不要退化成全量聚合（那正是串味的形态）
        //  - 有角色时只取本角色的那一个分区
        if (!ownSandbox || source !== ownSandbox) continue;
      }
      Object.assign(merged, this._sources[source]);
    }
    return merged;
  },

  /**
   * 清理某角色的沙箱分区（切卡时调用）。
   *
   * [XCHAR-PROMPT-BLEED 2026-10-03] 切卡清理的**唯一**入口。放在这里而不是
   * 散落到各调用方，是因为「谁在切卡」在前端有两个来源（CharacterChat 的
   * selectedCharacter、CharacterView 的 setSelectedCharacter），而只有本模块知道
   * 分区键长什么样。
   *
   * @param characterId 要清理的角色 id
   */
  clearCharacterSandbox(characterId: string | number | null | undefined): void {
    if (characterId == null || characterId === '') return;
    delete this._sources[sandboxSourceKey(characterId)];
  },

  /**
   * 设置某个 source（如 smart-card iframe）的完整提示词映射。
   *
   * iframe 在 setExtensionPrompt 后 / 初始化恢复后上报其 chatVariableStore 中的
   * __extension_prompts 快照（每条形如 {value, position, depth, scan, role, filter}），
   * 此处归一化为 ExtensionPromptEntry 并整体替换该 source 的条目。
   *
   * @param source source 标识（约定 'frame:<frameId>'）
   * @param prompts iframe 上报的提示词映射（value 为内容）
   */
  setSourcePrompts(source: string, prompts: Record<string, any>): void {
    if (!source) return;
    const normalized: PromptSource = {};
    for (const [key, value] of Object.entries(prompts || {})) {
      if (!value || typeof value !== 'object') continue;
      normalized[key] = {
        content: String(value.value ?? ''),
        position: value.position,
        depth: value.depth,
        scan: value.scan,
        role: value.role,
        filter: value.filter,
      };
    }
    this._sources[source] = normalized;
  },

  /**
   * 移除某个 source（iframe 卸载 / 关闭全屏时清理，避免跨角色污染）。
   *
   * @param source source 标识（约定 'frame:<frameId>'）
   */
  removeSource(source: string): void {
    if (!source) return;
    delete this._sources[source];
  },

  /**
   * 设置扩展提示词（默认写入 sandbox source，兼容现有调用方）。
   *
   * ST 插件通过 setExtensionPrompt() 注册要注入到生成上下文的提示词。
   * 签名与 ST 1.18.0 script.js:8904 完全对齐：
   *   setExtensionPrompt(key, value, position, depth, scan, role, filter)
   *
   * @param identifier 提示词唯一标识（通常是插件名）
   * @param content 提示词内容
   * @param position 插入位置（ST extension_prompt_types：-1/0/1/2，可选）
   * @param depth 插入深度（从消息末尾往回数的位置，仅 IN_CHAT 生效，可选）
   * @param scan 是否扫描该提示词中的宏（可选，默认 false）
   * @param role 角色（ST extension_prompt_roles：0=system/1=user/2=assistant，或字符串，可选）
   * @param filter 过滤函数或配置（可选）
   */
  setExtensionPrompt(
    identifier: string,
    content: string,
    position?: number,
    depth?: number,
    scan?: boolean,
    role?: number | string,
    filter?: any,
  ): void {
    // [XCHAR-PROMPT-BLEED 2026-10-03] 写入**当前角色**的沙箱分区，而非全局单池。
    // 拿不到角色时落无角色分区（不参与按角色聚合）—— 宁可该条缺席，也不要串到别的卡。
    const source = sandboxSourceKey(activeCharacterId);
    if (!this._sources[source]) this._sources[source] = {};
    this._sources[source][identifier] = {
      content,
      position,
      depth,
      scan,
      role,
      filter,
    };
  },

  /**
   * 移除扩展提示词（从所有 source 移除该 identifier）。
   *
   * 插件卸载时调用此方法清理已注册的提示词。
   *
   * @param identifier 提示词唯一标识
   */
  removeExtensionPrompt(identifier: string): void {
    for (const source of Object.keys(this._sources)) {
      delete this._sources[source][identifier];
    }
  },

  /**
   * 获取深度提示词
   *
   * ST 在生成上下文中使用 depth_prompt 字段注入到指定深度位置。
   *
   * @returns 深度提示词文本
   */
  getDepthPrompt(characterId?: string | number | null): string {
    // 收集所有 depth 类型的扩展提示词（按当前角色的聚合视图）
    const parts: string[] = [];
    const merged = this.getPromptsForGeneration(
      characterId === undefined ? getActivePromptCharacter() : characterId,
    );
    for (const key in merged) {
      const entry = merged[key];
      if (entry && entry.depth !== undefined && entry.content) {
        parts.push(entry.content);
      }
    }
    return parts.join('\n\n');
  },

  /**
   * [B4-SHARED-PARTITION 2026-10-03] 读某个沙箱分区的条目快照。
   *
   * 与 clearCharacterSandbox 成对使用：切卡时旧卡分区被删掉之前，插件 runtime
   * 先用它把「本插件登记过、且仍需在本卡生效」的条目取出来，rebind 到新分区。
   * 返回**拷贝**（不是内部引用）—— 否则调用方改的就是活分区本身。
   */
  snapshotSandbox(characterId: string | number | null | undefined): ExtensionPromptEntryMap {
    const src = this._sources[sandboxSourceKey(characterId)];
    if (!src) return {};
    const copy: ExtensionPromptEntryMap = {};
    for (const key of Object.keys(src)) {
      copy[key] = { ...src[key] };
    }
    return copy;
  },

  /**
   * [B4-SHARED-PARTITION] 删分区前先留存快照，供后续 rebind 搬运。
   *
   * ⚠️ 与 clearCharacterSandbox 的时序契约（这是本方法存在的唯一理由）：
   * 切卡那一帧 React 先跑「清旧卡分区」effect，再跑「插件注入」effect，而插件注入
   * 是**异步**的（要拉配置）。所以注入收尾时的 rebindRetainedEntries 回头去读旧分区
   * 一定读到空 —— 共用插件的条目就在这一步丢失。必须在删除的那一刻把内容留出来。
   *
   * 保留一份而不是实时读，是为了让 rebind 与清理解耦：清完即忘，注入时再取。
   */
  detachSandbox(characterId: string | number | null | undefined): ExtensionPromptEntryMap {
    const snap = this.snapshotSandbox(characterId);
    this._detached[sandboxSourceKey(characterId)] = snap;
    this.clearCharacterSandbox(characterId);
    return snap;
  },

  /**
   * [B4-SHARED-PARTITION] 读回 detachSandbox 留存的快照（不消费，可重复读）。
   */
  peekDetachedSandbox(characterId: string | number | null | undefined): ExtensionPromptEntryMap {
    return this._detached[sandboxSourceKey(characterId)] || {};
  },

  /**
   * [B4-SHARED-PARTITION 2026-10-03] 把快照里的条目写进**当前角色**的沙箱分区。
   *
   * 与 getPromptsForGeneration 的取用口径对称：写进去的新卡立刻就能取到。
   * 刻意做成「显式搬运注册项」而不是「重跑插件脚本」—— 脚本重跑会重建 DOM 节点
   * （闪烁）、重复绑事件、重复起定时器；搬运只改一行账本，零副作用。
   */
  rebindSandboxEntries(characterId: string | number | null | undefined, entries: ExtensionPromptEntryMap): void {
    if (!entries || Object.keys(entries).length === 0) return;
    const target = sandboxSourceKey(characterId);
    if (!this._sources[target]) this._sources[target] = {};
    for (const key of Object.keys(entries)) {
      // 先写覆盖：本次「重新登记」优先于上一格留下的同名项（ST 同 identifier 覆盖语义）
      this._sources[target][key] = { ...entries[key] };
    }
  },

  /**
   * 清空所有扩展提示词
   */
  clear(): void {
    this._sources = {};
    this._detached = {};
  },
};
