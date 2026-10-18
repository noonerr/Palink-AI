/**
 * [包I I-1 2026-10-18] 内联渲染路径的 <style> 去重 + 引用计数。
 *
 * 守卫的缺陷（REPORT_真实角色卡兼容性实测_酒馆助手卡_2026-10-18 §4）：
 * 猫娘卡一条正则脚本产出同一份 CSS（3,156B），旧实现把去重标记打在**源** style 上，
 * .mes_text 的 innerHTML 每次重建源元素都是新的 ⇒ 标记丢失 ⇒ 已移走的 clone 又在
 * document.body 里（container 查不到）⇒ 主文档同内容 CSS **15 份 / 47,340B**。
 *
 * 本文件钉住四条：
 *   A. 同一份 CSS 经 5 轮重建（每轮换新源元素）⇒ body 里该 hash 的 style **恒为 1 个**；
 *   B. 引用计数按「持有该 hash 的消息数」计，同一消息内多份同 hash **只加一次**；
 *   C. release（卸载）只减自己的计数，归零才 remove ⇒ 一条消息卸载不能把另一条的样式带走；
 *   D. 净化仍然先行：只含全局泄漏规则（body{...}）的 CSS 不入 body（安全兜底不许退化）。
 *
 * 运行: npx vitest run src/components/ui/custom/__tests__/message-inline-style-dedup.test.ts
 */
import { afterEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createMesStyleDeduper } from '../Message';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const messageSrc = fs.readFileSync(path.resolve(__dirname, '../Message.tsx'), 'utf-8');

const NK_CSS = '.mes_text .custom-nk-msg{display:flex;gap:14px;align-items:center;}';
/** 每轮换一个新源元素，模拟 React/正则/流式把 .mes_text 的 innerHTML 重建掉。 */
function refillSourceStyles(container: HTMLElement, count = 1, css = NK_CSS) {
  container.innerHTML = '';
  for (let i = 0; i < count; i += 1) {
    const style = document.createElement('style');
    style.textContent = css;
    container.appendChild(style);
  }
}

/**
 * 同内容份数统计。sanitizeStCompatCss 走 CSSOM 时会规范化空白与末尾分号
 * （`.a {color: red}` 与 `.a{color:red;}` 是同一份内容），所以判「同一份」要先归一化，
 * 但不能放松到「只差空格就算不同」——那会让 15 份重复的断言假绿。
 */
function normalizeCss(css: string): string {
  return String(css || '').replace(/\s+/g, '').replace(/;}/g, '}');
}

function bodySlotCount(cssText: string): number {
  const normalized = normalizeCss(cssText);
  return Array.from(document.body.querySelectorAll('style')).filter(
    (el) => normalizeCss(el.textContent || '') === normalized,
  ).length;
}

const mounted: Array<{ release: () => void }> = [];

function mountDeduper(container: HTMLElement) {
  const deduper = createMesStyleDeduper({ container });
  mounted.push(deduper);
  return deduper;
}

afterEach(() => {
  while (mounted.length) mounted.pop()?.release();
  document.body.innerHTML = '';
});

