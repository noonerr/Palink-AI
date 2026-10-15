/**
 * ST 兼容运行时体 · 第 05 段
 *
 * 机械拆分自 SillyTavernCompatRuntime.ts 原第 3790-4679 行，逐字节搬运，未改任何逻辑。
 * 内容是注入智能卡 iframe 的 JS 源码文本。
 *
 * 约束（改动前必读）：
 *  1. 本段是模板字符串：新增注释与代码里不得出现裸反引号，正则一律 new RegExp()。
 *  2. 各段拼接顺序由 SillyTavernCompatRuntime.ts 的
 *     buildSillyTavernCompatRuntimeBodyScript 固定（按行号升序），不可调换。
 *  3. 段内跨段引用的标识符靠 IIFE 闭包共享，不要单独求值某一段。
 */

export const RUNTIME_BODY_PART_05 = `    collection.empty = function() {
      this.forEach((node) => { try { node.innerHTML = ''; } catch {} });
      return this;
    };
    collection.find = function(selector) {
      const nodes = this.flatMap((node) => Array.from(node.querySelectorAll?.(selector) || []));
      return createParentDollarCollectionCompat(nodes);
    };
    collection.closest = function(selector) {
      const nodes = this.map((node) => node.closest?.(selector)).filter(Boolean);
      return createParentDollarCollectionCompat(nodes);
    };
    collection.filter = function(selectorOrCallback) {
      const nodes = typeof selectorOrCallback === 'function'
        ? Array.prototype.filter.call(this, (node, index) => selectorOrCallback.call(node, index, node))
        : Array.prototype.filter.call(this, (node) => node.matches?.(selectorOrCallback));
      return createParentDollarCollectionCompat(nodes);
    };
    collection.first = function() { return createParentDollarCollectionCompat(this.length ? [this[0]] : []); };
    collection.last = function() { return createParentDollarCollectionCompat(this.length ? [this[this.length - 1]] : []); };
    collection.eq = function(index) {
      const resolved = Number(index) < 0 ? this.length + Number(index) : Number(index);
      return createParentDollarCollectionCompat(this[resolved] ? [this[resolved]] : []);
    };
    collection.addClass = function(value) {
      const classes = String(value || '').split(/\\s+/).filter(Boolean);
      this.forEach((node) => {
        const current = new Set(String(node.className || '').split(/\\s+/).filter(Boolean));
        classes.forEach((item) => current.add(item));
        node.className = Array.from(current).join(' ');
      });
      return this;
    };
    collection.removeClass = function(value) {
      const classes = String(value || '').split(/\\s+/).filter(Boolean);
      this.forEach((node) => {
        const current = new Set(String(node.className || '').split(/\\s+/).filter(Boolean));
        classes.forEach((item) => current.delete(item));
        node.className = Array.from(current).join(' ');
      });
      return this;
    };
    collection.hasClass = function(value) {
      return String(this[0]?.className || '').split(/\\s+/).includes(String(value || ''));
    };
    collection.css = function(name, value) {
      if (typeof name === 'string' && value === undefined) return this[0]?.style?.[name] || '';
      this.forEach((node) => {
        if (!node.style) node.style = {};
        if (typeof name === 'object') Object.entries(name).forEach(([key, val]) => { node.style[key] = String(val ?? ''); });
        else node.style[name] = String(value ?? '');
      });
      return this;
    };
    collection.attr = function(name, value) {
      if (typeof name === 'string' && value === undefined) return this[0]?.getAttribute?.(name);
      this.forEach((node) => {
        if (typeof name === 'object') {
          Object.entries(name).forEach(([key, val]) => node.setAttribute?.(key, String(val)));
        } else if (value === null) {
          node.removeAttribute?.(name);
        } else {
          node.setAttribute?.(name, String(value));
        }
      });
      return this;
    };
    collection.prop = function(name, value) {
      if (typeof name === 'string' && value === undefined) return this[0]?.[name];
      this.forEach((node) => {
        if (typeof name === 'object') {
          Object.entries(name).forEach(([key, val]) => { try { node[key] = val; } catch {} });
        } else {
          try { node[name] = value; } catch {}
        }
      });
      return this;
    };
    collection.get = function(index) {
      if (index === undefined) return Array.from(this);
      const resolved = Number(index) < 0 ? this.length + Number(index) : Number(index);
      return this[resolved];
    };
    // [STATUSBAR-COMPAT] 补齐 ST 卡片/插件脚本常用的 jQuery 方法（父级集合缺这些会抛
    // "xxx is not a function"，如 $("selector").blur()）。方法与 jQuery 语义对齐。
    collection.blur = function(cb) {
      if (typeof cb === 'function') return this.on('blur', cb);
      this.forEach((node) => { try { node.blur?.(); } catch {} });
      return this;
    };
    collection.focus = function(cb) {
      if (typeof cb === 'function') return this.on('focus', cb);
      this.forEach((node) => { try { node.focus?.(); } catch {} });
      return this;
    };
    collection.toggle = function(force) {
      this.forEach((node) => {
        const wantVisible = force === undefined ? (node.style.display === 'none') : Boolean(force);
        node.style.display = wantVisible ? '' : 'none';
      });
      return this;
    };
    collection.toggleClass = function(value, force) {
      const classes = String(value || '').split(/\\s+/).filter(Boolean);
      this.forEach((node) => {
        classes.forEach((cls) => {
          const has = String(node.className || '').split(/\\s+/).includes(cls);
          const add = force === undefined ? !has : Boolean(force);
          if (add && !has) node.className = (String(node.className || '') + ' ' + cls).replace(/^\\s+/, '');
          if (!add && has) node.className = String(node.className || '').split(/\\s+/).filter((c) => c !== cls).join(' ');
        });
      });
      return this;
    };
    collection.is = function(selector) {
      return this.some((node) => {
        if (typeof node.matches === 'function') return node.matches(selector);
        return false;
      });
    };
    collection.not = function(selectorOrNodes) {
      const excluded = typeof selectorOrNodes === 'string'
        ? Array.from(document.querySelectorAll(selectorOrNodes))
        : Array.from(selectorOrNodes || []);
      return createParentDollarCollectionCompat(this.filter((node) => !excluded.includes(node)));
    };
    collection.children = function(selector) {
      const nodes = this.flatMap((node) => Array.from(node.children || []));
      return createParentDollarCollectionCompat(selector ? nodes.filter((n) => n.matches?.(selector)) : nodes);
    };
    collection.parent = function() {
      const nodes = this.map((node) => node.parentNode).filter(Boolean);
      return createParentDollarCollectionCompat(Array.from(new Set(nodes)));
    };
    collection.parents = function(selector) {
      const nodes = this.flatMap((node) => {
        const out = [];
        let p = node.parentNode;
        while (p && p.nodeType === 1) {
          if (!selector || p.matches?.(selector)) out.push(p);
          p = p.parentNode;
        }
        return out;
      });
      return createParentDollarCollectionCompat(Array.from(new Set(nodes)));
    };
    collection.siblings = function(selector) {
      const nodes = this.flatMap((node) => Array.from(node.parentNode?.children || []).filter((s) => s !== node));
      return createParentDollarCollectionCompat(selector ? nodes.filter((n) => n.matches?.(selector)) : nodes);
    };
    collection.index = function(selector) {
      if (selector !== undefined) {
        const target = typeof selector === 'string' ? document.querySelector(selector) : (selector && selector[0]);
        return this.indexOf(target);
      }
      const node = this[0];
      if (!node?.parentNode) return -1;
      return Array.from(node.parentNode.children).indexOf(node);
    };
    collection.width = function(value) {
      if (value === undefined) return this[0]?.offsetWidth ?? 0;
      this.forEach((node) => { node.style.width = String(typeof value === 'number' ? value + 'px' : value ?? ''); });
      return this;
    };
    collection.height = function(value) {
      if (value === undefined) return this[0]?.offsetHeight ?? 0;
      this.forEach((node) => { node.style.height = String(typeof value === 'number' ? value + 'px' : value ?? ''); });
      return this;
    };
    collection.outerWidth = function() { return this[0]?.offsetWidth ?? 0; };
    collection.outerHeight = function() { return this[0]?.offsetHeight ?? 0; };
    collection.data = function(key, value) {
      if (value === undefined) {
        if (key === undefined) {
          const all = {};
          this[0]?.getAttributeNames?.().forEach((name) => {
            if (name.startsWith('data-')) all[name.slice(5)] = this[0].getAttribute(name);
          });
          return all;
        }
        return this[0]?.getAttribute?.('data-' + String(key).replace(/[A-Z]/g, (c) => '-' + c.toLowerCase()));
      }
      this.forEach((node) => node.setAttribute?.('data-' + String(key).replace(/[A-Z]/g, (c) => '-' + c.toLowerCase()), String(value)));
      return this;
    };
    collection.before = function(value) {
      this.forEach((node) => {
        try {
          if (value?.nodeType) node.parentNode?.insertBefore?.(value.cloneNode?.(true) ?? value, node);
          else node.insertAdjacentHTML?.('beforebegin', String(value ?? ''));
        } catch {}
      });
      return this;
    };
    collection.after = function(value) {
      this.forEach((node) => {
        try {
          if (value?.nodeType) node.parentNode?.insertBefore?.(value.cloneNode?.(true) ?? value, node.nextSibling);
          else node.insertAdjacentHTML?.('afterend', String(value ?? ''));
        } catch {}
      });
      return this;
    };
    collection.wrap = function(wrapper) {
      this.forEach((node) => {
        try {
          const wrapEl = typeof wrapper === 'string' ? document.createElement(wrapper) : wrapper.cloneNode?.(true);
          if (!wrapEl) return;
          node.parentNode?.insertBefore?.(wrapEl, node);
          wrapEl.appendChild?.(node);
        } catch {}
      });
      return this;
    };
    collection.unwrap = function() {
      this.forEach((node) => {
        try {
          const parent = node.parentNode;
          if (parent && parent.parentNode) {
            while (parent.firstChild) parent.parentNode.insertBefore(parent.firstChild, parent);
            parent.remove();
          }
        } catch {}
      });
      return this;
    };
    collection.hover = function(inCb, outCb) {
      if (typeof inCb === 'function') this.on('mouseenter', inCb);
      if (typeof outCb === 'function') this.on('mouseleave', outCb);
      return this;
    };
    collection.one = function(type, selectorOrCallback, maybeCallback) {
      const eventType = String(type || '');
      const cb = typeof selectorOrCallback === 'string' ? maybeCallback : selectorOrCallback;
      if (typeof cb !== 'function') return this;
      this.forEach((node) => {
        const handler = function(event) {
          node.removeEventListener(eventType, handler);
          cb.call(node, event, event?.target || node);
        };
        node.addEventListener(eventType, handler);
      });
      return this;
    };
    collection.scrollTop = function(value) {
      if (value === undefined) return this[0]?.scrollTop ?? 0;
      this.forEach((node) => { node.scrollTop = value; });
      return this;
    };
    collection.offset = function() {
      const r = this[0]?.getBoundingClientRect?.();
      if (!r) return undefined;
      return { top: r.top + (window.scrollY || 0), left: r.left + (window.scrollX || 0) };
    };
    collection.position = function() {
      const node = this[0];
      if (!node) return undefined;
      const offsetParent = node.offsetParent;
      if (!offsetParent) return { top: 0, left: 0 };
      const r = node.getBoundingClientRect();
      const pr = offsetParent.getBoundingClientRect();
      return { top: r.top - pr.top, left: r.left - pr.left };
    };
    collection.fadeIn = function() { return this.show(); };
    collection.fadeOut = function() { return this.hide(); };
    collection.fadeToggle = function() { return this.toggle(); };
    collection.slideToggle = function() { return this.toggle(); };
    collection.slideUp = function() { return this.hide(); };
    collection.slideDown = function() { return this.show(); };
    collection.animate = function() { return this; };
    collection.delay = function() { return this; };
    collection.serialize = function() {
      const getVal = (node) => {
        if (node.name === undefined) return [];
        if (['checkbox', 'radio'].includes(node.type)) return node.checked ? [[node.name, node.value]] : [];
        return [[node.name, node.value]];
      };
      return this.flatMap((node) => getVal(node).map(([k, v]) => encodeURIComponent(k) + '=' + encodeURIComponent(v))).join('&');
    };
    // 其余未显式定义的方法：通用委托到原生 DOM 方法（$el.blur() → el.blur()），
    // 避免未知 jQuery 方法抛 "is not a function"；若元素无该原生方法则空转返回自身以支持链式。
    const nativeFallback = new Proxy(collection, {
      get(target, prop, receiver) {
        if (prop in target || prop in Array.prototype || typeof prop === 'symbol') {
          return Reflect.get(target, prop, receiver);
        }
        return function(...args) {
          target.forEach((node) => {
            try { if (typeof node[prop] === 'function') node[prop].apply(node, args); } catch {}
          });
          return target;
        };
      },
    });
    return nativeFallback;
  };
  // [STATUSBAR-COMPAT] 仅接受真实 jQuery（带 fn.jquery 版本标识），排除 legacyShim 注入的
  // 简易 dollar（其集合缺少 .blur() 等 jQuery 方法）。若误捕获 legacy dollar，委托会返回
  // 无 blur 方法的集合，导致 $("...").blur() 抛 "is not a function"。真实 jQuery 由卡片
  // <script src> 加载后通过下方 bridge setter 更新 realDollarCompat。
  // 注意：本函数位于 buildSillyTavernCompatRuntimeV2Shim 的模板字符串内，TS 不会剥离
  // 类型标注，故不写 (fn: unknown): boolean / as any，避免生成非法 JS（Unexpected token ':'）。
  const isRealJQueryCompat = (fn) =>
    typeof fn === 'function' && Boolean(fn?.fn?.jquery);
  let realDollarCompat = (() => {
    if (isRealJQueryCompat(window.jQuery)) return window.jQuery;
    if (isRealJQueryCompat(window.$)) return window.$;
    return null;
  })();
  let bridgedDollarCompat;
  const fallbackDollarCompat = (arg) => {
    if (typeof arg === 'function') {
      readyCompat(arg);
      return createParentDollarCollectionCompat([document]);
    }
    if (arg === parentDocumentStore || arg?.__palinkParentElement) {
      return createParentDollarCollectionCompat([arg]);
    }
    if (typeof arg === 'string') {
      if (/^\\s*</.test(arg)) return createParentDollarCollectionCompat(createElementsFromHtmlCompat(arg));
      ensureStExtensionSettingsSelectorCompat(arg);
      try { return createParentDollarCollectionCompat(Array.from(document.querySelectorAll(arg))); } catch {}
    }
    if (arg?.nodeType) return createParentDollarCollectionCompat([arg]);
    if (Array.isArray(arg)) return createParentDollarCollectionCompat(arg);
    return createParentDollarCollectionCompat([]);
  };
  const parentDollarCompat = (arg, ...args) => {
    if (typeof arg === 'function') {
      if (typeof realDollarCompat === 'function' && realDollarCompat !== bridgedDollarCompat) {
        return realDollarCompat(arg, ...args);
      }
      readyCompat(arg);
      return createParentDollarCollectionCompat([document]);
    }
    if (arg === parentDocumentStore || arg?.__palinkParentElement) {
      return createParentDollarCollectionCompat([arg]);
    }
    if (typeof arg === 'string') {
      if (/^\\s*</.test(arg)) return createParentDollarCollectionCompat(createElementsFromHtmlCompat(arg));
      ensureStExtensionSettingsSelectorCompat(arg);
      const parentElements = getParentElementsBySelectorCompat(arg);
      if (parentElements.length) return createParentDollarCollectionCompat(parentElements);
    }
    if (typeof realDollarCompat === 'function' && realDollarCompat !== bridgedDollarCompat) {
      return realDollarCompat(arg, ...args);
    }
    return fallbackDollarCompat(arg);
  };
  bridgedDollarCompat = new Proxy(function(arg, ...args) {
    return parentDollarCompat(arg, ...args);
  }, {
    get(target, prop) {
      if (prop in target) return target[prop];
      return realDollarCompat?.[prop];
    },
    set(target, prop, value) {
      if (realDollarCompat && realDollarCompat !== target) {
        try { realDollarCompat[prop] = value; return true; } catch {}
      }
      target[prop] = value;
      return true;
    },
    apply(_target, thisArg, args) {
      return parentDollarCompat.apply(thisArg, args);
    },
  });
  const installDollarBridgeCompat = (name) => {
    try {
      Object.defineProperty(window, name, {
        configurable: true,
        get() { return bridgedDollarCompat; },
        set(value) {
          if (isRealJQueryCompat(value) && value !== bridgedDollarCompat) realDollarCompat = value;
        },
      });
    } catch {
      window[name] = bridgedDollarCompat;
    }
  };
  installDollarBridgeCompat('$');
  installDollarBridgeCompat('jQuery');
  const resolveMessageIndex = (messageId = ctx.messageId, options = {}) => {
    if (Number.isFinite(Number(options?.index))) {
      const byOption = Number(options.index);
      if (byOption >= 0 && byOption < compatChat.length) return byOption;
    }
    if (messageId !== undefined && messageId !== null && messageId !== '') {
      const byId = compatChat.findIndex((message) => String(message.id) === String(messageId) || String(message.message_id) === String(messageId));
      if (byId >= 0) return byId;
      const asIndex = Number(messageId);
      if (Number.isInteger(asIndex) && asIndex >= 0 && asIndex < compatChat.length) return asIndex;
    }
    if (currentMessageIndex >= 0 && currentMessageIndex < compatChat.length) return currentMessageIndex;
    return compatChat.length > 0 ? compatChat.length - 1 : 0;
  };
  const resolveLatestMessageIndexCompat = () => {
    for (let index = compatChat.length - 1; index >= 0; index -= 1) {
      const message = compatChat[index];
      if (message && !message.is_system) return index;
    }
    return resolveMessageIndex(ctx.messageId, {});
  };
  // ST 兼容：插件读取消息文本时剥离 Palink 渲染专用的 <style> 块（原版 ST 的 mes
  // 是纯文本不含 <style>）。仅作用于返回副本，不影响内部 compatChat（回写/更新逻辑
  // 仍使用原始内容）。
  const stripStyleBlocksForPlugin = (message) => {
    if (!message || typeof message !== 'object') return message;
    const clean = (value) => String(value ?? '').replace(/<style[\\s\\S]*?<\\/style>/gi, '');
    const next = { ...message };
    if (typeof next.mes === 'string') next.mes = clean(next.mes);
    if (typeof next.message === 'string') next.message = clean(next.message);
    if (typeof next.text === 'string') next.text = clean(next.text);
    if (typeof next.content === 'string') next.content = clean(next.content);
    if (Array.isArray(next.swipes)) next.swipes = next.swipes.map(clean);
    return next;
  };
  const getCompatChatMessages = (messageId) => {
    const messages = compatChat;
    if (messageId === undefined || messageId === null || messageId === '') return messages.slice().map(stripStyleBlocksForPlugin);
    if (Number.isInteger(Number(messageId)) && Number(messageId) >= 0) {
      const byIndex = messages[Number(messageId)];
      if (byIndex) return [stripStyleBlocksForPlugin(byIndex)];
      // [P0-FIX 2026-09-30] 数字 id 未命中索引时回退按 id 匹配：ST 语义里 messageId
      // 是聊天数组下标，但 Palink 的 ctx.messageId 是消息的数据库行 id（如 2375），
      // 卡脚本 getChatMessages(getCurrentMessageId()) 会拿到远超数组长度的数字，
      // 只按索引取值必然落空 → 图文排版卡故事区"故事正文为空"。索引优先不变，
      // 未命中再按 id/message_id 匹配，两种语义都能命中。
      const byId = messages.filter((message) => String(message.id) === String(messageId) || String(message.message_id) === String(messageId));
      if (byId.length > 0) return byId.map(stripStyleBlocksForPlugin);
      return [];
    }
    return messages.filter((message) => String(message.id) === String(messageId) || String(message.message_id) === String(messageId)).map(stripStyleBlocksForPlugin);
  };
  const setMessageDisplayTextCompat = (html, messageId = ctx.messageId, options = {}) => {
    const index = resolveMessageIndex(messageId, options);
    const message = compatChat[index];
    if (!message) return false;
    const displayText = String(html ?? '');
    if (!message.extra || typeof message.extra !== 'object') message.extra = {};
    message.extra.display_text = displayText;
    ensureSwipeInfoShape(message);
    const swipeIndex = Math.max(0, Math.min(Number(message.swipe_id || 0), message.swipe_info.length - 1));
    message.swipe_info[swipeIndex] = {
      ...(message.swipe_info[swipeIndex] || {}),
      send_date: message.swipe_info[swipeIndex]?.send_date || message.send_date || '',
      extra: {
        ...(message.swipe_info[swipeIndex]?.extra || {}),
        display_text: displayText,
      },
    };
    syncCtxMessageFromCompat(index);
    emitCompatEvent(window.event_types?.MESSAGE_UPDATED || 'message_updated', index, message);
    const normalizedOptions = options && typeof options === 'object' ? options : {};
    if (normalizedOptions.localOnly || normalizedOptions.persist === false || normalizedOptions.save === false) {
      return true;
    }
    requestParent('setChatMessage', {
      content: message.mes || message.content || '',
      messageId: message.message_id ?? message.id ?? index,
      index,
      options: {
        __palinkHasExplicitContent: false,
        localOnly: true,
        refresh: 'display',
        swipe_id: message.swipe_id,
        swipes: message.swipes,
        swipe_info: message.swipe_info,
        extra: message.extra,
        display_text: displayText,
      },
    }).catch((error) => {
      post({ type: 'error', message: String(error?.message || error) });
    });
    return true;
  };
  const normalizeMessageUpdatePayload = (content, targetMessage, options = {}) => {
    const messageObject = content && typeof content === 'object' ? content : {};
    const mergedOptions = { ...(options && typeof options === 'object' ? options : {}) };
    const hasExplicitContent = Boolean(
      typeof content === 'string'
      || typeof messageObject.content === 'string'
      || typeof messageObject.mes === 'string'
      || typeof messageObject.message === 'string'
      || typeof messageObject.text === 'string'
      || mergedOptions.__palinkHasExplicitContent === true
    );
    const extra = messageObject.extra && typeof messageObject.extra === 'object'
      ? { ...(mergedOptions.extra && typeof mergedOptions.extra === 'object' ? mergedOptions.extra : {}), ...clone(messageObject.extra) }
      : mergedOptions.extra;
    const displayText = mergedOptions.display_text
      ?? mergedOptions.displayText
      ?? messageObject.display_text
      ?? messageObject.displayText;
    const normalizedExtra = typeof displayText === 'string'
      ? { ...(extra && typeof extra === 'object' ? extra : {}), display_text: displayText }
      : extra;
    const resolvedContent = typeof content === 'string'
      ? content
      : String(
        messageObject.content
        ?? messageObject.mes
        ?? messageObject.message
        ?? messageObject.text
        ?? targetMessage?.mes
        ?? targetMessage?.content
        ?? '',
      );
    return {
      content: resolvedContent,
      hasExplicitContent,
      options: {
        ...mergedOptions,
        __palinkHasExplicitContent: hasExplicitContent,
        role: mergedOptions.role ?? messageObject.role,
        name: mergedOptions.name ?? messageObject.name,
        is_user: mergedOptions.is_user ?? messageObject.is_user,
        is_system: mergedOptions.is_system ?? messageObject.is_system,
        is_name: mergedOptions.is_name ?? messageObject.is_name,
        force_avatar: mergedOptions.force_avatar ?? mergedOptions.forceAvatar ?? messageObject.force_avatar ?? messageObject.forceAvatar,
        original_avatar: mergedOptions.original_avatar ?? mergedOptions.originalAvatar ?? messageObject.original_avatar ?? messageObject.originalAvatar,
        avatar: mergedOptions.avatar ?? messageObject.avatar,
        gen_id: mergedOptions.gen_id ?? mergedOptions.genId ?? messageObject.gen_id ?? messageObject.genId,
        group_id: mergedOptions.group_id ?? mergedOptions.groupId ?? messageObject.group_id ?? messageObject.groupId,
        group_name: mergedOptions.group_name ?? mergedOptions.groupName ?? messageObject.group_name ?? messageObject.groupName,
        selected_group: mergedOptions.selected_group ?? mergedOptions.selectedGroup ?? messageObject.selected_group ?? messageObject.selectedGroup,
        groups: mergedOptions.groups ?? messageObject.groups,
        swipe_id: mergedOptions.swipe_id ?? mergedOptions.swipeId ?? messageObject.swipe_id ?? messageObject.swipeId,
        swipes: Array.isArray(mergedOptions.swipes)
          ? mergedOptions.swipes
          : Array.isArray(messageObject.swipes)
            ? messageObject.swipes
            : undefined,
        swipe_info: Array.isArray(mergedOptions.swipe_info)
          ? mergedOptions.swipe_info
          : Array.isArray(messageObject.swipe_info)
            ? messageObject.swipe_info
            : undefined,
        display_text: typeof displayText === 'string' ? displayText : mergedOptions.display_text,
        extra: normalizedExtra,
      },
    };
  };
  const setChatMessageCompat = async (content, messageId = ctx.messageId, options = {}) => {
    const targetIndex = resolveMessageIndex(messageId, options);
    const existingTarget = compatChat[targetIndex];
    const normalizedUpdate = normalizeMessageUpdatePayload(content, existingTarget, options);
    const normalizedContent = normalizedUpdate.content;
    const shouldUpdateContent = normalizedUpdate.hasExplicitContent || !existingTarget;
    const normalizedOptions = normalizedUpdate.options;
    const targetMessage = existingTarget || normalizeChatMessage({ id: messageId, role: 'assistant', content: normalizedContent }, targetIndex);
    compatChat[targetIndex] = targetMessage;
    if (typeof normalizedOptions.role === 'string') targetMessage.role = normalizedOptions.role;
    if (typeof normalizedOptions.name === 'string') targetMessage.name = normalizedOptions.name;
    if (typeof normalizedOptions.is_user === 'boolean') targetMessage.is_user = normalizedOptions.is_user;
    if (typeof normalizedOptions.is_system === 'boolean') targetMessage.is_system = normalizedOptions.is_system;
    const nextSwipes = Array.isArray(normalizedOptions?.swipes) && normalizedOptions.swipes.length
      ? normalizedOptions.swipes.map((item) => String(item ?? ''))
      : Array.isArray(targetMessage.swipes) && targetMessage.swipes.length
        ? targetMessage.swipes.slice()
        : [normalizedContent];
    const nextSwipeId = Number.isFinite(Number(normalizedOptions?.swipe_id ?? normalizedOptions?.swipeId))
      ? Math.max(0, Number(normalizedOptions?.swipe_id ?? normalizedOptions?.swipeId))
      : Number(targetMessage.swipe_id || 0);
    while (nextSwipes.length <= nextSwipeId) nextSwipes.push('');
    if (shouldUpdateContent) nextSwipes[nextSwipeId] = normalizedContent;
    targetMessage.swipes = nextSwipes;
    targetMessage.swipe_id = Math.max(0, Math.min(nextSwipeId, nextSwipes.length - 1));
    if (shouldUpdateContent) {
      targetMessage.mes = normalizedContent;
      targetMessage.content = normalizedContent;
      targetMessage.message = normalizedContent;
      targetMessage.text = normalizedContent;
    }
    if (normalizedOptions?.extra && typeof normalizedOptions.extra === 'object') {
      const nextExtra = stripSwipeInfoFromExtra(normalizedOptions.extra);
      targetMessage.extra = normalizedOptions.replaceExtra
        ? nextExtra
        : { ...(targetMessage.extra || {}), ...nextExtra };
    } else {
      targetMessage.extra = normalizedOptions.replaceExtra ? {} : (targetMessage.extra || {});
    }
    applyStMessageMeta(targetMessage, normalizedOptions, targetMessage.extra || {});
    if (Array.isArray(normalizedOptions.swipe_info)) {
      targetMessage.swipe_info = normalizedOptions.swipe_info.map((entry) => normalizeSwipeInfoEntry(entry, targetMessage.extra, targetMessage.send_date || ''));
    }
    syncMesToSwipeCompat(targetMessage);
    syncCtxMessageFromCompat(targetIndex);
    emitCompatEvent(window.event_types?.MESSAGE_UPDATED || 'message_updated', targetIndex, targetMessage);
    if (normalizedOptions.localOnly || normalizedOptions.persist === false || normalizedOptions.save === false) {
      return { success: true, content: normalizedContent, message: targetMessage };
    }
    const targetMessageId = targetMessage.message_id ?? targetMessage.id ?? messageId;
    return requestParent('setChatMessage', {
      content: normalizedContent,
      messageId: targetMessageId,
      index: targetIndex,
      options: {
        ...normalizedOptions,
        __palinkHasExplicitContent: shouldUpdateContent,
        swipe_id: targetMessage.swipe_id,
        swipes: targetMessage.swipes,
        swipe_info: targetMessage.swipe_info,
        extra: targetMessage.extra,
      },
    });
  };
  const addOneMessageCompat = async (message, options = {}) => {
    const content = typeof message === 'string'
      ? message
      : String(message?.mes ?? message?.content ?? message?.message ?? '');
    if (!content) return true;
    const forceId = Number.isInteger(Number(options?.forceId)) ? Number(options.forceId) : null;
    const insertAfter = Number.isInteger(Number(options?.insertAfter)) ? Number(options.insertAfter) : null;
    const insertBefore = Number.isInteger(Number(options?.insertBefore)) ? Number(options.insertBefore) : null;
    const shouldReplaceSwipe = options?.type === 'swipe';
    const index = shouldReplaceSwipe
      ? resolveMessageIndex(message?.message_id ?? message?.id ?? ctx.messageId, {})
      : forceId !== null
        ? Math.max(0, Math.min(forceId, compatChat.length))
        : insertBefore !== null
          ? Math.max(0, Math.min(insertBefore, compatChat.length))
          : insertAfter !== null
            ? Math.max(0, Math.min(insertAfter + 1, compatChat.length))
            : compatChat.length;
    const normalized = normalizeChatMessage({
      ...(typeof message === 'string' ? {} : message),
      content,
      role: typeof message === 'string'
        ? 'assistant'
        : (message?.role || (message?.is_user ? 'user' : message?.is_system ? 'system' : 'assistant')),
    }, index);
    const messageObject = typeof message === 'string' ? {} : (message || {});
    const appendDisplayText = options?.display_text
      ?? options?.displayText
      ?? messageObject.display_text
      ?? messageObject.displayText;
    if (shouldReplaceSwipe && compatChat[index]) {
      compatChat[index] = normalized;
    } else if (index >= compatChat.length) {
      compatChat.push(normalized);
    } else {
      compatChat.splice(index, 0, normalized);
    }
    compatChat.forEach((item, itemIndex) => { item.mesid = itemIndex; });
    syncSwipeToMesCompat(normalized, normalized.swipe_id);
    if (typeof appendDisplayText === 'string') {
      normalized.extra = { ...(normalized.extra || {}), display_text: appendDisplayText };
      syncMesToSwipeCompat(normalized);
    }
    const insertedIndex = compatChat.indexOf(normalized);
    const persistedIndex = insertedIndex >= 0 ? insertedIndex : index;
    if (normalized.is_user) {
      emitCompatEvent(window.event_types?.MESSAGE_SENT || 'message_sent', index, normalized);
      emitCompatEvent(window.event_types?.USER_MESSAGE_RENDERED || 'user_message_rendered', index, normalized);
    } else {
      emitCompatEvent(window.event_types?.MESSAGE_RECEIVED || 'message_received', index, normalized);
      emitCompatEvent(window.event_types?.CHARACTER_MESSAGE_RENDERED || 'character_message_rendered', index, normalized);
    }
    const response = await requestParent('addOneMessage', {
      content,
      role: normalized.role,
      name: normalized.name,
      is_user: normalized.is_user,
      is_system: normalized.is_system,
      is_name: normalized.is_name,
      force_avatar: normalized.force_avatar,
      original_avatar: normalized.original_avatar,
      avatar: normalized.avatar,
      gen_id: normalized.gen_id,
      group_id: normalized.group_id,
      group_name: normalized.group_name,
      selected_group: clone(normalized.selected_group),
      groups: clone(normalized.groups),
      swipe_id: normalized.swipe_id,
      swipes: normalized.swipes,
      swipe_info: normalized.swipe_info,
      extra: normalized.extra,
      model: typeof message === 'string' ? undefined : message?.model,
      options,
    });
    if (response?.message && typeof response.message === 'object') {
      compatChat[persistedIndex] = normalizeChatMessage(response.message, persistedIndex);
      syncMessageAliases(compatChat[persistedIndex]);
      syncCtxMessageFromCompat(persistedIndex);
    } else {
      refreshGroupContextCompat();
    }
    return response?.success === false ? false : (response || true);
  };
  const deleteMessageCompat = async (messageId = ctx.messageId, options = {}) => {
    const index = resolveMessageIndex(messageId, options);
    if (index < 0 || index >= compatChat.length) return false;
    const [removed] = compatChat.splice(index, 1);
    compatChat.forEach((item, itemIndex) => { item.mesid = itemIndex; });
    const nextIndex = Math.max(0, Math.min(index, compatChat.length - 1));
    syncCtxMessageFromCompat(nextIndex);
    refreshGroupContextCompat();
    emitCompatEvent(window.event_types?.MESSAGE_DELETED || 'message_deleted', index, removed);
    const normalizedOptions = options && typeof options === 'object' ? options : {};
    if (normalizedOptions.localOnly || normalizedOptions.persist === false || normalizedOptions.save === false) {
      return true;
    }
    const response = await requestParent('deleteMessage', {
      messageId: removed?.message_id ?? removed?.id ?? messageId,
      index,
      options: normalizedOptions,
    });
    return response?.success === false ? false : true;
  };
  const deleteLastMessageCompat = async (options = {}) => {
    if (!compatChat.length) return false;
    return deleteMessageCompat(compatChat.length - 1, options);
  };
  const printMessagesCompat = async (...args) => {
    emitCompatEvent(window.event_types?.CHAT_CHANGED || 'chat_id_changed', compatChat);
    post({ type: 'refresh', args });
    return true;
  };
  const clearChatCompat = async (options = {}) => {
    compatChat.splice(0, compatChat.length);
    syncCtxMessageFromCompat(0);
    refreshGroupContextCompat();
    emitCompatEvent(window.event_types?.CHAT_CHANGED || 'chat_id_changed', compatChat);
    const normalizedOptions = options && typeof options === 'object' ? options : {};
    if (normalizedOptions.localOnly || normalizedOptions.persist === false || normalizedOptions.save === false) {
      return true;
    }
    const response = await requestParent('clearChat', { options: normalizedOptions });
    return response?.success === false ? false : true;
  };
  const switchSwipeCompat = async (messageId = ctx.messageId, swipeId = 0) => {
    const index = resolveMessageIndex(messageId, {});
    const message = compatChat[index];
    if (!message || !Array.isArray(message.swipes) || message.swipes.length === 0) return false;
    const nextSwipeId = Math.max(0, Math.min(Number(swipeId) || 0, message.swipes.length - 1));
    syncSwipeToMesCompat(message, nextSwipeId);
    syncCtxMessageFromCompat(index);
    emitCompatEvent(window.event_types?.MESSAGE_SWIPED || 'message_swiped', index, nextSwipeId, message);
    await setChatMessageCompat(message.mes, message.message_id ?? message.id ?? index, {
      index,
      swipe_id: nextSwipeId,
      swipes: message.swipes,
      swipe_info: message.swipe_info,
      extra: message.extra || {},
      refresh: 'display',
    });
    return true;
  };
  const syncMesToSwipeByIdCompat = (messageId = ctx.messageId) => {
    const index = resolveMessageIndex(messageId, {});
    const message = compatChat[index];
    if (!message) return false;
    syncMesToSwipeCompat(message);
    syncCtxMessageFromCompat(index);
    return true;
  };
  const syncSwipeToMesByIdCompat = (messageId = ctx.messageId, swipeId = null) => {
    const index = resolveMessageIndex(messageId, {});
    const message = compatChat[index];
    if (!message) return false;
    syncSwipeToMesCompat(message, swipeId ?? message.swipe_id);
    syncCtxMessageFromCompat(index);
    return true;
  };
  const getSwipeTargetFromOptionsCompat = (options = {}) => {
    const opts = options && typeof options === 'object' ? options : {};
    return opts.forceMesId ?? opts.messageId ?? opts.mesId ?? ctx.messageId;
  };
  const swipeCompat = async (_event = null, direction = 1, options = {}) => {
    const messageId = getSwipeTargetFromOptionsCompat(options);
    const index = resolveMessageIndex(messageId, {});
    const message = compatChat[index];
    if (!message) return false;
    const explicitSwipeId = options && typeof options === 'object'
      ? options.forceSwipeId ?? options.swipeId ?? options.swipe_id
      : undefined;
    const nextSwipeId = Number.isFinite(Number(explicitSwipeId))
      ? Number(explicitSwipeId)
      : Number(message.swipe_id || 0) + (String(direction).toLowerCase().includes('left') || Number(direction) < 0 ? -1 : 1);
    return switchSwipeCompat(message.message_id ?? message.id ?? index, nextSwipeId);
  };
  const swipeStateCompat = {
    get messageId() { return ctx.messageId; },
    get swipeId() {
      const message = compatChat[resolveMessageIndex(ctx.messageId, {})];
      return Number(message?.swipe_id || 0);
    },
    get count() {
      const message = compatChat[resolveMessageIndex(ctx.messageId, {})];
      return Array.isArray(message?.swipes) ? message.swipes.length : 0;
    },
  };
  const sendMessageCompat = async (content, options = {}) => {
    const normalized = normalizePromptInputCompat(content);
    const insertAt = compatChat.length;
    emitCompatEvent(window.event_types?.MESSAGE_SENT || 'message_sent', insertAt);
    emitCompatEvent(window.event_types?.USER_MESSAGE_RENDERED || 'user_message_rendered', insertAt);
    return requestParent('sendMessage', {
      content: normalized.content,
      awaitResult: Boolean(options?.awaitResult),
      options,
    });
  };
  const sendTextareaCompat = async (options = {}) => {
    const textareaValue = String(parentElementStore.send_textarea?.value || '').trim();
    if (!textareaValue) return false;
    parentElementStore.send_textarea.value = '';
    post({ type: 'st:setInputDraft', content: '' });
    await sendMessageCompat(textareaValue, { ...(options && typeof options === 'object' ? options : {}), source: 'sendTextarea' });
    return true;
  };
  const sendMessageAsUserCompat = async (messageText, messageBias = undefined, insertAt = null, compact = false, name = undefined, avatar = undefined) => {
    const normalized = normalizeUserMessageInputCompat(messageText, messageBias, insertAt, compact, name, avatar);
    const response = await requestParent('sendMessageAsUser', {
      content: normalized.content,
      awaitResult: Boolean(normalized.options.awaitResult),
      options: normalized.options,
    });
    return response?.success !== false;
  };
  const triggerGenerationCompat = async (type = 'normal', options = {}, dryRun = false) => {
    const generationOptions = options && typeof options === 'object' ? options : {};
    const prompt = normalizePromptInputCompat(generationOptions, ['quietPrompt', 'quiet_prompt', 'prompt']);
    const generationType = String(type || 'normal');
    emitCompatEvent(window.event_types?.GENERATION_STARTED || 'generation_started', generationType, generationOptions);
    emitCompatEvent(window.event_types?.GENERATION_AFTER_COMMANDS || 'GENERATION_AFTER_COMMANDS', generationType, generationOptions);
    emitCompatEvent(window.event_types?.GENERATE_BEFORE_COMBINE_PROMPTS || 'generate_before_combine_prompts', generationType, generationOptions);
    emitCompatEvent(window.event_types?.GENERATE_AFTER_COMBINE_PROMPTS || 'generate_after_combine_prompts', {
      type: generationType,
      prompt: prompt.content,
      options: generationOptions,
    });
    try {
      const response = await requestParent('triggerGeneration', {
        type: generationType,
        content: prompt.content,
        options: generationOptions,
        dryRun: Boolean(dryRun),
        awaitResult: true,
      });
      const generated = normalizeGenerationResult(response);
      if (generated) {
        emitCompatEvent(window.event_types?.GENERATE_AFTER_DATA || 'generate_after_data', { content: generated, type: generationType });
        emitCompatEvent(window.event_types?.MESSAGE_RECEIVED || 'message_received', compatChat.length - 1, generated);
        emitCompatEvent(window.event_types?.CHARACTER_MESSAGE_RENDERED || 'character_message_rendered', compatChat.length - 1, generated);
      }
      emitCompatEvent(window.event_types?.GENERATION_ENDED || 'generation_ended', generationType, { message: generated });
      return generated;
    } catch (error) {
      emitCompatEvent(window.event_types?.GENERATION_STOPPED || 'generation_stopped', generationType, error);
      emitCompatEvent(window.event_types?.GENERATION_ENDED || 'generation_ended', generationType, { error: String(error?.message || error) });
      throw error;
    }
  };
  const normalizeGenerationResult = (response) => {
    if (typeof response === 'string') return response;
    if (response && typeof response === 'object') {
      if (typeof response.content === 'string') return response.content;
      if (typeof response.text === 'string') return response.text;
      if (typeof response.message === 'string') return response.message;
      if (typeof response.result === 'string') return response.result;
    }
    return '';
  };
  const emitCompatEvent = (type, ...args) => {
    try {
      window.eventSource?.emit?.(type, ...args);
    } catch {}
  };
  const refreshDerivedContextStoresCompat = () => {
    scopedRegexScripts = normalizeRegexListCompat(ctx.characterExtensions);
    presetRegexScripts = normalizeRegexListCompat(ctx.presetData);
    globalRegexScripts = normalizeRegexListCompat(ctx.globalRegexScripts);
    const extensions = parseMaybeJsonObject(ctx.characterExtensions, {});
    primaryCharacter.id = ctx.characterId;
    primaryCharacter.uuid = ctx.characterId;
    primaryCharacter.name = ctx.characterName;
    primaryCharacter.avatar = ctx.characterId;
    primaryCharacter.chat = ctx.sessionId;
    primaryCharacter.first_mes = ctx.firstMes || '';
    primaryCharacter.alternate_greetings = Array.isArray(ctx.alternateGreetings) ? clone(ctx.alternateGreetings) : [];
    primaryCharacter.data.name = ctx.characterName;
    primaryCharacter.data.extensions = extensions;
    primaryCharacter.data.first_mes = ctx.firstMes || '';
    primaryCharacter.data.alternate_greetings = Array.isArray(ctx.alternateGreetings) ? clone(ctx.alternateGreetings) : [];
    window.characters[0] = primaryCharacter;
    if (ctx.characterId) window.characters[ctx.characterId] = primaryCharacter;
  };
  const setViewportCssNumberCompat = (style, name, value) => {
`;
