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
  out.workspace = await page.evaluate(() => {
    const dock = document.querySelector('nav[data-dock="true"]');
    const toolbar = document.querySelector('.h-\\[48px\\]');
    const fileWrap = document.querySelector('[data-slot="scroll-area-viewport"]');
    return {
      bodyText: document.body.innerText.slice(0, 1000),
      dockRect: dock?.getBoundingClientRect(),
      toolbarRect: toolbar?.getBoundingClientRect(),
      fileViewportRect: fileWrap?.getBoundingClientRect(),
    };
  });

  await page.goto('http://localhost:3000/characters', { waitUntil: 'networkidle', timeout: 20000 });
  await page.waitForTimeout(1200);
  out.characters = await page.evaluate(() => ({
    bodyText: document.body.innerText.slice(0, 1000),
    dockRect: document.querySelector('nav[data-dock="true"]')?.getBoundingClientRect(),
  }));

  await page.goto('http://localhost:3000/chat', { waitUntil: 'networkidle', timeout: 20000 });
  await page.waitForTimeout(1200);

  const ta = page.locator('textarea').first();
  await ta.fill(Array.from({length:12}, (_,i)=>'Mobile long message test line '+(i+1)).join('\n'));
  await page.waitForTimeout(500);
  out.inputSizes = await page.evaluate(() => {
    const ta = document.querySelector('textarea');
    return ta ? { offsetH: ta.offsetHeight, scrollH: ta.scrollHeight } : null;
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

  const sendBtn = page.locator('button').filter({ has: page.locator('svg') }).last();
  await sendBtn.click();
  await page.waitForTimeout(2500);
  out.aiRender = await page.evaluate(() => {
    const pres = Array.from(document.querySelectorAll('pre'));
    const codes = Array.from(document.querySelectorAll('code'));
    const containers = Array.from(document.querySelectorAll('[class*="overflow"]'));
    return {
      preCount: pres.length,
      preOverflow: pres.map(el => ({ scrollW: el.scrollWidth, clientW: el.clientWidth, overflow: el.scrollWidth > el.clientWidth, cls: el.className?.slice(0,120) })),
      codeCount: codes.length,
      containerOverflowSample: containers.slice(0,20).map(el => ({ scrollW: el.scrollWidth, clientW: el.clientWidth, overflow: el.scrollWidth > el.clientWidth, cls: (el.className||'').toString().slice(0,120) }))
    };
  });

  const historyBtn = page.locator('button').filter({ has: page.locator('svg') }).nth(0);
  await historyBtn.click();
  await page.waitForTimeout(800);
  out.historyDrawer = await page.evaluate(() => {
    const overlay = document.querySelector('[data-state="open"], [class*="fixed inset-0"]');
    const sheet = document.querySelector('[data-slot="sheet-content"], [data-state="open"][data-slot="sheet-content"]');
    return {
      overlayExists: !!overlay,
      sheetExists: !!sheet,
      bodyText: document.body.innerText.slice(0, 800)
    };
  });

  await page.screenshot({ path:'D:/项目/Palink-AI/test-screenshots/mobile-ux-verify.png', fullPage:true });
  console.log(JSON.stringify(out));
  await ctx.close();
})();
