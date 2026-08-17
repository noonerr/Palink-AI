/**
 * 智能卡内联渲染的脚本重放。
 *
 * 为什么必须有这个模块（修正版 spec §4.2，原 spec 此处是事实性错误）：
 * HTML 规范明确规定，通过 innerHTML / dangerouslySetInnerHTML 插入的 <script>
 * 其 "already started" 标志为 true，**永远不会执行**。唯一可行路径是
 * document.createElement('script') 后插入 DOM，由浏览器同步执行。
 *
 * 本实现 1:1 对齐项目自己的 ST 侧实现 frontend/public/st/palink-smart-card.js
 * executeScriptsInElement()（L468-518），包括：
 *   - createElement('script') + parentNode.replaceChild(script, marker)   (L486/L494)
 *   - 每插入一个脚本后同步派发一次 palink-card-init                        (L500)
 *   - 全部插入完成后再补派发一次                                          (L514)
 *   - 单个脚本抛错不阻断后续脚本，仅移除该占位符                          (L505-508)
 * 用户决策 C5「完全对齐 ST 页面表现」：ST 不给每张卡包 IIFE，脚本共享
 * 主页面全局作用域，故此处同样不做任何包裹。多卡重名的 const/let 冲突由既有的
 * loosenSmartCardGlobalLexicalDeclarations(const→var) 兜底，与 iframe 路径一致。
 */

import { INLINE_CARD_INIT_EVENT, type InlineCardScript } from './inline-sanitize';
import { loosenSmartCardGlobalLexicalDeclarations } from '../primitives';

/** 挂在宿主 DOM 上的标记，记录该宿主已完成重放的内容指纹，避免流式重渲染重复执行。 */
const EXECUTED_FINGERPRINT_ATTR = 'data-palink-inline-executed';

export interface ReplayResult {
  /** 实际插入并执行的脚本数 */
  executed: number;
  /** 找到但没有对应脚本数据的孤儿占位符数（已被移除） */
  orphans: number;
  /** 执行过程中抛出的错误 */
  errors: Error[];
  /** 是否因指纹未变而整体跳过 */
  skipped: boolean;
}

function dispatchInitEvent(): void {
  try {
    document.dispatchEvent(new Event(INLINE_CARD_INIT_EVENT));
  } catch (error) {
    console.warn('[inline-card] 派发 ' + INLINE_CARD_INIT_EVENT + ' 失败:', error);
  }
}

/**
 * 在 host 内查找 <div data-palink-script="id"> 占位符并用真实 <script> 替换。
 *
 * @param host        已经完成 innerHTML 注入的宿主元素
 * @param scripts     prepareInlineCard 返回的脚本清单
 * @param fingerprint 本次内容指纹（通常是 HTML 的 hash）。与宿主上次记录一致则整体跳过，
 *                    这是流式输出场景防重复执行的关键（修正清单 B4）。
 */
export function replayInlineCardScripts(
  host: HTMLElement | null,
  scripts: InlineCardScript[],
  fingerprint: string,
): ReplayResult {
  const result: ReplayResult = { executed: 0, orphans: 0, errors: [], skipped: false };
  if (!host) return result;

  if (host.getAttribute(EXECUTED_FINGERPRINT_ATTR) === fingerprint) {
    result.skipped = true;
    return result;
  }

  const markers = host.querySelectorAll('div[data-palink-script]');
  // 即使没有脚本也要落指纹，否则每次重渲染都会重新扫描
  host.setAttribute(EXECUTED_FINGERPRINT_ATTR, fingerprint);
  if (markers.length === 0) return result;

  const scriptMap = new Map<string, InlineCardScript>();
  for (const item of scripts) scriptMap.set(item.id, item);

  for (let i = 0; i < markers.length; i += 1) {
    const marker = markers[i] as HTMLElement;
    const id = marker.getAttribute('data-palink-script') || '';
    const data = scriptMap.get(id);

    if (!data) {
      result.orphans += 1;
      marker.remove();
      continue;
    }

    try {
      if (data.type === 'data') {
        // JSON/模板数据块：用 template 解析还原，属性（尤其 id）完整保留。
        // 经 template 解析出来的 script 带 already-started 标记，且类型非 JS，绝不会执行。
        const tpl = document.createElement('template');
        tpl.innerHTML = '<script ' + (data.rawAttrs || '') + '>' + (data.code || '') + '<\/script>';
        const node = tpl.content.firstChild;
        const dataParent = marker.parentNode;
        if (node && dataParent) dataParent.replaceChild(node, marker);
        else marker.remove();
        continue;
      }

      const script = document.createElement('script');
      if (data.type === 'external') {
        if (!data.src) {
          marker.remove();
          continue;
        }
        script.src = data.src;
      } else {
        // C5 兜底：把顶层 const/let 降级为 var，避免多卡同屏重名声明 SyntaxError。
        // 对齐 iframe 路径 script-norm.ts 的处理（loosenSmartCardGlobalLexicalDeclarations）。
        script.textContent = loosenSmartCardGlobalLexicalDeclarations(data.code || '');
      }
      // 便于在 DevTools 里定位是哪张卡的哪段脚本
      script.setAttribute('data-palink-inline-script', id);

      const parent = marker.parentNode;
      if (!parent) {
        marker.remove();
        continue;
      }
      // 插入即同步执行（外链脚本除外，浏览器异步拉取）
      parent.replaceChild(script, marker);
      result.executed += 1;

      // 对齐 palink-smart-card.js L500：每段脚本执行完立刻派发一次，
      // 让「先注册监听、后被其他脚本触发」的卡片也能收到初始化信号
      dispatchInitEvent();
    } catch (error) {
      result.errors.push(error instanceof Error ? error : new Error(String(error)));
      console.warn('[inline-card] 脚本执行失败 id=' + id + ':', error);
      try {
        marker.remove();
      } catch {
        /* 占位符可能已被前面的脚本自行移除，忽略 */
      }
    }
  }

  // 对齐 palink-smart-card.js L512-517：兜底再派发一次，
  // 覆盖「后面的脚本注册监听时前面的派发已经过去」的情况
  if (result.executed > 0) dispatchInitEvent();

  return result;
}

/** 清除宿主上的执行指纹，强制下次重放。卡片被卸载或内容被外部改写时调用。 */
export function resetInlineCardReplayState(host: HTMLElement | null): void {
  if (!host) return;
  host.removeAttribute(EXECUTED_FINGERPRINT_ATTR);
}
