/**
 * Palink Smart Card Script Enabler
 *
 * ST 的 DOMPurify 是 ES module import（不在 window 上），无法外部 patch。
 * ST 的 messageFormatting 调用 DOMPurify.sanitize(mes, {MESSAGE_SANITIZE: true})
 * 会剥离所有 <script> 标签，导致角色卡中由 JavaScript 动态生成的表格/状态栏无法显示。
 *
 * 本脚本采用「fetch 响应拦截 + MutationObserver 延迟执行」方案：
 *   1. 拦截 /api/chats/get 和 /api/chats/group/get 的响应
 *   2. 对每条消息 mes 做预处理：
 *      a. 剥离 ```html ... ``` 代码围栏（Showdown 会把围栏内容当代码块转义）
 *      b. 剥离内部代码围栏（角色卡可能包含多个 HTML 文档，每个都用围栏包裹）
 *      c. 扁平化 HTML 文档（提取 <head> 中的 <script>，移除 <!DOCTYPE>/<html>/<head>/<body> 包装）
 *      d. 去除公共缩进（Showdown 会把 4+ 空格缩进当代码块转义）
 *      e. 提取 <script> 标签，存入全局 map，替换为 <div data-palink-script="id"> 标记
 *      f. 移除标记 div 前的空行（Showdown 会把空行后的 <div> 当代码块转义）
 *   3. MutationObserver 监听 .mes_text 元素插入
 *   4. 发现标记后，从 map 取出脚本代码，创建真正的 <script> 元素并替换标记
 *   5. 将脚本中的 DOMContentLoaded 替换为自定义事件 palink-card-init，
 *      脚本插入后立即派发该事件，触发初始化逻辑
 *
 * 安全考量：
 *   - ST sidecar 是沙箱环境，内容来自 Palink 后端（可信源）
 *   - 脚本来自用户自己的角色卡
 *   - 不修改 ST 的 DOMPurify 安全过滤逻辑
 */
