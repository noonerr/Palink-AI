/**
 * ST 兼容运行时体 · 第 04 段
 *
 * 机械拆分自 SillyTavernCompatRuntime.ts 原第 2910-3789 行，逐字节搬运，未改任何逻辑。
 * 内容是注入智能卡 iframe 的 JS 源码文本。
 *
 * 约束（改动前必读）：
 *  1. 本段是模板字符串：新增注释与代码里不得出现裸反引号，正则一律 new RegExp()。
 *  2. 各段拼接顺序由 SillyTavernCompatRuntime.ts 的
 *     buildSillyTavernCompatRuntimeBodyScript 固定（按行号升序），不可调换。
 *  3. 段内跨段引用的标识符靠 IIFE 闭包共享，不要单独求值某一段。
 */

export const RUNTIME_BODY_PART_04 = `      Number.isFinite(Number(message?.swipe_id)) ? Number(message.swipe_id) : 0,
      Math.max(0, swipes.length - 1),
    ));
    const activeContent = swipes[swipeId] ?? content;
    const sourceSwipeInfo = Array.isArray(message?.swipe_info)
      ? message.swipe_info
      : Array.isArray(rawExtra.swipe_info)
        ? rawExtra.swipe_info
        : null;
    const activeSwipeExtra = sourceSwipeInfo?.[swipeId]?.extra && typeof sourceSwipeInfo[swipeId].extra === 'object'
      ? sourceSwipeInfo[swipeId].extra
      : null;
    const extra = stripSwipeInfoFromExtra(activeSwipeExtra || rawExtra);
    const sendDate = message?.created_at || message?.send_date || '';
    const normalized = {
      id,
      mesid,
      message_id: id,
      name: message?.name || (isUser ? ctx.userName : ctx.characterName),
      role,
      is_user: isUser,
      is_system: role === 'system',
      is_name: getStMessageMeta(message, 'is_name', extra) ?? true,
      content: activeContent,
      mes: activeContent,
      message: activeContent,
      text: activeContent,
      swipes,
      swipe_id: swipeId,
      swipe_info: sourceSwipeInfo
        ? sourceSwipeInfo.map((entry) => normalizeSwipeInfoEntry(entry, extra, sendDate))
        : swipes.map(() => ({ send_date: sendDate, extra: clone(extra) })),
      extra,
      send_date: sendDate,
    };
    return applyStMessageMeta(normalized, message, extra);
  };
  const seedMessages = Array.isArray(ctx.chatMessages) && ctx.chatMessages.length > 0
    ? ctx.chatMessages
    : [{ id: ctx.messageId, role: 'assistant', name: ctx.characterName, content: ctx.messageContent }];
  const compatChat = seedMessages.map(normalizeChatMessage);
  let currentMessageIndex = Number.isFinite(Number(ctx.messageIndex))
    ? Number(ctx.messageIndex)
    : Math.max(0, compatChat.findIndex((message) => String(message.id) === String(ctx.messageId) || String(message.message_id) === String(ctx.messageId)));
  const ensureSwipeInfoShape = (message) => {
    if (!Array.isArray(message.swipes) || message.swipes.length === 0) {
      const content = String(message?.mes ?? message?.content ?? message?.message ?? '');
      message.swipes = [content];
    }
    if (!Number.isFinite(Number(message.swipe_id))) message.swipe_id = 0;
    message.swipe_id = Math.max(0, Math.min(Number(message.swipe_id), message.swipes.length - 1));
    if (!Array.isArray(message.swipe_info)) message.swipe_info = [];
    const fallbackExtra = stripSwipeInfoFromExtra(message.extra || {});
    while (message.swipe_info.length < message.swipes.length) {
      message.swipe_info.push({ send_date: message.send_date || '', extra: clone(fallbackExtra) });
    }
    message.swipe_info = message.swipe_info
      .slice(0, message.swipes.length)
      .map((entry) => normalizeSwipeInfoEntry(entry, fallbackExtra, message.send_date || ''));
    return message;
  };
  const syncMessageAliases = (message) => {
    const content = String(message?.mes ?? message?.content ?? message?.message ?? '');
    message.content = content;
    message.mes = content;
    message.message = content;
    message.text = content;
    message.extra = stripSwipeInfoFromExtra(message.extra || {});
    ensureSwipeInfoShape(message);
    return message;
  };
  const syncMesToSwipeCompat = (message) => {
    if (!message) return message;
    syncMessageAliases(message);
    message.swipes[message.swipe_id] = String(message.mes ?? '');
    message.swipe_info[message.swipe_id] = {
      ...(message.swipe_info[message.swipe_id] || {}),
      send_date: message.swipe_info[message.swipe_id]?.send_date || message.send_date || '',
      extra: stripSwipeInfoFromExtra(message.extra || {}),
    };
    return syncMessageAliases(message);
  };
  const syncSwipeToMesCompat = (message, swipeId = message?.swipe_id) => {
    if (!message) return message;
    syncMessageAliases(message);
    const nextSwipeId = Math.max(0, Math.min(Number(swipeId) || 0, message.swipes.length - 1));
    message.swipe_id = nextSwipeId;
    message.mes = String(message.swipes[nextSwipeId] ?? '');
    const activeSwipeInfo = message.swipe_info[nextSwipeId];
    if (activeSwipeInfo?.extra && typeof activeSwipeInfo.extra === 'object') {
      message.extra = stripSwipeInfoFromExtra(activeSwipeInfo.extra);
    }
    return syncMessageAliases(message);
  };
  compatChat.forEach((message) => syncSwipeToMesCompat(message, message.swipe_id));
  const primaryCharacter = {
    id: ctx.characterId,
    uuid: ctx.characterId,
    name: ctx.characterName,
    avatar: ctx.characterId,
    chat: ctx.sessionId,
    first_mes: ctx.firstMes || '',
    alternate_greetings: Array.isArray(ctx.alternateGreetings) ? clone(ctx.alternateGreetings) : [],
    data: {
      name: ctx.characterName,
      extensions: parseMaybeJsonObject(ctx.characterExtensions, {}),
      first_mes: ctx.firstMes || '',
      alternate_greetings: Array.isArray(ctx.alternateGreetings) ? clone(ctx.alternateGreetings) : [],
    },
  };
  const getMessageGroupIdCompat = (message) => (
    message?.selected_group
    ?? message?.selectedGroup
    ?? message?.group_id
    ?? message?.groupId
    ?? null
  );
  const getMessageGroupNameCompat = (message) => (
    message?.group_name
    ?? message?.groupName
    ?? null
  );
  const buildCharacterFromMessageCompat = (message, index) => {
    const name = String(message?.name || '').trim();
    if (!name || message?.is_user || message?.is_system) return null;
    const avatar = message?.avatar || message?.force_avatar || message?.original_avatar || name;
    const id = message?.character_id || message?.characterId || avatar || name || index;
    return {
      id,
      uuid: id,
      name,
      avatar,
      chat: ctx.sessionId,
      data: {
        name,
        avatar,
        extensions: {},
      },
    };
  };
  const buildGroupContextCompat = () => {
    const explicitGroupSource = compatChat.find((message) => Array.isArray(message?.groups) && message.groups.length > 0);
    const metaGroupSource = compatChat.find((message) => (
      getMessageGroupIdCompat(message) !== null
      || getMessageGroupNameCompat(message) !== null
    ));
    const source = explicitGroupSource || metaGroupSource || null;
    const groupId = getMessageGroupIdCompat(source);
    const groupName = getMessageGroupNameCompat(source);
    const members = [];
    const seenNames = new Set();
    compatChat.forEach((message, index) => {
      const member = buildCharacterFromMessageCompat(message, index);
      if (!member || seenNames.has(member.name)) return;
      seenNames.add(member.name);
      members.push(member);
    });
    if (!seenNames.has(primaryCharacter.name)) {
      members.unshift(primaryCharacter);
    }
    const groups = Array.isArray(explicitGroupSource?.groups)
      ? clone(explicitGroupSource.groups)
      : groupId || groupName
        ? [{
          id: groupId || ctx.sessionId || 'palink-group',
          name: groupName || ctx.characterName || 'Palink Group',
          members: members.map((member) => member.id ?? member.name),
          disabled_members: [],
          chat_id: ctx.sessionId,
          chat_metadata: window.chat_metadata || {},
        }]
        : [];
    return {
      selectedGroup: groupId || (groups[0]?.id ?? null),
      groups,
      members,
    };
  };
  const refreshGroupContextCompat = () => {
    const groupContext = buildGroupContextCompat();
    window.selected_group = groupContext.selectedGroup ?? null;
    window.groups = Array.isArray(groupContext.groups) ? groupContext.groups : [];
    window.characters = Array.isArray(window.characters) ? window.characters : [];
    window.characters[0] = primaryCharacter;
    if (ctx.characterId) window.characters[ctx.characterId] = primaryCharacter;
    groupContext.members.forEach((member, index) => {
      const characterIndex = index === 0 ? 0 : index;
      window.characters[characterIndex] = member;
      if (member.id !== undefined && member.id !== null) window.characters[member.id] = member;
      if (member.name) window.characters[member.name] = member;
    });
    window.this_chid = 0;
    window.characters[0] = primaryCharacter;
    if (ctx.characterId) window.characters[ctx.characterId] = primaryCharacter;
    if (primaryCharacter.name) window.characters[primaryCharacter.name] = primaryCharacter;
    return groupContext;
  };
  const getGroupsCompat = () => clone(Array.isArray(window.groups) ? window.groups : []);
  const getGroupChatCompat = (groupId = window.selected_group) => {
    const groups = Array.isArray(window.groups) ? window.groups : [];
    const group = groups.find((item) => String(item?.id) === String(groupId))
      || groups.find((item) => String(item?.name) === String(groupId))
      || groups[0]
      || null;
    return {
      ...(group && typeof group === 'object' ? clone(group) : {}),
      id: group?.id ?? groupId ?? null,
      name: group?.name ?? ctx.characterName ?? '',
      chat_id: group?.chat_id ?? ctx.sessionId,
      chat: getCompatChatMessages(),
      messages: getCompatChatMessages(),
      members: Array.isArray(group?.members)
        ? clone(group.members)
        : compatChat
          .filter((message) => message && !message.is_user && !message.is_system && message.name)
          .map((message) => message.name),
    };
  };
  window.chat = compatChat;
  window.name1 = ctx.userName || 'User';
  window.name2 = ctx.characterName || 'Character';
  window.this_chid = 0;
  refreshGroupContextCompat();
  const syncCtxMessageFromCompat = (index) => {
    const message = compatChat[index];
    if (!message) return;
    if (Array.isArray(ctx.chatMessages) && ctx.chatMessages[index]) {
      ctx.chatMessages[index] = {
        ...ctx.chatMessages[index],
        content: message.mes,
        mes: message.mes,
        message: message.mes,
        text: message.mes,
        name: message.name,
        role: message.role,
        is_user: message.is_user,
        is_system: message.is_system,
        is_name: message.is_name,
        force_avatar: message.force_avatar,
        original_avatar: message.original_avatar,
        avatar: message.avatar,
        gen_id: message.gen_id,
        group_id: message.group_id,
        group_name: message.group_name,
        selected_group: clone(message.selected_group),
        groups: clone(message.groups),
        swipe_id: message.swipe_id,
        swipes: clone(message.swipes),
        swipe_info: clone(message.swipe_info),
        extra: clone(message.extra || {}),
      };
    }
    if (index === currentMessageIndex || String(message.id) === String(ctx.messageId) || String(message.message_id) === String(ctx.messageId)) {
      ctx.messageContent = message.mes;
    }
    refreshGroupContextCompat();
  };
  const normalizeParentSelectorCompat = (selector) => String(selector || '').trim();
  const parentSelectorMatchesCompat = (selector, id) => {
    const normalized = normalizeParentSelectorCompat(selector);
    if (!normalized) return false;
    return normalized.split(',').map((part) => part.trim()).filter(Boolean).some((part) => {
      const simple = part
        .replace(/:(?:visible|hidden|first|last|first-child|last-child|eq\\([^)]*\\)|not\\([^)]*\\))/gi, '')
        .trim();
      if (simple === '*' || simple === '#' + id || simple === '[id="' + id + '"]' || simple === "[id='" + id + "']") return true;
      if (id === 'send_textarea') return /^(?:textarea)?#send_textarea$|^textarea\\b|send_textarea|send-textarea/i.test(part);
      if (id === 'send_but') return /^(?:button)?#send_but$|^button\\b|send_but|send-button|sendButton/i.test(part);
      if (id === 'send_form') return /^(?:form)?#send_form$|^form\\b|send_form|send-form/i.test(part);
      if (id === 'chat') return /(?:^|\\s|>)#chat\\b|(?:^|\\s|>)\\.chat\\b|chat_container|chat-container/i.test(part);
      if (id === 'chat_scroll') return /chat_scroll|chat-scroll|\\.chat-scroll|\\.chat_container/i.test(part);
      if (/(?:\\.mes_text\\b|#mes_text\\b|mes_text|message_text|message-content)/i.test(part) && (id === 'last_mes' || id === 'mes')) return false;
      if (id === 'last_mes' || id === 'mes') return /(?:^|\\s|>)\\.mes\\b|\\.last_mes\\b|last_mes|mes_block|message-block/i.test(part);
      if (id === 'mes_text') return /\\.mes_text\\b|mes_text|message_text|message-content|\\.mes\\s+.*\\.mes_text|\\.last_mes\\s+.*\\.mes_text/i.test(part);
      if (id === 'mes_buttons') return /\\.mes_buttons\\b|mes_buttons|message-buttons/i.test(part);
      if (id === 'swipe_left') return /swipe_left|swipe-left|\\.swipe_left\\b|\\.swipe-button-left/i.test(part);
      if (id === 'swipe_right') return /swipe_right|swipe-right|\\.swipe_right\\b|\\.swipe-button-right/i.test(part);
      if (id === 'swipe_counter') return /swipe_counter|swipe-counter|\\.swipes-counter|\\.swipe_counter/i.test(part);
      return false;
    });
  };
  const parentElementStore = {};
  const createParentVirtualElementCompat = (id, tagName = 'DIV', className = '', options = {}) => {
    const listeners = new Map();
    const element = {
      __palinkParentElement: true,
      nodeType: 1,
      id,
      tagName,
      className,
      dataset: { ...(options.dataset || {}) },
      style: {},
      value: options.value || '',
      get textContent() {
        return typeof options.text === 'function' ? String(options.text() ?? '') : String(options.text ?? '');
      },
      set textContent(value) {
        options.text = String(value ?? '');
        if (typeof options.onSetText === 'function') options.onSetText(options.text, this);
      },
      get innerText() { return this.textContent; },
      set innerText(value) { this.textContent = value; },
      get innerHTML() {
        return typeof options.html === 'function' ? String(options.html() ?? '') : this.textContent;
      },
      set innerHTML(value) {
        options.html = String(value ?? '');
        options.text = String(value ?? '').replace(/<[^>]+>/g, '');
        if (typeof options.onSetHtml === 'function') options.onSetHtml(options.html, this);
      },
      parentElement: null,
      children: [],
      addEventListener(type, callback) {
        if (typeof callback !== 'function') return;
        const key = String(type || '');
        if (!listeners.has(key)) listeners.set(key, new Set());
        listeners.get(key).add(callback);
      },
      removeEventListener(type, callback) {
        listeners.get(String(type || ''))?.delete(callback);
      },
      dispatchEvent(event) {
        const eventType = typeof event === 'string' ? event : event?.type;
        if (!eventType) return true;
        const evt = event && typeof event === 'object' ? event : { type: eventType };
        if (!evt.target) {
          try { Object.defineProperty(evt, 'target', { value: this, configurable: true }); } catch { evt.target = this; }
        }
        if (!evt.currentTarget) {
          try { Object.defineProperty(evt, 'currentTarget', { value: this, configurable: true }); } catch { evt.currentTarget = this; }
        }
        if (typeof evt.preventDefault !== 'function') {
          evt.preventDefault = () => {
            try { Object.defineProperty(evt, 'defaultPrevented', { value: true, configurable: true }); } catch { evt.defaultPrevented = true; }
          };
        }
        Array.from(listeners.get(String(eventType)) || []).forEach((listener) => {
          try { listener.call(this, evt); } catch (error) { post({ type: 'error', message: String(error?.message || error) }); }
        });
        if (!evt.defaultPrevented && typeof options.dispatch === 'function') options.dispatch.call(this, evt, eventType);
        return !evt.defaultPrevented;
      },
      click() {
        const allowed = this.dispatchEvent({ type: 'click', target: this, currentTarget: this, preventDefault() { this.defaultPrevented = true; } });
        if (allowed !== false && typeof options.click === 'function') options.click.call(this);
      },
      focus() {},
      blur() {},
      matches(selector) {
        if (typeof options.matches === 'function') return Boolean(options.matches(selector, this));
        return parentSelectorMatchesCompat(selector, id);
      },
      closest(selector) {
        if (typeof options.closest === 'function') return options.closest(selector, this);
        return this.matches(selector) ? this : null;
      },
      querySelector(selector) { return getParentElementBySelectorCompat(selector); },
      querySelectorAll(selector) { return getParentElementsBySelectorCompat(selector); },
      getAttribute(name) {
        const key = String(name || '');
        if (key === 'id') return id;
        if (key === 'class') return className;
        if (key === 'value') return this.value;
        if (key === 'src' && 'src' in this) return this.src || '';
        if (key === 'alt' && 'alt' in this) return this.alt || '';
        if (key === 'mesid' || key === 'data-mesid' || key === 'data-message-id') {
          const optionIndex = typeof options.getMessageIndex === 'function'
            ? options.getMessageIndex()
            : resolveMessageIndex(ctx.messageId, {});
          return String(optionIndex);
        }
        if (key.startsWith('data-')) return this.dataset[key.slice(5)] ?? null;
        return null;
      },
      setAttribute(name, value) {
        const key = String(name || '');
        if (key === 'value') this.value = String(value ?? '');
        else if (key.startsWith('data-')) this.dataset[key.slice(5)] = String(value ?? '');
        else this[key] = String(value ?? '');
      },
      removeAttribute(name) {
        const key = String(name || '');
        if (key.startsWith('data-')) delete this.dataset[key.slice(5)];
      },
    };
    return element;
  };
  const parentMessageElementCache = new Map();
  const selectorHasMessageTextCompat = (selector) => /(?:^|[\\s>+~])\\.mes_text\\b|#mes_text\\b|\\bmes_text\\b|message_text|message-content/i.test(String(selector || ''));
  const selectorHasMessageBlockCompat = (selector) => /(?:^|[\\s>+~])\\.mes\\b|\\.last_mes\\b|#chat\\b|chat_container|chat-container/i.test(String(selector || ''));
  const selectorHasMesBlockInnerCompat = (selector) => /(?:^|[\\s>+~])\\.mes_block\\b|\\bmes_block\\b/i.test(String(selector || ''));
  const selectorHasNameCompat = (selector) => /(?:^|[\\s>+~])\\.ch_name\\b|(?:^|[\\s>+~])\\.name_text\\b|\\bch_name\\b|\\bname_text\\b/i.test(String(selector || ''));
  const selectorHasAvatarCompat = (selector) => /(?:^|[\\s>+~])\\.avatar\\b|\\.avatar\\s+img|force_avatar|original_avatar/i.test(String(selector || ''));
  const selectorHasTimestampCompat = (selector) => /(?:^|[\\s>+~])\\.timestamp\\b|\\btimestamp\\b|send_date/i.test(String(selector || ''));
  const selectorHasSwipeElementCompat = (selector) => /swipe_left|swipe-right|swipe_right|swipe_counter|swipes-counter|\\.swipe_/i.test(String(selector || ''));
  const normalizeSelectorCompat = (selector) => String(selector || '')
    .replace(/:(?:visible|hidden|first|last|first-child|last-child|eq\\([^)]*\\)|not\\([^)]*\\))/gi, '')
    .trim();
  const getSelectorPseudoCompat = (selector) => {
    const raw = String(selector || '');
    const eqMatch = raw.match(/:eq\\(\\s*(-?\\d+)\\s*\\)/i);
    return {
      first: /:(?:first|first-child)\\b/i.test(raw),
      last: /:(?:last|last-child)\\b/i.test(raw),
      eq: eqMatch ? Number(eqMatch[1]) : null,
    };
  };
  const applySelectorPseudoCompat = (indexes, selector) => {
    const uniqueIndexes = Array.from(new Set((indexes || []).filter((index) => Number.isInteger(index) && index >= 0 && index < compatChat.length)));
    const pseudo = getSelectorPseudoCompat(selector);
    if (pseudo.eq !== null && Number.isInteger(pseudo.eq)) {
      const resolved = pseudo.eq < 0 ? uniqueIndexes.length + pseudo.eq : pseudo.eq;
      return uniqueIndexes[resolved] !== undefined ? [uniqueIndexes[resolved]] : [];
    }
    if (pseudo.last) return uniqueIndexes.length ? [uniqueIndexes[uniqueIndexes.length - 1]] : [];
    if (pseudo.first) return uniqueIndexes.length ? [uniqueIndexes[0]] : [];
    return uniqueIndexes;
  };
  const getMessageIndexesFromSelectorCompat = (selector) => {
    const normalized = normalizeSelectorCompat(selector);
    if (!normalized) return [];
    const latestIndex = resolveLatestMessageIndexCompat();
    if (/\\.last_mes\\b|last_mes/i.test(normalized)) return latestIndex >= 0 ? [latestIndex] : [];
    const attrMatch = normalized.match(/(?:\\bmesid\\b|\\bdata-mesid\\b|\\bdata-message-id\\b|\\bdata-palink-message-id\\b|\\bmessage_id\\b)\\s*=\\s*["']?([^"'\\]\\s]+)/i);
    if (attrMatch) {
      const raw = attrMatch[1];
      const byIndex = Number(raw);
      if (Number.isInteger(byIndex) && byIndex >= 0 && byIndex < compatChat.length) return [byIndex];
      const byId = compatChat.findIndex((message) => String(message.id) === String(raw) || String(message.message_id) === String(raw));
      return byId >= 0 ? [byId] : [];
    }
    const idMatch = normalized.match(/#(?:message-|mes-|chat-message-|mes_text-)(\\d+)\\b/i);
    if (idMatch) {
      const byIndex = Number(idMatch[1]);
      return Number.isInteger(byIndex) && byIndex >= 0 && byIndex < compatChat.length ? [byIndex] : [];
    }
    if (
      selectorHasMessageBlockCompat(normalized)
      || selectorHasMessageTextCompat(normalized)
      || selectorHasMesBlockInnerCompat(normalized)
      || selectorHasNameCompat(normalized)
      || selectorHasAvatarCompat(normalized)
      || selectorHasTimestampCompat(normalized)
    ) {
      return applySelectorPseudoCompat(compatChat.map((_message, index) => index), selector);
    }
    return [];
  };
  const getParentMessageElementCompat = (index, kind = 'mes') => {
    const numericIndex = Number(index);
    if (!Number.isInteger(numericIndex) || numericIndex < 0 || numericIndex >= compatChat.length) return null;
    const key = String(kind) + ':' + String(numericIndex);
    if (parentMessageElementCache.has(key)) return parentMessageElementCache.get(key);
    const isText = kind === 'mes_text';
    const isButtons = kind === 'mes_buttons';
    const isCounter = kind === 'swipe_counter';
    const isLeft = kind === 'swipe_left';
    const isRight = kind === 'swipe_right';
    const isAvatarImg = kind === 'avatar_img';
    const tagName = isAvatarImg ? 'IMG' : isLeft || isRight ? 'BUTTON' : isCounter ? 'SPAN' : 'DIV';
    const className = isText
      ? 'mes_text'
      : isButtons
        ? 'mes_buttons'
        : isCounter
          ? 'swipe_counter'
          : isLeft
            ? 'swipe_left'
            : isRight
              ? 'swipe_right'
              : kind === 'mes_block'
                ? 'mes_block'
                : kind === 'ch_name'
                  ? 'ch_name'
                  : kind === 'name_text'
                    ? 'name_text'
                    : kind === 'avatar'
                      ? 'avatar'
                      : isAvatarImg
                        ? ''
                        : kind === 'timestamp'
                          ? 'timestamp'
                          : 'mes' + (numericIndex === resolveLatestMessageIndexCompat() ? ' last_mes' : '');
    const getMessage = () => compatChat[numericIndex] || {};
    const element = createParentVirtualElementCompat(kind + '-' + String(numericIndex), tagName, className, {
      dataset: {
        mesid: String(numericIndex),
        messageId: String(getMessage().message_id ?? getMessage().id ?? numericIndex),
        swipeId: String(getMessage().swipe_id ?? 0),
        is_user: getMessage().is_user ? 'true' : 'false',
      },
      getMessageIndex: () => numericIndex,
      text: () => {
        const message = getMessage();
        if (kind === 'ch_name' || kind === 'name_text') return String(message.name || ctx.characterName || '');
        if (kind === 'timestamp') return String(message.send_date || '');
        if (isCounter) {
          const count = Array.isArray(message.swipes) ? message.swipes.length : 1;
          return String(Number(message.swipe_id || 0) + 1) + '/' + String(Math.max(1, count));
        }
        return message.mes || message.content || '';
      },
      html: () => {
        const message = getMessage();
        return isText
          ? messageFormattingCompat(message.mes || message.content || '', message.name, Boolean(message.is_system), Boolean(message.is_user), numericIndex)
          : message.mes || message.content || '';
      },
      onSetText: (value) => {
        if (!isText) return;
        const message = getMessage();
        setMessageDisplayTextCompat(htmlEscapeCompat(value), message.message_id ?? message.id ?? numericIndex, { index: numericIndex, source: 'parent-dom-text' });
      },
      onSetHtml: (value) => {
        if (!isText) return;
        const message = getMessage();
        setMessageDisplayTextCompat(value, message.message_id ?? message.id ?? numericIndex, { index: numericIndex, source: 'parent-dom-html' });
      },
      click: () => {
        if (isLeft) void swipeCompat(null, -1, { source: 'parent-dom', forceMesId: numericIndex });
        if (isRight) void swipeCompat(null, 1, { source: 'parent-dom', forceMesId: numericIndex });
      },
      matches: (selector) => {
        const normalized = normalizeSelectorCompat(selector);
        if (!normalized) return false;
        if (isText) return selectorHasMessageTextCompat(normalized) && getMessageIndexesFromSelectorCompat(normalized).includes(numericIndex);
        if (kind === 'mes_block') return selectorHasMesBlockInnerCompat(normalized) && getMessageIndexesFromSelectorCompat(normalized).includes(numericIndex);
        if (kind === 'ch_name' || kind === 'name_text') return selectorHasNameCompat(normalized) && getMessageIndexesFromSelectorCompat(normalized).includes(numericIndex);
        if (kind === 'avatar' || isAvatarImg) return selectorHasAvatarCompat(normalized) && getMessageIndexesFromSelectorCompat(normalized).includes(numericIndex);
        if (kind === 'timestamp') return selectorHasTimestampCompat(normalized) && getMessageIndexesFromSelectorCompat(normalized).includes(numericIndex);
        if (isButtons) return /\\.mes_buttons\\b|mes_buttons|message-buttons/i.test(normalized) && getMessageIndexesFromSelectorCompat(normalized).includes(numericIndex);
        if (isLeft) return /swipe_left|swipe-left|\\.swipe_left\\b|\\.swipe-button-left/i.test(normalized) && getMessageIndexesFromSelectorCompat(normalized).includes(numericIndex);
        if (isRight) return /swipe_right|swipe-right|\\.swipe_right\\b|\\.swipe-button-right/i.test(normalized) && getMessageIndexesFromSelectorCompat(normalized).includes(numericIndex);
        if (isCounter) return /swipe_counter|swipe-counter|\\.swipes-counter|\\.swipe_counter/i.test(normalized) && getMessageIndexesFromSelectorCompat(normalized).includes(numericIndex);
        return selectorHasMessageBlockCompat(normalized) && getMessageIndexesFromSelectorCompat(normalized).includes(numericIndex);
      },
      closest: (selector, self) => {
        const normalized = normalizeSelectorCompat(selector);
        if (!normalized) return null;
        if (selectorHasMessageTextCompat(normalized) && isText) return self;
        if (selectorHasMessageBlockCompat(normalized)) return isText || isButtons || isCounter || isLeft || isRight || kind !== 'mes'
          ? getParentMessageElementCompat(numericIndex, 'mes')
          : self;
        return self.matches(selector) ? self : null;
      },
    });
    if (isAvatarImg) {
      Object.defineProperty(element, 'src', {
        configurable: true,
        get() {
          const message = getMessage();
          return String(message.force_avatar || message.avatar || message.original_avatar || '');
        },
        set(value) {
          const message = getMessage();
          message.force_avatar = String(value || '');
        },
      });
      element.alt = String(getMessage().name || ctx.characterName || '');
    }
    element.querySelector = (selector) => {
      if (isText || isButtons || isCounter || isLeft || isRight) return null;
      if (selectorHasMesBlockInnerCompat(selector)) return getParentMessageElementCompat(numericIndex, 'mes_block');
      if (selectorHasMessageTextCompat(selector)) return getParentMessageElementCompat(numericIndex, 'mes_text');
      if (/\\.name_text\\b|\\bname_text\\b/i.test(String(selector || ''))) return getParentMessageElementCompat(numericIndex, 'name_text');
      if (/\\.ch_name\\b|\\bch_name\\b/i.test(String(selector || ''))) return getParentMessageElementCompat(numericIndex, 'ch_name');
      if (/\\.avatar\\s+img|img\\b/i.test(String(selector || '')) && kind === 'avatar') return getParentMessageElementCompat(numericIndex, 'avatar_img');
      if (/\\.avatar\\b|\\bavatar\\b/i.test(String(selector || ''))) return getParentMessageElementCompat(numericIndex, 'avatar');
      if (/\\.timestamp\\b|\\btimestamp\\b/i.test(String(selector || ''))) return getParentMessageElementCompat(numericIndex, 'timestamp');
      if (/\\.mes_buttons\\b|mes_buttons|message-buttons/i.test(String(selector || ''))) return getParentMessageElementCompat(numericIndex, 'mes_buttons');
      if (/swipe_left|swipe-left|\\.swipe_left\\b|\\.swipe-button-left/i.test(String(selector || ''))) return getParentMessageElementCompat(numericIndex, 'swipe_left');
      if (/swipe_right|swipe-right|\\.swipe_right\\b|\\.swipe-button-right/i.test(String(selector || ''))) return getParentMessageElementCompat(numericIndex, 'swipe_right');
      if (/swipe_counter|swipe-counter|\\.swipes-counter|\\.swipe_counter/i.test(String(selector || ''))) return getParentMessageElementCompat(numericIndex, 'swipe_counter');
      return null;
    };
    element.querySelectorAll = (selector) => {
      const found = element.querySelector(selector);
      return found ? [found] : [];
    };
    parentMessageElementCache.set(key, element);
    return element;
  };
  const submitParentDraftCompat = () => {
    const content = String(parentElementStore.send_textarea?.value || '').trim();
    if (!content) return;
    parentElementStore.send_textarea.value = '';
    post({ type: 'st:setInputDraft', content: '' });
    void sendMessageCompat(content, { source: 'parent-send-button' });
  };
  // 双向同步：Palink 真实输入框变化 → 虚拟 #send_textarea（供 ST 插件读取）。
  // NativeRoleplayChat 的输入框 onChange 会派发 palink:input_draft_changed 事件。
  window.addEventListener('palink:input_draft_changed', (event) => {
    const content = event?.detail?.content;
    if (typeof content === 'string' && parentElementStore?.send_textarea) {
      parentElementStore.send_textarea.value = content;
    }
  });
  Object.assign(parentElementStore, {
    send_textarea: createParentVirtualElementCompat('send_textarea', 'TEXTAREA', 'send_textarea', {
      dispatch(_event, eventType) {
        if (eventType === 'input' || eventType === 'change') {
          post({ type: 'st:setInputDraft', content: String(parentElementStore.send_textarea.value || '') });
        }
      },
    }),
    send_but: createParentVirtualElementCompat('send_but', 'BUTTON', 'send_but', {
      click: submitParentDraftCompat,
    }),
    send_form: createParentVirtualElementCompat('send_form', 'FORM', 'send_form', {
      dispatch(_event, eventType) {
        if (eventType === 'submit') submitParentDraftCompat();
      },
    }),
    chat: createParentVirtualElementCompat('chat', 'DIV', 'chat', {
      text: () => compatChat.map((message) => message.mes || '').join('\\n'),
    }),
    chat_scroll: createParentVirtualElementCompat('chat_scroll', 'DIV', 'chat-scroll chat_container', {
      text: () => compatChat.map((message) => message.mes || '').join('\\n'),
    }),
    last_mes: createParentVirtualElementCompat('last_mes', 'DIV', 'mes last_mes', {
      text: () => compatChat[resolveLatestMessageIndexCompat()]?.mes || ctx.messageContent || '',
      dataset: { is_user: 'false' },
    }),
    mes: createParentVirtualElementCompat('mes', 'DIV', 'mes last_mes', {
      text: () => compatChat[resolveLatestMessageIndexCompat()]?.mes || ctx.messageContent || '',
      dataset: { is_user: 'false' },
    }),
    mes_text: createParentVirtualElementCompat('mes_text', 'DIV', 'mes_text', {
      text: () => compatChat[resolveLatestMessageIndexCompat()]?.mes || ctx.messageContent || '',
      html: () => {
        const index = resolveLatestMessageIndexCompat();
        const message = compatChat[index];
        return messageFormattingCompat(message?.mes || ctx.messageContent || '', message?.name, Boolean(message?.is_system), Boolean(message?.is_user), index);
      },
      onSetText: (value) => {
        const index = resolveLatestMessageIndexCompat();
        const message = compatChat[index];
        setMessageDisplayTextCompat(htmlEscapeCompat(value), message?.message_id ?? message?.id ?? index, { index, source: 'parent-dom-text' });
      },
      onSetHtml: (value) => {
        const index = resolveLatestMessageIndexCompat();
        const message = compatChat[index];
        setMessageDisplayTextCompat(value, message?.message_id ?? message?.id ?? index, { index, source: 'parent-dom-html' });
      },
    }),
    mes_buttons: createParentVirtualElementCompat('mes_buttons', 'DIV', 'mes_buttons'),
    swipe_left: createParentVirtualElementCompat('swipe_left', 'BUTTON', 'swipe_left', {
      click: () => { void swipeCompat(null, -1, { source: 'parent-dom' }); },
    }),
    swipe_right: createParentVirtualElementCompat('swipe_right', 'BUTTON', 'swipe_right', {
      click: () => { void swipeCompat(null, 1, { source: 'parent-dom' }); },
    }),
    swipe_counter: createParentVirtualElementCompat('swipe_counter', 'SPAN', 'swipe_counter', {
      text: () => {
        const message = compatChat[resolveMessageIndex(ctx.messageId, {})];
        const count = Array.isArray(message?.swipes) ? message.swipes.length : 1;
        return String(Number(message?.swipe_id || 0) + 1) + '/' + String(Math.max(1, count));
      },
    }),
  });
  parentElementStore.send_form.requestSubmit = () => parentElementStore.send_but.click();
  parentElementStore.send_form.submit = () => parentElementStore.send_but.click();
  const getParentElementsBySelectorCompat = (selector) => {
    const normalized = normalizeParentSelectorCompat(selector);
    if (!normalized) return [];
    const dynamicIndexes = getMessageIndexesFromSelectorCompat(normalized);
    if (dynamicIndexes.length && (
      selectorHasMessageTextCompat(normalized)
      || selectorHasMesBlockInnerCompat(normalized)
      || selectorHasNameCompat(normalized)
      || selectorHasAvatarCompat(normalized)
      || selectorHasTimestampCompat(normalized)
      || /\\.mes_buttons\\b|mes_buttons|message-buttons/i.test(normalized)
      || selectorHasSwipeElementCompat(normalized)
      || selectorHasMessageBlockCompat(normalized)
    )) {
      let kind = 'mes';
      if (selectorHasMessageTextCompat(normalized)) kind = 'mes_text';
      else if (/\\.name_text\\b|\\bname_text\\b/i.test(normalized)) kind = 'name_text';
      else if (/\\.ch_name\\b|\\bch_name\\b/i.test(normalized)) kind = 'ch_name';
      else if (/\\.avatar\\s+img|img\\b.*\\.avatar|force_avatar|original_avatar/i.test(normalized)) kind = 'avatar_img';
      else if (selectorHasAvatarCompat(normalized)) kind = 'avatar';
      else if (selectorHasTimestampCompat(normalized)) kind = 'timestamp';
      else if (selectorHasMesBlockInnerCompat(normalized)) kind = 'mes_block';
      else if (/\\.mes_buttons\\b|mes_buttons|message-buttons/i.test(normalized)) kind = 'mes_buttons';
      else if (/swipe_left|swipe-left|\\.swipe_left\\b|\\.swipe-button-left/i.test(normalized)) kind = 'swipe_left';
      else if (/swipe_right|swipe-right|\\.swipe_right\\b|\\.swipe-button-right/i.test(normalized)) kind = 'swipe_right';
      else if (/swipe_counter|swipe-counter|\\.swipes-counter|\\.swipe_counter/i.test(normalized)) kind = 'swipe_counter';
      return dynamicIndexes.map((index) => getParentMessageElementCompat(index, kind)).filter(Boolean);
    }
    return Object.values(parentElementStore).filter((element) => parentSelectorMatchesCompat(normalized, element.id));
  };
  const getParentElementBySelectorCompat = (selector) => {
    return getParentElementsBySelectorCompat(selector)[0] || null;
  };
  const createElementsFromHtmlCompat = (html) => {
    const template = document.createElement('template');
    template.innerHTML = String(html || '').trim();
    // [P2-CREATE-OWNERDOC] template.content 的子节点属于「模板内容文档」，不是本帧文档：
    // 线上实测那份文档没有 documentElement、childNodes 为 0、location 为 null、URL about:blank，
    // 且两次调用拿到的是同一个对象（HTMLTemplateElement 规范行为，不是谁造的临时文档）。
    // 真 jQuery 交付的节点归本帧文档 ⇒ 这里与之对齐，把解析结果归入 live document，
    // 下游按 ownerDocument 判归属时不再把节点当外来物。
    var created = [];
    Array.from(template.content.childNodes).forEach(function(node) {
      if (node.nodeType !== 1) return;
      created.push(node.ownerDocument === document ? node : document.importNode(node, true));
    });
    return created;
  };
  // [P2-MOVE-ARG-KIND] append/prepend 的入参判定：兼容层集合是 nativeFallback Proxy，
  // 对它取任何未知属性都会返回一个函数，所以旧写法「if value 的 nodeType 为真就把整条集合
  // 交给 appendChild」恒成立 —— 于是 append(集合) 与 appendTo/prependTo（内部就是
  // targets.append(this)）双双抛 TypeError 又被 catch 吞掉，整段静默空转：
  // 卡侧「建容器 → 把 head 里的 style 塞进容器 → appendTo head」因此样式永远回不到生效文档。
  // 判节点必须用「nodeType 是数字」这种严格形状；集合一律摊平成节点数组。
  const isDomNodeLikeCompat = (value) => Boolean(value) && typeof value === 'object'
    && typeof value.nodeType === 'number' && value.nodeType > 0;
  const dollarMoveTargetsCompat = (value) => {
    if (value === undefined || value === null) return [];
    if (typeof value === 'string') return [value];
    if (isDomNodeLikeCompat(value)) return [value];
    if (Array.isArray(value) || typeof value.get === 'function') {
      try {
        var listed = typeof value.get === 'function' ? value.get() : value;
        return Array.prototype.slice.call(listed || []);
      } catch {
        try { return Array.prototype.slice.call(value || []); } catch { return []; }
      }
    }
    return [value];
  };
  const dollarMovedItemMarkupCompat = (item) => {
    if (item && typeof item === 'object' && item.__palinkParentElement) return String(item.innerHTML || '');
    return String(item === undefined || item === null ? '' : item);
  };
  const parentDocumentStore = {
    __palinkParentDocument: true,
    getElementById(id) {
      const key = String(id || '').trim();
      return parentElementStore[key] || null;
    },
    querySelector(selector) {
      return getParentElementBySelectorCompat(selector);
    },
    querySelectorAll(selector) {
      return getParentElementsBySelectorCompat(selector);
    },
    getElementsByClassName(className) {
      const wanted = String(className || '').trim();
      if (!wanted) return [];
      if (wanted === 'mes') return compatChat.map((_message, index) => getParentMessageElementCompat(index, 'mes')).filter(Boolean);
      if (wanted === 'last_mes') {
        const latestIndex = resolveLatestMessageIndexCompat();
        return latestIndex >= 0 ? [getParentMessageElementCompat(latestIndex, 'mes')].filter(Boolean) : [];
      }
      if (wanted === 'mes_text') return compatChat.map((_message, index) => getParentMessageElementCompat(index, 'mes_text')).filter(Boolean);
      if (wanted === 'mes_block') return compatChat.map((_message, index) => getParentMessageElementCompat(index, 'mes_block')).filter(Boolean);
      if (wanted === 'ch_name') return compatChat.map((_message, index) => getParentMessageElementCompat(index, 'ch_name')).filter(Boolean);
      if (wanted === 'name_text') return compatChat.map((_message, index) => getParentMessageElementCompat(index, 'name_text')).filter(Boolean);
      if (wanted === 'avatar') return compatChat.map((_message, index) => getParentMessageElementCompat(index, 'avatar')).filter(Boolean);
      if (wanted === 'timestamp') return compatChat.map((_message, index) => getParentMessageElementCompat(index, 'timestamp')).filter(Boolean);
      if (wanted === 'mes_buttons') return compatChat.map((_message, index) => getParentMessageElementCompat(index, 'mes_buttons')).filter(Boolean);
      return Object.values(parentElementStore).filter((element) => (
        String(element.className || '').split(/\\s+/).includes(wanted)
      ));
    },
    getElementsByTagName(tagName) {
      const tag = String(tagName || '').toLowerCase();
      if (tag === 'textarea') return [parentElementStore.send_textarea];
      if (tag === 'button') return [parentElementStore.send_but, parentElementStore.swipe_left, parentElementStore.swipe_right];
      if (tag === 'form') return [parentElementStore.send_form];
      return Object.values(parentElementStore).filter((element) => String(element.tagName || '').toLowerCase() === tag);
    },
    addEventListener() {},
    removeEventListener() {},
    dispatchEvent() { return true; },
    createEvent() { return { initEvent() {} }; },
  };
  const readyCompat = (callback) => {
    if (typeof callback !== 'function') return;
    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', () => callback.call(document), { once: true });
    } else {
      setTimeout(() => callback.call(document), 0);
    }
  };
  const createParentDollarCollectionCompat = (nodes) => {
    const collection = Array.from(nodes || []);
    collection.ready = function(cb) { readyCompat(cb); return this; };
    collection.each = function(cb) {
      if (typeof cb === 'function') this.forEach((node, index) => cb.call(node, index, node));
      return this;
    };
    collection.on = function(type, selectorOrCallback, maybeCallback) {
      const eventType = String(type || '');
      const hasDelegatedSelector = typeof selectorOrCallback === 'string';
      const cb = hasDelegatedSelector ? maybeCallback : selectorOrCallback;
      if (typeof cb !== 'function') return this;
      const delegatedNodes = hasDelegatedSelector ? getParentElementsBySelectorCompat(selectorOrCallback) : [];
      const targets = Array.from(new Set([...(this || []), ...delegatedNodes]));
      targets.forEach((node) => node.addEventListener?.(eventType, function(event) {
        if (!hasDelegatedSelector || node.matches?.(selectorOrCallback) || event?.target?.matches?.(selectorOrCallback)) {
          return cb.call(node, event, event?.target || node);
        }
        return undefined;
      }));
      return this;
    };
    collection.off = function(type, cb) {
      this.forEach((node) => node.removeEventListener?.(type, cb));
      return this;
    };
    collection.click = function(cb) {
      if (typeof cb === 'function') return this.on('click', cb);
      this.forEach((node) => node.click?.());
      return this;
    };
    collection.submit = function(cb) {
      if (typeof cb === 'function') return this.on('submit', cb);
      this.forEach((node) => node.requestSubmit?.() || node.submit?.());
      return this;
    };
    collection.val = function(value) {
      if (value === undefined) return this[0]?.value ?? '';
      this.forEach((node) => {
        if ('value' in node) node.value = String(value ?? '');
      });
      return this;
    };
    collection.trigger = function(type) {
      const eventType = typeof type === 'string' ? type : type?.type;
      if (!eventType) return this;
      this.forEach((node) => {
        if (eventType === 'click' && typeof node.click === 'function') {
          node.click();
          return;
        }
        const event = new Event(eventType, { bubbles: true, cancelable: true });
        node.dispatchEvent?.(event);
        if (eventType === 'submit' && !event.defaultPrevented) node.requestSubmit?.();
      });
      return this;
    };
    collection.text = function(value) {
      if (value === undefined) return this.map((node) => node.textContent || '').join('');
      this.forEach((node) => { try { node.textContent = String(value ?? ''); } catch (palinkDiagErr) { palinkDiagRecord({ owner: 'frame_compat', kind: 'compat_catch_swallowed', name: 'part-04:dollar-text-set', detail: '兼容层 try 内异常被吞掉，处置未改（继续往下走，返回值不变）', stack: String((palinkDiagErr && palinkDiagErr.stack) || '') }) } });
      return this;
    };
    collection.html = function(value) {
      if (value === undefined) return this[0]?.innerHTML ?? '';
      this.forEach((node) => { try { node.innerHTML = String(value ?? ''); } catch (palinkDiagErr) { palinkDiagRecord({ owner: 'frame_compat', kind: 'compat_catch_swallowed', name: 'part-04:dollar-html-set', detail: '兼容层 try 内异常被吞掉，处置未改（继续往下走，返回值不变）', stack: String((palinkDiagErr && palinkDiagErr.stack) || '') }) } });
      return this;
    };
    collection.append = function(value) {
      // [P2-MOVE-ARG-KIND] 与真 jQuery 对齐：集合参数摊平成节点后逐个搬，
      // 节点本身不克隆（跨文档由 appendChild 自己 adopt），字符串走 insertAdjacentHTML。
      var items = dollarMoveTargetsCompat(value);
      this.forEach((node) => {
        items.forEach(function(item) {
          try {
            if (isDomNodeLikeCompat(item)) node.appendChild?.(item);
            else node.insertAdjacentHTML?.('beforeend', dollarMovedItemMarkupCompat(item));
          } catch (palinkDiagErr) { palinkDiagRecord({ owner: 'frame_compat', kind: 'compat_catch_swallowed', name: 'part-04:dollar-append-move', detail: '兼容层 try 内异常被吞掉，处置未改（继续往下走，返回值不变）', stack: String((palinkDiagErr && palinkDiagErr.stack) || '') }) }
        });
      });
      return this;
    };
    collection.prepend = function(value) {
      // [P2-MOVE-ARG-KIND] 同 append：先摊平集合，再按倒序插到最前，结果与 jQuery 一致。
      var items = dollarMoveTargetsCompat(value);
      this.forEach((node) => {
        var head = node.firstChild || null;
        items.slice().reverse().forEach(function(item) {
          try {
            if (isDomNodeLikeCompat(item)) node.insertBefore?.(item, head);
            else node.insertAdjacentHTML?.('afterbegin', dollarMovedItemMarkupCompat(item));
          } catch (palinkDiagErr) { palinkDiagRecord({ owner: 'frame_compat', kind: 'compat_catch_swallowed', name: 'part-04:dollar-prepend-move', detail: '兼容层 try 内异常被吞掉，处置未改（继续往下走，返回值不变）', stack: String((palinkDiagErr && palinkDiagErr.stack) || '') }) }
        });
      });
      return this;
    };
    collection.appendTo = function(target) {
      const targets = typeof target === 'string'
        ? parentDollarCompat(target)
        : createParentDollarCollectionCompat(target?.nodeType ? [target] : Array.from(target || []));
      targets.append(this);
      return this;
    };
    collection.prependTo = function(target) {
      const targets = typeof target === 'string'
        ? parentDollarCompat(target)
        : createParentDollarCollectionCompat(target?.nodeType ? [target] : Array.from(target || []));
      targets.prepend(this);
      return this;
    };
    collection.remove = function() {
      this.forEach((node) => { try { node.remove?.(); } catch (palinkDiagErr) { palinkDiagRecord({ owner: 'frame_compat', kind: 'compat_catch_swallowed', name: 'part-04:dollar-remove', detail: '兼容层 try 内异常被吞掉，处置未改（继续往下走，返回值不变）', stack: String((palinkDiagErr && palinkDiagErr.stack) || '') }) } });
      return this;
    };
    collection.show = function() {
      this.forEach((node) => { try { node.style.display = ''; } catch (palinkDiagErr) { palinkDiagRecord({ owner: 'frame_compat', kind: 'compat_catch_swallowed', name: 'part-04:dollar-show', detail: '兼容层 try 内异常被吞掉，处置未改（继续往下走，返回值不变）', stack: String((palinkDiagErr && palinkDiagErr.stack) || '') }) } });
      return this;
    };
    collection.hide = function() {
      this.forEach((node) => { try { node.style.display = 'none'; } catch (palinkDiagErr) { palinkDiagRecord({ owner: 'frame_compat', kind: 'compat_catch_swallowed', name: 'part-04:dollar-hide', detail: '兼容层 try 内异常被吞掉，处置未改（继续往下走，返回值不变）', stack: String((palinkDiagErr && palinkDiagErr.stack) || '') }) } });
      return this;
    };
`;
