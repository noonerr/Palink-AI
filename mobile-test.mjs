import { chromium } from 'playwright';
import { writeFileSync, mkdirSync, existsSync } from 'fs';
import { join } from 'path';

const BASE = 'http://localhost:3000';
const SS_DIR = 'D:\\项目\\Palink-AI\\test-screenshots';
if (!existsSync(SS_DIR)) mkdirSync(SS_DIR, { recursive: true });
const ss = (name) => join(SS_DIR, name);

const FAKE_USER = { id: 1, username: 'admin', email: 'admin@palink.local', role: 'admin', avatar_url: '' };
const FAKE_MODELS = [
  { id: 'gpt-4o', name: 'GPT-4o', description: 'OpenAI GPT-4o', context_length: 128000, provider: 'openai' },
  { id: 'gpt-4o-mini', name: 'GPT-4o Mini', description: 'Mini', context_length: 128000, provider: 'openai' },
];
const FAKE_SESSIONS = [
  { id: 'sess-1', title: '测试对话 1', type: 'chat', created_at: new Date().toISOString(), updated_at: new Date().toISOString() },
  { id: 'sess-2', title: '测试对话 2 - 较长标题测试截断效果看看如何', type: 'chat', created_at: new Date().toISOString(), updated_at: new Date().toISOString() },
];
const FAKE_MESSAGES = [
  { id: 'msg-1', role: 'user', content: '你好，介绍一下自己', model: null, created_at: new Date().toISOString() },
  { id: 'msg-2', role: 'assistant', content: '你好！我是 Palink AI 助手。我可以帮助你回答问题、分析文件、进行角色扮演对话等。有什么我可以帮你的吗？', model: 'gpt-4o', created_at: new Date().toISOString() },
];
const FAKE_SETTINGS = { developer_mode: true, memory_mode: 'rule', default_chat_model: 'gpt-4o' };
const FAKE_PROVIDERS = [{ id: 1, name: 'OpenAI', base_url: 'https://api.openai.com/v1', models: FAKE_MODELS }];
const FAKE_SYSTEM_DEFAULTS = { default_chat_model: 'gpt-4o', default_workspace_model: 'gpt-4o', default_outline_model: 'gpt-4o' };
const FAKE_MEMORY_STATS = { total_memories: 42, categories: { user_preferences: 10, facts: 20, context: 12 } };

