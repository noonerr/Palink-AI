/**
 * 守卫包装：把 scripts/docs/st-gap-ledger-reconcile.mjs 的结论钉进前端门禁。
 *
 * 本文件不重复实现任何解析逻辑 —— 全部口径以那个脚本为唯一来源，
 * 这里只做两件事：① 断言"必须成立的结构不变量"；② 把**已知的守卫漏列**记成债务白名单。
 *
 * 为什么 ③ 用白名单而不是直接断言绿（本批的诚实边界，报告里也写了）：
 * 2026-10-20 批次F 的任务是"只读对账"，明令不许改判、不许动守卫；
 * 而现状 ③ 本来就是红的（守卫 D 名单只列了 24 个键，D 类实测 51 个）。
 * 若这里直接 expect(ok).toBe(true)，门禁会恒红 ⇒ 恒红的门禁等于没有门禁。
 * 所以：**新增漏列 ⇒ 必红**（这正是"少算 10 个键"那次事故的形态），**漏列减少 ⇒ 允许**
 * （说明有人补了守卫，属改进；但必须在报告里记一笔）。
 */
import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SCRIPT_NAME = 'st-gap-ledger-reconcile.mjs';

function locateScript(): string {
  let dir = path.dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i < 12; i += 1) {
    const candidate = path.join(dir, 'scripts', 'docs', SCRIPT_NAME);
    if (fs.existsSync(candidate)) return candidate;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  throw new Error('找不到 ' + SCRIPT_NAME + '（对账脚本被移走或改名了）');
}

type ReconCheck = { level: 'PASS' | 'WARN' | 'FAIL'; check: string; message: string; detail?: unknown };
type ReconReport = {
  ok: boolean;
  counts: { A: number; C: number; D: number; total: number };
  results: ReconCheck[];
  gaps: Array<{ family: string; familySize: number; missing: string[] }>;
};

const SCRIPT = locateScript();
const RUN = spawnSync(process.execPath, [SCRIPT, '--json'], { encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 });

// 脚本的 JSON 形状由脚本自己保证（它是唯一口径来源）；这里只声明用到的字段。
let report: ReconReport | null = null;
let parseError = '';
try {
  report = JSON.parse(RUN.stdout) as ReconReport;
} catch (e) {
  parseError = String((e as Error).message);
}

/** 已知的守卫漏列（2026-10-20 批次F 只读对账时的现状，逐键来自包H §3 D 族表）。 */
const KNOWN_GUARD_GAPS = [
  // 音频播放器族 5/8 漏
  'appendAudioList', 'getCurrentAudio', 'pauseAudio', 'replaceAudioList', 'setAudioSettings',
  // 预设体系族 10/16 漏
  'builtin_prompt_default_order', 'createOrReplacePreset', 'createPreset', 'deletePreset',
  'getPresetNames', 'getProxyPresetNames', 'importRawPreset', 'renamePreset', 'replacePreset',
  'updatePresetWith',
  // tavern regex 族 3/5 漏
  'isCharacterTavernRegexesEnabled', 'replaceTavernRegexes', 'updateTavernRegexesWith',
  // 扩展安装族 5/9 漏
  'getExtensionStatus', 'getExtensionType', 'reinstallExtension', 'uninstallExtension',
  'updateExtension',
  // 原始对象导入器 1/2 漏
  'importRawTavernRegex',
  // 预设提示词类型判定 3/3 漏
  'isPresetNormalPrompt', 'isPresetPlaceholderPrompt', 'isPresetSystemPrompt',
];

const checks = (prefix: string): ReconCheck[] =>
  (report ? report.results.filter((r) => r.check.indexOf(prefix) === 0) : []);

describe('ST-GAP 总账对账（脚本 → 门禁）', () => {
  it('对账脚本可跑，且 --json 输出可解析（rc 为 1 也要有 stdout：不平是结论，不是崩溃）', () => {
    expect(parseError, 'JSON 解析失败：' + parseError + '\nstderr=' + RUN.stderr).toBe('');
    expect(report, '脚本没有输出 JSON').not.toBeNull();
    expect(Array.isArray(report!.results)).toBe(true);
    expect(report!.results.length).toBeGreaterThan(4);
    // 输入/解析级异常（exit 2 语义）不许混进"不平"里 —— 那种情况 stdout 也不该有完整 JSON。
    expect(RUN.status === 0 || RUN.status === 1, '退出码只能是 0/1，实际 ' + RUN.status).toBe(true);
  });

  it('② 分类闭合：A+C+D = 134 且键名零重复（结构性硬断言，任何一族改判都必须重新闭合）', () => {
    const hit = checks('② 分类闭合');
    expect(hit.length, '脚本没有输出 ② 的结论').toBeGreaterThan(0);
    hit.forEach((c) => expect(c.level, '② 必须绿：' + JSON.stringify(c.detail)).toBe('PASS'));
    expect(report!.counts.total).toBe(134);
    expect(report!.counts.A + report!.counts.C + report!.counts.D).toBe(134);
    // A 类是"已在场"，不该被任何改判动过（动了就是有人把已实现的键又当缺口算）。
    expect(report!.counts.A).toBe(13);
  });

  it('① 台账 id 与 ST_GAP_IDS 双向对齐，且没有空壳 id', () => {
    const hit = checks('① 台账可用');
    expect(hit.length, '脚本没有输出 ① 的结论').toBeGreaterThan(0);
    hit.forEach((c) => expect(c.level, '① 必须绿：' + JSON.stringify(c.detail)).toBe('PASS'));
  });

  it('④ ST_GAP_BY_NAME 的每个名字都落在 134 分母或斜杠命令形状上，且 id 都在 ST_GAP_IDS 里', () => {
    const hit = checks('④ 名字表');
    expect(hit.length, '脚本没有输出 ④ 的结论').toBeGreaterThan(0);
    hit.forEach((c) => expect(c.level, '④ 必须绿：' + JSON.stringify(c.detail)).toBe('PASS'));
  });

  it('③ 守卫漏列只允许是已记录的债务：新增一个漏列键 ⇒ 本用例必红', () => {
    const hit = checks('③ 守卫漏列');
    expect(hit.length, '脚本没有输出 ③ 的结论').toBeGreaterThan(0);
    const gaps: string[] = (report!.gaps || []).flatMap((g) => g.missing);
    const newGaps = gaps.filter((k) => KNOWN_GUARD_GAPS.indexOf(k) < 0);
    expect(
      newGaps,
      '守卫（D 名单 ∪ 正向锚点）新漏了这些 D 类键，它们将来被塞成空壳时守卫看不见：'
        + newGaps.join(', ') + '\n完整漏列：' + JSON.stringify(report!.gaps, null, 2),
    ).toEqual([]);
    // 反过来：脚本判"不平"这件事本身要能被看见（不是悄悄绿掉）。
    if (gaps.length) {
      expect(hit[0].level, '有漏列却判了 PASS，说明脚本逻辑被改坏了').toBe('FAIL');
    }
  });

  it('③b 守卫自身不过期：D 名单里不许出现已归 C/A 的键（锚点里不许出现仍归 D 的键）', () => {
    const hit = checks('③b 守卫自身过期');
    expect(hit.length).toBeGreaterThan(0);
    hit.forEach((c) => expect(c.level, c.check + '：' + JSON.stringify(c.detail)).toBe('PASS'));
  });
});
