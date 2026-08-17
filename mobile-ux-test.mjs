import { chromium } from 'playwright';
import { mkdirSync, existsSync, writeFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DIR = join(__dirname, 'test-screenshots');
if (!existsSync(DIR)) mkdirSync(DIR, { recursive: true });
const BASE = 'http://localhost:3000';

const browser = await chromium.launch({ headless: true, args: ['--disable-gpu'] });
const context = await browser.newContext({
  viewport: { width: 390, height: 844 },
  userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 16_0 like Mac OS X) AppleWebKit/605.1.15',
  isMobile: true, hasTouch: true, deviceScaleFactor: 2,
});
const page = await context.newPage();
const consoleErrors = [];
const jsErrors = [];
page.on('console', m => { if (m.type() === 'error') consoleErrors.push(m.text()); });
page.on('pageerror', e => jsErrors.push(e.message));
const report = [];
function log(msg) { report.push(msg); console.log(msg); }

log('=== Mobile UX Test (iPhone 14 Pro) ===\n');

// 1. Login page visual
log('[1] Login page...');
await page.goto(BASE + '/#/login', { waitUntil: 'networkidle', timeout: 15000 });
await page.waitForTimeout(1000);
await page.screenshot({ path: join(DIR, '01-login.png'), fullPage: true });
const vp = await page.evaluate(() => document.querySelector('meta[name="viewport"]')?.getAttribute('content') || 'MISSING');
log('  Viewport: ' + vp);

// 2. Inject fake token to bypass login
log('\n[2] Injecting auth token...');
await page.evaluate(() => {
  localStorage.setItem('palink_token', 'fake-dev-token');
  localStorage.setItem('palink_user', JSON.stringify({ username: 'admin', avatar: '', role: 'admin' }));
});
await page.goto(BASE + '/#/chat', { waitUntil: 'networkidle', timeout: 15000 });
await page.waitForTimeout(2000);
await page.screenshot({ path: join(DIR, '02-chat.png'), fullPage: true });
const chatUrl = page.url();
log('  URL after inject: ' + chatUrl);

// If still redirected to login, the API validation blocks us.
// Let's try with developer mode - just check what we can see on the rendered page
const bodyText = await page.evaluate(() => document.body.innerText?.substring(0, 300) || '');
log('  Body: ' + bodyText.substring(0, 200));

// 3. Check all pages regardless of auth
const pages = ['chat', 'settings', 'workspace', 'characters'];
for (const pg of pages) {
  log('\n[3.' + pages.indexOf(pg) + '] /#/' + pg);
  await page.goto(BASE + '/#/' + pg, { waitUntil: 'networkidle', timeout: 10000 });
  await page.waitForTimeout(1500);
  await page.screenshot({ path: join(DIR, '03-' + pg + '.png'), fullPage: true });
  
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth);
  log('  H-overflow: ' + (overflow ? 'YES!' : 'NO'));
  
  const smallTargets = await page.evaluate(() => {
    const r = [];
    document.querySelectorAll('button, a, [role="button"]').forEach(el => {
      const b = el.getBoundingClientRect();
      if (b.width > 0 && b.height > 0 && (b.width < 44 || b.height < 44)) {
        r.push({ t: (el.textContent||'').trim().substring(0,30), w: Math.round(b.width), h: Math.round(b.height) });
      }
    });
    return r;
  });
  if (smallTargets.length) {
    log('  Small targets (<44px): ' + smallTargets.length);
    smallTargets.slice(0,5).forEach(s => log('    "' + s.t + '" ' + s.w + 'x' + s.h));
  }
  
  // Font audit
  const smallFonts = await page.evaluate(() => {
    const r = [];
    document.querySelectorAll('*').forEach(el => {
      const s = parseFloat(getComputedStyle(el).fontSize);
      const t = el.textContent?.trim();
      if (t && t.length > 0 && s < 12 && el.children.length === 0) r.push({ t: t.substring(0,30), s });
    });
    return r;
  });
  if (smallFonts.length) {
    log('  Small fonts (<12px): ' + smallFonts.length);
    smallFonts.slice(0,3).forEach(f => log('    "' + f.t + '" ' + f.s + 'px'));
  }
}

// 4. Bottom nav check
log('\n[4] Bottom nav...');
await page.goto(BASE + '/#/chat', { waitUntil: 'networkidle', timeout: 10000 });
await page.waitForTimeout(1000);
const nav = await page.evaluate(() => {
  const el = document.querySelector('nav[data-dock="true"]');
  if (!el) return null;
  const r = el.getBoundingClientRect();
  const items = el.querySelectorAll('a');
  return { h: Math.round(r.height), items: Array.from(items).map(i => ({
    t: (i.textContent||'').trim().substring(0,15), h: Math.round(i.getBoundingClientRect().height)
  })) };
});
if (nav) {
  log('  Nav height: ' + nav.h + 'px');
  nav.items.forEach(i => log('    "' + i.t + '" h=' + i.h + (i.h < 44 ? ' SMALL!' : '')));
} else {
  log('  Bottom nav NOT FOUND');
}

// 5. Touch target audit on login
log('\n[5] Login touch targets...');
await page.goto(BASE + '/#/login', { waitUntil: 'networkidle', timeout: 10000 });
await page.waitForTimeout(500);
const loginTargets = await page.evaluate(() => {
  const r = [];
  document.querySelectorAll('button, a, input').forEach(el => {
    const b = el.getBoundingClientRect();
    if (b.width > 0 && b.height > 0) {
      r.push({ t: el.tagName + ' ' + (el.textContent||el.placeholder||'').trim().substring(0,30), w: Math.round(b.width), h: Math.round(b.height), small: b.width < 44 || b.height < 44 });
    }
  });
  return r;
});
loginTargets.forEach(t => log('  ' + (t.small ? 'SMALL' : 'OK') + ' ' + t.t + ' ' + t.w + 'x' + t.h));

// Summary
log('\n=== Errors ===');
log('Console: ' + consoleErrors.length);
consoleErrors.slice(0,5).forEach(e => log('  ' + e.substring(0,120)));
log('JS: ' + jsErrors.length);
jsErrors.slice(0,5).forEach(e => log('  ' + e.substring(0,120)));

await browser.close();
log('\nDone! Screenshots in test-screenshots/');
writeFileSync(join(DIR, 'report.txt'), report.join('\n'), 'utf-8');
