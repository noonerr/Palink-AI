import { toast } from 'sonner';
import DOMPurify from 'dompurify';
import { api, invalidateCache } from '@/services/api';
import type { CharacterChatSession, SmartCardCompatDiagnostic } from '@/types';
import type { SmartCardAction } from '@/components/ui/custom/CharacterCardRenderer';
import { popupManager } from '@/lib/popup-system';
import { PopupType } from '@/lib/popup-system/types';

type SmartCardWorldBookEntry = Record<string, any>;

function getSmartCardControllerText() {
  const isEnglish = getCurrentInterfaceIsEnglish();
  return isEnglish
    ? {
        defaultWorldBookName: 'Player custom profile',
        worldBookDescription: 'Palink smart card generated world book',
        noActiveSession: 'Smart card world book needs an active character chat session.',
        noUsableEntries: 'Smart card world book has no usable entries.',
      }
    : {
        defaultWorldBookName: '\u73a9\u5bb6\u81ea\u5b9a\u4e49\u6863\u6848',
        worldBookDescription: 'Palink \u667a\u80fd\u89d2\u8272\u5361\u751f\u6210\u7684\u4e16\u754c\u4e66',
        noActiveSession: '\u667a\u80fd\u89d2\u8272\u5361\u4e16\u754c\u4e66\u9700\u8981\u4e00\u4e2a\u6709\u6548\u7684\u89d2\u8272\u804a\u5929\u4f1a\u8bdd\u3002',
        noUsableEntries: '\u667a\u80fd\u89d2\u8272\u5361\u4e16\u754c\u4e66\u6ca1\u6709\u53ef\u7528\u6761\u76ee\u3002',
      };
}

function getSmartCardControllerCleanText() {
  const isEnglish = getCurrentInterfaceIsEnglish();
  return isEnglish
    ? {
        defaultWorldBookName: 'Player custom profile',
        worldBookDescription: 'Palink smart card generated world book',
        noActiveSession: 'Smart card world book needs an active character chat session.',
        noUsableEntries: 'Smart card world book has no usable entries.',
        unsupportedApi: 'This card needs an unsupported Tavern API:',
        unknownApi: 'unknown API',
        requestTimeout: 'Smart card compatibility request timed out:',
        unknownRequest: 'unknown request',
        warning: 'Smart card compatibility warning',
        userGestureRequired: 'This card action needs a click or keyboard action first.',
      }
    : {
        defaultWorldBookName: '\u73a9\u5bb6\u81ea\u5b9a\u4e49\u6863\u6848',
        worldBookDescription: 'Palink \u667a\u80fd\u89d2\u8272\u5361\u751f\u6210\u7684\u4e16\u754c\u4e66',
        noActiveSession: '\u667a\u80fd\u89d2\u8272\u5361\u4e16\u754c\u4e66\u9700\u8981\u4e00\u4e2a\u6709\u6548\u7684\u89d2\u8272\u804a\u5929\u4f1a\u8bdd\u3002',
        noUsableEntries: '\u667a\u80fd\u89d2\u8272\u5361\u4e16\u754c\u4e66\u6ca1\u6709\u53ef\u7528\u6761\u76ee\u3002',
        unsupportedApi: '\u8fd9\u5f20\u89d2\u8272\u5361\u9700\u8981\u5c1a\u672a\u5b8c\u6574\u652f\u6301\u7684 Tavern API\uff1a',
        unknownApi: '\u672a\u77e5 API',
        requestTimeout: '\u89d2\u8272\u5361\u517c\u5bb9\u8bf7\u6c42\u8d85\u65f6\uff1a',
        unknownRequest: '\u672a\u77e5\u8bf7\u6c42',
        warning: '\u89d2\u8272\u5361\u517c\u5bb9\u5c42\u63d0\u793a',
        userGestureRequired: '\u8fd9\u4e2a\u89d2\u8272\u5361\u52a8\u4f5c\u9700\u8981\u5148\u70b9\u51fb\u5361\u7247\u4e2d\u7684\u6309\u94ae\u6216\u4f7f\u7528\u952e\u76d8\u89e6\u53d1\u3002',
      };
}

const SMART_CARD_MUTATING_ACTIONS_REQUIRING_GESTURE: Set<string> = new Set([
  'sendMessage',
  'sendMessageAsUser',
  'sendUserMessage',
  'triggerGeneration',
  'Generate',
  'generate',
  'generateRaw',
  'generateQuietPrompt',
]);

function smartCardPayloadHasUserGesture(payload: Record<string, unknown>): boolean {
  return payload.__palinkUserGesture === true;
}

function isSmartCardMutatingActionRequiringGesture(action: string): boolean {
  return SMART_CARD_MUTATING_ACTIONS_REQUIRING_GESTURE.has(action);
}

function hasSmartCardDisplayLayerOptions(options: Record<string, unknown> | null | undefined): boolean {
  if (!options || typeof options !== 'object') return false;
  const displayLayerKeys = [
    'extra',
    'display_text',
    'displayText',
    'swipe_info',
    'swipes',
    'swipe_id',
    'swipeId',
    'role',
    'name',
    'is_user',
    'is_system',
    'is_name',
    'force_avatar',
    'forceAvatar',
    'original_avatar',
    'originalAvatar',
    'avatar',
    'gen_id',
    'genId',
    'group_id',
    'groupId',
    'group_name',
    'groupName',
    'selected_group',
    'selectedGroup',
    'groups',
  ];
  return displayLayerKeys.some((key) => (
    Object.prototype.hasOwnProperty.call(options, key)
    && options[key] !== undefined
  ));
}

