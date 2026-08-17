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

  await page.evaluate(() => {
    const exp = Date.now() - 60 * 1000;
    localStorage.setItem('palink_token', 'stale-token');
    localStorage.setItem('palink_token_exp', String(exp));
  });

  await page.goto('http://localhost:3000/workspace', { waitUntil: 'networkidle', timeout: 20000 });
  await page.waitForTimeout(1500);

  const res = await page.evaluate(async () => {
    const lsToken = localStorage.getItem('palink_token');
    const r = await fetch('/api/workspace?parent_id=');
    let body = null;
    try { body = await r.json(); } catch {}
    return { lsToken, workspaceStatus: r.status, body };
  });

  console.log(JSON.stringify(res));
  await ctx.close();
})();
