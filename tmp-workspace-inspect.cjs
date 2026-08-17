(async () => {
  const { chromium } = require('playwright');
  const ctx = await chromium.launchPersistentContext('.codex-browser-profile-mobile2', {
    headless: true,
    viewport: { width: 390, height: 844 },
    args: ['--disable-gpu', '--no-sandbox']
  });
  const page = ctx.pages()[0] || await ctx.newPage();

  await page.goto('http://localhost:3000/login', { waitUntil: 'domcontentloaded', timeout: 20000 });
  await page.getByPlaceholder('Username').fill('admin');
  await page.getByPlaceholder('Password').fill('admin123');
  await page.getByRole('button', { name: 'Sign In' }).click();
  await page.waitForURL('**/chat', { timeout: 20000 });

  await page.goto('http://localhost:3000/workspace', { waitUntil: 'networkidle', timeout: 20000 });
  await page.waitForTimeout(1500);

  const metrics = await page.evaluate(() => {
    const main = document.querySelector('main');
    const scroll = main?.querySelector('[data-slot="scroll-area-viewport"]') || main?.querySelector('.flex-1.p-6')?.closest('[data-slot="scroll-area-viewport"]') || main?.querySelector('[class*="flex-1 p-6"]')?.parentElement;
    const dock = document.querySelector('nav[data-dock="true"]');
    const topToolbar = main?.querySelector('.h-\\[48px\\]');
    const fileListWrap = main?.querySelector('.flex-1.p-6')?.parentElement;

    function rect(el) {
      if (!el) return null;
      const r = el.getBoundingClientRect();
      const s = getComputedStyle(el);
      return { left:r.left, top:r.top, right:r.right, bottom:r.bottom, width:r.width, height:r.height, overflow:s.overflow, overflowY:s.overflowY, display:s.display, visibility:s.visibility, opacity:s.opacity };
    }

    const mainRect = rect(main);
    const scrollRect = rect(scroll);
    const fileListWrapRect = rect(fileListWrap);
    const dockRect = rect(dock);

    const visibleEls = Array.from(document.querySelectorAll('main,section,div'))
      .filter(el => { const r = el.getBoundingClientRect(); const s = getComputedStyle(el); return r.width>0 && r.height>0 && s.display!=='none' && s.visibility!=='hidden'; })
      .slice(0,30)
      .map(el => ({ tag:el.tagName, cls:(el.className||'').toString().slice(0,180), text:(el.innerText||'').slice(0,160), rect:rect(el) }));

    return { mainRect, scrollRect, fileListWrapRect, dockRect, viewport:{w:window.innerWidth,h:window.innerHeight}, visibleEls };
  });

  await page.screenshot({ path:'D:/项目/Palink-AI/test-screenshots/mobile-workspace-metrics.png', fullPage:true });
  console.log(JSON.stringify(metrics));
  await ctx.close();
})();
