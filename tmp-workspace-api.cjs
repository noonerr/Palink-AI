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
  await page.waitForTimeout(1200);

  const res = await page.evaluate(async () => {
    const token = localStorage.getItem('palink_token');
    let apiJson = null;
    let apiStatus = null;
    try {
      const r = await fetch('/api/workspace?parent_id=');
      apiStatus = r.status;
      apiJson = await r.json();
    } catch (e) {
      apiJson = { error: String(e) };
    }

    const visibleText = document.body.innerText.slice(0, 2000);
    const innerHtml = document.querySelector('main')?.innerHTML?.slice(0, 12000) || '';
    return { tokenExists: !!token, apiStatus, apiJson, visibleText, innerHtml };
  });

  await page.screenshot({ path:'D:/项目/Palink-AI/test-screenshots/mobile-workspace-api.png', fullPage:true });
  console.log(JSON.stringify(res));
  await ctx.close();
})();
