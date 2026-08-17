#!/usr/bin/env node

const { chromium } = require('playwright');

const BASE_URL = process.env.PALINK_BASE_URL || 'http://localhost:3000';
const USERNAME = process.env.PALINK_SMOKE_USER || 'admin';
const PASSWORD = process.env.PALINK_SMOKE_PASSWORD || 'admin123';
const SMOKE_MODEL = process.env.PALINK_SMOKE_MODEL || 'deepseek-v4-pro';
const SUBMIT_FLOW = process.env.PALINK_SMOKE_SUBMIT === '1';
const REQUIRE_INTERACTIVE_START = process.env.PALINK_SMOKE_REQUIRE_INTERACTIVE === '1' || SUBMIT_FLOW;

let MAGIC_CARD_ID = process.env.PALINK_MAGIC_CARD_ID || '22b2d1a3-5930-4080-8c31-76ca631970b1';
let BANG_CARD_ID = process.env.PALINK_BANG_CARD_ID || '7abd572b-48cc-4b5d-84ff-e2780d47ac69';
const MAGIC_CARD_NAME_PATTERN = /星与梦的魔法少女|魔法少女|magic/i;
const BANG_CARD_NAME_PATTERN = /BanG|City/i;

function assert(condition, message, details) {
  if (condition) return;
  const error = new Error(message);
  error.details = details;
  throw error;
}

async function login(page) {
  await page.goto(`${BASE_URL}/login`, { waitUntil: 'networkidle', timeout: 30000 });
  const tokenResult = await page.evaluate(async ({ username, password }) => {
    const body = new URLSearchParams();
    body.set('username', username);
    body.set('password', password);
    const response = await fetch('/api/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body,
    });
    const text = await response.text();
    let json = null;
    try { json = JSON.parse(text); } catch {}
    if (json?.access_token) localStorage.setItem('palink_token', json.access_token);
    return { status: response.status, ok: response.ok, hasToken: Boolean(json?.access_token), text: text.slice(0, 200) };
  }, { username: USERNAME, password: PASSWORD });
  assert(tokenResult.ok && tokenResult.hasToken, 'smoke login failed', tokenResult);
}

async function resolveCharacterId(page, preferredId, namePattern, label) {
  const result = await page.evaluate(async ({ preferredId, patternSource, patternFlags }) => {
    const token = localStorage.getItem('palink_token');
    const headers = token ? { Authorization: `Bearer ${token}` } : {};
    const preferredResponse = preferredId
      ? await fetch(`/api/characters/${preferredId}`, { headers }).catch(() => null)
      : null;
    if (preferredResponse?.ok) {
      const preferred = await preferredResponse.json();
      return { id: preferredId, name: preferred?.name || '', source: 'preferred' };
    }

    const charactersResponse = await fetch('/api/characters', { headers });
    if (!charactersResponse.ok) {
      return { id: preferredId, source: 'preferred-missing-list-failed', status: charactersResponse.status };
    }
    const characters = await charactersResponse.json();
    const pattern = new RegExp(patternSource, patternFlags);
    const found = Array.isArray(characters)
      ? characters.find((character) => pattern.test(String(character?.name || '')))
      : null;
    return found
      ? { id: found.id, name: found.name || '', source: 'name' }
      : { id: preferredId, source: 'not-found', count: Array.isArray(characters) ? characters.length : -1 };
  }, {
    preferredId,
    patternSource: namePattern.source,
    patternFlags: namePattern.flags,
  });

  assert(result?.id, `unable to resolve ${label} character id`, result);
  return result.id;
}

async function clickFreshConversation(page) {
  const candidates = [
    () => page.locator('button').filter({ has: page.locator('svg') }).first().click({ timeout: 2500, force: true }),
    () => page.locator('button').last().click({ timeout: 2500, force: true }),
  ];

  let lastError = null;
  for (const click of candidates) {
    try {
      await click();
      await page.waitForTimeout(5000);
      return true;
    } catch (error) {
      lastError = error;
    }
  }

  throw new Error(`Unable to click a fresh conversation control: ${lastError?.message || lastError}`);
}

async function createFreshInitSession(page, characterId) {
  return page.evaluate(async ({ characterId, model }) => {
    const token = localStorage.getItem('palink_token');
    if (!token) throw new Error('No login token found for smoke test');

    const response = await fetch('/api/character-chat', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        character_id: characterId,
        message: '__INIT__',
        model,
        temperature: 0.7,
        top_p: 0.9,
        max_tokens: 2048,
        frequency_penalty: 0,
        presence_penalty: 0,
        dialogue_mode: 'normal',
        user_nickname: 'smoke-player',
        response_length: 'medium',
      }),
    });

    if (!response.ok) {
      const errorText = await response.text().catch(() => response.statusText);
      throw new Error(`Failed to create __INIT__ session: ${response.status} ${errorText}`);
    }

    const reader = response.body?.getReader();
    if (!reader) throw new Error('The __INIT__ response did not expose an SSE body');

    const decoder = new TextDecoder();
    let buffer = '';
    let sessionId = null;
    let branchId = null;
    let assistantContent = '';
    let done = false;

    const consumeEvent = (eventText) => {
      const dataLines = eventText
        .split(/\r?\n/)
        .filter((line) => line.startsWith('data:'))
        .map((line) => line.slice(5).trimStart());
      if (dataLines.length === 0) return;
      const data = dataLines.join('\n').trim();
      if (!data) return;
      if (data === '[DONE]') {
        done = true;
        return;
      }
      try {
        const json = JSON.parse(data);
        if (typeof json.session_id === 'string') sessionId = json.session_id;
        if (typeof json.branch_id === 'string') branchId = json.branch_id;
        if (typeof json.content === 'string') assistantContent += json.content;
      } catch {
        // Ignore non-JSON SSE events.
      }
    };

    while (!done) {
      const { value, done: readerDone } = await reader.read();
      if (value) {
        buffer += decoder.decode(value, { stream: !readerDone });
        const events = buffer.split(/\r?\n\r?\n/);
        buffer = events.pop() || '';
        events.forEach(consumeEvent);
      }
      if (readerDone) break;
    }
    if (buffer.trim()) consumeEvent(buffer);

    if (!sessionId) throw new Error('The __INIT__ SSE stream did not return session_id');
    return {
      sessionId,
      branchId,
      assistantPrefix: assistantContent.slice(0, 160),
    };
  }, { characterId, model: SMOKE_MODEL });
}

async function getSmartFrames(page) {
  const frames = page.frames().filter((frame) => frame.url().startsWith('about:srcdoc'));
  const inspected = [];
  for (const frame of frames) {
    let shape = {};
    try {
      shape = await frame.evaluate(() => ({
        compat: Boolean(window.__palinkSmartCardCompatV2),
        palinkApi: Boolean(window.PalinkSmartCard),
        getContext: typeof window.getContext === 'function',
        setChatMessage: typeof window.setChatMessage === 'function',
        hasMain: Boolean(document.querySelector('#mg-main-container,.mg-launcher,#dashboard,#main-wrapper')),
      }));
    } catch {
      shape = {};
    }
    inspected.push({
      frame,
      score:
        (shape.compat ? 100 : 0)
        + (frame.parentFrame() === page.mainFrame() ? 20 : 0)
        + (shape.palinkApi ? 10 : 0)
        + (shape.getContext ? 6 : 0)
        + (shape.setChatMessage ? 6 : 0)
        + (shape.hasMain ? 3 : 0),
    });
  }
  return inspected.sort((left, right) => right.score - left.score).map((item) => item.frame);
}

async function evaluateInSmartFrame(page, frame, fn, arg) {
  let currentFrame = frame;
  let lastError = null;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      return await currentFrame.evaluate(fn, arg);
    } catch (error) {
      lastError = error;
      if (!/Execution context was destroyed|Frame was detached|navigation/i.test(String(error?.message || error))) {
        throw error;
      }
      await page.waitForTimeout(900);
      const frames = await getSmartFrames(page);
      if (!frames.length) throw error;
      currentFrame = frames[0];
    }
  }
  throw lastError;
}