export interface SmartCardCompatControllerState {
  worldBook: { id: string; name: string; entries: SmartCardWorldBookEntry[] } | null;
  diagnosticToastTimes: Map<string, number>;
}

export interface SmartCardCompatRequestContext {
  selectedCharacterName: string;
  selectedCharacterId?: string | null;
  selectedModel?: string | null;
  selectedSession: CharacterChatSession | null;
  sessionId?: string | null;
  branchId?: string | null;
  wb: any;
  setChatMessage?: (payload: {
    content: string;
    messageId?: string | number | null;
    index?: number;
    options?: Record<string, unknown>;
  }) => void | Promise<void>;
  appendMessage?: (payload: {
    content: string;
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
    swipes?: string[];
    swipe_info?: Array<Record<string, unknown>>;
    extra?: Record<string, unknown>;
    model?: string;
    options?: Record<string, unknown>;
  }) => Promise<unknown>;
  setInputDraft?: (content: string) => void;
  sendMessage?: (
    content: string,
    options?: { awaitResult?: boolean; source?: string },
  ) => Promise<{ success: boolean; content?: string } | void>;
  deleteMessage?: (messageId?: string | number | null, index?: number) => Promise<void> | void;
  clearChat?: () => Promise<void> | void;
  stopGeneration?: () => Promise<void> | void;
  scrollChatToBottom?: () => void;
  refresh?: () => void;
}

function isPlainSmartCardObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

function sanitizeSmartCardExtensionSettings(value: unknown): Record<string, unknown> {
  if (!isPlainSmartCardObject(value)) return {};
  try {
    return JSON.parse(JSON.stringify(value)) as Record<string, unknown>;
  } catch {
    return {};
  }
}

async function saveSmartCardExtensionSettings(payload: Record<string, unknown>) {
  const pluginId = String(payload.pluginId || '').trim();
  const namespace = String(payload.namespace || payload.extensionName || '').trim();
  const settings = sanitizeSmartCardExtensionSettings(payload.settings);
  if (!pluginId || !namespace) {
    return { success: false, reason: 'missing_plugin_or_namespace' };
  }

  const plugin = await api.get<{ config?: Record<string, unknown> | null }>(`/api/plugins/${encodeURIComponent(pluginId)}`);
  const config = isPlainSmartCardObject(plugin.config) ? { ...plugin.config } : {};
  const extensionSettings = isPlainSmartCardObject(config.extension_settings)
    ? { ...config.extension_settings }
    : {};
  extensionSettings[namespace] = settings;
  const nextConfig = {
    ...config,
    settings,
    extension_settings: extensionSettings,
    namespace,
  };
  await api.patch(`/api/plugins/${encodeURIComponent(pluginId)}/config`, { config: nextConfig });
  invalidateCache('/api/plugins');
  invalidateCache('/api/plugins/runtime/config');
  return { success: true, pluginId, namespace };
}

function asStringArray(value: unknown): string[] {
  if (Array.isArray(value)) return value.map((item) => String(item || '').trim()).filter(Boolean);
  if (typeof value === 'string') return value.split(',').map((item) => item.trim()).filter(Boolean);
  return [];
}

function normalizeSmartCardWorldBookPosition(value: unknown): string | number {
  if (typeof value === 'number') return value;
  if (typeof value === 'string') return value;
  if (value && typeof value === 'object') {
    const type = String((value as { type?: unknown }).type || '');
    if (type === 'before_character_definition') return 'before_char';
    if (type === 'after_character_definition') return 'after_char';
    if (type === 'before_example_messages') return 'before_example';
    if (type === 'after_example_messages') return 'after_example';
  }
  return 4;
}

function buildSmartCardWorldBookImport(name: string, entries: SmartCardWorldBookEntry[]) {
  const normalizedEntries = entries.reduce<Record<string, Record<string, unknown>>>((acc, entry, index) => {
    const content = String(entry?.content ?? entry?.text ?? '').trim();
    if (!content) return acc;
    const title = String(entry?.name ?? entry?.comment ?? entry?.title ?? `Entry ${index + 1}`).trim() || `Entry ${index + 1}`;
    const keys = asStringArray(entry?.key ?? entry?.keys ?? entry?.keywords);
    const secondaryKeys = asStringArray(entry?.keysecondary ?? entry?.secondary_keys ?? entry?.secondaryKeys);
    acc[String(index)] = {
      comment: title,
      content,
      disable: entry?.enabled === false || entry?.disable === true,
      constant: typeof entry?.constant === 'boolean'
        ? entry.constant
        : entry?.strategy?.type === 'constant' || keys.length === 0,
      key: keys,
      keysecondary: secondaryKeys,
      order: Number(entry?.order ?? entry?.position?.order ?? index),
      position: normalizeSmartCardWorldBookPosition(entry?.position),
      scanDepth: Number(entry?.scanDepth ?? entry?.scan_depth ?? 4),
      selective: Boolean(entry?.selective),
      probability: Number(entry?.probability ?? 100),
      group: entry?.group ?? undefined,
    };
    return acc;
  }, {});

  return {
    name,
    description: getSmartCardControllerCleanText().worldBookDescription,
    tags: ['smart-card', 'tavern-helper'],
    entries: normalizedEntries,
  };
}

