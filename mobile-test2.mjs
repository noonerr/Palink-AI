import { chromium } from 'playwright';
import { mkdirSync, existsSync } from 'fs';
import { join } from 'path';

const SS = 'D:\\项目\\Palink-AI\\test-screenshots';
if (!existsSync(SS)) mkdirSync(SS, { recursive: true });
const ss = n => join(SS, n);

const U = { id:1, username:'admin', email:'admin@palink.local', role:'admin', avatar_url:'' };
const M = [{ id:'gpt-4o', name:'GPT-4o', context_length:128000, provider:'openai' }];
const S = { developer_mode:true, memory_mode:'rule', default_chat_model:'gpt-4o' };
const SESS = [{ id:'s1', title:'测试对话', type:'chat', created_at:new Date().toISOString(), updated_at:new Date().toISOString() }];
const MSGS = [
  { id:'m1', role:'user', content:'你好', model:null, created_at:new Date().toISOString() },
  { id:'m2', role:'assistant', content:'你好！我是 Palink AI 助手。我可以帮助你完成各种任务。这段回复足够长用来测试滚动行为。', model:'gpt-4o', created_at:new Date().toISOString() },
];

const browser = await chromium.launch({ headless: true });
const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X)' });
const page = await ctx.newPage();

await page.addInitScript(() => {
  localStorage.setItem('palink_token', 'mock-token');
  localStorage.setItem('palink_user_snapshot', JSON.stringify({ id:1, username:'admin', email:'admin@palink.local', role:'admin', avatar_url:'' }));
});

const ok = d => ({ status:200, contentType:'application/json', body:JSON.stringify(d) });
await page.route('**/api/**', async route => {
  const u = new URL(route.request().url()), p = u.pathname, m = route.request().method();
  if (p==='/api/users/me'&&m==='GET') return route.fulfill(ok(U));
  if (p==='/api/users/me/settings'&&m==='GET') return route.fulfill(ok(S));
  if (p==='/api/users/me/settings'&&m==='PUT') return route.fulfill(ok({ok:true}));
  if (p==='/api/models') return route.fulfill(ok(M));
  if (p==='/api/admin/providers') return route.fulfill(ok([]));
  if (p==='/api/admin/system/defaults') return route.fulfill(ok({default_chat_model:'gpt-4o'}));
  if (p==='/api/admin/web-search') return route.fulfill(ok({enabled:false}));
  if (p==='/api/sessions'&&m==='GET') return route.fulfill(ok(SESS));
  if (p==='/api/sessions'&&m==='POST') return route.fulfill(ok({id:'s-new',title:'新对话',type:'chat'}));
  if (p.match(/sessions\/[^/]+$/)&&m==='DELETE') return route.fulfill(ok({ok:true}));
  if (p==='/api/sessions/batch') return route.fulfill(ok({ok:true}));
  if (p.match(/sessions\/[^/]+\/messages$/)&&m==='GET') return route.fulfill(ok(MSGS));
  if (p.match(/sessions\/[^/]+\/messages$/)&&m==='POST') return route.fulfill(ok({id:'m-new',ok:true}));
  if (p.match(/messages\/[^/]+$/)&&(m==='DELETE'||m==='PUT')) return route.fulfill(ok({ok:true}));
  if (p.includes('memory')&&p.includes('stats')) return route.fulfill(ok({total_memories:42,categories:{}}));
  if (p.includes('stream')||p.includes('chat/completions')) {
    const words = ['这','是','模拟','AI','回复','。','移动端','测试','流式','输出','正常','滚动','显示','。','再','多加','一些','内容','来','确保','它','能','滚动','起来','。','第','三','段','文字','继续','增加','长度','。'];
    let sse = '';
    for (const w of words) sse += 'data: ' + JSON.stringify({choices:[{delta:{content:w}}]}) + '\n\n';
    sse += 'data: [DONE]\n\n';
    return route.fulfill({status:200,contentType:'text/event-stream',headers:{'Cache-Control':'no-cache'},body:sse});
  }
  return route.fulfill(ok({}));
});

await page.goto('http://localhost:3000', { waitUntil:'networkidle', timeout:15000 });
await page.waitForTimeout(3000);

// 1. Welcome
console.log('=== 1. Welcome page ===');
await page.screenshot({ path: ss('final-01-welcome.png') });

// 2. Touch targets
console.log('=== 2. Touch targets ===');
const targets = await page.evaluate(() => {
  return Array.from(document.querySelectorAll('button, a, [role="button"]')).map(el => {
    const r = el.getBoundingClientRect();
    return { text: (el.textContent||'').trim().slice(0,25), w: Math.round(r.width), h: Math.round(r.height) };
  }).filter(t => t.w > 0);
});
let smallCount = 0;
targets.forEach(t => {
  const flag = (t.w < 44 || t.h < 44) ? ' [SMALL]' : '';
  if (flag) smallCount++;
  console.log(`  "${t.text}" ${t.w}x${t.h}${flag}`);
});
console.log(`Small targets: ${smallCount}/${targets.length}`);

