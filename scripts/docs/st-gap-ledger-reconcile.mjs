#!/usr/bin/env node
/**
 * ST-GAP 总账对账（纯只读）—— 批次F 2026-10-20
 *
 * 为什么要这个文件：2026-10-20 连出两起同源事故 —— 改判只按"守卫列了谁"移键，
 * 而守卫名单自己漏列，权威计数被少算 10 个键（见 REPORT_包H §3 的"主脑复验再订正"段、
 * 提交 c3c5639）。人肉对账不可持续，本脚本把五份权威摆在一张表上，不平就 exit 1。
 *
 * 五份权威（只读，任何一份改了都要能在这里看见）：
 *   1. 台账族表   docs/_active/spec/SPEC_向ST学习的子系统缺口与标记方案_2026-10-19.md §2
 *   2. 包H 族表   docs/_active/report/REPORT_包H_TavernHelper广度_2026-10-18.md §3（含订正段，以最后一条为准）
 *   3. 代码归类   frontend/src/components/ui/custom/smart-card-runtime/palink-diag.ts
 *   4. 守卫名单   frontend/.../__tests__/h-tavernhelper-134-contract.test.ts（D 名单 + 正向锚点）
 *   5. 权威分母   frontend/.../__tests__/fixtures/th134-names.json（134）
 *
 * ⚠️ 本脚本**不改判、不改任何文件**。发现不平只打印 + exit 1，由主脑定（改判要三层同批）。
 *
 * 用法：
 *   node scripts/docs/st-gap-ledger-reconcile.mjs          # 人读
 *   node scripts/docs/st-gap-ledger-reconcile.mjs --json   # 机器读（vitest 包装用）
 * 退出码：0 = 四条断言全过（含 0 条 FAIL）；1 = 有 FAIL；2 = 输入/解析失败（也是红，别当没事）
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..', '..');

const REL = {
  ledger: 'docs/_active/spec/SPEC_向ST学习的子系统缺口与标记方案_2026-10-19.md',
  reportH: 'docs/_active/report/REPORT_包H_TavernHelper广度_2026-10-18.md',
  diag: 'frontend/src/components/ui/custom/smart-card-runtime/palink-diag.ts',
  guard: 'frontend/src/components/ui/custom/smart-card-runtime/__tests__/h-tavernhelper-134-contract.test.ts',
  fixture: 'frontend/src/components/ui/custom/smart-card-runtime/__tests__/fixtures/th134-names.json',
  // 2026-10-21 主脑修正：斜杠侧权威名单一直住在 slash-engine 的 fixture 目录里（289 键），
  // 本脚本此前指错到 smart-card-runtime 目录 ⇒ ④c 长期误报"分母缺失"。
  slashFixture: 'frontend/src/lib/slash-engine/__tests__/fixtures/st289-names.json',
};

const results = [];
function add(level, check, message, detail) {
  results.push({ level, check, message, detail: detail || null });
}
const fail = (check, message, detail) => add('FAIL', check, message, detail);
const warn = (check, message, detail) => add('WARN', check, message, detail);
const pass = (check, message) => add('PASS', check, message);

function readRel(rel) {
  const abs = path.join(ROOT, rel);
  if (!fs.existsSync(abs)) {
    throw new Error('缺少权威文件：' + rel);
  }
  return fs.readFileSync(abs, 'utf8');
}
const norm = (s) => String(s || '').split('*').join('').split('`').join('');
const uniq = (arr) => Array.from(new Set(arr));
const sortName = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

// ---------------------------------------------------------------- 1. 分母 134
const fixture = JSON.parse(readRel(REL.fixture));
const names134 = fixture.names;
const set134 = new Set(names134);
if (names134.length !== 134 || set134.size !== 134) {
  fail('fixture', 'fixture 不是 134 个唯一键', { count: names134.length, uniq: set134.size });
} else {
  pass('fixture', '权威分母 th134-names.json = 134 个唯一键');
}

// ---------------------------------------------------------------- 2. 包H §3 族表
const hLines = readRel(REL.reportH).split(/\r?\n/);
const families = []; // {line, cls, label, declared, keys}
hLines.forEach((line, idx) => {
  const m = /^\|\s*([ACD])\s*\|/.exec(line);
  if (!m) return;
  const cells = line.split('|');
  const label = (cells[2] || '').trim();
  const declaredCell = (cells[3] || '').trim();
  const declared = Number.parseInt(declaredCell.replace(/[^0-9]/g, ''), 10);
  const keys = uniq((cells[4] || '').match(/`([A-Za-z_$][A-Za-z0-9_$]*)`/g) || []);
  families.push({
    line: idx + 1,
    cls: m[1],
    label,
    declared: Number.isFinite(declared) ? declared : -1,
    keys: keys.map((k) => k.split('`')[1]),
  });
});
if (families.length < 20) {
  fail('reportH', '§3 族表解析行数异常（< 20），文档结构可能变了', { rows: families.length });
}

// 每行声明的键数必须等于该行真正列出的键名数（防"数了 7 个只写 5 个名字"）
for (const f of families) {
  if (f.declared !== f.keys.length) {
    fail('reportH', '族表行声明数与实际键名数不符：' + f.label, {
      line: f.line, declared: f.declared, listed: f.keys.length,
      missing: f.declared > f.keys.length ? '该行少列了 ' + (f.declared - f.keys.length) + ' 个键名' : '该行多列了',
    });
  }
}

const baseA = uniq(families.filter((f) => f.cls === 'A').flatMap((f) => f.keys));
const baseC = uniq(families.filter((f) => f.cls === 'C').flatMap((f) => f.keys));
const baseD = uniq(families.filter((f) => f.cls === 'D').flatMap((f) => f.keys));
const familyOf = new Map(); // key -> family label
for (const f of families) for (const k of f.keys) familyOf.set(k, f.label);

// ---------------------------------------------------------------- 3. 订正段（以最后一条为准）
// 订正不是"我判的"，是**逐条抄报告**。每条都带行号 + 必须命中的原文片段：
// 报告一旦改写（行号/措辞对不上），这里立刻红，逼人来核，而不是静默用旧口径。
const MOVES = [
  {
    id: '包AA C：registerMacroLike D→C',
    cite: { lines: [68, 78], expect: ['registerMacroLike 一个键从 D 挪到 C', 'C = 45 → 46', 'D = 76 → 75'] },
    mode: 'keys', from: 'D', to: 'C', keys: ['registerMacroLike'],
  },
  {
    id: '批次A：写桥四键 D→C',
    cite: { lines: [80, 91], expect: ['再挪 4 个键', 'C = 46 → 50', 'D = 75 → 71', 'deleteWorldbook', 'rebindCharWorldbooks'] },
    mode: 'keys', from: 'D', to: 'C',
    keys: ['deleteWorldbook', 'deleteLorebook', 'setCurrentCharLorebooks', 'rebindCharWorldbooks'],
  },
  {
    id: '批次B 段①：人设三键 D→C（后被主脑订正为整族 11 键）',
    cite: { lines: [159, 167], expect: ['再挪 3 个键', 'C 50 → 53', 'D 71 → 68'] },
    mode: 'keys', from: 'D', to: 'C', keys: ['getPersona', 'createPersona', 'getCurrentPersonaId'],
  },
  {
    id: '批次B 段②：角色库五键 D→C（后被主脑订正为整族 7 键）',
    cite: { lines: [169, 171], expect: ['再挪 5 个键', 'C 53 → 58', 'D 68 → 63'] },
    mode: 'keys', from: 'D', to: 'C',
    keys: ['createCharacter', 'deleteCharacter', 'replaceCharacter', 'importRawCharacter', 'RawCharacter'],
  },
  {
    // 主脑复验的订正：按**报告族表**整族移，不按守卫列了谁移。
    // 这是本脚本存在的理由 —— 上两条只挪了 3+5，族表是 11+7，少算 10 个键。
    id: '主脑复验：人设整族 11 键 D→C',
    cite: { lines: [172, 183], expect: ['少算了 10 个键', '人设族是 11 键', '角色库写侧族是 7 键', 'C 50 → 68', 'D 71 → 53'] },
    mode: 'family', from: 'D', to: 'C', familyMatch: 'ST 人设（persona）体系', expectCount: 11,
  },
  {
    id: '主脑复验：角色库写侧整族 7 键 D→C',
    cite: { lines: [172, 183], expect: ['角色库写侧族是 7 键', 'C 50 → 68', 'D 71 → 53'] },
    mode: 'family', from: 'D', to: 'C', familyMatch: 'ST 角色库写侧', expectCount: 7,
  },
  {
    // §7.2：实现期核实"没有宿主写通道"，C 改判 D 的 11 个键（报告里点名了族）。
    id: '§7.2 实现期改判：无宿主写通道 C→D',
    cite: { lines: [321, 332], expect: ['报告初稿把 14 个键标成 C，实现期核实为无宿主写通道', 'setCurrentCharLorebooks', 'getTavernRegexes', 'importRawWorldbook', 'getAllEnabledScriptButtons', 'getModelList', 'rotateChatMessages'] },
    mode: 'keys', from: 'C', to: 'D',
    keys: ['setCurrentCharLorebooks', 'rebindCharWorldbooks',
      'getTavernRegexes', 'replaceTavernRegexes', 'updateTavernRegexesWith',
      'isCharacterTavernRegexesEnabled', 'formatAsTavernRegexedString',
      'importRawWorldbook', 'getAllEnabledScriptButtons', 'getModelList', 'rotateChatMessages'],
  },
  {
    // 批次Q1（2026-10-21）：用户第三次裁定把"未授信一律 opaque"改成"分场合放开"
    // ⇒ 原 D 类理由对本机档不再成立，且帧内真实现当天落地（part-07 th134RetrieveDisplayedMessage）。
    // 订正段在报告 §8（追加在文末，不动前面任何行号）。
    id: '批次Q1：retrieveDisplayedMessage D→C',
    cite: { lines: [352, 372], expect: ['订正（2026-10-21，批次Q1）', 'retrieveDisplayedMessage 一个键从 D 挪到 C', 'C = 70 → 71', 'D = 51 → 50', '13 + 71 + 50 = 134'] },
    mode: 'keys', from: 'D', to: 'C', keys: ['retrieveDisplayedMessage'],
  },
  {
    // 批次P2（2026-10-21）：预设**读类**三键。数据源是 P2-2 新落的"全局选中名"
    // （UserSetting.silly_tavern_settings 的 palink_prompt_preset.selected_name，零迁移）
    // + P-1 的会话覆盖层；帧内三成员 → 父侧 dispatchSmartCardPresetAction。
    // 订正段在报告 §9（同样追加在文末）。isPreset* 三键**不在**本条里：
    // 缺的是判定字段（marker/system_prompt/injection_position），不是通道 ⇒ 仍 D。
    id: '批次P2：预设读类三键 D→C',
    cite: {
      lines: [377, 380],
      expect: ['订正（2026-10-21，批次P2）', 'getPresetNames / getLoadedPresetName / getPreset', '三个键从 D 挪到 C', 'C = 71 → 74', 'D = 50 → 47', '13 + 74 + 47 = 134'],
    },
    mode: 'keys', from: 'D', to: 'C',
    keys: ['getPresetNames', 'getLoadedPresetName', 'getPreset'],
  },
];

function verifyCite(move) {
  const [a, b] = move.cite.lines;
  const text = norm(hLines.slice(a - 1, b).join('\n'));
  const missing = move.cite.expect.filter((needle) => text.indexOf(norm(needle)) < 0);
  return missing;
}

// 应用顺序 = **时间顺序**，不是文件行号顺序：§7.2（§7 里的原文，2026-10-18 实现期改判）
// 比 §3/§4 里追加的订正段（2026-10-20）都早。按行号排会把批次A 的四键当成"起始类不对"跳过。
const CHRONO = ['§7.2', '包AA', '批次A', '批次B 段①', '批次B 段②', '主脑复验', '批次Q1', '批次P2'];
const ordered = MOVES.slice().sort((x, y) => {
  const rank = (m) => CHRONO.findIndex((p) => m.id.indexOf(p) === 0);
  return rank(x) - rank(y);
});
const cls = new Map(); // key -> 'A' | 'C' | 'D'
for (const k of baseA) cls.set(k, 'A');
for (const k of baseC) cls.set(k, 'C');
for (const k of baseD) cls.set(k, 'D');

const moveTrace = [];
for (const move of ordered) {
  const missing = verifyCite(move);
  if (missing.length) {
    fail('correction-cite', '订正段原文对不上（行号/措辞变了，必须先核再跑）：' + move.id, { missing });
    continue;
  }
  let keys = [];
  if (move.mode === 'keys') {
    keys = move.keys;
  } else {
    const fam = families.find((f) => f.label.indexOf(move.familyMatch) === 0 || f.label.indexOf(move.familyMatch) >= 0);
    if (!fam) {
      fail('correction-cite', '整族移动找不到族表行：' + move.id, { familyMatch: move.familyMatch });
      continue;
    }
    if (fam.keys.length !== move.expectCount) {
      fail('correction-cite', '整族键数与订正声明不符：' + move.id, { family: fam.label, listed: fam.keys.length, expected: move.expectCount });
      continue;
    }
    keys = fam.keys;
  }
  const skipped = [];
  const alreadyThere = [];
  for (const k of keys) {
    if (cls.get(k) === move.to) { alreadyThere.push(k); continue; } // 上一条订正已经挪过，不是异常
    if (cls.get(k) !== move.from) {
      skipped.push(k + '(实际 ' + (cls.get(k) || '未归类') + ')');
      continue;
    }
    cls.set(k, move.to);
  }
  if (skipped.length) {
    warn('correction-apply', '订正里有键不在声明的起始类里（已跳过，不硬改）：' + move.id, { skipped });
  }
  moveTrace.push({
    id: move.id, moved: keys.length - skipped.length - alreadyThere.length,
    alreadyThere: alreadyThere.length, from: move.from, to: move.to,
  });
}

const finalA = uniq(names134.filter((k) => cls.get(k) === 'A'));
const finalC = uniq(names134.filter((k) => cls.get(k) === 'C'));
const finalD = uniq(names134.filter((k) => cls.get(k) === 'D'));
const unclassified = names134.filter((k) => !cls.has(k));

// ---------------------------------------------------------------- 断言 ②  A+C+D = 134 且键名只属一族
{
  const dupAcross = names134.filter((k) => {
    const owners = [];
    if (baseA.includes(k)) owners.push('A');
    if (baseC.includes(k)) owners.push('C');
    if (baseD.includes(k)) owners.push('D');
    return owners.length > 1;
  });
  const problems = [];
  if (dupAcross.length) problems.push({ kind: '族表里同一键名被两族重复计入', keys: dupAcross });
  if (unclassified.length) problems.push({ kind: '族表没有覆盖到的键（134 里有、表里无）', keys: unclassified });
  if (finalA.length + finalC.length + finalD.length !== 134) {
    problems.push({ kind: 'A+C+D 不等于 134', got: finalA.length + finalC.length + finalD.length });
  }
  if (problems.length) {
    fail('② 分类闭合', 'A+C+D 不等于 134，或键名跨族重复', { problems, A: finalA.length, C: finalC.length, D: finalD.length });
  } else {
    pass('② 分类闭合', 'A=' + finalA.length + ' C=' + finalC.length + ' D=' + finalD.length + '，合计 134，键名零重复');
  }
}

// 报告声明值 vs 键名实测值。
// 2026-10-21 主脑修正：declared **不再写死在脚本里**（原先硬编码 {C:68,D:53}，是主脑那轮复验的
// 快照数；批次AA/A/B/Q1 之后它只能长期 WARN —— 一个只会告警的判据等于没有判据）。
// 现在从"最后一笔订正的原文"里抠出它自己声明的 C/D 计数：移动必须声明前后计数是本仓约定，
// 于是这条检查会随台账自己往前走，也能抓到"挪了键但忘了在订正段写数"。
{
  const lastMove = ordered[ordered.length - 1];
  const readDeclared = (label) => {
    const re = new RegExp(label + '\\s*=\\s*\\d+\\s*(?:→|->)\\s*(\\d+)');
    for (let i = (lastMove ? lastMove.cite.expect.length : 0) - 1; i >= 0; i -= 1) {
      const m = re.exec(norm(lastMove.cite.expect[i]));
      if (m) return Number.parseInt(m[1], 10);
    }
    return NaN;
  };
  const declared = { C: readDeclared('C'), D: readDeclared('D') };
  const got = { C: finalC.length, D: finalD.length };
  if (!Number.isFinite(declared.C) || !Number.isFinite(declared.D)) {
    fail('②b 声明值核对', '最后一笔订正（' + (lastMove ? lastMove.id : '无') + '）原文里没有 '
      + '"C = x → y / D = x → y" 形式的计数声明 ⇒ 无从核对。补订正段时请把挪动前后的 C/D 数写进原文', {
      citeExpect: lastMove ? lastMove.cite.expect : null, computed: got,
    });
  } else if (got.C !== declared.C || got.D !== declared.D) {
    fail('②b 声明值核对', '订正段声明的 C/D 与按键名重放的结果不符', {
      declared, computed: got, lastMove: lastMove ? lastMove.id : null,
      note: '要么订正段的算术写错，要么有键挪了没登记 MOVES —— 两者都得人核，脚本不自行改判',
    });
  } else {
    pass('②b 声明值核对', '重放结果与订正段声明一致：C=' + declared.C + ' / D=' + declared.D
      + '（声明取自「' + lastMove.id + '」原文）');
  }
}

// ---------------------------------------------------------------- 4. palink-diag.ts
const diagSrc = readRel(REL.diag);
const idsBlock = /export const ST_GAP_IDS = \[([\s\S]*?)\] as const;/.exec(diagSrc);
if (!idsBlock) throw new Error('palink-diag.ts 里找不到 ST_GAP_IDS 字面量');
const diagIds = uniq((idsBlock[1].match(/'([a-z_]+)'/g) || []).map((s) => s.split("'")[1]));

const byNameBlock = /export const ST_GAP_BY_NAME: Record<string, string> = \{([\s\S]*?)\n\};/.exec(diagSrc);
if (!byNameBlock) throw new Error('palink-diag.ts 里找不到 ST_GAP_BY_NAME 字面量');
const byName = new Map();
for (const m of byNameBlock[1].matchAll(/^\s*'?([A-Za-z_$][A-Za-z0-9_$-]*)'?:\s*'([a-z_]+)',\s*$/gm)) {
  if (byName.has(m[1])) fail('diag', 'ST_GAP_BY_NAME 里同一键名出现两次：' + m[1]);
  byName.set(m[1], m[2]);
}
const byNameKeys = Array.from(byName.keys());
const idsWithToken = new Set((diagSrc.match(/\[ST-GAP:([a-z_]+)\]/g) || []).map((s) => s.slice(8, -1)));

// ---------------------------------------------------------------- 5. 守卫名单
const guardSrc = readRel(REL.guard);
const forbBlock = /const forbidden = \[([\s\S]*?)\];/.exec(guardSrc);
if (!forbBlock) throw new Error('守卫里找不到 forbidden 数组');
const forbidden = uniq((forbBlock[1].match(/'([A-Za-z_$][A-Za-z0-9_$]*)'/g) || []).map((s) => s.split("'")[1]));
const anchors = [];
for (const m of guardSrc.matchAll(/\(\s*\[([^[\]]*?)\]\s*as const\)\.forEach/g)) {
  anchors.push(...((m[1].match(/'([A-Za-z_$][A-Za-z0-9_$]*)'/g) || []).map((s) => s.split("'")[1])));
}
const guardCover = new Set([...forbidden, ...anchors]);

// ---------------------------------------------------------------- 断言 ① 台账每个 id 有名字或族表说明
{
  const specLines = readRel(REL.ledger).split(/\r?\n/);
  const endIdx = specLines.findIndex((l) => /^### 2\.1/.test(l));
  const ledgerRows = [];
  specLines.forEach((line, idx) => {
    if (endIdx >= 0 && idx > endIdx) return;
    const m = /^\|\s*`([a-z_]+)`\s*\|/.exec(line);
    if (!m) return;
    const cells = line.split('|');
    ledgerRows.push({ line: idx + 1, id: m[1], cells: cells.slice(2, 6).map((c) => c.trim()) });
  });
  const ledgerIds = uniq(ledgerRows.map((r) => r.id));
  const problems = [];
  if (ledgerIds.length !== ledgerRows.length) {
    problems.push({ kind: '台账同一 id 出现多行', dup: ledgerRows.map((r) => r.id).filter((v, i, a) => a.indexOf(v) !== i) });
  }
  const onlyLedger = ledgerIds.filter((id) => !diagIds.includes(id));
  const onlyCode = diagIds.filter((id) => !ledgerIds.includes(id));
  if (onlyLedger.length || onlyCode.length) {
    problems.push({ kind: '台账 id 与 ST_GAP_IDS 不双向对齐', onlyLedger, onlyCode });
  }
  const emptyIds = [];
  for (const row of ledgerRows) {
    const names = (row.cells.join(' ').match(/`([A-Za-z_$][A-Za-z0-9_$]*)`/g) || []).map((s) => s.split('`')[1]);
    const named = byNameKeys.filter((k) => byName.get(k) === row.id);
    const prose = row.cells.join(' ').replace(/`/g, '').replace(/\d+\s*键/g, '').replace(/\s+/g, '');
    const hasNote = prose.length >= 6; // 一条"族表说明"至少得说出点东西，不能只写"N 键"
    if (!named.length && !names.length && !(hasNote && idsWithToken.has(row.id))) {
      emptyIds.push({ id: row.id, line: row.line, cell: row.cells.join(' | ').slice(0, 60) });
    }
  }
  if (emptyIds.length) problems.push({ kind: '空壳 id（既无键名、也无族表说明+代码 token）', emptyIds });
  if (problems.length) {
    fail('① 台账可用', '台账有 id 是空壳 / 与代码不对齐', { problems, ledgerIds, diagIds });
  } else {
    pass('① 台账可用', ledgerIds.length + ' 个 id 与 ST_GAP_IDS 双向对齐，每个 id 都有键名或族表说明');
  }
  global.__ledgerIds = ledgerIds;
}

// ---------------------------------------------------------------- 断言 ③ 守卫覆盖 包H 族表该族全部键名
{
  const gaps = [];
  const staleForbidden = forbidden.filter((k) => cls.get(k) === 'C' || cls.get(k) === 'A');
  const staleAnchors = uniq(anchors).filter((k) => cls.get(k) === 'D');
  if (staleForbidden.length) {
    fail('③b 守卫自身过期', 'D 名单里列了已归 C/A 的键（守卫在拦已实现的键）', { keys: staleForbidden });
  } else {
    pass('③b 守卫自身过期', 'D 名单 ' + forbidden.length + ' 键全部仍是 D 类');
  }
  if (staleAnchors.length) {
    fail('③b 守卫自身过期', '正向锚点里列了仍归 D 的键（锚点与分类矛盾）', { keys: staleAnchors });
  }
  const dFamilies = uniq(finalD.map((k) => familyOf.get(k) || '(无族)'));
  for (const fam of dFamilies) {
    const keys = finalD.filter((k) => (familyOf.get(k) || '(无族)') === fam);
    const miss = keys.filter((k) => !guardCover.has(k));
    if (miss.length) gaps.push({ family: fam, familySize: keys.length, missing: miss.sort(sortName) });
  }
  const totalMissing = gaps.reduce((n, g) => n + g.missing.length, 0);
  if (totalMissing) {
    fail('③ 守卫漏列', '守卫（D 名单 ∪ 正向锚点）没覆盖到 ' + totalMissing + ' 个 D 类键 —— 这些键被塞成空壳时守卫看不见', { gaps, totalMissing });
  } else {
    pass('③ 守卫漏列', 'D 类 ' + finalD.length + ' 键全部被守卫覆盖（D 名单 ∪ 正向锚点）');
  }
  global.__gaps = gaps;
  global.__guardStats = { forbidden: forbidden.length, anchors: uniq(anchors).length, covered: guardCover.size, d: finalD.length };
}

// ---------------------------------------------------------------- 断言 ④ 名字表 ↔ 分母 ↔ id
{
  const problems = [];
  const notIn134 = byNameKeys.filter((k) => !set134.has(k)).sort(sortName);
  // 斜杠命令形状：全小写、可带连字符（/inject、/char-create）。驼峰名（如 getPresett）落不进这里 ⇒ 会被抓。
  const slashShaped = notIn134.filter((k) => /^[a-z][a-z0-9-]*$/.test(k));
  const badShape = notIn134.filter((k) => slashShaped.indexOf(k) < 0);
  const badIds = byNameKeys.filter((k) => !diagIds.includes(byName.get(k)));
  const face134 = byNameKeys.filter((k) => set134.has(k));
  if (badIds.length) problems.push({ kind: '指向的 id 不在 ST_GAP_IDS 里', keys: badIds.map((k) => k + '→' + byName.get(k)) });
  if (badShape.length) problems.push({ kind: '既不在 134 里、也不是斜杠命令形状（像写错的键名）', keys: badShape });
  if (problems.length) {
    fail('④ 名字表', 'ST_GAP_BY_NAME 有名字落不到任何权威分母上', { problems });
  } else {
    pass('④ 名字表', byNameKeys.length + ' 个名字：' + face134.length + ' 个命中 134 分母且 id 全在 ST_GAP_IDS；' + notIn134.length + ' 个是斜杠命令形状');
  }
  if (notIn134.length) {
    // 2026-10-21 起这是**真检查**不是告警：斜杠侧分母一直在 slash-engine 的 fixture 里（289 键），
    // 此前 REL.slashFixture 指错目录 ⇒ 本条长期误报"分母缺失"。
    const slashPath = path.join(ROOT, REL.slashFixture);
    if (!fs.existsSync(slashPath)) {
      warn('④c 斜杠侧分母', '指到 ' + REL.slashFixture + ' 但文件不在 ⇒ 退回"只校验形状"', { keys: notIn134 });
    } else {
      const rawSlash = JSON.parse(fs.readFileSync(slashPath, 'utf8'));
      const set289 = new Set(Array.isArray(rawSlash) ? rawSlash : (rawSlash.names || []));
      const miss = notIn134.filter((k) => !set289.has(k));
      if (miss.length) {
        fail('④c 斜杠侧分母', notIn134.length + ' 个非 134 名字里有 ' + miss.length + ' 个不在权威斜杠名单（'
          + set289.size + ' 键）里 —— 像写错的命令名', { keys: miss, denominator: set289.size, fixture: REL.slashFixture });
      } else {
        pass('④c 斜杠侧分母', notIn134.length + ' 个斜杠形状名字全部命中权威 ' + set289.size + ' 分母');
      }
    }
  }
}

// ---------------------------------------------------------------- 输出
const fails = results.filter((r) => r.level === 'FAIL');
const warns = results.filter((r) => r.level === 'WARN');
const summary = {
  ok: fails.length === 0,
  counts: { A: finalA.length, C: finalC.length, D: finalD.length, total: 134 },
  base: { A: baseA.length, C: baseC.length, D: baseD.length },
  moves: moveTrace,
  guard: global.__guardStats || null,
  gaps: global.__gaps || [],
  results,
};

if (process.argv.includes('--json')) {
  process.stdout.write(JSON.stringify(summary, null, 2) + '\n');
} else {
  const out = [];
  out.push('ST-GAP 总账对账（只读）— 批次F 2026-10-20');
  out.push('权威：台账 §2 / 包H §3+订正 / palink-diag.ts / h-134 守卫 / th134-names.json');
  out.push('');
  out.push('§3 族表原始（按文档行号）:');
  for (const f of families) out.push('  :' + String(f.line).padEnd(4) + f.cls + '  ' + f.label.slice(0, 34).padEnd(36) + '声明 ' + f.declared + ' / 列出 ' + f.keys.length);
  out.push('');
  out.push('订正应用轨迹（顺序 = 时间顺序：§7.2 早于 §3/§4 的 2026-10-20 订正段）:');
  for (const t of moveTrace) out.push('  ' + t.from + '→' + t.to + '  ' + String(t.moved).padStart(2) + ' 键  ' + t.id);
  out.push('');
  out.push('最终分类: A=' + finalA.length + '  C=' + finalC.length + '  D=' + finalD.length + '  (A+C+D=' + (finalA.length + finalC.length + finalD.length) + ')');
  out.push('守卫: D 名单 ' + (summary.guard ? summary.guard.forbidden : '?') + ' 键, 正向锚点 ' + (summary.guard ? summary.guard.anchors : '?') + ' 键, 并集 ' + (summary.guard ? summary.guard.covered : '?'));
  out.push('');
  for (const r of results) {
    out.push('[' + r.level + '] ' + r.check + ' — ' + r.message);
    if (r.detail) out.push('        ' + JSON.stringify(r.detail));
  }
  out.push('');
  if (summary.gaps.length) {
    out.push('③ 守卫漏列明细（族 → 漏掉的键名）:');
    for (const g of summary.gaps) out.push('  ' + g.family + ' (' + g.missing.length + '/' + g.familySize + ' 漏): ' + g.missing.join(', '));
    out.push('');
  }
  out.push('SUMMARY: FAIL=' + fails.length + ' WARN=' + warns.length + (fails.length ? ' ⇒ 不平（exit 1）' : ' ⇒ 平（exit 0）'));
  process.stdout.write(out.join('\n') + '\n');
}
process.exit(fails.length ? 1 : 0);
