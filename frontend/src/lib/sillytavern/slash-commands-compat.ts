/**
 * [S5-GDEP2 2026-10-15] Palink 专有 slash 命令的共享实现（大堂轨 / 沙箱轨共用）
 *
 * 背景：S5-GDEP1 把 `executeSlashCommandCompat`（SlashCommandEngine 委托段）下沉到了
 * lib/sillytavern/getContext.ts，但**大堂轨 runSlashCommand 的前置命令段**
 * （utils/sillyTavernPluginRuntime.ts:646-707）当时被判为"不在下沉范围"，理由是它
 * 依赖大堂私有的 `palinkBridge.resolveMessageAnchor` 与 `this.context`。
 * 那批命令共 7 个处理分支 / 9 个命令名：
 *
 *   | 分支 | 命令名 | 依赖 |
 *   |------|--------|------|
 *   | ① 分支/存档创建 | /branch-create {mesId}、/checkpoint-create mesId=X {name} | sessionId + resolveMessageAnchor + branches API |
 *   | ② 分支/存档跳转 | /checkpoint-go {mesId} | sessionId + resolveMessageAnchor + switch API |
 *   | ③ 同级分叉 | /chat-fork | sessionId + branches API |
 *   | ④ 聊天文件名 | /getchatname | sessionId |
 *   | ⑤ 模型读写 | /model [arg] | generationEngine（共享服务，非大堂私有） |
 *   | ⑥ profile/preset 映射为模型 | /profile [arg]、/preset [arg] | generationEngine |
 *   | ⑦ 预设列表占位 | /profile-list | 无（登记 recordStubHit 后返空串） |
 *
 * S5 删除大堂轨后这批命令会**整体消失**，而沙箱轨（lib/plugin-system/sandbox.ts 的
 * triggerSlash，S5 后插件调用 slash 命令的唯一入口）拿不到它们。本模块把它们搬到
 * 大堂无关的位置，两轨共调同一份，消除"删大堂 → 沙箱逻辑丢失"。
 *
 * 红线：**只搬不改语义**。下面的匹配正则、请求体、返回值、副作用（含 recordStubHit
 * 与 window 事件派发）逐条与旧实现一致，逐一对照见
 * docs/_active/report/REPORT_slash-sink_2026-10-15.md §3。
 *
 * 依赖边界（本模块刻意**不**读 window.__palinkBridge 等任何大堂注入物）：
 *   - sessionId / characterUuid / name2 → 全局 ST runtime 的 context
 *     （CharacterChat 每次渲染都喂入，S5 保留；见 CharacterChat.tsx:1775-1778）
 *   - 楼层锚点 → 本模块内 /api/chats/get 实现（对齐大堂 fetchSessionMessages +
 *     resolveMessageAnchor 两段，语义逐条一致）
 *   - 模型读写 → generationEngine 单例（共享服务，与大堂同一实例，非大堂私有）
 */

import { api } from '@/services/api';
import { recordStubHit } from '@/lib/plugin-system/compat-stub-registry';
import { generationEngine } from '@/services/generation-engine';
import { getGlobalSillyTavernRuntime } from './runtime';

/** 楼层锚点：把 mesid（楼层号）解析为分支与数据库消息 id。 */
export interface PalinkMessageAnchor {
  branchId?: string | null;
  messageId?: number | null;
}

/**
 * 上下文注入口。
 *
 * 大堂轨传入自己的 `this.context.chatId` 与 `palinkBridge.resolveMessageAnchor`
 * （保持与其旧实现逐字同源）；沙箱轨不传，走本模块基于全局 ST runtime 的缺省解析。
 */
export interface PalinkSlashCommandDeps {
  /** 当前会话 id。显式传 undefined 也算"无会话"（与大堂旧实现的 falsy 判定一致）。 */
  sessionId?: string;
  /** 楼层号 → 锚点解析器。缺省用本模块的 /api/chats/get 实现。 */
  resolveMessageAnchor?: (floorId: number) => Promise<PalinkMessageAnchor | null>;
}

