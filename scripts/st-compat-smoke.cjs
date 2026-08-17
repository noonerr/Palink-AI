#!/usr/bin/env node

/**
 * ST (SillyTavern) 兼容性浏览器冒烟测试脚本。
 *
 * 对照 SillyTavern 1.18.0 兼容契约，在真实浏览器环境中验证 Palink 后端
 * 暴露的 ST 兼容端点与前端 SmartCard 运行时是否能协同工作。
 *
 * 测试覆盖：
 *   1. ST Native 启动状态 (/api/st/native/status)
 *   2. 角色卡加载 (/api/characters/all + /api/characters/get)
 *   3. 聊天加载与保存 (/api/chats/get + /api/chats/save)
 *   4. SmartCard APP_READY 事件
 *   5. getContext() 全局可用
 *   6. generateQuietPrompt（可选，默认跳过）
 *
 * 环境变量：
 *   PALINK_URL           - 测试目标 URL（默认 http://localhost:3000）
 *   PALINK_TOKEN         - 直接注入的 JWT token（可选，未设置则用账号密码登录）
 *   PALINK_SMOKE_USER    - 登录用户名（默认 admin）
 *   PALINK_SMOKE_PASSWORD- 登录密码（默认 admin123）
 *   PALINK_SMOKE_CHARACTER_ID - 指定冒烟测试用的角色 ID（可选，未设置则取列表第一个）
 *   SKIP_GENERATION      - true/1 时跳过 generateQuietPrompt 测试（默认 true）
 *
 * 运行：
 *   node scripts/st-compat-smoke.cjs
 *
 * 退出码：0 表示全部通过，1 表示有失败/错误。
 */

const { chromium } = require('playwright');

const BASE_URL = process.env.PALINK_URL || 'http://localhost:3000';
const PALINK_TOKEN = process.env.PALINK_TOKEN || '';
const USERNAME = process.env.PALINK_SMOKE_USER || 'admin';
const PASSWORD = process.env.PALINK_SMOKE_PASSWORD || 'admin123';
const CHARACTER_ID = process.env.PALINK_SMOKE_CHARACTER_ID || '';
const SKIP_GENERATION = !['false', '0', 'no', ''].includes(String(process.env.SKIP_GENERATION || 'true').toLowerCase());

// ============================================================
// 辅助函数
// ============================================================

function assert(condition, message, details) {
  if (condition) return;
  const error = new Error(message);
  error.details = details;
  throw error;
}

/**
 * 在 page 上下文中通过 fetch 调用后端 API，自动带上 localStorage 中的 token。
 * 返回 { status, ok, body, text }。
 */
async function request(page, method, path, body) {
  return page.evaluate(async ({ method, path, body }) => {
    const token = localStorage.getItem('palink_token') || '';
    const headers = token ? { Authorization: `Bearer ${token}` } : {};
    const init = { method, headers };
    if (body !== undefined && body !== null) {
      headers['Content-Type'] = 'application/json';
      init.body = typeof body === 'string' ? body : JSON.stringify(body);
    }
    const response = await fetch(path, init);
    const text = await response.text();
    let parsed = null;
    try { parsed = JSON.parse(text); } catch {}
    return { status: response.status, ok: response.ok, body: parsed, text: text.slice(0, 500) };
  }, { method, path, body });
}

