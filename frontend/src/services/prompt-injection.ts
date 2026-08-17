/**
 * 提示词注入服务
 *
 * 提供 ST 兼容的扩展提示词注入接口，供 getContext.ts、sandbox.ts、useCharacterChat.ts
 * 和 smart-card iframe 使用。
 *
 * 多 source 分区（[EP-BRIDGE]）：
 * - `sandbox`：父页面插件沙箱 / getContext / 世界书等现有写入方（setExtensionPrompt 默认源）
 * - `frame:<frameId>`：smart-card iframe 经 postMessage 上报（setSourcePrompts）
 * getPromptsForGeneration() 返回所有 source 的聚合视图（后写覆盖先写，对齐 ST 同 identifier 覆盖语义）。
 * removeSource() 供 iframe 卸载时精确清理，避免跨角色/跨卡污染。
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

/** 默认 source：父页面插件沙箱 / getContext 等现有写入方 */
const DEFAULT_SOURCE = 'sandbox';

/**
 * 提示词注入服务单例
 *
 * 维护按 source 分区的扩展提示词映射，提供 ST 兼容的提示词注入接口。
 *
 * 使用场景：
 * - getContext.ts: getPromptsForGeneration() 获取所有扩展提示词用于生成，
 *   setExtensionPrompt() 设置扩展提示词，getDepthPrompt() 获取深度提示词
 * - sandbox.ts: setExtensionPrompt() 插件设置扩展提示词，
 *   removeExtensionPrompt() 插件卸载时清理
 * - useCharacterChat.ts: getPromptsForGeneration() 获取扩展提示词注入到生成请求
 * - smart-card iframe: setSourcePrompts('frame:<frameId>', prompts) 上报注入内容，
 *   removeSource('frame:<frameId>') iframe 卸载时清理
 */
export const promptInjection = {
  /** 按 source 分区的扩展提示词映射 */
  _sources: {} as Record<string, PromptSource>,

  /**
   * 获取用于生成的所有扩展提示词（所有 source 聚合，后写覆盖先写）。
   *
   * @returns 扩展提示词映射（identifier -> entry）
   */
  getPromptsForGeneration(): Record<string, any> {
    const merged: Record<string, any> = {};
    for (const source of Object.keys(this._sources)) {
      Object.assign(merged, this._sources[source]);
    }
    return merged;
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
    if (!this._sources[DEFAULT_SOURCE]) this._sources[DEFAULT_SOURCE] = {};
    this._sources[DEFAULT_SOURCE][identifier] = {
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
  getDepthPrompt(): string {
    // 收集所有 depth 类型的扩展提示词（聚合视图）
    const parts: string[] = [];
    const merged = this.getPromptsForGeneration();
    for (const key in merged) {
      const entry = merged[key];
      if (entry && entry.depth !== undefined && entry.content) {
        parts.push(entry.content);
      }
    }
    return parts.join('\n\n');
  },

  /**
   * 清空所有扩展提示词
   */
  clear(): void {
    this._sources = {};
  },
};
