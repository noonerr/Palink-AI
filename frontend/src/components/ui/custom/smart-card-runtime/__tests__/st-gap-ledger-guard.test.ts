/*
 * 向 ST 学习的缺口台账 ↔ 代码 双向守门（台账 §1 的第 1、3 件事）
 *
 * 台账：docs/_active/spec/SPEC_向ST学习的子系统缺口与标记方案_2026-10-19.md
 * 代码：frontend/src/components/ui/custom/smart-card-runtime/palink-diag.ts 的 ST_GAP_* 表
 *
 * 钉五件事，任何一条断=台账与代码开始互相骗：
 *   A. 台账 §2 表的 id 清单 == 代码 ST_GAP_IDS（**双向**：台账有而代码没 ⇒ 红；代码有而台账没记 ⇒ 也红）。
 *   B. 每个 id 在源码里至少有一个 `// [ST-GAP:<id>]` token；源码里出现的每个 token 都在台账里。
 *   C. 归类表的键名逐条来自两份已入库报告的权威名单（th134 fixture / st289 fixture），
 *      写错一个字、或凭空加一个名字都会红 —— 这条是防"照表盲补"的。
 *   D. 包H §3 表里每一行 D 类键，都必须能被归类到一个 id（不许静默落 unknown）。
 *   E. 运行时字段与排行：host_capability 记录自动带 missingStSubsystem，
 *      排行按事件数累计，非 host_capability 不参与（不把兼容层自己的 bug 混进"哪口井被踩到"）。
 *
 * 运行: npx vitest run src/components/ui/custom/smart-card-runtime/__tests__/st-gap-ledger-guard.test.ts
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  ST_GAP_IDS,
  ST_GAP_BY_NAME,
  ST_GAP_UNKNOWN,
  classifyStGap,
  recordPalinkDiag,
  resetPalinkDiagForTest,
  setPalinkDiagEnabled,
  palinkDiagStGapRanking,
  palinkDiagDump,
  palinkDiagTotals,
} from '../palink-diag';
import th134Fixture from './fixtures/th134-names.json';
import st289Fixture from '@/lib/slash-engine/__tests__/fixtures/st289-names.json';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..', '..', '..', '..', '..', '..', '..');
const LEDGER = path.join(repoRoot, 'docs/_active/spec/SPEC_向ST学习的子系统缺口与标记方案_2026-10-19.md');
const H_REPORT = path.join(repoRoot, 'docs/_active/report/REPORT_包H_TavernHelper广度_2026-10-18.md');
const read = (p: string) => readFileSync(p, 'utf8');

/** 递归收集待扫源码（跳过 __tests__ / 构建产物 / 备份区），用于 token 双向检查。 */
function collectSourceFiles(dir: string, out: string[] = []): string[] {
  if (!existsSync(dir)) return out;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === 'node_modules' || entry.name === 'dist' || entry.name === '__tests__' || entry.name.startsWith('_BACKUPS')) continue;
      collectSourceFiles(full, out);
    } else if (/\.(ts|tsx|py)$/.test(entry.name)) {
      out.push(full);
    }
  }
  return out;
}

const SCANNED = [
  ...collectSourceFiles(path.join(repoRoot, 'frontend/src')),
  ...collectSourceFiles(path.join(repoRoot, 'backend/app')),
];

/** 台账 §2 表第一列的 id（形如 | `wb_delete` | ...）。 */
function ledgerIds(): string[] {
  const text = read(LEDGER);
  const ids: string[] = [];
  for (const line of text.split(/\r?\n/)) {
    const m = /^\|\s*`([a-z][a-z0-9_]*)`\s*\|/.exec(line);
    if (m) ids.push(m[1]);
  }
  return ids;
}

/** 源码里出现过的 ST-GAP token id（去重）。 */
function tokenIds(): string[] {
  const found = new Set<string>();
  for (const file of SCANNED) {
    const text = read(file);
    for (const m of text.matchAll(/ST-GAP:([a-z][a-z0-9_]*)/g)) found.add(m[1]);
  }
  return Array.from(found);
}

const authoritativeNames = new Set<string>([
  ...(th134Fixture as { names: string[] }).names,
  ...(st289Fixture as string[]),
]);

