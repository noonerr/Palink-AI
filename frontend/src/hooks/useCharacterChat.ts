import { useState, useRef, useCallback, useEffect } from 'react';
import { toast } from 'sonner';
import { api } from '@/services/api';
import { AppError } from '@/lib/error-handler';
import { StreamEngine } from '@/lib/stream-engine';
import { generateMessageId } from '@/lib/utils/messageUtils';
import { useChatWebSocket } from '@/hooks/useChatWebSocket';
import CatchUpAnimator from '@/lib/catchUpAnimator';
import { variableManager } from '@/lib/variables/manager';
import { getGlobalSillyTavernRuntime, stWorldBookManagerSingleton } from '@/lib/sillytavern/runtime';
import { regex_placement } from '@/lib/sillytavern/regex/engine';
import { getRegexedStringForMessage } from '@/lib/sillytavern/regex/adapter';
import { getCachedGlobalRegexScripts } from '@/utils/sillyTavernDisplayPipeline';
import { messageManager } from '@/services/message-manager';
import { promptInjection } from '@/services/prompt-injection';
import { functionToolRegistry } from '@/lib/plugin-system/sandbox';
import type { ScanContext } from '@/lib/worldbook/types';
import type { Attachment, Character, CharacterChatMessage, CharacterChatSession, CharacterChatSessionBranch, GenerationPreset } from '@/types';

interface UseCharacterChatOptions {
  selectedCharacter: Character | null;
  selectedSession: CharacterChatSession | null;
  selectedModel: string;
  dialogueMode: 'first_person' | 'third_person';
  selectedBranch: CharacterChatSessionBranch | null;
  currentPreset: GenerationPreset | null;
  getDisplayName: (character?: Character | Partial<Character> | null) => string;
  messages: CharacterChatMessage[];
  setMessages: React.Dispatch<React.SetStateAction<CharacterChatMessage[]>>;
  setSelectedSession: (session: CharacterChatSession | null) => void;
  loadSessions: (characterId: string) => Promise<CharacterChatSession[]>;
  loadMemoryStats: (sessionId: string) => Promise<void>;
  forkPoint: { branchId: string; messageId: number } | null;
  onForkCreated: () => void;
  onBranchCreated: (branch: { id: string; branch_name: string; is_active: boolean }) => void;
  responseLength: string;
  // PlotLine 阶段自动推进事件回调，收到事件时调用以刷新会话状态
  onPlotLineAdvanced?: (data: { new_stage: { stage_index: number; title: string; summary: string }; session_id?: string }) => void;
  onVariablesUpdated?: (variables: Record<string, unknown>) => void;
}

// 生成超时警告阈值：模型网关（opencode.ai）响应慢时首个 chunk 可能数十秒后才到，
// 15s 太激进会误报"回复慢"（2026-08-18 实测连接重试 31s + 生成 64s）。后端已在
// 流式开始前推送 generation_started，收到后即清除本警告，故此处阈值只需覆盖
// "后端尚未开始生成"的极端情况，放宽到 30s。
const TIMEOUT_WARNING_MS = 30000;

interface SendMessageOptions {
  sessionOverride?: CharacterChatSession | null;
  branchIdOverride?: string | null;
  ignorePendingAttachments?: boolean;
  suppressUserMessage?: boolean;
  smartCardTrigger?: boolean;
  smartCardContext?: string;
  awaitResult?: boolean;
  useEmptyContext?: boolean;
}

const SMART_CARD_LAUNCH_LINE_PATTERNS = [
  /^\s*\u8bf7\u6839\u636e\u4ee5\u4e0a\u8bbe\u5b9a\u5f00\u59cb\u6e38\u620f[。.!！]*\s*$/i,
  /^\s*\u6839\u636e\u4ee5\u4e0a\u8bbe\u5b9a\u5f00\u59cb\u6e38\u620f[。.!！]*\s*$/i,
  /^\s*\u5f00\u59cb\u6e38\u620f[。.!！]*\s*$/i,
  /^\s*\u8bf7\u5f00\u59cb\u6e38\u620f[。.!！]*\s*$/i,
  /^\s*please\s+(?:start|begin)\s+(?:the\s+)?(?:game|story)[.!！。]*\s*$/i,
  /^\s*(?:start|begin)\s+(?:the\s+)?(?:game|story)[.!！。]*\s*$/i,
];

