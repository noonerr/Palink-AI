(async () => {
  const { chromium } = require('playwright');
  const ctx = await chromium.launchPersistentContext('.codex-browser-profile-mobile2', {
    headless: true,
    viewport: { width: 390, height: 844 },
    args: ['--disable-gpu','--no-sandbox']
  });
  const page = ctx.pages()[0] || await ctx.newPage();

  await page.goto('http://localhost:3000/login', { waitUntil:'domcontentloaded', timeout:20000 });
  await page.getByPlaceholder('Username').fill('admin');
  await page.getByPlaceholder('Password').fill('admin123');
  await page.getByRole('button',{name:'Sign In'}).click();
  await page.waitForURL('**/chat',{timeout:20000});
  await page.waitForTimeout(1200);

  await page.evaluate(() => {
    window.__origFetch = window.fetch;
    window.fetch = async (...args) => {
      if (String(args[0]).includes('/api/chat')) {
        const long = Array.from({length:40}, (_,i)=>'AI line '+(i+1)+' '+ 'x'.repeat(60)).join('\n') + '\n\n```js\nconsole.log(Array.from({length:120}, (_,i)=>i).join("-"))\n```';
        return new Response(new ReadableStream({
          start(controller) {
            const enc = s => controller.enqueue(new TextEncoder().encode(s));
            enc('data: {"message":' + JSON.stringify(long) + '}\n\n');
            setTimeout(()=>{ enc('data: [DONE]\n\n'); controller.close(); }, 600);
          }
        }), {status:200, headers:{'content-type':'text/event-stream'}});
      }
      return window.__origFetch(...args);
    };
  });

  await page.locator('textarea').first().fill('Mobile overflow test');
  await page.locator('button').filter({ has: page.locator('svg') }).last().click();
  await page.waitForTimeout(2500);

  const res = await page.evaluate(() => {
    const pres = Array.from(document.querySelectorAll('pre'));
    return {
      preCount: pres.length,
      preOverflow: pres.map(el => ({scrollW:el.scrollWidth, clientW:el.clientWidth, overflow:el.scrollWidth>el.clientWidth, cls:(el.className||'').toString().slice(0,120)}))
    };
  });
  await page.screenshot({path:'D:/项目/Palink-AI/test-screenshots/mobile-code-overflow2.png', fullPage:true});
  console.log(JSON.stringify(res));
  await ctx.close();
})();
