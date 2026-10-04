/*
 * [插件设置空间收纳 2026-10-04] StPluginSettingsDrawer + 挂载点 parked 行为测试
 *
 * 用 vitest 的 jsdom + react-dom/client 直接渲染真组件（本项目没装
 * @testing-library，手写 render + act 最小封装，与 character-plugins-tab.test.tsx 同款）。
 *
 * 钉住的语义：
 *   1. StPluginMountPoints 把 #extensions_settings / #extensions_settings2 渲染成
 *      常驻离屏 parked（position:fixed top:-9999px + visibility:hidden，非 display:none
 *      —— 部分插件用 offsetWidth 判断可见性），标准子容器仍存在，wand 菜单
 *      #extensionsMenu 的 forceHidden 行为不受影响；
 *   2. 抽屉打开：有内容的挂载点根节点被 move 进抽屉 host（真实节点，非克隆），
 *      parked inline style 被清空，空态提示不显示；
 *   3. 抽屉关闭：根节点按原位 move 回（nextSibling 保持），parked style 还原；
 *   4. 打开期间空挂载点收到插件注入 → MutationObserver 自动搬入（空态提示消失）；
 *   5. inline-drawer 折叠委托：点 header 切换 palink-idrawer-collapsed，
 *      点 content 内控件不触发；未按 ST 约定写类名时回退首个非 content 子元素。
 *
 * 运行: npx vitest run
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import React from 'react';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { StPluginMountPoints } from '../StPluginMountPoints';
import { StPluginSettingsDrawer } from '../StPluginSettingsDrawer';

const PARKED_CSS = 'position:fixed;top:-9999px;left:-9999px;visibility:hidden;pointer-events:none;';
// jsdom 序列化 cssText 时会插入空格（`position:fixed` → `position: fixed`），断言前先去空白
const squash = (s: string) => s.replace(/\s+/g, '');

let container: HTMLDivElement;
let root: Root;

function renderDrawer(open: boolean, onClose: () => void = () => {}) {
  act(() => {
    root.render(<StPluginSettingsDrawer open={open} onClose={onClose} />);
  });
}

/** 在 wrapper 下建一个带插件内容 / parked 样式的假挂载点根节点 */
function setupMountRoot(rootId: string, opts: { withPanel?: boolean; empty?: boolean } = {}) {
  const wrapper = document.createElement('div');
  document.body.appendChild(wrapper);
  const mountRoot = document.createElement('div');
  mountRoot.id = rootId;
  mountRoot.style.cssText = PARKED_CSS;
  const emptyContainer = document.createElement('div');
  emptyContainer.className = 'extension_container';
  mountRoot.appendChild(emptyContainer);
  if (opts.withPanel) {
    const panel = document.createElement('div');
    panel.className = 'mvu-panel';
    panel.textContent = 'MVU 变量框架';
    mountRoot.appendChild(panel);
  }
  wrapper.appendChild(mountRoot);
  const afterMarker = document.createElement('div');
  afterMarker.id = `${rootId}-after-marker`;
  wrapper.appendChild(afterMarker);
  return { wrapper, mountRoot, afterMarker };
}

beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  // 挂载点 id 全局唯一，测试间必须清干净，否则后续用例 getElementById 拿到别人的节点
  document
    .querySelectorAll('#extensions_settings, #extensions_settings2')
    .forEach((n) => n.remove());
});

describe('StPluginMountPoints 挂载点常驻离屏 parked', () => {
  it('#extensions_settings / #extensions_settings2 离屏 parked 且子容器齐全，wand 菜单不受影响', () => {
    act(() => {
      root.render(<StPluginMountPoints />);
    });

    for (const rootId of ['extensions_settings', 'extensions_settings2'] as const) {
      const el = document.getElementById(rootId);
      expect(el, rootId).not.toBeNull();
      const style = squash(el!.getAttribute('style') || '');
      expect(style).toContain('position:fixed');
      expect(style).toContain('top:-9999px');
      expect(style).toContain('visibility:hidden');
      // 不用 display:none（插件会用 offsetWidth 判断可见性）
      expect(style).not.toContain('display:none');
      // 标准子容器仍预置
      expect(el!.querySelectorAll('.extension_container').length).toBe(16);
    }

    // K-11 wand 菜单 forceHidden 行为保持不变（display:none）
    const wand = document.getElementById('extensionsMenu');
    expect(wand).not.toBeNull();
    expect(wand!.style.display).toBe('none');
  });
});