(function () {
    'use strict';

    var PATCH_KEY = '__palink_smart_card_patched';
    if (window[PATCH_KEY]) return;
    window[PATCH_KEY] = true;

    var INIT_EVENT = 'palink-card-init';
    var SCRIPT_STORE = {};
    var scriptCounter = 0;

    /**
     * 拦截 fetch 响应，对 /api/chats/get 和 /api/chats/group/get 的消息内容
     * 提取 <script> 标签并替换为标记元素
     */
    function installFetchInterceptor() {
        var prevFetch = window.fetch;
        if (!prevFetch) {
            setTimeout(installFetchInterceptor, 50);
            return;
        }

        console.log('[palink-smart-card] installing fetch interceptor, prevFetch exists=', !!prevFetch);
        window.fetch = async function (input, init) {
            var response = await prevFetch.apply(this, arguments);
            try {
                var url = typeof input === 'string'
                    ? input
                    : (input instanceof Request ? input.url : String(input));
                var path = new URL(url, location.origin).pathname;

                if (path === '/api/chats/get' || path === '/api/chats/group/get') {
                    window._palinkFetchInterceptCount = (window._palinkFetchInterceptCount || 0) + 1;
                    console.log('[palink-smart-card] fetch intercepted:', path, 'status=', response.status, 'ok=', response.ok);
                    if (response.ok) {
                        return processChatResponse(response);
                    }
                }
            } catch (e) {
                console.warn('[palink-smart-card] fetch interceptor error:', e);
            }
            return response;
        };
    }

    /**
     * 拦截 XMLHttpRequest（jQuery $.ajax 底层用 XHR，不经过 fetch）
     * ST 的 chats.js 用 jQuery $.ajax 发 /api/chats/get 请求，
     * 必须拦截 XHR 才能处理消息内容。
     * 方案：在 open 时检查 URL，重写 responseText/response getter（延迟处理）
     */
    function installXhrInterceptor() {
        var XHR = window.XMLHttpRequest;
        if (!XHR || !XHR.prototype) return;

        var origOpen = XHR.prototype.open;
        var origResponseTextDesc = Object.getOwnPropertyDescriptor(XHR.prototype, 'responseText');
        var origResponseDesc = Object.getOwnPropertyDescriptor(XHR.prototype, 'response');

        if (!origResponseTextDesc || !origResponseTextDesc.get) {
            console.warn('[palink-smart-card] cannot intercept XHR responseText');
            return;
        }

        XHR.prototype.open = function (method, url) {
            this._palinkPath = '';
            try {
                this._palinkPath = new URL(url, location.origin).pathname;
            } catch (e) {}

            var self = this;
            var needsIntercept = self._palinkPath === '/api/chats/get' || self._palinkPath === '/api/chats/group/get';

            if (needsIntercept && !self._palinkXhrPatched) {
                self._palinkXhrPatched = true;
                self._palinkProcessed = false;
                self._palinkCachedText = null;
                self._palinkCachedObj = null;

                // 延迟处理：第一次访问 responseText/response 时（readyState=4）才处理
                Object.defineProperty(self, 'responseText', {
                    get: function () {
                        if (self.readyState === 4 && !self._palinkProcessed) {
                            processXhrResponse(self, origResponseTextDesc, origResponseDesc);
                        }
                        if (self._palinkCachedText !== null) return self._palinkCachedText;
                        return origResponseTextDesc.get.call(self);
                    },
                    configurable: true
                });

                if (origResponseDesc && origResponseDesc.get) {
                    Object.defineProperty(self, 'response', {
                        get: function () {
                            if (self.readyState === 4 && !self._palinkProcessed) {
                                processXhrResponse(self, origResponseTextDesc, origResponseDesc);
                            }
                            if (self._palinkCachedObj !== null) return self._palinkCachedObj;
                            if (self._palinkCachedText !== null) return self._palinkCachedText;
                            return origResponseDesc.get.call(self);
                        },
                        configurable: true
                    });
                }
            }

            return origOpen.apply(this, arguments);
        };

        console.log('[palink-smart-card] XHR interceptor installed');
    }

    /**
     * 处理 XHR 响应：解析 JSON，预处理每条消息，缓存处理结果
     */
    function processXhrResponse(xhr, origResponseTextDesc, origResponseDesc) {
        xhr._palinkProcessed = true;
        try {
            var origText = null;
            var data = null;

            // 尝试获取原始 responseText
            try {
                origText = origResponseTextDesc.get.call(xhr);
            } catch (e) {
                // responseType 可能是 'json'，尝试 response
                if (origResponseDesc && origResponseDesc.get) {
                    var origResp = origResponseDesc.get.call(xhr);
                    if (typeof origResp === 'string') {
                        origText = origResp;
                    } else if (origResp && typeof origResp === 'object') {
                        data = origResp;
                    }
                }
            }

            if (!data && origText) {
                data = JSON.parse(origText);
            }
            if (!Array.isArray(data)) return;

            var modified = false;
            for (var i = 0; i < data.length; i++) {
                var item = data[i];
                if (item && typeof item.mes === 'string') {
                    var original = item.mes;
                    var result = processMessageMes(item.mes, i);
                    if (result.mes !== original) {
                        item.mes = result.mes;
                        modified = true;
                    }
                }
            }

            if (modified) {
                xhr._palinkCachedText = JSON.stringify(data);
                xhr._palinkCachedObj = data;
                console.log('[palink-smart-card] XHR response processed, modified', data.length, 'messages');
            }
        } catch (e) {
            console.warn('[palink-smart-card] XHR response process error:', e);
        }
    }

    /**
     * 处理聊天响应：解析 JSON，预处理每条消息，返回修改后的 Response
     */
    async function processChatResponse(response) {
        var cloned = response.clone();
        var data;
        try {
            data = await cloned.json();
        } catch (e) {
            window._palinkDebug = {error: 'json parse failed', msg: e.message};
            console.warn('[palink-smart-card] processChatResponse: failed to parse JSON:', e);
            return response;
        }

        if (!Array.isArray(data)) {
            window._palinkDebug = {error: 'not array', type: typeof data};
            console.log('[palink-smart-card] processChatResponse: response is not array, type=', typeof data, 'length=', data && data.length);
            return response;
        }

        console.log('[palink-smart-card] processChatResponse: array length=', data.length);
        var modified = false;
        var processedInfo = [];
        for (var i = 0; i < data.length; i++) {
            var item = data[i];
            if (item && typeof item.mes === 'string') {
                var original = item.mes;
                var result = processMessageMes(item.mes, i);
                if (result.mes !== original) {
                    item.mes = result.mes;
                    modified = true;
                    processedInfo.push({i: i, oldLen: original.length, newLen: result.mes.length, extracted: result.extracted, hasMarker: result.mes.indexOf('data-palink-script') > -1});
                    console.log('[palink-smart-card] message', i, 'processed: extracted', result.extracted, 'scripts, len', original.length, '->', result.mes.length);
                }
            }
        }

        if (!modified) {
            window._palinkDebug = {error: 'no modifications', dataLen: data.length};
            console.log('[palink-smart-card] processChatResponse: no modifications needed');
            return response;
        }
        console.log('[palink-smart-card] processChatResponse: modified, returning new Response');
        window._palinkDebug = {success: true, dataLen: data.length, processed: processedInfo};

        var body = JSON.stringify(data);
        var headers = new Headers();
        headers.set('Content-Type', 'application/json');
        try {
            var ct = response.headers.get('Content-Type');
            if (ct) headers.set('Content-Type', ct);
        } catch (e) {}

        return new Response(body, {
            status: response.status,
            statusText: response.statusText,
            headers: headers
        });
    }

    /**
     * 剥离 ```html ... ``` 或 ``` ... ``` 代码围栏
     * 支持 3 个或更多反引号（ST 卡片常使用 4 反引号 ````html 围栏）
     * 仅当整个 mes 被一对围栏包裹时才剥离
     * - 如果语言标记是 html/HTML，直接剥离
     * - 如果没有语言标记，仅当内容包含 HTML 标签时才剥离（避免误剥代码示例）
     */
    function stripCodeFence(mes) {
        // 匹配 3+ 反引号围栏：开头和结尾的反引号数量必须一致
        var fenceMatch = mes.match(/^\s*(`{3,})(html|HTML)?\s*\n([\s\S]*?)\n\s*(`{3,})\s*$/);
        if (!fenceMatch) return mes;

        var lang = fenceMatch[2];
        var content = fenceMatch[3];

        if (lang === 'html' || lang === 'HTML') {
            return content;
        }

        // 无语言标记 — 仅当内容包含需要渲染的 HTML 元素时才剥离
        if (/<(?:script|table|div|style|tr|td|<!DOCTYPE)[\s>]/i.test(content)) {
            return content;
        }

        return mes;
    }

    /**
     * 剥离内容中所有剩余的代码围栏标记行
     * 角色卡可能包含多个 HTML 文档，每个都用代码围栏包裹（如 ````html ... ````）
     * stripCodeFence 只剥离最外层围栏，内部的围栏会被 Showdown 当作代码块转义
     * 此函数移除所有独立的围栏标记行（3+ 反引号 + 可选语言标记/$1 占位符）
     * 仅当内容包含 HTML 标签时才执行（避免误剥普通代码示例）
     */
    function stripInnerCodeFences(mes) {
        if (!/<(?:script|table|div|style|tr|td|<!DOCTYPE|<html[\s>])/i.test(mes)) {
            return mes;
        }
        // 移除围栏行（连同换行符），避免留下空行导致后续缩进内容被 Showdown 当作代码块
        // 先移除带换行符的围栏行（非末尾），再移除可能在末尾的围栏行
        mes = mes.replace(/^[ \t]*`{3,}[a-zA-Z$0-9]*[ \t]*\r?\n/gm, '');
        mes = mes.replace(/^[ \t]*`{3,}[a-zA-Z$0-9]*[ \t]*$/gm, '');
        return mes;
    }

    /**
     * 扁平化 HTML 文档：
     * - 如果 mes 包含 <!DOCTYPE> 或 <html>，把 <head> 替换为其内部的 <script> 标签（保留原位）
     * - 移除 <!DOCTYPE>、<html>、<head>、<body> 等文档级标签
     * - 注意：script 保留在 <head> 原位置（保留原缩进），不前置到顶部，
     *   否则 dedentHtml 会因 script 行 0 缩进而计算 minIndent=0，无法去缩进
     */
    function flattenHtmlDocument(mes) {
        if (!/<html[\s>]/i.test(mes) && !/<!DOCTYPE/i.test(mes)) {
            return mes;
        }

        // 把 <head>...</head> 替换为其内部的 <script> 标签（保留在原位，保留缩进）
        mes = mes.replace(/<head[^>]*>([\s\S]*?)<\/head>/gi, function (match, headContent) {
            var scripts = headContent.match(/<script\b[^>]*>[\s\S]*?<\/script>/gims);
            if (scripts) {
                return scripts.join('\n');
            }
            return '';
        });

        // 移除文档级标签
        mes = mes.replace(/<!DOCTYPE[^>]*>/gi, '');
        mes = mes.replace(/<\/?html[^>]*>/gi, '');
        mes = mes.replace(/<\/?body[^>]*>/gi, '');
        // 只 trim 换行符，保留行首缩进 — 否则 dedentHtml 会因首行 0 缩进而计算 minIndent=0
        mes = mes.replace(/^\n+/, '').replace(/\n+$/, '');

        return mes;
    }

    /**
     * 去除 HTML 内容的公共前导空白（dedent）
     * Showdown 会把 4+ 空格缩进的行当代码块转义，导致 HTML 标签被 escape
     *
     * 当 mes 是混合内容（如 "Error: ...\n<!DOCTYPE html>..." 前缀 + 缩进 HTML）时，
     * 前缀行（0 缩进）会使全局 minIndent=0，导致 HTML 部分无法被 dedent。
     * 修复：从第一个包含 HTML 标签的行开始计算 minIndent，前缀行保持原样。
     */
    function dedentHtml(mes) {
        // 仅当内容包含 HTML 标签时才 dedent
        if (!/<(?:div|table|script|style|tr|td|span|p|ul|ol|li|section|article|header|footer|nav|aside|h[1-6]|<!DOCTYPE|<html[\s>])\b/i.test(mes)) {
            return mes;
        }

        var lines = mes.split('\n');

        // 找到第一个包含 HTML 标签的行（HTML 块的开始）
        var htmlStartIdx = -1;
        for (var i = 0; i < lines.length; i++) {
            if (/<(?:<!DOCTYPE|html|head|body|div|table|script|style|tr|td|th|span|p|ul|ol|li|section|article|header|footer|nav|aside|h[1-6])[\s>]/i.test(lines[i])) {
                htmlStartIdx = i;
                break;
            }
        }
        if (htmlStartIdx === -1) return mes;

        // 从 HTML 块开始位置计算 minIndent（只统计非空行）
        var minIndent = Infinity;
        for (var i = htmlStartIdx; i < lines.length; i++) {
            if (lines[i].trim() === '') continue;
            var match = lines[i].match(/^(\s*)/);
            var indent = match ? match[1].length : 0;
            if (indent < minIndent) minIndent = indent;
        }
        if (minIndent === Infinity || minIndent === 0) return mes;

        // 前缀行保持不变，HTML 块及之后的所有行应用 dedent
        var result = [];
        for (var i = 0; i < lines.length; i++) {
            if (i < htmlStartIdx) {
                result.push(lines[i]);
            } else {
                result.push(lines[i].substring(minIndent));
            }
        }
        return result.join('\n');
    }

    /**
     * 处理单条消息 mes：
     * 1. 剥离最外层代码围栏
     * 1.5. 剥离内部代码围栏（多 HTML 文档场景）
     * 2. 扁平化 HTML 文档
     * 3. 去除公共缩进（防止 Showdown 把缩进内容当代码块）
     * 4. 提取 <script>，替换为标记 div
     * 5. 移除标记前空行
     * 6. 移除 HTML 标签行的前导空白（防止 Showdown 把缩进的 <tag> 当代码块转义）
     * 返回 { mes: 修改后的内容, extracted: 提取数量 }
     */
    function processMessageMes(mes, msgIndex) {
        var debugSteps = { msgIndex: msgIndex, origLen: mes.length };
        var hasHtml = /<(?:script|table|div|style|tr|td|<!DOCTYPE|<html[\s>])/i.test(mes);

        // Step 1: 剥离最外层代码围栏
        mes = stripCodeFence(mes);
        debugSteps.afterStep1 = mes.length;

        // Step 1.5: 剥离内部代码围栏（角色卡可能包含多个 HTML 文档，每个都用围栏包裹）
        var fenceCountBefore = (mes.match(/^`{3,}/gm) || []).length;
        mes = stripInnerCodeFences(mes);
        var fenceCountAfter = (mes.match(/^`{3,}/gm) || []).length;
        debugSteps.afterStep1_5 = mes.length;
        debugSteps.fenceBefore = fenceCountBefore;
        debugSteps.fenceAfter = fenceCountAfter;

        // Step 2: 扁平化 HTML 文档
        mes = flattenHtmlDocument(mes);
        debugSteps.afterStep2 = mes.length;

        // Step 3: 去除公共缩进（Showdown 会把 4+ 空格缩进当代码块）
        mes = dedentHtml(mes);
        debugSteps.afterStep3 = mes.length;

        // Step 3.5: 移除 HTML 标签行的前导空白
        // dedentHtml 在混合内容（0 缩进文本 + N 缩进 HTML）场景下无法统一去缩进，
        // 但只要 HTML 标签行本身没有 4+ 空格前导空白，Showdown 就不会把它们转义为 <pre><code>
        // 只处理以 < 开头的行，保留文本内容的缩进（避免破坏 <pre>/white-space:pre-wrap 内容）
        if (hasHtml) {
            var lines = mes.split('\n');
            for (var i = 0; i < lines.length; i++) {
                lines[i] = lines[i].replace(/^[ \t]+(<[\w\/!])/g, '$1');
            }
            mes = lines.join('\n');
        }
        debugSteps.afterStep3_5 = mes.length;

        // 存储调试信息（仅前 3 条消息）
        if (msgIndex < 3) {
            window._palinkMesDebug = window._palinkMesDebug || {};
            window._palinkMesDebug[msgIndex] = debugSteps;
            window._palinkMesDebug[msgIndex + '_processed'] = mes;
        }

        // Step 4: 提取 <script> 标签，替换为标记 div
        var count = 0;
        mes = mes.replace(
            /<script\b([^>]*)>([\s\S]*?)<\/script>/gims,
            function (match, attrs, content) {
                count++;
                var id = msgIndex + '-' + (++scriptCounter);

                var srcMatch = attrs.match(/\bsrc\s*=\s*["']([^"']+)["']/i);
                if (srcMatch) {
                    SCRIPT_STORE[id] = { type: 'external', src: srcMatch[1] };
                } else {
                    var patchedContent = content.replace(
                        /document\s*\.\s*addEventListener\s*\(\s*(['"])DOMContentLoaded\1/g,
                        "document.addEventListener($1" + INIT_EVENT + "$1"
                    );
                    SCRIPT_STORE[id] = { type: 'inline', code: patchedContent };
                }

                return '<div data-palink-script="' + id + '"></div>';
            }
        );

        // Step 5: 移除标记 div 前的空行（Showdown 会把空行后的 <div> 当代码块转义）
        mes = mes.replace(/\n\s*<div data-palink-script/g, '<div data-palink-script');

        // Step 6: 移除标记 div 后到下一个 HTML 标签之间的空行
        // 防止 "marker</div>\n\n\n    <div>" 模式被 Showdown 当作代码块
        if (hasHtml) {
            mes = mes.replace(/(<\/div>)\n\s*\n[ \t]*(<[\w\/!])/g, '$1\n$2');
        }

        return { mes: mes, extracted: count };
    }

    /**
     * 在指定元素中查找标记并执行脚本
     */
    function executeScriptsInElement(element) {
        var markers = element.querySelectorAll('div[data-palink-script]');
        if (markers.length === 0) return;

        console.log('[palink-smart-card] executeScriptsInElement: found', markers.length, 'markers');
        var executedCount = 0;
        for (var i = 0; i < markers.length; i++) {
            var marker = markers[i];
            var id = marker.getAttribute('data-palink-script');
            var scriptData = SCRIPT_STORE[id];
            console.log('[palink-smart-card] marker', i, 'id=', id, 'hasScript=', !!scriptData);
            if (!scriptData) {
                console.warn('[palink-smart-card] no script data for marker', id, '- marker will be removed');
                marker.remove();
                continue;
            }

            try {
                var script = document.createElement('script');
                if (scriptData.type === 'external') {
                    script.src = scriptData.src;
                    console.log('[palink-smart-card] executing external script:', scriptData.src);
                } else {
                    script.textContent = scriptData.code;
                    console.log('[palink-smart-card] executing inline script', id, 'code length=', scriptData.code.length);
                }
                marker.parentNode.replaceChild(script, marker);
                executedCount++;
                console.log('[palink-smart-card] script', id, 'inserted (executed=' + executedCount + ')');

                // 同步派发初始化事件 — 脚本插入 DOM 时已同步执行完毕，事件监听器已注册
                try {
                    document.dispatchEvent(new Event(INIT_EVENT));
                    console.log('[palink-smart-card] event', INIT_EVENT, 'dispatched synchronously');
                } catch (e) {
                    console.warn('[palink-smart-card] init event dispatch failed:', e);
                }
            } catch (e) {
                console.error('[palink-smart-card] script execution failed:', e);
                marker.remove();
            }
        }

        // 最终再派发一次，确保所有脚本都能收到事件（某些脚本可能在前面脚本派发时还未注册）
        if (executedCount > 0) {
            try {
                document.dispatchEvent(new Event(INIT_EVENT));
                console.log('[palink-smart-card] final event', INIT_EVENT, 'dispatched for', executedCount, 'scripts');
            } catch (e) {}
        }
    }

    /**
     * 安装 MutationObserver 监听 .mes_text 元素插入
     */
    function installObserver() {
        var target = document.body || document.documentElement;
        if (!target) {
            setTimeout(installObserver, 50);
            return;
        }

        console.log('[palink-smart-card] installing MutationObserver on', target.tagName);
        var observer = new MutationObserver(function (mutations) {
            for (var i = 0; i < mutations.length; i++) {
                var added = mutations[i].addedNodes;
                for (var j = 0; j < added.length; j++) {
                    var node = added[j];
                    if (node.nodeType !== 1) continue;

                    if (node.classList && node.classList.contains('mes_text')) {
                        executeScriptsInElement(node);
                    }
                    if (node.querySelectorAll) {
                        var mesTexts = node.querySelectorAll('.mes_text');
                        for (var k = 0; k < mesTexts.length; k++) {
                            executeScriptsInElement(mesTexts[k]);
                        }
                    }
                }
            }
        });

        observer.observe(target, { childList: true, subtree: true });
        console.log('[palink-smart-card] MutationObserver active');
    }

    // 启动
    installFetchInterceptor();
    installXhrInterceptor();

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', installObserver);
    } else {
        installObserver();
    }

    console.log('[palink-smart-card] initialized (fetch + XHR interceptor + MutationObserver)');
})();
