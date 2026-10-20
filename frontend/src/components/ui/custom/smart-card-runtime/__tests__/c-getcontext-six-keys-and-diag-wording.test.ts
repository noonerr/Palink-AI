/*
 * 批次C · getContext 六个「有名字没实物」键的定性 + window.context 留痕文案
 *
 * 钉四件事（全部对**求值后载体** COMPAT_V2_RUNTIME_ARTIFACT 断言，不拿源码副本冒充执行）：
 *   A. tokenizers 已是 ST 的静态枚举（scripts/tokenizers.js:16-38），键集与值逐条相等，
 *      且没有造 ST 没有的键。
 *   B. getRequestHeaders 已按 ST 契约（script.js:645）返回头对象，支持 omitContentType，
 *      且**不含** X-CSRF-Token（帧内无该值数据源，理由写在 part-06 注释里）。
 *   C. 四个依附子系统/无数据源的键**保持原样且没有造假数据**：
 *      chatMetadata（活对象，缺 ST 聊天文件语义字段）、tagMap（本仓无 tag 实体表）、
 *      CONNECT_API_MAP（依附 ST 连接面板 DOM）、getPresetManager（依附预设对象模型）。
 *      每个键的一手锚点（文件:行号）必须写进源码注释，改注释等于改结论 ⇒ 这里钉住。
 *   D. window.context 那条启动留痕的文案改成「ST 亦无此全局」，且判定逻辑
 *      （owner / kind / name）一个字都没动。
 *
 * 运行:
 *   npx vitest run src/components/ui/custom/smart-card-runtime/__tests__/c-getcontext-six-keys-and-diag-wording.test.ts
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { COMPAT_V2_RUNTIME_ARTIFACT } from './compat-v2-runtime-source';

const ARTIFACT = COMPAT_V2_RUNTIME_ARTIFACT;
const RUNTIME_BODY_DIR = 'src/components/ui/custom/smart-card-runtime/runtime-body';
const readSource = (relative: string) => readFileSync(join(process.cwd(), relative), 'utf8');

const PART01 = readSource(`${RUNTIME_BODY_DIR}/part-01.ts`);
const PART06 = readSource(`${RUNTIME_BODY_DIR}/part-06.ts`);
const PART07 = readSource(`${RUNTIME_BODY_DIR}/part-07.ts`);
const PART08 = readSource(`${RUNTIME_BODY_DIR}/part-08.ts`);

/** 从载体里切出 startMarker 起、到其后第一个 endMarker（含）为止的原文。 */
function sliceRegion(text: string, startMarker: string, endMarker: string): string {
  const start = text.indexOf(startMarker);
  expect(start, `载体里找不到片段起点: ${startMarker}`).toBeGreaterThanOrEqual(0);
  const end = text.indexOf(endMarker, start);
  expect(end, `载体里找不到片段终点: ${endMarker}`).toBeGreaterThan(start);
  return text.slice(start, end + endMarker.length);
}

/** ST 1.18 的 tokenizers 枚举（scripts/tokenizers.js:16-38 逐条抄录，作为对照基准）。 */
const ST_TOKENIZERS: Record<string, number> = {
  NONE: 0, GPT2: 1, OPENAI: 2, LLAMA: 3, NERD: 4, NERD2: 5,
  API_CURRENT: 6, MISTRAL: 7, YI: 8, API_TEXTGENERATIONWEBUI: 9, API_KOBOLD: 10,
  CLAUDE: 11, LLAMA3: 12, GEMMA: 13, JAMBA: 14, QWEN2: 15, COMMAND_R: 16,
  NEMO: 17, DEEPSEEK: 18, COMMAND_A: 19, BEST_MATCH: 99,
};

describe('A tokenizers = ST 静态枚举（真做，不是空壳）', () => {
  const regionOf = () => sliceRegion(ARTIFACT, 'window.tokenizers = Object.assign(', '\n  );');
  const evaluate = () => {
    const win: Record<string, unknown> = {};
    // 求值的是载体原文那一段，不是这里重写的副本。
    const factory = new Function('window', `${regionOf()}\nreturn window.tokenizers;`);
    return factory(win) as Record<string, unknown>;
  };

  it('载体里确实是 Object.assign 出来的枚举，不再是 window.tokenizers || {}', () => {
    expect(ARTIFACT).toContain('window.tokenizers = Object.assign(');
    expect(ARTIFACT).not.toContain('window.tokenizers = window.tokenizers || {};');
  });

  it('21 个键与 ST 逐条相等（含 BEST_MATCH: 99）', () => {
    const tk = evaluate();
    Object.entries(ST_TOKENIZERS).forEach(([key, value]) => {
      expect(tk[key], `tokenizers.${key} 必须等于 ST 的 ${value}`).toBe(value);
    });
    expect(Object.keys(tk).sort()).toEqual(Object.keys(ST_TOKENIZERS).sort());
  });

  it('已有同名全局时不覆盖别人写的键（合并而非替换）', () => {
    const win: Record<string, unknown> = { tokenizers: { PALINK_ONLY: 777 } };
    const factory = new Function('window', `${regionOf()}\nreturn window.tokenizers;`);
    const tk = factory(win) as Record<string, unknown>;
    expect(tk.PALINK_ONLY).toBe(777);
    expect(tk.OPENAI).toBe(2);
  });

  it('一手锚点写在源码注释里（改实现必须先改结论）', () => {
    expect(PART07).toContain('scripts/tokenizers.js:16-38');
  });
});

