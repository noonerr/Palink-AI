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

  const res = await page.evaluate(async () => {
    const lsToken = localStorage.getItem('palink_token');
    const sessionTokens = [];
    try {
      for (let i = 0; i < sessionStorage.length; i++) {
        const k = sessionStorage.key(i);
        if (k && k.toLowerCase().includes('token')) {
          sessionTokens.push({ key: k, val: sessionStorage.getItem(k)?.slice(0, 80) });
        }
      }
    } catch {}

    const headersFromApi = await fetch('/api/workspace?parent_id=', {
      headers: { Authorization: `Bearer ${lsToken}` }
    }).then(async r => ({ status: r.status, body: await r.json() }));

    return { lsTokenExists: !!lsToken, lsTokenLen: lsToken?.length || 0, sessionTokens, headersFromApi };
  });

  console.log(JSON.stringify(res));
  await ctx.close();
})();