describe('I-1 内联 CSS 去重（内容 hash + 引用计数）', () => {
  it('A. 同一份 CSS 重建 5 轮 ⇒ body 里恒为 1 个 style，且正文内不留 style', () => {
    const container = document.createElement('div');
    container.className = 'mes_text';
    document.body.appendChild(container);
    const deduper = mountDeduper(container);

    for (let round = 1; round <= 5; round += 1) {
      refillSourceStyles(container);
      deduper.detachStyleFromMesText();

      const slots = Array.from(document.body.querySelectorAll('style[data-palink-css-hash]'));
      expect(slots, `第 ${round} 轮后 body 里该 hash 的槽位数`).toHaveLength(1);
      expect(bodySlotCount(NK_CSS), `第 ${round} 轮后同内容 style 份数`).toBe(1);
      expect(container.querySelectorAll('style')).toHaveLength(0);
      expect((slots[0] as HTMLElement).dataset.palinkMesStyleMoved).toBe('1');
      // 只有一个持有者 ⇒ 计数 1（不是「每轮 +1」的 5）
      expect((slots[0] as unknown as { __palinkRefCount?: number }).__palinkRefCount).toBe(1);
    }
  });

  it('A+. 卸载后归零移除；下一轮重建会新建槽位（不留幽灵 style）', () => {
    const container = document.createElement('div');
    document.body.appendChild(container);
    const deduper = createMesStyleDeduper({ container });
    mounted.pop(); // 本用例自己负责 release

    refillSourceStyles(container);
    deduper.detachStyleFromMesText();
    expect(bodySlotCount(NK_CSS)).toBe(1);

    deduper.release();
    expect(bodySlotCount(NK_CSS)).toBe(0);
    expect(document.body.querySelectorAll('style[data-palink-css-hash]')).toHaveLength(0);

    // release 后组件仍在跑（例如 StrictMode 双挂载的第二次 effect）⇒ 能重新建槽
    refillSourceStyles(container);
    deduper.detachStyleFromMesText();
    expect(bodySlotCount(NK_CSS)).toBe(1);
    deduper.release();
    expect(bodySlotCount(NK_CSS)).toBe(0);
  });

  it('B. 同一消息内两份同 hash CSS 只加一次计数（否则永远归不了零）', () => {
    const container = document.createElement('div');
    document.body.appendChild(container);
    const deduper = mountDeduper(container);

    refillSourceStyles(container, 2);
    deduper.detachStyleFromMesText();

    const slots = Array.from(document.body.querySelectorAll('style[data-palink-css-hash]'));
    expect(slots).toHaveLength(1);
    expect((slots[0] as unknown as { __palinkRefCount?: number }).__palinkRefCount).toBe(1);

    deduper.release();
    expect(bodySlotCount(NK_CSS)).toBe(0);
  });

  it('C. 两条消息共用一份 CSS：计数 2，卸载一条后另一条的样式仍在', () => {
    const containerA = document.createElement('div');
    const containerB = document.createElement('div');
    document.body.append(containerA, containerB);
    const deduperA = mountDeduper(containerA);
    const deduperB = createMesStyleDeduper({ container: containerB });

    refillSourceStyles(containerA);
    refillSourceStyles(containerB);
    deduperA.detachStyleFromMesText();
    deduperB.detachStyleFromMesText();

    const slots = Array.from(document.body.querySelectorAll('style[data-palink-css-hash]'));
    expect(slots).toHaveLength(1);
    expect((slots[0] as unknown as { __palinkRefCount?: number }).__palinkRefCount).toBe(2);

    deduperA.release();
    expect(document.body.contains(slots[0]), '另一条消息仍持有 ⇒ 不许移除').toBe(true);
    expect((slots[0] as unknown as { __palinkRefCount?: number }).__palinkRefCount).toBe(1);

    deduperB.release();
    expect(bodySlotCount(NK_CSS)).toBe(0);
  });

  it('C+. 槽位被外部删掉后重建：本消息的计数挂到新实例上，不会把别人的样式误删', () => {
    const containerA = document.createElement('div');
    const containerB = document.createElement('div');
    document.body.append(containerA, containerB);
    const deduperA = mountDeduper(containerA);
    const deduperB = mountDeduper(containerB);

    refillSourceStyles(containerA);
    refillSourceStyles(containerB);
    deduperA.detachStyleFromMesText();
    deduperB.detachStyleFromMesText();
    const oldSlot = document.body.querySelector('style[data-palink-css-hash]');
    expect(oldSlot).not.toBeNull();

    // 外部把槽位删了（插件 / 样式守护），随后 A 又渲染出一轮同样的 CSS ⇒ 新建槽位
    oldSlot?.remove();
    refillSourceStyles(containerA);
    deduperA.detachStyleFromMesText();
    const newSlot = document.body.querySelector('style[data-palink-css-hash]');
    expect(newSlot).not.toBeNull();
    expect(newSlot === oldSlot).toBe(false);
    expect((newSlot as unknown as { __palinkRefCount?: number }).__palinkRefCount).toBe(1);

    // B 下一轮认到同一个槽位 ⇒ 计数补上
    refillSourceStyles(containerB);
    deduperB.detachStyleFromMesText();
    expect((newSlot as unknown as { __palinkRefCount?: number }).__palinkRefCount).toBe(2);

    deduperA.release();
    expect(document.body.contains(newSlot), 'B 仍持有 ⇒ 不许移除').toBe(true);
    deduperB.release();
    expect(bodySlotCount(NK_CSS)).toBe(0);
  });

  it('D. 内容不同 ⇒ 各自一个槽位；净化后为空的全局泄漏规则不入 body', () => {
    const container = document.createElement('div');
    document.body.appendChild(container);
    const deduper = mountDeduper(container);

    refillSourceStyles(container, 1, NK_CSS);
    deduper.detachStyleFromMesText();
    refillSourceStyles(container, 1, '.mes_text .custom-other{color:red;}');
    deduper.detachStyleFromMesText();
    expect(document.body.querySelectorAll('style[data-palink-css-hash]')).toHaveLength(2);

    refillSourceStyles(container, 1, 'body{display:flex}');
    deduper.detachStyleFromMesText();
    expect(document.body.querySelectorAll('style[data-palink-css-hash]')).toHaveLength(2);
    expect(bodySlotCount('')).toBe(0);
  });

  it('接线：Message.tsx 的 effect 必须走 deduper 并在 cleanup 里 release（不许退回每轮新建 clone）', () => {
    expect(messageSrc).toContain('createMesStyleDeduper({ container })');
    expect(messageSrc).toContain('deduper.detachStyleFromMesText()');
    expect(messageSrc).toContain('deduper.release();');
    // 反例守卫：旧实现「每轮 append 一个新 clone 并自己记住」的写法不得回归
    expect(messageSrc).not.toContain('const movedStyles: HTMLStyleElement[] = []');
    expect(messageSrc).not.toContain('for (const styleEl of movedStyles) styleEl.remove();');
    // 源元素仍要移出（.mes_text 纯净正文）与净化兜底仍在
    expect(messageSrc).toContain('styleEl.remove();');
    expect(messageSrc).toContain('sanitizeStCompatCss(styleEl.textContent');
  });
});