async function main() {
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({
    viewport: { width: 390, height: 844 },
    userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15',
  });
  const page = await context.newPage();

  await page.addInitScript(() => {
    localStorage.setItem('palink_token', 'mock-admin-token-12345');
    localStorage.setItem('palink_user_snapshot', JSON.stringify({ id: 1, username: 'admin', email: 'admin@palink.local', role: 'admin', avatar_url: '' }));
  });

  await page.route('**/api/**', async (route) => {
    const url = new URL(route.request().url());
    const path = url.pathname;
    const method = route.request().method();
    console.log(`[API] ${method} ${path}`);

    if (path === '/api/users/me' && method === 'GET') return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(FAKE_USER) });
    if (path === '/api/users/me/settings' && method === 'GET') return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(FAKE_SETTINGS) });
    if (path === '/api/users/me/settings' && method === 'PUT') return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true }) });
    if (path === '/api/models' && method === 'GET') return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(FAKE_MODELS) });
    if (path === '/api/admin/providers' && method === 'GET') return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(FAKE_PROVIDERS) });
    if (path === '/api/admin/system/defaults' && method === 'GET') return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(FAKE_SYSTEM_DEFAULTS) });
    if (path === '/api/sessions' && method === 'GET') return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(FAKE_SESSIONS) });
    if (path === '/api/sessions' && method === 'POST') return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ id: 'sess-new', title: '新对话', type: 'chat' }) });
    if (path.match(/^\/api\/sessions\/[^/]+$/) && method === 'DELETE') return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true }) });
    if (path === '/api/sessions/batch' && method === 'DELETE') return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true }) });
    if (path.match(/^\/api\/sessions\/[^/]+\/messages$/) && method === 'GET') return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(FAKE_MESSAGES) });
    if (path.match(/^\/api\/sessions\/[^/]+\/messages$/) && method === 'POST') return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ id: 'msg-new', ok: true }) });
    if (path.match(/\/messages\/[^/]+$/) && method === 'DELETE') return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true }) });
    if (path.match(/\/messages\/[^/]+$/) && method === 'PUT') return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true }) });
    if (path.includes('memory') && path.includes('stats')) return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(FAKE_MEMORY_STATS) });
    if (path.includes('stream') || path.includes('chat/completions')) {
      const words = ['这','是','一段','模拟','的','AI','回复','。','在','移动端','测试','中，','我们','需要','验证','流式','输出','是否','正常','滚动','和','显示','。','这段','文字','足够','长来','测试','换行','和','滚动','行为','。','再','多加','一些','内容','来','确保','它','能','滚动','起来','。'];
      let sse = '';
      for (const w of words) sse += 'data: ' + JSON.stringify({ choices: [{ delta: { content: w } }] }) + '\n\n';
      sse += 'data: [DONE]\n\n';
      return route.fulfill({ status: 200, contentType: 'text/event-stream', headers: { 'Cache-Control': 'no-cache' }, body: sse });
    }
    return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({}) });
  });

  console.log('\n=== TEST 1: App load ===');
  await page.goto(BASE, { waitUntil: 'networkidle', timeout: 15000 });
  await page.waitForTimeout(3000);
  await page.screenshot({ path: ss('m-01-home.png') });
  console.log('Saved m-01-home.png');

  console.log('\n=== TEST 2: Chat view ===');
  const sessionItem = await page.$('[class*="session"], [class*="chat-item"], [class*="history"] li, [class*="sidebar"] li');
  if (sessionItem) { await sessionItem.click(); await page.waitForTimeout(1500); }
  await page.screenshot({ path: ss('m-02-chat.png') });
  console.log('Saved m-02-chat.png');

  console.log('\n=== TEST 3: Input ===');
  const textarea = await page.$('textarea, [contenteditable]');
  if (textarea) {
    await textarea.click();
    await page.waitForTimeout(500);
    await textarea.fill('测试移动端输入体验，这是一段较长的文本用于测试输入框的换行和高度自适应行为');
    await page.waitForTimeout(500);
    await page.screenshot({ path: ss('m-03-input.png') });
    const rect = await textarea.boundingBox();
    console.log(`Input box: ${Math.round(rect?.width)}x${Math.round(rect?.height)} at y=${Math.round(rect?.y)}`);
  }

  console.log('\n=== TEST 4: Send & stream ===');
  if (textarea) {
    await textarea.press('Enter');
    await page.waitForTimeout(4000);
    await page.screenshot({ path: ss('m-04-streamed.png') });
    console.log('Saved m-04-streamed.png');
  }

  console.log('\n=== TEST 5: Settings ===');
  const nav = page.locator('nav');
  const navBtns = nav.locator('button, a');
  const navCount = await navBtns.count();
  console.log(`Nav buttons: ${navCount}`);
  if (navCount >= 4) { await navBtns.nth(3).click(); await page.waitForTimeout(1500); }
  await page.screenshot({ path: ss('m-05-settings.png') });
  console.log('Saved m-05-settings.png');

  console.log('\n=== TEST 6: Workspace ===');
  if (navCount >= 2) { await navBtns.nth(1).click(); await page.waitForTimeout(1500); }
  await page.screenshot({ path: ss('m-06-workspace.png') });

  console.log('\n=== TEST 7: Characters ===');
  if (navCount >= 3) { await navBtns.nth(2).click(); await page.waitForTimeout(1500); }
  await page.screenshot({ path: ss('m-07-characters.png') });

  console.log('\n=== TOUCH TARGET AUDIT ===');
  const smallTargets = await page.evaluate(() => {
    const results = [];
    document.querySelectorAll('button, a, [role="button"]').forEach(el => {
      const r = el.getBoundingClientRect();
      if (r.width > 0 && r.height > 0 && (r.width < 44 || r.height < 44)) {
        results.push({ text: (el.textContent || '').trim().slice(0, 30), w: Math.round(r.width), h: Math.round(r.height) });
      }
    });
    return results;
  });
  console.log(`Small touch targets: ${smallTargets.length}`);
  smallTargets.slice(0, 20).forEach(t => console.log(`  "${t.text}" -> ${t.w}x${t.h}`));

  console.log('\n=== OVERFLOW CHECK ===');
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth);
  console.log(`Horizontal overflow: ${overflow}`);

  console.log('\n=== FONT SIZE AUDIT ===');
  const smallFonts = await page.evaluate(() => {
    const results = [];
    document.querySelectorAll('*').forEach(el => {
      const s = parseFloat(getComputedStyle(el).fontSize);
      if (s < 12 && el.textContent?.trim()) results.push({ tag: el.tagName, text: el.textContent.trim().slice(0, 30), size: s });
    });
    return results.slice(0, 20);
  });
  console.log(`Small fonts: ${smallFonts.length}`);
  smallFonts.forEach(f => console.log(`  <${f.tag}> "${f.text}" @ ${f.size}px`));

  console.log('\n=== DONE ===');
  await browser.close();
}

main().catch(e => { console.error('FATAL:', e); process.exit(1); });