describe('B getRequestHeaders = ST 契约（头对象 + omitContentType）', () => {
  const regionOf = () => sliceRegion(ARTIFACT, "ensureFunction('getRequestHeaders'", '\n  });');
  const build = () => {
    const win: Record<string, unknown> = {};
    const ensureFunction = (name: string, fn: unknown) => { win[name] = fn; };
    const factory = new Function('ensureFunction', 'window', `${regionOf()}\nreturn window.getRequestHeaders;`);
    return factory(ensureFunction, win) as (options?: { omitContentType?: boolean }) => Record<string, string>;
  };

  it('默认返回 { "Content-Type": "application/json" }（ST script.js:645 同形）', () => {
    expect(build()()).toEqual({ 'Content-Type': 'application/json' });
  });

  it('omitContentType: true 时删掉 Content-Type，返回空对象而不是 undefined', () => {
    const headers = build()({ omitContentType: true });
    expect(headers).toEqual({});
    expect(headers['Content-Type']).toBeUndefined();
  });

  it('无参调用不抛（卡常写 getRequestHeaders()）', () => {
    expect(() => build()()).not.toThrow();
  });

  it('不给 X-CSRF-Token：帧内无该值数据源，硬塞空串=形状对语义错', () => {
    const headers = build()();
    expect(Object.prototype.hasOwnProperty.call(headers, 'X-CSRF-Token')).toBe(false);
    // 理由必须留在源码里，否则下一个人会「顺手补上」
    expect(PART06).toContain('为什么**不给** X-CSRF-Token');
    expect(PART06).toContain('script.js:645');
  });

  it('已实现 ⇒ 必须移出桩表（否则卡每调一次就多一条 st_api_stub 噪音）', () => {
    const notes = sliceRegion(PART08, 'const PALINK_STUB_API_NOTES = {', '};');
    expect(notes).not.toContain('getRequestHeaders:');
  });
});

describe('C 四个依附子系统/无数据源的键：保持原样，且不造数据', () => {
  it('chatMetadata 是活对象（part-06 从持久化恢复 + 落盘），不是每次新建的空壳', () => {
    expect(PART06).toContain("ensureObject('chat_metadata'");
    expect(PART06).toContain('persistedMetadata');
    expect(PART08).toContain('chatMetadata: window.chat_metadata || {},');
    // ST 侧 chat_metadata 是活对象（script.js:453）——锚点必须在注释里
    expect(PART08).toContain('script.js:453');
  });

  it('chatMetadata 不填 ST 的聊天文件语义字段（本仓无数据源 ⇒ 不造默认值）', () => {
    expect(PART08).not.toContain('chat_metadata.note_prompt =');
    expect(PART08).not.toContain('chat_metadata.integrity =');
    expect(PART08).not.toContain('chat_metadata.tainted =');
  });

  it('tagMap 保持空对象：本仓角色标签只是字符串列，无 tag 实体表', () => {
    expect(PART08).toContain('tagMap: {},');
    expect(PART08).toContain('tags.js:351');
    expect(PART08).not.toContain('tagMap: buildTagMapCompat');
  });

  it('CONNECT_API_MAP 保持空对象：依附 ST 连接面板的 DOM 选择器', () => {
    expect(PART08).toContain('CONNECT_API_MAP: {},');
    expect(PART08).toContain('slash-commands.js:141');
    expect(PART08).toContain('#api_button_openai');
  });

  it('getPresetManager 保持既有手搭形状（依附预设对象模型，台账 preset_prompt）', () => {
    expect(PART08).toContain('preset-manager.js:83');
    expect(PART08).toContain('getPresetManager: () => ({');
    // getSelectedPreset 读的是真 presetData，不是编的
    expect(PART08).toContain('getSelectedPreset: () => parseMaybeJsonObject(ctx.presetData, {})');
  });
});

describe('D window.context 留痕：只改文案，判定逻辑一个字没动', () => {
  it('新措辞在场：ST 亦无此全局 + 卡写法不合规', () => {
    expect(ARTIFACT).toContain('ST 亦无此全局');
    expect(ARTIFACT).toContain('卡这么写本身不合规');
  });

  it('旧措辞不在场（读起来像我们缺陷的那句）', () => {
    expect(ARTIFACT).not.toContain('形状缺口：boot 的 ctx 是 IIFE 内的 const');
    expect(ARTIFACT).not.toContain('本包只留痕不补对象（待用户拍板）');
  });

  it('判定逻辑不变：owner / kind / name / 去重前的前提条件全部原样', () => {
    expect(ARTIFACT).toContain("owner: 'frame_compat'");
    expect(ARTIFACT).toContain("kind: 'global_shape_absent'");
    expect(ARTIFACT).toContain("name: 'window.context'");
    expect(ARTIFACT).toContain("if (!Object.getOwnPropertyDescriptor(window, 'context')) {");
  });

  it('一手锚点（ST 的 context 恒为局部变量）写进源码注释', () => {
    expect(PART01).toContain('authors-note.js:325/444');
    expect(PART01).toContain('const context = getContext()');
  });
});
