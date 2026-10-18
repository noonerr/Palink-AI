/*
 * 包 F F-1 · 帧内命令枚举口径（2026-10-18）
 *
 * 测的是 `runtime-body/part-07.ts` 里**真实存在的那段源码**（sliceBetween + new Function），
 * 不是照抄一份等价逻辑 —— 否则把种子请求改坏时本文件不会红（§5.4 反证依赖这一点）。
 *
 * 缺口背景：`slashKnownNamesCompat` 原先只由 `/help` 的返回文本解析填充，
 * 上限 = 宿主引擎真注册了的命令 ⇒ 帧内 `Object.keys(SlashCommandParser.commands)` 只有 135，
 * ST 1.18 权威 289 名里 202 名对三方代码"看起来不存在"。
 * 修法：帧内先向宿主取权威名单（`getStCompatCommandNames` 动作，名单在
 * `lib/slash-engine/st-command-catalog.ts`，不进模板串），再照旧接 /help 补漏。
 *
 * 运行: npx vitest run src/components/ui/custom/smart-card-runtime/__tests__/f-package-slash-enum-contract.test.ts
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it, expect } from 'vitest';
// [包L 2026-10-18] 执行型测试（sliceBetween + new Function）⇒ 用求值后载体：
// 未求值源码文本里单反斜杠转义与生产语义相反，本地绿线上坏。
import { COMPAT_V2_RUNTIME_ARTIFACT as SRC } from './compat-v2-runtime-source';
import { ST_118_COMMAND_NAMES } from '@/lib/slash-engine/st-command-catalog';

const PROBE_289: string[] = JSON.parse(
  readFileSync(join(process.cwd(), 'src/lib/slash-engine/__tests__/fixtures/st289-names.json'), 'utf8'),
);

/** 取 [from, to) 之间的源码原文（与 b-package 测试同法）。 */
function sliceBetween(src: string, from: string, to: string): string {
  const start = src.indexOf(from);
  const end = src.indexOf(to, start);
  expect(start, `from not found: ${from}`).toBeGreaterThan(-1);
  expect(end, `to not found: ${to}`).toBeGreaterThan(start);
  return src.slice(start, end);
}

type Bridge = { calls: Array<{ name: string; args: unknown }> };

/**
 * 把 part-07 的「Map + 注册函数 + known names + Proxy 视图 + prime」原样求值出来。
 * requestParent / executeSlashCommandCompat 由测试注入，其余全是仓库里的真源码。
 */
function buildFrameView(options: {
  seedNames?: string[] | null;
  helpText?: string;
} = {}) {
  const storeRegion = sliceBetween(
    SRC,
    'const slashCommandStoreCompat = new Map();',
    'const parseSlashArgsCompat =',
  );
  const viewRegion = sliceBetween(
    SRC,
    'const slashKnownNamesCompat = new Set();',
    'window.SlashCommandParser.commands = slashCommandViewCompat;',
  );
  const bridge: Bridge = { calls: [] };
  const requestParent = (action: string, payload: any = {}) => {
    bridge.calls.push({ name: action, args: payload });
    if (action === 'getStCompatCommandNames') {
      // 宿主 respond({ ok: true, result: { names } }) → 帧内 v2 归一化成 { ok:true, ...{names} }
      if (options.seedNames === null) return Promise.resolve({ ok: false, error: 'boom' });
      return Promise.resolve({ ok: true, names: options.seedNames ?? ST_118_COMMAND_NAMES });
    }
    if (action === 'runPalinkSlash') {
      return Promise.resolve({ ok: true, result: options.helpText ?? '/help  Show this list\n'});
    }
    return Promise.resolve({ ok: false, error: 'unexpected action' });
  };
  const executeSlashCommandCompat = (text: string) => {
    bridge.calls.push({ name: 'execute', args: text });
    return Promise.resolve('');
  };
  const factory = new Function(
    'window',
    'requestParent',
    'executeSlashCommandCompat',
    `${storeRegion}\n${viewRegion}\nreturn { view: slashCommandViewCompat, prime: primeSlashKnownNamesCompat, known: slashKnownNamesCompat };`,
  );
  const fakeWindow: any = { SlashCommandParser: {} };
  const built = factory(fakeWindow, requestParent, executeSlashCommandCompat) as {
    view: any;
    prime: () => Promise<void>;
    known: Set<string>;
    window: any;
  };
  return { ...built, bridge, fakeWindow };
}