async function captureSmartCardReloadDebug(page) {
  return page.evaluate(async () => {
    const token = localStorage.getItem('palink_token');
    const pathMatch = location.pathname.match(/\/characters\/([^/?#]+)/);
    const characterId = pathMatch?.[1] || null;
    const messageNodes = Array.from(document.querySelectorAll('.character-card-renderer,.markdown-content,[data-palink-smart-card-frame]')).slice(0, 8);
    const domMessages = messageNodes.map((node) => ({
      tag: node.tagName,
      classes: node.getAttribute('class') || '',
      text: (node.textContent || '').slice(0, 260),
      iframeCount: node.querySelectorAll?.('iframe')?.length || 0,
      smartFrame: node.getAttribute('data-palink-smart-card-frame') || '',
    }));
    let api = null;
    if (token && characterId) {
      const headers = { Authorization: `Bearer ${token}` };
      const sessions = await fetch(`/api/characters/${characterId}/sessions`, { headers }).then((response) => response.json()).catch((error) => ({ error: String(error) }));
      const latestSession = Array.isArray(sessions) ? sessions[0] : null;
      if (latestSession?.id) {
        const data = await fetch(`/api/character-sessions/${latestSession.id}/messages?limit=5`, { headers }).then((response) => response.json()).catch((error) => ({ error: String(error) }));
        const messages = Array.isArray(data) ? data : data.messages || [];
        api = {
          latestSessionId: latestSession.id,
          messages: messages.map((message) => ({
            id: message.id,
            role: message.role,
            content: String(message.content || '').slice(0, 220),
            extraKeys: message.extra && typeof message.extra === 'object' ? Object.keys(message.extra).sort() : [],
            displayText: typeof message.extra?.display_text === 'string' ? message.extra.display_text.slice(0, 220) : null,
            swipeId: message.swipe_id,
            swipes: Array.isArray(message.swipes) ? message.swipes.length : 0,
            swipeInfo: Array.isArray(message.swipe_info)
              ? message.swipe_info.map((entry) => ({
                extraKeys: entry?.extra && typeof entry.extra === 'object' ? Object.keys(entry.extra).sort() : [],
                displayText: typeof entry?.extra?.display_text === 'string' ? entry.extra.display_text.slice(0, 220) : null,
              }))
              : null,
          })),
        };
      } else {
        api = { sessions };
      }
    }
    return {
      url: location.href,
      title: document.title,
      frameCount: document.querySelectorAll('iframe').length,
      bodyText: (document.body?.innerText || '').slice(0, 600),
      domMessages,
      api,
    };
  });
}

async function waitForCompatRuntime(page, frame, timeoutMs = 12000) {
  const deadline = Date.now() + timeoutMs;
  let currentFrame = frame;
  let lastShape = null;
  while (Date.now() < deadline) {
    try {
      const shape = await evaluateInSmartFrame(page, currentFrame, () => ({
        compat: Boolean(window.__palinkSmartCardCompatV2),
        thisChidDefined: window.this_chid !== undefined,
        thisChidValue: window.this_chid,
        characters: Array.isArray(window.characters),
        scopedExtensions: Boolean(window.characters?.[window.this_chid]?.data?.extensions),
        scopedRegexArray: Array.isArray(window.characters?.[window.this_chid]?.data?.extensions?.regex_scripts),
        getContext: typeof window.getContext,
        getRegexedString: typeof window.getRegexedString,
        messageFormatting: typeof window.messageFormatting,
      }));
      lastShape = shape;
      if (
        shape.compat
        && shape.thisChidDefined
        && shape.characters
        && shape.scopedExtensions
        && shape.getContext === 'function'
        && shape.getRegexedString === 'function'
        && shape.messageFormatting === 'function'
      ) {
        return { frame: currentFrame, shape };
      }
    } catch (error) {
      lastShape = { error: String(error?.message || error) };
    }
    await page.waitForTimeout(300);
    const frames = await getSmartFrames(page);
    if (frames.length) currentFrame = frames[0];
  }
  throw Object.assign(new Error('Smart card compat runtime was not ready in time'), { details: lastShape });
}

async function verifyRuntimeShapeAndPersistence(page, frame) {
  const ready = await waitForCompatRuntime(page, frame);
  frame = ready.frame;
  const runtimeShape = await evaluateInSmartFrame(page, frame, async () => {
    const messages = typeof window.getChatMessages === 'function' ? window.getChatMessages() : [];
    const first = messages[0] || {};
    const formatterOrder = [];
    window.messageFormatter?.addHook?.((mes) => {
      formatterOrder.push('early');
      return `${mes}|early`;
    }, { stage: window.messageFormatter.stage.AFTER_REGEX, order: window.messageFormatter.order.EARLY });
    window.messageFormatter?.addHook?.((mes) => {
      formatterOrder.push('late');
      return `${mes}|late`;
    }, { stage: window.messageFormatter.stage.AFTER_REGEX, order: window.messageFormatter.order.LATE });
    const formattedByHook = window.messageFormatter?.runStage?.(
      window.messageFormatter.stage.AFTER_REGEX,
      'hook',
      { characterName: 'Smoke', isSystem: false, isUser: false, messageId: 0, isReasoning: false },
    );
    const directFormatterOrder = formatterOrder.slice();
    formatterOrder.length = 0;
    const formattedByMessageFormatting = typeof window.messageFormatting === 'function'
      ? window.messageFormatting('**bold**', 'Smoke', false, false, 0)
      : '';
    const pipelineFormatterOrder = formatterOrder.slice();
    formatterOrder.length = 0;
    const ctx = typeof window.getContext === 'function' ? window.getContext() : {};
    const regexScript = {
      scriptName: 'palink-smoke-display-regex',
      findRegex: '/SMOKE_REGEX_SOURCE/g',
      replaceString: '<span class="smoke-regexed">SMOKE_REGEX_RENDERED</span>',
      placement: [2],
      markdownOnly: true,
      promptOnly: false,
      disabled: false,
    };
    const currentCharacter = window.characters?.[window.this_chid];
    if (!currentCharacter?.data?.extensions) {
      return {
        count: messages.length,
        directGlobals: {
          name1: typeof window.name1,
          name2: typeof window.name2,
          characters: Array.isArray(window.characters),
          this_chid: window.this_chid !== undefined,
          thisChidValue: window.this_chid,
          characterExtensionsReadable: false,
          currentCharacterKeys: currentCharacter ? Object.keys(currentCharacter).sort() : [],
        },
        runtimeNotReady: true,
      };
    }
    currentCharacter.data.extensions.regex_scripts = Array.isArray(currentCharacter.data.extensions.regex_scripts)
      ? currentCharacter.data.extensions.regex_scripts
      : [];
    const previousScopedRegex = Array.isArray(currentCharacter.data.extensions.regex_scripts)
      ? currentCharacter.data.extensions.regex_scripts.slice()
      : [];
    currentCharacter.data.extensions.regex_scripts = [regexScript, ...previousScopedRegex];
    const regexed = typeof window.getRegexedString === 'function'
      ? window.getRegexedString('SMOKE_REGEX_SOURCE', 2, { isMarkdown: true, depth: 0 })
      : '';
    const formattedRegexed = typeof window.messageFormatting === 'function'
      ? window.messageFormatting('SMOKE_REGEX_SOURCE', 'Smoke', false, false, 0)
      : '';
    const originalContent = first.mes || first.content || '';
    const displayText = '<div class="smoke-display-text">DISPLAY_TEXT_OK</div>';
    const smokeMessageId = '__palink_smoke_display_update__';
    const smokeIndex = messages.length;
    const smokeMessage = {
      id: smokeMessageId,
      message_id: smokeMessageId,
      mesid: smokeIndex,
      role: 'assistant',
      name: 'Smoke',
      is_user: false,
      is_system: false,
      mes: 'SMOKE_ORIGINAL_MESSAGE',
      content: 'SMOKE_ORIGINAL_MESSAGE',
      swipes: ['SMOKE_ORIGINAL_MESSAGE'],
      swipe_id: 0,
      swipe_info: [{ extra: {}, send_date: '' }],
      extra: {},
    };
    if (Array.isArray(window.chat)) window.chat.push(smokeMessage);
    if (typeof window.updateMessageBlock === 'function') {
      await window.updateMessageBlock(smokeMessageId, {
        ...smokeMessage,
        extra: { display_text: displayText },
      }, { index: smokeIndex, localOnly: true, refresh: 'display' });
    }
    const updatedSmoke = (typeof window.getChatMessages === 'function' ? window.getChatMessages(smokeMessageId) : [])[0] || {};
    const parentDomMessageId = '__palink_smoke_parent_dom_update__';
    const parentDomIndex = window.chat.length;
    const parentDomMessage = {
      id: parentDomMessageId,
      message_id: parentDomMessageId,
      mesid: parentDomIndex,
      role: 'assistant',
      name: 'Smoke DOM',
      is_user: false,
      is_system: false,
      mes: 'SMOKE_PARENT_DOM_ORIGINAL',
      content: 'SMOKE_PARENT_DOM_ORIGINAL',
      swipes: ['SMOKE_PARENT_DOM_ORIGINAL'],
      swipe_id: 0,
      swipe_info: [{ extra: {}, send_date: '' }],
      extra: {},
    };
    if (Array.isArray(window.chat)) window.chat.push(parentDomMessage);
    const parentDomDisplayText = '<section class="smoke-parent-dom-display">PARENT_DOM_DISPLAY_OK</section>';
    let parentDomCollectionInfo = null;
    if (typeof window.$ === 'function') {
      const parentDomCollection = window.$('.last_mes .mes_text');
      parentDomCollectionInfo = {
        length: parentDomCollection.length,
        ids: Array.from(parentDomCollection).map((node) => node?.id || node?.className || node?.tagName || ''),
        beforeHtml: parentDomCollection.html?.(),
      };
      parentDomCollection.html(parentDomDisplayText);
      await new Promise((resolve) => setTimeout(resolve, 120));
    }
    const parentDomUpdated = (typeof window.getChatMessages === 'function' ? window.getChatMessages(parentDomMessageId) : [])[0] || {};
    const parentDomPreserved = (parentDomUpdated.mes || parentDomUpdated.content || '') === 'SMOKE_PARENT_DOM_ORIGINAL';
    const selectorMatrix = {};
    if (typeof window.$ === 'function') {
      const selectors = [
        '.last_mes .mes_text',
        `'.mes[mesid="${parentDomIndex}"] .mes_text'`.slice(1, -1),
        `.mes[data-mesid="${parentDomIndex}"] .mes_text`,
        '.mes_text:not(.missing)',
        '#chat .mes:last .mes_text',
        '.last_mes .mes_block',
        '.last_mes .ch_name',
        '.last_mes .name_text',
        '.last_mes .avatar',
        '.last_mes .avatar img',
        '.last_mes .timestamp',
      ];
      selectors.forEach((selector) => {
        const collection = window.$(selector);
        selectorMatrix[selector] = {
          length: collection.length,
          firstId: collection[0]?.id || '',
          firstClass: collection[0]?.className || '',
          firstText: typeof collection.text === 'function' ? collection.text().slice(0, 120) : '',
          firstMesid: collection[0]?.closest?.('.mes')?.getAttribute?.('mesid') || collection[0]?.getAttribute?.('mesid') || '',
          closestMes: Boolean(collection[0]?.closest?.('.mes')),
          matchesSelf: Boolean(collection[0]?.matches?.(selector)),
        };
      });
    }
    const classMatrix = {
      mes: window.PalinkSmartCard?.parentDocument?.getElementsByClassName?.('mes')?.length || 0,
      mesText: window.PalinkSmartCard?.parentDocument?.getElementsByClassName?.('mes_text')?.length || 0,
      mesBlock: window.PalinkSmartCard?.parentDocument?.getElementsByClassName?.('mes_block')?.length || 0,
      chName: window.PalinkSmartCard?.parentDocument?.getElementsByClassName?.('ch_name')?.length || 0,
      avatar: window.PalinkSmartCard?.parentDocument?.getElementsByClassName?.('avatar')?.length || 0,
      timestamp: window.PalinkSmartCard?.parentDocument?.getElementsByClassName?.('timestamp')?.length || 0,
    };
    if (Array.isArray(window.chat)) window.chat.splice(parentDomIndex, 1);
    if (Array.isArray(window.chat)) window.chat.splice(smokeIndex, 1);
    const eventTypes = window.event_types || {};
    localStorage.setItem('__palink_smoke_local', 'persist-ok');
    if (typeof window.setVariable === 'function') window.setVariable('smoke.persist', 'variable-ok');
    window.chat_metadata = window.chat_metadata || {};
    window.chat_metadata.__palink_smoke = 'metadata-ok';
    window.saveSettingsDebounced?.();
    window.saveMetadataDebounced?.();
    const historyEvents = [];
    const historyPopListener = (event) => {
      historyEvents.push({ type: 'popstate', state: event.state || null });
    };
    const historyHashListener = (event) => {
      historyEvents.push({ type: 'hashchange', oldURL: event.oldURL || '', newURL: event.newURL || '' });
    };
    window.addEventListener('popstate', historyPopListener);
    window.addEventListener('hashchange', historyHashListener);
    const beforeHistoryLength = history.length;
    const beforeHistoryState = history.state;
    history.pushState({ smoke: 'one' }, '', '#palink-smoke-one');
    history.pushState({ smoke: 'two' }, '', '#palink-smoke-two');
    history.back();
    await new Promise((resolve) => setTimeout(resolve, 50));
    const afterBackState = history.state;
    const afterBackHash = window.location.hash;
    history.replaceState(beforeHistoryState || null, '', '#');
    window.removeEventListener('popstate', historyPopListener);
    window.removeEventListener('hashchange', historyHashListener);
    const extensionMenuBefore = Boolean(document.getElementById('palink-st-extension-settings'));
    let jqueryMount = {};
    try {
      const $ = window.$;
      const created = $('<div class="palink-smoke-plugin-setting"><button type="button" class="palink-smoke-plugin-btn">OK</button></div>');
      created.appendTo('#extensions_settings2');
      let clicks = 0;
      $('.palink-smoke-plugin-btn').on('click', () => { clicks += 1; });
      $('.palink-smoke-plugin-btn').trigger('click');
      jqueryMount = {
        dollarType: typeof $,
        createdLength: created.length,
        appendToType: typeof created.appendTo,
        removeType: typeof created.remove,
        showType: typeof created.show,
        hostExists: Boolean(document.getElementById('extensions_settings2')),
        inHost: Boolean(document.querySelector('#extensions_settings2 .palink-smoke-plugin-setting')),
        clicks,
      };
    } catch (error) {
      jqueryMount = { error: String(error?.message || error) };
    }
    let utilsCompat = {};
    try {
      const importUtil = (name) => window.__palinkStModuleImport?.('../../../utils.js', name);
      const escapeRegex = importUtil('escapeRegex');
      const escapeRegExp = importUtil('escapeRegExp');
      const debounce = importUtil('debounce');
      const throttle = importUtil('throttle');
      const delay = importUtil('delay');
      const waitUntilCondition = importUtil('waitUntilCondition');
      const parseJsonFile = importUtil('parseJsonFile');
      const saveJsonToFile = importUtil('saveJsonToFile');
      const timestampToMoment = importUtil('timestampToMoment');
      const humanizedDateTime = importUtil('humanizedDateTime');
      const defaultUtils = importUtil('default');
      let debounceCount = 0;
      const debounced = debounce(() => { debounceCount += 1; }, 1);
      debounced();
      debounced();
      await new Promise((resolve) => setTimeout(resolve, 10));
      let throttleCount = 0;
      const throttled = throttle(() => { throttleCount += 1; }, 20);
      throttled();
      throttled();
      const parsed = await parseJsonFile({ text: async () => '{"ok":true}' });
      utilsCompat = {
        escapeRegexType: typeof escapeRegex,
        escapeRegexValue: escapeRegex('a+b?'),
        escapeRegExpValue: escapeRegExp('[x]'),
        debounceType: typeof debounce,
        debounceCount,
        throttleType: typeof throttle,
        throttleCount,
        delayType: typeof delay,
        waitUntilConditionType: typeof waitUntilCondition,
        waitUntilConditionResult: await waitUntilCondition(() => true, 50, 1),
        parseJsonFileType: typeof parseJsonFile,
        parseJsonFileOk: parsed.ok === true,
        saveJsonToFileType: typeof saveJsonToFile,
        timestampToMomentType: typeof timestampToMoment,
        timestampFormatType: typeof timestampToMoment(Date.now()).format,
        humanizedDateTimeType: typeof humanizedDateTime,
        defaultObject: defaultUtils && typeof defaultUtils === 'object',
      };
    } catch (error) {
      utilsCompat = { error: String(error?.message || error) };
    }
    let extensionMenuResult = null;
    try {
      extensionMenuResult = typeof window.openThirdPartyExtensionMenu === 'function'
        ? await window.openThirdPartyExtensionMenu()
        : null;
    } catch (error) {
      extensionMenuResult = { error: String(error?.message || error) };
    }
    const extensionMenuNode = document.getElementById('palink-st-extension-settings');
    let moduleCompat = {};
    try {
      const importFrom = (modulePath, name) => window.__palinkStModuleImport?.(modulePath, name);
      const smokeModulePlugin = {
        id: 'palink-smoke-local-module',
        name: 'Palink Smoke Local Module',
        runtime: { enabled: true, execute_scripts: true },
        manifest: { id: 'palink-smoke-local-module', name: 'palink-smoke-local-module' },
        resources: {
          modules: [
            {
              path: 'lib/helper.js',
              zip_path: 'lib/helper.js',
              content: 'export function answer(){ return 42; }\\nexport const label = "ok";\\nexport { label as renamed };',
            },
          ],
        },
      };
      ctx.stPluginRuntimeConfig = ctx.stPluginRuntimeConfig || { plugins: [], extension_settings: {} };
      ctx.stPluginRuntimeConfig.plugins = Array.isArray(ctx.stPluginRuntimeConfig.plugins)
        ? [...ctx.stPluginRuntimeConfig.plugins.filter((plugin) => plugin?.id !== smokeModulePlugin.id), smokeModulePlugin]
        : [smokeModulePlugin];
      if (window.extension_settings?.palink_plugin_runtime) {
        window.extension_settings.palink_plugin_runtime.plugins = ctx.stPluginRuntimeConfig.plugins;
      }
      const localAnswer = window.__palinkStModuleImport?.('./helper.js', 'answer', smokeModulePlugin.id, 'lib/main.js');
      const localLabel = window.__palinkStModuleImport?.('./helper.js', 'label', smokeModulePlugin.id, 'lib/main.js');
      const localNamespace = window.__palinkStModuleNamespace?.('./helper.js', smokeModulePlugin.id, 'lib/main.js');
      moduleCompat = {
        scriptEventSource: typeof importFrom('../../../script.js', 'eventSource')?.emit,
        scriptGetRequestHeaders: typeof importFrom('../../../script.js', 'getRequestHeaders'),
        powerUserObject: importFrom('../../../scripts/power-user.js', 'power_user') && typeof importFrom('../../../scripts/power-user.js', 'power_user') === 'object',
        charactersGet: typeof importFrom('../../../scripts/characters.js', 'getCharacters'),
        groupsGet: typeof importFrom('../../../scripts/group-chats.js', 'getGroups'),
        worldEntriesGet: typeof importFrom('../../../scripts/world-info.js', 'getWorldbookEntries'),
        secretsRead: typeof importFrom('../../../scripts/secrets.js', 'readSecret'),
        slashRegister: typeof importFrom('../../../scripts/slash-commands.js', 'registerSlashCommand'),
        localModuleAnswer: typeof localAnswer === 'function' ? localAnswer() : null,
        localModuleLabel: localLabel,
        localModuleRenamed: localNamespace?.renamed,
      };
    } catch (error) {
      moduleCompat = { error: String(error?.message || error) };
    }
    let apiCompat = {};
    try {
      const settingsResponse = await fetch('/api/settings');
      const settingsJson = await settingsResponse.json();
      const charactersResponse = await fetch('/api/characters');
      const charactersJson = await charactersResponse.json();
      const secretsResponse = await fetch('/api/secrets/read');
      const secretsJson = await secretsResponse.json();
      apiCompat = {
        settingsOk: settingsResponse.ok,
        settingsHasExtensionSettings: settingsJson.extension_settings && typeof settingsJson.extension_settings === 'object',
        charactersOk: charactersResponse.ok,
        charactersIsArray: Array.isArray(charactersJson.characters),
        secretsOk: secretsResponse.ok,
        secretsHasValue: Object.prototype.hasOwnProperty.call(secretsJson, 'value'),
        saveSettingsType: typeof window.saveSettings,
        saveSettingsResult: await window.saveSettings?.(),
      };
    } catch (error) {
      apiCompat = { error: String(error?.message || error) };
    }
    const thirdPartyRuntime = {
      libs: {
        object: window.SillyTavern?.libs && typeof window.SillyTavern.libs === 'object',
        dollar: typeof window.SillyTavern?.libs?.$,
        jQuery: typeof window.SillyTavern?.libs?.jQuery,
        lodash: typeof window.SillyTavern?.libs?._,
        DOMPurifySanitize: typeof window.SillyTavern?.libs?.DOMPurify?.sanitize,
      },
      macros: {
        global: typeof window.macros,
        context: typeof ctx.macros,
        register: typeof window.macros?.register,
        unregister: typeof window.macros?.unregister,
        has: typeof window.macros?.has,
      },
      variables: {
        context: typeof ctx.variables,
        chatGet: typeof ctx.variables?.chat?.get,
        chatSet: typeof ctx.variables?.chat?.set,
        localGet: typeof ctx.variables?.local?.get,
        globalGet: typeof ctx.variables?.global?.get,
      },
      extensionSettings: {
        object: window.extension_settings && typeof window.extension_settings === 'object',
        runtimeObject: window.extension_settings?.palink_plugin_runtime
          && typeof window.extension_settings.palink_plugin_runtime === 'object',
        pluginsArray: Array.isArray(window.extension_settings?.palink_plugin_runtime?.plugins),
        generatedAtType: typeof window.extension_settings?.palink_plugin_runtime?.generated_at,
      },
      extensionMenu: {
        global: typeof window.openThirdPartyExtensionMenu,
        sillyTavern: typeof window.SillyTavern?.openThirdPartyExtensionMenu,
        context: typeof ctx.openThirdPartyExtensionMenu,
        returned: extensionMenuResult !== null,
        rendered: Boolean(extensionMenuNode),
        nativeMountRendered: Boolean(extensionMenuNode?.querySelector?.('.palink-smoke-plugin-setting')),
        before: extensionMenuBefore,
      },
      jqueryMount,
      utils: utilsCompat,
      modules: moduleCompat,
      api: apiCompat,
      templates: {
        renderExtensionTemplate: typeof window.renderExtensionTemplate,
        renderExtensionTemplateAsync: typeof window.renderExtensionTemplateAsync,
        loadExtensionSettings: typeof window.loadExtensionSettings,
        waitGlobalInitialized: typeof window.waitGlobalInitialized,
      },
    };
    extensionMenuNode?.remove?.();
    return {
      count: messages.length,
      firstKeys: Object.keys(first).sort(),
      hasMesid: Number.isFinite(Number(first.mesid)),
      hasMessageId: first.message_id !== undefined,
      hasName: typeof first.name === 'string' && first.name.length > 0,
      hasIsUser: typeof first.is_user === 'boolean',
      hasSwipes: Array.isArray(first.swipes),
      hasExtra: first.extra && typeof first.extra === 'object',
      chatIsStableArray: Array.isArray(window.chat) && window.chat === ctx.chat,
      contextChatIsArray: Array.isArray(ctx.chat),
      directGlobals: {
        name1: typeof window.name1,
        name2: typeof window.name2,
        characters: Array.isArray(window.characters),
        this_chid: window.this_chid !== undefined,
        thisChidValue: window.this_chid,
        characterExtensionsReadable: Array.isArray(window.characters?.[window.this_chid]?.data?.extensions?.regex_scripts),
      },
      regexCompat: {
        regexed,
        formattedRegexed,
        scopedCount: window.characters?.[window.this_chid]?.data?.extensions?.regex_scripts?.length || 0,
      },
      displayTextUpdate: {
        preservedMes: (updatedSmoke.mes || updatedSmoke.content || '') === 'SMOKE_ORIGINAL_MESSAGE',
        displayText: updatedSmoke.extra?.display_text,
        firstPreserved: (first.mes || first.content || '') === originalContent,
        parentDomDisplayText: parentDomUpdated.extra?.display_text,
        parentDomPreserved,
        parentDomCollectionInfo,
        selectorMatrix,
        classMatrix,
        parentDomExtraKeys: parentDomUpdated.extra && typeof parentDomUpdated.extra === 'object' ? Object.keys(parentDomUpdated.extra).sort() : [],
      },
      eventTypes: {
        MESSAGE_RECEIVED: eventTypes.MESSAGE_RECEIVED,
        MESSAGE_UPDATED: eventTypes.MESSAGE_UPDATED,
        MESSAGE_SWIPED: eventTypes.MESSAGE_SWIPED,
        CHAT_LOADED: eventTypes.CHAT_LOADED,
        CHARACTER_FIRST_MESSAGE_SELECTED: eventTypes.CHARACTER_FIRST_MESSAGE_SELECTED,
        STREAM_TOKEN_RECEIVED: eventTypes.STREAM_TOKEN_RECEIVED,
      },
      messageFormatter: {
        addHook: typeof window.messageFormatter?.addHook,
        runStage: typeof window.messageFormatter?.runStage,
        formattedByHook,
        directFormatterOrder,
        pipelineFormatterOrder,
        formattedByMessageFormatting,
      },
      swipe: {
        ctxSwipe: typeof ctx.swipe?.to,
        helperSwipe: typeof window.TavernHelper?.swipe?.to,
        stateCount: Number(ctx.swipe?.state?.()?.count || 0),
      },
      thirdPartyRuntime,
      history: {
        virtual: Boolean(history.__palinkVirtualHistory),
        beforeLength: beforeHistoryLength,
        afterLength: history.length,
        afterBackState,
        afterBackHash,
        eventTypes: historyEvents.map((item) => item.type),
      },
      storageNow: localStorage.getItem('__palink_smoke_local'),
      variableNow: typeof window.getVariable === 'function' ? window.getVariable('smoke.persist') : null,
      metadataNow: window.chat_metadata.__palink_smoke,
    };
  });

  assert(
    runtimeShape.count > 0
      && runtimeShape.hasMesid
      && runtimeShape.hasMessageId
      && runtimeShape.hasName
      && runtimeShape.hasIsUser
      && runtimeShape.hasSwipes
      && runtimeShape.hasExtra,
    'SillyTavern message shape is incomplete inside iframe',
    runtimeShape,
  );
  assert(
    runtimeShape.chatIsStableArray
      && runtimeShape.contextChatIsArray
      && runtimeShape.directGlobals.name1 === 'string'
      && runtimeShape.directGlobals.name2 === 'string'
      && runtimeShape.directGlobals.characters
      && runtimeShape.directGlobals.this_chid
      && runtimeShape.directGlobals.thisChidValue === 0
      && runtimeShape.directGlobals.characterExtensionsReadable,
    'SillyTavern global/context chat shape is incomplete inside iframe',
    runtimeShape,
  );
  assert(
    runtimeShape.regexCompat.regexed.includes('SMOKE_REGEX_RENDERED')
      && runtimeShape.regexCompat.formattedRegexed.includes('SMOKE_REGEX_RENDERED')
      && runtimeShape.regexCompat.scopedCount >= 1,
    'SillyTavern scoped regex/getRegexedString/messageFormatting compatibility is incomplete inside iframe',
    runtimeShape,
  );
  assert(
    runtimeShape.displayTextUpdate.preservedMes
      && runtimeShape.displayTextUpdate.displayText === '<div class="smoke-display-text">DISPLAY_TEXT_OK</div>',
    'updateMessageBlock(messageObject) did not preserve mes/display_text semantics',
    runtimeShape,
  );
  assert(
    typeof runtimeShape.displayTextUpdate.parentDomDisplayText === 'string'
      && runtimeShape.displayTextUpdate.parentDomDisplayText.includes('PARENT_DOM_DISPLAY_OK')
      && runtimeShape.displayTextUpdate.parentDomPreserved,
    'SillyTavern parent .mes_text DOM updates are not mirrored to Palink display_text',
    runtimeShape,
  );
  const selectorMatrix = runtimeShape.displayTextUpdate.selectorMatrix || {};
  const requiredParentSelectors = [
    '.last_mes .mes_text',
    '.mes_text:not(.missing)',
    '#chat .mes:last .mes_text',
    '.last_mes .mes_block',
    '.last_mes .ch_name',
    '.last_mes .name_text',
    '.last_mes .avatar',
    '.last_mes .avatar img',
    '.last_mes .timestamp',
  ];
  const missingSelectors = requiredParentSelectors.filter((selector) => Number(selectorMatrix[selector]?.length || 0) < 1);
  assert(
    missingSelectors.length === 0
      && Number(selectorMatrix['#chat .mes:last .mes_text']?.length || 0) === 1
      && String(selectorMatrix['#chat .mes:last .mes_text']?.firstMesid || '') === String(selectorMatrix['.last_mes .mes_text']?.firstMesid || '')
      && Number(runtimeShape.displayTextUpdate.classMatrix?.mesText || 0) >= 1
      && Number(runtimeShape.displayTextUpdate.classMatrix?.mesBlock || 0) >= 1
      && Number(runtimeShape.displayTextUpdate.classMatrix?.chName || 0) >= 1
      && Number(runtimeShape.displayTextUpdate.classMatrix?.avatar || 0) >= 1
      && Number(runtimeShape.displayTextUpdate.classMatrix?.timestamp || 0) >= 1,
    'SillyTavern parent DOM selector matrix is incomplete',
    runtimeShape.displayTextUpdate,
  );
  assert(
    runtimeShape.eventTypes.MESSAGE_RECEIVED === 'message_received'
      && runtimeShape.eventTypes.MESSAGE_UPDATED === 'message_updated'
      && runtimeShape.eventTypes.MESSAGE_SWIPED === 'message_swiped'
      && runtimeShape.eventTypes.CHAT_LOADED === 'chatLoaded'
      && runtimeShape.eventTypes.CHARACTER_FIRST_MESSAGE_SELECTED === 'character_first_message_selected'
      && runtimeShape.eventTypes.STREAM_TOKEN_RECEIVED === 'stream_token_received',
    'SillyTavern event_types constants are incomplete inside iframe',
    runtimeShape,
  );
  assert(
    runtimeShape.messageFormatter.addHook === 'function'
      && runtimeShape.messageFormatter.runStage === 'function'
      && runtimeShape.messageFormatter.formattedByHook === 'hook|early|late'
      && runtimeShape.messageFormatter.directFormatterOrder.join(',') === 'early,late'
      && runtimeShape.messageFormatter.pipelineFormatterOrder.join(',') === 'early,late'
      && /<strong>bold<\/strong>/.test(runtimeShape.messageFormatter.formattedByMessageFormatting),
    'SillyTavern MessageFormatter compatibility is incomplete inside iframe',
    runtimeShape,
  );
  assert(
    runtimeShape.swipe.ctxSwipe === 'function'
      && runtimeShape.swipe.helperSwipe === 'function'
      && runtimeShape.swipe.stateCount >= 1,
    'SillyTavern swipe API is incomplete inside iframe',
    runtimeShape,
  );
  assert(
    runtimeShape.thirdPartyRuntime.libs.object
      && runtimeShape.thirdPartyRuntime.libs.dollar === 'function'
      && runtimeShape.thirdPartyRuntime.libs.jQuery === 'function'
      && ['object', 'function'].includes(runtimeShape.thirdPartyRuntime.libs.lodash)
      && runtimeShape.thirdPartyRuntime.libs.DOMPurifySanitize === 'function'
      && runtimeShape.thirdPartyRuntime.macros.global === 'object'
      && runtimeShape.thirdPartyRuntime.macros.context === 'object'
      && runtimeShape.thirdPartyRuntime.macros.register === 'function'
      && runtimeShape.thirdPartyRuntime.macros.unregister === 'function'
      && runtimeShape.thirdPartyRuntime.variables.context === 'object'
      && runtimeShape.thirdPartyRuntime.variables.chatGet === 'function'
      && runtimeShape.thirdPartyRuntime.variables.chatSet === 'function'
      && runtimeShape.thirdPartyRuntime.variables.localGet === 'function'
      && runtimeShape.thirdPartyRuntime.variables.globalGet === 'function'
      && runtimeShape.thirdPartyRuntime.extensionSettings.object
      && runtimeShape.thirdPartyRuntime.extensionSettings.runtimeObject
      && runtimeShape.thirdPartyRuntime.extensionSettings.pluginsArray
      && runtimeShape.thirdPartyRuntime.extensionSettings.generatedAtType === 'string'
      && runtimeShape.thirdPartyRuntime.extensionMenu.global === 'function'
      && runtimeShape.thirdPartyRuntime.extensionMenu.sillyTavern === 'function'
      && runtimeShape.thirdPartyRuntime.extensionMenu.context === 'function'
      && runtimeShape.thirdPartyRuntime.extensionMenu.rendered
      && runtimeShape.thirdPartyRuntime.extensionMenu.nativeMountRendered
      && runtimeShape.thirdPartyRuntime.jqueryMount.dollarType === 'function'
      && runtimeShape.thirdPartyRuntime.jqueryMount.createdLength >= 1
      && runtimeShape.thirdPartyRuntime.jqueryMount.appendToType === 'function'
      && runtimeShape.thirdPartyRuntime.jqueryMount.removeType === 'function'
      && runtimeShape.thirdPartyRuntime.jqueryMount.showType === 'function'
      && runtimeShape.thirdPartyRuntime.jqueryMount.hostExists
      && runtimeShape.thirdPartyRuntime.jqueryMount.inHost
      && runtimeShape.thirdPartyRuntime.jqueryMount.clicks === 1
      && runtimeShape.thirdPartyRuntime.utils.escapeRegexType === 'function'
      && runtimeShape.thirdPartyRuntime.utils.escapeRegexValue === 'a\\+b\\?'
      && runtimeShape.thirdPartyRuntime.utils.escapeRegExpValue === '\\[x\\]'
      && runtimeShape.thirdPartyRuntime.utils.debounceType === 'function'
      && runtimeShape.thirdPartyRuntime.utils.debounceCount === 1
      && runtimeShape.thirdPartyRuntime.utils.throttleType === 'function'
      && runtimeShape.thirdPartyRuntime.utils.throttleCount >= 1
      && runtimeShape.thirdPartyRuntime.utils.delayType === 'function'
      && runtimeShape.thirdPartyRuntime.utils.waitUntilConditionType === 'function'
      && runtimeShape.thirdPartyRuntime.utils.waitUntilConditionResult
      && runtimeShape.thirdPartyRuntime.utils.parseJsonFileType === 'function'
      && runtimeShape.thirdPartyRuntime.utils.parseJsonFileOk
      && runtimeShape.thirdPartyRuntime.utils.saveJsonToFileType === 'function'
      && runtimeShape.thirdPartyRuntime.utils.timestampToMomentType === 'function'
      && runtimeShape.thirdPartyRuntime.utils.timestampFormatType === 'function'
      && runtimeShape.thirdPartyRuntime.utils.humanizedDateTimeType === 'function'
      && runtimeShape.thirdPartyRuntime.utils.defaultObject
      && runtimeShape.thirdPartyRuntime.templates.renderExtensionTemplate === 'function'
      && runtimeShape.thirdPartyRuntime.templates.renderExtensionTemplateAsync === 'function'
      && runtimeShape.thirdPartyRuntime.templates.loadExtensionSettings === 'function'
      && runtimeShape.thirdPartyRuntime.templates.waitGlobalInitialized === 'function',
    'SillyTavern third-party extension runtime APIs are incomplete inside iframe',
    runtimeShape.thirdPartyRuntime,
  );
  assert(
    runtimeShape.thirdPartyRuntime.modules.scriptEventSource === 'function'
      && runtimeShape.thirdPartyRuntime.modules.scriptGetRequestHeaders === 'function'
      && runtimeShape.thirdPartyRuntime.modules.powerUserObject
      && runtimeShape.thirdPartyRuntime.modules.charactersGet === 'function'
      && runtimeShape.thirdPartyRuntime.modules.groupsGet === 'function'
      && runtimeShape.thirdPartyRuntime.modules.worldEntriesGet === 'function'
      && runtimeShape.thirdPartyRuntime.modules.secretsRead === 'function'
      && runtimeShape.thirdPartyRuntime.modules.slashRegister === 'function'
      && runtimeShape.thirdPartyRuntime.modules.localModuleAnswer === 42
      && runtimeShape.thirdPartyRuntime.modules.localModuleLabel === 'ok'
      && runtimeShape.thirdPartyRuntime.modules.localModuleRenamed === 'ok',
    'SillyTavern third-party extension module import compatibility is incomplete inside iframe',
    runtimeShape.thirdPartyRuntime.modules,
  );
  assert(
    runtimeShape.thirdPartyRuntime.api.settingsOk
      && runtimeShape.thirdPartyRuntime.api.settingsHasExtensionSettings
      && runtimeShape.thirdPartyRuntime.api.charactersOk
      && runtimeShape.thirdPartyRuntime.api.charactersIsArray
      && runtimeShape.thirdPartyRuntime.api.secretsOk
      && runtimeShape.thirdPartyRuntime.api.secretsHasValue
      && runtimeShape.thirdPartyRuntime.api.saveSettingsType === 'function'
      && runtimeShape.thirdPartyRuntime.api.saveSettingsResult === true,
    'SillyTavern third-party extension /api fetch compatibility is incomplete inside iframe',
    runtimeShape.thirdPartyRuntime.api,
  );
  assert(
    runtimeShape.history.virtual
      && runtimeShape.history.afterLength >= runtimeShape.history.beforeLength + 2
      && runtimeShape.history.afterBackState?.smoke === 'one'
      && runtimeShape.history.afterBackHash === '#palink-smoke-one'
      && runtimeShape.history.eventTypes.includes('popstate'),
    'Smart card virtual history/back compatibility is incomplete inside iframe',
    runtimeShape,
  );
  assert(
    runtimeShape.storageNow === 'persist-ok'
      && runtimeShape.variableNow === 'variable-ok'
      && runtimeShape.metadataNow === 'metadata-ok',
    'Smart card runtime state did not write inside iframe',
    runtimeShape,
  );

  const parentHtmlStage = await page.evaluate(async () => {
    const formatter = window.messageFormatter || window.MessageFormatter || window.PalinkSillyTavern?.messageFormatter;
    if (!formatter?.addHook || !formatter?.stage) {
      return { formatter: typeof formatter, rendered: false };
    }
    const sentinel = `PALINK_PARENT_HTML_STAGE_${Date.now()}`;
    const dispose = formatter.addHook((html) => `${html}<section class="palink-parent-html-stage">${sentinel}</section>`, {
      stage: formatter.stage.AFTER_MARKDOWN,
      order: formatter.order?.LATEST ?? 100,
    });
    const hasDisplayTarget = document.querySelector('.markdown-content:not(.character-card-renderer *),.palink-st-html-display');
    if (!hasDisplayTarget) {
      return {
        sentinel,
        rendered: false,
        skipped: true,
        reason: 'no parent markdown/html display target on this smart-card-only screen',
      };
    }
    await new Promise((resolve) => setTimeout(resolve, 650));
    const node = document.querySelector('.palink-parent-html-stage');
    const result = {
      sentinel,
      rendered: Boolean(node),
      text: node?.textContent || '',
      wrapperClass: node?.closest?.('.palink-st-html-display,.markdown-content,.character-card-renderer')?.className || '',
      escapedInBody: (document.body?.innerText || '').includes(`<section class="palink-parent-html-stage">${sentinel}</section>`),
    };
    try { dispose?.(); } catch {}
    return result;
  });
  if (!parentHtmlStage.skipped) {
    assert(
      parentHtmlStage.rendered
        && parentHtmlStage.text.includes('PALINK_PARENT_HTML_STAGE_')
        && /palink-st-html-display/.test(parentHtmlStage.wrapperClass || '')
        && !parentHtmlStage.escapedInBody,
      'Parent SillyTavern afterMarkdown HTML stage did not render as sanitized HTML in Palink messages',
      parentHtmlStage,
    );
  }

  await page.reload({ waitUntil: 'networkidle', timeout: 30000 });
  await page.waitForTimeout(2500);
  const frames = await getSmartFrames(page);
  if (frames.length === 0) {
    const debug = await captureSmartCardReloadDebug(page);
    assert(false, 'Smart card iframe disappeared after reload', debug);
  }

  const persistedShape = await evaluateInSmartFrame(page, frames[0], () => ({
    storageAfterReload: localStorage.getItem('__palink_smoke_local'),
    variableAfterReload: typeof window.getVariable === 'function' ? window.getVariable('smoke.persist') : null,
    metadataAfterReload: window.chat_metadata?.__palink_smoke,
  }));
  assert(
    persistedShape.storageAfterReload === 'persist-ok'
      && persistedShape.variableAfterReload === 'variable-ok'
      && persistedShape.metadataAfterReload === 'metadata-ok',
    'Smart card runtime state did not persist after reload',
    persistedShape,
  );

  return { runtimeShape, persistedShape, frame: frames[0] };
}

async function verifyAddOneMessageAppend(page, frame) {
  const appendSentinel = `PALINK_APPEND_SENTINEL_${Date.now()}`;
  const npcAvatar = `https://example.invalid/palink-smoke-npc-${Date.now()}.png`;
  let appendResult;
  try {
    appendResult = await frame.evaluate(async ({ sentinel, npcAvatar }) => {
    const before = typeof window.getChatMessages === 'function' ? window.getChatMessages() : [];
    const currentBefore = before[0]?.mes || before[0]?.content || '';
    const rawContent = `Smoke NPC: ${sentinel}`;
    window.addOneMessage?.({
      role: 'assistant',
      name: 'Smoke NPC',
      is_name: true,
      force_avatar: npcAvatar,
      original_avatar: 'smoke-original-avatar.png',
      group_name: 'Smoke Group',
      mes: rawContent,
      content: rawContent,
      is_user: false,
      is_system: false,
      extra: {
        display_text: `<div class="smoke-npc-display">${sentinel}</div>`,
      },
    }).catch?.(() => {});
    await new Promise((resolve) => setTimeout(resolve, 120));
    const after = typeof window.getChatMessages === 'function' ? window.getChatMessages() : [];
    const appended = after.find((message) => String(message.mes || message.content || '').includes(sentinel)) || {};
    return {
      beforeLength: before.length,
      afterLength: after.length,
      currentBefore,
      currentAfter: after[0]?.mes || after[0]?.content || '',
      hasSentinel: after.some((message) => String(message.mes || message.content || '').includes(sentinel)),
      appended: {
        name: appended.name,
        is_name: appended.is_name,
        force_avatar: appended.force_avatar,
        original_avatar: appended.original_avatar,
        group_name: appended.group_name,
        displayText: appended.extra?.display_text,
        rawContent: appended.mes || appended.content || '',
      },
    };
    }, { sentinel: appendSentinel, npcAvatar });
  } catch (error) {
    if (!/Execution context was destroyed|Frame was detached|navigation/i.test(String(error?.message || error))) {
      throw error;
    }
    appendResult = { frameRecreated: true };
  }
  if (!appendResult.frameRecreated) {
    assert(
      appendResult.afterLength === appendResult.beforeLength + 1
        && appendResult.hasSentinel
        && appendResult.appended.name === 'Smoke NPC'
        && appendResult.appended.is_name === true
        && appendResult.appended.force_avatar === npcAvatar
        && appendResult.appended.original_avatar === 'smoke-original-avatar.png'
        && appendResult.appended.group_name === 'Smoke Group'
        && appendResult.appended.rawContent.includes(`Smoke NPC: ${appendSentinel}`)
        && typeof appendResult.appended.displayText === 'string'
        && appendResult.appended.displayText.includes(appendSentinel)
        && appendResult.currentBefore === appendResult.currentAfter,
      'addOneMessage did not append a new SillyTavern-style message in the iframe runtime',
      appendResult,
    );
  }
  await page.waitForTimeout(1600);
  return { appendSentinel, npcAvatar, appendResult };
}

async function verifyAppendedMessageDom(page, appendCheck) {
  const domResult = await page.evaluate(({ sentinel, npcAvatar }) => {
    const textMatches = Array.from(document.querySelectorAll('body *'))
      .filter((node) => (node.textContent || '').includes(sentinel));
    const rendererNode = textMatches.find((node) => node.classList?.contains('character-card-renderer'))
      || textMatches.find((node) => node.classList?.contains('markdown-content'))
      || textMatches.find((node) => node.closest?.('.character-card-renderer,.markdown-content'))
      || null;
    const messageRoot = rendererNode?.closest?.('.group')
      || rendererNode?.closest?.('[data-testid*="message"]')
      || rendererNode?.parentElement
      || null;
    const bodyText = document.body?.innerText || '';
    const avatarImages = Array.from(document.querySelectorAll('img')).map((image) => image.currentSrc || image.src || '');
    return {
      hasSentinelText: bodyText.includes(sentinel),
      hasDisplayClass: Boolean(document.querySelector('.smoke-npc-display')),
      stMessageCount: document.querySelectorAll('.mes').length,
      stTextCount: document.querySelectorAll('.mes_text').length,
      stLastCount: document.querySelectorAll('.last_mes').length,
      stMesid: rendererNode?.closest?.('.mes')?.getAttribute?.('mesid') || rendererNode?.closest?.('.mes')?.getAttribute?.('data-mesid') || '',
      stSwipeId: rendererNode?.closest?.('.mes')?.getAttribute?.('swipeid') || rendererNode?.closest?.('.mes')?.getAttribute?.('data-swipe-id') || '',
      stTextWrapper: Boolean(rendererNode?.closest?.('.mes_text')),
      hasNpcName: bodyText.includes('Smoke NPC'),
      hasGroupName: bodyText.includes('Smoke Group'),
      hasNpcAvatar: avatarImages.some((src) => src.includes(npcAvatar)),
      rendererText: (rendererNode?.textContent || '').slice(0, 260),
      messageRootText: (messageRoot?.textContent || '').slice(0, 360),
      rendererHasRawPrefix: (rendererNode?.textContent || '').includes(`Smoke NPC: ${sentinel}`),
      avatarImages: avatarImages.filter((src) => src.includes('palink-smoke-npc')).slice(0, 5),
    };
  }, {
    sentinel: appendCheck.appendSentinel,
    npcAvatar: appendCheck.npcAvatar,
  });

  assert(
    domResult.hasSentinelText
      && domResult.hasDisplayClass
      && domResult.stMessageCount > 0
      && domResult.stTextCount > 0
      && domResult.stLastCount > 0
      && domResult.stTextWrapper
      && domResult.hasNpcName
      && domResult.hasGroupName
      && domResult.hasNpcAvatar
      && !domResult.rendererHasRawPrefix,
    'addOneMessage append persisted metadata but did not render SillyTavern multi-character display in the Palink message list',
    domResult,
  );

  return domResult;
}

async function verifyUnknownApiRealEffects(page, frame) {
  const appendSentinel = `PALINK_UNKNOWN_APPEND_${Date.now()}`;
  const updateSentinel = `PALINK_UNKNOWN_UPDATE_${Date.now()}`;
  const result = await evaluateInSmartFrame(page, frame, async ({ appendSentinel, updateSentinel }) => {
    const before = typeof window.getChatMessages === 'function' ? window.getChatMessages() : [];
    const appendResponse = await window.TavernHelper?.appendChatMessage?.({
      role: 'assistant',
      name: 'Unknown API NPC',
      mes: appendSentinel,
      extra: {
        display_text: `<div class="unknown-api-display">${appendSentinel}</div>`,
      },
    });
    await new Promise((resolve) => setTimeout(resolve, 220));
    const afterAppend = typeof window.getChatMessages === 'function' ? window.getChatMessages() : [];
    const appendedIndex = afterAppend.findIndex((message) => String(message.mes || message.content || '').includes(appendSentinel));
    const appended = appendedIndex >= 0 ? afterAppend[appendedIndex] : null;
    const appendedSnapshot = appended ? {
      name: appended.name,
      content: appended.mes || appended.content || '',
      displayText: appended.extra?.display_text || '',
    } : null;

    const updateResponse = await window.TavernHelper?.updateChatMessage?.(appendedIndex, updateSentinel, {
      extra: {
        display_text: `<div class="unknown-api-updated">${updateSentinel}</div>`,
      },
    });
    await new Promise((resolve) => setTimeout(resolve, 220));
    const afterUpdate = typeof window.getChatMessages === 'function' ? window.getChatMessages() : [];
    const updated = afterUpdate[appendedIndex] || null;

    return {
      beforeLength: before.length,
      afterAppendLength: afterAppend.length,
      afterUpdateLength: afterUpdate.length,
      appendResponse,
      updateResponse,
      appendedIndex,
      appended: appendedSnapshot,
      updated: updated ? {
        content: updated.mes || updated.content || '',
        displayText: updated.extra?.display_text || '',
      } : null,
    };
  }, { appendSentinel, updateSentinel });

  assert(
    result.afterAppendLength === result.beforeLength + 1
      && result.appendedIndex >= 0
      && result.appended?.name === 'Unknown API NPC'
      && result.appended?.displayText?.includes(appendSentinel)
      && result.updated?.content?.includes(updateSentinel)
      && result.updated?.displayText?.includes(updateSentinel),
    'unknown Tavern API fallback did not map common message APIs to real Palink side effects',
    result,
  );

  const domResult = await page.evaluate(({ updateSentinel }) => ({
    hasUpdatedText: document.body.innerText.includes(updateSentinel),
    hasUpdatedClass: Boolean(document.querySelector('.unknown-api-updated')),
  }), { updateSentinel });
  assert(
    domResult.hasUpdatedText && domResult.hasUpdatedClass,
    'unknown Tavern API message update was not rendered in the parent message list',
    domResult,
  );

  return result;
}

async function verifySlashCommandCompat(page, frame) {
  const namespace = `palink.smokeSlash.${Date.now()}`;
  const commandName = `palink_smoke_${Date.now()}`;
  const aliasName = `${commandName}_alias`;
  const result = await evaluateInSmartFrame(page, frame, async ({ namespace, commandName, aliasName }) => {
    const registered = window.registerSlashCommand?.(
      commandName,
      async (args, context = {}) => {
        const value = `${args}|${context?.source || ''}`;
        window.setVariable?.(`${namespace}.custom`, value);
        return `custom:${args}`;
      },
      [aliasName],
    );
    const setResponse = await window.executeSlashCommandsWithOptions?.(
      `/setvar ${namespace}.value hello world`,
      { dryRun: true, awaitResult: false },
    );
    const getResponse = await window.executeSlashCommands?.(`/getvar ${namespace}.value`);
    const aliasResponse = await window.executeSlashCommands?.(`/${aliasName} alias-run`);
    const parserResponse = await window.SlashCommandParser?.execute?.(`/${commandName} parser-run`, { source: 'parser' });
    return {
      registeredType: typeof registered,
      setResponse,
      getResponse,
      aliasResponse,
      parserResponse,
      stored: window.getVariable?.(`${namespace}.value`),
      custom: window.getVariable?.(`${namespace}.custom`),
      parserType: typeof window.SlashCommandParser?.execute,
    };
  }, { namespace, commandName, aliasName });

  assert(
    result.registeredType === 'object'
      && result.parserType === 'function'
      && result.stored === 'hello world'
      && result.getResponse === 'hello world'
      && result.aliasResponse === 'custom:alias-run'
      && result.parserResponse === 'custom:parser-run'
      && result.custom === 'parser-run|parser',
    'SillyTavern slash command compatibility is incomplete',
    result,
  );

  return result;
}

async function verifyEventSourceCompat(page, frame) {
  const eventName = `PALINK_SMOKE_EVENT_${Date.now()}`;
  const onceName = `${eventName}_once`;
  const result = await evaluateInSmartFrame(page, frame, async ({ eventName, onceName }) => {
    const order = [];
    let onceCount = 0;
    const first = async () => {
      order.push('first-start');
      await new Promise((resolve) => setTimeout(resolve, 75));
      order.push('first-end');
    };
    const second = () => {
      order.push('second');
    };
    window.eventSource?.removeAllListeners?.(eventName);
    window.eventSource?.on?.(eventName, first);
    window.eventSource?.on?.(eventName, second);
    window.eventSource?.makeLast?.(eventName, first);
    const started = performance.now();
    await window.eventSource?.emit?.(eventName, { smoke: true });
    const elapsed = performance.now() - started;
    await window.eventSource?.emit?.(eventName, { smoke: true });
    window.eventSource?.removeAllListeners?.(onceName);
    window.eventSource?.once?.(onceName, () => {
      onceCount += 1;
    });
    await window.eventSource?.emit?.(onceName, { smoke: true });
    await window.eventSource?.emit?.(onceName, { smoke: true });
    return {
      order,
      onceCount,
      elapsed,
      emitType: typeof window.eventSource?.emit,
      makeLastType: typeof window.eventSource?.makeLast,
    };
  }, { eventName, onceName });

  assert(
    result.emitType === 'function'
      && result.makeLastType === 'function'
      && result.order.join(',') === 'second,first-start,first-end,second,first-start,first-end'
      && result.onceCount === 1
      && result.elapsed >= 70,
    'SillyTavern eventSource compatibility is incomplete',
    result,
  );

  return result;
}

async function verifyMagicCard(page) {
  let freshInit = null;
  if (REQUIRE_INTERACTIVE_START) {
    await page.goto(`${BASE_URL}/characters/${MAGIC_CARD_ID}`, { waitUntil: 'networkidle', timeout: 30000 });
    freshInit = await createFreshInitSession(page, MAGIC_CARD_ID);
  }

  await page.goto(`${BASE_URL}/characters/${MAGIC_CARD_ID}`, { waitUntil: 'networkidle', timeout: 30000 });
  await page.waitForTimeout(4000);

  let frames = await getSmartFrames(page);
  assert(frames.length > 0, 'Smart card did not render an iframe');

  let info = await evaluateInSmartFrame(page, frames[0], () => ({
    compat: Boolean(window.__palinkSmartCardCompatV2),
    compatVersion: window.__palinkSmartCardCompatV2?.version || null,
        parentDocument: Boolean(window.PalinkSmartCard?.parentDocument),
        parentDollar: typeof window.PalinkSmartCard?.parent$,
        dollar: typeof window.$,
        getContext: typeof window.getContext,
        setChatMessage: typeof window.setChatMessage,
        appendChatMessage: typeof window.appendChatMessage,
        updateChatMessage: typeof window.updateChatMessage,
        replaceChatMessage: typeof window.replaceChatMessage,
        setChatMessageBlock: typeof window.setChatMessageBlock,
        executeSlashCommandsWithOptions: typeof window.executeSlashCommandsWithOptions,
        registerSlashCommand: typeof window.registerSlashCommand,
        callPopup: typeof window.callPopup,
        saveMetadata: typeof window.saveMetadata,
        sendTextarea: Boolean(window.PalinkSmartCard?.parentDocument?.getElementById('send_textarea')),
        buttonCount: document.querySelectorAll('button,.mg-btn-select').length,
        hasMain: Boolean(document.querySelector('#mg-main-container,.mg-launcher,#dashboard,#main-wrapper')),
  }));

  if (REQUIRE_INTERACTIVE_START && info.buttonCount === 0) {
    await clickFreshConversation(page);
    frames = await getSmartFrames(page);
    assert(frames.length > 0, 'Smart card iframe disappeared after starting a fresh conversation');
    info = await evaluateInSmartFrame(page, frames[0], () => ({
      compat: Boolean(window.__palinkSmartCardCompatV2),
      compatVersion: window.__palinkSmartCardCompatV2?.version || null,
        parentDocument: Boolean(window.PalinkSmartCard?.parentDocument),
        parentDollar: typeof window.PalinkSmartCard?.parent$,
        dollar: typeof window.$,
        getContext: typeof window.getContext,
        setChatMessage: typeof window.setChatMessage,
        appendChatMessage: typeof window.appendChatMessage,
        updateChatMessage: typeof window.updateChatMessage,
        replaceChatMessage: typeof window.replaceChatMessage,
        setChatMessageBlock: typeof window.setChatMessageBlock,
        executeSlashCommandsWithOptions: typeof window.executeSlashCommandsWithOptions,
        registerSlashCommand: typeof window.registerSlashCommand,
        callPopup: typeof window.callPopup,
        saveMetadata: typeof window.saveMetadata,
        sendTextarea: Boolean(window.PalinkSmartCard?.parentDocument?.getElementById('send_textarea')),
        buttonCount: document.querySelectorAll('button,.mg-btn-select').length,
        hasMain: Boolean(document.querySelector('#mg-main-container,.mg-launcher,#dashboard,#main-wrapper')),
    }));
  }

  assert(info.compat, 'iframe does not expose Palink/SillyTavern compat runtime', info);
  assert(info.parentDocument && info.parentDollar === 'function', 'parent DOM/jquery simulation is missing', info);
  assert(info.dollar === 'function' && info.getContext === 'function' && info.setChatMessage === 'function', 'common Tavern APIs are incomplete', info);
  assert(
    info.appendChatMessage === 'function'
      && info.updateChatMessage === 'function'
      && info.replaceChatMessage === 'function'
      && info.setChatMessageBlock === 'function'
      && info.executeSlashCommandsWithOptions === 'function'
      && info.registerSlashCommand === 'function'
      && info.callPopup === 'function'
      && info.saveMetadata === 'function',
    'common Tavern helper aliases are incomplete',
    info,
  );
  assert(info.sendTextarea, 'send_textarea simulation is not available', info);
  assert(info.hasMain, 'card UI main container did not render', info);
  if (REQUIRE_INTERACTIVE_START) {
    assert(info.buttonCount > 0, 'interactive start card has no clickable buttons', info);
  }

  const persistence = await verifyRuntimeShapeAndPersistence(page, frames[0]);
  frames = await getSmartFrames(page);
  const slashCommands = await verifySlashCommandCompat(page, frames[0]);
  const eventSource = await verifyEventSourceCompat(page, frames[0]);

  let appendCheck = null;
  if (SUBMIT_FLOW) {
    appendCheck = await verifyAddOneMessageAppend(page, frames[0]);
    await page.waitForTimeout(1200);
    appendCheck.dom = await verifyAppendedMessageDom(page, appendCheck);
    appendCheck.unknownApi = await verifyUnknownApiRealEffects(page, frames[0]);
    frames = await getSmartFrames(page);
    assert(frames.length > 0, 'Smart card iframe disappeared after addOneMessage append');
  }

  const layout = await page.evaluate(() => {
    const iframe = document.querySelector('div[data-palink-smart-card-immersive="true"] iframe')
      || document.querySelector('.character-card-renderer iframe')
      || document.querySelector('iframe');
    const rect = iframe?.getBoundingClientRect?.();
    return {
      immersive: Boolean(iframe?.closest?.('[data-palink-smart-card-immersive="true"]')),
      iframeRect: rect ? {
        x: Math.round(rect.x),
        y: Math.round(rect.y),
        width: Math.round(rect.width),
        height: Math.round(rect.height),
      } : null,
      viewport: {
        width: window.innerWidth,
        height: window.innerHeight,
      },
      placeholderHeight: Math.round(document.querySelector('[data-palink-smart-card-placeholder="true"]')?.getBoundingClientRect?.().height || 0),
    };
  });

  if (REQUIRE_INTERACTIVE_START) {
    assert(layout.immersive, 'interactive start card is not rendered as immersive UI', layout);
    assert(
      layout.iframeRect
        && layout.iframeRect.width >= layout.viewport.width * 0.95
        && layout.iframeRect.height >= layout.viewport.height * 0.95,
      'interactive card iframe does not fill the viewport',
      layout,
    );
  }

  const clickResult = info.buttonCount > 0
    ? await evaluateInSmartFrame(page, frames[0], async () => {
        const select = document.querySelector('.mg-btn-select') || document.querySelector('button');
        if (!select) return { ok: false, reason: 'no select button' };
        select.click();
        await new Promise((resolve) => setTimeout(resolve, 500));
        return {
          ok: true,
          visibleForm: Boolean(document.querySelector('#mg-form-page.show,#btn-submit-form')),
          text: document.body.innerText.slice(0, 500),
        };
      })
    : { ok: true, skipped: true, reason: 'current session is not an interactive start card' };

  if (info.buttonCount > 0 || REQUIRE_INTERACTIVE_START) {
    assert(clickResult.ok && clickResult.visibleForm, 'card button click did not open the next form/page', clickResult);
  }

  if (!SUBMIT_FLOW) {
    return { runtime: info, persistence, slashCommands, eventSource, layout, clickResult, freshInit };
  }

  const appendAfter = await page.evaluate(async (characterId) => {
    const token = localStorage.getItem('palink_token');
    const headers = { Authorization: `Bearer ${token}` };
    const sessions = await fetch(`/api/characters/${characterId}/sessions`, { headers }).then((response) => response.json());
    const list = Array.isArray(sessions) ? sessions : sessions.sessions || [];
    const latest = list[0];
    let messages = [];
    if (latest?.id) {
      const data = await fetch(`/api/character-sessions/${latest.id}/messages?limit=20`, { headers }).then((response) => response.json());
      messages = Array.isArray(data) ? data : data.messages || [];
    }
    return {
      latestSessionId: latest?.id || null,
      messages: messages.map((message) => ({
        role: message.role,
        name: message.name,
        is_name: message.is_name,
        force_avatar: message.force_avatar,
        original_avatar: message.original_avatar,
        group_name: message.group_name,
        displayText: typeof message.extra?.display_text === 'string' ? message.extra.display_text.slice(0, 240) : null,
        content: String(message.content || '').slice(0, 240),
      })),
    };
  }, MAGIC_CARD_ID);

  assert(
    appendAfter.messages.some((message) => (
      message.role === 'assistant'
      && message.content.includes(appendCheck.appendSentinel)
      && message.name === 'Smoke NPC'
      && message.is_name === true
      && message.force_avatar === appendCheck.npcAvatar
      && message.original_avatar === 'smoke-original-avatar.png'
      && message.group_name === 'Smoke Group'
      && typeof message.displayText === 'string'
      && message.displayText.includes(appendCheck.appendSentinel)
    )),
    'addOneMessage append did not persist SillyTavern multi-character metadata in the Palink session',
    { appendResult: appendCheck.appendResult, appendAfter },
  );

  const submitFreshInit = await createFreshInitSession(page, MAGIC_CARD_ID);
  await page.goto(`${BASE_URL}/characters/${MAGIC_CARD_ID}`, { waitUntil: 'networkidle', timeout: 30000 });
  await page.waitForTimeout(3500);
  frames = await getSmartFrames(page);
  assert(frames.length > 0, 'Smart card iframe disappeared before submit flow');
  await evaluateInSmartFrame(page, frames[0], async () => {
    const select = document.querySelector('.mg-btn-select') || document.querySelector('button');
    select?.click?.();
    await new Promise((resolve) => setTimeout(resolve, 700));
  });
  frames = await getSmartFrames(page);
  assert(frames.length > 0, 'Smart card iframe disappeared after reopening form');

  const submitAvailable = await evaluateInSmartFrame(page, frames[0], () => ({
    hasSubmit: Boolean(document.querySelector('#btn-submit-form')),
    buttonCount: document.querySelectorAll('button,.mg-btn-select').length,
    text: document.body.innerText.slice(0, 500),
  }));

  const beforeSessionCount = await page.evaluate(async (characterId) => {
    const token = localStorage.getItem('palink_token');
    const headers = { Authorization: `Bearer ${token}` };
    const sessions = await fetch(`/api/characters/${characterId}/sessions`, { headers }).then((response) => response.json());
    return Array.isArray(sessions) ? sessions.length : Number(sessions?.sessions?.length || 0);
  }, MAGIC_CARD_ID);

  const submitAttempt = {
    availableBeforeClick: Boolean(submitAvailable.hasSubmit),
    clicked: false,
    disappearedBeforeClick: false,
    detached: false,
    error: null,
    beforeText: submitAvailable.text,
  };
  if (submitAvailable.hasSubmit) {
    try {
      await evaluateInSmartFrame(page, frames[0], async () => {
        const name = document.querySelector('#user-name');
        if (name) name.value = 'smoke-player';
        name?.dispatchEvent?.(new Event('input', { bubbles: true }));
        const submit = document.querySelector('#btn-submit-form');
        if (!submit) throw new Error('no submit button');
        submit.click();
        await new Promise((resolve) => setTimeout(resolve, 2500));
      });
      submitAttempt.clicked = true;
    } catch (error) {
      if (/Frame was detached|Execution context was destroyed/i.test(String(error?.message || error))) {
        submitAttempt.detached = true;
      } else if (/no submit button/i.test(String(error?.message || error))) {
        submitAttempt.disappearedBeforeClick = true;
      } else {
        submitAttempt.error = String(error?.message || error);
        throw error;
      }
    }
  }

  await page.waitForTimeout(3000);
  const after = await page.evaluate(async (characterId) => {
    const token = localStorage.getItem('palink_token');
    const headers = { Authorization: `Bearer ${token}` };
    const sessions = await fetch(`/api/characters/${characterId}/sessions`, { headers }).then((response) => response.json());
    const list = Array.isArray(sessions) ? sessions : sessions.sessions || [];
    const latest = list[0];
    let messages = [];
    if (latest?.id) {
      const data = await fetch(`/api/character-sessions/${latest.id}/messages?limit=20`, { headers }).then((response) => response.json());
      messages = Array.isArray(data) ? data : data.messages || [];
    }
    return {
      sessionCount: list.length,
      latestSessionId: latest?.id || null,
      messages: messages.map((message) => ({
        role: message.role,
        content: String(message.content || '').slice(0, 240),
        swipe_id: message.swipe_id,
        swipes: Array.isArray(message.swipes) ? message.swipes.length : 0,
      })),
    };
  }, MAGIC_CARD_ID);

  assert(after.sessionCount >= beforeSessionCount, 'submitting the card regressed session count', { beforeSessionCount, after, submitAttempt });
  assert(after.messages.some((message) => message.role === 'assistant'), 'no assistant message exists after submit flow', after);
  assert(
    after.messages.some((message) => message.role === 'assistant' && !/^<GameStart>\s*$/i.test(message.content.trim()) && message.content.trim().length > 40),
    'card submit left the chat on the raw <GameStart> placeholder instead of switching to the selected greeting',
    { after, submitAttempt },
  );
  assert(
    after.messages.some((message) => message.role === 'assistant' && Number(message.swipe_id) > 0),
    'selected smart-card route did not persist as a SillyTavern swipe',
    { after, submitAttempt },
  );

  await page.reload({ waitUntil: 'networkidle', timeout: 30000 });
  await page.waitForTimeout(2500);
  const afterReload = await page.evaluate(async (sessionId) => {
    const token = localStorage.getItem('palink_token');
    const headers = { Authorization: `Bearer ${token}` };
    const data = await fetch(`/api/character-sessions/${sessionId}/messages?limit=20`, { headers }).then((response) => response.json());
    const messages = Array.isArray(data) ? data : data.messages || [];
    return {
      messages: messages.map((message) => ({
        role: message.role,
        content: String(message.content || '').slice(0, 240),
        swipe_id: message.swipe_id,
        swipes: Array.isArray(message.swipes) ? message.swipes.length : 0,
      })),
    };
  }, after.latestSessionId);
  assert(
    afterReload.messages.some((message) => message.role === 'assistant' && !/^<GameStart>\s*$/i.test(message.content.trim()) && Number(message.swipe_id) > 0),
    'selected smart-card greeting did not survive reload',
    afterReload,
  );
  return { runtime: info, persistence, layout, clickResult, appendResult: appendCheck.appendResult, submit: { beforeSessionCount, after, afterReload, submitFreshInit, submitAttempt }, freshInit };
}

async function verifyBangCard(page) {
  await page.goto(`${BASE_URL}/characters/${BANG_CARD_ID}`, { waitUntil: 'networkidle', timeout: 30000 });
  await page.waitForTimeout(4000);

  const info = await page.evaluate(() => {
    const text = document.body.innerText || '';
    return {
      frameCount: document.querySelectorAll('iframe').length,
      rendererCount: document.querySelectorAll('.character-card-renderer,[data-palink-smart-card-frame]').length,
      codeBlockCount: document.querySelectorAll('pre code, .code-block').length,
      bodyLeaks: /body\s*\{\s*font-family|<!DOCTYPE html>|<html\s/i.test(text),
    };
  });

  assert(info.frameCount > 0 || info.rendererCount > 0, 'BanG card did not render through smart-card renderer', info);
  assert(info.codeBlockCount === 0, 'BanG card leaked HTML as code block', info);
  assert(!info.bodyLeaks, 'BanG card leaked raw HTML/CSS text', info);
  return info;
}

async function main() {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 439, height: 898 } });
  const consoleMessages = [];
  const pageErrors = [];
  page.on('console', (message) => {
    const text = `${message.type()}: ${message.text()}`;
    if (/smart card|SillyTavern|BanG|error|warning/i.test(text)) consoleMessages.push(text);
  });
  page.on('pageerror', (error) => {
    pageErrors.push({
      name: error?.name || 'Error',
      message: error?.message || String(error),
      stack: String(error?.stack || '').slice(0, 2000),
    });
  });

  try {
    await login(page);
    MAGIC_CARD_ID = await resolveCharacterId(page, MAGIC_CARD_ID, MAGIC_CARD_NAME_PATTERN, 'magic smart-card');
    BANG_CARD_ID = await resolveCharacterId(page, BANG_CARD_ID, BANG_CARD_NAME_PATTERN, 'BanG smart-card');
    const magic = await verifyMagicCard(page);
    const bang = await verifyBangCard(page);
    const result = {
      ok: true,
      baseUrl: BASE_URL,
      magicCardId: MAGIC_CARD_ID,
      bangCardId: BANG_CARD_ID,
      submitFlow: SUBMIT_FLOW,
      magic,
      bang,
      consoleTail: consoleMessages.slice(-20),
      pageErrors: pageErrors.slice(-10),
    };
    console.log(JSON.stringify(result, null, 2));
  } catch (error) {
    console.error(JSON.stringify({
      ok: false,
      message: error.message,
      stack: error.stack,
      details: error.details,
      consoleTail: consoleMessages.slice(-20),
      pageErrors: pageErrors.slice(-10),
    }, null, 2));
    process.exitCode = 1;
  } finally {
    await browser.close();
  }
}

main();
