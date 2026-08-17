(async () => {
  const { chromium } = require('playwright');
  const ctx = await chromium.launchPersistentContext('.codex-browser-profile-mobile2', {
    headless: true,
    viewport: { width: 390, height: 844 },
    args: ['--disable-gpu', '--no-sandbox']
  });
  const page = ctx.pages()[0] || await ctx.newPage();
  const out = [];
  const snap = async (name) => {
    await page.screenshot({ path: 'D:/项目/Palink-AI/test-screenshots/mobile-' + name + '.png', fullPage: true });
    out.push(name);
  };

  await page.goto('http://localhost:3000/login', { waitUntil: 'domcontentloaded', timeout: 20000 });
  await page.waitForTimeout(600);
  await page.getByPlaceholder('Username').fill('admin');
  await page.getByPlaceholder('Password').fill('admin123');
  await page.getByRole('button', { name: 'Sign In' }).click();
  await page.waitForURL('**/chat', { timeout: 20000 });
  await page.waitForTimeout(1000);

  await page.goto('http://localhost:3000/workspace', { waitUntil: 'networkidle', timeout: 20000 });
  await page.waitForTimeout(1500);
  await snap('workspace-authed');
  const workVis = await page.evaluate(() => {
    return Array.from(document.querySelectorAll('main,section,div')).filter(el => {
      const r = el.getBoundingClientRect();
      const s = getComputedStyle(el);
      return r.width > 0 && r.height > 0 && s.display !== 'none' && s.visibility !== 'hidden';
    }).slice(0, 20).map(el => ({
      tag: el.tagName,
      cls: (el.className || '').toString().slice(0, 160),
      text: (el.innerText || '').slice(0, 200)
    }));
  });

  await page.goto('http://localhost:3000/characters', { waitUntil: 'networkidle', timeout: 20000 });
  await page.waitForTimeout(1500);
  await snap('characters');
  const charVis = await page.evaluate(() => {
    return Array.from(document.querySelectorAll('main,section,div')).filter(el => {
      const r = el.getBoundingClientRect();
      const s = getComputedStyle(el);
      return r.width > 0 && r.height > 0 && s.display !== 'none' && s.visibility !== 'hidden';
    }).slice(0, 20).map(el => ({
      tag: el.tagName,
      cls: (el.className || '').toString().slice(0, 160),
      text: (el.innerText || '').slice(0, 200)
    }));
  });

  await page.goto('http://localhost:3000/chat', { waitUntil: 'networkidle', timeout: 20000 });
  await page.waitForTimeout(1200);
  const textarea = page.getByPlaceholder(/Type a message|输入消息/);
  await textarea.fill(Array.from({ length: 20 }, (_, i) => 'This is a long mobile input line ' + (i + 1)).join('\n'));
  await page.waitForTimeout(500);
  await snap('chat-longinput');
  const inputSizes = await page.evaluate(() => {
    const ta = document.querySelector('textarea');
    if (!ta) return null;
    return { offsetH: ta.offsetHeight, scrollH: ta.scrollHeight, valueLen: ta.value.length };
  });

  await page.evaluate(() => {
    window.__originalFetch = window.fetch;
    window.fetch = async (...args) => {
      if (String(args[0]).includes('/api/chat')) {
        return new Response(new ReadableStream({
          start(controller) {
            const enc = (s) => controller.enqueue(new TextEncoder().encode(s));
            enc('data: {"message":"Mock mobile AI response: line1\\n\\n- point 1\\n- point 2\\n```javascript\\nconsole.log(\\"mobile long code block test\\")\\nconst x = Array.from({length:120}, (_, i) => i).join(\\"-\\")\\n```\\n\\nDone."}\n\n');
            setTimeout(() => {
              enc('data: [DONE]\n\n');
              controller.close();
            }, 800);
          }
        }), { status: 200, headers: { 'content-type': 'text/event-stream' } });
      }
      return window.__originalFetch(...args);
    };
  });

  const sendBtn = page.locator('button').filter({ has: page.locator('svg') }).last();
  await sendBtn.click();
  await page.waitForTimeout(2500);
  await snap('chat-ai-longreply');
  const chatOverflow = await page.evaluate(() => {
    const msgs = document.querySelectorAll('[class*="message"], [class*="Message"], [class*="chat"] pre, [class*="chat"] code, pre, code');
    return Array.from(msgs).slice(0, 20).map(el => ({
      scrollW: el.scrollWidth,
      clientW: el.clientWidth,
      overflow: el.scrollWidth > el.clientWidth
    }));
  });

  console.log(JSON.stringify({ workVis, charVis, inputSizes, chatOverflow, out }));
  await ctx.close();
})();