/** 从全局 ST runtime 读当前会话上下文（与 getContext.ts [S5-GDEP1] 的读源口径一致）。 */
function resolveGlobalContext(): { sessionId: string; characterUuid: string; chName: string } {
  const ctx = getGlobalSillyTavernRuntime()?.getContext?.() as any;
  return {
    sessionId: ctx?.chatId == null ? '' : String(ctx.chatId),
    characterUuid: ctx?.characterUuid == null ? '' : String(ctx.characterUuid),
    chName: ctx?.name2 == null ? '' : String(ctx.name2),
  };
}

/**
 * 读当前会话的 ST 消息（含分支头，供楼层锚点解析）。
 *
 * 对齐 utils/sillyTavernPluginRuntime.ts 的 palinkBridge.fetchSessionMessages：
 * 缺 sessionId / characterUuid 直接返空数组，成功后按数组判定，不额外包 try。
 */
async function fetchSessionMessagesShared(): Promise<any[]> {
  const { sessionId, characterUuid, chName } = resolveGlobalContext();
  if (!sessionId || !characterUuid) return [];
  const resp = await api.post('/api/chats/get', {
    avatar_url: `palink-${characterUuid}.png`,
    ch_name: chName,
  });
  return Array.isArray(resp) ? resp : [];
}

/**
 * 把楼层号（mesid）解析为 { branchId, messageId }。
 *
 * 对齐 utils/sillyTavernPluginRuntime.ts 的 palinkBridge.resolveMessageAnchor
 * （含其 try/catch → console.error + null 的降级）。
 */
async function resolveMessageAnchorShared(floorId: number): Promise<PalinkMessageAnchor | null> {
  try {
    const resp = await fetchSessionMessagesShared();
    if (!Array.isArray(resp) || resp.length === 0) return null;
    const header = resp[0];
    const branchId = header?.chat_metadata?.palink_branch_id ?? header?.branch_id ?? null;
    for (const item of resp.slice(1)) {
      if (Number(item?.mesid) === Number(floorId) || Number(item?.id) === Number(floorId)) {
        return { branchId, messageId: item?.id ?? null };
      }
    }
    return { branchId, messageId: null };
  } catch (e) {
    console.error('[Palink slash-commands] resolveMessageAnchor failed:', e);
    return null;
  }
}

/**
 * 执行 Palink 专有的 slash 命令（7 分支 / 9 命令名）。
 *
 * @returns
 *   - `string`：命令命中，值即最终返回值（含空串 ''）。调用方**不要**再走引擎。
 *   - `null`：未命中任何 Palink 专有命令，调用方应继续委托 SlashCommandEngine。
 *
 * ⚠️ 命中判据与旧实现完全一致：会话类命令（①~③）匹配到命令名但**无 sessionId**
 * 时按"未命中"处理（继续往下走，最终落到引擎），这不是本模块引入的语义。
 *
 * ⚠️ 异常处理：任一环节抛错一律记 console.error 并返回 ''（已命中语义），
 * 与大堂旧实现 runSlashCommand 的 catch 分支返回值一致。这样沙箱轨拿到的是
 * 与大堂同款的优雅降级，而不是插件侧的未捕获 rejection。
 */