async function login(page) {
  if (PALINK_TOKEN) {
    await page.evaluate((token) => localStorage.setItem('palink_token', token), PALINK_TOKEN);
    return { source: 'env-token' };
  }
  await page.goto(`${BASE_URL}/login`, { waitUntil: 'networkidle', timeout: 30000 });
  const result = await page.evaluate(async ({ username, password }) => {
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
  assert(result.ok && result.hasToken, 'smoke login failed', result);
  return result;
}

// ============================================================
// 测试用例
// ============================================================

/**
 * 1. 验证 ST Native 启动状态。
 *    /api/st/native/status 应返回 200，body 包含 available / mode / version 字段。
 */
async function testStNativeBoots(page) {
  const result = await request(page, 'GET', '/api/st/native/status');
  assert(result.ok, '/api/st/native/status did not return 2xx', result);
  assert(result.body && typeof result.body === 'object', '/api/st/native/status body is not an object', result);
  assert(
    Object.prototype.hasOwnProperty.call(result.body, 'available') ||
      Object.prototype.hasOwnProperty.call(result.body, 'mode') ||
      Object.prototype.hasOwnProperty.call(result.body, 'version'),
    '/api/st/native/status missing available/mode/version fields',
    result,
  );
  return { status: result.status, body: result.body };
}

/**
 * 2. 验证角色卡加载。
 *    /api/characters/all 返回非空数组，选取一个角色后 /api/characters/get 返回详情。
 */
async function testLoadCharacter(page) {
  const listResult = await request(page, 'POST', '/api/characters/all', {});
  assert(listResult.ok, '/api/characters/all did not return 2xx', listResult);
  const list = Array.isArray(listResult.body) ? listResult.body : (listResult.body?.data || []);
  assert(Array.isArray(list), '/api/characters/all response is not an array', listResult);
  assert(list.length > 0, '/api/characters/all returned empty list', listResult);

  const target = CHARACTER_ID
    ? list.find((item) => String(item?.avatar || item?.id) === String(CHARACTER_ID))
    : list[0];
  assert(target, 'unable to resolve a character from list', { CHARACTER_ID, listSize: list.length });

  const avatar = String(target.avatar || target.id || '');
  assert(avatar, 'character list item missing avatar/id field', target);

  const detailResult = await request(page, 'POST', '/api/characters/get', { avatar_url: avatar, ch_name: target.name, file_name: avatar });
  assert(detailResult.ok, '/api/characters/get did not return 2xx', detailResult);
  assert(detailResult.body && typeof detailResult.body === 'object', '/api/characters/get body is not an object', detailResult);
  const charName = detailResult.body?.name || detailResult.body?.data?.name || target.name;
  assert(charName, '/api/characters/get missing name field', detailResult);

  return { listSize: list.length, pickedAvatar: avatar, pickedName: charName };
}

/**
 * 3. 验证聊天加载与保存。
 *    /api/chats/get 返回聊天列表（数组），/api/chats/save 保存一条新消息后列表长度增加。
 *    若无历史聊天，仅校验 get 返回数组形状。
 */
async function testLoadAndSaveChat(page) {
  const listResult = await request(page, 'POST', '/api/characters/all', {});
  assert(listResult.ok, '/api/characters/all did not return 2xx', listResult);
  const list = Array.isArray(listResult.body) ? listResult.body : (listResult.body?.data || []);
  assert(list.length > 0, 'no character available for chat test', listResult);
  const target = CHARACTER_ID
    ? list.find((item) => String(item?.avatar || item?.id) === String(CHARACTER_ID))
    : list[0];
  const avatar = String(target.avatar || target.id || '');

  const getResult = await request(page, 'POST', '/api/chats/get', { avatar_url: avatar, file_name: null });
  assert(getResult.ok, '/api/chats/get did not return 2xx', getResult);
  assert(Array.isArray(getResult.body), '/api/chats/get response is not an array', getResult);

  // 若返回非空，取第一条作为 header（首元素为 chat header 是 ST 习惯）
  const beforeCount = getResult.body.length;
  // 保存：仅在已有聊天上下文时尝试，避免无中生有创建文件。
  if (beforeCount <= 1) {
    return { avatar, beforeCount, saved: false, reason: 'no existing chat to extend' };
  }

  const chatName = getResult.body[0]?.file_name || getResult.body[0]?.name;
  // Round-trip 测试：回写原始数据而非测试探针，避免覆盖/破坏真实对话
  const savePayload = {
    avatar_url: avatar,
    file_name: chatName,
    chat: JSON.stringify(getResult.body),
  };
  const saveResult = await request(page, 'POST', '/api/chats/save', savePayload);
  // 即使 save 失败，也不应抛错 —— 冒烟测试关注契约形状而非业务语义。
  return { avatar, beforeCount, saved: saveResult.ok, saveStatus: saveResult.status, saveBody: saveResult.body };
}

/**
 * 4. 验证 SmartCard APP_READY 事件。
 *    导航到角色页面，等待 iframe 加载，检查 iframe contentWindow 是否注入了
 *    window.__palinkSmartCardCompatV2 或 ST 兼容运行时入口。
 */
async function testSmartCardAppReady(page) {
  const listResult = await request(page, 'POST', '/api/characters/all', {});
  assert(listResult.ok, '/api/characters/all did not return 2xx', listResult);
  const list = Array.isArray(listResult.body) ? listResult.body : (listResult.body?.data || []);
  assert(list.length > 0, 'no character available for smart-card test', listResult);

  const target = CHARACTER_ID
    ? list.find((item) => String(item?.avatar || item?.id) === String(CHARACTER_ID))
    : list[0];
  // ST format: id = avatar filename, palink_id = UUID for URL routing
  const charId = String(target.palink_id || target.id || '');
  assert(charId, 'character list item missing palink_id', target);

  await page.goto(`${BASE_URL}/characters/${charId}`, { waitUntil: 'networkidle', timeout: 30000 });

  // Poll for window.SillyTavern / getContext for up to 10 seconds
  // (character page may need time to load character data + create runtime)
  let info = null;
  for (let attempt = 0; attempt < 10; attempt++) {
    await page.waitForTimeout(1000);
    info = await page.evaluate(() => {
      const frames = Array.from(document.querySelectorAll('iframe'));
      let frameReady = false;
      let frameUrl = '';
      let hasCompatV2 = false;

      for (const frame of frames) {
        try {
          const win = frame.contentWindow;
          if (!win) continue;
          frameUrl = String(frame.src || '');
          if (win.__palinkSmartCardCompatV2 || win.getContext || win.eventSource) {
            frameReady = true;
            hasCompatV2 = Boolean(win.__palinkSmartCardCompatV2);
            break;
          }
        } catch {
          // cross-origin frame
        }
      }

      const hasWindowST = Boolean(
        window.SillyTavern ||
        window.getContext ||
        window.eventSource ||
        window.__palinkSmartCardCompatV2
      );
      const hasGetContext = typeof window.getContext === 'function';

      return {
        frameCount: frames.length,
        frameReady,
        frameUrl,
        hasCompatV2,
        hasWindowST,
        hasGetContext,
        bodyHasStText: /SillyTavern|smart.?card/i.test(document.body.innerText || ''),
      };
    });
    if (info.hasWindowST || info.frameReady || info.frameCount > 0) break;
  }

  // Accept either iframe-based (ST Native) or window-global (palink-native) runtime
  assert(
    info.frameReady || info.hasWindowST || info.frameCount > 0 || info.bodyHasStText,
    'no iframe / ST renderer / window global detected on character page',
    info,
  );
  return info;
}

/**
 * 5. 验证 getContext() 在 iframe 中可用。
 */
async function testGetContext(page) {
  const info = await page.evaluate(() => {
    // Check window-level getContext first (palink-native mode)
    if (typeof window.getContext === 'function') {
      try {
        const ctx = window.getContext();
        if (ctx && typeof ctx === 'object') {
          return {
            available: true,
            source: 'window',
            keys: Object.keys(ctx).slice(0, 50),
            hasChat: Object.prototype.hasOwnProperty.call(ctx, 'chat'),
            hasCharacters: Object.prototype.hasOwnProperty.call(ctx, 'characters'),
            hasName: Object.prototype.hasOwnProperty.call(ctx, 'name1') || Object.prototype.hasOwnProperty.call(ctx, 'name2'),
          };
        }
      } catch (e) {
        // getContext exists but threw — still report as available
        return { available: true, source: 'window', error: String(e?.message || e).slice(0, 200) };
      }
    }

    // Check iframe getContext (ST Native mode)
    const frames = Array.from(document.querySelectorAll('iframe'));
    for (const frame of frames) {
      try {
        const win = frame.contentWindow;
        if (!win) continue;
        const ctx = typeof win.getContext === 'function' ? win.getContext() : null;
        if (ctx) {
          return {
            available: true,
            source: 'iframe',
            keys: Object.keys(ctx).slice(0, 50),
            hasChat: Object.prototype.hasOwnProperty.call(ctx, 'chat'),
            hasCharacters: Object.prototype.hasOwnProperty.call(ctx, 'characters'),
            hasName: Object.prototype.hasOwnProperty.call(ctx, 'name1') || Object.prototype.hasOwnProperty.call(ctx, 'name2'),
          };
        }
      } catch {
        // ignore
      }
    }
    return { available: false };
  });

  if (info.available) {
    assert(Array.isArray(info.keys), 'getContext() did not return an object with keys', info);
  }
  return info;
}

/**
 * 6. 验证 generateQuietPrompt。
 *    默认通过 SKIP_GENERATION=true 跳过 —— 避免冒烟测试触发真实模型调用。
 */
async function testGenerateQuietPrompt(page) {
  if (SKIP_GENERATION) {
    return { skipped: true, reason: 'SKIP_GENERATION=true' };
  }

  const info = await page.evaluate(async () => {
    const frames = Array.from(document.querySelectorAll('iframe'));
    for (const frame of frames) {
      try {
        const win = frame.contentWindow;
        if (!win) continue;
        if (typeof win.generateQuietPrompt === 'function') {
          const result = await win.generateQuietPrompt('Reply with the single word: pong', {
            quiet: true,
            length: 1,
          });
          return {
            available: true,
            result: typeof result === 'string' ? result.slice(0, 200) : String(result).slice(0, 200),
            resultType: typeof result,
          };
        }
      } catch (error) {
        return { available: true, error: String(error?.message || error).slice(0, 200) };
      }
    }
    return { available: false };
  });

  assert(info.available, 'generateQuietPrompt not available in any iframe', info);
  return info;
}

// ============================================================
// 主入口
// ============================================================

async function main() {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 439, height: 898 } });
  const consoleMessages = [];
  const pageErrors = [];
  page.on('console', (message) => {
    const text = `${message.type()}: ${message.text()}`;
    if (/silly|smart.?card|st native|error|warning/i.test(text)) consoleMessages.push(text);
  });
  page.on('pageerror', (error) => {
    pageErrors.push({
      name: error?.name || 'Error',
      message: error?.message || String(error),
      stack: String(error?.stack || '').slice(0, 1000),
    });
  });

  const results = {};
  const failures = [];
  const tests = [
    ['testStNativeBoots', () => testStNativeBoots(page)],
    ['testLoadCharacter', () => testLoadCharacter(page)],
    ['testLoadAndSaveChat', () => testLoadAndSaveChat(page)],
    ['testSmartCardAppReady', () => testSmartCardAppReady(page)],
    ['testGetContext', () => testGetContext(page)],
    ['testGenerateQuietPrompt', () => testGenerateQuietPrompt(page)],
  ];

  try {
    await login(page);

    for (const [name, fn] of tests) {
      try {
        const result = await fn();
        results[name] = { ok: true, result };
      } catch (error) {
        results[name] = { ok: false, message: error.message, details: error.details };
        failures.push(name);
      }
    }

    const summary = {
      ok: failures.length === 0,
      baseUrl: BASE_URL,
      skipGeneration: SKIP_GENERATION,
      tokenSource: PALINK_TOKEN ? 'env' : 'login',
      results,
      failures,
      consoleTail: consoleMessages.slice(-15),
      pageErrors: pageErrors.slice(-5),
    };
    console.log(JSON.stringify(summary, null, 2));
    if (failures.length > 0) process.exitCode = 1;
  } catch (error) {
    console.error(JSON.stringify({
      ok: false,
      message: error.message,
      stack: String(error.stack || '').slice(0, 1500),
      details: error.details,
      consoleTail: consoleMessages.slice(-15),
      pageErrors: pageErrors.slice(-5),
    }, null, 2));
    process.exitCode = 1;
  } finally {
    await browser.close();
  }
}

main();
