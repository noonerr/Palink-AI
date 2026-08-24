(function () {
  'use strict';

  var originalFetch = window.fetch;

  var bootParams = new URLSearchParams(window.location.search || '');
  var nativeMode = bootParams.get('palinkNativeMode') === '1';
  var bootContext = {
    characterId: bootParams.get('palinkCharacterId') || '',
    sessionId: bootParams.get('palinkSessionId') || '',
    branchId: bootParams.get('palinkBranchId') || '',
    model: bootParams.get('palinkModel') || ''
  };
  var bootInFlight = false;
  var bootDone = false;
  var bootPending = !!bootContext.characterId;
  var TRANSPARENT_BACKGROUND_URL = "url('data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=')";

  window.__PALINK_ST_EMBEDDED = true;
  window.__PALINK_ST_SUPPRESS_CHARACTER_EDIT = true;
  window.__PALINK_ST_BOOT_CONTEXT = bootContext;
  window.__PALINK_ST_MODEL = bootContext.model || '';

  // Palink-owned API 白名单 — 由 Palink 后端实现的 ST 端点
  // 必须与 backend/app/api/silly_tavern.py、st_groups.py、st_resources.py 中
  // 实际注册的 @router 路径保持一致，否则 bridge.js 会将 Palink-owned 端点
  // 错误地代理到 ST sidecar，导致 Palink DB 与 ST sidecar 文件系统数据不一致。
  // 更新端点时，请同步更新 backend/tests/test_st_contract.py 中的 ST_ENDPOINTS。
  var REAL_API_PATHS = {
    // Version & CSRF
    '/version': true,
    '/csrf-token': true,
    '/api/st/version': true,
    '/api/st/csrf-token': true,
    // Settings
    '/api/settings/get': true,
    '/api/settings/save': true,
    // Characters (silly_tavern.py: characters/get/edit/create/delete/duplicate/rename/merge-attributes/chats/import/export/edit-avatar/edit-attribute)
    '/api/characters/all': true,
    '/api/characters/get': true,
    '/api/characters/edit': true,
    '/api/characters/create': true,
    '/api/characters/delete': true,
    '/api/characters/chats': true,
    '/api/characters/duplicate': true,
    '/api/characters/rename': true,
    '/api/characters/merge-attributes': true,
    '/api/characters/import': true,
    '/api/characters/export': true,
    '/api/characters/edit-avatar': true,
    '/api/characters/edit-attribute': true,
    // Chats — core CRUD (silly_tavern.py)
    '/api/chats/get': true,
    '/api/chats/save': true,
    '/api/chats/search': true,
    '/api/chats/delete': true,
    '/api/chats/rename': true,
    '/api/chats/import': true,
    '/api/chats/export': true,
    '/api/chats/recent': true,
    // Chats — generation (continue/regenerate/swipe)
    '/api/chats/continue': true,
    '/api/chats/regenerate': true,
    '/api/chats/swipe': true,
    // Chats — group operations (silly_tavern.py + st_groups.py)
    '/api/chats/group/get': true,
    '/api/chats/group/save': true,
    '/api/chats/group/delete': true,
    '/api/chats/group/info': true,
    '/api/chats/group/import': true,
    // Chats — message-level ops (hide/unhide/delete-message/rename-session/find/set-input/inject/flush-inject/trigger/popup/buttons/messages)
    '/api/chats/hide': true,
    '/api/chats/unhide': true,
    '/api/chats/delete-message': true,
    '/api/chats/rename-session': true,
    '/api/chats/find': true,
    '/api/chats/set-input': true,
    '/api/chats/inject': true,
    '/api/chats/flush-inject': true,
    '/api/chats/trigger': true,
    '/api/chats/popup': true,
    '/api/chats/buttons': true,
    '/api/chats/messages': true,
    // WorldInfo (silly_tavern.py)
    '/api/worldinfo/get': true,
    '/api/worldinfo/edit': true,
    '/api/worldinfo/delete': true,
    '/api/worldinfo/list': true,
    '/api/worldinfo/import': true,
    '/api/worldinfo/export': true,
    '/api/worldinfo/batch-import': true,
    // Groups (st_groups.py)
    '/api/groups/get': true,
    '/api/groups/all': true,
    '/api/groups/create': true,
    '/api/groups/edit': true,
    '/api/groups/delete': true,
    '/api/groups/member-get': true,
    '/api/groups/member-add': true,
    '/api/groups/member-remove': true,
    '/api/groups/chats': true,
    // Quick Replies (silly_tavern.py)
    '/api/quick-replies/save': true,
    '/api/quick-replies/delete': true,
    '/api/quick-replies/list': true,
    '/api/quick-replies/execute': true,
    '/api/quick-replies/create': true,
    '/api/quick-replies/update': true,
    // Backgrounds (st_resources.py)
    '/api/backgrounds/all': true,
    '/api/backgrounds/folders': true,
    '/api/backgrounds/upload': true,
    '/api/backgrounds/rename': true,
    '/api/backgrounds/delete': true,
    // Avatars (st_resources.py)
    '/api/avatars/get': true,
    '/api/avatars/upload': true,
    '/api/avatars/delete': true,
    // Sprites (st_resources.py)
    '/api/sprites/get': true,
    '/api/sprites/upload': true,
    '/api/sprites/upload-zip': true,
    '/api/sprites/delete': true,
    // Assets (st_resources.py)
    '/api/assets/get': true,
    '/api/assets/character': true,
    '/api/assets/download': true,
    '/api/assets/delete': true,
    // Secrets — Palink redirects to ConnectionProfiles UI
    '/api/secrets/write': true,
    '/api/secrets/read': true,
    '/api/secrets/view': true,
    '/api/secrets/find': true,
    '/api/secrets/delete': true,
    '/api/secrets/rotate': true,
    '/api/secrets/rename': true,
    '/api/secrets/settings': true,
    // Extensions — Palink redirects to extension market UI
    '/api/extensions/install': true,
    '/api/extensions/update': true,
    '/api/extensions/delete': true,
    '/api/extensions/discover': true,
    // Images (silly_tavern.py)
    '/api/images/upload': true,
    '/api/images/list': true,
    '/api/images/folders': true,
    // Vector (silly_tavern.py)
    '/api/vector/index': true,
    '/api/vector/query': true,
    '/api/vector/query-multi': true,
    '/api/vector/insert': true,
    '/api/vector/delete': true,
    '/api/vector/list': true,
    '/api/vector/purge': true,
    '/api/vector/purge-all': true,
    // Speech (silly_tavern.py)
    '/api/speech/list': true,
    '/api/speech/get': true,
    '/api/speech/preview': true,
    '/api/speech/generate': true,
    // Speech — ElevenLabs 兼容层 (silly_tavern.py P1 语音套件)
    '/api/speech/elevenlabs/voices': true,
    '/api/speech/elevenlabs/voice-settings': true,
    '/api/speech/elevenlabs/synthesize': true,
    '/api/speech/elevenlabs/history': true,
    '/api/speech/elevenlabs/history-audio': true,
    '/api/speech/elevenlabs/voices/add': true,
    '/api/speech/elevenlabs/recognize': true,
    // ST Extras 兼容层 (silly_tavern.py P1-9/P1-11/P1-12: extras 服务端 Palink 自实现)
    '/api/modules': true,
    '/api/summarize': true,
    '/api/extra/caption': true,
    '/api/extra/classify': true,
    '/api/extra/classify/labels': true,
    // Live2D 模型池 (live2d_pool.py，Palink 自有路由组 prefix=/api/live2d-pool)
    '/api/live2d-pool/models': true,
    '/api/live2d-pool/upload': true,
    // Translate & Search (silly_tavern.py)
    '/api/translate': true,
    '/api/search': true,
    // Backends (silly_tavern.py — Palink inference engine)
    '/api/backends/chat-completions/status': true,
    '/api/backends/chat-completions/generate': true,
    '/api/backends/text-completions/generate': true,
    '/api/backends/kobold/embed': true
  };

  // 动态路径前缀匹配 — 用于路径参数化的端点
  // 例如 /api/chats/swipe/{index} 和 /api/images/list/{folder}
  var REAL_API_PREFIXES = [
    '/api/chats/swipe/',  // /api/chats/swipe/{index}
    '/api/images/list/',  // /api/images/list/{folder}
    '/api/translate/',     // /api/translate/{provider}（onering/libre/google/lingva/deepl/deeplx/bing/yandex，Palink 已实现）
    '/api/live2d-pool/'   // /api/live2d-pool/models/{model_id}、/api/live2d-pool/files/{model_id}/{path}（live2d_pool.py）
  ];

  function isPalinkOwnedApi(apiPath) {
    if (REAL_API_PATHS[apiPath]) return true;
    for (var i = 0; i < REAL_API_PREFIXES.length; i++) {
      if (apiPath.indexOf(REAL_API_PREFIXES[i]) === 0) return true;
    }
    return false;
  }

  /**
   * Native 模式下需要拦截的 ST 自有管理 API 路径
   * 对应 ST 自带的 Connection Manager / API Keys / TTS Provider / Image Provider 管理面板
   * nativeMode 下应隐藏，重定向到 Palink 设置入口
   * 注意：不影响核心功能路径（/api/tts 生成、/api/sd/generate 等）
   */
  function isStNativeManagedApi(apiPath) {
    if (apiPath.startsWith('/api/connection')) return true;      // Connection Manager
    if (apiPath.startsWith('/api/keys')) return true;           // API Keys 管理
    if (apiPath.startsWith('/api/tts/provider')) return true;    // TTS Provider 管理（不影响 /api/tts 生成）
    if (apiPath.startsWith('/api/sd/provider')) return true;     // SD Provider 管理（不影响 /api/sd/generate）
    if (apiPath === '/api/tts/load') return true;               // TTS 加载 voices
    if (apiPath === '/api/sd/get-models') return true;           // SD 获取模型列表（provider 管理用）
    return false;
  }

  function cloneHeaders(headersLike) {
    try {
      return new Headers(headersLike || {});
    } catch (e) {
      return new Headers();
    }
  }

  function getPalinkToken() {
    try {
      return window.parent && window.parent !== window
        ? window.parent.localStorage.getItem('palink_token')
        : localStorage.getItem('palink_token');
    } catch (e) {
      try { return localStorage.getItem('palink_token'); } catch (_) { return ''; }
    }
  }

  function palinkAvatarKey(characterId) {
    return 'palink-' + String(characterId || '').trim() + '.png';
  }

  function palinkSessionFile(sessionId) {
    return sessionId ? 'palink-session-' + String(sessionId).trim() : '';
  }

  function palinkStatusText() {
    return bootContext.model ? 'Palink API: ' + bootContext.model : 'Palink API';
  }

  function forcePalinkApiState() {
    window.__PALINK_ST_MODEL = bootContext.model || '';
    try {
      if (window.SillyTavern && window.SillyTavern.setOnlineStatus) {
        window.SillyTavern.setOnlineStatus(palinkStatusText());
      }
    } catch (e) {
      console.warn('[ST-Bridge] setOnlineStatus failed:', e);
    }
  }

  function syncModelFromStSettings() {
    try {
      if (window.oai_settings && window.oai_settings.openai_model) {
        var newModel = String(window.oai_settings.openai_model || '').trim();
        if (newModel && newModel !== bootContext.model) {
          bootContext.model = newModel;
          window.__PALINK_ST_MODEL = newModel;
          forcePalinkApiState();
        }
      }
      if (window.oai_settings && window.oai_settings.custom_model) {
        var customModel = String(window.oai_settings.custom_model || '').trim();
        if (customModel && customModel !== bootContext.model) {
          bootContext.model = customModel;
          window.__PALINK_ST_MODEL = customModel;
          forcePalinkApiState();
        }
      }
    } catch (e) {
      console.warn('[ST-Bridge] syncModelFromStSettings failed:', e);
    }
  }

  function setupModelSync() {
    try {
      var checkInterval = setInterval(function () {
        syncModelFromStSettings();
      }, 1500);
      window.__PALINK_ST_MODEL_SYNC = checkInterval;
    } catch (e) {
      console.warn('[ST-Bridge] setupModelSync failed:', e);
    }
  }

  function rewriteSillyTavernRootPath(resolvedUrl) {
    var path = resolvedUrl.pathname;
    if (path.startsWith('/st/') || path.startsWith('/api/')) return null;
    if (path === '/version' || path === '/csrf-token') return null;
    if (/^\/(locales|scripts|lib|css|img|sounds|backgrounds|themes|templates|user|User Avatars|worlds|movingUI|quick-replies|characters|assets)(\/|$)/i.test(path)) {
      return '/st' + path + resolvedUrl.search;
    }
    return null;
  }

  function normalizeSillyTavernApiPath(path) {
    return path.startsWith('/st/api/') ? path.slice(3) : path;
  }

  function withPalinkHeaders(input, init) {
    var requestInput = input instanceof Request ? input : null;
    var next = Object.assign({}, init || {});
    if (requestInput) {
      next.method = next.method || requestInput.method;
      next.body = next.body || requestInput.body;
      next.cache = next.cache || requestInput.cache;
      next.credentials = next.credentials || requestInput.credentials;
      next.mode = next.mode || requestInput.mode;
      next.redirect = next.redirect || requestInput.redirect;
      next.referrer = next.referrer || requestInput.referrer;
      next.referrerPolicy = next.referrerPolicy || requestInput.referrerPolicy;
      next.integrity = next.integrity || requestInput.integrity;
      next.keepalive = next.keepalive || requestInput.keepalive;
      next.signal = next.signal || requestInput.signal;
    }
    var headers = cloneHeaders(next.headers);
    if (requestInput) {
      requestInput.headers.forEach(function(value, key) {
        if (!headers.has(key)) headers.set(key, value);
      });
    }
    var token = getPalinkToken();
    if (token && !headers.has('Authorization')) {
      headers.set('Authorization', 'Bearer ' + token);
    }
    if (bootContext.characterId) headers.set('X-Palink-Character-Id', bootContext.characterId);
    if (bootContext.sessionId) headers.set('X-Palink-Session-Id', bootContext.sessionId);
    if (bootContext.branchId) headers.set('X-Palink-Branch-Id', bootContext.branchId);
    if (bootContext.model) headers.set('X-Palink-Model', bootContext.model);
    next.headers = headers;
    return next;
  }

  async function fetchPalinkApi(input, init, resolvedUrl, path) {
    var targetPath = path === '/version'
      ? '/api/st/version'
      : path === '/csrf-token'
        ? '/api/st/csrf-token'
        : path;
    return originalFetch.call(window, targetPath + resolvedUrl.search, withPalinkHeaders(input, init));
  }

  async function fetchStSidecarProxy(input, init, resolvedUrl, apiPath) {
    var proxyPath = '/api/st/native/proxy' + apiPath + resolvedUrl.search;
    return originalFetch.call(window, proxyPath, withPalinkHeaders(input, init));
  }

  function isStaticAsset(pathname) {
    if (pathname.startsWith('/st/')) return true;
    if (pathname === '/st/favicon.ico') return true;
    if (pathname === '/st/manifest.json') return true;
    if (pathname.match(/\.(js|css|png|jpg|jpeg|gif|svg|ico|woff|woff2|ttf|eot|webp|webm|mp3|mp4|json|html|map)$/i)) return true;
    return false;
  }

  /**
   * 获取插件端点注册表
   * 优先从当前 window 读取，若不存在且 window.parent 可访问则尝试从父窗口读取
   * 跨域访问父窗口时 try-catch 静默失败
   */
  function getPluginEndpointRegistry() {
    try {
      if (window.__palinkEndpointRegistry) return window.__palinkEndpointRegistry;
    } catch (e) { /* ignore */ }
    try {
      if (window.parent && window.parent !== window && window.parent.__palinkEndpointRegistry) {
        return window.parent.__palinkEndpointRegistry;
      }
    } catch (e) { /* 跨域访问父窗口 */ }
    return null;
  }

  /**
   * 调用插件注册的端点 handler，返回 Response 对象
   * - method 不匹配时返回 405
   * - handler 抛错时返回 500
   * - handler 返回 Response 原样返回；其他值包装为 JSON Response
   */
  function invokePluginEndpoint(entry, method, url, init) {
    var requestMethod = String(method || 'GET').toUpperCase();
    if (requestMethod !== String(entry.method || 'GET').toUpperCase()) {
      return Promise.resolve(new Response(JSON.stringify({ error: 'Method not allowed' }), {
        status: 405,
        headers: { 'Content-Type': 'application/json' }
      }));
    }
    try {
      var request = new Request(url, init);
      var result = entry.handler(request);
      return Promise.resolve(result).then(function (res) {
        if (res instanceof Response) return res;
        var body = res == null ? '{}' : JSON.stringify(res);
        return new Response(body, {
          status: 200,
          headers: { 'Content-Type': 'application/json' }
        });
      }).catch(function (e) {
        return new Response(JSON.stringify({ error: String(e && e.message || e) }), {
          status: 500,
          headers: { 'Content-Type': 'application/json' }
        });
      });
    } catch (e) {
      return Promise.resolve(new Response(JSON.stringify({ error: String(e && e.message || e) }), {
        status: 500,
        headers: { 'Content-Type': 'application/json' }
      }));
    }
  }

  window.fetch = async function (input, init) {
    var url = typeof input === 'string' ? input : (input instanceof Request ? input.url : String(input));

    try {
      var resolvedUrl = new URL(url, location.origin);
      var path = resolvedUrl.pathname;

      if (resolvedUrl.hostname === '127.0.0.1' && resolvedUrl.port === '7777') {
        return originalFetch.apply(this, arguments);
      }

      if (path === '/st/css/user.css') {
        return new Response('', { status: 200, headers: { 'Content-Type': 'text/css' } });
      }

      var rewrittenStaticPath = rewriteSillyTavernRootPath(resolvedUrl);
      if (rewrittenStaticPath) {
        return originalFetch.call(window, rewrittenStaticPath, init);
      }

      if (isStaticAsset(path)) {
        return originalFetch.apply(this, arguments);
      }

      var method = (init && init.method) || 'GET';
      var apiPath = normalizeSillyTavernApiPath(path);

      // Layer 0: 插件端点拦截 — /api/plugins/{plugin_id}/{endpoint_path}
      // 优先调用前端注册的 handler，未注册则继续走正常流程
      var pluginEndpointMatch = apiPath.match(/^\/api\/plugins\/([^/]+)\/(.+)$/);
      if (pluginEndpointMatch) {
        var pluginId = pluginEndpointMatch[1];
        var endpointPath = pluginEndpointMatch[2];
        // 跳过 asset 路径（由后端处理资源请求）
        if (endpointPath !== 'asset' && endpointPath.indexOf('asset/') !== 0) {
          var registry = getPluginEndpointRegistry();
          if (registry) {
            var entry = registry.get(pluginId + '/' + endpointPath);
            if (entry) {
              return invokePluginEndpoint(entry, method, url, init);
            }
          }
        }
      }

      // Layer 1: Palink-owned API → Palink backend
      if (isPalinkOwnedApi(apiPath)) {
        return fetchPalinkApi(input, init, resolvedUrl, apiPath);
      }

      // Guard: 递归代理防护 — /api/st/native/proxy/* 已经是代理路径，直接放行
      if (apiPath.startsWith('/api/st/native/proxy/') || apiPath === '/api/st/native/proxy') {
        return originalFetch.apply(this, arguments);
      }

      // Guard: Palink 后端直连路径（非 ST API）直接放行
      if (apiPath.startsWith('/api/st/') || apiPath.startsWith('/api/token') || apiPath.startsWith('/api/openai/')) {
        return originalFetch.apply(this, arguments);
      }

      // Layer 1.5: Native 模式拦截 — ST 自有管理路径重定向到 Palink 设置入口
      // nativeMode=true 时拦截 Connection Manager / API Keys / TTS Provider / SD Provider 等管理面板请求
      // 不影响核心功能路径（chat/character/worldinfo/groups/tts 生成/sd 生成）和 REAL_API_PATHS 白名单
      if (nativeMode && isStNativeManagedApi(apiPath)) {
        return new Response(JSON.stringify({ error: 'redirect_to_palink_settings' }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' }
        });
      }

      // Layer 2: Other /api/* → transparent proxy to ST sidecar
      if (apiPath.startsWith('/api/') || path === '/version' || path === '/csrf-token') {
        return fetchStSidecarProxy(input, init, resolvedUrl, apiPath);
      }

      return originalFetch.apply(this, arguments);
    } catch (e) {
      return originalFetch.apply(this, arguments);
    }
  };

  // S-1: postMessage 目标 origin 收紧。此前 '*' 会把消息发给任意父窗口
  //（若本 iframe 被恶意页面嵌入，消息会泄露给攻击者）。iframe 的 referrer
  // 恒为加载本页的父窗口 URL，取其 origin 作为目标 origin；referrer 不可用时
  // 回退同源（本 iframe 与宿主同源部署的场景）。
  var HOST_ORIGIN = (function () {
    try {
      return new URL(document.referrer || '').origin;
    } catch (e) {
      return window.location.origin;
    }
  })();

  function sendToPalink(data) {
    if (window.parent && window.parent !== window) {
      window.parent.postMessage(Object.assign({ source: 'st-bridge' }, data), HOST_ORIGIN);
    }
  }

  window.addEventListener('message', function (event) {
    if (!event.data || event.data.source !== 'palink-bridge') return;

    var action = event.data.action;
    var payload = event.data.payload;

    switch (action) {
      case 'loadCharacter':
        injectCharacter(payload);
        break;
      case 'loadMessages':
        injectMessages(payload);
        break;
      case 'bootContext':
        bootContext = Object.assign(bootContext, payload || {});
        window.__PALINK_ST_BOOT_CONTEXT = bootContext;
        window.__PALINK_ST_MODEL = bootContext.model || '';
        bootDone = false;
        bootPending = true;
        forcePalinkApiState();
        schedulePalinkBoot(0);
        break;
      case 'appendMessage':
        appendMessage(payload);
        break;
      case 'setGenerating':
        setGenerating(payload);
        break;
    }
  });

  function removeWelcomePanel() {
    try {
      var chatEl = document.getElementById('chat');
      if (chatEl) {
        var welcome = chatEl.querySelector('.welcomePanel');
        if (welcome) welcome.remove();
      }
    } catch (e) {}
  }

  function normalizeStMessage(message, index) {
    if (!message || typeof message !== 'object') return null;
    if (message.chat_metadata && !message.mes) return null;
    if (Object.prototype.hasOwnProperty.call(message, 'mes')) {
      var existing = Object.assign({}, message);
      if (!Array.isArray(existing.swipes)) existing.swipes = [String(existing.mes || '')];
      if (typeof existing.swipe_id !== 'number') existing.swipe_id = 0;
      if (!Array.isArray(existing.swipe_info)) existing.swipe_info = existing.swipes.map(function() { return { send_date: existing.send_date || '', extra: {} }; });
      if (!existing.extra || typeof existing.extra !== 'object') existing.extra = {};
      if (typeof existing.mesid !== 'number') existing.mesid = index;
      return existing;
    }
    var role = String(message.role || '').toLowerCase();
    var content = message.content != null ? message.content : (message.text != null ? message.text : '');
    var mes = typeof content === 'string' ? content : JSON.stringify(content || '');
    var isUser = role === 'user' || message.is_user === true;
    var isSystem = role === 'system' || message.is_system === true;
    return {
      id: message.id,
      mesid: typeof message.mesid === 'number' ? message.mesid : index,
      name: message.name || (isUser ? 'User' : isSystem ? 'System' : 'Assistant'),
      is_user: isUser,
      is_system: isSystem,
      send_date: message.send_date || message.created_at || new Date().toISOString(),
      mes: mes,
      swipes: Array.isArray(message.swipes) && message.swipes.length ? message.swipes : [mes],
      swipe_id: typeof message.swipe_id === 'number' ? message.swipe_id : 0,
      swipe_info: Array.isArray(message.swipe_info) ? message.swipe_info : [{ send_date: message.send_date || message.created_at || '', extra: {} }],
      extra: message.extra && typeof message.extra === 'object' ? message.extra : {}
    };
  }

  function applyCharacters(characters) {
    var ctx = window.SillyTavern && window.SillyTavern.getContext ? window.SillyTavern.getContext() : null;
    if (!ctx || !Array.isArray(ctx.characters) || !Array.isArray(characters)) return false;
    ctx.characters.splice.apply(ctx.characters, [0, ctx.characters.length].concat(characters));
    return true;
  }

  function applyChatSnapshot(snapshot) {
    var ctx = window.SillyTavern && window.SillyTavern.getContext ? window.SillyTavern.getContext() : null;
    if (!ctx || !Array.isArray(ctx.chat) || !Array.isArray(snapshot)) return false;
    var messages = snapshot.filter(function(item) { return !(item && item.chat_metadata && !item.mes); }).map(normalizeStMessage).filter(Boolean);
    ctx.chat.splice.apply(ctx.chat, [0, ctx.chat.length].concat(messages));
    if (ctx.chatMetadata && snapshot[0] && snapshot[0].chat_metadata) {
      Object.keys(ctx.chatMetadata).forEach(function(key) { delete ctx.chatMetadata[key]; });
      Object.assign(ctx.chatMetadata, snapshot[0].chat_metadata);
    }
    if (window.SillyTavern.printMessages) {
      window.SillyTavern.printMessages();
    }
    removeWelcomePanel();
    return true;
  }

  function injectCharacter(character) {
    console.log('[ST-Bridge] Loading character:', character && character.name);
    try {
      removeWelcomePanel();
      if (window.SillyTavern && window.SillyTavern.getContext) {
        var ctx = window.SillyTavern.getContext();
        if (ctx.characters && character) {
          ctx.characters.splice(0, ctx.characters.length, character);
        }
        if (window.SillyTavern.setCharacterId) window.SillyTavern.setCharacterId(0);
        if (window.SillyTavern.selectCharacterById) window.SillyTavern.selectCharacterById(0, { switchMenu: false });
      }
    } catch (e) {
      console.error('[ST-Bridge] injectCharacter error:', e);
    }
  }

  function injectMessages(messages) {
    console.log('[ST-Bridge] Loading messages:', messages && messages.length);
    try {
      removeWelcomePanel();
      if (window.SillyTavern && window.SillyTavern.getContext) {
        var ctx = window.SillyTavern.getContext();
        if (ctx.chat && Array.isArray(messages)) {
          var normalized = messages.map(normalizeStMessage).filter(Boolean);
          ctx.chat.splice.apply(ctx.chat, [0, ctx.chat.length].concat(normalized));
        }
        if (window.SillyTavern.printMessages) {
          window.SillyTavern.printMessages();
        }
      }
    } catch (e) {
      console.error('[ST-Bridge] injectMessages error:', e);
    }
  }

  function appendMessage(message) {
    console.log('[ST-Bridge] Append message:', message && message.role);
    try {
      if (window.SillyTavern && window.SillyTavern.getContext) {
        var ctx = window.SillyTavern.getContext();
        if (ctx.chat) {
          var normalized = normalizeStMessage(message, ctx.chat.length);
          if (normalized) ctx.chat.push(normalized);
        }
      }
    } catch (e) {
      console.error('[ST-Bridge] appendMessage error:', e);
    }
  }

  function setGenerating(isGenerating) {
    try {
      var sendBut = document.getElementById('send_but');
      var cancelBut = document.getElementById('cancel_but');
      if (sendBut) sendBut.style.display = isGenerating ? 'none' : '';
      if (cancelBut) cancelBut.style.display = isGenerating ? '' : 'none';
    } catch (e) {}
  }

  function checkSTReady() {
    var stExists = !!(window.SillyTavern && window.SillyTavern.getContext);
    if (stExists) {
      console.log('[ST-Bridge] ST is ready');
      sendToPalink({ type: 'ready' });
      hookSTEvents();
      forcePalinkApiState();
      schedulePalinkBoot(0);
    } else {
      setTimeout(checkSTReady, 500);
    }
  }

  function selectBootCharacter(attempt) {
    try {
      if (!bootContext.characterId || !window.SillyTavern || !window.SillyTavern.getContext) return;
      var ctx = window.SillyTavern.getContext();
      var chars = ctx && ctx.characters;
      if (!Array.isArray(chars) || !chars.length) {
        if ((attempt || 0) < 20) setTimeout(function() { selectBootCharacter((attempt || 0) + 1); }, 500);
        return;
      }
      var expectedAvatar = 'palink-' + bootContext.characterId + '.png';
      var index = chars.findIndex(function(ch) { return ch && ch.avatar === expectedAvatar; });
      if (index < 0) {
        if ((attempt || 0) < 20) setTimeout(function() { selectBootCharacter((attempt || 0) + 1); }, 500);
        return;
      }
      if (window.SillyTavern.selectCharacterById) {
        window.SillyTavern.selectCharacterById(index, { switchMenu: false });
      }
    } catch (e) {
      console.warn('[ST-Bridge] selectBootCharacter failed:', e);
    }
  }

  function schedulePalinkBoot(attempt) {
    if (!bootPending || bootDone) return;
    if (!(window.SillyTavern && window.SillyTavern.isAppReady)) {
      if ((attempt || 0) < 80) setTimeout(function() { schedulePalinkBoot((attempt || 0) + 1); }, 250);
      return;
    }
    forcePalinkBoot(attempt || 0);
  }

  async function forcePalinkBoot(attempt) {
    attempt = attempt || 0;
    if (bootDone || bootInFlight) return;
    if (!bootContext.characterId) return;
    if (!window.SillyTavern || !window.SillyTavern.getContext) {
      if (attempt < 30) setTimeout(function() { forcePalinkBoot(attempt + 1); }, 350);
      return;
    }

    var ctx = window.SillyTavern.getContext();
    if (!ctx || !Array.isArray(ctx.characters) || !Array.isArray(ctx.chat)) {
      if (attempt < 30) setTimeout(function() { forcePalinkBoot(attempt + 1); }, 350);
      return;
    }

    bootInFlight = true;
    try {
      var charactersResponse = await originalFetch.call(window, '/api/characters/all', withPalinkHeaders('/api/characters/all', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: '{}'
      }));
      if (!charactersResponse.ok) throw new Error('characters/all ' + charactersResponse.status);
      var characters = await charactersResponse.json();
      applyCharacters(characters);

      var expectedAvatar = palinkAvatarKey(bootContext.characterId);
      var index = ctx.characters.findIndex(function(ch) { return ch && ch.avatar === expectedAvatar; });
      if (index < 0) throw new Error('boot character not found: ' + expectedAvatar);

      var chatBody = {
        avatar_url: expectedAvatar,
        file_name: bootContext.sessionId ? palinkSessionFile(bootContext.sessionId) : (ctx.characters[index] && ctx.characters[index].chat),
        ch_name: ctx.characters[index] && ctx.characters[index].name
      };
      var chatResponse = await originalFetch.call(window, '/api/chats/get', withPalinkHeaders('/api/chats/get', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(chatBody)
      }));
      if (!chatResponse.ok) throw new Error('chats/get ' + chatResponse.status);
      var snapshot = await chatResponse.json();

      if (window.SillyTavern.setCharacterId) window.SillyTavern.setCharacterId(index);
      applyChatSnapshot(snapshot);

      if (window.SillyTavern.selectCharacterById) {
        await window.SillyTavern.selectCharacterById(index, { switchMenu: false });
      }
      applyChatSnapshot(snapshot);
      forcePalinkApiState();
      setupModelSync();
      bootDone = true;
      bootPending = false;
      console.log('[ST-Bridge] Palink boot applied:', expectedAvatar, snapshot.length);
    } catch (e) {
      console.warn('[ST-Bridge] forcePalinkBoot failed:', e);
      if (attempt < 30) setTimeout(function() { forcePalinkBoot(attempt + 1); }, 500);
    } finally {
      bootInFlight = false;
    }
  }

  function hookSTEvents() {
    try {
      var sendForm = document.getElementById('send_form');
      if (sendForm) {
        sendForm.addEventListener('submit', function (e) {
          e.preventDefault();
          var textarea = document.getElementById('send_textarea');
          if (textarea && textarea.value.trim()) {
            sendToPalink({ type: 'sendMessage', content: textarea.value.trim() });
          }
        }, true);
      }

      var sendBut = document.getElementById('send_but');
      if (sendBut) {
        sendBut.addEventListener('click', function (e) {
          e.preventDefault();
          e.stopPropagation();
          var textarea = document.getElementById('send_textarea');
          if (textarea && textarea.value.trim()) {
            sendToPalink({ type: 'sendMessage', content: textarea.value.trim() });
          }
        }, true);
      }

      try {
        var ctx = window.SillyTavern.getContext();
        if (ctx && ctx.eventSource) {
          ctx.eventSource.on('MESSAGE_SENT', function () {
            var textarea = document.getElementById('send_textarea');
            if (textarea && textarea.value.trim()) {
              sendToPalink({ type: 'sendMessage', content: textarea.value.trim() });
            }
          });
        }
      } catch (e) {
        console.warn('[ST-Bridge] eventSource hook failed:', e);
      }
    } catch (e) {
      console.error('[ST-Bridge] hookSTEvents error:', e);
    }
  }

  if (document.readyState === 'complete') {
    setTimeout(checkSTReady, 1000);
  } else {
    window.addEventListener('load', function () {
      setTimeout(checkSTReady, 1000);
    });
    // fallback: if load event never fires, start checking after 5s
    setTimeout(function() {
      checkSTReady();
    }, 5000);
  }

  console.log('[ST-Bridge] Loaded');
})();