export async function runPalinkSlashCommands(
  command: unknown,
  deps?: PalinkSlashCommandDeps | null,
): Promise<string | null> {
  const cmd = String(command ?? '').trim();
  // sessionId：调用方显式给键（含显式 undefined）时以其为准，否则用全局 runtime 解析。
  const hasExplicitSession = !!deps && Object.prototype.hasOwnProperty.call(deps, 'sessionId');
  const rawSessionId = hasExplicitSession ? deps!.sessionId : resolveGlobalContext().sessionId;
  const sessionId = rawSessionId == null ? '' : String(rawSessionId);
  const resolveAnchor = deps?.resolveMessageAnchor ?? resolveMessageAnchorShared;
  try {
    // /branch-create {mesId}、/checkpoint-create mesId=X {name}
    const branchCreateMatch = cmd.match(/^\/branch-create\s+(\d+)/) || cmd.match(/^\/checkpoint-create\s+mesId=(\d+)(?:\s+(.*))?$/i);
    if (branchCreateMatch && sessionId) {
      const floorId = Number(branchCreateMatch[1]);
      const branchName = branchCreateMatch[2] ? String(branchCreateMatch[2]).trim() : undefined;
      const anchor = await resolveAnchor(floorId);
      const payload: any = { session_id: sessionId, same_level: false };
      if (anchor?.branchId) payload.parent_branch_id = anchor.branchId;
      if (anchor?.messageId) payload.parent_message_id = anchor.messageId;
      if (branchName) payload.branch_name = branchName;
      await api.post(`/api/character-sessions/${sessionId}/branches`, payload);
      window.dispatchEvent(new CustomEvent('palink:switchBranch', { detail: { sessionId } }));
      return '';
    }
    // /checkpoint-go {mesId}：切到目标消息所在分支并定位
    const checkpointGoMatch = cmd.match(/^\/checkpoint-go\s+(\d+)/);
    if (checkpointGoMatch && sessionId) {
      const floorId = Number(checkpointGoMatch[1]);
      const anchor = await resolveAnchor(floorId);
      if (anchor?.branchId) {
        const qs = anchor.messageId ? `&up_to_message_id=${anchor.messageId}` : '';
        await api.post(`/api/character-sessions/${sessionId}/branches/${anchor.branchId}/switch?limit=10${qs}`);
        window.dispatchEvent(new CustomEvent('palink:switchBranch', { detail: { sessionId, branchId: anchor.branchId, messageId: anchor.messageId } }));
      }
      return '';
    }
    // /chat-fork：当前聊天同级分叉
    if (/^\/chat-fork\b/.test(cmd) && sessionId) {
      await api.post(`/api/character-sessions/${sessionId}/branches`, { session_id: sessionId, same_level: true });
      window.dispatchEvent(new CustomEvent('palink:switchBranch', { detail: { sessionId } }));
      return '';
    }
    // /getchatname：返回当前聊天文件名（与 /api/characters/chats 的 file_name 对齐）
    if (/^\/getchatname\b/.test(cmd)) {
      return sessionId ? `palink-session-${sessionId}.jsonl` : '';
    }
    // ST /model get/set：读当前模型名、切换 raw 生成所用模型（generationEngine 上下文）。
    // Galgame 插件加强模式经 /profile /model /preset 快照→切换→恢复 API 配置
    // （COT 二次生成换更强模型）；Palink 无独立 profile/preset 概念，统一映射为模型。
    if (/^\/model(?:\s|$)/i.test(cmd)) {
      const arg = String(cmd).replace(/^\/model\s*/i, '').replace(/^quiet=true\s*/i, '').trim();
      if (arg) {
        try { generationEngine.setContext({ model: arg }); } catch (e) { /* ignore */ }
        return /^\/model\s+quiet=true\b/i.test(cmd) ? arg : `Model: ${arg}`;
      }
      const currentModel = (generationEngine as any)._currentModel || '';
      return /quiet=true/i.test(cmd) ? currentModel : (currentModel ? `Current model: ${currentModel}` : '');
    }
    if (/^\/(profile|preset)(\s|$)/i.test(cmd)) {
      const arg = String(cmd).replace(/^\/(profile|preset)\s*/i, '').replace(/^quiet=true\s*/i, '').trim();
      if (arg) {
        // set：映射为模型切换；返回空串即可（runSlashSafe 只判"未知命令"）
        try { generationEngine.setContext({ model: arg }); } catch (e) { /* ignore */ }
        return '';
      }
      // get：返回当前模型名，让插件快照/恢复闭环；无模型时返回空串（插件跳过恢复）
      return (generationEngine as any)._currentModel || '';
    }
    if (/^\/profile-list\b/.test(cmd)) {
      recordStubHit('slash:profile-list', 'Palink 无独立 profile/preset 概念，返回空列表');
      return '';
    }
    // 未命中任何 Palink 专有命令 → 由调用方决定是否委托 SlashCommandEngine。
    return null;
  } catch (e) {
    console.error('[Palink slash-commands] runPalinkSlashCommands failed:', cmd, e);
    return '';
  }
}