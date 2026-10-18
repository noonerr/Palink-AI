/*
 * srcdoc boot 载荷瘦身契约（P0-SRCDOC-SLIM 2026-10-18）
 *
 * 病灶实测（真机，角色 c28061bb，7 帧）：
 *   单帧 srcdoc 893,342 字节，其中
 *     · legacy shim 内联块 495,007（代码 ~135KB + ctx.characterExtensions 355,892）
 *     · compat v2 boot 内联块 359,544（几乎全是同一份 characterExtensions）
 *   ⇒ **同一份 extensions 被内联了两次，合计 711,784 = 79.6%**。
 *   而对同一角色的所有卡片，这份数据完全相同 ⇒ 纯冗余，且帧内已有一条
 *   全量 context-update 通道（父侧 handleFrameLoad → postLiveContext）。
 *
 * 本测试钉住四件事：
 *   A. 两个 shim 构建器都**不再**把 characterExtensions 写进 srcdoc；
 *   B. 不能顺手把别的小字段也删掉（用 worldbookName / variables 作哨兵）；
 *   C. 帧内自愈路径仍在（refreshDerivedContextStoresCompat 重算 regex 与 primaryCharacter）；
 *   D. 父侧仍把 characterExtensions 放进 liveContext（否则永远补不回来）。
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { buildShim } from '../helpers';
import { buildSillyTavernCompatRuntimeV2Shim } from '../SillyTavernCompatRuntime';

const EXT_SENTINEL = 'SENTINEL-EXT-VALUE-9f3a';
const WB_SENTINEL = 'SENTINEL-WORLDBOOK-4c7d';

const CTX = {
  characterId: 'c1',
  characterName: '卡',
  userName: '用户',
  language: 'zh',
  worldbookName: WB_SENTINEL,
  characterExtensions: {
    palink_raw_card_data: EXT_SENTINEL,
    regex_scripts: [{ scriptName: EXT_SENTINEL }],
  },
  globalRegexScripts: [],
  variables: { stat_data: { 好感度: 1 } },
  persistedStorage: { localStorage: {}, sessionStorage: {} },
  alternateGreetings: [],
  firstMes: '',
  sessionId: 's1',
} as any;

function buildCompat(): string {
  return buildSillyTavernCompatRuntimeV2Shim({
    context: CTX,
    frameId: 'slim-frame-0001',
    sourceHtml: '<div></div>',
    mode: 'inline',
  } as any);
}

describe('A 两个构建器都不再把 characterExtensions 写进 srcdoc', () => {
  it('buildShim（legacy 段，内联路径）', () => {
    const out = buildShim(CTX, 'slim-frame-0001');
    expect(out).not.toContain('"characterExtensions"');
    expect(out).not.toContain(EXT_SENTINEL);
  });

  it('buildShim（legacy 段，外部化路径的引导数据）', () => {
    const out = buildShim(CTX, 'slim-frame-0001', {
      externalLegacyUrl: '/assets/palink-smart-card-legacy-deadbeef0000.js',
    });
    expect(out).not.toContain('"characterExtensions"');
    expect(out).not.toContain(EXT_SENTINEL);
  });

  it('buildSillyTavernCompatRuntimeV2Shim（compat v2 boot）', () => {
    const out = buildCompat();
    expect(out).not.toContain('"characterExtensions"');
    expect(out).not.toContain(EXT_SENTINEL);
  });
});

describe('B 其它小字段必须保留（防过度删减）', () => {
  it('buildShim 仍内联 worldbookName（帧内同步 API 首帧要用）', () => {
    expect(buildShim(CTX, 'slim-frame-0001')).toContain(`"worldbookName":"${WB_SENTINEL}"`);
  });

  it('buildShim 仍内联 variables（MVU 首帧 stat_data）', () => {
    expect(buildShim(CTX, 'slim-frame-0001')).toContain('好感度');
  });

  it('compat v2 boot 仍内联 worldbookName', () => {
    expect(buildCompat()).toContain(`"worldbookName":"${WB_SENTINEL}"`);
  });
});

describe('C 帧内自愈路径仍在（extensions 由 context-update 补齐后必须重算派生值）', () => {
  const body = readFileSync(
    join(process.cwd(), 'src/components/ui/custom/smart-card-runtime/runtime-body/part-05.ts'),
    'utf8',
  );

  it('refreshDerivedContextStoresCompat 仍从 ctx.characterExtensions 重算 regex 脚本', () => {
    expect(body).toContain('const refreshDerivedContextStoresCompat = () => {');
    expect(body).toContain('scopedRegexScripts = normalizeRegexListCompat(ctx.characterExtensions);');
  });

  it('同一函数仍重算 primaryCharacter.data.extensions（getContext().characters[0] 的唯一来源）', () => {
    expect(body).toContain('primaryCharacter.data.extensions = extensions;');
  });

  it('context-update 到达时会调用它', () => {
    const part06 = readFileSync(
      join(process.cwd(), 'src/components/ui/custom/smart-card-runtime/runtime-body/part-06.ts'),
      'utf8',
    );
    expect(part06).toContain('Object.assign(ctx, clone(nextContext));');
    expect(part06).toContain('refreshDerivedContextStoresCompat();');
  });
});

describe('D 父侧仍下发 characterExtensions（唯一补数通道）', () => {
  const src = readFileSync(
    join(process.cwd(), 'src/components/ui/custom/CharacterCardRenderer.tsx'),
    'utf8',
  );

  it('liveContext 带 characterExtensions', () => {
    expect(src).toContain('characterExtensions: context.characterExtensions,');
  });

  it('postContextToFrame 仍投递 liveContext', () => {
    expect(src).toContain('postContextToFrame(liveContext, true)');
  });
});
