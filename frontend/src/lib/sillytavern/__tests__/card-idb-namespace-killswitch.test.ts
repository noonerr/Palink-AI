/*
 * IDB 分库止血开关契约测试（三轨并一轨 · S1 · G6）
 *
 * 真机实证的缺陷（2026-10-13，14700，角色 露缇雅1.2）：
 *   主框架写 localStorage.palink_idb_namespace = '0' 后刷新，
 *   卡片帧里的分库 shim **依然安装**（判据：帧内 indexedDB.open 是否 [native code]）⇒ 开关是哑弹。
 *
 * 根因：idbNamespaceDisabled() 读 window.parent.localStorage，而**未信任卡帧**里
 * legacy 段装了 parent 安全代理，它**故意**把 localStorage 映射到卡内 memoryStorage
 * （frame-shim/legacy-st-sim.ts:135-138；同文件 :39 明写"真实父帧对象本身不暴露"）
 * ⇒ 永远读不到主框架写的那个键 ⇒ 恒 false ⇒ shim 永远安装。
 *
 * 为什么既有单测没抓到：单测直接 mock window.parent，**没有装 legacy parent 代理** ——
 * 桩没有照抄真机环境（与 lorebook 族那条教训同宗）。
 * 所以本文件的核心用例就是**显式模拟那个代理**（parent.localStorage 是个没有该键的卡内存储）。
 *
 * 修法：父侧在 srcdoc 构建期读主框架 localStorage，经 ctx 下发；帧内优先读 ctx。
 * 旧路径保留为兜底 —— trusted-native 帧不装代理，那里旧路径仍有效且更新鲜。
 *
 * 运行: npx vitest run src/lib/sillytavern/__tests__/card-idb-namespace-killswitch.test.ts
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { IDB_NS_RUNTIME_SOURCE, IDB_NS_KILL_SWITCH_KEY } from '../card-idb-namespace';

const REPO_SRC = join(process.cwd(), 'src');

/** 卡内 memoryStorage：**没有**主框架写的止血键（模拟 legacy parent 代理给到的东西）。 */
function frameOwnStore(): any {
  const map = new Map<string, string>();
  return {
    getItem: (k: string) => (map.has(k) ? map.get(k)! : null),
    setItem: (k: string, v: string) => { map.set(k, String(v)); },
    removeItem: (k: string) => { map.delete(k); },
  };
}

/** 真父帧的 localStorage：主框架，里面可能写着止血键。 */
function realParentStore(entries: Record<string, string>): any {
  const map = new Map(Object.entries(entries));
  return {
    getItem: (k: string) => (map.has(k) ? map.get(k)! : null),
    setItem: (k: string, v: string) => { map.set(k, String(v)); },
    removeItem: (k: string) => { map.delete(k); },
  };
}

/** 在受控的 window / ctx 上求值真实运行时源码，取出 idbNamespaceDisabled。 */
function buildRuntime(parentStore: any, ctx: unknown) {
  const fakeWindow: any = { parent: null, HTMLIFrameElement: undefined };
  fakeWindow.parent = { localStorage: parentStore };
  const factory = new Function(
    'window', 'ctx',
    IDB_NS_RUNTIME_SOURCE + '\nreturn { idbNamespaceDisabled: idbNamespaceDisabled };',
  );
  return factory(fakeWindow, ctx) as { idbNamespaceDisabled: () => boolean };
}

// ============================================================
// A 核心回归钉：legacy parent 代理在场时，仍必须认 ctx 下发的开关
// ============================================================
describe('A ctx 下发的开关必须生效（真机那次的失败点）', () => {
  it('[红→S1 转绿] ctx 说已关闭 ⇒ 即使 parent.localStorage 读不到键，也判为已关闭', () => {
    // parentStore 是卡内存储：里面没有止血键（代理的真实行为）
    const rt = buildRuntime(frameOwnStore(), { idbNamespaceDisabled: true });
    expect(rt.idbNamespaceDisabled()).toBe(true);
  });

  it('[红→S1 转绿] ctx 说未关闭 ⇒ 判为未关闭（正常态，分库照装，行为与修复前一致）', () => {
    const rt = buildRuntime(frameOwnStore(), { idbNamespaceDisabled: false });
    expect(rt.idbNamespaceDisabled()).toBe(false);
  });
});

