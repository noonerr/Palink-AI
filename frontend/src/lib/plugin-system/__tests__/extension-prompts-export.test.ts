/*
 * [EXT-PROMPTS-VIEW 2026-10-23] script.js 的 `extension_prompts` 导出
 *
 * 真机报错（Smart Memory 1.8.3 ui.js）：
 *   `import { extension_prompts } from '../../../../script.js'`
 *   → `var { extension_prompts } = require('script.js')` → moduleMap 无此键 → undefined
 *   → `updateTokenDisplay` 里 `extension_prompts[t.key]?.value` 抛
 *     `Cannot read properties of undefined (reading '…')`。
 *
 * 本文件用**真实 PluginSandbox.executePluginCode**（与生产同一入口）执行插件代码，
 * 验证导出的 extension_prompts 是实时视图而不是一次快照：
 *   ① `require('script.js')` 解构能拿到已定义对象；
 *   ② 先 import、后 setExtensionPrompt，同一对象能读到新键（实时性）；
 *   ③ 每条 entry 有 `value` 别名（= content，与 getContext 同口径）；
 *   ④ 写入只落本地 overlay，不串到 promptInjection 源数据。
 *
 * 运行: npx vitest run src/lib/plugin-system/__tests__/extension-prompts-export.test.ts
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { PluginSandbox } from '../sandbox';
import {
  promptInjection,
  setActivePromptCharacter,
} from '@/services/prompt-injection';

const CONTEXT = {
  on: () => {},
  off: () => {},
  emit: () => {},
  once: () => {},
  removeAllListeners: () => {},
  storage: {
    get: () => undefined,
    set: () => {},
    delete: () => {},
    clear: () => {},
  },
  registerCommand: () => {},
  registerMacro: () => {},
  log: () => {},
};

const CHARACTER_ID = 'char-extension-prompts-view';

/** 与插件转译产物同形的取用方式：解构 require('script.js')，并把它导出回来观察 */
function runPlugin(source: string): Promise<Record<string, any>> {
  return new PluginSandbox().executePluginCode(source, CONTEXT as any, 'ext-prompts-probe');
}

describe('script.js 导出 extension_prompts（实时 Proxy 视图）', () => {
  beforeEach(() => {
    promptInjection.clear();
    setActivePromptCharacter(CHARACTER_ID);
  });

  afterEach(() => {
    promptInjection.clear();
    setActivePromptCharacter('');
  });

  it('① var { extension_prompts } = require(\'script.js\') 拿到已定义对象，取不存在的键不抛', async () => {
    const exports = await runPlugin(`
      var { extension_prompts } = require('script.js');
      export const view = extension_prompts;
      export const probe = () => extension_prompts['not-registered']?.value;
    `);

    expect(exports.view).toBeDefined();
    expect(typeof exports.view).toBe('object');
    expect((exports.probe as Function)()).toBeUndefined();
    expect(Object.keys(exports.view as object)).toEqual([]);
  });

  it('② 先 import、后 setExtensionPrompt：同一对象实时读到新键', async () => {
    const exports = await runPlugin(`
      var { extension_prompts } = require('script.js');
      export const view = extension_prompts;
    `);
    const view = exports.view as Record<string, any>;

    // import 时还没有任何条目
    expect(view[CHARACTER_ID]?.value).toBeUndefined();
    expect('smart_memory' in view).toBe(false);

    // 插件在 import 之后才注册自己的 prompt（真实时序）
    promptInjection.setExtensionPrompt('smart_memory', 'remember this', 1, 4, false);

    expect('smart_memory' in view).toBe(true);
    expect(Object.keys(view)).toContain('smart_memory');
    expect(view.smart_memory?.content).toBe('remember this');

    // 更新同一个 key 也要实时反映（不是写入时缓存的值）
    promptInjection.setExtensionPrompt('smart_memory', 'remember this too', 1, 4, false);
    expect(view.smart_memory?.content).toBe('remember this too');
  });

  it('③ 每条 entry 带 value 别名（= content，与 getContext 同口径）', async () => {
    promptInjection.setExtensionPrompt('alpha', 'A content', 0, 2, true);
    promptInjection.setSourcePrompts('frame:test-frame', {
      beta: { value: 'B content', position: 1, depth: 0, scan: false },
    });

    const exports = await runPlugin(`
      var { extension_prompts } = require('script.js');
      export const view = extension_prompts;
      export const tokenOf = (key) => extension_prompts[key]?.value;
    `);
    const view = exports.view as Record<string, any>;

    expect(view.alpha?.content).toBe('A content');
    expect(view.alpha?.value).toBe('A content');
    expect(view.beta?.content).toBe('B content');
    expect(view.beta?.value).toBe('B content');

    // Smart Memory updateTokenDisplay 的真实取法：不能抛
    expect((exports.tokenOf as Function)('alpha')).toBe('A content');
    expect((exports.tokenOf as Function)('missing')).toBeUndefined();
    // ST 字段本身仍然透传
    expect(view.alpha?.position).toBe(0);
    expect(view.alpha?.depth).toBe(2);
    expect(view.alpha?.scan).toBe(true);
  });

  it('④ 写入 / 删除只落本地 overlay，不串到 promptInjection 源数据', async () => {
    promptInjection.setExtensionPrompt('alpha', 'A content');

    const exports = await runPlugin(`
      var { extension_prompts } = require('script.js');
      export const view = extension_prompts;
    `);
    const view = exports.view as Record<string, any>;

    // 写：overlay 命中，读得到
    view.locally_added = { value: 'only in overlay' };
    expect(view.locally_added?.value).toBe('only in overlay');
    expect(Object.keys(view)).toContain('locally_added');

    // 源数据没被污染
    const source = promptInjection.getPromptsForGeneration(CHARACTER_ID);
    expect(source.locally_added).toBeUndefined();
    expect(Object.keys(source)).toEqual(['alpha']);

    // 写同名键时覆盖视图，但源条目保持原值
    view.alpha = { value: 'shadowed' };
    expect(view.alpha?.value).toBe('shadowed');
    expect(promptInjection.getPromptsForGeneration(CHARACTER_ID).alpha.content).toBe('A content');

    // 删：先删 overlay，源值重新显现
    delete view.alpha;
    expect(view.alpha?.value).toBe('A content');

    // 删 overlay-only 键后彻底消失
    delete view.locally_added;
    expect(view.locally_added).toBeUndefined();
    expect('locally_added' in view).toBe(false);
  });
});
