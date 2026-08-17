/**
 * 生成引擎服务
 *
 * 提供 ST 兼容的生成控制接口，供 getContext.ts 使用。
 * 方法签名与 ST 1.18.0 对齐：
 * - generate(prompt, options) 触发完整生成流程（SSE 流式），写入聊天记录
 * - generateQuietPrompt(prompt, options) 生成响应但不写入聊天记录，返回文本
 * - generateRaw(prompt, options) 绕过提示词构建管线，直接调用模型 API
 * - stopGeneration() 中止当前生成
 *
 * 实际生成通过调用 Palink 后端 /api/character-chat（SSE）和
 * /api/character-chat/smart-card-generate（非流式）完成。
 */

import { api } from './api';
import { consumeSseStream } from '../lib/sseStream';
import { messageManager } from './message-manager';
import { getGlobalSillyTavernRuntime } from '../lib/sillytavern/runtime';

/**
 * 生成选项
 *
 * 与 ST 1.18.0 的 generate/generateQuietPrompt/generateRaw 选项对齐。
 * 包含静默提示、响应长度、自定义提示、群组抑制、中止信号、采样参数等字段。
 */
export interface GenerationOptions {
  /** 静默提示文本（不显示在聊天中） */
  quietPrompt?: boolean | string;
  /** 响应长度（token 数） */
  responseLength?: number;
  /** 自定义提示文本 */
  customPrompt?: string;
  /** 是否抑制群组生成 */
  inhibitGroup?: boolean;
  /** 中止信号 */
  signal?: AbortSignal;
  /** 采样温度 */
  temperature?: number;
  /** top-p 采样参数 */
  top_p?: number;
  /** 最大 token 数 */
  max_tokens?: number;
  /** 频率惩罚 */
  frequency_penalty?: number;
  /** 存在惩罚 */
  presence_penalty?: number;
  /** 是否静默生成（不写入聊天记录） */
  quiet?: boolean;
  /** 响应长度（ST snake_case 别名） */
  length?: number;
  /** 自定义提示（ST snake_case 别名） */
  custom_prompt?: string;
}

/**
 * 解析当前使用的模型 ID
 *
 * 优先级：
 * 1. 通过 setContext 注册的 _currentModel
 * 2. 系统默认模型（/api/admin/system/defaults 的 default_chat_model）
 *
 * 不缓存到模块级变量：api.get 自带 5 分钟 TTL 缓存 + 失效代次机制，
 * 模块级缓存会让管理端修改默认模型后插件生成永远用旧模型（直到刷新页面）。
 * 直接走 api 层缓存，改默认模型后最多 5 分钟生效。
 *
 * @returns 模型 ID，若无法获取则返回空字符串
 */
async function _resolveModel(): Promise<string> {
  if (generationEngine._currentModel) {
    return generationEngine._currentModel;
  }
  try {
    const data = await api.get('/api/admin/system/defaults', { cacheTtlMs: 5 * 60 * 1000 });
    return data?.default_chat_model || '';
  } catch {
    return '';
  }
}

/**
 * 生成引擎单例
 *
 * 维护生成状态，提供 ST 兼容的生成控制接口。
 * state.isGenerating 反映插件通过 context.generate 等方法触发的生成状态；
 * useCharacterChat 的 React 层生成状态独立维护，通过 runtime.stopGeneration
 * 与本引擎在事件层面解耦。
 */
/**
 * 在调用后端生成 API 前，运行 ST 扩展的 generate_interceptor（palink-native 模式）。
 *
 * - 通过 window.SillyTavern.runGenerationInterceptors 编排（compat 运行时提供，
 *   复刻 ST 核心 extensions.js 的逻辑：遍历已加载扩展中声明 manifest.generate_interceptor 者）。
 * - 拦截器可能 mutate chat 数组（vectors 重排消息）或 abort 生成。
 * - 收集 ST 扩展经 setExtensionPrompt 注入的扩展提示，作为 extension_prompts 转发给后端
 *   （后端 roleplay_prompt_assembly 已支持 ST 1.18.0 extension_prompts 四态注入）。
 *
 * 注意：chat 数组重排仅作用于前端 window.chat；palink-native 后端从 DB 重装配 prompt，
 * 消息重排同步（Task 7）：拦截器执行后读取 window.chat 的消息 ID 顺序，
 * 作为 message_order 字段转发给后端，后端按此顺序装配 prompt，
 * 使 vectors_rearrangeChat 等扩展的消息重排真正生效。
 *
 * @returns aborted 表示拦截器请求中止生成；extensionPrompts 为待注入的扩展提示列表；
 *          messageOrder 为重排后的消息 ID 顺序（空数组表示未重排）
 */