// ============================================================
// B 兜底路径保留：trusted-native 帧不装代理，旧路径仍要能用
// ============================================================
describe('B 旧路径兜底（trusted-native 帧 / ctx 未下发时）', () => {
  it('[绿] ctx 未提供该字段 + 真父帧写着 "0" ⇒ 仍判为已关闭', () => {
    const rt = buildRuntime(realParentStore({ [IDB_NS_KILL_SWITCH_KEY]: '0' }), {});
    expect(rt.idbNamespaceDisabled()).toBe(true);
  });

  it('[绿] ctx 未提供该字段 + 真父帧没写 ⇒ 未关闭', () => {
    const rt = buildRuntime(realParentStore({}), {});
    expect(rt.idbNamespaceDisabled()).toBe(false);
  });

  it('[绿] 值为 "1"/其他 ⇒ 未关闭（只有字符串 "0" 才算关闭，语义不变）', () => {
    const rt = buildRuntime(realParentStore({ [IDB_NS_KILL_SWITCH_KEY]: '1' }), {});
    expect(rt.idbNamespaceDisabled()).toBe(false);
  });

  it('[绿] ctx 为 undefined 时不抛错（typeof 守卫）', () => {
    const rt = buildRuntime(frameOwnStore(), undefined);
    expect(rt.idbNamespaceDisabled()).toBe(false);
  });

  it('[绿] parent 与 window 相同（顶层帧）时不误判', () => {
    const fakeWindow: any = { HTMLIFrameElement: undefined };
    fakeWindow.parent = fakeWindow;
    const factory = new Function(
      'window', 'ctx',
      IDB_NS_RUNTIME_SOURCE + '\nreturn { idbNamespaceDisabled: idbNamespaceDisabled };',
    );
    const rt = factory(fakeWindow, {}) as { idbNamespaceDisabled: () => boolean };
    expect(rt.idbNamespaceDisabled()).toBe(false);
  });
});

// ============================================================
// C 端到端通路：父侧读 → ctx → 帧内
// ============================================================
describe('C 通路完整性 —— 父侧读主框架 localStorage 并经 ctx 下发', () => {
  it('[红→S1 转绿] card-idb-namespace 提供 readIdbNamespaceKillSwitch()', () => {
    const src = readFileSync(join(REPO_SRC, 'lib/sillytavern/card-idb-namespace.ts'), 'utf8');
    expect(src).toMatch(/export function readIdbNamespaceKillSwitch/);
  });

  it('[红→S1 转绿] v2 boot payload 白名单带 idbNamespaceDisabled（否则帧内永远收不到）', () => {
    const src = readFileSync(
      join(REPO_SRC, 'components/ui/custom/smart-card-runtime/SillyTavernCompatRuntime.ts'),
      'utf8',
    );
    expect(src).toMatch(/idbNamespaceDisabled: Boolean\(context\.idbNamespaceDisabled\)/);
  });

  it('[红→S1 转绿] CharacterCardRenderer 把开关读出来透传进 bootContext', () => {
    const src = readFileSync(join(REPO_SRC, 'components/ui/custom/CharacterCardRenderer.tsx'), 'utf8');
    expect(src).toMatch(/idbNamespaceDisabled: readIdbNamespaceKillSwitch\(\)/);
  });

  it('[红→S1 转绿] 帧内实现必须优先读 ctx（而不是只读 window.parent）', () => {
    const idx = IDB_NS_RUNTIME_SOURCE.indexOf('ctx && ctx.idbNamespaceDisabled === true');
    const legacy = IDB_NS_RUNTIME_SOURCE.indexOf('window.parent');
    expect(idx).toBeGreaterThan(-1);
    expect(legacy).toBeGreaterThan(-1);
    expect(idx, 'ctx 判定必须排在 window.parent 之前').toBeLessThan(legacy);
  });
});
