/*
 * 包D · 「信任此卡」入口契约（trust-control + 渲染器接线）
 *
 * 要钉住的四件事：
 *   ① 只有**会执行脚本**的帧才给入口（static-html 永远不给 —— 没有脚本可信任，
 *      给它开关只会诱导用户白白放开同源）；
 *   ② 授予前必过确认弹窗，且弹窗文案**写清代价**（localStorage / IndexedDB 可读写）；
 *   ③ 取消 ≠ 授权（点击遮罩与「取消」都不许落到 writeSmartCardTrustGrant）；
 *   ④ 入口组件**无权**产出 `allow-same-origin`：同源权只由 CharacterCardRenderer 的
 *      `trustedNative ? …allow-same-origin… : …` 单点产生（P1-1 红线，防会话盗取）。
 *
 * ⑤⑥ 是"接线"证据：入口确实渲染在**内联分支**（非沉浸式），并且旧的
 *    `prefersImmersive &&` 门不回潮（那正是真机上没人能按到信任按钮的原因）。
 *
 * 运行: npx vitest run src/components/ui/custom/smart-card-runtime/__tests__/trust-control.test.tsx
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import React from 'react';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  SmartCardTrustButton,
  SmartCardTrustConfirmDialog,
  nextSmartCardTrustAction,
  shouldShowSmartCardTrustControl,
} from '../trust-control';
import { SMART_CARD_UI_TEXT } from '../shared';

(globalThis as unknown as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;

// vitest 固定以 frontend/ 为 cwd
const rendererSource = readFileSync(
  join(process.cwd(), 'src/components/ui/custom/CharacterCardRenderer.tsx'),
  'utf8',
);
const trustControlSource = readFileSync(
  join(process.cwd(), 'src/components/ui/custom/smart-card-runtime/trust-control.tsx'),
  'utf8',
);

let root: Root | null = null;
let container: HTMLDivElement | null = null;

async function mount(element: React.ReactElement): Promise<HTMLDivElement> {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => {
    root!.render(element);
    await Promise.resolve();
  });
  return container;
}

async function click(el: Element): Promise<void> {
  await act(async () => {
    el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
    await Promise.resolve();
  });
}

afterEach(() => {
  if (root) {
    act(() => root!.unmount());
    root = null;
  }
  container?.remove();
  container = null;
});

const zhText = SMART_CARD_UI_TEXT.zh;

// ============================================================
// 1 谁能被信任
// ============================================================
describe('D-① 入口可见性只跟"这帧会不会跑脚本"走', () => {
  it('iframe-js / trusted-native 给入口；static-html 不给', () => {
    expect(shouldShowSmartCardTrustControl('iframe-js')).toBe(true);
    expect(shouldShowSmartCardTrustControl('trusted-native')).toBe(true);
    expect(shouldShowSmartCardTrustControl('static-html')).toBe(false);
  });

  it('点一下要发起的动作：未信任=授予，已信任=撤销（可回退，不是单向门）', () => {
    expect(nextSmartCardTrustAction(false)).toBe('enable');
    expect(nextSmartCardTrustAction(true)).toBe('revoke');
  });
});

// ============================================================
// 2 按钮呈现 + 回调
// ============================================================
describe('D-② 盾牌按钮：状态可辨、点击只发起、不自行授权', () => {
  it('未信任时 data-palink-card-trust="none"，点击回调被调用且只一次', async () => {
    const onToggle = vi.fn();
    const host = await mount(
      <SmartCardTrustButton trusted={false} text={zhText} onToggle={onToggle} />,
    );
    const btn = host.querySelector('[data-palink-card-trust]') as HTMLButtonElement;
    expect(btn).not.toBeNull();
    expect(btn.getAttribute('data-palink-card-trust')).toBe('none');
    expect(btn.getAttribute('aria-pressed')).toBe('false');
    expect(btn.title).toContain('信任');
    await click(btn);
    expect(onToggle).toHaveBeenCalledTimes(1);
  });

  it('已信任时切到 granted + aria-pressed=true（用户能看出当前是信任态）', async () => {
    const host = await mount(
      <SmartCardTrustButton trusted text={zhText} onToggle={vi.fn()} />,
    );
    const btn = host.querySelector('[data-palink-card-trust]') as HTMLButtonElement;
    expect(btn.getAttribute('data-palink-card-trust')).toBe('granted');
    expect(btn.getAttribute('aria-pressed')).toBe('true');
    expect(btn.title).toBe(zhText.nativeEnabled);
  });
});

// ============================================================
// 3 确认弹窗：文案说清代价 + 取消不授权
// ============================================================
describe('D-③④ 事前确认弹窗', () => {
  it('授予文案必须点名 localStorage 与 IndexedDB（不能只说"最高兼容性"）', async () => {
    const host = await mount(
      <SmartCardTrustConfirmDialog
        action="enable"
        text={zhText}
        titleId="t1"
        onConfirm={vi.fn()}
        onCancel={vi.fn()}
      />,
    );
    const body = host.querySelector('p')!.textContent || '';
    expect(body).toContain('localStorage');
    expect(body).toContain('IndexedDB');
    expect(host.querySelector('h2')!.textContent).toBe(zhText.enableNative);
    expect(host.querySelector('[role="dialog"]')).not.toBeNull();
  });

  it('撤销文案说明"回到隔离沙箱、已存数据不删"', async () => {
    const host = await mount(
      <SmartCardTrustConfirmDialog
        action="revoke"
        text={zhText}
        titleId="t2"
        onConfirm={vi.fn()}
        onCancel={vi.fn()}
      />,
    );
    const body = host.querySelector('p')!.textContent || '';
    expect(body).toContain('opaque origin');
    expect(host.querySelector('h2')!.textContent).toBe(zhText.revokeNative);
  });

  it('confirm 才落地；cancel 与点遮罩都不算授权', async () => {
    const onConfirm = vi.fn();
    const onCancel = vi.fn();
    const host = await mount(
      <SmartCardTrustConfirmDialog
        action="enable"
        text={zhText}
        titleId="t3"
        onConfirm={onConfirm}
        onCancel={onCancel}
      />,
    );
    await click(host.querySelector('[data-palink-card-trust-choice="cancel"]')!);
    expect(onCancel).toHaveBeenCalledTimes(1);
    expect(onConfirm).toHaveBeenCalledTimes(0);

    await click(host.querySelector('[data-palink-card-trust-choice="confirm"]')!);
    expect(onConfirm).toHaveBeenCalledTimes(1);

    // 点遮罩（容器本身）= 取消；点弹窗内部不冒泡
    const before = onCancel.mock.calls.length;
    await click(host.querySelector('[data-palink-card-trust-choice="confirm"]')!.parentElement!.parentElement!);
    await click(host.firstElementChild!);
    expect(onCancel.mock.calls.length).toBe(before + 1);
  });

  it('入口组件的代码里不许出现 allow-same-origin / 授权写入（同源权只由渲染器的 trustedNative 分支单点产生）', () => {
    // 只剥注释再断言：本文件头部注释里写了这些词是为了说明"我不做这件事"，
    // 拿原文件断言会被自己的解释文字打红（第一版踩过）。
    const code = trustControlSource
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/^\s*\/\/.*$/gm, '');
    expect(code).not.toContain('allow-same-origin');
    expect(code).not.toContain('sandbox');
    expect(code).not.toContain('writeSmartCardTrustGrant');
    expect(code).not.toContain('sessionStorage');
  });
});

// ============================================================
// 5 接线：内联分支真的有入口（真机可发现性的回归线）
// ============================================================
describe('D-⑤⑥ 渲染器接线', () => {
  it('可见性判定改走 shouldShowSmartCardTrustControl(effectiveMode)', () => {
    expect(rendererSource).toContain('shouldShowSmartCardTrustControl(effectiveMode)');
    // 旧门（沉浸式 && 模式）不回潮：非 launcher 卡恒 explicitInline ⇒ prefersImmersive 恒 false
    // ⇒ 入口又变成"代码写好了但没人能按到"。本行只认赋值语句本身，
    // 免得被"解释旧门为什么错"的注释文字误伤（第一版踩过）。
    expect(rendererSource).not.toMatch(/showTrustedControl\s*=\s*prefersImmersive/);
  });

  it('内联分支与沉浸式分支都挂了按钮与确认弹窗', () => {
    expect(rendererSource).toContain('<SmartCardTrustButton');
    expect(rendererSource).toContain('<SmartCardTrustConfirmDialog');
    // 两处按钮（沉浸式 + 内联）、两处弹窗（沉浸式 + 内联）
    expect((rendererSource.match(/<SmartCardTrustButton/g) || []).length).toBe(2);
    expect((rendererSource.match(/<SmartCardTrustConfirmDialog/g) || []).length).toBe(2);
  });

  it('授权落地仍走 writeSmartCardTrustGrant + setTrustedNative（入口只发起，判定没被改）', () => {
    expect(rendererSource).toContain('writeSmartCardTrustGrant(context.characterId, sourceFingerprint, nextTrusted)');
    expect(rendererSource).toContain("const nextTrusted = pendingTrustAction === 'enable';");
  });
});
