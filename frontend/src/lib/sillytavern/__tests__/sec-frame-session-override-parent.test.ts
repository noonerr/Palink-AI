/**
 * [安全顺手批 2026-10-26 · SPEC_下一程计划 §1#13 / §3 第 10 项]
 * 帧侧 sessionId 顶包 —— 批次S 之外的剩余两处收口。
 *
 * 批次S（docs/_active/report/REPORT_批次S_帧侧会话顶包收口_2026-10-21.md）只覆盖了
 * `SmartCardCompatController.ts` 的 RPC dispatcher（该文 §范围 :4-5 写明"范围 = 控制器的
 * 那条通道"），并在 §5 :223-226 如实记了两条未做：接口上的 `sessionId` 字段没删（宿主仍在传）、
 * 帧侧 shim 仍在发 `__palinkContext.sessionId`。台账 docs/OPEN_ISSUES.md:544 的"还剩两处"
 * 那两条（① generateRaw/generateQuietPrompt ② 世界书逐动作清点）**已由批次S 收口**，
 * 本批不再重复；本批收的是同一信任规则下、批次S 没走到的另外两个读取点：
 *
 *   位置一  frontend/src/lib/sillytavern/getContext.ts:3518（改前行号；改后宿主权威解析在 :3527）
 *           改前 `String(a.session_id ?? a.sessionId ?? currentChatId ?? '')`
 *           ⇒ 插件/卡自带值**优先于**宿主权威 chatId。消费点两个：
 *             :2759 sendStreamingRequest / :2773 sendGenerationRequest（请求体构造在 :2763 / :2777）。
 *   位置二  frontend/src/components/views/character/CharacterChat.tsx:378-386（改前行号；
 *           改后监听器在 :405-421，判据抽在 :368 `acceptSessionScopedEvent`）
 *           改前**完全不看** detail.sessionId
 *           ⇒ 自声明别份会话的变量直接落进当前视图（同事件另一消费方
 *             CharacterView.tsx:1698 早就有"不等就 return"的守卫，本处是漏网的那一份）。
 *
 * 判据：帧内 payload 自带的 sessionId 一律不得覆盖宿主权威会话标识；不一致 ⇒ 忽略 + palinkDiag 留痕。
 *
 * 运行: npx vitest run src/lib/sillytavern/__tests__/sec-frame-session-override-parent.test.ts
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

const { apiMock } = vi.hoisted(() => ({
  apiMock: {
    get: vi.fn(),
    post: vi.fn(),
    put: vi.fn(),
    patch: vi.fn(),
    delete: vi.fn(),
    stream: vi.fn(),
  },
}));
vi.mock('@/services/api', async (importOriginal) => {
  const actual = (await importOriginal()) as any;
  return { ...actual, api: { ...actual.api, ...apiMock } };
});

import { getContext } from '../getContext';
import { createSillyTavernRuntime, destroySillyTavernRuntime } from '../runtime';
import { acceptSessionScopedEvent } from '@/components/views/character/CharacterChat';
import {
  palinkDiagRecords,
  recordPalinkDiag,
  resetPalinkDiagForTest,
  setPalinkDiagEnabled,
} from '@/components/ui/custom/smart-card-runtime/palink-diag';

const HOST_SESSION = 'sess-host-authoritative';
const FRAME_CLAIM = 'frame-claims-other-session';

function feedHostContext(overrides?: Record<string, unknown>) {
  createSillyTavernRuntime({
    chat: [],
    chatId: HOST_SESSION,
    characterUuid: 'uuid-sec',
    name1: 'User',
    name2: 'Bot',
    character: { name: 'Bot', description: '' },
    characters: [],
    ...overrides,
  } as any);
}

const streamBody = (): Record<string, any> => {
  const calls = apiMock.stream.mock.calls as unknown as Array<[string, Record<string, any>, unknown]>;
  const last = calls[calls.length - 1];
  return (last?.[1] ?? {}) as Record<string, any>;
};
const urlsSeen = (): string => JSON.stringify(apiMock.stream.mock.calls ?? []);
const ignoredRecords = () => palinkDiagRecords().filter((r) => r.kind === 'payload_session_ignored');

beforeEach(() => {
  vi.clearAllMocks();
  resetPalinkDiagForTest();
  setPalinkDiagEnabled(true, false);
  apiMock.stream.mockResolvedValue({ ok: true, body: null } as any);
  feedHostContext();
});

afterEach(() => {
  destroySillyTavernRuntime();
  resetPalinkDiagForTest();
  setPalinkDiagEnabled(null, false);
});

describe('位置一：getContext 生成通道（真入口 sendStreamingRequest / sendGenerationRequest）', () => {
  it('帧自带 session_id 不得覆盖宿主 chatId：请求体里只有宿主值', async () => {
    await getContext().sendStreamingRequest({ prompt: 'hi', session_id: FRAME_CLAIM });
    expect(apiMock.stream).toHaveBeenCalled();
    expect(streamBody().session_id).toBe(HOST_SESSION);
    expect(JSON.stringify(streamBody())).not.toContain(FRAME_CLAIM);
  });

  it('驼峰写法 sessionId 同样不算数（sendGenerationRequest）', async () => {
    await getContext().sendGenerationRequest({ prompt: 'hi', sessionId: FRAME_CLAIM });
    expect(streamBody().session_id).toBe(HOST_SESSION);
    expect(urlsSeen()).not.toContain(FRAME_CLAIM);
  });

  it('宿主没有会话时，帧塞的 id 既不落请求体、也不落到 null 之外的位置', async () => {
    destroySillyTavernRuntime();
    feedHostContext({ chatId: '' });
    await getContext().sendStreamingRequest({ prompt: 'hi', session_id: FRAME_CLAIM });
    expect(streamBody().session_id).toBeNull();
    expect(JSON.stringify(streamBody())).not.toContain(FRAME_CLAIM);
  });

  it('宿主会话还是 __pending__ ⇒ 按"没有会话"处理（与批次S 同口径）', async () => {
    destroySillyTavernRuntime();
    feedHostContext({ chatId: '__pending__' });
    await getContext().sendStreamingRequest({ prompt: 'hi', session_id: FRAME_CLAIM });
    expect(streamBody().session_id).toBeNull();
  });

  it('正向：不塞会话键时行为不变（宿主值照旧进请求体）', async () => {
    await getContext().sendStreamingRequest({ prompt: 'hi' });
    expect(streamBody().session_id).toBe(HOST_SESSION);
    expect(ignoredRecords()).toHaveLength(0);
  });

  it('不一致必须留痕（payload_session_ignored），且留痕里带宿主值与自声明值', async () => {
    await getContext().sendStreamingRequest({ prompt: 'hi', session_id: FRAME_CLAIM });
    const recs = ignoredRecords();
    expect(recs).toHaveLength(1);
    expect(recs[0].owner).toBe('frame_compat');
    expect(recs[0].detail).toContain(FRAME_CLAIM);
    expect(recs[0].detail).toContain(HOST_SESSION);
  });

  it('帧声明的就是宿主那一份（合法 shim 的常态）⇒ 零留痕，不制造噪声', async () => {
    await getContext().sendStreamingRequest({ prompt: 'hi', session_id: HOST_SESSION });
    expect(streamBody().session_id).toBe(HOST_SESSION);
    expect(ignoredRecords()).toHaveLength(0);
  });

  it('记录器关闭时判定照旧生效（放行规则不依赖记录器），且零写入', async () => {
    // resetPalinkDiagForTest() 会清掉 enabledOverride（jsdom 的 localhost 会默认判"开"），
    // 所以必须 reset 在前、显式关闭在后。
    resetPalinkDiagForTest();
    setPalinkDiagEnabled(false, false);
    await getContext().sendStreamingRequest({ prompt: 'hi', session_id: FRAME_CLAIM });
    expect(streamBody().session_id).toBe(HOST_SESSION);
    expect(palinkDiagRecords()).toHaveLength(0);
  });
});

describe('位置二：palink:mvuVariablesUpdated 的会话作用域判据（纯函数）', () => {
  it('自声明 ≠ 宿主 ⇒ 拒绝（这就是顶包）', () => {
    expect(acceptSessionScopedEvent(FRAME_CLAIM, HOST_SESSION)).toBe(false);
  });

  it('自声明 = 宿主 ⇒ 放行', () => {
    expect(acceptSessionScopedEvent(HOST_SESSION, HOST_SESSION)).toBe(true);
  });

  it('未自声明（旧投递）⇒ 放行，不因补守卫打死既有链路', () => {
    expect(acceptSessionScopedEvent('', HOST_SESSION)).toBe(true);
    expect(acceptSessionScopedEvent('   ', HOST_SESSION)).toBe(true);
  });

  it('宿主没有权威会话（空 / __pending__ 已在上游置空）⇒ 放行（无可比对对象）', () => {
    expect(acceptSessionScopedEvent(FRAME_CLAIM, '')).toBe(true);
  });

  it('两侧都带空白时按 trim 比较，不能因为空格差异把正常投递判成顶包', () => {
    expect(acceptSessionScopedEvent(` ${HOST_SESSION} `, ` ${HOST_SESSION} `)).toBe(true);
  });

  it('留痕通路可用：宿主侧守卫拒绝后落的那条记录 kind 在名单内', () => {
    const rec = recordPalinkDiag({
      owner: 'frame_compat',
      kind: 'payload_session_ignored',
      name: 'CharacterChat.palink:mvuVariablesUpdated',
      detail: `自声明=${FRAME_CLAIM} 宿主=${HOST_SESSION}`,
      frameId: HOST_SESSION,
      origin: 'host',
    });
    expect(rec).not.toBeNull();
    expect(ignoredRecords()).toHaveLength(1);
    expect(ignoredRecords()[0].frameId).toBe(HOST_SESSION);
  });
});