function cleanSmartCardTriggerContext(content: string): string {
  return String(content || '')
    .replace(/\r\n/g, '\n')
    .replace(/\r/g, '\n')
    .split('\n')
    .filter(line => !SMART_CARD_LAUNCH_LINE_PATTERNS.some(pattern => pattern.test(line)))
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function mergeSwipeInfoForCurrentDisplay(
  fallbackMessage: CharacterChatMessage | undefined,
  content: string,
  swipeId: number | undefined,
  swipes: string[] | undefined,
  explicitSwipeInfo: Array<Record<string, unknown>> | undefined,
  extra: Record<string, unknown> | undefined,
): Array<Record<string, unknown>> | undefined {
  const sourceSwipes = swipes || (Array.isArray(fallbackMessage?.swipes) ? fallbackMessage.swipes : undefined);
  if (!sourceSwipes || sourceSwipes.length === 0) return explicitSwipeInfo;

  const activeSwipeId = Math.max(
    0,
    Math.min(
      Number.isFinite(Number(swipeId)) ? Number(swipeId) : Number(fallbackMessage?.swipe_id || 0),
      sourceSwipes.length - 1,
    ),
  );
  const baseInfo = explicitSwipeInfo
    ? explicitSwipeInfo.map((entry) => ({ ...(entry || {}) }))
    : Array.isArray(fallbackMessage?.swipe_info)
      ? fallbackMessage.swipe_info.map((entry) => ({ ...(entry || {}) }))
      : [];

  while (baseInfo.length < sourceSwipes.length) {
    baseInfo.push({ send_date: fallbackMessage?.created_at || '', extra: {} });
  }

  const activeInfo = baseInfo[activeSwipeId] || {};
  const activeExtra = activeInfo.extra && typeof activeInfo.extra === 'object'
    ? activeInfo.extra as Record<string, unknown>
    : {};
  const messageExtra = fallbackMessage?.extra && typeof fallbackMessage.extra === 'object'
    ? fallbackMessage.extra
    : {};
  baseInfo[activeSwipeId] = {
    ...activeInfo,
    extra: {
      ...activeExtra,
      ...messageExtra,
      ...(extra || {}),
    },
  };

  return baseInfo;
}

/**
 * Task 7.4: 构建世界书上下文，扫描当前聊天内容并返回注入文本。
 * 与 generationEngine._buildWorldBookContext 逻辑一致，确保 useCharacterChat
 * 在保留 api.stream 路由的同时注入世界书上下文。
 */
function buildWorldBookContextForChat(): string {
  try {
    const msgs = messageManager.messages;
    if (msgs.length === 0) return '';
    const recentMessages = msgs.slice(-20).map(m => typeof m.mes === 'string' ? m.mes : '');
    const runtime = getGlobalSillyTavernRuntime();
    const ctx = runtime?.getContext() ?? null;
    const character = ctx?.character;
    const scanContext: ScanContext = {
      messages: recentMessages,
      personaDescription: ctx?.name || '',
      characterDescription: (character as any)?.description || '',
      characterPersonality: (character as any)?.personality || '',
      characterDepthPrompt: (character as any)?.depth_prompt || '',
      scenario: (character as any)?.scenario || '',
      creatorNotes: (character as any)?.creatorcomment || (character as any)?.creator_notes || '',
    };
    return stWorldBookManagerSingleton.scanAndBuildContext(scanContext, msgs.length - 1);
  } catch (e) {
    console.error('[useCharacterChat] 世界书上下文构建失败:', e);
    return '';
  }
}

/**
 * Task 3.4.1: 将 functionToolRegistry 序列化为 OpenAI tool calling 格式的 tools 数组。
 *
 * 插件通过 registerFunctionTool(name, description, handler) 注册的工具，
 * 这里转换为 [{type: "function", function: {name, description, parameters}}]。
 * 由于 ST 扩展注册时不提供 JSON Schema，使用宽松 schema（允许任意参数）。
 */
function serializeFunctionTools(): Array<{ type: 'function'; function: { name: string; description: string; parameters: Record<string, unknown> } }> {
  try {
    const tools: Array<{ type: 'function'; function: { name: string; description: string; parameters: Record<string, unknown> } }> = [];
    for (const [name, entry] of functionToolRegistry.entries()) {
      tools.push({
        type: 'function',
        function: {
          name,
          description: entry.description || name,
          // 宽松 schema：允许任意属性，模型可自由传参
          parameters: {
            type: 'object',
            properties: {},
            additionalProperties: true,
          },
        },
      });
    }
    return tools;
  } catch (e) {
    console.error('[useCharacterChat] serializeFunctionTools 失败:', e);
    return [];
  }
}

export function useCharacterChat({
  selectedCharacter,
  selectedSession,
  selectedModel,
  dialogueMode,
  selectedBranch,
  currentPreset,
  getDisplayName,
  messages,
  setMessages,
  setSelectedSession,
  loadSessions,
  loadMemoryStats,
  forkPoint,
  onForkCreated,
  onBranchCreated,
  responseLength,
  onPlotLineAdvanced,
  onVariablesUpdated,
}: UseCharacterChatOptions) {
  const [isGenerating, setIsGenerating] = useState(false);
  const [inputValue, setInputValue] = useState('');
  const [attachments, setAttachments] = useState<Attachment[]>([]);
  const [uploading, setUploading] = useState(false);
  const [suggestions, setSuggestions] = useState<string[]>([]);
  const [regeneratingMessageIndex, setRegeneratingMessageIndex] = useState<number | null>(null);
  const [generatingImageMessageIds, setGeneratingImageMessageIds] = useState<Set<string>>(new Set());

  // Stream engine instance
  const streamEngineRef = useRef(new StreamEngine());

  // Error handling state
  const [currentError, setCurrentError] = useState<AppError | null>(null);
  const [retryMessageContent, setRetryMessageContent] = useState<string>('');
  const [retryMessageImages, setRetryMessageImages] = useState<string[]>([]);

  // Timeout state
  const [timeoutWarning, setTimeoutWarning] = useState(false);
  const [requestStartTime, setRequestStartTime] = useState<number | null>(null);
  const timeoutRef = useRef<number | null>(null);

  const abortControllerRef = useRef<AbortController | null>(null);

  const wsAssistantMessageIdRef = useRef<string | null>(null);
  const wsFullContentRef = useRef('');
  const wsFullReasoningRef = useRef('');
  const wsResolvedSessionIdRef = useRef<string | null>(null);
  const wsSessionSyncedRef = useRef(false);
  const wsHasReceivedDataRef = useRef(false);
  const catchUpAnimatorRef = useRef<CatchUpAnimator | null>(null);

  const streamRafRef = useRef<number | null>(null);
  // [REASONING-SEPARATE] 流式快照分离携带思考，落 state 时合并进 msg.extra.reasoning
  const streamPendingRef = useRef<{ assistantId: string; content: string; reasoning?: string } | null>(null);
  const messageIndexMapRef = useRef<Map<string, number>>(new Map());

  // PlotLine 阶段推进回调 ref，避免闭包过期且无需修改现有 useCallback 依赖
  const onPlotLineAdvancedRef = useRef(onPlotLineAdvanced);
  onPlotLineAdvancedRef.current = onPlotLineAdvanced;

  const updateMessageIndexMap = useCallback((messages: Array<{id?: string | number | null}>) => {
    const map = new Map<string, number>();
    messages.forEach((msg, idx) => {
      if (msg.id != null) map.set(String(msg.id), idx);
    });
    messageIndexMapRef.current = map;
  }, []);

  // Keep message index map in sync
  useEffect(() => {
    updateMessageIndexMap(messages);
  }, [messages, updateMessageIndexMap]);

  // 设置变量系统的会话ID
  useEffect(() => {
    if (selectedSession?.id) {
      variableManager.setSessionId(selectedSession.id);
    }
  }, [selectedSession?.id]);

  const flushStreamUpdate = useCallback(() => {
    streamRafRef.current = null;
    const pending = streamPendingRef.current;
    if (!pending) return;
    streamPendingRef.current = null;
    setMessages(prev => {
      const applyPatch = (msg: (typeof prev)[number]) => (
        pending.reasoning !== undefined
          ? { ...msg, content: pending.content, extra: { ...(msg.extra || {}), reasoning: pending.reasoning } }
          : { ...msg, content: pending.content }
      );
      const idx = messageIndexMapRef.current.get(pending.assistantId);
      if (idx === undefined) {
        // Fallback to findIndex if map is stale
        const fallbackIdx = prev.findIndex((msg) => msg.id === pending.assistantId);
        if (fallbackIdx === -1) return prev;
        const newMessages = [...prev];
        newMessages[fallbackIdx] = applyPatch(newMessages[fallbackIdx]);
        updateMessageIndexMap(newMessages);
        return newMessages;
      }
      const newMessages = [...prev];
      newMessages[idx] = applyPatch(newMessages[idx]);
      return newMessages;
    });
  }, [setMessages, updateMessageIndexMap]);

  const scheduleStreamUpdate = useCallback((assistantId: string, content: string, reasoning?: string) => {
    streamPendingRef.current = { assistantId, content, reasoning: reasoning || undefined };
    if (streamRafRef.current === null) {
      streamRafRef.current = requestAnimationFrame(flushStreamUpdate);
    }
  }, [flushStreamUpdate]);

  const clearGenerationTimers = useCallback(() => {
    if (timeoutRef.current) {
      window.clearTimeout(timeoutRef.current);
      timeoutRef.current = null;
    }
    if (streamRafRef.current !== null) {
      cancelAnimationFrame(streamRafRef.current);
      streamRafRef.current = null;
    }
    streamPendingRef.current = null;
    if (catchUpAnimatorRef.current) {
      catchUpAnimatorRef.current.stop();
      catchUpAnimatorRef.current = null;
    }
  }, []);

  const {
    connected: wsConnected,
    useWebSocket,
    connect: wsConnect,
    disconnect: wsDisconnect,
    sendCharacterChatRequest: wsSendCharacterChatRequest,
    requestSync: wsRequestSync,
    sendCancel: wsSendCancel,
    sendToolCallResponse: wsSendToolCallResponse,
  } = useChatWebSocket({
    onChunk: (data) => {
      const assistantId = wsAssistantMessageIdRef.current;
      if (!assistantId) return;

      if (!wsHasReceivedDataRef.current) {
        wsHasReceivedDataRef.current = true;
        setTimeoutWarning(false);
        if (timeoutRef.current) {
          window.clearTimeout(timeoutRef.current);
        }
      }

      if (data.reasoning) wsFullReasoningRef.current += data.reasoning;
      if (data.content) wsFullContentRef.current += data.content;

      // WebSocket 路径触发 ST stream_token_received 事件
      if (data.content) {
        const wsRuntime = getGlobalSillyTavernRuntime();
        wsRuntime?.onStreamToken(data.content);
      }

      // [REASONING-SEPARATE] 正文与思考分离携带，不再拼接包裹体
      scheduleStreamUpdate(assistantId, wsFullContentRef.current, wsFullReasoningRef.current || undefined);
    },
    onDone: (data) => {
      if (streamRafRef.current !== null) {
        cancelAnimationFrame(streamRafRef.current);
        streamRafRef.current = null;
      }
      const pending = streamPendingRef.current;
      if (pending) {
        streamPendingRef.current = null;
        setMessages(prev => {
          const idx = messageIndexMapRef.current.get(pending.assistantId) ?? prev.findIndex((msg) => msg.id === pending.assistantId);
          if (idx === -1) return prev;
          const newMessages = [...prev];
          newMessages[idx] = pending.reasoning !== undefined
            ? { ...newMessages[idx], content: pending.content, extra: { ...(newMessages[idx].extra || {}), reasoning: pending.reasoning } }
            : { ...newMessages[idx], content: pending.content };
          return newMessages;
        });
      }
      setIsGenerating(false);
      setRegeneratingMessageIndex(null);
      setRequestStartTime(null);
      setTimeoutWarning(false);
      if (timeoutRef.current) {
        window.clearTimeout(timeoutRef.current);
      }
      if (wsResolvedSessionIdRef.current) {
        loadMemoryStats(wsResolvedSessionIdRef.current);
      }
      // WebSocket 路径触发 ST generation_ended / message_received / character_message_rendered 事件
      const finalContent = typeof data?.content === 'string' ? data.content : wsFullContentRef.current;
      if (wsFullReasoningRef.current) {
        const wsRuntime = getGlobalSillyTavernRuntime();
        wsRuntime?.onStreamReasoningDone(wsFullReasoningRef.current);
      }
      const wsRuntime2 = getGlobalSillyTavernRuntime();
      // regeneratingMessageIndex !== null 说明是 regenerate 场景，否则视为 normal
      const wsGenType = (regeneratingMessageIndex !== null && regeneratingMessageIndex >= 0) ? 'regenerate' : 'normal';
      const wsLastIdx = (regeneratingMessageIndex !== null && regeneratingMessageIndex >= 0)
        ? regeneratingMessageIndex
        : (messages.length > 0 ? messages.length - 1 : 0);
      // Fix 4: 传入 wsLastIdx 使插件加强模式能解析 messageId
      wsRuntime2?.emitGenerationEnded(wsGenType, finalContent, wsLastIdx);
      wsRuntime2?.emitMessageReceived(wsLastIdx, wsGenType);
      wsRuntime2?.emitMessageRendered(wsLastIdx, wsGenType);
      wsAssistantMessageIdRef.current = null;
    },
    onFinalContent: (data) => {
      const assistantId = wsAssistantMessageIdRef.current;
      if (!assistantId) return;
      const persistedMessageId = (typeof data.message_id === 'string' || typeof data.message_id === 'number')
        ? data.message_id
        : null;
      const nextVariables = (data.variables && typeof data.variables === 'object') ? data.variables : null;
      // [WS-MVU-EVENT] WebSocket 路径与 HTTP 路径对齐：final_content 带 variables 时
      // dispatch palink:mvuVariablesUpdated，让会话级 sessionVariables 即时更新。
      // 否则旧消息 iframe（面板常驻处）只能靠 isGenerating 翻转后的异步 refetch 兜底，
      // 面板拿到的是旧 stat_data —— "变量进不了面板"的前端侧根因之一。
      if (nextVariables) {
        window.dispatchEvent(new CustomEvent('palink:mvuVariablesUpdated', {
          detail: { sessionId: wsResolvedSessionIdRef.current ?? selectedSession?.id, variables: nextVariables },
        }));
      }
      setMessages(prev => prev.map(msg => {
        if (msg.id !== assistantId) return msg;
        const patched = {
          ...msg,
          id: persistedMessageId ? String(persistedMessageId) : msg.id,
          message_id: persistedMessageId ?? msg.message_id,
          content: data.content,
        };
        if (nextVariables) {
          patched.extra = { ...(msg.extra || {}), variables: nextVariables };
        }
        return patched;
      }));
      if (persistedMessageId) {
        wsAssistantMessageIdRef.current = String(persistedMessageId);
      }
      wsFullContentRef.current = data.content;
      wsFullReasoningRef.current = '';
    },
    onSync: (data) => {
      const assistantId = wsAssistantMessageIdRef.current;
      if (!assistantId) return;

      if (!catchUpAnimatorRef.current) {
        catchUpAnimatorRef.current = new CatchUpAnimator((content) => {
          setMessages(prev => {
            const newMessages = [...prev];
            const assistantIdx = messageIndexMapRef.current.get(assistantId) ?? newMessages.findIndex((msg) => msg.id === assistantId);
            if (assistantIdx === -1) return newMessages;
            newMessages[assistantIdx] = {
              ...newMessages[assistantIdx],
              content,
            };
            return newMessages;
          });
        });
      }

      // [REASONING-SEPARATE] 追赶动画只作用于正文；思考直接写入 extra.reasoning
      const syncReasoning = typeof data.reasoning === 'string' ? data.reasoning : '';
      if (syncReasoning) {
        setMessages(prev => prev.map(msg => (
          String(msg.id) === String(assistantId)
            ? { ...msg, extra: { ...(msg.extra || {}), reasoning: syncReasoning } }
            : msg
        )));
      }

      if (catchUpAnimatorRef.current.isRunning) {
        catchUpAnimatorRef.current.appendContent(data.content || '');
      } else {
        setMessages(prev => {
          const currentMsg = prev.find((msg) => msg.id === assistantId);
          catchUpAnimatorRef.current!.start(data.content || '', currentMsg?.content ?? '');
          return prev;
        });
      }

      if (data.status === 'done') {
        catchUpAnimatorRef.current.stop();
        catchUpAnimatorRef.current = null;
        setIsGenerating(false);
        setRegeneratingMessageIndex(null);
      }
    },
    onMessageImageGenerated: (data) => {
      setMessages(prev => prev.map(msg => (
        String(msg.id) === String(data.message_id) ? { ...msg, content: data.content } : msg
      )));
      toast.success('图片已生成');
    },
    onMessageImageGenerationFailed: (data) => {
      toast.error(data.error || '图片生成失败');
    },
    onPlotLineAdvanced: (data) => {
      // WebSocket 路径收到 PlotLine 阶段推进事件
      const sessionId = wsResolvedSessionIdRef.current ?? selectedSession?.id ?? undefined;
      const newStage = data.new_stage;
      const title = newStage?.title || '新阶段';
      toast.success(`剧情推进到：${title}`);
      onPlotLineAdvancedRef.current?.({ new_stage: newStage, session_id: sessionId });
    },
    onError: (data) => {
      const assistantId = wsAssistantMessageIdRef.current;
      if (assistantId) {
        const errorInfo = AppError.fromStreamError(data.message);
        setCurrentError(errorInfo);

        setMessages(prev => {
          const newMessages = [...prev];
          const assistantIdx = newMessages.findIndex((msg) => msg.id === assistantId);
          if (assistantIdx >= 0) {
            newMessages[assistantIdx].content =
              `⚠️ **${errorInfo.title}**\n\n${errorInfo.description}\n\n💡 ${errorInfo.suggestion}`;
          }
          return newMessages;
        });
      }
      setIsGenerating(false);
      setRegeneratingMessageIndex(null);
      setRequestStartTime(null);
      setTimeoutWarning(false);
      if (timeoutRef.current) {
        window.clearTimeout(timeoutRef.current);
      }
      // WebSocket 错误路径也触发 generation_ended，让插件知道生成结束了
      const wsErrorRuntime = getGlobalSillyTavernRuntime();
      wsErrorRuntime?.onGenerationEnded('');
      wsAssistantMessageIdRef.current = null;
    },
    onSlashResponse: (data) => {
      // slash 命令响应：展示为系统消息 toast，保留历史记录感
      const text = data?.response?.trim();
      if (!text) return;
      toast.message(text, { description: '斜杠命令输出' });
    },
    onToolCallRequest: (data) => {
      // Task 3.4.5: 后端请求执行插件 function tool handler
      const { tool_call_id, name, arguments: args } = data;
      const sessionId = wsResolvedSessionIdRef.current ?? selectedSession?.id;
      try {
        const entry = functionToolRegistry.get(name);
        if (!entry || typeof entry.handler !== 'function') {
          wsSendToolCallResponse({
            tool_call_id,
            session_id: sessionId,
            result: `Tool error: handler '${name}' not found`,
          });
          return;
        }
        // handler 可能是同步或异步；统一用 Promise 包装
        const argObj = (typeof args === 'object' && args !== null) ? args : {};
        Promise.resolve()
          .then(() => entry.handler(argObj))
          .then((result) => {
            const resultStr = typeof result === 'string' ? result : JSON.stringify(result);
            wsSendToolCallResponse({ tool_call_id, session_id: sessionId, result: resultStr });
          })
          .catch((err) => {
            const errMsg = err instanceof Error ? err.message : String(err);
            wsSendToolCallResponse({
              tool_call_id,
              session_id: sessionId,
              result: `Tool error: ${errMsg}`,
            });
          });
      } catch (err) {
        const errMsg = err instanceof Error ? err.message : String(err);
        wsSendToolCallResponse({
          tool_call_id,
          session_id: sessionId,
          result: `Tool error: ${errMsg}`,
        });
      }
    },
    onUsage: () => {},
    onSessionId: (sessionId) => {
      wsResolvedSessionIdRef.current = sessionId;
      if (!selectedSession && !wsSessionSyncedRef.current) {
        wsSessionSyncedRef.current = true;
        const now = new Date().toISOString();
        setSelectedSession({
          id: sessionId,
          dialogue_mode: dialogueMode,
          created_at: now,
          updated_at: now,
        });
        if (selectedCharacter) {
          loadSessions(selectedCharacter.id);
        }
      }
    },
  });

  const selectedCharacterId = selectedCharacter?.id;

  useEffect(() => {
    if (selectedCharacterId) {
      wsConnect('character');
    }
    return () => {
      wsDisconnect();
      if (catchUpAnimatorRef.current) {
        catchUpAnimatorRef.current.stop();
        catchUpAnimatorRef.current = null;
      }
    };
  }, [selectedCharacterId, wsConnect, wsDisconnect]);

  const handleRegenerate = useCallback(async (messageIndex: number) => {
    if (!selectedCharacter || isGenerating || uploading || messageIndex < 0) return;

    const assistantMessageIndex = messageIndex;
    // 开场白（messageIndex === 0）前面没有 user 消息。
    // ST 对齐：重新生成开场白时直接基于角色卡/系统提示生成，
    // 上下文不注入开场白文本，前端仅跳过 user 上下文解析即可。
    const userMessageIndex = assistantMessageIndex - 1;
    const userMessage = userMessageIndex >= 0 ? messages[userMessageIndex] : undefined;
    if (userMessageIndex >= 0 && userMessage?.role !== 'user') return;

    const assistantMessage = messages[assistantMessageIndex];
    const targetMessageId = typeof assistantMessage.id === 'number'
      ? assistantMessage.id
      : (typeof assistantMessage.message_id === 'number' ? assistantMessage.message_id : null);
    if (targetMessageId === null) {
      toast.error('无法重新生成：消息未持久化');
      return;
    }

    const sessionId = (selectedSession?.id && selectedSession.id !== '__pending__') ? selectedSession.id : null;
    if (!sessionId) {
      toast.error('无法重新生成：会话未创建');
      return;
    }

    setRegeneratingMessageIndex(assistantMessageIndex);
    setIsGenerating(true);
    setSuggestions([]);

    const assistantMessageId = generateMessageId();
    setMessages(prev => {
      const newMessages = [...prev];
      newMessages[assistantMessageIndex] = {
        id: assistantMessageId,
        role: 'assistant',
        content: '',
        model: selectedModel,
      };
      return newMessages;
    });

    abortControllerRef.current = new AbortController();
    let fullContent = '';
    let fullReasoning = '';
    try {
      // Task 7.2: 触发 ST GENERATION_STARTED 事件（带 type，区分 normal/regenerate/continue/swipe）
      const runtime = getGlobalSillyTavernRuntime();
      const baseMessage = userMessage
        ? userMessage.content.replace(/!\[.*?\]\(.*?\)|\[📎.*?\]\(.*?\)/g, '').trim()
        : '';

      runtime?.emitGenerationStarted('regenerate', {
        character_id: selectedCharacter.id,
        model: selectedModel,
        session_id: sessionId,
        message: baseMessage,
      });

      const response = await api.stream(`/api/character-sessions/${sessionId}/regenerate`, {
        message_id: targetMessageId,
        model: selectedModel,
        temperature: currentPreset?.temperature ?? 0.7,
        top_p: currentPreset?.top_p ?? 0.9,
        max_tokens: currentPreset?.max_tokens ?? 2048,
        frequency_penalty: currentPreset?.frequency_penalty ?? 0,
        presence_penalty: currentPreset?.presence_penalty ?? 0,
        response_length: responseLength,
        user_nickname: getDisplayName(selectedCharacter),
        preset_id: currentPreset?.id,
      }, { signal: abortControllerRef.current.signal });

      const streamResult = await streamEngineRef.current.sendViaSSE(response, (json) => {
        // 后端已开始生成：清除超时警告，避免网关响应慢时误报"回复慢"
        if (json.type === 'generation_started') {
          if (timeoutRef.current) {
            window.clearTimeout(timeoutRef.current);
            timeoutRef.current = null;
          }
          setTimeoutWarning(false);
          return;
        }
        if (json.type === 'message_image_generated' && (typeof json.message_id === 'string' || typeof json.message_id === 'number') && typeof json.content === 'string') {
          setMessages(prev => prev.map(msg => (
            String(msg.id) === String(json.message_id) ? { ...msg, content: json.content as string } : msg
          )));
          toast.success('图片已生成');
          return;
        }
        if (json.type === 'message_image_generation_failed') {
          toast.error(typeof json.error === 'string' ? json.error : '图片生成失败');
          return;
        }
        // PlotLine 阶段自动推进事件
        if (json.type === 'plotline_advanced' && json.new_stage && typeof json.new_stage === 'object') {
          const newStage = json.new_stage as { stage_index: number; title: string; summary: string };
          const title = newStage.title || '新阶段';
          toast.success(`剧情推进到：${title}`);
          onPlotLineAdvancedRef.current?.({ new_stage: newStage, session_id: sessionId });
          return;
        }
        if (json.type === 'final_content' && typeof json.content === 'string') {
          const persistedMessageId = (typeof json.message_id === 'string' || typeof json.message_id === 'number')
            ? json.message_id
            : null;
          if (json.variables && typeof json.variables === 'object') {
            window.dispatchEvent(new CustomEvent('palink:mvuVariablesUpdated', {
              detail: { sessionId, variables: json.variables },
            }));
          }
          setMessages(prev => prev.map(msg => (
            msg.id === assistantMessageId
              ? {
                  ...msg,
                  id: persistedMessageId ?? msg.id,
                  message_id: persistedMessageId ?? msg.message_id,
                  content: json.content as string,
                  ...(json.variables ? { extra: { ...(msg.extra || {}), variables: json.variables } } : {}),
                }
              : msg
          )));
          fullContent = json.content as string;
          fullReasoning = '';
          return;
        }
        const reasoning = typeof json.reasoning === 'string' ? json.reasoning : '';
        const modelReasoning = typeof json.model_reasoning === 'string' ? json.model_reasoning : '';
        const content = typeof json.content === 'string' ? json.content : '';

        if (json.type === 'usage') return;

        if (!reasoning && !modelReasoning && !content) return;

        if (reasoning) fullReasoning += reasoning;
        if (modelReasoning) fullReasoning += modelReasoning;
        if (content) {
          fullContent += content;
          // Task 7.3: 触发 ST STREAM_TOKEN_RECEIVED 事件
          runtime?.onStreamToken(content);
        }

        // [REASONING-SEPARATE] 正文与思考分离携带，不再拼接包裹体
        scheduleStreamUpdate(assistantMessageId, fullContent, fullReasoning || undefined);
      });

      if (streamResult.cancelled) {
        // Task 7.2: 触发 ST GENERATION_STOPPED + GENERATION_ENDED 事件
        runtime?.stopGeneration();
        runtime?.emitGenerationEnded('regenerate', '');
        setIsGenerating(false);
        return;
      }

      // Task 7.2: 触发 ST STREAM_REASONING_DONE + GENERATION_ENDED 事件
      if (fullReasoning) {
        runtime?.onStreamReasoningDone(fullReasoning);
      }
      // Fix 4: 传入 assistantMessageIndex 使插件加强模式能解析 messageId
      runtime?.emitGenerationEnded('regenerate', fullContent, assistantMessageIndex);
      // 主流程完成：触发消息接收与渲染事件（插件系统依赖这些事件）
      runtime?.emitMessageReceived(assistantMessageIndex, 'regenerate');
      runtime?.emitMessageRendered(assistantMessageIndex, 'regenerate');

      await loadSessions(selectedCharacter.id);
      await loadMemoryStats(sessionId);
    } catch (e: any) {
      const runtime = getGlobalSillyTavernRuntime();
      if (e.name === 'AbortError') {
        // Task 7.2: 触发 ST GENERATION_STOPPED + GENERATION_ENDED 事件
        runtime?.stopGeneration();
        runtime?.emitGenerationEnded('regenerate', '');
      } else {
        // Task 7.2: 非 AbortError 错误路径触发 GENERATION_ENDED
        runtime?.emitGenerationEnded('regenerate', '');
        setMessages(prev => {
          const newMessages = [...prev];
          const assistantIdx = newMessages.findIndex((msg) => msg.id === assistantMessageId);
          if (assistantIdx >= 0) {
            newMessages[assistantIdx].content += `\n[Error: ${e.message}]`;
          }
          return newMessages;
        });
      }
    } finally {
      if (streamRafRef.current !== null) {
        cancelAnimationFrame(streamRafRef.current);
        streamRafRef.current = null;
      }
      const pending = streamPendingRef.current;
      if (pending) {
        streamPendingRef.current = null;
        setMessages(prev => {
          const idx = prev.findIndex((msg) => msg.id === pending.assistantId);
          if (idx === -1) return prev;
          const newMessages = [...prev];
          newMessages[idx] = pending.reasoning !== undefined
            ? { ...newMessages[idx], content: pending.content, extra: { ...(newMessages[idx].extra || {}), reasoning: pending.reasoning } }
            : { ...newMessages[idx], content: pending.content };
          return newMessages;
        });
      }
      setIsGenerating(false);
      setRegeneratingMessageIndex(null);
      abortControllerRef.current = null;
    }
  }, [selectedCharacter, selectedSession, selectedModel, currentPreset, isGenerating, uploading, messages, getDisplayName, setMessages, loadSessions, loadMemoryStats, responseLength, scheduleStreamUpdate]);

  // Continue generation — calls the dedicated /continue endpoint which
  // appends to the last assistant message without adding a new user message.
  const handleContinue = useCallback(async (): Promise<void> => {
    if (!selectedCharacter || isGenerating || uploading) return;

    const sessionId = (selectedSession?.id && selectedSession.id !== '__pending__') ? selectedSession.id : null;
    if (!sessionId) {
      toast.error('无法续写：会话未创建');
      return;
    }

    // 找到最后一条 assistant 消息
    let assistantIdx = -1;
    for (let i = messages.length - 1; i >= 0; i--) {
      if (messages[i].role === 'assistant') {
        assistantIdx = i;
        break;
      }
    }
    if (assistantIdx === -1) {
      toast.error('无法续写：没有可续写的 AI 消息');
      return;
    }

    const lastAssistant = messages[assistantIdx];
    const assistantMessageId = String(lastAssistant.id ?? '');
    const originalContent = lastAssistant.content || '';

    setIsGenerating(true);
    setSuggestions([]);

    abortControllerRef.current = new AbortController();
    let fullContent = '';
    let fullReasoning = '';

    try {
      // 触发 ST GENERATION_STARTED 事件（type: continue）
      const runtime = getGlobalSillyTavernRuntime();
      runtime?.emitGenerationStarted('continue', {
        character_id: selectedCharacter.id,
        model: selectedModel,
        session_id: sessionId,
      });

      const response = await api.stream(`/api/character-sessions/${sessionId}/continue`, {
        model: selectedModel,
        temperature: currentPreset?.temperature ?? 0.7,
        top_p: currentPreset?.top_p ?? 0.9,
        max_tokens: currentPreset?.max_tokens ?? 2048,
        frequency_penalty: currentPreset?.frequency_penalty ?? 0,
        presence_penalty: currentPreset?.presence_penalty ?? 0,
        response_length: responseLength,
        user_nickname: getDisplayName(selectedCharacter),
        preset_id: currentPreset?.id,
      }, { signal: abortControllerRef.current.signal });

      const streamResult = await streamEngineRef.current.sendViaSSE(response, (json) => {
        // 后端已开始生成：清除超时警告（与主发送路径一致）
        if (json.type === 'generation_started') {
          if (timeoutRef.current) {
            window.clearTimeout(timeoutRef.current);
            timeoutRef.current = null;
          }
          setTimeoutWarning(false);
          return;
        }
        if (json.type === 'plotline_advanced' && json.new_stage && typeof json.new_stage === 'object') {
          const newStage = json.new_stage as { stage_index: number; title: string; summary: string };
          const title = newStage.title || '新阶段';
          toast.success(`剧情推进到：${title}`);
          onPlotLineAdvancedRef.current?.({ new_stage: newStage, session_id: sessionId });
          return;
        }
        if (json.type === 'final_content' && typeof json.content === 'string') {
          const persistedMessageId = (typeof json.message_id === 'string' || typeof json.message_id === 'number')
            ? json.message_id
            : null;
          if (json.variables && typeof json.variables === 'object') {
            window.dispatchEvent(new CustomEvent('palink:mvuVariablesUpdated', {
              detail: { sessionId, variables: json.variables },
            }));
          }
          setMessages(prev => prev.map(msg => (
            String(msg.id) === assistantMessageId
              ? {
                  ...msg,
                  id: persistedMessageId ?? msg.id,
                  message_id: persistedMessageId ?? msg.message_id,
                  content: json.content as string,
                  ...(json.variables ? { extra: { ...(msg.extra || {}), variables: json.variables } } : {}),
                }
              : msg
          )));
          fullContent = json.content as string;
          fullReasoning = '';
          return;
        }
        const reasoning = typeof json.reasoning === 'string' ? json.reasoning : '';
        const modelReasoning = typeof json.model_reasoning === 'string' ? json.model_reasoning : '';
        const content = typeof json.content === 'string' ? json.content : '';

        if (json.type === 'usage') return;

        if (!reasoning && !modelReasoning && !content) return;

        if (reasoning) fullReasoning += reasoning;
        if (modelReasoning) fullReasoning += modelReasoning;
        if (content) {
          fullContent += content;
          runtime?.onStreamToken(content);
        }

        // continue 模式：流式正文追加到原消息内容之后；思考分离携带
        scheduleStreamUpdate(assistantMessageId, originalContent + fullContent, fullReasoning || undefined);
      });

      if (streamResult.cancelled) {
        runtime?.stopGeneration();
        runtime?.emitGenerationEnded('continue', '');
        setIsGenerating(false);
        return;
      }

      if (fullReasoning) {
        runtime?.onStreamReasoningDone(fullReasoning);
      }
      // Fix 4: 传入 assistantIdx 使插件加强模式能解析 messageId
      runtime?.emitGenerationEnded('continue', fullContent, assistantIdx);
      runtime?.emitMessageReceived(assistantIdx, 'continue');
      runtime?.emitMessageRendered(assistantIdx, 'continue');

      await loadMemoryStats(sessionId);
    } catch (e: any) {
      const runtime = getGlobalSillyTavernRuntime();
      if (e.name === 'AbortError') {
        runtime?.stopGeneration();
        runtime?.emitGenerationEnded('continue', '');
      } else {
        runtime?.emitGenerationEnded('continue', '');
        setMessages(prev => prev.map(msg => (
          String(msg.id) === assistantMessageId
            ? { ...msg, content: (msg.content || '') + `\n[Error: ${e.message}]` }
            : msg
        )));
      }
    } finally {
      if (streamRafRef.current !== null) {
        cancelAnimationFrame(streamRafRef.current);
        streamRafRef.current = null;
      }
      const pending = streamPendingRef.current;
      if (pending) {
        streamPendingRef.current = null;
        setMessages(prev => {
          const idx = prev.findIndex((msg) => msg.id === pending.assistantId);
          if (idx === -1) return prev;
          const newMessages = [...prev];
          newMessages[idx] = pending.reasoning !== undefined
            ? { ...newMessages[idx], content: pending.content, extra: { ...(newMessages[idx].extra || {}), reasoning: pending.reasoning } }
            : { ...newMessages[idx], content: pending.content };
          return newMessages;
        });
      }
      setIsGenerating(false);
      abortControllerRef.current = null;
    }
  }, [selectedCharacter, selectedSession, selectedModel, currentPreset, isGenerating, uploading, messages, getDisplayName, setMessages, loadMemoryStats, responseLength, scheduleStreamUpdate]);


  const handleSendMessage = useCallback(async (content: string, images: string[], options: SendMessageOptions = {}): Promise<string | null> => {
    if (!selectedCharacter) return null;

    const isSmartCardTrigger = options.smartCardTrigger === true;
    const text = isSmartCardTrigger
      ? (options.useEmptyContext ? '' : cleanSmartCardTriggerContext(options.smartCardContext ?? content))
      : (content || inputValue);
    if ((!text.trim() && attachments.length === 0 && !isSmartCardTrigger) || isGenerating || uploading) return null;

    const effectiveSession = options.sessionOverride !== undefined ? options.sessionOverride : selectedSession;
    let effectiveBranchId = options.branchIdOverride !== undefined ? options.branchIdOverride || undefined : selectedBranch?.id;

    if (forkPoint && effectiveSession) {
      try {
        const resp = await api.post(`/api/character-sessions/${effectiveSession.id}/branches`, {
          session_id: effectiveSession.id,
          parent_branch_id: forkPoint.branchId,
          parent_message_id: forkPoint.messageId,
          same_level: false,
        });
        if (resp?.branch?.id) {
          effectiveBranchId = resp.branch.id;
          onBranchCreated(resp.branch);
        }
        onForkCreated();
      } catch (e: any) {
        console.error('Failed to create fork branch:', e);
        onForkCreated();
      }
    }

    const pendingAttachments = options.ignorePendingAttachments ? [] : attachments;
    const outgoingImages = pendingAttachments.length > 0
      ? pendingAttachments.filter(a => a.type === 'image').map(a => a.url)
      : images;
    const outgoingFiles = pendingAttachments.filter(a => a.type === 'file').map(a => a.url);

    setCurrentError(null);
    setTimeoutWarning(false);
    setInputValue('');
    setAttachments([]);
    setIsGenerating(true);
    setSuggestions([]);

    setRetryMessageContent(options.suppressUserMessage ? '' : text);
    setRetryMessageImages(outgoingImages);

    setRequestStartTime(Date.now());
    timeoutRef.current = window.setTimeout(() => {
      setTimeoutWarning(true);
    }, TIMEOUT_WARNING_MS);

    let displayContent = text;
    if (pendingAttachments.length > 0) {
      displayContent += '\n\n';
      pendingAttachments.forEach(att => {
        displayContent += att.type === 'image'
          ? `![${att.name}](${att.url})\n`
          : `[📎 ${att.name}](${att.url})\n`;
      });
    }

    const userMessageId = generateMessageId();
    const assistantMessageId = generateMessageId();
    setMessages(prev => {
      if (options.suppressUserMessage) {
        return [
          ...prev,
          { id: assistantMessageId, role: 'assistant', content: '', model: selectedModel },
        ];
      }
      return [
        ...prev,
        { id: userMessageId, role: 'user', content: displayContent, model: selectedModel },
        { id: assistantMessageId, role: 'assistant', content: '', model: selectedModel },
      ];
    });

    abortControllerRef.current = new AbortController();
    let fullContent = '';
    let fullReasoning = '';
    let hasReceivedData = false;
    let resolvedSessionId: string | null = (effectiveSession?.id && effectiveSession.id !== '__pending__') ? effectiveSession.id : null;
    let sessionSynced = false;
    const requestSessionId = (effectiveSession?.id && effectiveSession.id !== '__pending__') ? effectiveSession.id : null;

    // Task 18: Apply AI_INPUT regex to the outgoing message before sending to the API.
    // This transforms what the AI sees without altering the chat display (displayContent
    // retains the original text). Skipped for smart-card triggers to preserve trigger context.
    const messageForApi = isSmartCardTrigger
      ? text
      : getRegexedStringForMessage(text, regex_placement.AI_INPUT, {
          characterName: selectedCharacter.name,
          characterAvatar: selectedCharacter.avatar || '',
          characterExtensions: selectedCharacter.extensions,
          characterPresetData: selectedCharacter.preset_data,
          globalRegexScripts: getCachedGlobalRegexScripts(),
        });

    // Task 7.5: 获取扩展提示（SSE 与 WebSocket 路径共用）
    // 后端 CharacterChatRequest.extension_prompts 期望 List[ExtensionPromptInput]（数组），
    // 而 promptInjection 内部存储为 Record<string, ExtensionPromptEntry>（对象）。
    // 这里把 Record 转为数组，并把 key 写入 identifier 字段。
    // 同时过滤掉 filter 函数（无法序列化）和空 content 条目。
    // [EP-BRIDGE] 提前到 WebSocket 分支前构造，使 WS 请求体同样注入 extension_prompts
    // （修复前 WS 模式完全不注入扩展提示词）。
    const extensionPromptsRecord = promptInjection.getPromptsForGeneration();
    const extensionPrompts = Object.entries(extensionPromptsRecord)
      .filter(([, entry]: [string, any]) => entry && (entry.content ?? '').length > 0)
      .map(([identifier, entry]: [string, any]) => ({
        identifier,
        content: entry.content,
        position: entry.position,
        depth: entry.depth,
        role: entry.role,
        filter: typeof entry.filter === 'function' ? null : entry.filter,
        // scan 字段后端不处理，不发送
      }));

    if (useWebSocket && wsConnected && !(isSmartCardTrigger && options.awaitResult)) {
      wsAssistantMessageIdRef.current = assistantMessageId;
      wsFullContentRef.current = '';
      wsFullReasoningRef.current = '';
      wsResolvedSessionIdRef.current = requestSessionId;
      wsSessionSyncedRef.current = false;
      wsHasReceivedDataRef.current = false;

      // WebSocket 路径触发生成开始事件（与 SSE 路径的 runtime.startGeneration 对应）
      const wsRuntime = getGlobalSillyTavernRuntime();
      wsRuntime?.startGeneration(messageForApi, {
        type: 'normal',
        character_id: selectedCharacter.id,
        model: selectedModel,
        session_id: requestSessionId ?? undefined,
      });

      wsSendCharacterChatRequest({
        session_id: requestSessionId,
        character_id: selectedCharacter.id,
        message: messageForApi,
        model: selectedModel,
        temperature: currentPreset?.temperature ?? 0.7,
        top_p: currentPreset?.top_p ?? 0.9,
        max_tokens: currentPreset?.max_tokens ?? 2048,
        frequency_penalty: currentPreset?.frequency_penalty ?? 0,
        presence_penalty: currentPreset?.presence_penalty ?? 0,
        dialogue_mode: dialogueMode,
        branch_id: effectiveBranchId,
        user_nickname: getDisplayName(selectedCharacter),
        images: outgoingImages,
        files: outgoingFiles,
        response_length: responseLength,
        smart_card_trigger: isSmartCardTrigger,
        smart_card_context: isSmartCardTrigger ? text : undefined,
        preset_id: currentPreset?.id,
        // [EP-BRIDGE] WS 路径注入扩展提示词（与 SSE 路径一致，修复前 WS 完全不注入）
        extension_prompts: extensionPrompts,
        // Task 3.4.1: 序列化插件 function tool 为 OpenAI tool calling 格式
        tools: serializeFunctionTools(),
      });

      if (!effectiveSession) {
        loadSessions(selectedCharacter.id);
      }

      return null;
    }

    try {
      // Task 7.2: 触发 ST GENERATION_STARTED 事件（带 type，区分 normal/regenerate/continue/swipe）
      const runtime = getGlobalSillyTavernRuntime();
      // Task 7.4: 构建世界书上下文
      const worldBookContext = buildWorldBookContextForChat();
      // 注入世界书上下文到消息前（与 generationEngine._buildWorldBookContext 行为一致）
      const effectiveMessage = worldBookContext ? worldBookContext + '\n' + messageForApi : messageForApi;

      runtime?.emitGenerationStarted('normal', {
        character_id: selectedCharacter.id,
        model: selectedModel,
        session_id: requestSessionId ?? undefined,
        message: effectiveMessage,
      });

      const response = await api.stream('/api/character-chat', {
        session_id: requestSessionId,
        character_id: selectedCharacter.id,
        message: effectiveMessage,
        model: selectedModel,
        temperature: currentPreset?.temperature ?? 0.7,
        top_p: currentPreset?.top_p ?? 0.9,
        max_tokens: currentPreset?.max_tokens ?? 2048,
        frequency_penalty: currentPreset?.frequency_penalty ?? 0,
        presence_penalty: currentPreset?.presence_penalty ?? 0,
        dialogue_mode: dialogueMode,
        branch_id: effectiveBranchId,
        user_nickname: getDisplayName(selectedCharacter),
        images: outgoingImages,
        files: outgoingFiles,
        response_length: responseLength,
        smart_card_trigger: isSmartCardTrigger,
        smart_card_context: isSmartCardTrigger ? text : undefined,
        extension_prompts: extensionPrompts,
        preset_id: currentPreset?.id,
        // Task 3.4.1: 序列化插件 function tool（SSE 路径降级：无法接收前端响应）
        tools: serializeFunctionTools(),
      }, { signal: abortControllerRef.current.signal });

      if (!effectiveSession) {
        loadSessions(selectedCharacter.id);
      }

      const streamResult2 = await streamEngineRef.current.sendViaSSE(response, (json) => {
        if (!hasReceivedData) {
          hasReceivedData = true;
          setTimeoutWarning(false);
          if (timeoutRef.current) {
            window.clearTimeout(timeoutRef.current);
          }
        }

        const sessionId = typeof json.session_id === 'string' ? json.session_id : null;
        if (json.type === 'message_image_generated' && (typeof json.message_id === 'string' || typeof json.message_id === 'number') && typeof json.content === 'string') {
          setMessages(prev => prev.map(msg => (
            String(msg.id) === String(json.message_id) ? { ...msg, content: json.content as string } : msg
          )));
          toast.success('图片已生成');
          return;
        }
        if (json.type === 'message_image_generation_failed') {
          toast.error(typeof json.error === 'string' ? json.error : '图片生成失败');
          return;
        }
        // PlotLine 阶段自动推进事件
        if (json.type === 'plotline_advanced' && json.new_stage && typeof json.new_stage === 'object') {
          const newStage = json.new_stage as { stage_index: number; title: string; summary: string };
          const title = newStage.title || '新阶段';
          toast.success(`剧情推进到：${title}`);
          onPlotLineAdvancedRef.current?.({ new_stage: newStage, session_id: resolvedSessionId ?? undefined });
          return;
        }
        if (json.type === 'final_content' && typeof json.content === 'string') {
          const persistedMessageId = (typeof json.message_id === 'string' || typeof json.message_id === 'number')
            ? json.message_id
            : null;
          if (json.variables && typeof json.variables === 'object') {
            window.dispatchEvent(new CustomEvent('palink:mvuVariablesUpdated', {
              detail: { sessionId: sessionId || resolvedSessionId, variables: json.variables },
            }));
          }
          fullContent = json.content as string;
          fullReasoning = '';
          setMessages(prev => prev.map(msg => (
            msg.id === assistantMessageId
              ? {
                  ...msg,
                  id: persistedMessageId ?? msg.id,
                  message_id: persistedMessageId ?? msg.message_id,
                  content: fullContent,
                  ...(json.variables ? { extra: { ...(msg.extra || {}), variables: json.variables } } : {}),
                }
              : msg
          )));
          return;
        }

        const reasoning = typeof json.reasoning === 'string' ? json.reasoning : '';
        const modelReasoning = typeof json.model_reasoning === 'string' ? json.model_reasoning : '';
        const content = typeof json.content === 'string' ? json.content : '';

        if (json.type === 'usage') return;

        if (sessionId) {
          resolvedSessionId = sessionId;
          if ((!effectiveSession || effectiveSession.id === '__pending__') && !sessionSynced) {
            sessionSynced = true;
            const now = new Date().toISOString();
            setSelectedSession({
              id: sessionId,
              dialogue_mode: dialogueMode,
              created_at: now,
              updated_at: now,
            });
            loadSessions(selectedCharacter.id);
          }
        }

        if (!reasoning && !modelReasoning && !content) return;

        if (reasoning) fullReasoning += reasoning;
        if (modelReasoning) fullReasoning += modelReasoning;
        if (content) {
          fullContent += content;
          // Task 7.3: 触发 ST STREAM_TOKEN_RECEIVED 事件
          runtime?.onStreamToken(content);
        }

        // [REASONING-SEPARATE] 正文与思考分离携带，不再拼接包裹体
        scheduleStreamUpdate(assistantMessageId, fullContent, fullReasoning || undefined);
      });

      if (streamResult2.cancelled) {
        // Task 7.2: 触发 ST GENERATION_STOPPED + GENERATION_ENDED 事件
        runtime?.stopGeneration();
        runtime?.emitGenerationEnded('normal', '');
        setIsGenerating(false);
        return fullContent || null;
      }

      // Task 7.2: 触发 ST STREAM_REASONING_DONE + GENERATION_ENDED 事件
      if (fullReasoning) {
        runtime?.onStreamReasoningDone(fullReasoning);
      }
      // 主流程完成：触发消息接收与渲染事件（插件系统依赖这些事件）
      // assistantMessageId 是 UUID，这里兜底用最近的消息索引，优先转成 numeric（失败回退 0）
      const lastMessageIndex = messages.length > 0 ? messages.length - 1 : 0;
      // Fix 4: 传入 lastMessageIndex 使插件加强模式能解析 messageId
      runtime?.emitGenerationEnded('normal', fullContent, lastMessageIndex);
      runtime?.emitMessageReceived(lastMessageIndex, 'normal');
      runtime?.emitMessageRendered(lastMessageIndex, 'normal');

      if (resolvedSessionId) {
        await loadSessions(selectedCharacter.id);
        await loadMemoryStats(resolvedSessionId);
      }
      return fullContent || null;
    } catch (e: any) {
      const runtime = getGlobalSillyTavernRuntime();
      if (e.name === 'AbortError') {
        // Task 7.2: 触发 ST GENERATION_STOPPED + GENERATION_ENDED 事件
        runtime?.stopGeneration();
        runtime?.emitGenerationEnded('normal', '');
      } else {
        // Task 7.2: 非 AbortError 错误路径触发 GENERATION_ENDED
        runtime?.emitGenerationEnded('normal', '');
        const errorInfo = AppError.fromStreamError(String(e));
        setCurrentError(errorInfo);

        setMessages(prev => {
          const newMessages = [...prev];
          const assistantIdx = newMessages.findIndex((msg) => msg.id === assistantMessageId);
          if (assistantIdx >= 0) {
            newMessages[assistantIdx].content =
              `⚠️ **${errorInfo.title}**\n\n${errorInfo.description}\n\n💡 ${errorInfo.suggestion}`;
          }
          return newMessages;
        });
      }
      return null;
    } finally {
      if (streamRafRef.current !== null) {
        cancelAnimationFrame(streamRafRef.current);
        streamRafRef.current = null;
      }
      const pending = streamPendingRef.current;
      if (pending) {
        streamPendingRef.current = null;
        setMessages(prev => {
          const idx = prev.findIndex((msg) => msg.id === pending.assistantId);
          if (idx === -1) return prev;
          const newMessages = [...prev];
          newMessages[idx] = pending.reasoning !== undefined
            ? { ...newMessages[idx], content: pending.content, extra: { ...(newMessages[idx].extra || {}), reasoning: pending.reasoning } }
            : { ...newMessages[idx], content: pending.content };
          return newMessages;
        });
      }
      setIsGenerating(false);
      setRequestStartTime(null);
      setTimeoutWarning(false);
      abortControllerRef.current = null;
      if (timeoutRef.current) {
        window.clearTimeout(timeoutRef.current);
      }
    }
  }, [selectedCharacter, selectedSession, selectedModel, dialogueMode, selectedBranch, currentPreset, inputValue, attachments, isGenerating, uploading, getDisplayName, setMessages, setSelectedSession, loadSessions, loadMemoryStats, forkPoint, onForkCreated, onBranchCreated, useWebSocket, wsConnected, wsSendCharacterChatRequest, responseLength, scheduleStreamUpdate]);

  const handleStopGeneration = useCallback(() => {
    if (useWebSocket && wsConnected && wsAssistantMessageIdRef.current) {
      wsSendCancel();
      // WebSocket 路径触发生成停止 + 结束事件
      const stopRuntime = getGlobalSillyTavernRuntime();
      stopRuntime?.stopGeneration();
      stopRuntime?.onGenerationEnded('');
      wsAssistantMessageIdRef.current = null;
    }
    abortControllerRef.current?.abort();
    abortControllerRef.current = null;
    clearGenerationTimers();
    setIsGenerating(false);
    setRegeneratingMessageIndex(null);
    setRequestStartTime(null);
    setTimeoutWarning(false);
  }, [clearGenerationTimers, useWebSocket, wsConnected, wsSendCancel]);

  const handleSendWithInput = useCallback(async () => {
    if (inputValue.trim() || attachments.length > 0) {
      await handleSendMessage(inputValue, attachments.filter(a => a.type === 'image').map(a => a.url));
    }
  }, [inputValue, attachments, handleSendMessage]);

  const handleSmartCardTrigger = useCallback(async (
    content: string,
    options: Pick<SendMessageOptions, 'sessionOverride' | 'branchIdOverride' | 'awaitResult' | 'useEmptyContext'> = {},
  ): Promise<string | null> => {
    const smartCardContext = cleanSmartCardTriggerContext(content);
    const context = options.useEmptyContext ? '' : smartCardContext;
    return await handleSendMessage(context, [], {
      ...options,
      ignorePendingAttachments: true,
      suppressUserMessage: true,
      smartCardTrigger: true,
      smartCardContext: context,
    });
  }, [handleSendMessage]);

  const handleRetry = useCallback(() => {
    if (retryMessageContent) {
      setCurrentError(null);
      handleSendMessage(retryMessageContent, retryMessageImages);
    }
  }, [retryMessageContent, retryMessageImages, handleSendMessage]);

  const handleCloseError = useCallback(() => {
    setCurrentError(null);
  }, []);

  const handleUpload = useCallback(async (file: File, type: 'image' | 'file') => {
    setUploading(true);
    try {
      const formData = new FormData();
      formData.append('file', file);
      const data = await api.post('/api/upload', formData);
      if (!data.url) {
        throw new Error('上传返回数据异常');
      }
      setAttachments(prev => [...prev, {
        type,
        name: file.name,
        url: data.url,
        thumbnail: type === 'image' ? URL.createObjectURL(file) : undefined,
        size: file.size,
      }]);
    } catch (e) {
      console.error('Upload failed:', e);
      toast.error('文件上传失败');
    } finally {
      setUploading(false);
    }
  }, []);

  const handleDeleteMessage = useCallback(async (messageId: string | number, messageIndex: number) => {
    if (!selectedSession) return;
    try {
      await api.delete(`/api/character-sessions/${selectedSession.id}/messages/${messageId}`);
      setMessages(prev => prev.filter((msg, idx) => {
        if (msg.id != null) {
          return String(msg.id) !== String(messageId);
        }
        return idx !== messageIndex;
      }));
    } catch (e) {
      console.error('Failed to delete message:', e);
      toast.error('删除消息失败');
    }
  }, [messages, selectedSession, setMessages]);

  const handleEditMessage = useCallback(async (
    messageId: string | number,
    messageIndex: number,
    newContent: string,
    options?: {
      role?: string;
      name?: string;
      is_user?: boolean;
      is_system?: boolean;
      is_name?: boolean;
      force_avatar?: string;
      original_avatar?: string;
      avatar?: string;
      gen_id?: string;
      group_id?: string;
      group_name?: string;
      selected_group?: unknown;
      groups?: Array<Record<string, unknown>>;
      swipe_id?: number;
      swipeId?: number;
      swipes?: string[];
      swipe_info?: Array<Record<string, unknown>>;
      extra?: Record<string, unknown>;
    },
  ) => {
    if (!selectedSession) return;
    try {
      const fallbackMessage = messages.find((msg) => String(msg.id) === String(messageId)) || messages[messageIndex];
      const requestedSwipeId = Number.isFinite(Number(options?.swipe_id ?? options?.swipeId))
        ? Number(options?.swipe_id ?? options?.swipeId)
        : undefined;
      const preparedSwipeId = requestedSwipeId ?? fallbackMessage?.swipe_id;
      const preparedSwipes = Array.isArray(options?.swipes)
        ? options.swipes.map((item) => String(item ?? ''))
        : Array.isArray(fallbackMessage?.swipes)
          ? fallbackMessage.swipes.map((item) => String(item ?? ''))
          : undefined;
      if (preparedSwipes && preparedSwipes.length > 0) {
        const activeSwipeId = Math.max(
          0,
          Math.min(Number.isFinite(Number(preparedSwipeId)) ? Number(preparedSwipeId) : 0, preparedSwipes.length - 1),
        );
        preparedSwipes[activeSwipeId] = newContent;
      }
      const preparedSwipeInfo = mergeSwipeInfoForCurrentDisplay(
        fallbackMessage,
        newContent,
        preparedSwipeId,
        preparedSwipes,
        Array.isArray(options?.swipe_info) ? options.swipe_info : undefined,
        options?.extra,
      );

      const persistedMessageId = Number(messageId);
      if (Number.isInteger(persistedMessageId) && persistedMessageId > 0) {
        await api.put(`/api/character-sessions/${selectedSession.id}/messages/${persistedMessageId}`, {
          content: newContent,
          role: options?.role,
          name: options?.name,
          is_user: options?.is_user,
          is_system: options?.is_system,
          is_name: options?.is_name,
          force_avatar: options?.force_avatar,
          original_avatar: options?.original_avatar,
          avatar: options?.avatar,
          gen_id: options?.gen_id,
          group_id: options?.group_id,
          group_name: options?.group_name,
          selected_group: options?.selected_group,
          groups: options?.groups,
          swipe_id: Number.isFinite(Number(options?.swipe_id ?? options?.swipeId))
            ? Number(options?.swipe_id ?? options?.swipeId)
            : undefined,
          swipes: preparedSwipes,
          swipe_info: preparedSwipeInfo,
          extra: options?.extra,
        });
      }
      setMessages(prev => {
        const newMessages = [...prev];
        const targetIndex = newMessages.findIndex((msg) => String(msg.id) === String(messageId));
        const safeIndex = targetIndex >= 0 ? targetIndex : messageIndex;
        if (safeIndex < 0 || safeIndex >= newMessages.length) {
          return newMessages;
        }

        const nextSwipeId = Number.isFinite(Number(options?.swipe_id ?? options?.swipeId))
          ? Number(options?.swipe_id ?? options?.swipeId)
          : newMessages[safeIndex].swipe_id;
        const nextSwipes = Array.isArray(options?.swipes)
          ? options.swipes.map((item) => String(item ?? ''))
          : Array.isArray(newMessages[safeIndex].swipes)
            ? newMessages[safeIndex].swipes.map((item) => String(item ?? ''))
            : undefined;
        if (nextSwipes && nextSwipes.length > 0) {
          const activeSwipeId = Math.max(
            0,
            Math.min(Number.isFinite(Number(nextSwipeId)) ? Number(nextSwipeId) : 0, nextSwipes.length - 1),
          );
          nextSwipes[activeSwipeId] = newContent;
        }
        const nextSwipeInfo = mergeSwipeInfoForCurrentDisplay(
          newMessages[safeIndex],
          newContent,
          nextSwipeId,
          nextSwipes,
          Array.isArray(options?.swipe_info) ? options.swipe_info : undefined,
          options?.extra,
        );

        newMessages[safeIndex] = {
          ...newMessages[safeIndex],
          role: options?.role && ['user', 'assistant', 'system'].includes(options.role)
            ? options.role as CharacterChatMessage['role']
            : newMessages[safeIndex].role,
          name: typeof options?.name === 'string' ? options.name : newMessages[safeIndex].name,
          is_user: typeof options?.is_user === 'boolean' ? options.is_user : newMessages[safeIndex].is_user,
          is_system: typeof options?.is_system === 'boolean' ? options.is_system : newMessages[safeIndex].is_system,
          is_name: typeof options?.is_name === 'boolean' ? options.is_name : (newMessages[safeIndex] as any).is_name,
          force_avatar: typeof options?.force_avatar === 'string' ? options.force_avatar : (newMessages[safeIndex] as any).force_avatar,
          original_avatar: typeof options?.original_avatar === 'string' ? options.original_avatar : (newMessages[safeIndex] as any).original_avatar,
          avatar: typeof options?.avatar === 'string' ? options.avatar : (newMessages[safeIndex] as any).avatar,
          gen_id: typeof options?.gen_id === 'string' ? options.gen_id : (newMessages[safeIndex] as any).gen_id,
          group_id: typeof options?.group_id === 'string' ? options.group_id : (newMessages[safeIndex] as any).group_id,
          group_name: typeof options?.group_name === 'string' ? options.group_name : (newMessages[safeIndex] as any).group_name,
          selected_group: options?.selected_group ?? (newMessages[safeIndex] as any).selected_group,
          groups: Array.isArray(options?.groups) ? options.groups : (newMessages[safeIndex] as any).groups,
          content: newContent,
          swipe_id: nextSwipeId,
          swipes: nextSwipes,
          swipe_info: nextSwipeInfo ?? newMessages[safeIndex].swipe_info,
          extra: options?.extra && typeof options.extra === 'object'
            ? { ...(newMessages[safeIndex].extra || {}), ...options.extra }
            : newMessages[safeIndex].extra,
        };
        return newMessages;
      });
    } catch (e) {
      console.error('Failed to edit message:', e);
      toast.error('编辑消息失败');
    }
  }, [messages, selectedSession, setMessages]);

  const handleGenerateImage = useCallback(async (messageId: string | number) => {
    if (!selectedSession) return;
    const key = String(messageId);
    setGeneratingImageMessageIds(prev => new Set(prev).add(key));
    try {
      const result = await api.imageGeneration.generateForCharacterMessage(selectedSession.id, messageId);
      setMessages(prev => prev.map(msg => (
        String(msg.id) === key ? { ...msg, content: result.updated_message.content } : msg
      )));
      toast.success('图片已生成');
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : '图片生成失败';
      toast.error(message);
    } finally {
      setGeneratingImageMessageIds(prev => {
        const next = new Set(prev);
        next.delete(key);
        return next;
      });
    }
  }, [selectedSession, setMessages]);

  // Cleanup on unmount
  const cleanupTimeout = useCallback(() => {
    if (timeoutRef.current) {
      window.clearTimeout(timeoutRef.current);
    }
  }, []);

  return {
    // State
    isGenerating,
    inputValue,
    setInputValue,
    attachments,
    setAttachments,
    uploading,
    suggestions,
    setSuggestions,
    regeneratingMessageIndex,
    generatingImageMessageIds,
    currentError,
    retryMessageContent,
    timeoutWarning,
    requestStartTime,

    // Handlers
    handleSendMessage,
    handleSmartCardTrigger,
    handleSendWithInput,
    handleRegenerate,
    handleContinue,
    handleRetry,
    handleCloseError,
    handleUpload,
    handleDeleteMessage,
    handleEditMessage,
    handleGenerateImage,
    handleStopGeneration,
    abortControllerRef,
    cleanupTimeout,
    wsConnected,
    useWebSocket,
  };
}
