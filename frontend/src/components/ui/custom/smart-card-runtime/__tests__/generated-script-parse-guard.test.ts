/*
 * 生成脚本文本可解析性守卫
 *
 * 背景（2026-09-30，HANDOFF_卡片正文空白与卡脚本执行 §1.1 同类坑的常驻守卫）：
 * buildShim / buildSillyTavernCompatRuntimeV2Shim 的产物是"模板字符串里嵌 JS 源码"。
 * 任何人在这些模板里直接写正则字面量或 `\n`/`\d` 类转义序列，都会被宿主模板
 * 吃掉反斜杠 → 生成的脚本文本非法 → 注入 iframe 后 SyntaxError，整段运行时静默死亡
 * （§1.1 的 [IMAGE-PROXY] 补丁事故、2026-09-30 P0 排障中两次踩中同一坑）。
 *
 * 本文件钉住：两大生成器的产物剥掉 <script> 外壳后必须能被 JS 引擎解析。
 *
 * 运行: npx vitest run
 */
import { describe, it, expect } from 'vitest';
import * as vm from 'node:vm';
import { buildShim } from '../helpers';
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

function assertParsable(name: string, text: string) {
  // 生成文本带 <script ...> ... </script> 外壳（真实 srcdoc 原样嵌入），解析前剥壳
  const inner = String(text || '')
    .replace(/^\s*<script[^>]*>/, '')
    .replace(/<\/script>\s*$/, '');
  let err: SyntaxError | null = null;
  try {
    new vm.Script(inner, { filename: name + '.generated.js' });
  } catch (e) {
    err = e as SyntaxError;
  }
  if (err) {
    const stack = String((err as Error).stack || '');
    const m = stack.match(new RegExp(name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\.generated\\.js:(\\d+)'));
    const lineNo = m ? parseInt(m[1], 10) : 0;
    const lines = inner.split('\n');
    const ctx = lineNo > 0
      ? lines.slice(Math.max(0, lineNo - 3), lineNo + 1).map((l, i) => `L${lineNo - 2 + i}: ${l.slice(0, 200)}`).join('\n')
      : '';
    throw new Error(`${name} 生成脚本文本解析失败（模板字符串吃反斜杠类回归）: ${err.message}\n${ctx}`);
  }
}

describe('生成脚本文本可解析性守卫', () => {
  it('buildShim 产物（srcdoc 脚本段）必须可解析', () => {
    assertParsable('buildShim', buildShim(FIXED_CONTEXT, 'guard-frame-0001'));
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