async function createOrReplaceSmartCardWorldBook(
  state: SmartCardCompatControllerState,
  context: SmartCardCompatRequestContext,
  requestedName: unknown,
  requestedEntries: unknown,
) {
  const { selectedCharacterName, selectedSession, sessionId: fallbackSessionId, wb } = context;
  const text = getSmartCardControllerCleanText();
  const resolvedSessionId = selectedSession && selectedSession.id !== '__pending__'
    ? selectedSession.id
    : String(fallbackSessionId || '').trim();
  if (!resolvedSessionId || resolvedSessionId === '__pending__') {
    throw new Error(text.noActiveSession);
  }

  const baseName = String(requestedName || text.defaultWorldBookName).trim() || text.defaultWorldBookName;
  const worldBookName = `${selectedCharacterName} / ${baseName}`;
  const entries = Array.isArray(requestedEntries) ? requestedEntries as SmartCardWorldBookEntry[] : [];
  const importPayload = buildSmartCardWorldBookImport(worldBookName, entries);
  if (Object.keys(importPayload.entries).length === 0) {
    throw new Error(text.noUsableEntries);
  }

  try {
    const existing = await api.get<Array<{ id: string; name: string; tags?: string[] }>>('/api/worldbooks');
    const duplicates = existing.filter((worldBook) => (
      worldBook.name === worldBookName
      && Array.isArray(worldBook.tags)
      && worldBook.tags.includes('smart-card')
    ));
    await Promise.all(duplicates.map((worldBook) => api.delete(`/api/worldbooks/${worldBook.id}`).catch(() => null)));
  } catch (error) {
    console.warn('Failed to clean previous smart card world books:', error);
  }

  const file = new File(
    [JSON.stringify(importPayload, null, 2)],
    `${worldBookName.replace(/[\\/:*?"<>|]+/g, '_')}.json`,
    { type: 'application/json' },
  );
  const formData = new FormData();
  formData.append('file', file);

  const worldBook = await api.post<{ id: string; name: string }>('/api/worldbooks/import', formData);
  state.worldBook = { id: worldBook.id, name: baseName, entries };
  await api.post(`/api/character-sessions/${resolvedSessionId}/worldbook`, {
    world_book_id: worldBook.id,
  });
  await wb.loadSessionStatus?.(resolvedSessionId);
  invalidateCache('worldbook_list');
  return {
    success: true,
    id: worldBook.id,
    name: baseName,
    world_book_id: worldBook.id,
  };
}

function buildSmartCardWorldBookExport(state: SmartCardCompatControllerState) {
  if (!state.worldBook) {
    return {
      success: true,
      id: '',
      name: '',
      world_book_id: '',
      entries: [],
    };
  }

  return {
    success: true,
    id: state.worldBook.id,
    name: state.worldBook.name,
    world_book_id: state.worldBook.id,
    entries: [...state.worldBook.entries],
  };
}

function extractArgsFromPayload(payload: Record<string, unknown>): unknown[] {
  return Array.isArray(payload.args) ? payload.args : [];
}

function extractMessageIdFromPayload(payload: Record<string, unknown>): string | number | null | undefined {
  const message = extractMessageObjectFromPayload(payload);
  return (
    payload.messageId
    ?? payload.message_id
    ?? message.messageId
    ?? message.message_id
    ?? message.id
  ) as string | number | null | undefined;
}

function extractIndexFromPayload(payload: Record<string, unknown>): number | undefined {
  const message = extractMessageObjectFromPayload(payload);
  const args = extractArgsFromPayload(payload);
  const explicit = payload.index ?? payload.mesid ?? message.index ?? message.mesid;
  if (Number.isFinite(Number(explicit))) return Number(explicit);
  const firstNumber = args.find((arg) => Number.isInteger(Number(arg)));
  return Number.isFinite(Number(firstNumber)) ? Number(firstNumber) : undefined;
}

function payloadHasExplicitMessageContent(payload: Record<string, unknown>, apiName = ''): boolean {
  if (
    typeof payload.content === 'string'
    || typeof payload.mes === 'string'
    || typeof payload.message === 'string'
    || typeof payload.text === 'string'
  ) {
    return true;
  }

  const message = extractMessageObjectFromPayload(payload);
  if (
    typeof message.content === 'string'
    || typeof message.mes === 'string'
    || typeof message.message === 'string'
    || typeof message.text === 'string'
  ) {
    return true;
  }

  const args = extractArgsFromPayload(payload);
  const lower = apiName.toLowerCase();
  if (/(?:^|\.)(?:set|update|edit|replace)(?:chat)?message/.test(lower) || lower.endsWith('.updatemessageblock')) {
    return args.some((arg, index) => (
      index > 0
      && typeof arg === 'string'
      && !Number.isFinite(Number(arg))
    ));
  }

  return args.some((arg) => typeof arg === 'string');
}

function getAdditionalOptionsFromArgs(payload: Record<string, unknown>): Record<string, unknown> {
  const args = extractArgsFromPayload(payload);
  const message = extractMessageObjectFromPayload(payload);
  const extraOptions = args.find((arg) => (
    arg
    && typeof arg === 'object'
    && arg !== message
    && !Array.isArray(arg)
  )) as Record<string, unknown> | undefined;
  return extraOptions && typeof extraOptions === 'object' ? extraOptions : {};
}

function extractUnknownApiContent(apiName: string, payload: Record<string, unknown>): string {
  const message = extractMessageObjectFromPayload(payload);
  const direct = extractMessageContentFromPayload({
    ...payload,
    args: undefined,
  });
  if (direct) return direct;

  const args = extractArgsFromPayload(payload);
  const lower = apiName.toLowerCase();
  if (/(?:^|\.)(?:set|update|edit|replace)(?:chat)?message/.test(lower) || lower.endsWith('.updatemessageblock')) {
    const likelyContent = args.find((arg, index) => (
      index > 0
      && typeof arg === 'string'
      && !Number.isFinite(Number(arg))
    ));
    if (typeof likelyContent === 'string') return likelyContent;
  }

  if (typeof message.content === 'string') return message.content;
  if (typeof message.mes === 'string') return message.mes;
  if (typeof message.message === 'string') return message.message;
  if (typeof message.text === 'string') return message.text;
  const firstString = args.find((arg) => typeof arg === 'string');
  return typeof firstString === 'string' ? firstString : '';
}

