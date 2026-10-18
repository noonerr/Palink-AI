/*
 * iframe 重建后 context 必须重投（去重签名重置）契约测试
 *
 * 背景（P0-CTX-REPLAY 2026-10-18）：
 *   postNow() 用 stableSmartCardStringify(context) 做去重，避免滚动/键盘等高频
 *   context-update 重复结构化克隆。但去重键存在 lastPostedContextSignatureRef 上，
 *   它**跨 iframe 文档生命周期存活**，而新文档的 message 监听器是全新实例 ——
 *   上一份文档收到的 context-update 不会随之迁移。
 *
 *   旧行为不显问题的唯一原因是：srcdoc 里内联了全量 characterExtensions / chatMessages，
 *   帧内即使一条 context-update 都没收到也"看起来正常"。
 *   [P0-SRCDOC-SLIM] 把这些数据移出 boot 后，context-update 成为唯一通道 ⇒
 *   不重置签名就会在「srcdoc 重建 / LRU 逐出唤醒 / 插件换文档」时静默丢数据。
 *
 * 本测试钉两件事：
 *   A. handleFrameLoad 里重置签名，且**在** postLiveContext 之前；
 *   B. 去重本身没被顺手删掉（否则高频 context-update 会重新变成性能问题）。
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const SRC = readFileSync(
  join(process.cwd(), 'src/components/ui/custom/CharacterCardRenderer.tsx'),
  'utf8',
);

/** 剥掉整行注释：防止「把代码注释掉」也能让 toContain 通过（改坏证明会假绿）。 */
function stripLineComments(source: string): string {
  return source
    .split('\n')
    .filter((line) => !/^\s*\/\//.test(line))
    .join('\n');
}

/** 从 `const <name> = useCallback(` 起按圆括号配平切出整个回调（含箭头函数体）。 */
function sliceCallback(source: string, name: string): string {
  const start = source.indexOf(`const ${name} = useCallback(`);
  expect(start, `未找到 ${name} 的 useCallback 定义`).toBeGreaterThan(-1);
  let i = source.indexOf('(', start);
  let depth = 0;
  for (; i < source.length; i += 1) {
    if (source[i] === '(') depth += 1;
    else if (source[i] === ')') {
      depth -= 1;
      if (depth === 0) break;
    }
  }
  return source.slice(start, i + 1);
}

describe('A handleFrameLoad 必须重置去重签名', () => {
  it('重置语句存在（注释掉不算）', () => {
    const body = stripLineComments(sliceCallback(SRC, 'handleFrameLoad'));
    expect(body).toContain("lastPostedContextSignatureRef.current = '';");
  });

  it('重置必须发生在 postLiveContext() 之前（否则补投仍被旧签名吃掉）', () => {
    const body = stripLineComments(sliceCallback(SRC, 'handleFrameLoad'));
    const resetAt = body.indexOf("lastPostedContextSignatureRef.current = '';");
    const postAt = body.indexOf('postLiveContext()');
    expect(resetAt).toBeGreaterThan(-1);
    expect(postAt).toBeGreaterThan(-1);
    expect(resetAt).toBeLessThan(postAt);
  });
});

describe('B 去重逻辑本身保留（不能为了修 A 把去重删掉）', () => {
  it('postNow 仍按 signature 提前 return', () => {
    expect(SRC).toContain('if (signature === lastPostedContextSignatureRef.current) return;');
  });

  it('signature 仍在投递后写回', () => {
    expect(SRC).toContain('lastPostedContextSignatureRef.current = signature;');
  });
});