// 3. Open sidebar & navigate to session
console.log('\n=== 3. Sidebar + session ===');
const triggers = await page.$$('[data-sidebar="trigger"]');
if (triggers.length > 0) {
  await triggers[0].click({ force: true });
  await page.waitForTimeout(1500);
  await page.screenshot({ path: ss('final-02-sidebar.png') });
  console.log('Sidebar opened');
  
  const sessLink = await page.$('text=测试对话');
  if (sessLink) {
    await sessLink.click({ force: true });
    await page.waitForTimeout(2000);
    await page.screenshot({ path: ss('final-03-chat-view.png') });
    console.log('Navigated to session');
  }
}

// 4. Input test
console.log('\n=== 4. Input ===');
const ta = await page.$('textarea');
if (ta) {
  await ta.click();
  await page.waitForTimeout(300);
  await ta.fill('移动端输入测试文本，比较长一些看看换行效果如何。');
  await page.waitForTimeout(300);
  await page.screenshot({ path: ss('final-04-input.png') });
  const box = await ta.boundingBox();
  console.log(`Input: ${Math.round(box.width)}x${Math.round(box.height)} at y=${Math.round(box.y)}`);
}

// 5. Send
console.log('\n=== 5. Send ===');
if (ta) {
  await ta.press('Enter');
  await page.waitForTimeout(5000);
  await page.screenshot({ path: ss('final-05-streamed.png') });
}

// 6. Settings
console.log('\n=== 6. Settings ===');
await page.evaluate(() => { window.location.hash = ''; });
await page.click('a[href="/settings"]', { force: true, timeout: 5000 }).catch(async () => {
  await page.goto('http://localhost:3000/settings', { waitUntil:'networkidle', timeout:10000 });
});
await page.waitForTimeout(2000);
await page.screenshot({ path: ss('final-06-settings.png') });

// 7. Workspace
console.log('\n=== 7. Workspace ===');
await page.click('a[href="/workspace"]', { force: true, timeout: 5000 }).catch(async () => {
  await page.goto('http://localhost:3000/workspace', { waitUntil:'networkidle', timeout:10000 });
});
await page.waitForTimeout(2000);
await page.screenshot({ path: ss('final-07-workspace.png') });

// 8. Characters
console.log('\n=== 8. Characters ===');
await page.click('a[href="/characters"]', { force: true, timeout: 5000 }).catch(async () => {
  await page.goto('http://localhost:3000/characters', { waitUntil:'networkidle', timeout:10000 });
});
await page.waitForTimeout(2000);
await page.screenshot({ path: ss('final-08-characters.png') });

// 9. Technical audit
console.log('\n=== 9. Technical Audit ===');

// Go back to chat for audit
await page.click('a[href="/chat"]', { force: true, timeout: 5000 }).catch(async () => {
  await page.goto('http://localhost:3000/chat', { waitUntil:'networkidle', timeout:10000 });
});
await page.waitForTimeout(2000);

const audit = await page.evaluate(() => {
  const results = { fonts: [], fixed: [], zIndex: [], overflow: {} };
  
  // Fonts
  document.querySelectorAll('*').forEach(el => {
    const s = parseFloat(getComputedStyle(el).fontSize);
    const t = el.textContent?.trim();
    if (s < 12 && t && el.children.length === 0) {
      results.fonts.push({ tag: el.tagName, cls: (el.className||'').toString().slice(0,50), text: t.slice(0,30), size: s });
    }
  });
  
  // Fixed
  document.querySelectorAll('*').forEach(el => {
    const s = getComputedStyle(el);
    if (s.position === 'fixed') {
      const r = el.getBoundingClientRect();
      if (r.width > 0) results.fixed.push({ tag: el.tagName, cls: (el.className||'').toString().slice(0,50), w: Math.round(r.width), h: Math.round(r.height), y: Math.round(r.y) });
    }
  });
  
  // Z-index
  document.querySelectorAll('*').forEach(el => {
    const z = parseInt(getComputedStyle(el).zIndex);
    if (z > 100) {
      const r = el.getBoundingClientRect();
      if (r.width > 0) results.zIndex.push({ tag: el.tagName, z, w: Math.round(r.width) });
    }
  });
  
  // Overflow
  results.overflow = {
    h: document.documentElement.scrollWidth > document.documentElement.clientWidth,
    v: document.documentElement.scrollHeight > document.documentElement.clientHeight,
    docW: document.documentElement.scrollWidth,
    clientW: document.documentElement.clientWidth,
  };
  
  return results;
});

console.log(`Fonts < 12px: ${audit.fonts.length}`);
audit.fonts.slice(0, 10).forEach(f => console.log(`  <${f.tag}> "${f.text}" @ ${f.size}px`));
console.log(`Fixed elements: ${audit.fixed.length}`);
audit.fixed.forEach(f => console.log(`  <${f.tag}.${f.cls}> ${f.w}x${f.h} at y=${f.y}`));
console.log(`Z-index > 100: ${audit.zIndex.length}`);
console.log(`Overflow: h=${audit.overflow.h} v=${audit.overflow.v} docW=${audit.overflow.docW} clientW=${audit.overflow.clientW}`);

console.log('\n=== DONE ===');
await browser.close();