async function applyUnknownTavernApiSideEffect(
  context: SmartCardCompatRequestContext,
  apiName: string,
  payload: Record<string, unknown>,
): Promise<unknown | undefined> {
  const lower = apiName.toLowerCase();
  const content = extractUnknownApiContent(apiName, payload);
  const options = {
    ...getAdditionalOptionsFromArgs(payload),
    ...extractMessageOptionsFromPayload(payload),
  };

  if (/(?:^|\.)(?:add|append|insert|create)(?:one)?(?:chat)?message/.test(lower) || lower.endsWith('.addonemessage')) {
    if (!content || !context.appendMessage) return { success: Boolean(content), content };
    return context.appendMessage({
      content,
      role: typeof options.role === 'string' ? options.role : undefined,
      name: typeof options.name === 'string' ? options.name : undefined,
      is_user: typeof options.is_user === 'boolean' ? options.is_user : undefined,
      is_system: typeof options.is_system === 'boolean' ? options.is_system : undefined,
      is_name: typeof options.is_name === 'boolean' ? options.is_name : undefined,
      force_avatar: typeof (options.force_avatar ?? options.forceAvatar) === 'string' ? String(options.force_avatar ?? options.forceAvatar) : undefined,
      original_avatar: typeof (options.original_avatar ?? options.originalAvatar) === 'string' ? String(options.original_avatar ?? options.originalAvatar) : undefined,
      avatar: typeof options.avatar === 'string' ? options.avatar : undefined,
      gen_id: typeof (options.gen_id ?? options.genId) === 'string' ? String(options.gen_id ?? options.genId) : undefined,
      group_id: typeof (options.group_id ?? options.groupId) === 'string' ? String(options.group_id ?? options.groupId) : undefined,
      group_name: typeof (options.group_name ?? options.groupName) === 'string' ? String(options.group_name ?? options.groupName) : undefined,
      selected_group: options.selected_group ?? options.selectedGroup,
      groups: Array.isArray(options.groups) ? options.groups as Array<Record<string, unknown>> : undefined,
      swipe_id: Number.isFinite(Number(options.swipe_id ?? options.swipeId))
        ? Number(options.swipe_id ?? options.swipeId)
        : undefined,
      swipes: Array.isArray(options.swipes) ? options.swipes.map((item) => String(item ?? '')) : undefined,
      swipe_info: Array.isArray(options.swipe_info) ? options.swipe_info as Array<Record<string, unknown>> : undefined,
      extra: options.extra && typeof options.extra === 'object' ? options.extra as Record<string, unknown> : undefined,
      model: typeof options.model === 'string' ? options.model : undefined,
      options,
    });
  }

  if (/(?:^|\.)(?:set|update|edit|replace)(?:chat)?message/.test(lower) || lower.endsWith('.updatemessageblock')) {
    const hasDisplayLayerUpdate = hasSmartCardDisplayLayerOptions(options);
    if ((!content && !hasDisplayLayerUpdate) || !context.setChatMessage) return { success: Boolean(content || hasDisplayLayerUpdate), content };
    await context.setChatMessage({
      content,
      messageId: extractMessageIdFromPayload(payload),
      index: extractIndexFromPayload(payload),
      options: {
        ...options,
        __palinkHasExplicitContent: payloadHasExplicitMessageContent(payload, apiName),
      },
    });
    return { success: true, content };
  }

  if (/(?:^|\.)(?:sendmessageasuser|sendusermessage|sendmessage)$/.test(lower)) {
    if (!content || !context.sendMessage) return { success: Boolean(content), content };
    return context.sendMessage(content, {
      awaitResult: Boolean(payload.awaitResult),
      source: apiName,
    }) || { success: true, content: '' };
  }

  if (/(?:^|\.)(?:generate|generatequietprompt|generateraw|generatecompletion|triggergeneration)$/.test(lower)) {
    if (!context.sendMessage) return { success: false, content: '' };
    return context.sendMessage(content, {
      awaitResult: payload.awaitResult !== false,
      source: apiName,
    }) || { success: true, content: '' };
  }

  if (/(?:^|\.)(?:setinputdraft|settextarea|setsendtextarea|setprompt)$/.test(lower)) {
    context.setInputDraft?.(content);
    return { success: true, content };
  }

  if (/(?:^|\.)(?:reloadcurrentchat|refresh|refreshchat|savechat|savechatconditional)$/.test(lower)) {
    context.refresh?.();
    return { success: true };
  }

  return undefined;
}

