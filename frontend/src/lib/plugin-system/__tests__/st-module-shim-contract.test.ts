/*
 * ST 插件 shim 契约守卫：插件按模块名 import 的符号，沙箱必须真的提供。
 *
 * 背景：Palink 的插件沙箱用一张 moduleMap（sandbox.ts 内 `'group-chats.js': { ... }`
 * 这类字面量）来冒充 ST 的 public/scripts/*.js 模块。这张表是**逐个插件、逐个符号
 * 手工补**出来的（文件里那条 `P-6：缺失 ST 模块的轻量兼容实现…覆盖插件实际 import
 * 但 moduleMap 缺失的符号` 就是这套流程的自述），没有 ESM 的具名导出校验，
 * 所以漏一个键不会报错，插件只会静默拿到 undefined —— 有两种后果：
 *   · 用到即崩：gallery/index.js:787 `groups.find(...)` → Cannot read properties
 *     of undefined (reading 'find')
 *   · 静默走偏：expressions/index.js:198 `if (isDisabled && hideMutedSprites)`
 *     → 恒假，被静音的群成员永远照常渲染，不抛错因此没人发现
 * 这类缺口历史上是一批一批冒出来的，靠人工审计不可持续，故本测试把
 * 「插件要什么」与「沙箱给什么」变成每次跑测试自动比对。
 *
 * 另附 getContext().isMobile 的布尔性守卫：该字段声明为 boolean，但实现曾以
 * `a && window.matchMedia && window.matchMedia(...).matches` 短路，在无 matchMedia
 * 的环境（jsdom 即不实现）返回 undefined。真实浏览器恒有 matchMedia 故线上不显。
 *
 * 运行: npx vitest run src/lib/plugin-system/__tests__/st-module-shim-contract.test.ts
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it, expect } from 'vitest';
// getContext 是重模块（整条 i18n / 沙箱 / 正则链）。此前三条 isMobile 用例各自
// 在用例体内 `await import(...)`，冷启动转译的成本落在**测试自身的 5s 超时**里，
// 满载并行时反复假红（单跑该文件恒绿）。提到模块顶层后成本落到收集阶段，
// 与 getcontext-parity / plugin-runtime-extprompt-contract 的既有修法一致。
import { getContext } from '@/lib/sillytavern/getContext';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SANDBOX_SRC = fs.readFileSync(
  path.resolve(__dirname, '..', 'sandbox.ts'),
  'utf-8',
);
// st-plugins 在仓库根（本文件位于 frontend/src/lib/plugin-system/__tests__/）
const PLUGINS_ROOT = path.resolve(__dirname, '..', '..', '..', '..', '..', 'st-plugins');

/** 取出 moduleMap 里某个 `'x.js': { ... }` 块的文本（按大括号配平）。 */
function moduleBlock(moduleName: string): string {
  const start = SANDBOX_SRC.indexOf(`'${moduleName}': {`);
  expect(start, `sandbox.ts 里找不到 '${moduleName}' 模块映射`).toBeGreaterThanOrEqual(0);
  let depth = 0;
  for (let i = start + moduleName.length + 5; i < SANDBOX_SRC.length; i += 1) {
    const c = SANDBOX_SRC[i];
    if (c === '{') depth += 1;
    else if (c === '}') {
      depth -= 1;
      if (depth < 0) return SANDBOX_SRC.slice(start, i);
    }
  }
  throw new Error(`'${moduleName}' 块大括号未配平`);
}

/** 沙箱为该模块提供的顶层导出名（含 get X() 形式的 getter）。 */
function providedNames(block: string): Set<string> {
  const names = new Set<string>();
  for (const line of block.split('\n')) {
    const stripped = line.replace(/\/\/.*$/, '');
    const m = stripped.match(/^\s{8}(?:get\s+|async\s+)?([A-Za-z_$][\w$]*)\s*[:(]/);
    if (m) names.add(m[1]);
  }
  return names;
}

/** 递归列出插件 js（排除 third-party / assets / samples —— 那些不由本仓库适配保证）。 */
function pluginSources(dir: string, out: string[] = []): string[] {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.isDirectory()) {
      if (!['third-party', 'assets', 'samples', 'node_modules'].includes(e.name)) {
        pluginSources(path.join(dir, e.name), out);
      }
    } else if (e.name.endsWith('.js')) {
      out.push(path.join(dir, e.name));
    }
  }
  return out;
}

/** 扫出所有 Palink 自带插件从某 ST 模块具名导入的符号集合。 */
function requestedFrom(moduleName: string): Map<string, Set<string>> {
  const hits = new Map<string, Set<string>>();
  for (const f of pluginSources(PLUGINS_ROOT)) {
    const src = fs.readFileSync(f, 'utf8');
    const re = new RegExp(
      `import\\s*\\{([^}]*)\\}\\s*from\\s*['"][^'"]*${moduleName.replace('.', '\\.')}['"]`,
      'g',
    );
    for (const m of src.matchAll(re)) {
      const names = m[1].split(',').map(s => s.trim().split(/\s+as\s+/)[0].trim()).filter(Boolean);
      const rel = path.relative(PLUGINS_ROOT, f).replace(/\\/g, '/');
      hits.set(rel, new Set([...(hits.get(rel) ?? []), ...names]));
    }
  }
  return hits;
}

describe('沙箱 group-chats.js shim 契约', () => {
  it('插件从 group-chats.js 具名导入的符号，moduleMap 全部提供', () => {
    const block = moduleBlock('group-chats.js');
    const provided = providedNames(block);
    const requested = requestedFrom('group-chats.js');

    // 守卫自身不能失效：必须真的扫到插件 import，否则这条测试会假绿
    expect(requested.size, '未扫到任何 group-chats.js 的插件导入，守卫可能已失效').toBeGreaterThan(0);

    const missing: string[] = [];
    for (const [file, names] of requested) {
      for (const n of names) if (!provided.has(n)) missing.push(`${file} → ${n}`);
    }
    expect(missing, '沙箱未提供、插件 import 会拿到 undefined 的符号：\n' + missing.join('\n')).toEqual([]);
  });

  it('groups 是实时 getter，不得退回构建时快照（P-5/N7 同类缺陷已修过三轮）', () => {
    const block = moduleBlock('group-chats.js');
    expect(/get\s+groups\s*\(\s*\)\s*:/.test(block)).toBe(true);
    expect(block).toContain('buildStContext()');
    expect(/groups:\s*stContext\.groups/.test(block)).toBe(false);
  });

  it('hideMutedSprites 有显式取值（不能靠缺键给出 undefined）', () => {
    expect(providedNames(moduleBlock('group-chats.js')).has('hideMutedSprites')).toBe(true);
  });
});

describe('getContext().isMobile 类型契约', () => {
  it('是 boolean 而非 undefined', () => {
    expect(typeof getContext().isMobile).toBe('boolean');
  });

  it('运行环境缺 matchMedia 时仍返回 boolean（原实现会短路成 undefined）', () => {
    const g = globalThis as { matchMedia?: unknown };
    const saved = g.matchMedia;
    try {
      delete g.matchMedia;
      const v = getContext().isMobile;
      expect(v).toBe(false);          // 不是 undefined
      expect(typeof v).toBe('boolean');
    } finally {
      g.matchMedia = saved;
    }
  });
});

describe('getContext().groups 数据源', () => {
  it('groups 是数组（沙箱 groups getter 依赖此形状）', () => {
    expect(Array.isArray(getContext().groups)).toBe(true);
  });
});
