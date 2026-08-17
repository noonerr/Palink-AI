import React, { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import { toast } from 'sonner';
import { api } from '@/services/api';
import { emitEvent } from '@/lib/event-bus';
import { evaluateMacros, initRegisterMacros } from '@/lib/macro-engine';
import { variableManager } from '@/lib/variables/manager';
import { stWorldBookManager, loadCharacterWorldBooks } from '@/lib/sillytavern/getContext';
import { groupChatManager } from '@/lib/group-chat/manager';
import type { GroupChat, GroupMember } from '@/lib/group-chat/types';
import { instructManager } from '@/lib/instruct/manager';
import { promptManager } from '@/lib/prompt-manager/manager';
import { personaManager } from '@/lib/personas/manager';
import { messageManager, type ChatMessage } from '@/services/message-manager';
import { generationEngine, type GenerationOptions } from '@/services/generation-engine';
import { promptInjection, type ExtensionPromptEntry, INJECTION_POSITION } from '@/services/prompt-injection';
import type { Character, CharacterChatMessage, CharacterChatSession, User } from '@/types';
import { PluginManager } from './PluginManager';
import { useSlashCommandInput } from '@/hooks/useSlashCommandInput';
import { SlashCommandEngine, type CommandContext } from '@/lib/slash-engine/mod';
import { WorldInfoScanPanel, type WorldInfoScanResult } from './WorldInfoScanPanel';
import { CharacterCardRenderer, looksLikeRenderableCardHtml, looksLikeSmartCardHtml } from '@/components/ui/custom/CharacterCardRenderer';
import { normalizeRegexScriptList } from '@/lib/sillytavern/regex/adapter';
import { regex_placement } from '@/lib/sillytavern/regex/engine';
import { getCachedGlobalRegexScripts } from '@/utils/sillyTavernDisplayPipeline';
import { formatMessage } from '@/lib/sillytavern/formatting';
import { chatShortcutManager } from '@/lib/shortcuts';
import { PushToTalkButton } from '@/components/ui/PushToTalkButton';
import { QrBar } from '../st-plugin-ui-host/QrBar';
export interface NativeRoleplayChatProps {
  character: Character;
  session: CharacterChatSession | null;
  messages: CharacterChatMessage[];
  user: User;
  isGenerating: boolean;
  onSendMessage: (content: string, images?: string[]) => Promise<string | null>;
  onStopGeneration: () => void;
  onEditMessage: (messageId: string, content: string) => Promise<void>;
  onDeleteMessage: (messageId: string) => Promise<void>;
  onRegenerate?: (messageIndex: number) => Promise<void>;
  onContinue?: () => Promise<void>;
  selectedModel?: string;
  sessionId?: string;
  branchId?: string;
  className?: string;
}

interface DisplayMessage {
  id: string;
  content: string;
  role: 'user' | 'assistant' | 'system';
  name: string;
  timestamp: string;
  isUser: boolean;
  isSystem: boolean;
  swipes: string[];
  swipeId: number;
  isStreaming: boolean;
}

function toStMessages(messages: CharacterChatMessage[]): ChatMessage[] {
  return messages.map((msg, idx) => ({
    id: String(msg.id ?? idx),
    name: msg.name || (msg.is_user ? 'User' : 'Assistant'),
    mes: msg.content || '',
    is_user: !!msg.is_user,
    is_system: !!msg.is_system,
    send_date: msg.created_at || new Date().toISOString(),
    swipes: Array.isArray(msg.swipes) ? msg.swipes : [msg.content || ''],
    swipe_id: msg.swipe_id ?? 0,
    swipe_info: msg.swipe_info || [{ send_date: msg.created_at || new Date().toISOString(), extra: {} }],
    extra: msg.extra || {},
  }));
}

export function NativeRoleplayChat({
  character,
  session,
  messages,
  user,
  isGenerating: externalIsGenerating,
  onSendMessage,
  onStopGeneration,
  onEditMessage,
  onDeleteMessage,
  onRegenerate,
  onContinue,
  selectedModel,
  sessionId,
  branchId,
  className,
}: NativeRoleplayChatProps) {
  const [input, setInput] = useState('');
  const [displayMessages, setDisplayMessages] = useState<DisplayMessage[]>([]);
  const [isGenerating, setIsGenerating] = useState(false);
  const [streamingMessageId, setStreamingMessageId] = useState<string | null>(null);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  // 使用全局共享的 WorldBookManager 单例，确保与 getContext / 生成管线一致
  const worldBookManagerRef = useRef(stWorldBookManager);
  const [activeGroupId, setActiveGroupId] = useState<string | null>(null);
  const [availableGroups, setAvailableGroups] = useState<GroupChat[]>([]);
  const [groupMembers, setGroupMembers] = useState<GroupMember[]>([]);
  const [currentSpeakerId, setCurrentSpeakerId] = useState<string | null>(null);
  const [showGroupPanel, setShowGroupPanel] = useState(false);
  const [showPluginManager, setShowPluginManager] = useState(false);
  // 群组成员 profile 编辑（Task 17）
  const [editingProfileId, setEditingProfileId] = useState<string | null>(null);
  const [profileDraft, setProfileDraft] = useState<{ description: string; personality: string }>({
    description: '',
    personality: '',
  });
  // 世界书扫描结果与扫描状态（Task2）
  const [worldInfoScanResult, setWorldInfoScanResult] = useState<WorldInfoScanResult | null>(null);
  const [isScanning, setIsScanning] = useState(false);

  // 斜杠命令上下文（Task1）：仅提供安全可用的回调，不引入新依赖
  const commandContext = useMemo<CommandContext>(() => ({
    clearMessages: () => {
      messageManager.clearMessages();
      setDisplayMessages([]);
    },
    getCurrentModel: () => selectedModel || 'unknown',
    getAvailableModels: () => [],
    getHelp: (commandName?: string) => SlashCommandEngine.getHelp(commandName),
  }), [selectedModel]);

  // 斜杠命令输入 hook（Task1）
  const {
    completions,
    showCompletions,
    selectedCompletion,
    handleInputChange,
    selectCompletion,
    applyCompletion,
    isCommand,
    executeCommand,
    handleKeyDown: handleSlashKeyDown,
  } = useSlashCommandInput({
    context: commandContext,
    enableCompletion: true,
    onCommandExecuted: (result) => {
      if (result.success) {
        if (result.output) {
          toast.success(result.output, { duration: 4000 });
        }
      } else {
        toast.error(result.output || '命令执行失败', { duration: 5000 });
      }
    },
  });

  useEffect(() => {
    initRegisterMacros();
  }, []);

  useEffect(() => {
    if (session?.id) {
      variableManager.setSessionId(session.id);
      messageManager.setSession(session.id, character.id);
    }
  }, [session?.id, character.id]);

  // 角色变化时加载角色关联的世界书到全局单例管理器，
  // 确保 getContext / 生成管线 / NativeRoleplayChat 共享同一世界书状态
  useEffect(() => {
    if (!character?.id) return;
    loadCharacterWorldBooks(character.id).catch(e => {
      console.warn('[NativeRoleplayChat] 加载角色世界书失败:', e);
    });
  }, [character?.id]);

  useEffect(() => {
    if (activeGroupId) {
      groupChatManager.setActiveGroup(activeGroupId);
      const group = groupChatManager.getGroup(activeGroupId);
      setGroupMembers(group?.members ?? []);
      // 默认设置第一个非静音成员为当前发言者
      const firstActive = group?.members.find(m => !m.isMuted && !m.isDisabled);
      setCurrentSpeakerId(firstActive?.characterId ?? null);

      // 从后端加载群聊消息记录
      groupChatManager.loadGroupMessages(activeGroupId).then(messages => {
        if (messages.length > 0) {
          // 将群聊消息同步到 messageManager
          const chatMessages = messages.map(m => ({
            id: m.id,
            name: m.name,
            mes: m.content,
            is_user: m.isUser,
            is_system: false,
            send_date: m.createdAt,
            swipes: m.swipes || [m.content],
            swipe_id: m.swipeId ?? 0,
            swipe_info: [{ send_date: m.createdAt, extra: { characterId: m.characterId } }],
            extra: { ...m.extra, characterId: m.characterId, groupId: activeGroupId },
          }));
          messageManager.setMessages(chatMessages, true);
        }
      }).catch(e => {
        console.warn('[NativeRoleplayChat] 加载群聊消息失败:', e);
      });
    } else {
      groupChatManager.setActiveGroup(null);
      setGroupMembers([]);
      setCurrentSpeakerId(null);
    }
  }, [activeGroupId]);

  // 加载可用群组列表（从后端同步 + 包含当前角色的群组）
  useEffect(() => {
    // 先从后端同步群组
    groupChatManager.syncFromBackend().then(() => {
      const allGroups = groupChatManager.getAllGroups();
      // 过滤包含当前角色的群组
      const related = allGroups.filter(g =>
        g.members.some(m => m.characterId === character.id)
      );
      setAvailableGroups(related);
    }).catch(() => {
      // 后端同步失败，使用内存中的群组
      const allGroups = groupChatManager.getAllGroups();
      const related = allGroups.filter(g =>
        g.members.some(m => m.characterId === character.id)
      );
      setAvailableGroups(related);
    });
  }, [character.id]);

  useEffect(() => {
    const stMessages = toStMessages(messages);
    messageManager.setMessages(stMessages, true);

    const converted: DisplayMessage[] = stMessages.map((msg) => ({
      id: String(msg.id),
      content: processMessageContent(msg.mes, msg.is_user, msg.is_system),
      role: msg.is_system ? 'system' : msg.is_user ? 'user' : 'assistant',
      name: msg.is_user ? user.username : (msg.is_system ? 'System' : character.name),
      timestamp: String(msg.send_date || new Date().toISOString()),
      isUser: msg.is_user,
      isSystem: !!msg.is_system,
      swipes: msg.swipes || [msg.mes],
      swipeId: msg.swipe_id ?? 0,
      isStreaming: false,
    }));
    setDisplayMessages(converted);
  }, [messages, user.username, character.name]);

  useEffect(() => {
    const unsub = messageManager.onMessage((event) => {
      if (event.type === 'added' && event.message) {
        const msg = event.message;
        setDisplayMessages(prev => [...prev, {
          id: String(msg.id),
          content: processMessageContent(msg.mes, msg.is_user, msg.is_system),
          role: msg.is_system ? 'system' : msg.is_user ? 'user' : 'assistant',
          name: msg.is_user ? user.username : (msg.is_system ? 'System' : character.name),
          timestamp: String(msg.send_date || new Date().toISOString()),
          isUser: msg.is_user,
          isSystem: !!msg.is_system,
          swipes: msg.swipes || [msg.mes],
          swipeId: msg.swipe_id ?? 0,
          isStreaming: false,
        }]);
      } else if (event.type === 'updated' && event.message) {
        const msg = event.message;
        setDisplayMessages(prev => prev.map(d =>
          d.id === String(msg.id)
            ? {
                ...d,
                content: processMessageContent(msg.mes, msg.is_user, msg.is_system),
                swipes: msg.swipes || [msg.mes],
                swipeId: msg.swipe_id ?? 0,
              }
            : d
        ));
      } else if (event.type === 'deleted') {
        // deleted 事件携带被删消息对象（message.messageId 不存在，原实现过滤恒不生效）
        setDisplayMessages(prev => prev.filter(d => d.id !== String(event.message?.id)));
      }
    });

    const unsubGen = generationEngine.onStateChange((state) => {
      setIsGenerating(state.isGenerating);
    });

    return () => {
      unsub();
      unsubGen();
    };
  }, [user.username, character.name]);

  useEffect(() => {
    if (displayMessages.length > 0) {
      messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
    }
  }, [displayMessages]);

  // 消息内容处理：作为 formatMessage 的薄包装，统一走 ST messageFormatting 管线
  // - AI 消息：完整管线（正则 + 宏替换 + Markdown + DOMPurify 消毒）
  // - 用户/系统消息：跳过正则，保留宏替换和 Markdown
  const processMessageContent = useCallback((content: string, isUser?: boolean, isSystem?: boolean): string => {
    // 提取三层正则脚本（用于 formatMessage 的正则管线）
    // GLOBAL → SCOPED → PRESET，与 sillyTavernDisplayPipeline 保持一致
    const globalScripts = getCachedGlobalRegexScripts();
    const scopedScripts = character.extensions
      ? normalizeRegexScriptList(character.extensions)
      : [];
    const presetScripts = character.preset_data
      ? normalizeRegexScriptList(character.preset_data)
      : [];

    // 富宏替换钩子：保留 character.description/personality/scenario 等富宏上下文
    // formatMessage 内部会在正则之后再做一次基础宏替换（{{user}}/{{char}} 等），
    // 此钩子补充 formatMessage 不支持的富宏（如 {{char.description}}、{{getvar::x}}）
    const richMacroHook = (text: string): string => {
      return evaluateMacros(text, {
        names: {
          user: user.username,
          char: character.name,
          group: '',
          groupNotMuted: '',
          notChar: user.username,
        },
        character: {
          description: character.description,
          personality: character.personality,
          scenario: character.scenario,
          firstMessage: character.first_mes,
        },
        system: {
          model: selectedModel || '',
        },
        extra: {
          getVariable: (scope: 'local' | 'global', name: string) => {
            return scope === 'local'
              ? variableManager.local.get(name)
              : variableManager.global.get(name);
          },
          setVariable: (scope: 'local' | 'global', name: string, value: string) => {
            if (scope === 'local') {
              variableManager.local.set(name, value);
            } else {
              variableManager.global.set(name, value);
            }
          },
        },
      });
    };

    // AI 消息执行正则脚本（MD_DISPLAY），用户消息执行 USER_OUTPUT 正则，系统消息跳过正则
    const isAiMessage = !isUser && !isSystem;
    const shouldRunRegex = !isSystem; // AI + 用户消息均执行正则

    // AI 消息中若包含智能卡片（<palink-html>/```html/完整 HTML 文档/含 script/on* 事件），
    // 完全跳过消毒（iframe 沙箱自行消毒）。普通 HTML 片段（div/span/table 等）走完整管线。
    const isCardHtml = isAiMessage && looksLikeSmartCardHtml(content || '');

    return formatMessage(
      content || '',
      {
        characterName: character.name,
        // 用户/系统消息标记为 isUser 以跳过名称前缀剥离
        isUser: !!isUser || !!isSystem,
        userName: user.username,
        modelName: selectedModel || '',
      },
      {
        runRegex: shouldRunRegex,
        // AI 消息使用 AI_OUTPUT（与 ST 1.18.0 script.js L1792 及主路径 sillyTavernDisplayPipeline 对齐）
        regexPlacement: isAiMessage ? regex_placement.AI_OUTPUT : regex_placement.USER_OUTPUT,
        regexParams: shouldRunRegex ? {
          globalScripts,
          scopedScripts,
          presetScripts,
          isMarkdown: true,
          characterName: character.name,
          userName: user.username,
        } : undefined,
        beforeRegexHooks: [richMacroHook],
        skipSanitize: isCardHtml,
      },
    );
  }, [user.username, character, selectedModel]);

  // 群聊生成流程：选择发言者并生成回复
  const generateGroupReply = useCallback(async (userContent: string) => {
    if (!activeGroupId) return;
    const group = groupChatManager.getGroup(activeGroupId);
    if (!group) return;

    // 将现有消息转换为 GroupChatMessage 格式
    const groupMessages: import('@/lib/group-chat/types').GroupChatMessage[] = displayMessages.map(m => ({
      id: m.id,
      content: m.content,
      role: m.role,
      name: m.name,
      isUser: m.isUser,
      createdAt: m.timestamp,
    }));

    // 添加刚发送的用户消息
    groupMessages.push({
      id: Date.now().toString(),
      content: userContent,
      role: 'user',
      name: user.username,
      isUser: true,
      createdAt: new Date().toISOString(),
    });

    // 找到最后一个发言的群组成员
    const lastAssistantMsg = [...groupMessages].reverse().find(m => !m.isUser && m.characterId);
    const lastSpeaker = lastAssistantMsg?.characterId
      ? group.members.find(m => m.characterId === lastAssistantMsg.characterId)
      : undefined;

    // 选择下一个发言者
    let speaker = groupChatManager.selectNextSpeaker(activeGroupId, groupMessages, lastSpeaker);

    // Manual 策略下使用用户选择的发言者
    if (group.activationStrategy === 2 /* MANUAL */ && currentSpeakerId) {
      speaker = group.members.find(m => m.characterId === currentSpeakerId) ?? speaker;
    }

    if (!speaker) {
      console.warn('[GroupChat] 没有可用的发言者');
      return;
    }

    // 更新当前发言者
    setCurrentSpeakerId(speaker.characterId);

    // 触发群聊生成事件
    emitEvent('group:generationStarted', { groupId: activeGroupId });

    try {
      // 为发言者生成回复
      const prompt = `[${speaker.name}]: ${userContent}`;
      const result = await generationEngine.generateQuietPrompt(prompt, {
        characterId: speaker.characterId,
        characterName: speaker.name,
      } as any);

      if (result) {
        // 添加群聊回复消息
        const replyMsg: import('@/lib/group-chat/types').GroupChatMessage = {
          id: `${Date.now()}-${speaker.characterId}`,
          content: result,
          role: 'assistant',
          name: speaker.name,
          characterId: speaker.characterId,
          isUser: false,
          createdAt: new Date().toISOString(),
        };

        // 通过 messageManager 添加消息
        messageManager.addMessage({
          id: replyMsg.id,
          name: replyMsg.name,
          mes: replyMsg.content,
          is_user: false,
          is_system: false,
          send_date: replyMsg.createdAt,
          swipes: [replyMsg.content],
          swipe_id: 0,
          swipe_info: [{ send_date: replyMsg.createdAt, extra: { characterId: speaker.characterId } }],
          extra: { characterId: speaker.characterId, groupId: activeGroupId },
        });

        emitEvent('group:messageReceived', { groupId: activeGroupId, messageId: replyMsg.id });
      }
    } catch (error) {
      console.error('[GroupChat] 生成回复失败:', error);
    } finally {
      emitEvent('group:generationEnded', { groupId: activeGroupId });
    }
  }, [activeGroupId, displayMessages, currentSpeakerId, user.username]);

  const runWorldInfoScan = useCallback(async () => {
    // Task2: 世界书扫描并存储结果（供发送消息与面板「扫描」按钮共用）
    const worldBookManager = worldBookManagerRef.current;
    const scanContext = {
      messages: messages.map(m => m.content || ''),
      personaDescription: '',
      characterDescription: character.description || '',
      characterPersonality: character.personality || '',
      characterDepthPrompt: '',
      scenario: character.scenario || '',
      creatorNotes: '',
    };

    setIsScanning(true);
    try {
      // scanAndBuildContext 返回注入文本，接收并注入到对话上下文（通过 extension prompt）
      const injectedWorldInfo = worldBookManager.scanAndBuildContext(scanContext, messages.length);
      // 将世界书注入内容作为 extension prompt 提供给生成管线，确保生成时使用
      if (injectedWorldInfo) {
        promptInjection.setExtensionPrompt('world_info', injectedWorldInfo, INJECTION_POSITION.IN_CHAT, 4);
      } else {
        promptInjection.setExtensionPrompt('world_info', '', INJECTION_POSITION.IN_CHAT, 4);
      }
      // 额外调用 previewScan 获取结构化数据用于面板展示
      const preview = worldBookManager.previewScan(scanContext, messages.length);
      const budgetMax = worldBookManager.getConfig().budget?.maxTokens ?? 16000;
      setWorldInfoScanResult({
        entries: preview.entries,
        totalTokens: preview.totalTokens,
        budgetMax,
      });
    } catch (error) {
      console.warn('[NativeRoleplayChat] 世界书扫描失败:', error);
    } finally {
      setIsScanning(false);
    }
  }, [messages, character]);

  const handleSend = useCallback(async () => {
    if (!input.trim() || isGenerating) return;

    const content = input.trim();

    // Task1: 命令路由 - 以 / 开头走斜杠命令引擎，不作为消息发送
    if (isCommand(content)) {
      setInput('');
      try {
        await executeCommand(content);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        toast.error(`命令执行失败: ${message}`, { duration: 5000 });
      }
      return;
    }

    setInput('');

    // Task2: 世界书扫描并存储结果
    await runWorldInfoScan();

    emitEvent('message:sent', {
      sessionId: session?.id || '',
      messageId: Date.now().toString(),
      content,
    });

    if (activeGroupId) {
      // 群聊模式：发送用户消息后触发群聊生成流程
      await onSendMessage(content);
      await generateGroupReply(content);
    } else {
      // 单聊模式：正常发送
      await onSendMessage(content);
    }
  }, [input, isGenerating, session?.id, onSendMessage, messages, character, activeGroupId, generateGroupReply, isCommand, executeCommand, runWorldInfoScan]);

  const handleKeyDown = useCallback((e: React.KeyboardEvent) => {
    // Task 14: 快捷键系统优先匹配 Ctrl 系列组合键（重新生成/继续生成）。
    // 仅拦截含 Ctrl 的组合，避免影响 Enter（发送）/ Shift+Enter（换行）现有行为。
    const shortcutMatch = chatShortcutManager.matchEvent(e.nativeEvent);
    if (shortcutMatch && shortcutMatch.ctrl) {
      e.preventDefault();
      shortcutMatch.handler(e.nativeEvent);
      return;
    }

    // Task1: 先让斜杠命令 hook 处理补全导航（Tab/方向键/Esc）
    const newInput = handleSlashKeyDown(e, input);
    if (newInput !== null) {
      setInput(newInput);
      return;
    }

    // Task1: 补全列表显示时，Enter 选中当前补全项填充到输入框
    if (e.key === 'Enter' && !e.shiftKey && showCompletions && completions.length > 0) {
      e.preventDefault();
      const completion = completions[selectedCompletion];
      if (completion) {
        setInput(applyCompletion(input, completion));
      }
      return;
    }

    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  }, [handleSlashKeyDown, input, showCompletions, completions, selectedCompletion, applyCompletion, handleSend]);

  // Task1: 输入框变化时同步到斜杠命令补全
  const handleTextareaChange = useCallback((e: React.ChangeEvent<HTMLTextAreaElement>) => {
    const value = e.target.value;
    setInput(value);
    handleInputChange(value, e.target.selectionStart ?? value.length);
    // ST 兼容：把真实输入框变化同步到虚拟 #send_textarea（供 ST 插件读取）
    window.dispatchEvent(new CustomEvent('palink:input_draft_changed', { detail: { content: value } }));
  }, [handleInputChange]);

  // STT: 语音转录文本追加到输入框末尾（保留已有内容，避免覆盖用户已输入）
  const handleTranscript = useCallback((text: string) => {
    if (!text) return;
    setInput(prev => {
      if (!prev) return text;
      const sep = /\s$/.test(prev) ? '' : ' ';
      return prev + sep + text;
    });
  }, []);

  const handlePushToTalkError = useCallback((message: string) => {
    toast.error(message, { duration: 4000 });
  }, []);

  const handleSwipe = useCallback((messageId: string, direction: 'next' | 'prev') => {
    messageManager.swipe({ messageId, direction });
  }, []);

  const handleRegenerate = useCallback(async () => {
    if (onRegenerate) {
      const lastAssistantIdx = displayMessages.findLastIndex(m => !m.isUser && !m.isSystem);
      if (lastAssistantIdx >= 0) {
        await onRegenerate(lastAssistantIdx);
      }
    }
  }, [onRegenerate, displayMessages]);

  // Task 20/21: Continue generation — appends "Continue where you left off."
  // as a hidden continuation prompt via onContinue (wired to handleSendMessage
  // with suppressUserMessage). The AI sees the last AI message in history and
  // continues from where it left off without repeating existing content.
  const handleContinue = useCallback(async () => {
    if (!onContinue || isGenerating) return;
    // Only continue if the last message is an AI message with content
    const lastMsg = displayMessages[displayMessages.length - 1];
    if (!lastMsg || lastMsg.isUser || lastMsg.isSystem || !lastMsg.content?.trim()) return;
    await onContinue();
  }, [onContinue, isGenerating, displayMessages]);

  // Task 20: Listen for /continue slash command via global window event
  useEffect(() => {
    const onSlashContinue = () => {
      handleContinue().catch(e => {
        console.error('[NativeRoleplayChat] /continue failed:', e);
      });
    };
    window.addEventListener('slash:continue', onSlashContinue);
    return () => window.removeEventListener('slash:continue', onSlashContinue);
  }, [handleContinue]);

  // Task 14: 注册 Ctrl+Enter（重新生成）/ Ctrl+Shift+Enter（继续生成）快捷键。
  // handler 依赖组件回调，回调变化时重新注册以保证不持有过期闭包。
  useEffect(() => {
    chatShortcutManager.unregister('chat.regenerate');
    chatShortcutManager.register({
      id: 'chat.regenerate',
      key: 'enter',
      ctrl: true,
      description: '重新生成',
      handler: () => {
        handleRegenerate().catch(e => {
          console.error('[NativeRoleplayChat] regenerate shortcut failed:', e);
        });
      },
    });
    chatShortcutManager.unregister('chat.continue');
    chatShortcutManager.register({
      id: 'chat.continue',
      key: 'enter',
      ctrl: true,
      shift: true,
      description: '继续生成',
      handler: () => {
        handleContinue().catch(e => {
          console.error('[NativeRoleplayChat] continue shortcut failed:', e);
        });
      },
    });
    return () => {
      chatShortcutManager.unregister('chat.regenerate');
      chatShortcutManager.unregister('chat.continue');
    };
  }, [handleRegenerate, handleContinue]);

  const handleDelete = useCallback(async (messageId: string) => {
    await onDeleteMessage(messageId);
  }, [onDeleteMessage]);

  const handleEdit = useCallback(async (messageId: string, newContent: string) => {
    await onEditMessage(messageId, newContent);
  }, [onEditMessage]);

  // 根据消息查找群聊发言者（群聊模式下使用）
  const findMessageSpeaker = useCallback((msg: DisplayMessage): GroupMember | undefined => {
    if (!activeGroupId) return undefined;
    // 用户消息不查找
    if (msg.isUser || msg.isSystem) return undefined;
    // 通过名称匹配群组成员
    return groupMembers.find(m => m.name === msg.name);
  }, [activeGroupId, groupMembers]);

  // 获取成员头像首字母
  const getMemberInitial = useCallback((name: string): string => {
    return (name || '?').charAt(0).toUpperCase();
  }, []);

  // 获取成员头像背景色（基于名称哈希）
  const getMemberColor = useCallback((name: string): string => {
    const colors = [
      'bg-blue-500', 'bg-green-500', 'bg-purple-500', 'bg-pink-500',
      'bg-orange-500', 'bg-teal-500', 'bg-indigo-500', 'bg-red-500',
    ];
    let hash = 0;
    for (let i = 0; i < name.length; i++) {
      hash = name.charCodeAt(i) + ((hash << 5) - hash);
    }
    return colors[Math.abs(hash) % colors.length];
  }, []);

  // 切换群组
  const handleSelectGroup = useCallback((groupId: string | null) => {
    setActiveGroupId(groupId);
    setShowGroupPanel(false);
  }, []);

  // 选择当前发言者（Manual策略）
  const handleSelectSpeaker = useCallback((characterId: string) => {
    setCurrentSpeakerId(characterId);
  }, []);

  // ============================================================
  // 群组成员 profile 编辑（Task 17）
  // ============================================================

  // 打开 profile 编辑表单：用当前成员的 profile 初始化草稿
  const handleOpenProfileEditor = useCallback((characterId: string) => {
    const member = groupMembers.find(m => m.characterId === characterId);
    const group = activeGroupId ? groupChatManager.getGroup(activeGroupId) : null;
    const existing = member?.profile ?? group?.memberProfiles?.[characterId];
    setProfileDraft({
      description: existing?.description ?? '',
      personality: existing?.personality ?? '',
    });
    setEditingProfileId(characterId);
  }, [groupMembers, activeGroupId]);

  const handleCloseProfileEditor = useCallback(() => {
    setEditingProfileId(null);
  }, []);

  // 保存 profile：写入 groupChatManager 并持久化到后端
  const handleSaveProfile = useCallback(async (characterId: string) => {
    if (!activeGroupId) return;
    const group = groupChatManager.getGroup(activeGroupId);
    if (!group) return;

    const member = group.members.find(m => m.characterId === characterId);
    const hasContent = profileDraft.description.trim() || profileDraft.personality.trim();
    const newProfile = hasContent
      ? {
          description: profileDraft.description.trim() || undefined,
          personality: profileDraft.personality.trim() || undefined,
        }
      : undefined;

    // 更新内存中的成员 profile
    if (member) {
      groupChatManager.updateMember(activeGroupId, characterId, { profile: newProfile });
    }
    // 同步 memberProfiles 映射（即使成员不在 members 列表也保留映射）
    const nextProfiles = { ...(group.memberProfiles || {}) };
    if (newProfile) {
      nextProfiles[characterId] = newProfile;
    } else {
      delete nextProfiles[characterId];
    }
    groupChatManager.updateGroup(activeGroupId, { memberProfiles: nextProfiles });

    // 刷新本地 members 状态以反映 profile 变化
    const refreshed = groupChatManager.getGroup(activeGroupId);
    if (refreshed) {
      setGroupMembers([...refreshed.members]);
    }

    try {
      await groupChatManager.persistGroup(activeGroupId);
      toast.success('成员 profile 已保存');
    } catch (error) {
      console.warn('[NativeRoleplayChat] 保存成员 profile 失败:', error);
      toast.error('保存 profile 失败');
    }
    setEditingProfileId(null);
  }, [activeGroupId, profileDraft]);

  const renderMessage = useCallback((msg: DisplayMessage, idx: number) => {
    const hasSwipes = msg.swipes && msg.swipes.length > 1;
    const isLastAssistant = !msg.isUser && !msg.isSystem && idx === displayMessages.length - 1;
    const speaker = findMessageSpeaker(msg);
    const isGroupMode = !!activeGroupId && !msg.isUser && !msg.isSystem;
    const isCurrentSpeaker = speaker && speaker.characterId === currentSpeakerId;

    return (
      <div
        key={msg.id}
        className={`flex ${msg.isUser ? 'justify-end' : 'justify-start'} mb-4 group`}
      >
        {/* 群聊模式下显示发言者头像 */}
        {isGroupMode && speaker && (
          <div
            className={`flex-shrink-0 w-8 h-8 rounded-full flex items-center justify-center text-white text-xs font-bold mr-2 mt-1 ${getMemberColor(speaker.name)} ${isCurrentSpeaker ? 'ring-2 ring-primary ring-offset-2' : ''}`}
            title={speaker.name}
          >
            {speaker.avatar ? (
              <img src={speaker.avatar} alt={speaker.name} className="w-full h-full rounded-full object-cover" />
            ) : (
              getMemberInitial(speaker.name)
            )}
          </div>
        )}
        <div
          className={`${
            looksLikeRenderableCardHtml(msg.content) && !msg.isUser && !msg.isSystem
              ? 'w-full' // 角色卡 HTML：无气泡背景，让卡片自身控制样式
              : 'max-w-[70%] rounded-2xl px-4 py-2 relative ' + (
                msg.isSystem
                  ? 'bg-muted text-muted-foreground'
                  : msg.isUser
                    ? 'text-white'
                    : isGroupMode && speaker
                      ? 'text-secondary-foreground border-l-4 ' + (isCurrentSpeaker ? 'border-primary' : 'border-transparent')
                      : 'text-secondary-foreground'
              )
          }`}
          style={
            looksLikeRenderableCardHtml(msg.content) && !msg.isUser && !msg.isSystem
              ? undefined
              : msg.isSystem
                ? undefined
                : msg.isUser
                  ? { backgroundColor: 'var(--rp-color-user-msg)' }
                  : { backgroundColor: 'var(--rp-color-bot-msg)' }
          }
        >
          {!(looksLikeRenderableCardHtml(msg.content) && !msg.isUser && !msg.isSystem) && (
            <div className="text-xs opacity-70 mb-1">
              {isGroupMode && speaker ? (
                <span className="font-semibold" style={{ color: isCurrentSpeaker ? 'var(--primary)' : undefined }}>
                  {speaker.name}
                  {speaker.isMuted && <span className="ml-1 opacity-50">(静音)</span>}
                </span>
              ) : (
                msg.name
              )}
            </div>
          )}
          {(() => {
            // 流式消息：保持 whitespace-pre-wrap 纯文本显示（不经过 formatMessage）
            if (msg.isStreaming) {
              return (
                <div className="whitespace-pre-wrap animate-pulse">
                  {msg.content || '...'}
                </div>
              );
            }
            // 非流式消息：msg.content 已通过 processMessageContent（formatMessage 薄包装）预处理为 HTML
            // 用户/系统消息：formatMessage 轻量处理（跳过正则，保留宏替换），直接渲染 HTML
            if (msg.isUser || msg.isSystem) {
              return (
                <div
                  className="markdown-content"
                  dangerouslySetInnerHTML={{ __html: msg.content || '' }}
                />
              );
            }
            // AI 消息：formatMessage 完整管线处理后，检测是否为可渲染的 HTML 卡片
            // 注意：looksLikeRenderableCardHtml 在 formatMessage 处理后调用，因为正则脚本可能生成 HTML 标签
            if (looksLikeRenderableCardHtml(msg.content)) {
              return (
                <CharacterCardRenderer
                  content={msg.content}
                  className="w-full"
                />
              );
            }
            // 非 HTML AI 消息：渲染 formatMessage 输出的 HTML
            return (
              <div
                className="markdown-content"
                dangerouslySetInnerHTML={{ __html: msg.content || '' }}
              />
            );
          })()}

          {hasSwipes && !msg.isStreaming && (
            <div className="flex items-center gap-1 mt-1 opacity-0 group-hover:opacity-100 transition-opacity">
              <button
                onClick={() => handleSwipe(msg.id, 'prev')}
                className="text-xs px-1 opacity-60 hover:opacity-100"
                disabled={msg.swipeId <= 0}
              >
                ◀
              </button>
              <span className="text-xs opacity-60">
                {msg.swipeId + 1}/{msg.swipes.length}
              </span>
              <button
                onClick={() => handleSwipe(msg.id, 'next')}
                className="text-xs px-1 opacity-60 hover:opacity-100"
                disabled={msg.swipeId >= msg.swipes.length - 1}
              >
                ▶
              </button>
            </div>
          )}

          {!msg.isStreaming && !msg.isSystem && (
            <div className="absolute -right-2 top-1/2 -translate-y-1/2 opacity-0 group-hover:opacity-100 transition-opacity flex flex-col gap-1">
              {!msg.isUser && isLastAssistant && onRegenerate && (
                <button
                  onClick={handleRegenerate}
                  className="w-6 h-6 rounded-full bg-muted text-muted-foreground text-xs flex items-center justify-center hover:bg-accent"
                  title="重新生成"
                >
                  ↻
                </button>
              )}
              <button
                onClick={() => handleDelete(msg.id)}
                className="w-6 h-6 rounded-full bg-muted text-muted-foreground text-xs flex items-center justify-center hover:bg-destructive hover:text-destructive-foreground"
                title="删除"
              >
                ✕
              </button>
            </div>
          )}
        </div>
      </div>
    );
  }, [displayMessages, handleSwipe, handleRegenerate, handleDelete, onRegenerate, findMessageSpeaker, getMemberColor, getMemberInitial, activeGroupId, currentSpeakerId]);

  return (
    <div className={`flex flex-col h-full roleplay-container ${className || ''}`}>
      {/* 群组选择栏 */}
      {availableGroups.length > 0 && (
        <div className="border-b border-border bg-background/50 px-4 py-2 flex items-center gap-2">
          <button
            onClick={() => setShowGroupPanel(!showGroupPanel)}
            className="text-xs px-2 py-1 rounded-md bg-secondary text-secondary-foreground hover:bg-accent flex items-center gap-1"
            title="群组设置"
          >
            <span>👥</span>
            <span>{activeGroupId ? groupChatManager.getGroup(activeGroupId)?.name || '群聊' : '单聊'}</span>
            <span className="opacity-60">▼</span>
          </button>
          {activeGroupId && (
            <button
              onClick={() => handleSelectGroup(null)}
              className="text-xs px-2 py-1 rounded-md hover:bg-accent text-muted-foreground"
              title="退出群聊"
            >
              ✕
            </button>
          )}
          {activeGroupId && currentSpeakerId && (
            <span className="text-xs text-muted-foreground">
              当前发言者: <span className="font-semibold text-foreground">{groupMembers.find(m => m.characterId === currentSpeakerId)?.name || '-'}</span>
            </span>
          )}
          <button
            onClick={() => setShowPluginManager(true)}
            className="text-xs px-2 py-1 rounded-md bg-secondary text-secondary-foreground hover:bg-accent ml-auto"
            title="插件管理"
          >
            🧩 插件
          </button>
        </div>
      )}

      {/* 当没有群组时，仍然显示插件管理按钮 */}
      {availableGroups.length === 0 && (
        <div className="border-b border-border bg-background/50 px-4 py-1 flex justify-end">
          <button
            onClick={() => setShowPluginManager(true)}
            className="text-xs px-2 py-1 rounded-md bg-secondary text-secondary-foreground hover:bg-accent"
            title="插件管理"
          >
            🧩 插件
          </button>
        </div>
      )}

      {/* 插件管理器弹窗 */}
      <PluginManager
        open={showPluginManager}
        onClose={() => setShowPluginManager(false)}
      />

      {/* 群组成员面板（可折叠） */}
      {showGroupPanel && availableGroups.length > 0 && (
        <div className="border-b border-border bg-muted/30 p-3 space-y-3">
          <div>
            <div className="text-xs font-semibold mb-2 text-muted-foreground">选择群组</div>
            <div className="flex flex-wrap gap-1">
              <button
                onClick={() => handleSelectGroup(null)}
                className={`text-xs px-2 py-1 rounded-md ${!activeGroupId ? 'bg-primary text-primary-foreground' : 'bg-secondary text-secondary-foreground hover:bg-accent'}`}
              >
                单聊模式
              </button>
              {availableGroups.map(g => (
                <button
                  key={g.id}
                  onClick={() => handleSelectGroup(g.id)}
                  className={`text-xs px-2 py-1 rounded-md ${activeGroupId === g.id ? 'bg-primary text-primary-foreground' : 'bg-secondary text-secondary-foreground hover:bg-accent'}`}
                  title={g.description}
                >
                  {g.name} ({g.members.length})
                </button>
              ))}
            </div>
          </div>
          {activeGroupId && groupMembers.length > 0 && (
            <div>
              <div className="text-xs font-semibold mb-2 text-muted-foreground">群组成员（点击选择发言者）</div>
              <div className="flex flex-wrap gap-1">
                {groupMembers.map(m => (
                  <div key={m.characterId} className="flex items-center gap-1">
                    <button
                      onClick={() => handleSelectSpeaker(m.characterId)}
                      disabled={m.isMuted || m.isDisabled}
                      className={`flex items-center gap-1 text-xs px-2 py-1 rounded-md ${
                        currentSpeakerId === m.characterId
                          ? 'bg-primary text-primary-foreground'
                          : m.isMuted || m.isDisabled
                            ? 'bg-muted text-muted-foreground/50 cursor-not-allowed'
                            : 'bg-secondary text-secondary-foreground hover:bg-accent'
                      }`}
                      title={m.isMuted ? '已静音' : m.isDisabled ? '已禁用' : `概率: ${m.probability}%`}
                    >
                      <span className={`w-4 h-4 rounded-full flex items-center justify-center text-[8px] font-bold ${getMemberColor(m.name)}`}>
                        {getMemberInitial(m.name)}
                      </span>
                      <span>{m.name}</span>
                      {m.isMuted && <span className="opacity-50">🔇</span>}
                      {m.profile && (m.profile.description || m.profile.personality) && (
                        <span className="opacity-70" title="已设置群组 profile">📝</span>
                      )}
                    </button>
                    <button
                      onClick={() => handleOpenProfileEditor(m.characterId)}
                      className={`text-xs px-1.5 py-1 rounded-md ${
                        editingProfileId === m.characterId
                          ? 'bg-accent text-accent-foreground'
                          : 'bg-secondary/60 text-muted-foreground hover:bg-accent'
                      }`}
                      title="编辑群组 profile"
                    >
                      {editingProfileId === m.characterId ? '✕' : '⚙'}
                    </button>
                  </div>
                ))}
              </div>
              {/* Profile 编辑表单（仅当 editingProfileId 匹配某成员时显示） */}
              {editingProfileId && groupMembers.some(m => m.characterId === editingProfileId) && (
                <div className="mt-2 p-2 rounded-md border border-border bg-background/60 space-y-2">
                  <div className="text-xs font-semibold text-muted-foreground">
                    编辑「{groupMembers.find(m => m.characterId === editingProfileId)?.name || '成员'}」的群组 profile
                  </div>
                  <div className="text-[10px] text-muted-foreground/80">
                    群聊提示词中将以该 profile 区分各成员身份。留空则使用角色卡默认值。
                  </div>
                  <div>
                    <label className="block text-[10px] text-muted-foreground mb-1">描述（description）</label>
                    <textarea
                      value={profileDraft.description}
                      onChange={e => setProfileDraft(prev => ({ ...prev, description: e.target.value }))}
                      placeholder="例如：在群聊中她是个开朗的女孩，常主动挑起话题。"
                      rows={3}
                      className="w-full text-xs px-2 py-1 rounded-md bg-background border border-border resize-y"
                    />
                  </div>
                  <div>
                    <label className="block text-[10px] text-muted-foreground mb-1">个性（personality）</label>
                    <textarea
                      value={profileDraft.personality}
                      onChange={e => setProfileDraft(prev => ({ ...prev, personality: e.target.value }))}
                      placeholder="例如：活泼、好奇、爱开玩笑。"
                      rows={2}
                      className="w-full text-xs px-2 py-1 rounded-md bg-background border border-border resize-y"
                    />
                  </div>
                  <div className="flex justify-end gap-1">
                    <button
                      onClick={handleCloseProfileEditor}
                      className="text-xs px-2 py-1 rounded-md bg-secondary text-secondary-foreground hover:bg-accent"
                    >
                      取消
                    </button>
                    <button
                      onClick={() => handleSaveProfile(editingProfileId)}
                      className="text-xs px-2 py-1 rounded-md bg-primary text-primary-foreground hover:bg-primary/90"
                    >
                      保存
                    </button>
                  </div>
                </div>
              )}
            </div>
          )}
        </div>
      )}

      <div className="flex-1 overflow-y-auto p-4" style={{ backgroundColor: 'var(--rp-color-chat-bg)' }}>
        {displayMessages.map((msg, idx) => renderMessage(msg, idx))}
        <div ref={messagesEndRef} />
      </div>

      {/* Task2: 世界书扫描结果面板 */}
      <WorldInfoScanPanel
        scanResult={worldInfoScanResult}
        isScanning={isScanning}
        onScan={runWorldInfoScan}
        className="mx-4 mb-2"
      />

      <div className="border-t border-border p-4">
        {/* Task 21: Continue button — floating glass style, shown only when the
            last message is an AI message with content and not currently generating */}
        {(() => {
          const lastMsg = displayMessages[displayMessages.length - 1];
          const canContinue = !isGenerating
            && !!onContinue
            && !!lastMsg
            && !lastMsg.isUser
            && !lastMsg.isSystem
            && !!lastMsg.content?.trim();
          if (!canContinue) return null;
          return (
            <div className="flex justify-end mb-2">
              <button
                type="button"
                onClick={() => handleContinue().catch(e => console.error('[NativeRoleplayChat] Continue failed:', e))}
                className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-full text-xs font-medium border border-border bg-background/60 backdrop-blur-md shadow-sm hover:bg-background/80 hover:shadow-md transition-all text-foreground/80 hover:text-foreground"
                title="继续生成"
              >
                <svg
                  xmlns="http://www.w3.org/2000/svg"
                  width="14"
                  height="14"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                >
                  <path d="M5 12h14M12 5l7 7-7 7" />
                </svg>
                <span>继续</span>
              </button>
            </div>
          );
        })()}
        <div className="flex gap-2">
          {/* Task1: 补全下拉列表 + 输入框 */}
          <div className="relative flex-1">
            {showCompletions && completions.length > 0 && (
              <div className="absolute bottom-full left-0 right-0 mb-1 max-h-48 overflow-y-auto rounded-lg border border-border bg-popover text-popover-foreground shadow-lg z-10">
                {completions.map((item, idx) => (
                  <button
                    key={`${item.type}-${item.name}`}
                    type="button"
                    onMouseDown={(e) => {
                      e.preventDefault();
                      const applied = applyCompletion(input, item);
                      setInput(applied);
                    }}
                    onMouseEnter={() => selectCompletion(idx)}
                    className={`w-full text-left px-3 py-1.5 text-xs flex items-center gap-2 ${
                      idx === selectedCompletion
                        ? 'bg-accent text-accent-foreground'
                        : 'hover:bg-accent/50'
                    }`}
                  >
                    <span className="font-mono text-muted-foreground">
                      {item.type === 'command' ? '/' : ''}{item.name}
                    </span>
                    <span className="text-muted-foreground truncate">{item.description}</span>
                  </button>
                ))}
              </div>
            )}
            <QrBar />
            <textarea
              value={input}
              onChange={handleTextareaChange}
              onKeyDown={handleKeyDown}
              placeholder={
                activeGroupId && currentSpeakerId
                  ? `以 ${groupMembers.find(m => m.characterId === currentSpeakerId)?.name || character.name} 身份发送...`
                  : `发送消息给 ${character.name}...`
              }
              disabled={isGenerating}
              className="flex-1 resize-none rounded-xl border border-border bg-background p-3 text-sm focus:outline-none focus:ring-2 focus:ring-primary w-full"
              rows={1}
            />
          </div>
          <PushToTalkButton
            onTranscript={handleTranscript}
            onError={handlePushToTalkError}
            disabled={isGenerating}
            size="default"
            className="rounded-xl px-4 py-2 shrink-0"
            label="按住说话"
          />
          {isGenerating ? (
            <button
              onClick={onStopGeneration}
              className="px-4 py-2 rounded-xl bg-destructive text-destructive-foreground"
            >
              停止
            </button>
          ) : (
            <button
              onClick={handleSend}
              disabled={!input.trim()}
              className="px-4 py-2 rounded-xl bg-primary text-primary-foreground disabled:opacity-50"
            >
              发送
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

export default NativeRoleplayChat;