async function buildUnknownTavernApiFallback(
  state: SmartCardCompatControllerState,
  context: SmartCardCompatRequestContext,
  apiName: unknown,
  payload: Record<string, unknown>,
) {
  const name = String(apiName || '').trim();
  const lower = name.toLowerCase();

  if (!lower) return { success: true };
  const sideEffect = await applyUnknownTavernApiSideEffect(context, name, payload);
  if (sideEffect !== undefined) return sideEffect;

  if (lower.includes('worldbook') || lower.includes('lorebook')) {
    if (lower.includes('entr')) return state.worldBook?.entries ? [...state.worldBook.entries] : [];
    return buildSmartCardWorldBookExport(state);
  }
  if (lower.includes('chatmessage') || lower.includes('messages') || lower.includes('swipes')) return [];
  if (lower.includes('metadata') || lower.includes('settings') || lower.includes('config') || lower.includes('state')) return {};
  if (lower.includes('variable') || lower.includes('mvu')) return {};
  if (lower.includes('popup') || lower.includes('confirm')) return true;
  if (/(?:^|\.)(list|find|search|filter|query)/.test(lower)) return [];
  if (/(?:^|\.)(is|has|can|should)/.test(lower)) return false;
  if (/(?:^|\.)(get|read|load)/.test(lower)) {
    if (lower.includes('name') || lower.includes('title')) return '';
    if (lower.includes('id')) return null;
    return {};
  }
  if (/(?:^|\.)(set|create|update|save|delete|remove|reload|rebind|activate|deactivate|emit|trigger)/.test(lower)) {
    return {
      success: false,
      unsupported: true,
      apiName: name,
    };
  }

  return {
    success: false,
    unsupported: true,
    apiName: name,
  };
}

function extractMessageContentFromPayload(payload: Record<string, unknown>): string {
  if (typeof payload.content === 'string') return payload.content;
  if (typeof payload.message === 'string') return payload.message;
  if (typeof payload.mes === 'string') return payload.mes;
  if (Array.isArray(payload.args)) {
    for (const arg of payload.args) {
      if (typeof arg === 'string') return arg;
      if (arg && typeof arg === 'object') {
        const maybe = arg as Record<string, unknown>;
        if (typeof maybe.content === 'string') return maybe.content;
        if (typeof maybe.message === 'string') return maybe.message;
        if (typeof maybe.mes === 'string') return maybe.mes;
      }
    }
  }
  return '';
}

function extractMessageObjectFromPayload(payload: Record<string, unknown>): Record<string, unknown> {
  const candidates: unknown[] = [];
  if (payload.message && typeof payload.message === 'object') candidates.push(payload.message);
  if (payload.mes && typeof payload.mes === 'object') candidates.push(payload.mes);
  if (payload.content && typeof payload.content === 'object') candidates.push(payload.content);
  if (Array.isArray(payload.args)) {
    candidates.push(...payload.args.filter((arg) => arg && typeof arg === 'object'));
  }
  const message = candidates.find((candidate) => {
    const item = candidate as Record<string, unknown>;
    return (
      typeof item.content === 'string'
      || typeof item.mes === 'string'
      || typeof item.message === 'string'
      || typeof item.text === 'string'
      || item.extra
      || item.swipes
    );
  });
  return message && typeof message === 'object' ? message as Record<string, unknown> : {};
}

function extractMessageOptionsFromPayload(payload: Record<string, unknown>): Record<string, unknown> {
  const explicit = payload.options && typeof payload.options === 'object'
    ? { ...(payload.options as Record<string, unknown>) }
    : {};
  const message = extractMessageObjectFromPayload(payload);
  const extra = (
    (payload.extra && typeof payload.extra === 'object' ? payload.extra : undefined)
    || (message.extra && typeof message.extra === 'object' ? message.extra : undefined)
  ) as Record<string, unknown> | undefined;
  const displayText = payload.display_text ?? payload.displayText ?? message.display_text ?? message.displayText ?? extra?.display_text;
  const explicitExtra = explicit.extra && typeof explicit.extra === 'object'
    ? explicit.extra as Record<string, unknown>
    : undefined;
  const normalizedExtra = extra || typeof displayText === 'string'
    ? {
      ...(explicitExtra || {}),
      ...(extra || {}),
      ...(typeof displayText === 'string' ? { display_text: displayText } : {}),
    }
    : undefined;
  const swipeInfo = Array.isArray(payload.swipe_info)
    ? payload.swipe_info
    : Array.isArray(message.swipe_info)
      ? message.swipe_info
      : undefined;
  return {
    ...explicit,
    role: payload.role ?? message.role ?? explicit.role,
    name: payload.name ?? message.name ?? explicit.name,
    is_user: payload.is_user ?? message.is_user ?? explicit.is_user,
    is_system: payload.is_system ?? message.is_system ?? explicit.is_system,
    is_name: payload.is_name ?? message.is_name ?? explicit.is_name,
    force_avatar: payload.force_avatar ?? payload.forceAvatar ?? message.force_avatar ?? message.forceAvatar ?? explicit.force_avatar ?? explicit.forceAvatar,
    original_avatar: payload.original_avatar ?? payload.originalAvatar ?? message.original_avatar ?? message.originalAvatar ?? explicit.original_avatar ?? explicit.originalAvatar,
    avatar: payload.avatar ?? message.avatar ?? explicit.avatar,
    gen_id: payload.gen_id ?? payload.genId ?? message.gen_id ?? message.genId ?? explicit.gen_id ?? explicit.genId,
    group_id: payload.group_id ?? payload.groupId ?? message.group_id ?? message.groupId ?? explicit.group_id ?? explicit.groupId,
    group_name: payload.group_name ?? payload.groupName ?? message.group_name ?? message.groupName ?? explicit.group_name ?? explicit.groupName,
    selected_group: payload.selected_group ?? payload.selectedGroup ?? message.selected_group ?? message.selectedGroup ?? explicit.selected_group ?? explicit.selectedGroup,
    groups: Array.isArray(payload.groups) ? payload.groups : Array.isArray(message.groups) ? message.groups : explicit.groups,
    swipe_id: payload.swipe_id ?? payload.swipeId ?? message.swipe_id ?? message.swipeId ?? explicit.swipe_id ?? explicit.swipeId,
    swipes: Array.isArray(payload.swipes) ? payload.swipes : Array.isArray(message.swipes) ? message.swipes : explicit.swipes,
    swipe_info: swipeInfo ?? explicit.swipe_info,
    extra: normalizedExtra ?? explicitExtra,
    display_text: typeof displayText === 'string' ? displayText : explicit.display_text,
  };
}