describe('A 台账 id 清单 ↔ 代码 ST_GAP_IDS', () => {
  it('台账 §2 读得到 id（文件被搬走时先红在这里，别往下猜）', () => {
    expect(existsSync(LEDGER), `台账文件不存在：${LEDGER}`).toBe(true);
    expect(ledgerIds().length).toBeGreaterThanOrEqual(14);
  });

  it('台账里的每个 id 都在代码清单里（防"台账有、代码没标"）', () => {
    const missing = ledgerIds().filter((id) => !(ST_GAP_IDS as readonly string[]).includes(id));
    expect(missing, `这些 id 台账记了但 palink-diag.ts 没标：${missing.join(', ')}`).toEqual([]);
  });

  it('代码里的每个 id 都在台账里（防"代码标了、台账没记"）', () => {
    const extra = (ST_GAP_IDS as readonly string[]).filter((id) => !ledgerIds().includes(id));
    expect(extra, `这些 id 代码有但台账 §2 没行：${extra.join(', ')}`).toEqual([]);
  });

  it('代码清单无重复', () => {
    expect(new Set(ST_GAP_IDS).size).toBe(ST_GAP_IDS.length);
  });
});

describe('B [ST-GAP:<id>] token 双向在场', () => {
  it('被扫描的源码目录不为空（扫描落空会伪装成全绿）', () => {
    expect(SCANNED.length, '一个源码文件都没扫到 ⇒ 扫描根目录写错了').toBeGreaterThan(50);
  });

  it('台账每个 id 至少有一处 token（jailbreak_slot 这类"装配链槽位"也要留可 grep 的标）', () => {
    const tokens = tokenIds();
    const unmarked = ledgerIds().filter((id) => !tokens.includes(id));
    expect(unmarked, `这些 id 没有任何 // [ST-GAP:<id>] 标记：${unmarked.join(', ')}`).toEqual([]);
  });

  it('每处 token 的 id 都在台账里（防自造 id）', () => {
    const ids = ledgerIds();
    const stray = tokenIds().filter((id) => !ids.includes(id));
    expect(stray, `代码里有 token 但台账没这一行：${stray.join(', ')}`).toEqual([]);
  });
});

describe('C 归类表键名必须来自权威名单', () => {
  const names = Object.keys(ST_GAP_BY_NAME);

  it('归类表非空且每条都指向清单内的 id（不许指到没登记的 id）', () => {
    expect(names.length).toBeGreaterThan(60);
    const bad = names.filter((n) => !(ST_GAP_IDS as readonly string[]).includes(ST_GAP_BY_NAME[n]));
    expect(bad, `这些名字指向未登记的 id：${bad.join(', ')}`).toEqual([]);
  });

  it('每个键名都在 th134 或 st289 权威名单里（写错字/凭空加名即红）', () => {
    const unknown = names.filter((n) => !authoritativeNames.has(n));
    expect(unknown, `这些名字不在两份权威名单里：${unknown.join(', ')}`).toEqual([]);
  });

  it('两份权威名单各覆盖一侧，且没有名字同时属于两侧（重名会让归属变成猜）', () => {
    const th134 = new Set((th134Fixture as { names: string[] }).names);
    const st289 = new Set(st289Fixture as string[]);
    const inTh = names.filter((n) => th134.has(n));
    const inCmd = names.filter((n) => st289.has(n));
    expect(inTh.length, 'TavernHelper 侧一条都没归到 ⇒ fixture 或表名变了').toBeGreaterThanOrEqual(50);
    expect(inCmd.length, 'slash 侧一条都没归到 ⇒ fixture 或表名变了').toBeGreaterThanOrEqual(15);
    const both = names.filter((n) => th134.has(n) && st289.has(n));
    expect(both, `这些名字同时在两份名单里，归属会歧义：${both.join(', ')}`).toEqual([]);
  });
});

