/**
 * ST 兼容运行时体 · 第 03 段
 *
 * 机械拆分自 SillyTavernCompatRuntime.ts 原第 2030-2909 行，逐字节搬运，未改任何逻辑。
 * 内容是注入智能卡 iframe 的 JS 源码文本。
 *
 * 约束（改动前必读）：
 *  1. 本段是模板字符串：新增注释与代码里不得出现裸反引号，正则一律 new RegExp()。
 *  2. 各段拼接顺序由 SillyTavernCompatRuntime.ts 的
 *     buildSillyTavernCompatRuntimeBodyScript 固定（按行号升序），不可调换。
 *  3. 段内跨段引用的标识符靠 IIFE 闭包共享，不要单独求值某一段。
 */

import { VARIABLES_COMPAT_SOURCE } from '../variables-compat';

export const RUNTIME_BODY_PART_03 = `                    message: 'Activate hook ' + activateHookName + ' completed.',
                  });
                })
                .catch((hookError) => {
                  reportDiagnostic({
                    severity: 'warning',
                    code: 'st_plugin_activate_hook_failed',
                    apiName: String(plugin.name || plugin.id || ''),
                    message: String(hookError?.message || hookError || uiText.unknownError),
                    stack: String(hookError?.stack || ''),
                  });
                });
            }, 0);
          }
        } catch (error) {
          reportDiagnostic({
            severity: 'warning',
            code: 'st_plugin_script_failed',
            apiName: String(plugin.name || plugin.id || ''),
            message: String(error?.message || error || uiText.unknownError),
            stack: String(error?.stack || ''),
          });
        }
      });
    });
    if (sawDisabledScript) {
      reportDiagnostic({
        severity: 'info',
        code: 'st_plugin_scripts_disabled',
        message: uiText.pluginScriptsDisabled,
      });
    }
  };
  // [P0-SRCDOC-SLIM] 接收父页面推送的插件脚本包：索引源码并按需执行插件脚本。
  // [P1-SRCDOC-SLIM] 推送内容为「清单」（仅元数据 + source URL，无 content）：
  // 这里先索引，再异步经 hydrateStPluginScriptsCompat 向父页面批量拉取缺失源码，
  // 内容就绪后补执行插件（executeStPluginScriptsCompat 按 scriptKey 幂等）。
  // 幂等：generated_at 相同则跳过（iframe 重建/重复推送场景）。执行时机从
  // 「shim 尾部同步执行」改为「脚本包内容就绪后执行」，与瘦身 srcDoc 解耦。
  const applyPluginScriptsPushCompat = (bundle) => {
    if (!bundle || typeof bundle !== 'object') return;
    const nextGeneratedAt = String(bundle.generated_at || '');
    if (nextGeneratedAt && nextGeneratedAt === stPluginScriptsBundleCompat.generated_at) return;
    stPluginScriptsBundleCompat.generated_at = nextGeneratedAt;
    stPluginScriptsBundleCompat.scripts = Array.isArray(bundle.scripts) ? bundle.scripts : [];
    indexStPluginScriptsCompat();
    try { injectStPluginCssCompat(); } catch {}
    // [P1-SRCDOC-SLIM] 异步拉取缺失源码（清单化内容通道），完成后执行插件脚本。
    void hydrateStPluginScriptsCompat();
  };
  const ensureStExtensionSettingsHostCompat = () => {
    let host = document.getElementById('extensions_settings2');
    if (!host) {
      const container = document.createElement('div');
      container.id = 'extensions_settings_container';
      // 不用 display:none：部分 ST 插件会用 offsetWidth/offsetHeight 判断可见性。
      // 改为离屏定位 + visibility:hidden，节点仍可被测量、插件设置面板可正常渲染。
      container.style.cssText = 'position:fixed; top:-9999px; left:-9999px; visibility:hidden;';
      const legacy = document.createElement('div');
      legacy.id = 'extensions_settings';
      legacy.setAttribute('data-palink-st-settings-host', 'legacy');
      host = document.createElement('div');
      host.id = 'extensions_settings2';
      host.setAttribute('data-palink-st-settings-host', 'primary');
      container.append(legacy, host);
      (document.body || document.documentElement).appendChild(container);
    }
    return host;
  };
  const ensureStExtensionSettingsSelectorCompat = (selector) => {
    const value = String(selector || '');
    if (/(?:^|[\\s,])#(?:extensions_settings2|extensions_settings|extensions_settings_container)\\b/.test(value)) {
      ensureStExtensionSettingsHostCompat();
    }
  };
  // [S3-PLUGIN-SHIM-GAP] ST 扩展的挂载容器。ST 里这些容器在主页面（Palink 对应
  // StPluginMountPoints.tsx），但 S3 后插件脚本默认在 iframe 内执行，操作的是 iframe
  // document —— quick-reply init 的 document.querySelector('#qr_container').append(...)
  // 拿到 null 直接抛（2026-10-14 真机定位）。这里在 iframe 内预建同名离屏容器
  // （与 extensions_settings 容器同款处理：仍可测量、不占视觉），让插件的挂载动作成功；
  // UI 可见性是宿主隔离问题（S5 删大堂后的单间轨自立议题），本桩只保证 init 不中断、
  // 命令/API 可注册。容器清单 = ADAPTATION.md 的 9 个 + 两个 wand 浮动窗。
  const ensureStPluginMountPointsCompat = () => {
    const ids = [
      'qr_container', 'regex_container', 'tts_container', 'vectors_container', 'caption_container',
      'translation_container', 'summarize_container', 'sd_container', 'expressions_container',
      'translate_wand_container', 'token_counter_wand_container',
    ];
    for (const id of ids) {
      if (document.getElementById(id)) continue;
      const el = document.createElement('div');
      el.id = id;
      el.setAttribute('data-palink-st-mount-stub', 'iframe');
      el.style.cssText = 'position:fixed; top:-9999px; left:-9999px; visibility:hidden;';
      (document.body || document.documentElement).appendChild(el);
    }
  };
  const openThirdPartyExtensionMenuCompat = async (extensionName = '') => {
    const existing = document.getElementById('palink-st-extension-settings');
    if (existing) existing.remove();
    const plugins = sortStPluginRuntimePluginsCompat(getStPluginRuntimePluginsCompat()).filter((plugin) => {
      if (!extensionName) return true;
      const manifest = plugin?.manifest && typeof plugin.manifest === 'object' ? plugin.manifest : {};
      const needle = String(extensionName).toLowerCase();
      return [plugin?.id, plugin?.name, manifest.id, manifest.name, manifest.display_name]
        .filter(Boolean)
        .some((value) => String(value).toLowerCase() === needle);
    });
    const overlay = document.createElement('div');
    overlay.id = 'palink-st-extension-settings';
    overlay.style.cssText = 'position:fixed;inset:0;z-index:2147483647;background:rgba(0,0,0,.48);display:flex;align-items:center;justify-content:center;padding:18px;box-sizing:border-box;font-family:system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;';
    const panel = document.createElement('div');
    panel.style.cssText = 'width:min(680px,100%);max-height:min(760px,88vh);overflow:auto;border-radius:10px;background:rgba(18,18,22,.96);color:#f8fafc;box-shadow:0 22px 70px rgba(0,0,0,.35);border:1px solid rgba(255,255,255,.12);';
    const close = () => {
      try { overlay.dispatchEvent(new Event('close')); } catch {}
      overlay.remove();
    };
    const header = document.createElement('div');
    header.style.cssText = 'position:sticky;top:0;display:flex;align-items:center;justify-content:space-between;gap:12px;padding:14px 16px;background:rgba(18,18,22,.98);border-bottom:1px solid rgba(255,255,255,.1);';
    const title = document.createElement('strong');
    title.textContent = uiText.pluginSettingsTitle;
    const closeButton = document.createElement('button');
    closeButton.type = 'button';
    closeButton.textContent = uiText.close;
    closeButton.style.cssText = 'border:1px solid rgba(255,255,255,.18);border-radius:7px;background:rgba(255,255,255,.08);color:inherit;padding:7px 10px;font-size:13px;';
    closeButton.addEventListener('click', close);
    header.append(title, closeButton);
    panel.appendChild(header);
    const body = document.createElement('div');
    body.style.cssText = 'padding:14px 16px;display:grid;gap:12px;';
    const nativeHost = ensureStExtensionSettingsHostCompat();
    if (nativeHost && nativeHost.childElementCount > 0) {
      const nativeSection = document.createElement('section');
      nativeSection.style.cssText = 'border:1px solid rgba(255,255,255,.12);border-radius:8px;padding:12px;background:rgba(255,255,255,.045);';
      const nativeTitle = document.createElement('div');
      nativeTitle.style.cssText = 'font-weight:650;margin-bottom:10px;';
      nativeTitle.textContent = uiText.nativeSettingsTitle;
      const nativeMount = document.createElement('div');
      nativeMount.id = 'palink-st-extension-native-settings-mount';
      nativeMount.style.cssText = 'display:grid;gap:10px;';
      while (nativeHost.firstChild) nativeMount.appendChild(nativeHost.firstChild);
      nativeSection.append(nativeTitle, nativeMount);
      body.appendChild(nativeSection);
      overlay.addEventListener('close', () => {
        while (nativeMount.firstChild) nativeHost.appendChild(nativeMount.firstChild);
      }, { once: true });
    }
    if (!plugins.length) {
      const empty = document.createElement('p');
      empty.textContent = uiText.pluginSettingsEmpty;
      empty.style.cssText = 'margin:0;color:rgba(255,255,255,.72);font-size:14px;';
      body.appendChild(empty);
    }
    plugins.forEach((plugin) => {
      const manifest = plugin?.manifest && typeof plugin.manifest === 'object' ? plugin.manifest : {};
      const namespace = getStPluginRuntimeNamespaceCompat(plugin);
      const card = document.createElement('section');
      card.style.cssText = 'border:1px solid rgba(255,255,255,.12);border-radius:8px;padding:12px;background:rgba(255,255,255,.045);';
      const name = document.createElement('div');
      name.style.cssText = 'font-weight:650;margin-bottom:8px;';
      name.textContent = String(manifest.display_name || manifest.name || plugin.name || plugin.id || 'SillyTavern Extension');
      const jsonTitle = document.createElement('div');
      jsonTitle.style.cssText = 'margin:-2px 0 8px;color:rgba(255,255,255,.7);font-size:12px;';
      jsonTitle.textContent = uiText.jsonSettingsTitle;
      const meta = document.createElement('div');
      meta.style.cssText = 'margin-bottom:10px;color:rgba(255,255,255,.62);font-size:12px;';
      meta.textContent = namespace ? 'extension_settings.' + namespace : String(plugin.id || '');
      const textarea = document.createElement('textarea');
      textarea.spellcheck = false;
      textarea.value = JSON.stringify(namespace ? (window.extension_settings?.[namespace] ?? plugin.settings ?? {}) : (plugin.settings ?? {}), null, 2);
      textarea.style.cssText = 'box-sizing:border-box;width:100%;min-height:120px;border-radius:7px;border:1px solid rgba(255,255,255,.14);background:rgba(0,0,0,.24);color:inherit;padding:10px;font:12px/1.55 ui-monospace,SFMono-Regular,Consolas,monospace;';
      const save = document.createElement('button');
      save.type = 'button';
      save.textContent = ctx.language === 'en' ? 'Save to this card' : '\u4fdd\u5b58\u5230\u5f53\u524d\u5361\u7247';
      save.style.cssText = 'margin-top:9px;border:0;border-radius:7px;background:#f8fafc;color:#111827;padding:8px 12px;font-size:13px;font-weight:600;';
      save.addEventListener('click', () => {
        try {
          const parsed = JSON.parse(textarea.value || '{}');
          if (!window.extension_settings || typeof window.extension_settings !== 'object') window.extension_settings = {};
          if (namespace) window.extension_settings[namespace] = parsed;
          persistStorageValue('__palink_extension_settings', window.extension_settings || {});
          emitCompatEvent(window.event_types?.SETTINGS_UPDATED || 'settings_updated', window.extension_settings || {});
          void requestParent('saveExtensionSettings', {
            pluginId: plugin?.id,
            namespace,
            settings: parsed,
            extensionName: manifest.id || manifest.name || manifest.display_name || plugin.name || plugin.id,
          });
          close();
        } catch (error) {
          textarea.style.borderColor = 'rgba(248,113,113,.9)';
        }
      });
      card.append(name, jsonTitle, meta, textarea, save);
      body.appendChild(card);
    });
    panel.appendChild(body);
    overlay.appendChild(panel);
    overlay.addEventListener('click', (event) => {
      if (event.target === overlay) close();
    });
    document.body.appendChild(overlay);
    return true;
  };
  const persistStorageValue = (key, value) => {
    post({ type: 'storage', storageType: 'localStorage', op: 'set', key, value: JSON.stringify(value ?? {}) });
  };
  const persistVariableStores = () => {
    persistStorageValue('__palink_local_variables', localVariableStore);
    persistStorageValue('__palink_global_variables', globalVariableStore);
    persistStorageValue('__palink_chat_variables', chatVariableStore);
  };
  // [S1-G7 2026-10-13] 用 srcdoc 构建期内联的会话绑定世界书名做初值（理由同 legacy-st-sim）。
  let activeWorldbookName = String((ctx && ctx.worldbookName) || '');
  const rememberWorldbookNameCompat = (requestedName, result) => {
    const resultName = result && typeof result === 'object'
      ? (result.name || result.worldbookName || result.world_book_name || result.title)
      : '';
    const nextName = String(resultName || requestedName || activeWorldbookName || '').trim();
    if (nextName) activeWorldbookName = nextName;
    return result;
  };
  // [F8/F9] 变量兼容 helper 源码内联进 shim（模板字符串内代码无法引用外部模块，
  // 故经 \${VARIABLES_COMPAT_SOURCE} 插值注入；模块函数供 __tests__ 单测，改动须同步）。
  ${VARIABLES_COMPAT_SOURCE}
  const setByPath = (source, path, value) => {
    const parts = String(path || '').split('.').filter(Boolean);
    if (!parts.length) return value;
    let target = source;
    for (let index = 0; index < parts.length - 1; index += 1) {
      const key = parts[index];
      if (!target[key] || typeof target[key] !== 'object') target[key] = {};
      target = target[key];
    }
    target[parts[parts.length - 1]] = value;
    return value;
  };
  const deleteByPath = (source, path) => {
    const parts = String(path || '').split('.').filter(Boolean);
    if (!parts.length) return false;
    let target = source;
    for (let index = 0; index < parts.length - 1; index += 1) {
      target = target?.[parts[index]];
      if (!target || typeof target !== 'object') return false;
    }
    const key = parts[parts.length - 1];
    if (!Object.prototype.hasOwnProperty.call(target, key)) return false;
    delete target[key];
    return true;
  };
  const mutateNumberByPath = (source, path, delta = 1) => {
    const current = Number(getByPath(source, path, 0));
    const next = (Number.isFinite(current) ? current : 0) + Number(delta || 0);
    setByPath(source, path, next);
    return next;
  };
  const macroRegistryCompat = new Map();
  // [包Z 批次三 macro_register 2026-10-19] 助手宏（macro-like）注册表。
  // 契约来源（一手）：st-plugins/third-party/JS-Slash-Runner-main/@types/function/macro_like.d.ts:1-38
  //   registerMacroLike(regex: RegExp, replace: (context, substring, ...args) => string)
  //     → { unregister(): void }        (:27-31)
  //   unregisterMacroLike(regex: RegExp): void    (:37)
  //   MacroLikeContext = { message_id?: number, role?: 'user'|'assistant'|'system' }    (:4-7)
  // 与 registerMacro(name, handler) 的区别：那张表按**名字**换 {{name}}，
  // 这张表按**正则**对替换后的正文做一遍后处理 —— 两者独立、互不影响。
  // 注意：本段是模板字符串，禁止裸反引号、禁止模板插值、禁止单反斜杠；这里不写正则字面量
  // （正则由调用方以对象传入），用 Array.prototype.slice 取分组，规避 this/arguments 依赖。
  const macroLikeRegistryCompat = [];
  const getMacroLikeContextCompat = () => {
    // 自包含实现：不依赖 part-05 的 resolveMessageIndex（跨段 const 在求值早期不可见），
    // 当前消息按 id 找，找不到再退回下标，最后退回末条 —— 与帧内其它取消息的降级顺序一致。
    const list = Array.isArray(compatChat) ? compatChat : [];
    let index = -1;
    for (let i = 0; i < list.length; i += 1) {
      const item = list[i] || {};
      if ((item.message_id ?? item.id) === ctx.messageId) { index = i; break; }
    }
    if (index === -1 && Number.isFinite(Number(ctx.messageId)) && Number(ctx.messageId) >= 0 && Number(ctx.messageId) < list.length) {
      index = Number(ctx.messageId);
    }
    if (index === -1) index = list.length - 1;
    const message = list[index] || {};
    return {
      message_id: ctx.messageId ?? message.message_id ?? message.id ?? index,
      role: message.role ?? (message.is_user ? 'user' : 'assistant'),
    };
  };
  const regexKeyCompat = (regex) => String((regex && regex.source) || '') + '/' + String((regex && regex.flags) || '');
  const unregisterMacroLikeCompat = (regex) => {
    if (!(regex instanceof RegExp)) return false;
    const key = regexKeyCompat(regex);
    let removed = 0;
    for (let index = macroLikeRegistryCompat.length - 1; index >= 0; index -= 1) {
      if (macroLikeRegistryCompat[index].key === key) {
        macroLikeRegistryCompat.splice(index, 1);
        removed += 1;
      }
    }
    return removed > 0;
  };
  const registerMacroLikeCompat = (regex, replace) => {
    if (!(regex instanceof RegExp) || typeof replace !== 'function') {
      // 不假成功：参数不合规就不注册，把手柄返回去也是空操作
      post({ type: 'error', message: 'registerMacroLike 需要RegExp与替换函数两个参数，本次未注册' });
      return { unregister: () => { } };
    }
    macroLikeRegistryCompat.push({ key: regexKeyCompat(regex), regex, replace });
    return { unregister: () => unregisterMacroLikeCompat(regex) };
  };
  const applyMacroLikeCompat = (text) => {
    let output = String(text ?? '');
    if (macroLikeRegistryCompat.length === 0) return output;
    for (const entry of macroLikeRegistryCompat) {
      const context = getMacroLikeContextCompat();
      output = output.replace(entry.regex, function () {
        const all = Array.prototype.slice.call(arguments);
        // replace 回调末两个参数是 offset 与整个字符串，前面是 match 与各分组
        const groups = all.slice(0, Math.max(1, all.length - 2));
        const rest = all.slice(1, all.length - 2);
        try {
          return String(entry.replace(context, groups[0], ...rest));
        } catch (error) {
          post({ type: 'error', message: 'registerMacroLike 替换回调失败：' + String((error && error.message) || error) });
          return groups[0];
        }
      });
    }
    return output;
  };
  const normalizeMacroNameCompat = (name) => String(name || '').replace(/^{{|}}$/g, '').trim();
  const getMacroValueCompat = (value, macroName, rawMatch) => {
    if (typeof value === 'function') {
      try {
        return value(macroName, rawMatch, ctx);
      } catch (error) {
        post({ type: 'error', message: String(error?.message || error) });
        return '';
      }
    }
    if (value && typeof value === 'object') {
      const handler = value.handler || value.callback || value.value;
      if (typeof handler === 'function') return getMacroValueCompat(handler, macroName, rawMatch);
      if (handler !== undefined) return handler;
    }
    return value;
  };
  const readDynamicMacroCompat = (dynamicMacros, macroName, rawMatch) => {
    if (!dynamicMacros || typeof dynamicMacros !== 'object') return undefined;
    const direct = Object.prototype.hasOwnProperty.call(dynamicMacros, macroName)
      ? dynamicMacros[macroName]
      : Object.prototype.hasOwnProperty.call(dynamicMacros, rawMatch)
        ? dynamicMacros[rawMatch]
        : undefined;
    if (direct === undefined) return undefined;
    return getMacroValueCompat(direct, macroName, rawMatch);
  };
  const getMessageMacroValueCompat = (macroName) => {
    const lower = String(macroName || '').toLowerCase();
    const currentIndex = resolveMessageIndex(ctx.messageId, {});
    const currentMessage = compatChat[currentIndex] || {};
    const lastMessage = compatChat[compatChat.length - 1] || currentMessage;
    if (lower === 'mes' || lower === 'message') return ctx.messageContent || currentMessage.mes || currentMessage.content || '';
    if (lower === 'lastmessage' || lower === 'last_message') return lastMessage.mes || lastMessage.content || '';
    if (lower === 'lastmessagename' || lower === 'last_message_name') return lastMessage.name || '';
    if (lower === 'currentmessageid' || lower === 'current_message_id') return ctx.messageId ?? currentMessage.message_id ?? currentMessage.id ?? currentIndex;
    if (lower === 'lastmessageid' || lower === 'last_message_id') return lastMessage.message_id ?? lastMessage.id ?? Math.max(0, compatChat.length - 1);
    return undefined;
  };
  const substituteParamsCompat = (content, options = {}, legacyName2 = undefined, legacyOriginal = undefined, legacyGroup = undefined, legacyReplaceCharacterCard = true, legacyAdditionalMacro = {}, legacyPostProcessFn = null) => {
    let resolvedOptions = options && typeof options === 'object' && !Array.isArray(options)
      ? { ...options }
      : {};
    if (typeof options === 'string' || legacyName2 !== undefined || legacyOriginal !== undefined || legacyGroup !== undefined) {
      resolvedOptions = {
        name1Override: typeof options === 'string' ? options : undefined,
        name2Override: legacyName2,
        original: legacyOriginal,
        group: legacyGroup,
        replaceCharacterCard: legacyReplaceCharacterCard,
        dynamicMacros: legacyAdditionalMacro,
        postProcessFn: legacyPostProcessFn,
      };
    }
    const dynamicMacros = resolvedOptions.dynamicMacros || resolvedOptions.additionalMacro || {};
    const name1 = resolvedOptions.name1Override ?? resolvedOptions.name1 ?? ctx.userName ?? 'User';
    const name2 = resolvedOptions.name2Override ?? resolvedOptions.name2 ?? ctx.characterName ?? 'Character';
    const original = resolvedOptions.original ?? legacyOriginal ?? '';
    const group = resolvedOptions.group ?? legacyGroup ?? window.selected_group ?? '';
    const builtIns = {
      user: name1,
      char: name2,
      character: name2,
      name1,
      name2,
      original,
      group,
      time: new Date().toLocaleTimeString(),
      date: new Date().toLocaleDateString(),
      datetime: new Date().toLocaleString(),
      model: ctx.model || '',
      chat: ctx.sessionId || '',
    };
    let result = String(content ?? '').replace(/{{\\s*([^{}]+?)\\s*}}/g, (rawMatch, rawName) => {
      const macroName = normalizeMacroNameCompat(rawName);
      const lower = macroName.toLowerCase();
      const dynamicValue = readDynamicMacroCompat(dynamicMacros, macroName, rawMatch);
      if (dynamicValue !== undefined) return String(dynamicValue ?? '');
      if (macroRegistryCompat.has(macroName)) return String(getMacroValueCompat(macroRegistryCompat.get(macroName), macroName, rawMatch) ?? '');
      if (macroRegistryCompat.has(lower)) return String(getMacroValueCompat(macroRegistryCompat.get(lower), macroName, rawMatch) ?? '');
      // [P2-19] 作用域取变量宏：{{getvar::name}} 先 chat 再 global（上游 ST 1.18 语义），
      // {{getglobalvar::name}} 只认 global；两种分隔（:: 与空格）都认；取不到返回空串。
      // 上游没有 getlocalvar 宏（只有斜杠命令），这里不提供。
      const scopedVarMatch = /^(getglobalvar|getvar)(?:::|\\s+)(.*)$/i.exec(macroName);
      if (scopedVarMatch) {
        const scopedVarName = String(scopedVarMatch[2] || '').trim();
        // 空名 / 只有点号：getByPath 会把整个 store 回退出来（[object Object]），必须挡掉
        if (!scopedVarName || !/[^.]/.test(scopedVarName)) return '';
        if (scopedVarMatch[1].toLowerCase() === 'getvar') {
          const chatScopedValue = getByPath(chatVariableStore, scopedVarName, undefined);
          if (chatScopedValue !== undefined) return String(chatScopedValue ?? '');
        }
        const globalScopedValue = getByPath(globalVariableStore, scopedVarName, undefined);
        return globalScopedValue === undefined ? '' : String(globalScopedValue ?? '');
      }
      if (Object.prototype.hasOwnProperty.call(builtIns, lower)) return String(builtIns[lower] ?? '');
      const messageValue = getMessageMacroValueCompat(lower);
      if (messageValue !== undefined) return String(messageValue ?? '');
      const variableValue = getByPath(chatVariableStore, macroName, undefined);
      if (variableValue !== undefined) return String(variableValue ?? '');
      const globalValue = getByPath(globalVariableStore, macroName, undefined);
      if (globalValue !== undefined) return String(globalValue ?? '');
      return rawMatch;
    });
    // [包Z 批次三] 助手宏（registerMacroLike）在 {{}} 替换之后跑一遍；
    // 放在 postProcessFn 之前，与"宏先生成再后处理"的顺序一致。
    result = applyMacroLikeCompat(result);
    const postProcessFn = resolvedOptions.postProcessFn;
    if (typeof postProcessFn === 'function') {
      try { result = postProcessFn(result); } catch (error) { post({ type: 'error', message: String(error?.message || error) }); }
    }
    return String(result ?? '');
  };
  const parseMaybeJsonObject = (value, fallback = {}) => {
    if (!value) return fallback;
    if (typeof value === 'object') return value;
    if (typeof value === 'string') {
      try {
        const parsed = JSON.parse(value);
        return parsed && typeof parsed === 'object' ? parsed : fallback;
      } catch {}
    }
    return fallback;
  };
  const normalizePromptInputCompat = (source, preferredKeys = []) => {
    const keyOrder = [
      ...preferredKeys,
      'quietPrompt',
      'quiet_prompt',
      'prompt',
      'content',
      'message',
      'mes',
      'text',
      'value',
    ];
    if (source && typeof source === 'object') {
      for (const key of keyOrder) {
        if (typeof source[key] === 'string') {
          return {
            content: substituteParamsCompat(source[key]),
            options: { ...source },
          };
        }
      }
      return {
        content: '',
        options: { ...source },
      };
    }
    return {
      content: substituteParamsCompat(String(source ?? '')),
      options: {},
    };
  };
  const normalizeUserMessageInputCompat = (messageText, messageBias = undefined, insertAt = null, compact = false, name = undefined, avatar = undefined) => {
    const normalized = normalizePromptInputCompat(messageText, ['messageText']);
    const options = {
      ...(normalized.options || {}),
      messageBias,
      insertAt,
      compact,
    };
    if (name !== undefined) options.name = name;
    if (avatar !== undefined) options.avatar = avatar;
    if (typeof normalized.options.name === 'string') options.name = normalized.options.name;
    if (typeof normalized.options.avatar === 'string') options.avatar = normalized.options.avatar;
    if (normalized.options.awaitResult !== undefined) options.awaitResult = Boolean(normalized.options.awaitResult);
    return { content: normalized.content, options };
  };
  const normalizeRegexListCompat = (source) => {
    if (!source) return [];
    if (Array.isArray(source)) return source.filter((item) => item && typeof item === 'object');
    const parsed = parseMaybeJsonObject(source, {});
    if (Array.isArray(parsed?.regex_scripts)) return parsed.regex_scripts.filter((item) => item && typeof item === 'object');
    if (Array.isArray(parsed?.extensions?.regex_scripts)) return parsed.extensions.regex_scripts.filter((item) => item && typeof item === 'object');
    if (Array.isArray(parsed?.prompts)) {
      return parsed.prompts.flatMap((prompt) => normalizeRegexListCompat(prompt?.extensions));
    }
    return [];
  };
  let scopedRegexScripts = normalizeRegexListCompat(ctx.characterExtensions);
  let presetRegexScripts = normalizeRegexListCompat(ctx.presetData);
  let globalRegexScripts = normalizeRegexListCompat(ctx.globalRegexScripts);
  const getGlobalRegexScriptsCompat = () => {
    const configured = window.extension_settings?.regex;
    return Array.isArray(configured) ? configured.filter((item) => item && typeof item === 'object') : clone(globalRegexScripts);
  };
  const getScopedRegexScriptsCompat = () => {
    const currentCharacter = window.characters?.[window.this_chid];
    const scoped = currentCharacter?.data?.extensions?.regex_scripts;
    return Array.isArray(scoped) ? scoped.filter((item) => item && typeof item === 'object') : clone(scopedRegexScripts);
  };
  const getPresetRegexScriptsCompat = () => {
    const configured = window.extension_settings?.palink_preset_regex_scripts;
    return Array.isArray(configured) ? configured.filter((item) => item && typeof item === 'object') : clone(presetRegexScripts);
  };
  const getAllRegexScriptsCompat = () => [
    ...getGlobalRegexScriptsCompat().map((script, index) => ({ ...script, __order: Number.isFinite(Number(script.order)) ? Number(script.order) : index })),
    ...getPresetRegexScriptsCompat().map((script, index) => ({ ...script, __order: Number.isFinite(Number(script.order)) ? Number(script.order) : index + 10000 })),
    ...getScopedRegexScriptsCompat().map((script, index) => ({ ...script, __order: Number.isFinite(Number(script.order)) ? Number(script.order) : index + 20000 })),
  ];
  const normalizeBooleanCompat = (value, fallback = false) => {
    if (typeof value === 'boolean') return value;
    if (typeof value === 'number') return value !== 0;
    if (typeof value === 'string') {
      const normalized = value.trim().toLowerCase();
      if (['true', '1', 'yes', 'on'].includes(normalized)) return true;
      if (['false', '0', 'no', 'off'].includes(normalized)) return false;
    }
    return fallback;
  };
  const normalizePlacementListCompat = (value) => {
    if (Array.isArray(value)) return value.map(Number).filter(Number.isFinite);
    if (typeof value === 'number' && Number.isFinite(value)) return [value];
    if (typeof value === 'string') {
      try { return normalizePlacementListCompat(JSON.parse(value)); } catch {}
      const parsed = Number(value);
      return Number.isFinite(parsed) ? [parsed] : [];
    }
    return [];
  };
  const normalizeDepthCompat = (value) => {
    if (value === undefined || value === null || value === '') return null;
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  };
  const regexFromStringCompat = (value) => {
    const source = String(value || '');
    const match = source.match(/^\\/(.+)\\/([gimsuy]*)$/);
    try {
      if (match) return new RegExp(match[1], match[2]);
      return new RegExp(source, 'g');
    } catch {
      return null;
    }
  };
  const trimCapturedRegexStringCompat = (value, trimStrings) => {
    let result = String(value ?? '');
    for (const trim of trimStrings || []) {
      if (!trim) continue;
      while (result.includes(trim)) result = result.replace(trim, '');
    }
    return result;
  };
  const normalizeTrimStringsCompat = (value) => {
    if (Array.isArray(value)) return value.filter((item) => typeof item === 'string' && item.length > 0);
    if (typeof value === 'string') {
      try { return normalizeTrimStringsCompat(JSON.parse(value)); } catch {}
      return value ? [value] : [];
    }
    return [];
  };
  const escapeRegexMacroCompat = (value) => {
    const specials = '.^$*+?{}[]/|()';
    return String(value ?? '').split('').map((char) => {
      const code = char.charCodeAt(0);
      if (code === 10) return regexBackslashCompat + 'n';
      if (code === 13) return regexBackslashCompat + 'r';
      if (code === 9) return regexBackslashCompat + 't';
      if (code === 11) return regexBackslashCompat + 'v';
      if (code === 12) return regexBackslashCompat + 'f';
      if (code === 0) return regexBackslashCompat + '0';
      if (char === regexBackslashCompat || specials.includes(char)) return regexBackslashCompat + char;
      return char;
    }).join('');
  };
  const regexScriptMatchesCompat = (script, options) => {
    if (!script || typeof script !== 'object') return false;
    if (normalizeBooleanCompat(script.disabled, false)) return false;
    if (script.enabled !== undefined && script.enabled !== null && !normalizeBooleanCompat(script.enabled, true)) return false;
    const placements = normalizePlacementListCompat(script.placement);
    if (placements.length > 0 && !placements.includes(Number(options.placement))) return false;
    const markdownOnly = normalizeBooleanCompat(script.markdownOnly ?? script.markdown_only, false);
    const promptOnly = normalizeBooleanCompat(script.promptOnly ?? script.prompt_only, false);
    if (markdownOnly && !options.isMarkdown) return false;
    if (promptOnly && !options.isPrompt) return false;
    if (!markdownOnly && !promptOnly && (options.isMarkdown || options.isPrompt)) return false;
    const minDepth = normalizeDepthCompat(script.minDepth ?? script.min_depth);
    const maxDepth = normalizeDepthCompat(script.maxDepth ?? script.max_depth);
    if (typeof options.depth === 'number') {
      if (minDepth !== null && minDepth >= -1 && options.depth < minDepth) return false;
      if (maxDepth !== null && maxDepth >= 0 && options.depth > maxDepth) return false;
    }
    return true;
  };
  const runRegexScriptCompat = (script, text, options) => {
    const rawFindRegex = typeof script.findRegex === 'string' ? script.findRegex : typeof script.find_regex === 'string' ? script.find_regex : '';
    if (!rawFindRegex || !text) return text;
    const substituteRegex = script.substituteRegex ?? script.substitute_regex ?? 0;
    const substituteMode = typeof substituteRegex === 'boolean' ? (substituteRegex ? 1 : 0) : Number(substituteRegex);
    const findRegexSource = substituteMode === 2
      ? rawFindRegex.replace(/{{(?:user|char|character|name1|name2)}}/gi, (match) => escapeRegexMacroCompat(substituteParamsCompat(match)))
      : substituteMode === 1
        ? substituteParamsCompat(rawFindRegex)
        : rawFindRegex;
    const findRegex = regexFromStringCompat(findRegexSource);
    if (!findRegex) return text;
    const replaceString = typeof script.replaceString === 'string'
      ? script.replaceString
      : typeof script.replace_string === 'string'
        ? script.replace_string
        : '';
    const trimStrings = normalizeTrimStringsCompat(script.trimStrings ?? script.trim_strings)
      .map((trim) => substituteParamsCompat(String(trim || '')))
      .filter((trim) => trim.length > 0);
    try {
      return String(text).replace(findRegex, function(match, ...args) {
        const groups = args[args.length - 1];
        const captures = [match, ...args];
        let result = substituteParamsCompat(replaceString).replace(/{{match}}/gi, '$0');
        return result.replace(/\\$(\\d+)|\\$<([^>]+)>/g, (_token, num, groupName) => {
          const captured = num
            ? captures[Number(num)]
            : groupName && groups && typeof groups === 'object'
              ? groups[groupName]
              : '';
          return trimCapturedRegexStringCompat(captured || '', trimStrings);
        });
      });
    } catch {
      return text;
    }
  };
  const applyDisplayRegexScriptsCompat = (text, options) => {
    const ordered = getAllRegexScriptsCompat().sort((a, b) => Number(a.__order || 0) - Number(b.__order || 0));
    let result = String(text ?? '');
    let applied = 0;
    for (const script of ordered) {
      if (applied >= 40) break;
      if (!regexScriptMatchesCompat(script, options)) continue;
      result = runRegexScriptCompat(script, result, options);
      applied += 1;
    }
    const htmlFencePattern = new RegExp('([\\\\x60]{3,})html\\\\s*\\\\r?\\\\n([\\\\s\\\\S]*?)\\\\r?\\\\n\\\\1', 'g');
    return result.replace(htmlFencePattern, (_match, _ticks, htmlContent) => '<palink-html>' + htmlContent + '</palink-html>');
  };
  const hasDisplayLayerOptionsCompat = (options) => {
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
    return displayLayerKeys.some((key) => Object.prototype.hasOwnProperty.call(options, key) && options[key] !== undefined);
  };
  const htmlEscapeCompat = (value) => String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
  const sanitizeFormattedHtmlCompat = (value) => {
    const template = document.createElement('template');
    template.innerHTML = String(value ?? '');
    template.content.querySelectorAll('script,iframe,object,embed,base,form').forEach((node) => node.remove());
    template.content.querySelectorAll('*').forEach((node) => {
      Array.from(node.attributes).forEach((attribute) => {
        const name = attribute.name.toLowerCase();
        const rawValue = String(attribute.value || '');
        if (name.startsWith('on') || /javascript:/i.test(rawValue)) {
          node.removeAttribute(attribute.name);
        }
      });
    });
    return template.innerHTML;
  };
  const escapeRegExpCompat = (value) => {
    const specials = '.*+?^{}()|[]\\\\$';
    return String(value ?? '').split('').map((char) => specials.includes(char) ? regexBackslashCompat + char : char).join('');
  };
  const protectFormattingBlocksCompat = (value) => {
    const blocks = [];
    const blockPattern = new RegExp('<style\\\\b[\\\\s\\\\S]*?<\\\\/style>|\\\\x60{3}[\\\\s\\\\S]*?\\\\x60{3}|~~~[\\\\s\\\\S]*?~~~|\\\\x60{2}[\\\\s\\\\S]*?\\\\x60{2}|\\\\x60[^\\\\x60\\\\n]*\\\\x60|<[^>\\\\n]+>', 'g');
    const text = String(value ?? '').replace(blockPattern, (match) => {
      const index = blocks.push(match) - 1;
      return '%%PALINK_FORMAT_BLOCK_' + index + '%%';
    });
    return { text, blocks };
  };
  const restoreFormattingBlocksCompat = (value, blocks) => String(value ?? '').replace(new RegExp('%%PALINK_FORMAT_BLOCK_(\\\\d+)%%', 'g'), (_match, index) => blocks[Number(index)] || '');
  const wrapQuotesForMessageFormattingCompat = (value) => {
    const protectedState = protectFormattingBlocksCompat(value);
    const wrapped = protectedState.text.replace(/(".*?")|(“.*?”)|(«.*?»)|(「.*?」)|(『.*?』)|(＂.*?＂)/gims, (match, p1, p2, p3, p4, p5, p6) => {
      if (p1) return '<q>"' + p1.slice(1, -1) + '"</q>';
      if (p2) return '<q>“' + p2.slice(1, -1) + '”</q>';
      if (p3) return '<q>«' + p3.slice(1, -1) + '»</q>';
      if (p4) return '<q>「' + p4.slice(1, -1) + '」</q>';
      if (p5) return '<q>『' + p5.slice(1, -1) + '』</q>';
      if (p6) return '<q>＂' + p6.slice(1, -1) + '＂</q>';
      return match;
    });
    return restoreFormattingBlocksCompat(wrapped, protectedState.blocks);
  };
  const normalizeMessageFormattingMarkdownCompat = (value) => String(value ?? '')
    .replaceAll(regexBackslashCompat + 'begin{align*}', '$$')
    .replaceAll(regexBackslashCompat + 'end{align*}', '$$');
  const markdownPreserveHtmlCompat = (value) => {
    const raw = wrapQuotesForMessageFormattingCompat(normalizeMessageFormattingMarkdownCompat(substituteParamsCompat(value)));
    const protectedBlocks = [];
    let text = String(raw ?? '')
      .replace(new RegExp('\\\\x60\\\\x60\\\\x60([a-zA-Z0-9_-]*)?\\\\s*\\\\r?\\\\n?([\\\\s\\\\S]*?)\\\\r?\\\\n?\\\\x60\\\\x60\\\\x60', 'g'), (_match, lang, code) => {
        protectedBlocks.push('<pre><code>' + htmlEscapeCompat(code) + '</code></pre>');
        return '%%PALINK_BLOCK_' + (protectedBlocks.length - 1) + '%%';
      })
      .replace(new RegExp('^###\\\\s+(.+)$', 'gm'), '<h3>$1</h3>')
      .replace(new RegExp('^##\\\\s+(.+)$', 'gm'), '<h2>$1</h2>')
      .replace(new RegExp('^#\\\\s+(.+)$', 'gm'), '<h1>$1</h1>')
      .replace(new RegExp('\\\\[([^\\\\]\\\\n]+)\\\\]\\\\((https?:\\\\/\\\\/[^)\\\\s]+)\\\\)', 'g'), '<a href="$2" target="_blank" rel="noopener noreferrer">$1</a>')
      .replace(new RegExp('\\\\*\\\\*([^*]+)\\\\*\\\\*', 'g'), '<strong>$1</strong>')
      .replace(new RegExp('\\\\*([^*]+)\\\\*', 'g'), '<em>$1</em>')
      .replace(new RegExp('(^|\\\\n)([-*]\\\\s+.+(?:\\\\n[-*]\\\\s+.+)*)', 'g'), (_match, prefix, list) => {
        const items = String(list).split(new RegExp('\\\\n')).map((line) => line.replace(new RegExp('^[-*]\\\\s+'), '').trim()).filter(Boolean);
        return prefix + '<ul>' + items.map((item) => '<li>' + item + '</li>').join('') + '</ul>';
      })
      .replace(/\\n/g, '<br>');
    text = text.replace(new RegExp('%%PALINK_BLOCK_(\\\\d+)%%', 'g'), (_match, index) => protectedBlocks[Number(index)] || '');
    return sanitizeFormattedHtmlCompat(text);
  };
  const formattingStage = {
    BEFORE_REGEX: 'beforeRegex',
    AFTER_REGEX: 'afterRegex',
    AFTER_MARKDOWN: 'afterMarkdown',
  };
  const hookOrder = {
    EARLIEST: 0,
    EARLY: 10,
    NORMAL: 50,
    LATE: 90,
    LATEST: 100,
  };
  const runFormattingStageCompat = (stage, value, base) => {
    try {
      if (typeof window.messageFormatter?.runStage === 'function') {
        return window.messageFormatter.runStage(stage, value, base);
      }
    } catch (error) {
      post({ type: 'error', message: String(error?.message || error) });
    }
    return value;
  };
  const messageFormattingCompat = (mes, chName = ctx.characterName, isSystem = false, isUser = false, messageId = ctx.messageId, sanitizerOverrides = {}, isReasoning = false) => {
    const messagesForDepth = Array.isArray(window.chat) ? window.chat : [];
    const resolvedIndex = (() => {
      const byId = messagesForDepth.findIndex((message, index) => (
        String(message?.id) === String(messageId)
        || String(message?.message_id) === String(messageId)
        || String(message?.mesid) === String(messageId)
        || String(index) === String(messageId)
      ));
      return byId >= 0 ? byId : Number(ctx.messageIndex ?? 0);
    })();
    const usableMessages = messagesForDepth
      .map((message, index) => ({ message, index }))
      .filter((item) => !item.message?.is_system);
    const usableIndex = usableMessages.findIndex((item) => item.index === resolvedIndex);
    const depth = resolvedIndex >= 0 && usableIndex !== -1
      ? Math.max(0, usableMessages.length - usableIndex - 1)
      : Number(ctx.depth || 0);
    const base = {
      characterName: chName || ctx.characterName || '',
      ch_name: chName || ctx.characterName || '',
      isSystem: Boolean(isSystem),
      isUser: Boolean(isUser),
      messageId,
      depth,
      isReasoning: Boolean(isReasoning),
    };
    const messageForDisplay = Number.isInteger(Number(resolvedIndex)) ? messagesForDepth[resolvedIndex] : null;
    const activeSwipeExtra = messageForDisplay?.swipe_info?.[Number(messageForDisplay?.swipe_id || 0)]?.extra;
    const displayText = activeSwipeExtra?.display_text ?? messageForDisplay?.extra?.display_text;
    let text = typeof displayText === 'string' && String(mes ?? '') === String(messageForDisplay?.mes ?? messageForDisplay?.content ?? '')
      ? displayText
      : String(mes ?? '');
    if (Number(messageId) === 0 && !base.isSystem && !base.isUser && !base.isReasoning) {
      text = substituteParamsCompat(text);
    }
    if (!isSystem) {
      text = runFormattingStageCompat(formattingStage.BEFORE_REGEX, text, base);
      const placement = base.isReasoning
        ? 6
        : isUser
          ? 1
          : messageForDisplay?.extra?.type === 'narrator'
            ? 3
            : 2;
      text = applyDisplayRegexScriptsCompat(text, {
        placement,
        isMarkdown: true,
        isPrompt: false,
        depth,
      });
      text = runFormattingStageCompat(formattingStage.AFTER_REGEX, text, base);
    }
    let html = markdownPreserveHtmlCompat(text);
    html = runFormattingStageCompat(formattingStage.AFTER_MARKDOWN, html, base);
    if (!window.power_user?.allow_name2_display && chName && !isUser && !isSystem) {
      const prefixPattern = new RegExp(
        '(^|<br' + regexBackslashCompat + 's*' + regexBackslashCompat + '/?>|' + regexBackslashCompat + 'n)' +
        regexBackslashCompat + 's*' + escapeRegExpCompat(chName) + regexBackslashCompat + 's*[:：]' + regexBackslashCompat + 's*',
        'gi',
      );
      html = html.replace(prefixPattern, '$1');
    }
    if (isSystem) return '<span class="mes-system">' + html + '</span>';
    if (isUser) return '<span class="mes-user">' + html + '</span>';
    const name = htmlEscapeCompat(chName || ctx.characterName || '');
    return name ? '<span class="mes-name">' + name + '</span><span class="mes-text">' + html + '</span>' : html;
  };
  const messageFormatterCompat = (() => {
    const hooks = new Map([
      [formattingStage.BEFORE_REGEX, []],
      [formattingStage.AFTER_REGEX, []],
      [formattingStage.AFTER_MARKDOWN, []],
    ]);
    const api = {
      stage: formattingStage,
      order: hookOrder,
      addHook(fn, { stage = formattingStage.AFTER_MARKDOWN, order = hookOrder.NORMAL } = {}) {
        if (typeof fn !== 'function') throw new TypeError('MessageFormatter: hook must be a function');
        if (fn.constructor?.name === 'AsyncFunction') throw new TypeError('MessageFormatter: async hooks are not supported');
        if (!hooks.has(stage)) throw new RangeError('MessageFormatter: unknown stage ' + String(stage));
        hooks.get(stage).push({ fn, order: Number.isFinite(Number(order)) ? Number(order) : hookOrder.NORMAL });
      },
      removeHook(fn, stage = null) {
        const stages = stage ? [stage] : Array.from(hooks.keys());
        for (const item of stages) {
          const bucket = hooks.get(item);
          if (!bucket) continue;
          const index = bucket.findIndex((hook) => hook.fn === fn);
          if (index >= 0) bucket.splice(index, 1);
        }
      },
      clearHooks(stage = null) {
        const stages = stage ? [stage] : Array.from(hooks.keys());
        for (const item of stages) hooks.get(item)?.splice(0);
      },
      runStage(stage, mes, base = {}) {
        const bucket = hooks.get(stage);
        if (!bucket?.length) return mes;
        const stageContext = Object.freeze({ ...base, stage });
        let result = String(mes ?? '');
        const sorted = bucket.slice().sort((a, b) => a.order - b.order);
        for (const hook of sorted) {
          try {
            const next = hook.fn(result, stageContext);
            if (typeof next === 'string') result = next;
          } catch (error) {
            post({ type: 'error', message: String(error?.message || error) });
          }
        }
        return result;
      },
      format: (...args) => messageFormattingCompat(...args),
      render: (...args) => messageFormattingCompat(...args),
      process: (message) => messageFormattingCompat(
        message?.mes ?? message?.content ?? message?.message ?? message,
        message?.name,
        Boolean(message?.is_system),
        Boolean(message?.is_user),
        message?.mesid ?? message?.id,
      ),
    };
    return api;
  })();
  const stripSwipeInfoFromExtra = (extra) => {
    const source = extra && typeof extra === 'object' ? clone(extra) : {};
    if (source && typeof source === 'object') delete source.swipe_info;
    return source;
  };
  const normalizeSwipeInfoEntry = (entry, fallbackExtra, fallbackSendDate = '') => {
    const source = entry && typeof entry === 'object' ? clone(entry) : {};
    return {
      ...source,
      send_date: source.send_date || fallbackSendDate || '',
      extra: stripSwipeInfoFromExtra(
        source.extra && typeof source.extra === 'object' ? source.extra : fallbackExtra,
      ),
    };
  };
  const stMessageMetaKeys = [
    'is_name',
    'force_avatar',
    'original_avatar',
    'avatar',
    'gen_id',
    'group_id',
    'group_name',
    'selected_group',
    'groups',
  ];
  const getStMessageMeta = (source, key, fallbackExtra) => {
    if (source && typeof source === 'object' && source[key] !== undefined) return source[key];
    if (fallbackExtra && typeof fallbackExtra === 'object' && fallbackExtra[key] !== undefined) return fallbackExtra[key];
    return undefined;
  };
  const applyStMessageMeta = (target, source, fallbackExtra = target?.extra) => {
    stMessageMetaKeys.forEach((key) => {
      const value = getStMessageMeta(source, key, fallbackExtra);
      if (value !== undefined) {
        target[key] = clone(value);
        if (!target.extra || typeof target.extra !== 'object') target.extra = {};
        target.extra[key] = clone(value);
      }
    });
    return target;
  };
  const normalizeChatMessage = (message, index) => {
    const role = String(message?.role || (index === 0 ? 'assistant' : 'user'));
    const content = String(message?.content ?? message?.mes ?? message?.message ?? '');
    const isUser = role === 'user';
    const id = message?.id ?? message?.message_id ?? index;
    const mesid = Number.isFinite(Number(message?.mesid)) ? Number(message.mesid) : index;
    const rawExtra = message?.extra && typeof message.extra === 'object' ? clone(message.extra) : {};
    const swipes = Array.isArray(message?.swipes) && message.swipes.length
      ? message.swipes.map((item) => String(item ?? ''))
      : [content];
    const swipeId = Math.max(0, Math.min(
`;
