/*
 * 事件枚举单源守卫（P2-25 · 2026-10-26）
 *
 * 要防的事故：事件枚举退回多份手维护副本各漂各的 —— 宿主 getContext 与帧内
 * event_types 键集不一致时，插件按 ST 惯例写 on(event_types.X) 会订到字符串
 * 'undefined' 上（P2-25 实测：CHAT_METADATA_UPDATED 帧内发得出、订不到）。
 *
 * 权威源：lib/sillytavern/event-types-compat.ts（145 键 = 76 共享 + 28 补收 + 41 自创）。
 *   宿主 getContext.ts re-export 同一对象；帧内 part-06 构建期经
 *   ${JSON.stringify(ST_EVENT_TYPES_SHARED)} 派生。runtime.ts 的第三张表
 *   ST_TO_PALINK_EVENT_MAP 本批不收编（另批处理）。
 *
 * 三层断言：
 *   A 权威源自身完整（145 键、注记集 34 键互洽）
 *   B 宿主同源（getContext 的 ST_EVENT_TYPES 与权威源同一对象；无第二份手抄）
 *   C 帧内同源（生产产物里的 event_types 表逐键等于权威源 —— 用载体二求值后文本）
 *
 * 运行: npx vitest run src/components/ui/custom/smart-card-runtime/__tests__/event-types-single-source.test.ts
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ST_EVENT_TYPES } from '../../../../../lib/sillytavern/getContext';
import {
  ST_EVENT_TYPES_SHARED,
  ST_EVENT_TYPES_NOT_IMPLEMENTED,
} from '../../../../../lib/sillytavern/event-types-compat';
import { COMPAT_V2_RUNTIME_ARTIFACT } from './compat-v2-runtime-source';

const AUTHORITY_RELATIVE = 'src/lib/sillytavern/event-types-compat.ts';
const GETCONTEXT_RELATIVE = 'src/lib/sillytavern/getContext.ts';
const PART06_RELATIVE = 'src/components/ui/custom/smart-card-runtime/runtime-body/part-06.ts';

const readSrc = (rel: string) => readFileSync(join(process.cwd(), rel), 'utf8');

/** 从权威源原文抠出 KEY: 'value' 字面量行（与 verify-event-roundtrip.mjs 同一口径）。 */
function parseLiteralRows(text: string): Array<{ key: string; value: string }> {
  const rows: Array<{ key: string; value: string }> = [];
  const re = /^\s*([A-Z][A-Z0-9_]*):\s*'([^']*)',?\s*$/gm;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) rows.push({ key: m[1], value: m[2] });
  return rows;
}

/** 从生产产物里抠出 ensureObject('event_types', {...}) 的对象字面量并 JSON.parse。 */
function parseFrameEventTypesFromArtifact(artifact: string): Record<string, string> {
  const anchor = "ensureObject('event_types', ";
  const start = artifact.indexOf(anchor);
  expect(start, '生产产物里找不到 ensureObject(\'event_types\', ...) 锚点').toBeGreaterThan(-1);
  const objStart = artifact.indexOf('{', start);
  const objEnd = artifact.indexOf('});', objStart);
  expect(objEnd, '产物里 event_types 对象字面量未闭合').toBeGreaterThan(objStart);
  return JSON.parse(artifact.slice(objStart, objEnd + 1)) as Record<string, string>;
}

// ============================================================
// A 权威源自身完整
// ============================================================
describe('A 权威源 event-types-compat.ts 自身完整', () => {
  it('A1 字面量行 145 键、无重复，且与运行时导出逐键值相等', () => {
    const text = readSrc(AUTHORITY_RELATIVE);
    const rows = parseLiteralRows(text);
    const keys = new Set(rows.map((r) => r.key));
    expect(rows.length, '字面量行数（重复键会被 JS 静默去重，这里按行数抓）').toBe(145);
    expect(keys.size).toBe(145);
    expect(Object.keys(ST_EVENT_TYPES_SHARED).length).toBe(145);
    for (const { key, value } of rows) {
      expect(ST_EVENT_TYPES_SHARED[key], key).toBe(value);
    }
  });

  it('A2 未实现注记集恰 34 键、全部在册，且与权威源无键级冲突', () => {
    expect(ST_EVENT_TYPES_NOT_IMPLEMENTED.length).toBe(34);
    for (const key of ST_EVENT_TYPES_NOT_IMPLEMENTED) {
      expect(ST_EVENT_TYPES_SHARED[key], `${key} 在权威源中必须存在`).toBeDefined();
    }
    expect(new Set(ST_EVENT_TYPES_NOT_IMPLEMENTED).size).toBe(34);
  });
});

