/*
 * SPEC_世界书向量召回接通与防护 §11 A + D 前端契约守卫。
 *
 * 锁两件事：
 *  1. `worldbookApi.updateStage` 的 data 白名单必须带 ``vectorized``——
 *     后端四处白名单里这是第四处，漏了就"前端传不出去"。
 *  2. `WorldBookManager` 的勾选必须**真的发出保存请求**（该组件此前无任何
 *     写通道，展开区全 readOnly），且文案是人话、界面不出现 vectorized 字样。
 *
 * 运行: npx vitest run
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));

// 只桩掉 transport 层（api），被测对象是 worldbookApi 的字段白名单与 URL 构造。
const putSpy = vi.fn(async (_url: string, _data?: unknown) => ({ id: 's1', vectorized: true }));
vi.mock('../../services/api', () => ({
  api: {
    get: vi.fn(async () => ({})),
    post: vi.fn(async () => ({})),
    put: (url: string, data?: unknown) => putSpy(url, data),
    delete: vi.fn(async () => ({})),
  },
  invalidateCache: vi.fn(),
}));

const WORLDBOOK_API_SOURCE = readFileSync(
  join(__dirname, '..', 'worldbookApi.ts'),
  'utf-8',
);
const TYPES_SOURCE = readFileSync(
  join(__dirname, '..', '..', 'types', 'index.ts'),
  'utf-8',
);
const MANAGER_SOURCE = readFileSync(
  join(__dirname, '..', '..', 'components', 'ui', 'custom', 'WorldBookManager.tsx'),
  'utf-8',
);

// 组件的 JSX 区：所有 hook / handler 代码都在 `if (selectedWorldBook) {` 之前，
// 从那里切到文件尾只剩两个 return 的 JSX，避免把代码标识符误当成界面文案。
const MANAGER_JSX_REGION = MANAGER_SOURCE.slice(
  MANAGER_SOURCE.indexOf('if (selectedWorldBook) {'),
);

/** 找到与 open 处 '{' 配对的 '}' 下标；不配对返回 -1。 */
function matchBrace(src: string, open: number): number {
  let depth = 0;
  for (let i = open; i < src.length; i += 1) {
    const ch = src[i];
    if (ch === '{') depth += 1;
    else if (ch === '}') {
      depth -= 1;
      if (depth === 0) return i;
    }
  }
  return -1;
}

/**
 * 抽取 JSX **文本节点**——用户在界面上真正看得见的字。
 *
 * 做法：只取 `>` 与 `<` 之间的内容（天然排除标签属性），并把
 * `{cond && (<p>文案</p>)}` 这类表达式容器里嵌套的 JSX 递归展开；
 * `{/* ... *​/}` 注释与 `{stage.content}` 这类纯表达式丢弃。
 *
 * 这是 F1 的修复点：原来的写法先把所有含 vector 的 token 删光再断言找不到
 * vector，是恒真断言（永远绿）。这里只扫描看得见的文本，往任意一条文案里
 * 塞一个 "vectorized" 都会让它变红。
 */
function collectJsxText(src: string, out: string[] = [], depth = 0): string[] {
  if (depth > 8) return out;
  const re = />([^<>]*)</g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(src)) !== null) {
    let chunk = m[1];
    let i = 0;
    while (i < chunk.length) {
      const open = chunk.indexOf('{', i);
      if (open === -1) break;
      const close = matchBrace(chunk, open);
      if (close === -1) {
        // 形如 `{cond && (` 的容器：闭合括号在嵌套 JSX 之后、超出本 chunk。
        // 它是纯代码，丢弃；其内部嵌套的 JSX 会由外层扫描单独命中。
        chunk = chunk.slice(0, open);
        break;
      }
      const inner = chunk.slice(open + 1, close);
      if (!/^\s*\/\*/.test(inner)) {
        collectJsxText(inner, out, depth + 1);
      }
      chunk = chunk.slice(0, open) + chunk.slice(close + 1);
      i = open;
    }
    out.push(chunk);
  }
  return out;
}

/** 取 updateStage 的函数体（到下一个顶层成员为止）。 */
function updateStageBody(): string {
  const start = WORLDBOOK_API_SOURCE.indexOf('updateStage:');
  expect(start).toBeGreaterThan(-1);
  const end = WORLDBOOK_API_SOURCE.indexOf('\n  },', start);
  return WORLDBOOK_API_SOURCE.slice(start, end === -1 ? undefined : end);
}