async function runStGenerationInterceptors(type: string): Promise<{ aborted: boolean; extensionPrompts: any[]; messageOrder: string[] }> {
  const st = (window as any).SillyTavern;
  // [EP-BRIDGE] 先收集扩展提示词（st 存在时）：即使 runGenerationInterceptors 未注册
  // （父页面不注册拦截器，仅 iframe 内注册），也不能丢弃 getExtensionPrompts 结果，
  // 否则插件 generate 路径的扩展提示词恒为空。
  let extensionPrompts: any[] = [];
  if (st && typeof st.getExtensionPrompts === 'function') {
    try {
      extensionPrompts = st.getExtensionPrompts();
    } catch {
      extensionPrompts = [];
    }
  }
  if (!st || typeof st.runGenerationInterceptors !== 'function') {
    return { aborted: false, extensionPrompts, messageOrder: [] };
  }
  const chat = (window as any).chat;
  const contextSize = 0; // vectors 等扩展忽略 contextSize；palink-native 下聊天上下文由后端装配
  const aborted = await st.runGenerationInterceptors(chat, contextSize, type);
  // 拦截器可能注入/修改扩展提示词（对齐 ST extensions.js 收集时序），运行后重新收集一次覆盖
  if (typeof st.getExtensionPrompts === 'function') {
    try {
      extensionPrompts = st.getExtensionPrompts();
    } catch {
      // 保留首次收集结果
    }
  }

  // 读取拦截器执行后的消息 ID 顺序（vectors_rearrangeChat 等扩展可能重排了 chat 数组）
  const messageOrder: string[] = Array.isArray(chat)
    ? chat.map((m: any, idx: number) => String(m?.id ?? m?.mes_id ?? idx))
    : [];

  return { aborted, extensionPrompts, messageOrder };
}