export async function handleSmartCardCompatRequest(
  state: SmartCardCompatControllerState,
  context: SmartCardCompatRequestContext,
  action: SmartCardAction & { type: 'request' },
) {
  try {
    const payload = action.payload || {};
    if (
      isSmartCardMutatingActionRequiringGesture(action.action)
      && !smartCardPayloadHasUserGesture(payload)
    ) {
      const message = getSmartCardControllerCleanText().userGestureRequired;
      action.respond({
        ok: false,
        result: {
          success: false,
          blocked: true,
          reason: 'user_gesture_required',
          message,
        },
        error: message,
      });
      return;
    }
    const payloadContext = payload.__palinkContext && typeof payload.__palinkContext === 'object'
      ? payload.__palinkContext as { sessionId?: unknown }
      : null;
    const requestContext: SmartCardCompatRequestContext = {
      ...context,
      sessionId: context.sessionId || (
        typeof payloadContext?.sessionId === 'string' ? payloadContext.sessionId : null
      ),
    };
    let result: unknown = { success: true };

    if (
      action.action === 'createOrReplaceWorldbook'
      || action.action === 'createWorldbook'
      || action.action === 'setWorldbookEntries'
    ) {
      result = await createOrReplaceSmartCardWorldBook(
        state,
        requestContext,
        payload.name ?? payload.target ?? getSmartCardControllerCleanText().defaultWorldBookName,
        payload.entries,
      );
    } else if (action.action === 'createWorldbookEntries') {
      const currentWorldBook = state.worldBook;
      const targetName = String(payload.target || payload.name || currentWorldBook?.name || getSmartCardControllerCleanText().defaultWorldBookName).trim();
      const incomingEntries = Array.isArray(payload.entries) ? payload.entries as SmartCardWorldBookEntry[] : [];
      const shouldAppend = Boolean(currentWorldBook && (!payload.target || payload.target === currentWorldBook.name || payload.target === currentWorldBook.id));
      result = await createOrReplaceSmartCardWorldBook(
        state,
        requestContext,
        targetName,
        shouldAppend && currentWorldBook ? [...currentWorldBook.entries, ...incomingEntries] : incomingEntries,
      );
    } else if (action.action === 'rebindChatWorldbook' || action.action === 'activateChatWorldbook') {
      const current = state.worldBook;
      const { selectedSession, sessionId, wb } = requestContext;
      const resolvedSessionId = selectedSession && selectedSession.id !== '__pending__'
        ? selectedSession.id
        : String(sessionId || '').trim();
      if (current && resolvedSessionId && resolvedSessionId !== '__pending__') {
        await api.post(`/api/character-sessions/${resolvedSessionId}/worldbook`, {
          world_book_id: current.id,
        });
        await wb.loadSessionStatus?.(resolvedSessionId);
        result = { success: true, name: current.name, world_book_id: current.id };
      }
    } else if (action.action === 'deleteWorldbookEntries') {
      const target = String(payload.target || payload.name || '').trim();
      if (state.worldBook && (!target || target === state.worldBook.name || target === state.worldBook.id)) {
        state.worldBook = { ...state.worldBook, entries: [] };
      }
      result = { success: true };
    } else if (action.action === 'getCharWorldbook') {
      result = buildSmartCardWorldBookExport(state);
    } else if (action.action === 'getWorldbookEntries') {
      result = state.worldBook?.entries ? [...state.worldBook.entries] : [];
    } else if (action.action === 'setChatMessage' || action.action === 'updateMessageBlock') {
      const content = extractMessageContentFromPayload(payload);
      const options = extractMessageOptionsFromPayload(payload);
      const hasDisplayLayerUpdate = hasSmartCardDisplayLayerOptions(options);
      if ((content || hasDisplayLayerUpdate) && requestContext.setChatMessage) {
        const message = extractMessageObjectFromPayload(payload);
        await requestContext.setChatMessage({
          content,
          messageId: (payload.messageId ?? payload.message_id ?? message.message_id ?? message.id) as string | number | null | undefined,
          index: Number.isFinite(Number(payload.index ?? message.mesid)) ? Number(payload.index ?? message.mesid) : undefined,
          options: {
            ...options,
            __palinkHasExplicitContent: payloadHasExplicitMessageContent(payload, action.action),
          },
        });
      }
      result = { success: true, content };
    } else if (
      action.action === 'sendMessage'
      || action.action === 'sendMessageAsUser'
      || action.action === 'sendUserMessage'
    ) {
      const content = extractMessageContentFromPayload(payload);
      if (content && requestContext.sendMessage) {
        result = await requestContext.sendMessage(content, {
          awaitResult: Boolean(payload.awaitResult),
          source: action.action,
        }) || { success: true, content: '' };
      } else {
        result = { success: Boolean(content), content };
      }
    } else if (action.action === 'triggerGeneration' || action.action === 'Generate' || action.action === 'generate') {
      const content = extractMessageContentFromPayload(payload);
      if (requestContext.sendMessage) {
        result = await requestContext.sendMessage(content, {
          awaitResult: payload.awaitResult !== false,
          source: action.action,
        }) || { success: true, content: '' };
      } else {
        result = { success: false, content: '' };
      }
    } else if (action.action === 'generateRaw' || action.action === 'generateQuietPrompt') {
      const content = extractMessageContentFromPayload(payload);
      if (content && requestContext.selectedCharacterId && requestContext.selectedModel) {
        const response = await api.post<{ success?: boolean; content?: string }>('/api/character-chat/smart-card-generate', {
          character_id: requestContext.selectedCharacterId,
          prompt: content,
          session_id: requestContext.selectedSession?.id && requestContext.selectedSession.id !== '__pending__'
            ? requestContext.selectedSession.id
            : requestContext.sessionId,
          branch_id: requestContext.branchId,
          model: requestContext.selectedModel,
          mode: action.action === 'generateRaw' ? 'raw' : 'quiet',
          include_history: action.action !== 'generateRaw',
        });
        result = { success: response.success !== false, content: response.content || '' };
      } else {
        result = { success: Boolean(content), content: '' };
      }
    } else if (action.action === 'addOneMessage') {
      const content = extractMessageContentFromPayload(payload);
      const options = extractMessageOptionsFromPayload(payload);
      if (content && requestContext.appendMessage) {
        result = await requestContext.appendMessage({
          content,
          role: typeof options.role === 'string' ? options.role : undefined,
          name: typeof options.name === 'string' ? options.name : undefined,
          is_user: typeof options.is_user === 'boolean' ? options.is_user : undefined,
          is_system: typeof options.is_system === 'boolean' ? options.is_system : undefined,
          is_name: typeof options.is_name === 'boolean' ? options.is_name : undefined,
          force_avatar: typeof (options.force_avatar ?? options.forceAvatar) === 'string' ? String(options.force_avatar ?? options.forceAvatar) : undefined,
          original_avatar: typeof (options.original_avatar ?? options.originalAvatar) === 'string' ? String(options.original_avatar ?? options.originalAvatar) : undefined,
          avatar: typeof options.avatar === 'string' ? options.avatar : undefined,
          gen_id: typeof (options.gen_id ?? options.genId) === 'string' ? String(options.gen_id ?? options.genId) : undefined,
          group_id: typeof (options.group_id ?? options.groupId) === 'string' ? String(options.group_id ?? options.groupId) : undefined,
          group_name: typeof (options.group_name ?? options.groupName) === 'string' ? String(options.group_name ?? options.groupName) : undefined,
          selected_group: options.selected_group ?? options.selectedGroup,
          groups: Array.isArray(options.groups) ? options.groups as Array<Record<string, unknown>> : undefined,
          swipe_id: Number.isFinite(Number(options.swipe_id ?? options.swipeId))
            ? Number(options.swipe_id ?? options.swipeId)
            : undefined,
          swipes: Array.isArray(options.swipes) ? options.swipes.map((item) => String(item ?? '')) : undefined,
          swipe_info: Array.isArray(options.swipe_info) ? options.swipe_info as Array<Record<string, unknown>> : undefined,
          extra: options.extra && typeof options.extra === 'object' ? options.extra as Record<string, unknown> : undefined,
          model: typeof options.model === 'string' ? options.model : typeof payload.model === 'string' ? payload.model : undefined,
          options,
        });
      } else if (content && requestContext.setChatMessage) {
        await requestContext.setChatMessage({ content });
        result = { success: true, content };
      } else {
        result = { success: Boolean(content), content };
      }
    } else if (action.action === 'setInputDraft') {
      const content = extractMessageContentFromPayload(payload);
      requestContext.setInputDraft?.(content);
      result = { success: true, content };
    } else if (action.action === 'deleteMessage' || action.action === 'deleteChatMessage') {
      const message = extractMessageObjectFromPayload(payload);
      const messageId = (payload.messageId ?? payload.message_id ?? message.message_id ?? message.id) as string | number | null | undefined;
      const index = Number.isFinite(Number(payload.index ?? message.mesid)) ? Number(payload.index ?? message.mesid) : undefined;
      await requestContext.deleteMessage?.(messageId, index);
      result = { success: true };
    } else if (action.action === 'deleteLastMessage') {
      await requestContext.deleteMessage?.(null, -1);
      result = { success: true };
    } else if (action.action === 'clearChat') {
      await requestContext.clearChat?.();
      result = { success: true };
    } else if (action.action === 'stopGeneration') {
      await requestContext.stopGeneration?.();
      result = { success: true };
    } else if (action.action === 'scrollChatToBottom' || action.action === 'printMessages') {
      requestContext.scrollChatToBottom?.();
      if (action.action === 'printMessages') requestContext.refresh?.();
      result = { success: true };
    } else if (action.action === 'reloadCurrentChat' || action.action === 'refresh') {
      requestContext.refresh?.();
      result = { success: true };
    } else if (action.action === 'saveExtensionSettings') {
      result = await saveSmartCardExtensionSettings(payload);
    } else if (action.action === 'callGenericPopup' || action.action === 'callPopup') {
      // Task 8.2: 委托到 popupManager.show() 并返回 PopupResult
      const rawMessage = typeof payload.message === 'string' ? payload.message : String(payload.message ?? '');
      const rawType = typeof payload.type === 'string' ? payload.type : 'text';
      const inputValue = typeof payload.inputValue === 'string' ? payload.inputValue : '';
      const popupOptions = (payload.options && typeof payload.options === 'object')
        ? payload.options as Record<string, unknown>
        : {};

      // 映射 SillyTavern popup 类型字符串到 PopupType 枚举
      let popupType: PopupType = PopupType.TEXT;
      const normalizedType = String(rawType || '').toLowerCase();
      if (normalizedType.includes('input')) popupType = PopupType.INPUT;
      else if (normalizedType.includes('confirm')) popupType = PopupType.CONFIRM;
      else if (normalizedType.includes('display')) popupType = PopupType.DISPLAY;
      else if (normalizedType.includes('text')) popupType = PopupType.TEXT;

      // [N-1] 仅 DISPLAY 分支经 dangerouslySetInnerHTML 注入主 origin，入口先消毒；
      // TEXT/CONFIRM/INPUT 走 React 文本节点本已安全，保持原样
      const message = popupType === PopupType.DISPLAY
        ? String(DOMPurify.sanitize(rawMessage, {
            FORBID_TAGS: ['script'],
            FORBID_ATTR: ['onerror', 'onload', 'onclick', 'onmouseover'],
          }))
        : rawMessage;

      // 构造 PopupOptions
      const options: import('@/lib/popup-system/types').PopupOptions = {};
      if (typeof popupOptions.okButton === 'string') options.okButton = popupOptions.okButton;
      else if (popupOptions.okButton === true) options.okButton = true;
      if (typeof popupOptions.cancelButton === 'string') options.cancelButton = popupOptions.cancelButton;
      else if (popupOptions.cancelButton === true) options.cancelButton = true;
      if (typeof popupOptions.placeholder === 'string') options.placeholder = popupOptions.placeholder;
      if (typeof popupOptions.defaultValue === 'string') options.defaultValue = popupOptions.defaultValue;
      if (typeof popupOptions.wide === 'boolean') options.wide = popupOptions.wide;
      if (typeof popupOptions.large === 'boolean') options.large = popupOptions.large;
      if (typeof popupOptions.timeout === 'number') options.timeout = popupOptions.timeout;
      if (typeof popupOptions.closeOnBackdropClick === 'boolean') options.closeOnBackdropClick = popupOptions.closeOnBackdropClick;
      if (Array.isArray(popupOptions.customButtons)) options.customButtons = popupOptions.customButtons as any;

      const headerText = typeof popupOptions.header === 'string' && popupOptions.header
        ? popupOptions.header
        : (popupType === PopupType.CONFIRM ? '确认' : popupType === PopupType.INPUT ? '输入' : '提示');

      // 对于 INPUT 类型,使用 defaultValue 作为初始值(若未在 options 中显式提供)
      if (popupType === PopupType.INPUT && !options.defaultValue && inputValue) {
        options.defaultValue = inputValue;
      }

      const popupResult = await popupManager.show(popupType, headerText, message, options);
      result = { success: true, result: popupResult };
    } else if (action.action === 'unknownApiCall') {
      result = await buildUnknownTavernApiFallback(state, requestContext, payload.apiName, payload);
    }

    action.respond({ ok: true, result });
  } catch (error: any) {
    console.warn('Character smart card request failed:', action.action, error);
    action.respond({ ok: false, error: String(error?.message || error) });
  }
}