describe('StPluginSettingsDrawer 真实节点 move 进出', () => {
  it('打开：有内容的挂载点整体搬入抽屉 host，parked style 清空，空态提示隐藏', () => {
    const { mountRoot } = setupMountRoot('extensions_settings2', { withPanel: true });
    renderDrawer(true);

    const host = container.querySelector('.palink-st-plugin-drawer-host') as HTMLElement;
    expect(host).not.toBeNull();
    expect(host.contains(mountRoot)).toBe(true);
    expect(mountRoot.style.cssText).toBe('');
    // 空态提示应消失
    expect(container.textContent).not.toContain('当前没有插件注入设置面板');
  });

  it('关闭：挂载点按原位 move 回（nextSibling 保持），parked style 还原', () => {
    const { mountRoot, afterMarker } = setupMountRoot('extensions_settings2', { withPanel: true });
    renderDrawer(true);
    const host = container.querySelector('.palink-st-plugin-drawer-host') as HTMLElement;
    expect(host.contains(mountRoot)).toBe(true);

    renderDrawer(false);
    // 回到原父节点、原位置（afterMarker 之前），parked 样式还原
    expect(mountRoot.parentElement).toBe(afterMarker.parentElement);
    expect(mountRoot.nextElementSibling).toBe(afterMarker);
    expect(squash(mountRoot.style.cssText)).toBe(squash(PARKED_CSS));
  });

  it('打开时挂载点为空：不搬入、显示空态提示；随后插件注入 → 自动搬入', async () => {
    const { mountRoot } = setupMountRoot('extensions_settings2', { empty: true });
    renderDrawer(true);

    const host = container.querySelector('.palink-st-plugin-drawer-host') as HTMLElement;
    expect(host.contains(mountRoot)).toBe(false);
    expect(container.textContent).toContain('当前没有插件注入设置面板');

    // 模拟插件晚注入（MVU 卡脚本异步加载场景）
    await act(async () => {
      const panel = document.createElement('div');
      panel.className = 'mvu-panel';
      panel.textContent = 'MVU 变量框架';
      mountRoot.appendChild(panel);
      await Promise.resolve();
    });
    expect(host.contains(mountRoot)).toBe(true);
    expect(container.textContent).not.toContain('当前没有插件注入设置面板');
  });

  it('两个挂载点都有内容时都搬入', () => {
    setupMountRoot('extensions_settings', { withPanel: true });
    setupMountRoot('extensions_settings2', { withPanel: true });
    renderDrawer(true);

    const host = container.querySelector('.palink-st-plugin-drawer-host') as HTMLElement;
    expect(host.querySelectorAll('#extensions_settings, #extensions_settings2').length).toBe(2);
  });
});

describe('inline-drawer 折叠委托', () => {
  function setupDrawerWithInlineDrawer(headerClass: 'standard' | 'no-class') {
    const { mountRoot } = setupMountRoot('extensions_settings2', { withPanel: true });
    const panel = mountRoot.querySelector('.mvu-panel') as HTMLElement;
    panel.innerHTML =
      headerClass === 'standard'
        ? '<div class="inline-drawer"><div class="inline-drawer-header"><b>MVU 变量框架</b></div><div class="inline-drawer-content"><button class="ctrl">控件</button></div></div>'
        : '<div class="inline-drawer"><div class="mvu-title"><b>MVU 变量框架</b></div><div class="inline-drawer-content"><button class="ctrl">控件</button></div></div>';
    return { mountRoot, drawer: panel.querySelector('.inline-drawer') as HTMLElement };
  }

  function click(el: Element) {
    act(() => {
      el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
    });
  }

  it('点标准 header 切换折叠态，点 content 内控件不折叠', () => {
    const { drawer } = setupDrawerWithInlineDrawer('standard');
    renderDrawer(true);

    const header = drawer.querySelector('.inline-drawer-header') as HTMLElement;
    const ctrl = drawer.querySelector('.ctrl') as HTMLElement;

    click(header);
    expect(drawer.classList.contains('palink-idrawer-collapsed')).toBe(true);
    click(header);
    expect(drawer.classList.contains('palink-idrawer-collapsed')).toBe(false);

    click(ctrl);
    expect(drawer.classList.contains('palink-idrawer-collapsed')).toBe(false);
  });

  it('header 无标准类名时回退首个非 content 子元素', () => {
    const { drawer } = setupDrawerWithInlineDrawer('no-class');
    renderDrawer(true);

    const header = drawer.querySelector('.mvu-title') as HTMLElement;
    click(header);
    expect(drawer.classList.contains('palink-idrawer-collapsed')).toBe(true);
  });
});