export const generationEngine = {
  /** 生成状态 */
  state: {
    /** 是否正在生成 */
    isGenerating: false,
  },

  /** 状态变更监听器列表 */
  _stateListeners: [] as Array<(state: { isGenerating: boolean }) => void>,

  /** 当前生成使用的 AbortController（由本引擎在 generate 时创建） */
  _abortController: null as AbortController | null,

  /** 当前上下文：模型 ID（可由外部通过 setContext 注册） */
  _currentModel: '' as string,

  /**
   * 注册当前生成上下文
   *
   * 由拥有 React state 的层（如 CharacterChat）调用，
   * 将当前选中的模型/角色/会话同步到生成引擎，供插件触发的生成使用。
   *
   * @param ctx 上下文对象
   */
  setContext(ctx: { model?: string }): void {
    if (typeof ctx.model === 'string') {
      this._currentModel = ctx.model;
    }
  },

  /**
   * 注册状态变更监听器
   * @param callback 回调函数，接收生成状态对象
   * @returns 取消订阅函数
   */
  onStateChange(callback: (state: { isGenerating: boolean }) => void): () => void {
    this._stateListeners.push(callback);
    return () => {
      const idx = this._stateListeners.indexOf(callback);
      if (idx >= 0) this._stateListeners.splice(idx, 1);
    };
  },

  /**
   * 通知所有状态监听器
   */
  _notifyStateChange(): void {
    for (const listener of this._stateListeners) {
      try { listener(this.state); } catch { /* 忽略监听器错误 */ }
    }
  },

  /**
   * 设置生成状态并通知监听器
   */
  _setGenerating(value: boolean): void {
    if (this.state.isGenerating === value) return;
    this.state.isGenerating = value;
    this._notifyStateChange();
  },

  /**
   * 执行生成（SSE 流式）
   *
   * ST 的 generate() 会触发完整的生成流程并写入聊天记录。
   * 此处调用 Palink 后端 /api/character-chat 端点，消费 SSE 流，
   * 累积生成内容，并在过程中触发 STREAM_TOKEN_RECEIVED 事件。
   *
   * @param prompt 提示文本（作为用户消息发送）
   * @param options 生成选项
   */
  async generate(prompt: string, options?: GenerationOptions): Promise<void> {
    const runtime = getGlobalSillyTavernRuntime();

    const characterId = String(messageManager.getCurrentCharacterId() || '');
    const sessionId = messageManager._currentSessionId || '';
    const model = await _resolveModel();

    if (!characterId || !model) {
      console.warn('[generationEngine] generate: missing characterId or model', { characterId, model });
      return;
    }

    // 创建本引擎管理的 AbortController，同时尊重外部传入的 signal
    const externalSignal = options?.signal;
    this._abortController = new AbortController();
    if (externalSignal) {
      if (externalSignal.aborted) {
        this._abortController.abort();
      } else {
        externalSignal.addEventListener('abort', () => this._abortController?.abort(), { once: true });
      }
    }

    this._setGenerating(true);
    runtime?.startGeneration(prompt || 'continue', {
      type: 'plain',
      character_id: characterId,
      model,
      session_id: sessionId || undefined,
    });

    // ── ST generate_interceptor 接入（palink-native 模式）──
    // 在调用后端生成 API 前运行 ST 扩展拦截器（如 vectors_rearrangeChat）。
    // 拦截器可 mutate chat 或请求 abort；其 setExtensionPrompt 注入已收集到 extensionPrompts。
    // messageOrder 携带重排后的消息 ID 顺序，后端按此顺序装配 prompt（Task 7）。
    const interceptorType = options?.quietPrompt ? 'quiet' : 'normal';
    const { aborted: interceptorAborted, extensionPrompts, messageOrder } = await runStGenerationInterceptors(interceptorType);
    if (interceptorAborted) {
      runtime?.emitGenerationEnded('plain', '');
      return;
    }

    let fullContent = '';
    let fullReasoning = '';

    try {
      const response = await api.stream('/api/character-chat', {
        session_id: sessionId || null,
        character_id: characterId,
        message: prompt || '__CONTINUE__',
        model,
        temperature: options?.temperature ?? 0.7,
        top_p: options?.top_p ?? 0.9,
        max_tokens: options?.max_tokens ?? 2048,
        frequency_penalty: options?.frequency_penalty ?? 0,
        presence_penalty: options?.presence_penalty ?? 0,
        dialogue_mode: 'first_person',
        response_length: options?.responseLength ?? options?.length ?? undefined,
        extension_prompts: extensionPrompts,
        message_order: messageOrder.length > 0 ? messageOrder : undefined,
      }, { signal: this._abortController.signal });

      await consumeSseStream(response, (json) => {
        // N12 修复: 后端生成失败（超时/空结果）以 {type:'error', error:true} 事件
        // 发射，此前错误文本被当作 content 渲染成 AI 回复。识别后抛错中断，
        // 由外层 catch 统一处理（console.error / 空内容结束）。
        if (json.type === 'error' || json.error === true) {
          const errMsg = typeof json.message === 'string' ? json.message : '生成失败';
          throw new Error(errMsg);
        }
        const reasoning = typeof json.reasoning === 'string' ? json.reasoning : '';
        const modelReasoning = typeof json.model_reasoning === 'string' ? json.model_reasoning : '';
        const content = typeof json.content === 'string' ? json.content : '';

        if (json.type === 'usage') return;
        if (json.type === 'final_content' && typeof json.content === 'string') {
          fullContent = json.content as string;
          return;
        }

        if (!reasoning && !modelReasoning && !content) return;

        if (reasoning) fullReasoning += reasoning;
        if (modelReasoning) fullReasoning += modelReasoning;
        if (content) {
          fullContent += content;
          runtime?.onStreamToken(content);
        }
      });

      if (fullReasoning) {
        runtime?.onStreamReasoningDone(fullReasoning);
      }
      runtime?.emitGenerationEnded('plain', fullContent);
    } catch (e: any) {
      if (e?.name === 'AbortError') {
        runtime?.stopGeneration();
        runtime?.emitGenerationEnded('plain', fullContent);
      } else {
        console.error('[generationEngine] generate failed:', e);
        runtime?.emitGenerationEnded('plain', fullContent);
      }
    } finally {
      this._abortController = null;
      this._setGenerating(false);
    }
  },

  /**
   * 静默生成提示
   *
   * ST 的 generateQuietPrompt() 生成响应但不写入聊天记录，返回生成的文本。
   * 此处调用后端 /api/character-chat/smart-card-generate 端点（mode="quiet"），
   * 不触发 SSE 流式，直接返回完整生成结果。
   *
   * @param prompt 提示文本
   * @param options 生成选项
   * @returns 生成的文本
   */
  async generateQuietPrompt(prompt: string, options?: GenerationOptions): Promise<string> {
    const runtime = getGlobalSillyTavernRuntime();

    const characterId = String(messageManager.getCurrentCharacterId() || '');
    const sessionId = messageManager._currentSessionId || '';
    const model = await _resolveModel();

    if (!characterId || !model) {
      console.warn('[generationEngine] generateQuietPrompt: missing characterId or model', { characterId, model });
      return '';
    }

    this._setGenerating(true);
    runtime?.startGeneration(prompt || 'quiet', {
      type: 'quiet',
      character_id: characterId,
      model,
      session_id: sessionId || undefined,
    });

    // ── ST generate_interceptor 接入（quiet 模式）──
    const { aborted: quietAborted, extensionPrompts: quietPrompts, messageOrder: quietMessageOrder } = await runStGenerationInterceptors('quiet');
    if (quietAborted) {
      runtime?.emitGenerationEnded('quiet', '');
      return '';
    }

    try {
      const result = await api.post('/api/character-chat/smart-card-generate', {
        character_id: characterId,
        prompt: prompt || '',
        session_id: sessionId || null,
        branch_id: null,
        model,
        mode: 'quiet',
        temperature: options?.temperature ?? 0.7,
        top_p: options?.top_p ?? 0.9,
        max_tokens: options?.max_tokens ?? 1024,
        frequency_penalty: options?.frequency_penalty ?? 0,
        presence_penalty: options?.presence_penalty ?? 0,
        dialogue_mode: 'first_person',
        include_history: true,
        extension_prompts: quietPrompts,
        message_order: quietMessageOrder.length > 0 ? quietMessageOrder : undefined,
      }, { signal: options?.signal });

      const content = (result && typeof result.content === 'string') ? result.content : '';
      runtime?.emitGenerationEnded('quiet', content);
      return content;
    } catch (e: any) {
      if (e?.name === 'AbortError') {
        runtime?.stopGeneration();
        runtime?.emitGenerationEnded('quiet', '');
      } else {
        console.error('[generationEngine] generateQuietPrompt failed:', e);
        runtime?.emitGenerationEnded('quiet', '');
      }
      return '';
    } finally {
      this._setGenerating(false);
    }
  },

  /**
   * 原始生成
   *
   * ST 的 generateRaw() 直接发送原始 prompt 到后端，返回生成的文本。
   * 此处调用后端 /api/chats/generate-raw 端点，绕过提示词构建管线，
   * 直接调用模型 API。
   *
   * K-5 修复: ST 1.18.0 的 generateRaw 是「单对象」签名
   * （script.js:4088 `generateRaw({ prompt, systemPrompt, responseLength, ... })`），
   * memory/vectors/expressions 插件均按此传参。此前的 `(prompt, options)` 位置参数
   * 签名会把整个对象当 prompt 字符串处理，systemPrompt/responseLength 全部丢失。
   * 此处做双向兼容：对象（ST 风格）或位置参数（Palink 风格）均可。
   *
   * @param promptOrParams 提示文本/JSON prompt 数组，或 ST 风格参数对象
   *   （{ prompt, systemPrompt, responseLength, prefill, signal, ... }）
   * @param options 生成选项（位置参数风格时使用）
   * @returns 生成的文本
   */
  async generateRaw(promptOrParams: string | Record<string, unknown>, options?: GenerationOptions): Promise<string> {
    const runtime = getGlobalSillyTavernRuntime();
    const model = await _resolveModel();

    if (!model) {
      console.warn('[generationEngine] generateRaw: missing model');
      return '';
    }

    // K-5: ST 单对象签名解构。systemPrompt 前置为 system 消息、responseLength → max_tokens、
    // prefill 追加 assistant 消息（对齐 ST createRawPrompt，script.js:3890-3945）。
    let prompt: string = '';
    let systemPrompt: string = '';
    let prefill: string = '';
    let mergedOptions = options ?? {};
    if (promptOrParams && typeof promptOrParams === 'object' && !Array.isArray(promptOrParams)) {
      const p = promptOrParams as Record<string, any>;
      prompt = typeof p.prompt === 'string' ? p.prompt : '';
      systemPrompt = typeof p.systemPrompt === 'string' ? p.systemPrompt : '';
      prefill = typeof p.prefill === 'string' ? p.prefill : '';
      const responseLength = typeof p.responseLength === 'number' && p.responseLength > 0
        ? p.responseLength
        : undefined;
      mergedOptions = {
        ...(options || {}),
        max_tokens: responseLength ?? options?.max_tokens,
        signal: (p.signal as AbortSignal | undefined) ?? options?.signal,
      };
    } else {
      prompt = typeof promptOrParams === 'string' ? promptOrParams : '';
    }

    this._setGenerating(true);
    runtime?.startGeneration(prompt || 'raw', {
      type: 'raw',
      model,
    });

    // ── ST generate_interceptor 接入（raw 路径）──
    // 与 generate()/generateQuietPrompt() 对齐，raw 路径也运行拦截器
    // （vectors_rearrangeChat 等扩展在 raw 生成时也需执行）。
    const { aborted: rawAborted, extensionPrompts: rawPrompts, messageOrder: rawMessageOrder } = await runStGenerationInterceptors('raw');
    if (rawAborted) {
      runtime?.emitGenerationEnded('raw', '');
      return '';
    }

    try {
      // 尝试解析为 prompt 数组（ST generateRaw 接受 promptArray）
      let messages: Array<{ role: string; content: string }> = [];
      let promptStr = '';
      if (prompt) {
        try {
          const parsed = JSON.parse(prompt);
          if (Array.isArray(parsed)) {
            messages = parsed.map((m: any) => ({
              role: typeof m?.role === 'string' ? m.role : 'user',
              content: typeof m?.content === 'string' ? m.content : String(m?.content ?? ''),
            }));
          } else {
            promptStr = prompt;
          }
        } catch {
          promptStr = prompt;
        }
      }

      // K-5: systemPrompt 前置为 system 消息（ST createRawPrompt unshift 语义）
      if (systemPrompt) {
        if (messages.length > 0) {
          messages.unshift({ role: 'system', content: systemPrompt });
        } else if (promptStr) {
          promptStr = `${systemPrompt}\n\n${promptStr}`;
        } else {
          messages.push({ role: 'system', content: systemPrompt });
        }
      }
      // K-5: prefill 追加 assistant 消息（ST openai 路径语义）
      if (prefill) {
        if (messages.length > 0) {
          messages.push({ role: 'assistant', content: prefill });
        } else if (promptStr) {
          promptStr = `${promptStr}\n${prefill}`;
        }
      }

      const body: Record<string, unknown> = {
        model,
        temperature: mergedOptions?.temperature ?? 0.7,
        top_p: mergedOptions?.top_p ?? 0.9,
        max_tokens: mergedOptions?.max_tokens ?? 1024,
        frequency_penalty: mergedOptions?.frequency_penalty ?? 0,
        presence_penalty: mergedOptions?.presence_penalty ?? 0,
      };
      if (rawPrompts.length > 0) {
        body.extension_prompts = rawPrompts;
      }
      if (rawMessageOrder.length > 0) {
        body.message_order = rawMessageOrder;
      }
      if (messages.length > 0) {
        body.messages = messages;
      } else {
        body.prompt = promptStr;
      }

      const result = await api.post('/api/chats/generate-raw', body, { signal: mergedOptions?.signal });
      const content = (result && typeof result.content === 'string') ? result.content : '';
      runtime?.emitGenerationEnded('raw', content);
      return content;
    } catch (e: any) {
      if (e?.name === 'AbortError') {
        runtime?.stopGeneration();
        runtime?.emitGenerationEnded('raw', '');
      } else {
        console.error('[generationEngine] generateRaw failed:', e);
        runtime?.emitGenerationEnded('raw', '');
      }
      return '';
    } finally {
      this._setGenerating(false);
    }
  },

  /**
   * 停止当前生成
   *
   * ST 的 stopGeneration() 中止正在进行的生成。
   * 此处中止本引擎管理的 AbortController，并调用后端 /api/chats/stop 端点
   * （作 ST 兼容占位），触发 GENERATION_STOPPED 事件。
   */
  stopGeneration(): void {
    const runtime = getGlobalSillyTavernRuntime();

    // 中止本引擎管理的 AbortController
    if (this._abortController) {
      this._abortController.abort();
      this._abortController = null;
    }

    // 调用后端 /api/chats/stop（fire-and-forget，不阻塞）
    api.post('/api/chats/stop', {}).catch(() => {
      // 忽略后端调用失败（中止主要由客户端 AbortController 完成）
    });

    // 触发 ST GENERATION_STOPPED 事件
    runtime?.stopGeneration();

    this._setGenerating(false);
  },
};