function getCurrentInterfaceIsEnglish(): boolean {
  if (typeof document !== 'undefined' && document.documentElement.getAttribute('lang') === 'en') return true;
  if (typeof window === 'undefined') return false;
  return window.localStorage.getItem('lang') === 'en' || window.localStorage.getItem('palink-lang') === 'en';
}

function getSmartCardDiagnosticText(diagnostic: SmartCardCompatDiagnostic): string {
  const isEnglish = getCurrentInterfaceIsEnglish();
  const apiName = diagnostic.apiName ? ` ${diagnostic.apiName}` : '';

  if (diagnostic.code === 'missing_api' || diagnostic.code === 'undefined_global' || diagnostic.code === 'detected_missing_api_stubbed') {
    return isEnglish
      ? `This card needs an unsupported Tavern API:${apiName || ' unknown API'}`
      : `\u8fd9\u5f20\u89d2\u8272\u5361\u9700\u8981\u5c1a\u672a\u5b8c\u6574\u652f\u6301\u7684 Tavern API\uff1a${diagnostic.apiName || '\u672a\u77e5 API'}`;
  }

  if (diagnostic.code === 'parent_request_timeout') {
    return isEnglish
      ? `Smart card compatibility request timed out:${apiName}`
      : `\u89d2\u8272\u5361\u517c\u5bb9\u8bf7\u6c42\u8d85\u65f6\uff1a${diagnostic.apiName || '\u672a\u77e5\u8bf7\u6c42'}`;
  }

  return isEnglish
    ? (diagnostic.message || 'Smart card compatibility warning')
    : (diagnostic.message || '\u89d2\u8272\u5361\u517c\u5bb9\u5c42\u63d0\u793a');
}