describe('D 包H 的 D 类键不得静默落 unknown', () => {
  it('REPORT_包H §3 表里每一行 D 类键都能归类到 id', () => {
    expect(existsSync(H_REPORT)).toBe(true);
    const text = read(H_REPORT);
    const section = text.slice(text.indexOf('## 3.'), text.indexOf('### 3.1'));
    const dNames: string[] = [];
    for (const line of section.split(/\r?\n/)) {
      const cells = line.split('|').map((c) => c.trim());
      if (cells.length < 6 || cells[1] !== 'D') continue;
      for (const m of cells[4].matchAll(/`([A-Za-z_][\w$-]*)`/g)) dNames.push(m[1]);
    }
    expect(dNames.length, '包H 报告 §3 的 D 行没解析出来 ⇒ 表格格式变了，本守卫该跟着改').toBeGreaterThanOrEqual(60);
    const unclassified = dNames.filter((n) => classifyStGap({ owner: 'host_capability', kind: 'tavernhelper_key_unimplemented', name: n }) === ST_GAP_UNKNOWN);
    expect(unclassified, `这些 D 类键没归到任何族：${unclassified.join(', ')}`).toEqual([]);
  });
});

describe('E 运行时字段与缺口排行', () => {
  beforeEach(() => {
    resetPalinkDiagForTest();
    setPalinkDiagEnabled(true, false);
  });
  afterEach(() => resetPalinkDiagForTest());

  it('host_capability 自动归类：全名前缀会被剥掉', () => {
    expect(classifyStGap({ owner: 'host_capability', kind: 'tavernhelper_key_unimplemented', name: 'TavernHelper.deleteLorebook' })).toBe('wb_delete');
    expect(classifyStGap({ owner: 'host_capability', kind: 'tavernhelper_key_unimplemented', name: 'deleteWorldbook' })).toBe('wb_delete');
    expect(classifyStGap({ owner: 'host_capability', kind: 'slash_command_unimplemented', name: 'persona-create' })).toBe('persona_crud');
    expect(classifyStGap({ owner: 'host_capability', kind: 'missing_api', name: 'whatever-we-have-not-mapped' })).toBe(ST_GAP_UNKNOWN);
  });

  it('非 host_capability 不参与聚合（归属口径不被污染）', () => {
    expect(classifyStGap({ owner: 'frame_compat', kind: 'script_error', name: 'deleteLorebook' })).toBe('');
    expect(classifyStGap({ owner: 'card_authored', kind: 'card_script_injection_failed', name: 'RawCharacter' })).toBe('');
  });

  it('记录带字段，同名合并只算一条记录、但事件数累加', () => {
    recordPalinkDiag({ owner: 'host_capability', kind: 'tavernhelper_key_unimplemented', name: 'TavernHelper.playAudio' });
    recordPalinkDiag({ owner: 'host_capability', kind: 'tavernhelper_key_unimplemented', name: 'TavernHelper.playAudio' });
    recordPalinkDiag({ owner: 'host_capability', kind: 'tavernhelper_key_unimplemented', name: 'TavernHelper.playAudio' });
    recordPalinkDiag({ owner: 'host_capability', kind: 'tavernhelper_key_unimplemented', name: 'TavernHelper.getPersona' });
    const recs = palinkDiagStGapRanking();
    expect(recs).toHaveLength(2);
    expect(recs[0]).toEqual({ id: 'audio_player', records: 1, events: 3 });
    expect(recs[1].id).toBe('persona_crud');
    expect(palinkDiagTotals()['stGap:audio_player']).toBe(1);
    expect(palinkDiagTotals()['stGap:persona_crud']).toBe(1);
  });

  it('导出 JSON 里排行与每条记录的字段都在（下载即成品，不需要再算）', () => {
    recordPalinkDiag({ owner: 'host_capability', kind: 'slash_command_unimplemented', name: 'extension-toggle' });
    recordPalinkDiag({ owner: 'frame_compat', kind: 'global_shape_absent', name: 'window.context' });
    const dump = JSON.parse(palinkDiagDump());
    expect(dump.stGapRanking).toEqual([{ id: 'ext_install', records: 1, events: 1 }]);
    const byKind = dump.records.reduce((acc: Record<string, string>, r: { kind: string; missingStSubsystem: string }) => {
      acc[r.kind] = r.missingStSubsystem;
      return acc;
    }, {});
    expect(byKind.slash_command_unimplemented).toBe('ext_install');
    expect(byKind.global_shape_absent).toBe('');
  });

  it('显式传入的 id 优先于自动归类（后端侧将来自己打标时用得上）', () => {
    const rec = recordPalinkDiag({ owner: 'host_capability', kind: 'missing_api', name: 'deleteLorebook', missingStSubsystem: 'chat_binding' });
    expect(rec?.missingStSubsystem).toBe('chat_binding');
  });
});