beforeEach(() => {
  putSpy.mockClear();
});

describe('词条 vectorized 前端白名单（SPEC §11 A 第四处）', () => {
  it('updateStage 的 data 类型含 vectorized?: boolean', () => {
    const body = updateStageBody();
    expect(body).toContain('vectorized?: boolean');
  });

  it('updateStage 打的是 PUT /api/worldbooks/{id}/stages/{sid}', () => {
    const body = updateStageBody();
    expect(body).toContain('api.put<WorldBookStage>');
    expect(body).toContain('/stages/${stageId}');
  });

  it('types/index.ts 的 WorldBookStage 含 vectorized（第一方 UI 面类型）', () => {
    const start = TYPES_SOURCE.indexOf('export interface WorldBookStage {');
    expect(start).toBeGreaterThan(-1);
    const end = TYPES_SOURCE.indexOf('\n}', start);
    const iface = TYPES_SOURCE.slice(start, end);
    expect(iface).toContain('vectorized: boolean');
    // 并注明与插件面 lib/worldbook/types.ts 是两套，防止后人混用
    expect(iface).toContain('lib/worldbook/types.ts');
  });
});

describe('updateStage 带 vectorized 能真的发出去', () => {
  it('调用后 PUT body 里带 vectorized: true（不被类型/构造吞掉）', async () => {
    const { worldbookApi } = await import('../worldbookApi');
    await worldbookApi.updateStage('book-1', 'stage-1', { vectorized: true });

    expect(putSpy).toHaveBeenCalledTimes(1);
    const [url, data] = putSpy.mock.calls[0] as [string, Record<string, unknown>];
    expect(url).toBe('/api/worldbooks/book-1/stages/stage-1');
    expect(data).toMatchObject({ vectorized: true });
  });

  it('只改内容时不带 vectorized（后端 Optional[bool]=None 不会冲掉已勾选）', async () => {
    const { worldbookApi } = await import('../worldbookApi');
    await worldbookApi.updateStage('book-1', 'stage-1', { content: '新的设定正文' });

    const [, data] = putSpy.mock.calls[0] as [string, Record<string, unknown>];
    expect(data).toMatchObject({ content: '新的设定正文' });
    expect(Object.prototype.hasOwnProperty.call(data, 'vectorized')).toBe(false);
  });
});

describe('WorldBookManager 勾选接线与文案（SPEC §11 D）', () => {
  it('勾选走 updateStage 真保存（组件此前零写通道，不能只是个摆设）', () => {
    expect(MANAGER_SOURCE).toContain('worldbookApi.updateStage(');
    expect(MANAGER_SOURCE).toContain('vectorized: next');
  });

  it('文案是人话：勾上后不再靠关键词触发', () => {
    expect(MANAGER_SOURCE).toContain('按意思找这条设定');
    expect(MANAGER_SOURCE).toContain('不再靠关键词触发');
  });

  it('写明首轮降级：第一次打开后下一条开始准备、再下一条才生效', () => {
    expect(MANAGER_SOURCE).toContain('第一次打开后的下一条消息开始准备，再下一条才生效');
  });

  it('勾了但没关键词的条目给出风险提示', () => {
    expect(MANAGER_SOURCE).toContain('只能靠语义召回');
  });

  it('界面文案不出现 vectorized 字样（只扫描 JSX 文本节点）', () => {
    const texts = collectJsxText(MANAGER_JSX_REGION);
    const visible = texts.join('\n');

    // 自检：扫描器必须真的抽到了界面文案，否则又变成一个空断言
    expect(visible).toContain('按意思找这条设定');
    expect(visible).toContain('不再靠关键词触发');

    // F1 真守卫：只查看得见的文本——往任意一条文案里塞 "vectorized" 会变红
    expect(visible).not.toMatch(/vector/i);
  });

  it('F2 文案：勾选后说明"打开总开关后才会开始建立索引"，不让用户以为已经算完', () => {
    const texts = collectJsxText(MANAGER_JSX_REGION).join('\n');
    expect(texts).toContain('打开总开关后才会开始为这本书建立索引');
    expect(texts).toContain('现在还没开始算');
  });
});