function getSmartCardDiagnosticCleanText(diagnostic: SmartCardCompatDiagnostic): string {
  const text = getSmartCardControllerCleanText();
  const apiName = diagnostic.apiName ? ` ${diagnostic.apiName}` : '';

  if (diagnostic.code === 'missing_api' || diagnostic.code === 'undefined_global' || diagnostic.code === 'detected_missing_api_stubbed') {
    return `${text.unsupportedApi}${apiName || ` ${text.unknownApi}`}`;
  }

  if (diagnostic.code === 'parent_request_timeout') {
    return `${text.requestTimeout}${apiName || ` ${text.unknownRequest}`}`;
  }

  return diagnostic.message || text.warning;
}

export function handleSmartCardCompatDiagnostic(
  state: SmartCardCompatControllerState,
  diagnostic: SmartCardCompatDiagnostic,
) {
  const key = `${diagnostic.code}:${diagnostic.apiName || ''}:${diagnostic.message || ''}`;
  const now = Date.now();
  const previous = state.diagnosticToastTimes.get(key) || 0;
  console.warn('Character smart card compatibility diagnostic:', diagnostic);
  if (diagnostic.severity !== 'info' && now - previous > 12000) {
    state.diagnosticToastTimes.set(key, now);
    toast.warning(getSmartCardDiagnosticCleanText(diagnostic));
  }
}
