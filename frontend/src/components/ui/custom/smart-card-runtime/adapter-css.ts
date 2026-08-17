// AUTO-SPLIT from helpers.ts (P1-b, 逻辑未改动)
import { smartCardAdapterStyleCache } from './shared';
import DOMPurify from 'dompurify';
import { collectInlineStyles, findMatchingBrace, getSmartCardCacheValue, hashSmartCardSource, sanitizeCss, scopeSelector, setSmartCardCacheValue } from './primitives';
import { removeFullDocumentShell } from './html-extract';

export function buildSmartCardAdapterStyle(html: string): string {
  const candidate = String(html || '');
  const cacheKey = hashSmartCardSource(candidate);
  const cached = getSmartCardCacheValue(smartCardAdapterStyleCache, cacheKey);
  if (cached !== undefined) return cached;

  const rules: string[] = [`
:root{
  --palink-viewport-width:100vw;
  --palink-viewport-height:100vh;
  --palink-visual-viewport-width:100vw;
  --palink-visual-viewport-height:100vh;
  --palink-safe-top:0px;
  --palink-safe-bottom:env(safe-area-inset-bottom, 0px);
  --palink-composer-height:0px;
  --palink-available-height:100vh;
  --palink-viewport-offset-top:0px;
  --palink-viewport-offset-left:0px;
  --palink-viewport-scale:1;
}
html[data-palink-immersive="true"],html[data-palink-immersive="true"] body{
  width:100%!important;
  min-height:var(--palink-available-height,100vh)!important;
}
`];

  if (/id=(["'])main-wrapper\1/i.test(candidate) && /id=(["'])dashboard\1/i.test(candidate)) {
    rules.push(`
html,body{width:100%!important;height:100%!important;min-height:0!important;margin:0!important;padding:0!important;overflow:hidden!important;}
body{display:block!important;align-items:stretch!important;justify-content:flex-start!important;}
#main-wrapper{width:100%!important;max-width:none!important;height:var(--palink-available-height,100%)!important;min-height:0!important;border-radius:0!important;}
@media (max-width:640px){
  #dashboard{padding:10px!important;gap:4px!important;}
  #dashboard::before{width:min(74vw,340px)!important;height:min(74vw,340px)!important;}
  #dashboard::after{width:min(40vw,180px)!important;height:min(40vw,180px)!important;}
  .item-container{width:46%!important;gap:6px!important;}
  .item-label{font-size:0.95em!important;}
}
`);
  }

  if (/\bmg-launcher\b/i.test(candidate) || /\bmg-wrapper-reset\b/i.test(candidate)) {
    rules.push(`
html,body{width:100%!important;height:100%!important;min-height:0!important;margin:0!important;padding:0!important;overflow:hidden!important;background:transparent!important;}
body{display:block!important;}
.mg-wrapper-reset{width:100%!important;height:100%!important;display:block!important;min-height:0!important;}
.mg-launcher{width:100%!important;max-width:none!important;height:var(--palink-available-height,100%)!important;min-height:0!important;max-height:none!important;aspect-ratio:auto!important;border-radius:0!important;}
@media (max-width:768px){
  .mg-launcher{height:var(--palink-available-height,100%)!important;min-height:0!important;max-height:none!important;border-radius:0!important;}
  .mg-title-box{padding:32px 24px!important;max-width:92%!important;}
  .mg-form-box{
    width:calc(100% - 28px)!important;
    max-width:none!important;
    max-height:calc(100% - 28px)!important;
    padding:16px!important;
    overflow-y:auto!important;
  }
  .mg-form-content{gap:8px!important;margin-top:8px!important;}
  .mg-input-group{gap:4px!important;}
  .mg-input-group label{font-size:0.8rem!important;}
  .mg-input-group input,.mg-input-group textarea{padding:8px 10px!important;font-size:0.86rem!important;}
  .mg-input-group textarea{min-height:56px!important;max-height:92px!important;}
  .mg-btn-high{margin-top:10px!important;padding:10px 0!important;font-size:0.95rem!important;letter-spacing:1.5px!important;}
  .mg-card{width:min(66vw,240px)!important;height:min(92vw,360px)!important;}
}
`);
  }

  return setSmartCardCacheValue(
    smartCardAdapterStyleCache,
    cacheKey,
    `<style data-palink-smart-card-adapter>${rules.join('\n')}</style>`,
  );
}


export function scopeCss(css: string, scopeSelectorText: string): string {
  const safeCss = sanitizeCss(css);
  let result = '';
  let cursor = 0;

  while (cursor < safeCss.length) {
    const openIndex = safeCss.indexOf('{', cursor);
    if (openIndex === -1) {
      result += safeCss.slice(cursor);
      break;
    }

    const selectorText = safeCss.slice(cursor, openIndex).trim();
    const closeIndex = findMatchingBrace(safeCss, openIndex);
    if (closeIndex === -1) {
      result += safeCss.slice(cursor);
      break;
    }

    const body = safeCss.slice(openIndex + 1, closeIndex);
    if (!selectorText) {
      result += safeCss.slice(cursor, closeIndex + 1);
    } else if (/^@(?:media|supports|container|layer)\b/i.test(selectorText)) {
      result += `${selectorText}{${scopeCss(body, scopeSelectorText)}}`;
    } else if (/^@/i.test(selectorText)) {
      result += `${selectorText}{${body}}`;
    } else {
      const selectors = selectorText
        .split(',')
        .map((selector) => scopeSelector(selector, scopeSelectorText))
        .filter(Boolean)
        .join(', ');
      result += selectors ? `${selectors}{${body}}` : `${selectorText}{${body}}`;
    }

    cursor = closeIndex + 1;
  }

  return result;
}


export function prepareInlineHtml(html: string, scopeSelectorText: string, customCss?: string): string {
  const styles: string[] = [];
  collectInlineStyles(html).forEach((css) => {
    styles.push(scopeCss(css, scopeSelectorText));
  });

  const body = removeFullDocumentShell(html).replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, '');

  if (customCss) {
    styles.push(scopeCss(customCss, scopeSelectorText));
  }

  const styleBlock = styles.length > 0 ? `<style>${styles.join('\n')}</style>` : '';
  return DOMPurify.sanitize(`${styleBlock}${body}`, {
    ADD_TAGS: [
      'style', 'div', 'span', 'font', 'center', 'marquee', 'hr', 'br', 'details', 'summary',
      'img', 'picture', 'source', 'table', 'thead', 'tbody', 'tfoot', 'tr', 'th', 'td',
      'button', 'input', 'select', 'option', 'textarea', 'label', 'section', 'main', 'article',
      'aside', 'nav', 'header', 'footer', 'figure', 'figcaption', 'progress', 'meter',
      'svg', 'path', 'circle', 'rect', 'line', 'polyline', 'polygon', 'g', 'defs', 'use',
    ],
    ADD_ATTR: [
      'id', 'class', 'style', 'color', 'bgcolor', 'align', 'valign', 'data-*', 'role',
      'aria-*', 'tabindex', 'title', 'href', 'src', 'srcset', 'alt', 'target', 'rel',
      'width', 'height', 'viewBox', 'fill', 'stroke', 'stroke-width', 'd', 'points',
      'type', 'value', 'name', 'placeholder', 'disabled', 'readonly', 'checked',
      'selected', 'multiple', 'cols', 'rows', 'wrap', 'maxlength', 'min', 'max', 'step',
      'optimum', 'open',
    ],
    // R-5 修复: FORBID_TAGS 移除 form——内联渲染的角色卡表单此前被 DOMPurify 删除
    // （ST 兼容要求表单可用）。form 本身不引入脚本执行面（script/iframe/object/
    // embed/base 仍禁用）；表单元素依赖的 input/select/textarea/button 已在 ADD_TAGS。
    FORBID_TAGS: ['script', 'iframe', 'object', 'embed', 'base'],
  });
}