// ============================================================
// B 宿主同源
// ============================================================
describe('B 宿主 getContext 与权威源同源', () => {
  it('B1 getContext 的 ST_EVENT_TYPES 就是权威源对象本身（re-export，非拷贝）', () => {
    expect(ST_EVENT_TYPES).toBe(ST_EVENT_TYPES_SHARED);
  });

  it('B2 getContext 里没有第二份手抄表（表体行只允许出现在权威源）', () => {
    const ctxText = readSrc(GETCONTEXT_RELATIVE);
    const authorityText = readSrc(AUTHORITY_RELATIVE);
    const tableRow = "MESSAGE_SENT: 'message_sent',";
    expect(authorityText).toContain(tableRow);
    expect(ctxText, 'getContext.ts 出现了事件表手抄行 —— 权威源统一被绕过').not.toContain(tableRow);
  });
});

// ============================================================
// C 帧内同源（对生产产物 COMPAT_V2_RUNTIME_ARTIFACT 断言）
// ============================================================
describe('C 帧内 part-06 与权威源同源', () => {
  it('C1 part-06 的 event_types 是插值派生（源里不再有字面量行）', () => {
    const text = readSrc(PART06_RELATIVE);
    expect(text).toContain("ensureObject('event_types', ${JSON.stringify(ST_EVENT_TYPES_SHARED)});");
    expect(text, 'part-06 出现了事件表字面量行 —— 插值派生被绕过')
      .not.toContain("IMPERSONATE_READY: 'impersonate_ready'");
  });

  it('C2 生产产物里的 event_types 表逐键值等于权威源（插值真实落进载体二）', () => {
    const frameTable = parseFrameEventTypesFromArtifact(COMPAT_V2_RUNTIME_ARTIFACT);
    const authorityEntries = Object.entries(ST_EVENT_TYPES_SHARED);
    expect(Object.keys(frameTable).length).toBe(authorityEntries.length);
    for (const [key, value] of authorityEntries) {
      expect(frameTable[key], `${key} 在帧内表与权威源不一致`).toBe(value);
    }
  });

  it('C3 修复锚点：CHAT_METADATA_UPDATED 与补收 28 键样本进帧（P2-25 前订不到/宿主漏收）', () => {
    const frameTable = parseFrameEventTypesFromArtifact(COMPAT_V2_RUNTIME_ARTIFACT);
    expect(frameTable.CHAT_METADATA_UPDATED).toBe('chat_metadata_updated');
    expect(frameTable.IMPERSONATE_READY).toBe('impersonate_ready');
    expect(frameTable.SECRET_WRITTEN).toBe('secret_written');
    expect(frameTable.ITEMIZED_PROMPTS_SAVED).toBe('itemized_prompts_saved');
  });
});

// ============================================================
// D 诚实留痕 —— 未实现键在帧内「可订但永不发」，不许被顺手删掉或补假 emit
// ============================================================
describe('D 未实现键的诚实留痕', () => {
  it('D1 34 键全部仍在帧内表里（union 不裁剪），删注记或删帧内键都必须显式改本用例', () => {
    const frameTable = parseFrameEventTypesFromArtifact(COMPAT_V2_RUNTIME_ARTIFACT);
    for (const key of ST_EVENT_TYPES_NOT_IMPLEMENTED) {
      expect(frameTable[key], `${key} 从帧内表消失 —— 若非补实现后的对账，属误删`).toBeDefined();
    }
  });
});
