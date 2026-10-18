/*
 * 生成脚本文本可解析性守卫
 *
 * 背景（2026-09-30，HANDOFF_卡片正文空白与卡脚本执行 §1.1 同类坑的常驻守卫）：
 * buildShim / buildSillyTavernCompatRuntimeV2Shim 的产物是"模板字符串里嵌 JS 源码"。
 * 任何人在这些模板里直接写正则字面量或 `\n`/`\d` 类转义序列，都会被宿主模板
 * 吃掉反斜杠 → 生成的脚本文本非法 → 注入 iframe 后 SyntaxError，整段运行时静默死亡
 * （§1.1 的 [IMAGE-PROXY] 补丁事故、2026-09-30 P0 排障中两次踩中同一坑）。
 *
 * 本文件钉住：两大生成器的产物里**每一个内联 <script> 块**都必须能被 JS 引擎解析。
 *
 * [LEGACY-EXTERNAL 2026-10-18] 外部化后 buildShim 可能返回**两个** <script>
 * （引导数据 + 外部 <script src>）。旧版剥壳只处理「首个开标签 + 末个闭标签」，
 * 双标签产物会把中间的 `</script><script src=…>` 留在待解析文本里 → 误报失败。
 * 现改为逐个 script 块校验：带 src 的跳过（内容不在 srcdoc 里），
 * 外部资产源码本身另有一条独立用例。
 *
 * 运行: npx vitest run
 */
import { describe, it, expect } from 'vitest';
import * as vm from 'node:vm';
import { buildShim, buildSmartCardLegacyExternalScript } from '../helpers';
import { buildSillyTavernCompatRuntimeV2Shim } from '../SillyTavernCompatRuntime';

const FIXED_CONTEXT = {
  characterId: 'guard-character-0001',
  characterName: '守卫卡',
  userName: '测试用户',
  language: 'zh',
  messageId: 42,
  messageContent: '守卫消息',
  chatMessages: [
    { role: 'user', content: '你好' },
    { role: 'assistant', content: '你好呀' },
  ],
  persistedStorage: { localStorage: {}, sessionStorage: {} },
  firstMes: '初次见面',
  alternateGreetings: [],
  sessionId: 'guard-session-0001',
  variables: {},
  depth: 0,
  isInit: false,
  trustedNative: false,
  sourceFingerprint: 'guard-fingerprint',
  presentationMode: 'inline',
  viewport: null,
} as any;

/** 切出产物里所有**内联** <script> 的 body（带 src 的外链块内容不在 srcdoc 内，跳过）。 */
function extractInlineScripts(text: string): string[] {
  const re = /<script([^>]*)>([\s\S]*?)<\/script>/g;
  const bodies: string[] = [];
  let match: RegExpExecArray | null;
  while ((match = re.exec(String(text || '')))) {
    const attrs = match[1] || '';
    if (/\bsrc\s*=/.test(attrs)) continue;
    bodies.push(match[2] || '');
  }
  return bodies;
}

function parseOrThrow(name: string, inner: string, index: number): void {
  let err: SyntaxError | null = null;
  try {
    new vm.Script(inner, { filename: `${name}#${index}.generated.js` });
  } catch (e) {
    err = e as SyntaxError;
  }
  if (!err) return;
  const stack = String((err as Error).stack || '');
  const m = stack.match(/\.generated\.js:(\d+)/);
  const lineNo = m ? parseInt(m[1], 10) : 0;
  const lines = inner.split('\n');
  const context = lineNo > 0
    ? lines.slice(Math.max(0, lineNo - 3), lineNo + 1).map((l, i) => `L${lineNo - 2 + i}: ${l.slice(0, 200)}`).join('\n')
    : '';
  throw new Error(
    `${name} 第 ${index} 个内联脚本解析失败（模板字符串吃反斜杠类回归）: ${err.message}\n${context}`,
  );
}

function assertParsable(name: string, text: string): void {
  const bodies = extractInlineScripts(text);
  if (bodies.length === 0) throw new Error(`${name}: 产物里没有可校验的内联 <script> 块`);
  bodies.forEach((inner, index) => parseOrThrow(name, inner, index));
}

describe('生成脚本文本可解析性守卫', () => {
  it('buildShim 产物（srcdoc 脚本段）必须可解析', () => {
    assertParsable('buildShim', buildShim(FIXED_CONTEXT, 'guard-frame-0001'));
  });

  it('[LEGACY-EXTERNAL] buildShim 外部化产物的引导数据脚本必须可解析', () => {
    assertParsable(
      'buildShimExternal',
      buildShim(FIXED_CONTEXT, 'guard-frame-0001', {
        externalLegacyUrl: '/assets/palink-smart-card-legacy-deadbeef0000.js',
      }),
    );
  });

  it('[LEGACY-EXTERNAL] 外部 legacy 资产源码整体必须可解析（它是独立 .js 文件）', () => {
    const source = buildSmartCardLegacyExternalScript();
    parseOrThrow('legacyExternalAsset', source, 0);
    // 独立 .js 文件不能带 HTML 外壳（段内正文本身会拼 <script> 字符串，故只校验首尾）
    expect(/^\s*<script/i.test(source)).toBe(false);
    expect(/<\/script>\s*$/i.test(source)).toBe(false);
    expect(source.trimStart().startsWith('(() => {')).toBe(true);
    // 必须从引导对象取数据（否则外部化后 ctx/frameId 全是 undefined）
    expect(source).toContain('window.__palinkLegacyBoot__');
  });

  it('buildSillyTavernCompatRuntimeV2Shim 产物（兼容运行时段）必须可解析', () => {
    assertParsable(
      'compatRuntime',
      buildSillyTavernCompatRuntimeV2Shim({
        context: FIXED_CONTEXT,
        frameId: 'guard-frame-0001',
        sourceHtml: '<div></div>',
        mode: 'inline',
      } as any),
    );
  });
});
