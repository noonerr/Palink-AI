(async () => {
  const { chromium } = require('playwright');
  const ctx = await chromium.launchPersistentContext('.codex-browser-profile-mobile2', {
    headless: true,
    viewport: { width: 390, height: 844 },
    args: ['--disable-gpu', '--no-sandbox']
  });
  const page = ctx.pages()[0] || await ctx.newPage();
  const out = {};

  await page.goto('http://localhost:3000/login', { waitUntil: 'domcontentloaded', timeout: 20000 });
  await page.getByPlaceholder('Username').fill('admin');
  await page.getByPlaceholder('Password').fill('admin123');
  await page.getByRole('button', { name: 'Sign In' }).click();
  await page.waitForURL('**/chat', { timeout: 20000 });

  await page.goto('http://localhost:3000/workspace', { waitUntil: 'networkidle', timeout: 20000 });
  await page.waitForTimeout(1200);
  out.workspace = await page.evaluate(() => ({
    bodyText: document.body.innerText.slice(0, 800),
    dockRect: document.querySelector('nav[data-dock="true"]')?.getBoundingClientRect(),
    viewportRect: document.querySelector('[data-slot="scroll-area-viewport"]')?.getBoundingClientRect()
  }));

  await page.goto('http://localhost:3000/characters', { waitUntil: 'networkidle', timeout: 20000 });
  await page.waitForTimeout(1200);
  out.characters = await page.evaluate(() => ({
    bodyText: document.body.innerText.slice(0, 800),
    dockRect: document.querySelector('nav[data-dock="true"]')?.getBoundingClientRect()
  }));

  await page.goto('http://localhost:3000/chat', { waitUntil: 'networkidle', timeout: 20000 });
  await page.waitForTimeout(1200);

  await page.locator('textarea').first().fill(Array.from({length:12}, (_,i)=>'Mobile long message test line '+(i+1)).join('\n'));
  await page.waitForTimeout(500);
  out.inputSizes = await page.evaluate(() => {
    const t = document.querySelector('textarea');
    return t ? { offsetH: t.offsetHeight, scrollH: t.scrollHeight } : null;
  });

  await page.evaluate(() => {
    window.__origFetch = window.fetch;
    window.fetch = async (...args) => {
      if (String(args[0]).includes('/api/chat')) {
        const long = Array.from({length:40}, (_,i)=>'AI line '+(i+1)+' '+ 'x'.repeat(40)).join('\n') + '\n\n```js\nconsole.log(Array.from({length:80}, (_,i)=>i).join("-"))\n```';
        return new Response(new ReadableStream({
          start(controller) {
            const enc = s => controller.enqueue(new TextEncoder().encode(s));
            enc('data: {"message":' + JSON.stringify(long) + '}\n\n');
            setTimeout(() => { enc('data: [DONE]\n\n'); controller.close(); }, 600);
          }
        }), { status:200, headers:{'content-type':'text/event-stream'}});
      }
      return window.__origFetch(...args);
    };
  });

  await page.locator('button').filter({ has: page.locator('svg') }).last().click();
  await page.waitForTimeout(2500);
  out.aiRender = await page.evaluate(() => {
    const pres = Array.from(document.querySelectorAll('pre'));
    return {
      preCount: pres.length,
      preOverflow: pres.map(el => ({ scrollW: el.scrollWidth, clientW: el.clientWidth, overflow: el.scrollWidth > el.clientWidth }))
    };
  });

  await page.getByRole('button', { name: /历史|History|toggle-history/i }).first().click({ timeout: 10000 }).catch(async () => {
    await page.evaluate(() => {
      const btn = Array.from(document.querySelectorAll('button')).find(b => /toggle-history/i.test(b.getAttribute('aria-label')||'') || /历史记录|History/i.test(b.textContent||''));
      if (btn) btn.click();
    });
  });
  await page.waitForTimeout(800);
  out.historyDrawer = await page.evaluate(() => ({
    sheet: !!document.querySelector('[data-slot="sheet-content"]'),
    openState: !!document.querySelector('[data-state="open"]'),
    bodyText: document.body.innerText.slice(0, 600)
  }));

  await page.screenshot({ path:'D:/项目/Palink-AI/test-screenshots/mobile-ux-verify2.png', fullPage:true });
  console.log(JSON.stringify(out));
  await ctx.close();
})();
