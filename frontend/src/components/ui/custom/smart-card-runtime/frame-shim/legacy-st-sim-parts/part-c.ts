/**
 * legacy-st-sim 段 · 第 03 段（原 legacy-st-sim.ts 第 1659-2481 行）
 *
 * 机械拆分产物：逐字节搬运，未改任何逻辑。内容是注入卡片 iframe 的 JS 源码文本。
 *
 * 约束（改动前必读）：
 *  1. 本段是模板字符串：新增注释与代码里不得出现裸反引号，正则一律 new RegExp()。
 *  2. 拼接顺序由 legacy-st-sim.ts 固定（a → b → c），不可调换。
 *  3. 修改后必须跑 node scripts/verify-shim-identity.mjs 比对字节快照。
 */

export const LEGACY_ST_SIM_SEGMENT_PART_C = `  const parseInlineArg = (value, event, element) => {
    const text = String(value || '').trim();
    if (!text) return undefined;
    if ((text[0] === '"' && text[text.length - 1] === '"') || (text[0] === "'" && text[text.length - 1] === "'")) {
      return parseInlineString(text);
    }
    if (text === 'event') return event;
    if (text === 'this') return element;
    if (text === 'true') return true;
    if (text === 'false') return false;
    if (text === 'null') return null;
    if (/^-?\\d+(?:\\.\\d+)?$/.test(text)) return Number(text);
    if (/^[\\[{]/.test(text)) {
      try { return JSON.parse(text); } catch {}
    }
    const resolved = resolveWindowPath(text.replace(/^window\\./, ''));
    return resolved === undefined ? text : resolved;
  };
  const splitJQueryMethodChain = (source) => {
    const calls = [];
    const text = String(source || '').trim();
    let index = 0;
    while (index < text.length) {
      while (/\\s/.test(text[index] || '')) index += 1;
      if (text[index] !== '.') return null;
      index += 1;
      const nameStart = index;
      while (/[A-Za-z0-9_$]/.test(text[index] || '')) index += 1;
      const name = text.slice(nameStart, index);
      if (!name) return null;
      while (/\\s/.test(text[index] || '')) index += 1;
      if (text[index] !== '(') return null;
      index += 1;
      const argsStart = index;
      let quote = null;
      let escaped = false;
      let depth = 1;
      while (index < text.length) {
        const char = text[index];
        if (quote) {
          if (escaped) escaped = false;
          else if (char === '\\\\') escaped = true;
          else if (char === quote) quote = null;
          index += 1;
          continue;
        }
        if (char === '"' || char === "'") {
          quote = char;
          index += 1;
          continue;
        }
        if (char === '(') depth += 1;
        if (char === ')') depth -= 1;
        if (depth === 0) break;
        index += 1;
      }
      if (depth !== 0) return null;
      calls.push({ name, args: text.slice(argsStart, index) });
      index += 1;
    }
    return calls;
  };
  const invokeJQueryInlineChain = (code, event, element) => {
    const match = String(code || '').trim().match(/^\\$\\s*\\(([\\s\\S]*?)\\)\\s*([\\s\\S]+)$/);
    if (!match || !match[2]?.trim?.().startsWith('.')) return false;
    const calls = splitJQueryMethodChain(match[2]);
    if (!calls || calls.length === 0) return false;
    let collection = dollar(parseInlineArg(match[1], event, element));
    for (const call of calls) {
      const method = collection?.[call.name];
      if (typeof method !== 'function') return false;
      const args = splitInlineArgs(call.args).map((arg) => parseInlineArg(arg, event, element));
      const result = method.apply(collection, args);
      if (result !== undefined && result !== null) collection = result;
    }
    return true;
  };
  const inlineSourceDataKey = (attrName) => {
    const name = String(attrName || '').replace(/^on/, '');
    return 'palinkInlineSource' + name.charAt(0).toUpperCase() + name.slice(1);
  };
  const invokeInlineEventHandler = (element, attrName, event) => {
    const code = element?.getAttribute?.(attrName) || element?.dataset?.[inlineSourceDataKey(attrName)];
    if (!code) return false;
    const normalized = String(code).trim().replace(/^return\\s+/, '').replace(/;\\s*$/, '');
    if (invokeJQueryInlineChain(normalized, event, element)) return true;
    const match = normalized.match(/^([A-Za-z_$][\\w$]*(?:\\.[A-Za-z_$][\\w$]*)*)\\s*\\(([\\s\\S]*)\\)$/);
    if (match) {
      const fn = resolveWindowPath(match[1].replace(/^window\\./, ''));
      if (typeof fn === 'function') {
        try {
          const args = splitInlineArgs(match[2]).map((arg) => parseInlineArg(arg, event, element));
          fn.apply(element, args);
          return true;
        } catch (error) {
          post({ type: 'error', message: String(error?.message || error) });
          return false;
        }
      }
    }
    try {
      const runner = new Function('event', 'element', 'window', 'document', '$', 'jQuery', String(code));
      runner.call(element, event, element, window, document, window.$, window.jQuery || window.$);
      return true;
    } catch (error) {
      post({ type: 'error', message: String(error?.message || error) });
      return false;
    }
  };
  const bindInlineEventHandlers = (root = document) => {
    const scope = root?.querySelectorAll ? root : document;
    const elements = Array.from(scope.querySelectorAll?.('[onclick],[onchange],[onsubmit]') || []);
    if (scope.nodeType === 1 && scope.matches?.('[onclick],[onchange],[onsubmit]')) elements.unshift(scope);
    const bindings = [
      ['click', 'onclick', 'palinkInlineClick'],
      ['change', 'onchange', 'palinkInlineChange'],
      ['submit', 'onsubmit', 'palinkInlineSubmit'],
    ];
    elements.forEach((element) => {
      bindings.forEach(([eventName, attrName, marker]) => {
        if (!element.hasAttribute?.(attrName) || element.dataset?.[marker] === 'true') return;
        const sourceKey = inlineSourceDataKey(attrName);
        if (element.dataset && !element.dataset[sourceKey]) element.dataset[sourceKey] = element.getAttribute(attrName) || '';
        if (element.dataset) element.dataset[marker] = 'true';
      });
    });
  };
  const nearestDashboardItem = (items, clientX, clientY) => {
    let best = null;
    let bestDistance = Number.POSITIVE_INFINITY;
    items.forEach((item) => {
      const rect = item.getBoundingClientRect();
      if (!rect.width || !rect.height) return;
      const dx = clientX < rect.left ? rect.left - clientX : clientX > rect.right ? clientX - rect.right : 0;
      const dy = clientY < rect.top ? rect.top - clientY : clientY > rect.bottom ? clientY - rect.bottom : 0;
      const distance = dx * dx + dy * dy;
      if (distance < bestDistance) {
        bestDistance = distance;
        best = item;
      }
    });
    return best;
  };
  const activateDashboardItem = (target, event) => {
    if (!target) return false;
    try {
      const forwardedEvent = new MouseEvent('click', {
        bubbles: true,
        cancelable: true,
        view: window,
        clientX: event.clientX,
        clientY: event.clientY,
      });
      target.dispatchEvent(forwardedEvent);
      if (forwardedEvent.__palinkInlineHandled) return true;
      if (target.hasAttribute?.('onclick')) return true;
    } catch {}
    if (invokeInlineEventHandler(target, 'onclick', event)) return true;
    const nested = target.querySelector?.('[onclick]');
    if (nested && invokeInlineEventHandler(nested, 'onclick', event)) return true;
    return false;
  };
  const installDashboardTapProxy = () => {
    const dashboard = document.getElementById('dashboard');
    if (!dashboard || dashboard.dataset.palinkTapProxy === 'true') return;
    dashboard.dataset.palinkTapProxy = 'true';
    let lastProxyTap = 0;
    const handleTap = (event) => {
      if (event.defaultPrevented) return;
      if (event.type === 'pointerup' && event.button !== 0) return;
      if (event.target?.closest?.('.item-container, button, a, input, textarea, select')) return;
      const items = Array.from(dashboard.querySelectorAll('.item-container,[onclick]')).filter((item) => {
        if (item === dashboard) return false;
        const rect = item.getBoundingClientRect();
        return rect.width > 0 && rect.height > 0;
      });
      if (items.length === 0) return;
      const now = Date.now();
      if (now - lastProxyTap < 280) return;
      const target = nearestDashboardItem(items, event.clientX, event.clientY);
      if (!target) return;
      lastProxyTap = now;
      event.preventDefault();
      event.stopPropagation();
      activateDashboardItem(target, event);
    };
    dashboard.addEventListener('click', handleTap, true);
    dashboard.addEventListener('pointerup', handleTap, true);
  };
  const installInteractionAdapters = (root = document) => {
    bindInlineEventHandlers(root);
    installDashboardTapProxy();
  };
  ready(() => {
    installInteractionAdapters();
    try {
      new MutationObserver((mutations) => {
        mutations.forEach((mutation) => {
          mutation.addedNodes?.forEach((node) => {
            if (node?.nodeType === 1) installInteractionAdapters(node);
          });
        });
        installInteractionAdapters();
      }).observe(document.documentElement, { childList: true, subtree: true });
    } catch {}
    setTimeout(installInteractionAdapters, 120);
    setTimeout(installInteractionAdapters, 500);
    setTimeout(installInteractionAdapters, 1200);
  });
  const toKebab = (value) => String(value).replace(/[A-Z]/g, (char) => '-' + char.toLowerCase());
  const toCamel = (value) => String(value).replace(/-([a-z])/g, (_match, char) => char.toUpperCase());
  const normalizeDisplay = (node, fallback = 'block') => {
    if (!node) return fallback;
    const tag = node.tagName?.toLowerCase?.();
    if (tag === 'span' || tag === 'a' || tag === 'label') return 'inline';
    if (tag === 'button' || tag === 'input' || tag === 'select' || tag === 'textarea') return '';
    return fallback;
  };
  const parseDataValue = (value) => {
    if (value == null) return value;
    const text = String(value);
    if (text === 'true') return true;
    if (text === 'false') return false;
    if (text === 'null') return null;
    if (/^-?\\d+(?:\\.\\d+)?$/.test(text)) return Number(text);
    if (/^[\\[{]/.test(text)) {
      try { return JSON.parse(text); } catch {}
    }
    return value;
  };
  const setStyleValue = (node, name, value) => {
    if (!node?.style) return;
    const cssName = toKebab(name);
    const cssValue = String(value ?? '');
    if (typeof node.style.setProperty === 'function') {
      node.style.setProperty(cssName, cssValue);
      return;
    }
    try { node.style[name] = cssValue; } catch {}
  };
  const normalizeDollarContent = (content) => {
    if (content == null) return [];
    if (Array.isArray(content)) return content.flatMap(normalizeDollarContent);
    if (content?.nodeType) return [content];
    if (typeof content === 'string') {
      const template = document.createElement('template');
      template.innerHTML = content;
      return Array.from(template.content.childNodes);
    }
    if (typeof content[Symbol.iterator] === 'function') return Array.from(content);
    return [];
  };
  const createParentVirtualElement = (id, tagName, options = {}) => {
    const listeners = new Map();
    const element = {
      __palinkParentElement: true,
      nodeType: 1,
      id,
      tagName,
      value: options.value || '',
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
        Array.from(listeners.get(eventType) || []).forEach((listener) => {
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
      matches(selector) { return parentSelectorMatches(selector, id); },
      closest(selector) { return parentSelectorMatches(selector, id) ? this : null; },
      getAttribute(name) {
        if (name === 'id') return id;
        if (name === 'value') return this.value;
        return null;
      },
      setAttribute(name, value) {
        if (name === 'value') this.value = String(value ?? '');
      },
      removeAttribute() {},
    };
    if (tagName === 'FORM') {
      element.requestSubmit = () => parentElementStore.send_but.click();
      element.submit = () => parentElementStore.send_but.click();
    }
    return element;
  };
  const parentElementStore = {
    send_textarea: createParentVirtualElement('send_textarea', 'TEXTAREA', {
      dispatch(_event, eventType) {
        if (eventType === 'input' || eventType === 'change') {
          post({ type: 'setInputDraft', content: String(parentElementStore.send_textarea.value || '') });
        }
      },
    }),
    send_but: createParentVirtualElement('send_but', 'BUTTON', {
      click() {
        const content = String(parentElementStore.send_textarea.value || '').trim();
        if (!content) return;
        void requestParent('sendMessage', { content, awaitResult: false });
        parentElementStore.send_textarea.value = '';
        post({ type: 'setInputDraft', content: '' });
      },
    }),
    send_form: createParentVirtualElement('send_form', 'FORM', {
      dispatch(_event, eventType) {
        if (eventType === 'submit') parentElementStore.send_but.click();
      },
    }),
  };
  parentElementStore.sendTextarea = parentElementStore.send_textarea;
  parentElementStore.send_textarea_field = parentElementStore.send_textarea;
  parentElementStore.chat_textarea = parentElementStore.send_textarea;
  parentElementStore.sendButton = parentElementStore.send_but;
  parentElementStore.send_button = parentElementStore.send_but;
  parentElementStore.sendButtonWrapper = parentElementStore.send_but;
  parentElementStore.send_form_container = parentElementStore.send_form;
  const parentSelectorMatches = (selector, id) => {
    const normalized = String(selector || '').trim();
    if (!normalized) return false;
    const selectorParts = normalized.split(',').map((part) => part.trim()).filter(Boolean);
    return selectorParts.some((part) => {
      if (part === '*' || part === '#' + id || part === '[id="' + id + '"]' || part === "[id='" + id + "']") return true;
      if (id === 'send_textarea') return /(?:^|[\s>+~])textarea\b|#(?:send_textarea|sendTextarea|chat_textarea|send-textarea|chat-input|send_textarea_field)\b|(?:send_textarea|sendTextarea|chat_textarea|send-textarea|chat-input)/i.test(part);
      if (id === 'send_but') return /(?:^|[\s>+~])button\b|#(?:send_but|sendButton|send-button|send_button|send)\b|(?:send_but|send-button|sendButton|send_button|sendButtonWrapper)/i.test(part);
      if (id === 'send_form') return /^(?:form)?#send_form$|^form\b|send_form|send-form|chat-form/i.test(part);
      return false;
    });
  };
  const getParentElementBySelector = (selector) => {
    const normalized = String(selector || '').trim();
    if (!normalized) return null;
    if (parentSelectorMatches(normalized, 'send_textarea')) return parentElementStore.send_textarea;
    if (parentSelectorMatches(normalized, 'send_but')) return parentElementStore.send_but;
    if (parentSelectorMatches(normalized, 'send_form')) return parentElementStore.send_form;
    return null;
  };
  const parentDocumentStore = {
    __palinkParentDocument: true,
    getElementById(id) {
      const key = String(id || '').trim();
      return parentElementStore[key] || null;
    },
    querySelector(selector) {
      return getParentElementBySelector(selector);
    },
    querySelectorAll(selector) {
      const element = getParentElementBySelector(selector);
      return element ? [element] : [];
    },
    getElementsByClassName() { return []; },
    getElementsByTagName(tagName) {
      const tag = String(tagName || '').toLowerCase();
      if (tag === 'textarea') return [parentElementStore.send_textarea];
      if (tag === 'button') return [parentElementStore.send_but];
      if (tag === 'form') return [parentElementStore.send_form];
      return [];
    },
    addEventListener() {},
    removeEventListener() {},
    dispatchEvent() { return true; },
    createEvent() { return { initEvent() {} }; },
  };
  const createDollarCollection = (nodes) => {
    const collection = Array.from(nodes || []);
    collection.ready = function(cb) { ready(cb); return this; };
    collection.each = function(cb) {
      if (typeof cb === 'function') this.forEach((node, index) => cb.call(node, index, node));
      return this;
    };
    collection.on = function(type, selectorOrCb, cb) {
      const delegated = typeof selectorOrCb === 'string';
      const handler = delegated ? cb : selectorOrCb;
      if (typeof handler !== 'function') return this;
      this.forEach((node) => {
        node.addEventListener?.(type, function(event) {
          if (delegated) {
            const target = event.target?.closest?.(selectorOrCb);
            if (!target || !node.contains(target)) return;
            handler.call(target, event);
            return;
          }
          handler.call(node, event);
        });
      });
      return this;
    };
    collection.off = function(type, cb) {
      this.forEach((node) => node.removeEventListener?.(type, cb));
      return this;
    };
    collection.click = function(cb) {
      if (typeof cb === 'function') return this.on('click', cb);
      return this.trigger('click');
    };
    collection.submit = function(cb) {
      if (typeof cb === 'function') return this.on('submit', cb);
      return this.trigger('submit');
    };
    collection.css = function(name, value) {
      if (typeof name === 'string' && value === undefined) {
        const node = this[0];
        return node ? window.getComputedStyle(node).getPropertyValue(toKebab(name)) || node.style[name] : undefined;
      }
      this.forEach((node) => {
        if (!node?.style) return;
        if (typeof name === 'object') {
          Object.entries(name).forEach(([key, val]) => setStyleValue(node, key, val));
        } else {
          setStyleValue(node, name, value);
        }
      });
      return this;
    };
    collection.html = function(value) {
      if (value === undefined) return this[0]?.innerHTML;
      this.forEach((node) => { node.innerHTML = String(value ?? ''); });
      return this;
    };
    collection.append = function(...items) {
      this.forEach((node) => {
        if (!node?.appendChild) return;
        items.flatMap(normalizeDollarContent).forEach((child) => {
          try { node.appendChild(child.cloneNode ? child.cloneNode(true) : child); } catch {}
        });
      });
      return this;
    };
    collection.prepend = function(...items) {
      this.forEach((node) => {
        if (!node?.insertBefore) return;
        const first = node.firstChild;
        items.flatMap(normalizeDollarContent).forEach((child) => {
          try { node.insertBefore(child.cloneNode ? child.cloneNode(true) : child, first); } catch {}
        });
      });
      return this;
    };
    collection.appendTo = function(target) {
      dollar(target).append(this);
      return this;
    };
    collection.prependTo = function(target) {
      dollar(target).prepend(this);
      return this;
    };
    collection.empty = function() {
      this.forEach((node) => { if ('innerHTML' in node) node.innerHTML = ''; });
      return this;
    };
    collection.remove = function() {
      this.forEach((node) => node.parentNode?.removeChild?.(node));
      return this;
    };
    collection.text = function(value) {
      if (value === undefined) return this[0]?.textContent;
      this.forEach((node) => { node.textContent = String(value ?? ''); });
      return this;
    };
    collection.addClass = function(value) {
      String(value || '').split(/\\s+/).filter(Boolean).forEach((className) => this.forEach((node) => node.classList?.add(className)));
      return this;
    };
    collection.removeClass = function(value) {
      if (value === undefined) {
        this.forEach((node) => node.removeAttribute?.('class'));
        return this;
      }
      String(value || '').split(/\\s+/).filter(Boolean).forEach((className) => this.forEach((node) => node.classList?.remove(className)));
      return this;
    };
    collection.toggleClass = function(value, force) {
      String(value || '').split(/\\s+/).filter(Boolean).forEach((className) => this.forEach((node) => node.classList?.toggle(className, force)));
      return this;
    };
    collection.hasClass = function(value) {
      return Boolean(this[0]?.classList?.contains(value));
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
    collection.removeAttr = function(name) {
      String(name || '').split(/\\s+/).filter(Boolean).forEach((attrName) => {
        this.forEach((node) => node.removeAttribute?.(attrName));
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
    collection.data = function(name, value) {
      const key = String(name || '');
      const dataName = 'data-' + toKebab(key);
      const camelKey = toCamel(key);
      if (value === undefined) {
        const node = this[0];
        if (!node) return undefined;
        return parseDataValue(node.dataset?.[camelKey] ?? node.dataset?.[key] ?? node.getAttribute?.(dataName));
      }
      this.forEach((node) => {
        if (node.dataset) node.dataset[camelKey] = String(value);
        else node.setAttribute?.(dataName, String(value));
      });
      return this;
    };
    collection.removeData = function(name) {
      const keys = name === undefined
        ? []
        : String(name || '').split(/\\s+/).filter(Boolean);
      this.forEach((node) => {
        if (!node) return;
        if (keys.length === 0) {
          Object.keys(node.dataset || {}).forEach((key) => { try { delete node.dataset[key]; } catch {} });
          return;
        }
        keys.forEach((key) => {
          const camelKey = toCamel(key);
          try { delete node.dataset?.[camelKey]; } catch {}
          node.removeAttribute?.('data-' + toKebab(key));
        });
      });
      return this;
    };
    collection.val = function(value) {
      if (value === undefined) return this[0]?.value ?? '';
      this.forEach((node) => { if ('value' in node) node.value = String(value ?? ''); });
      return this;
    };
    collection.get = function(index) {
      if (index === undefined) return Array.from(this);
      const resolved = Number(index) < 0 ? this.length + Number(index) : Number(index);
      return this[resolved];
    };
    collection.toArray = function() { return Array.from(this); };
    collection.add = function(selector) {
      const current = Array.from(this);
      const extra = dollar(selector).toArray ? dollar(selector).toArray() : Array.from(dollar(selector) || []);
      return createDollarCollection([...current, ...extra].filter((node, index, arr) => node && arr.indexOf(node) === index));
    };
    collection.filter = function(selectorOrCb) {
      const nodes = Array.prototype.filter.call(this, (node, index) => {
        if (typeof selectorOrCb === 'function') return Boolean(selectorOrCb.call(node, index, node));
        return Boolean(node?.matches?.(selectorOrCb));
      });
      return createDollarCollection(nodes);
    };
    collection.not = function(selectorOrCb) {
      const filtered = this.filter(selectorOrCb);
      return createDollarCollection(Array.prototype.filter.call(this, (node) => !filtered.includes(node)));
    };
    collection.index = function(target) {
      if (target !== undefined) return Array.prototype.indexOf.call(this, dollar(target)[0]);
      const node = this[0];
      if (!node?.parentElement) return -1;
      return Array.from(node.parentElement.children || []).indexOf(node);
    };
    collection.trigger = function(type) {
      const eventType = typeof type === 'string' ? type : type?.type;
      if (!eventType) return this;
      this.forEach((node) => {
        if (eventType === 'click' && typeof node.click === 'function') {
          try {
            node.click();
            return;
          } catch {}
        }
        const event = new Event(eventType, { bubbles: true, cancelable: true });
        node.dispatchEvent?.(event);
        if (eventType === 'submit' && !event.defaultPrevented && typeof node.requestSubmit === 'function') {
          try { node.requestSubmit(); } catch {}
        }
      });
      return this;
    };
    collection.is = function(selector) {
      const node = this[0];
      if (!node) return false;
      if (selector === ':visible') {
        const style = window.getComputedStyle(node);
        return style.display !== 'none' && style.visibility !== 'hidden' && Number(style.opacity) !== 0;
      }
      return Boolean(node.matches?.(selector));
    };
    collection.hide = function(duration, complete) {
      this.forEach((node) => { if (node?.style) node.style.display = 'none'; });
      if (typeof duration === 'function') duration.call(this[0]);
      if (typeof complete === 'function') setTimeout(() => complete.call(this[0]), Number(duration) || 0);
      return this;
    };
    collection.show = function(duration, complete) {
      this.forEach((node) => { if (node?.style) node.style.display = normalizeDisplay(node); });
      if (typeof duration === 'function') duration.call(this[0]);
      if (typeof complete === 'function') setTimeout(() => complete.call(this[0]), Number(duration) || 0);
      return this;
    };
    collection.toggle = function(force) {
      this.forEach((node) => {
        if (!node?.style) return;
        const visible = window.getComputedStyle(node).display !== 'none';
        const shouldShow = typeof force === 'boolean' ? force : !visible;
        node.style.display = shouldShow ? normalizeDisplay(node) : 'none';
      });
      return this;
    };
    collection.fadeIn = function(duration, complete) {
      this.show();
      this.css('opacity', 1);
      if (typeof duration === 'function') duration.call(this[0]);
      if (typeof complete === 'function') setTimeout(() => complete.call(this[0]), Number(duration) || 0);
      return this;
    };
    collection.fadeOut = function(duration, complete) {
      this.css('opacity', 0);
      const delay = Number(duration) || 0;
      setTimeout(() => {
        this.hide();
        if (typeof complete === 'function') complete.call(this[0]);
      }, delay);
      if (typeof duration === 'function') duration.call(this[0]);
      return this;
    };
    collection.fadeToggle = function(duration, complete) {
      const visible = this.is(':visible');
      return visible ? this.fadeOut(duration, complete) : this.fadeIn(duration, complete);
    };
    collection.slideDown = function(duration, complete) { return this.show(duration, complete); };
    collection.slideUp = function(duration, complete) { return this.hide(duration, complete); };
    collection.slideToggle = function() {
      this.forEach((node) => {
        if (!node?.style) return;
        const style = window.getComputedStyle(node);
        node.style.display = style.display === 'none' ? normalizeDisplay(node) : 'none';
      });
      return this;
    };
    collection.stop = function() { return this; };
    collection.animate = function(properties, duration, easing, complete) {
      const done = typeof duration === 'function'
        ? duration
        : typeof easing === 'function'
          ? easing
          : typeof complete === 'function'
            ? complete
            : null;
      if (properties && typeof properties === 'object') {
        this.css(properties);
      }
      if (done) setTimeout(() => done.call(this[0]), Number(duration) || 0);
      return this;
    };
    collection.width = function(value) {
      if (value === undefined) return this[0]?.getBoundingClientRect?.().width ?? 0;
      return this.css('width', typeof value === 'number' ? value + 'px' : value);
    };
    collection.height = function(value) {
      if (value === undefined) return this[0]?.getBoundingClientRect?.().height ?? 0;
      return this.css('height', typeof value === 'number' ? value + 'px' : value);
    };
    collection.outerWidth = function() { return this[0]?.getBoundingClientRect?.().width ?? 0; };
    collection.outerHeight = function() { return this[0]?.getBoundingClientRect?.().height ?? 0; };
    collection.scrollTop = function(value) {
      if (value === undefined) return this[0]?.scrollTop ?? 0;
      this.forEach((node) => { if ('scrollTop' in node) node.scrollTop = Number(value) || 0; });
      return this;
    };
    collection.scrollLeft = function(value) {
      if (value === undefined) return this[0]?.scrollLeft ?? 0;
      this.forEach((node) => { if ('scrollLeft' in node) node.scrollLeft = Number(value) || 0; });
      return this;
    };
    collection.offset = function() {
      const rect = this[0]?.getBoundingClientRect?.();
      return rect ? { top: rect.top + window.scrollY, left: rect.left + window.scrollX } : { top: 0, left: 0 };
    };
    collection.position = function() {
      const rect = this[0]?.getBoundingClientRect?.();
      return rect ? { top: rect.top, left: rect.left } : { top: 0, left: 0 };
    };
    collection.closest = function(selector) {
      return createDollarCollection(this.map((node) => node.closest?.(selector)).filter(Boolean));
    };
    collection.parent = function(selector) {
      const nodes = this.map((node) => node.parentElement).filter((node) => node && (!selector || node.matches?.(selector)));
      return createDollarCollection(nodes);
    };
    collection.children = function(selector) {
      const nodes = this.flatMap((node) => Array.from(node.children || [])).filter((node) => !selector || node.matches?.(selector));
      return createDollarCollection(nodes);
    };
    collection.siblings = function(selector) {
      const nodes = this.flatMap((node) => Array.from(node.parentElement?.children || []).filter((child) => child !== node));
      return createDollarCollection(nodes.filter((node) => !selector || node.matches?.(selector)));
    };
    collection.prev = function(selector) {
      const nodes = this.map((node) => node.previousElementSibling).filter((node) => node && (!selector || node.matches?.(selector)));
      return createDollarCollection(nodes);
    };
    collection.next = function(selector) {
      const nodes = this.map((node) => node.nextElementSibling).filter((node) => node && (!selector || node.matches?.(selector)));
      return createDollarCollection(nodes);
    };
    collection.eq = function(index) {
      const resolved = index < 0 ? this.length + index : index;
      return createDollarCollection(resolved >= 0 && resolved < this.length ? [this[resolved]] : []);
    };
    collection.first = function() { return this.eq(0); };
    collection.last = function() { return this.eq(-1); };
    collection.find = function(selector) {
      return createDollarCollection(this.flatMap((node) => Array.from(node.querySelectorAll?.(selector) || [])));
    };
    // [STATUSBAR-COMPAT] 补齐 legacyShim 集合缺失的焦点方法（与 compatV2Shim 对齐），
    // 否则面板/卡片脚本调用 $("...").blur()/.focus() 会抛 "is not a function"。
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
  const dollar = (arg) => {
    if (typeof arg === 'function') {
      ready(arg);
      return createDollarCollection([document]);
    }
    if (arg === document || arg === window) {
      return createDollarCollection([arg]);
    }
    if (arg === parentDocumentStore) {
      return createDollarCollection([parentDocumentStore]);
    }
    if (typeof arg === 'string') {
      const parentElement = getParentElementBySelector(arg);
      if (parentElement) return createDollarCollection([parentElement]);
    }
    const nodes = typeof arg === 'string'
      ? Array.from(document.querySelectorAll(arg))
      : arg?.nodeType === 1 || arg?.__palinkParentElement
        ? [arg]
        : Array.isArray(arg)
          ? arg
        : [];
    return createDollarCollection(nodes);
  };
  if (!window.$) window.$ = dollar;
  if (!window.jQuery) window.jQuery = window.$;
  window.PalinkSmartCard = {
    context: ctx,
    post,
    sendMessage: getContext().sendMessage,
    parentDocument: parentDocumentStore,
    parent$: dollar,
    getParentElementById(id) {
      return parentDocumentStore.getElementById(id);
    },
    queryParentSelector(selector) { return parentDocumentStore.querySelector(selector); },
    queryParentSelectorAll(selector) { return parentDocumentStore.querySelectorAll(selector); },
  };
  window.sendToTavern = (content) => getContext().sendMessage(content);
`;
