#!/usr/bin/env node

/**
 * ST Native 官方 UI 端到端冒烟测试。
 *
 * 在真实浏览器中验证 Palink 前端 nginx/Vite 代理暴露的 ST Native 入口
 * （/st/ 与 /st/index.html）是否可以加载、完成认证、展示角色列表、
 * 进入聊天界面，并收集 console / network 错误。
 *
 * 环境变量：
 *   PALINK_URL            - 测试目标 URL（默认 http://localhost:3000）
 *   PALINK_SMOKE_USER     - 登录用户名（默认 admin）
 *   PALINK_SMOKE_PASSWORD - 登录密码（默认 admin123）
 *   PALINK_TOKEN          - 直接注入的 JWT token（可选，未设置则用账号密码登录）
 *   ST_NATIVE_ENTRY       - 强制指定入口 URL（可选，默认依次探测 /st/ 与 /st/index.html）
 *
 * 截图保存位置：
 *   Linux/macOS: /tmp/st-native-home.png 与 /tmp/st-native-chat.png
 *   Windows:     os.tmpdir() 下的同名文件
 *
 * 运行：
 *   node scripts/st_native_e2e_smoke.cjs
 *
 * 退出码：0 表示通过，1 表示有问题（页面未加载 / 无角色列表 / 无聊天界面 / 入口 401）。
 */

const { chromium } = require('playwright');
const path = require('path');
const os = require('os');

const BASE_URL = process.env.PALINK_URL || 'http://localhost:3000';
const USERNAME = process.env.PALINK_SMOKE_USER || 'admin';
const PASSWORD = process.env.PALINK_SMOKE_PASSWORD || 'admin123';
const PALINK_TOKEN = process.env.PALINK_TOKEN || '';
const FORCED_ENTRY = process.env.ST_NATIVE_ENTRY || '';
const TIMEOUT = 30000;

// os.tmpdir() 在 Linux/macOS 下返回 /tmp，在 Windows 下返回用户临时目录。
const TMP_DIR = os.tmpdir();
const HOME_SCREENSHOT = path.join(TMP_DIR, 'st-native-home.png');
const CHAT_SCREENSHOT = path.join(TMP_DIR, 'st-native-chat.png');

const ENTRY_CANDIDATES = FORCED_ENTRY
  ? [FORCED_ENTRY]
  : [`${BASE_URL}/st/`, `${BASE_URL}/st/index.html`];

const WATCHED_STATUS = new Set([401, 404, 422, 500]);

function assert(condition, message, details) {
  if (condition) return;
  const error = new Error(message);
  error.details = details;
  throw error;
}

async function login(page) {
  if (PALINK_TOKEN) {
    await page.goto(`${BASE_URL}/login`, { waitUntil: 'domcontentloaded', timeout: TIMEOUT });
    await page.evaluate((token) => localStorage.setItem('palink_token', token), PALINK_TOKEN);
    return { source: 'env-token' };
  }
  await page.goto(`${BASE_URL}/login`, { waitUntil: 'networkidle', timeout: TIMEOUT });
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
    return {
      status: response.status,
      ok: response.ok,
      hasToken: Boolean(json?.access_token),
      text: text.slice(0, 200),
    };
  }, { username: USERNAME, password: PASSWORD });
  assert(result.ok && result.hasToken, 'smoke login failed', result);
  return result;
}

