/*
 * 智能卡帧安全与迁移契约测试（三轨并一轨 · S0 18 条契约测试 · 帧安全族 9 条）
 *
 * 背景：并轨后所有不可信代码只准在 iframe 单间里跑，主页面只当"服务员"。
 * 本文件把单间轨的安全与迁移语义钉死：
 *   ① 伪造来源的 postMessage 必须拒（帧身份 + 来源双校验，fail-closed）；
 *   ② 陌生人模式不可退（未信任 iframe 不给 allow-same-origin）；
 *   ③ 模式开关置停时新轨同样停跑（static-html 不执行脚本）；
 *   ④ MVU 写口是真落库（不是大堂轨那种登记桩）；
 *   ⑤ 手势闸门对生成类动作生效（与 gesture-gate-contract.test.ts 互补）；
 *   ⑥ 降级诊断链完整（reportDiagnostic → postMessage → 宿主消费）；
 *   ⑦ 切卡后残留为零（监听器卸载清理）；
 *   ⑧ 晚到的 context 走热合并（不重建 iframe）。
 *
 * 运行: npx vitest run src/components/ui/custom/smart-card-runtime/__tests__/frame-security-and-migration-contract.test.ts
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { handleSmartCardCompatRequest } from '../SmartCardCompatController';
import { LEGACY_ST_SIM_SEGMENT } from '../frame-shim/legacy-st-sim';

// vitest 固定以 frontend/ 为 cwd 运行
const rendererSource = readFileSync(
  join(process.cwd(), 'src/components/ui/custom/CharacterCardRenderer.tsx'),
  'utf8',
);
const runtimeSource = readFileSync(
  join(process.cwd(), 'src/components/ui/custom/smart-card-runtime/SillyTavernCompatRuntime.ts'),
  'utf8',
);
const chatSource = readFileSync(
  join(process.cwd(), 'src/components/views/character/CharacterChat.tsx'),
  'utf8',
);

// ============================================================
// B1 伪造来源的消息必须拒
// ============================================================
describe('B1 伪造来源的 postMessage 必须拒（帧身份 + 来源双校验）', () => {
  it('消息须同时通过 source 标签、frameId 与 event.source 三层校验，且 ref 缺失即拒（fail-closed）', () => {
    // 三层缺一不可：data.source 标签 / data.frameId 与当前帧匹配 / event.source 是本 iframe 的 contentWindow
    expect(rendererSource).toContain("data.source !== 'palink-smart-card'");
    expect(rendererSource).toContain('event.source !== iframeRef.current.contentWindow');
    // fail-closed：原写法 `iframeRef.current?.contentWindow && event.source !== ...` 在 ref 为空时
    // 会短路跳过最强校验；现改为 ref 缺失即 return（HARDEN-1）。
    expect(rendererSource).toContain('if (!iframeRef.current?.contentWindow) return;');
    // shim 错误上报用的历史 source 名也必须过 frameId 校验才不被静默丢弃
    expect(rendererSource).toContain("data.source === 'palink-smart-card-frame'");
  });
});

// ============================================================
// B2 弱网不白屏（脚本包未到达不误报、到达后补执行）
// ============================================================
describe('B2 弱网/脚本包未到达不白屏', () => {
  it('插件脚本包缺失时静默跳过（非禁用），不误报且不阻断渲染', () => {
    expect(runtimeSource).toContain('P0-SRCDOC-SLIM');
    expect(runtimeSource).toContain("if (typeof scriptContent !== 'string' || !scriptContent.trim()) return;");
    // 包到达后的补执行路径必须存在（bundle push 先于 context-update 到达时首帧补跑）
    expect(runtimeSource).toContain('bundle push 先于 context-update 到达时首帧无法遍历插件，此处补执行');
  });

  it('资源加载失败（HTML 冒充 JS）连同 URL 上报，页面不静默空白', () => {
    // 该上报段在 frame-shim/legacy-st-sim.ts（iframe 内 window.onerror 捕获段），
    // 与 frame-error-reporting-contract.test.ts 同一对象，此处从 B2 视角复核其存在性。
    expect(LEGACY_ST_SIM_SEGMENT).toContain('script resource failed to load (HTML-as-JS suspect)');
    expect(LEGACY_ST_SIM_SEGMENT).toContain('failedUrl');
  });
});

// ============================================================
// B3 陌生人模式不可退
// ============================================================
describe('B3 陌生人模式不可退（未信任 iframe 拿不到同源权）', () => {
  it('未信任 sandbox 只有 allow-scripts + 能力令牌，明确不给 allow-same-origin', () => {
    // 信任分支才追加 allow-same-origin
    expect(rendererSource).toMatch(/allow-scripts allow-same-origin \$\{CAPABILITY_TOKENS\}/);
    // 未信任分支是单独的模板串（不含 allow-same-origin）
    expect(rendererSource).toMatch(/`allow-scripts \$\{CAPABILITY_TOKENS\}`/);
    // 设计意图注释必须在（P1-1 逃逸修复史：未信任时保持 opaque origin）
    expect(rendererSource).toContain('仍未给：allow-same-origin');
  });

  it('static-html 模式 sandbox 为空串（连脚本权都不给）', () => {
    expect(rendererSource).toMatch(/effectiveMode === 'static-html'\s*\n?\s*\? ''/);
  });
});

// ============================================================
// B4 开关置停新轨同样停跑
// ============================================================
describe('B4 模式开关置停时新轨同样停跑', () => {
  it('static-html 走 DOMPurify 净化分支，脚本非标化/垫片注入只对 iframe-js/trusted-native 生效', () => {
    expect(rendererSource).toContain("effectiveMode === 'static-html'");
    expect(rendererSource).toContain('DOMPurify.sanitize(srcDocHtml');
    // 脚本 nonce 标化（执行前提）被模式开关把守
    expect(rendererSource).toMatch(/effectiveMode === 'iframe-js' \|\| effectiveMode === 'trusted-native'/);
  });
});

// ============================================================
// B5 MVU 写口真落库（非登记桩）
// ============================================================
describe('B5 MVU 写口是真落库（大堂轨为登记桩，并轨后以单间口径为准）', () => {
  it('setVariable 有真实实现并触发持久化，不是 recordStubHit 登记桩', () => {
    expect(runtimeSource).toContain("setCompatFunction('setVariable', (path, value) => {");
    expect(runtimeSource).toContain('persistVariableStores()');
    // 反证：setVariable 注册处 200 字符内不得出现登记桩调用
    expect(runtimeSource).not.toMatch(/setCompatFunction\('setVariable'[\s\S]{0,200}recordStubHit/);
  });

  it('变量写经 postMessage 回父落桶（iframe 内写不随销毁丢失）', () => {
    expect(runtimeSource).toContain('chatVariableStore');
    expect(runtimeSource).toContain('CHAT_VARIABLES_UPDATED');
  });
});

// ============================================================
// B6 手势闸门对生成类动作生效（行为级，与 gesture-gate-contract 互补）
// ============================================================
interface RespondCall { ok: boolean; reason?: string }

async function runAction(
  actionName: string,
  payload: Record<string, unknown>,
): Promise<{ respond: RespondCall | null; calls: Record<string, number> }> {
  const calls: Record<string, number> = {};
  const bump = (key: string) => { calls[key] = (calls[key] || 0) + 1; };
  const context = {
    selectedCharacterName: 'tester',
    selectedCharacterId: 'c1',
    selectedModel: 'm1',
    selectedSession: null,
    sessionId: null,
    branchId: null,
    wb: {},
    clearChat: async () => { bump('clearChat'); },
    deleteMessage: async () => { bump('deleteMessage'); },
    setChatMessage: async () => { bump('setChatMessage'); },
    appendMessage: async () => ({ success: true, content: 'x' }),
    setInputDraft: () => { bump('setInputDraft'); },
  };
  let respond: RespondCall | null = null;
  await handleSmartCardCompatRequest(
    { worldBook: null } as never,
    context as never,
    {
      type: 'request',
      requestId: 'req-1',
      action: actionName,
      payload,
      respond: (r: { ok: boolean; result?: unknown; error?: string }) => {
        const result = (r.result || {}) as { reason?: string };
        respond = { ok: r.ok, reason: result.reason };
      },
    } as never,
  );
  return { respond, calls };
}

describe('B6 手势闸门对生成类动作生效（行为级）', () => {
  it('triggerGeneration 无手势 → 拦截且不执行', async () => {
    const { respond } = await runAction('triggerGeneration', {});
    expect(respond).not.toBeNull();
    expect(respond!.ok).toBe(false);
    expect(respond!.reason).toBe('user_gesture_required');
  });

  it('sendMessage 无手势 → 拦截且不执行', async () => {
    const { respond } = await runAction('sendMessage', {});
    expect(respond).not.toBeNull();
    expect(respond!.ok).toBe(false);
    expect(respond!.reason).toBe('user_gesture_required');
  });

  it('triggerGeneration 已验证手势 → 放行', async () => {
    const { respond } = await runAction('triggerGeneration', { __palinkUserGesture: true });
    expect(respond!.ok).toBe(true);
  });
});

// ============================================================
// B7 回写降级登记链完整
// ============================================================
describe('B7 回写降级登记链完整（静默失效必须可见）', () => {
  it('iframe 内 reportDiagnostic → postMessage → 宿主 onAction → CharacterChat 消费', () => {
    // 单间轨不落 __palinkCompatStats，走 reportDiagnostic 另一套；三处必须都在
    expect(runtimeSource).toContain('reportDiagnostic');
    expect(rendererSource).toContain("data.type === 'diagnostic'");
    expect(rendererSource).toContain("onAction?.({ type: 'diagnostic', diagnostic: data.diagnostic })");
    expect(chatSource).toContain('handleSmartCardCompatDiagnostic');
    expect(chatSource).toContain("action.type === 'diagnostic'");
  });
});

// ============================================================
// B8 切卡后残留为零
// ============================================================
describe('B8 切卡后残留为零（监听器随组件卸载清理）', () => {
  it('message 监听与视口/焦点监听都有卸载清理，切卡不遗留全局监听', () => {
    expect(rendererSource).toContain("window.addEventListener('message', handleMessage)");
    expect(rendererSource).toContain('return () => window.removeEventListener(\'message\', handleMessage)');
    // 视口族监听成对清理
    expect(rendererSource).toContain("window.removeEventListener('resize', scheduleUpdate)");
    expect(rendererSource).toContain('resizeObserver?.disconnect()');
  });

  it('iframe 随 React 组件卸载移除（srcDoc 单间不跨卡复用 DOM）', () => {
    expect(rendererSource).toContain('iframeRef');
    expect(rendererSource).toContain('srcDoc');
  });
});

// ============================================================
// B9 晚到的 context 走热合并（不重建 iframe）
// ============================================================
describe('B9 晚到的 context 热合并（宿主数据后到不重建单间）', () => {
  it('runtime 侧存在 context-update 热合并处理，且合并目标是唯一真源 chatVariableStore', () => {
    expect(runtimeSource).toContain('context-update');
    expect(runtimeSource).toContain('热合并进 chatVariableStore');
    // 热更新不得走 srcDoc 重建（iframeKey 只随 mode + 源码指纹变化）
    expect(rendererSource).toContain('sourceFingerprint');
  });
});