describe('F-1 帧内枚举：种子名单来自宿主，不是 /help 上限', () => {
  it('prime 后 Object.keys 命中探针口径 289 名（≥280 验收线，实到 289）', async () => {
    const { view, prime, fakeWindow } = buildFrameView();
    await prime();
    const keys = Object.keys(view);
    const covered = PROBE_289.filter((n) => keys.indexOf(n) >= 0);
    expect(covered.length).toBe(289);
    expect(covered.length).toBeGreaterThanOrEqual(280);
    // ownKeys 下限 = 权威名单本身（Palink 自有命令另有 /help 补漏）
    expect(keys.length).toBeGreaterThanOrEqual(ST_118_COMMAND_NAMES.length);
    expect(ST_118_COMMAND_NAMES.length).toBe(293);
    // 观测面：prime 完就把名单挂到 window，探针不必再猜
    expect(fakeWindow.__palinkSlashKnownNames.length).toBeGreaterThanOrEqual(293);
    expect(fakeWindow.__palinkSlashSeedNamesCount).toBe(293);
  });

  it('in / has / for...in / 取值四种写法同时命中（ST 三方代码的惯用探测）', async () => {
    const { view, prime } = buildFrameView();
    await prime();
    expect('bg' in view).toBe(true);
    expect(view.has('bg')).toBe(true);
    expect(Object.keys(view).indexOf('caption') >= 0).toBe(true);
    let seen = 0;
    for (const _name in view) seen += 1;
    expect(seen).toBeGreaterThanOrEqual(293);
    // 有值必须有实现？—— 这里给的是合成 entry（callback 真桥到宿主），不是 undefined / 空壳
    expect(typeof view.bg.callback).toBe('function');
  });

  it('合成 entry 的执行仍落到宿主桥（未实现的命令不会被当成成功）', async () => {
    const { view, prime, bridge } = buildFrameView();
    await prime();
    view.bg.callback('blue');
    const executed = bridge.calls.filter((c) => c.name === 'execute');
    expect(executed.length).toBe(1);
    expect(executed[0].args).toBe('/bg blue');
  });

  it('/help 的解析结果照旧并入（Palink 自有命令不因种子而丢）', async () => {
    const { view, prime } = buildFrameView({ helpText: '/branch-create foo\n/palink-only-bar baz\n' });
    await prime();
    expect('branch-create' in view).toBe(true);
    expect('palink-only-bar' in view).toBe(true);
    expect(Object.keys(view).length).toBeGreaterThanOrEqual(294);
  });

  it('种子请求失败时退回 /help 口径（不炸、不清空既有注册）', async () => {
    const { view, prime } = buildFrameView({ seedNames: null, helpText: '/echo x\n' });
    view.echo = { name: 'echo', callback: () => 'x', aliases: [] };
    await prime();
    // /help 仍被解析 → echo 在 known 里；插件写的 Map 项也在
    expect('echo' in view).toBe(true);
    expect(view.echo.name).toBe('echo');
    // 种子没拿到 ⇒ ST 名单不出现（等同修复前，不是崩溃）
    expect('bg' in view).toBe(false);
  });

  it('权威名单不在种子里的名字不会被凭空造出来（种子只加 ST 的名，不带私货）', async () => {
    const { view, prime } = buildFrameView({ helpText: '' });
    await prime();
    expect('this-is-not-a-command' in view).toBe(false);
    expect(Object.keys(view).every((k: string) => k.length > 0)).toBe(true);
  });
});

describe('F-1 源码接线（宿主与帧内两端都要在）', () => {
  it('帧内：先取种子再接 /help，且没有把 293 个字面量写进模板串', () => {
    const region = sliceBetween(SRC, 'const primeSlashKnownNamesCompat = async () => {', '  primeSlashKnownNamesCompat();');
    expect(region).toContain("requestParent('getStCompatCommandNames', {})");
    expect(region).toContain("requestParent('runPalinkSlash', { command: '/help' })");
    // srcdoc 体积红线：名单不进模板串（只允许出现"取名单"的代码，不允许出现名单本身）
    expect(region).not.toContain("'clipboard-set'");
    expect(region).not.toContain("'checkpoint-create'");
  });

  it('宿主：控制器有 getStCompatCommandNames 落点，且返回对象包一层 names', () => {
    const controller = readFileSync(
      join(process.cwd(), 'src/components/ui/custom/smart-card-runtime/SmartCardCompatController.ts'),
      'utf8',
    );
    expect(controller).toContain("action.action === 'getStCompatCommandNames'");
    expect(controller).toContain('result = { names: getStCompatCommandNames() };');
    expect(controller).toContain("from '@/lib/slash-engine/st-command-catalog'");
  });
});