async function exploreEntry(page) {
  const attempts = [];
  for (const candidate of ENTRY_CANDIDATES) {
    let response = null;
    try {
      response = await page.goto(candidate, { waitUntil: 'domcontentloaded', timeout: TIMEOUT });
    } catch (error) {
      attempts.push({
        url: candidate,
        status: 0,
        finalUrl: page.url(),
        error: String(error?.message || error).slice(0, 300),
      });
      continue;
    }
    const status = response ? response.status() : 0;
    const finalUrl = page.url();
    const redirectedToLogin = /\/login(\?|$|#)/i.test(finalUrl) && !/\/st\//i.test(candidate);
    attempts.push({ url: candidate, status, finalUrl, redirectedToLogin });
    if (status === 401 || redirectedToLogin) {
      // 入口需要认证或被重定向到登录页，记录后继续尝试下一个候选。
      continue;
    }
    if (status >= 200 && status < 400) {
      return { url: candidate, status, finalUrl, response, attempts };
    }
  }
  return { url: '', status: 0, finalUrl: page.url(), response: null, attempts };
}

async function waitForNetworkIdle(page) {
  try {
    await page.waitForLoadState('networkidle', { timeout: TIMEOUT });
    return { ok: true };
  } catch (error) {
    return { ok: false, message: String(error?.message || error).slice(0, 300) };
  }
}

async function detectCharacterList(page) {
  try {
    await page.waitForSelector('#rm_print_characters_block .character_select', { timeout: 20000 });
    return true;
  } catch {
    // 退一步：检查角色容器是否存在且非空。
    return page.evaluate(() => {
      const block = document.querySelector('#rm_print_characters_block');
      if (!block) return false;
      return (
        block.querySelectorAll('.character_select, .group_select, .bogus_folder_select').length > 0
        || block.children.length > 0
      );
    });
  }
}

async function clickFirstCharacter(page) {
  const selector = '#rm_print_characters_block .character_select';
  try {
    await page.waitForSelector(selector, { timeout: 10000 });
    await page.click(`${selector} >> nth=0`, { timeout: 10000 });
    // 等待 ST 切换到聊天视图
    await page.waitForTimeout(3000);
    return { ok: true };
  } catch (error) {
    return { ok: false, error: String(error?.message || error).slice(0, 300) };
  }
}

async function detectChatInterface(page) {
  return page.evaluate(() => {
    const chat = document.querySelector('#chat');
    // 真正加载完成的聊天界面：#chat 中存在消息节点 (.mes)，
    // 或已选中角色（#characterName 有文本且非占位）且聊天表单可见。
    // 仅凭 #form_sheld 可见不足以判定 —— ST 初始化失败时也会显示该表单。
    const hasMessages = Boolean(chat && chat.querySelector('.mes'));
    if (hasMessages) return true;
    const charNameEl = document.querySelector('#characterName');
    const charName = (charNameEl?.textContent || '').trim();
    const formSheld = document.querySelector('#form_sheld');
    const formVisible = formSheld && window.getComputedStyle(formSheld).display !== 'none';
    const hasRealCharacter = Boolean(charName) && !/select character|no character/i.test(charName);
    return Boolean(formVisible && hasRealCharacter);
  });
}

async function main() {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });

  const consoleErrors = [];
  const networkErrors = [];
  const screenshots = [];

  page.on('console', (message) => {
    if (message.type() !== 'error') return;
    const text = message.text();
    consoleErrors.push(text);
  });
  page.on('pageerror', (error) => {
    consoleErrors.push(`pageerror: ${error?.message || String(error)}`);
  });
  page.on('response', (response) => {
    const status = response.status();
    if (status >= 200 && status < 300) return;
    networkErrors.push({
      url: response.url(),
      status,
      method: response.request().method(),
    });
  });

  const result = {
    ok: false,
    entryUrl: '',
    pageLoaded: false,
    title: '',
    consoleErrors,
    networkErrors,
    hasCharacterList: false,
    hasChatInterface: false,
    screenshots,
    bodyPreview: '',
    isStNativeUi: false,
    authRedirect: null,
    entryAttempts: [],
    networkIdle: null,
    characterClick: null,
    watchedStatusHits: [],
  };

  try {
    // 1. 登录获取 token（写入 localStorage.palink_token）
    await login(page);

    // 2. 探测 ST Native 入口
    const entry = await exploreEntry(page);
    result.entryAttempts = entry.attempts;
    result.entryUrl = entry.url;

    if (!entry.url) {
      result.authRedirect = {
        message: '所有 ST Native 入口候选均不可用（401 / 重定向 / 非 2xx）',
        finalUrl: entry.finalUrl,
      };
      console.log(JSON.stringify(result, null, 2));
      process.exitCode = 1;
      return;
    }

    if (entry.status === 401 || (/\/login(\?|$|#)/i.test(entry.finalUrl) && !/\/st\//i.test(entry.finalUrl))) {
      result.authRedirect = {
        message: 'ST Native 入口返回 401 或被重定向到登录页',
        triedUrl: entry.url,
        finalUrl: entry.finalUrl,
        status: entry.status,
      };
      console.log(JSON.stringify(result, null, 2));
      process.exitCode = 1;
      return;
    }

    // 3. 等待 networkidle
    result.networkIdle = await waitForNetworkIdle(page);
    result.pageLoaded = true;

    result.title = await page.title();
    result.bodyPreview = await page.evaluate(() => (document.body?.innerText || '').slice(0, 200));
    // ST 原生 UI 的 title 通常是 "SillyTavern"，且 body 会包含 ST 特有结构。
    result.isStNativeUi = /sillytavern/i.test(result.title)
      || Boolean(await page.evaluate(() => document.querySelector('#rm_print_characters_block, #sheld, #send_textarea')));

    // 4. 截图首页
    try {
      await page.screenshot({ path: HOME_SCREENSHOT, fullPage: true });
      screenshots.push(HOME_SCREENSHOT);
    } catch (error) {
      result.screenshotError = String(error?.message || error).slice(0, 300);
    }

    // 5. 检查角色列表
    result.hasCharacterList = await detectCharacterList(page);

    // 6. 尝试点击一个角色
    if (result.hasCharacterList) {
      result.characterClick = await clickFirstCharacter(page);
    } else {
      result.characterClick = { ok: false, skipped: true, reason: 'no character list detected' };
    }

    // 7. 检查聊天界面
    result.hasChatInterface = await detectChatInterface(page);

    // 8. 截图聊天
    try {
      await page.screenshot({ path: CHAT_SCREENSHOT, fullPage: true });
      screenshots.push(CHAT_SCREENSHOT);
    } catch (error) {
      if (result.screenshotError) {
        result.screenshotError += ' | chat: ' + String(error?.message || error).slice(0, 200);
      } else {
        result.screenshotError = 'chat: ' + String(error?.message || error).slice(0, 300);
      }
    }

    // 9. 汇总受关注的状态码命中
    result.watchedStatusHits = networkErrors.filter((item) => WATCHED_STATUS.has(item.status));

    // 10. 判定通过条件：页面加载 + （角色列表或聊天界面）
    result.ok = result.pageLoaded && (result.hasCharacterList || result.hasChatInterface);

    console.log(JSON.stringify(result, null, 2));
    if (!result.ok) process.exitCode = 1;
  } catch (error) {
    result.error = {
      message: error.message,
      stack: String(error.stack || '').slice(0, 1500),
      details: error.details,
    };
    console.log(JSON.stringify(result, null, 2));
    process.exitCode = 1;
  } finally {
    await browser.close();
  }
}

main();
