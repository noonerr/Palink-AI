/**
 * 「该用哪条分支」的前端落点（批次 BRANCH-1）。
 *
 * 后端 `GET /api/character-sessions/{id}/branches` 现在下发
 * `{ branches, active_branch_id, active_branch_source, total }`，判定规则由
 * `backend/app/services/branch_resolution.py` 唯一拥有：
 *
 *   有 is_active ⇒ 用它；否则 ⇒ 装着最新消息的那条；再否则 ⇒ created_at 最新建的那条。
 *
 * 前端不再自己发明规则（旧实现按 max(last_message_at || created_at) 排序，
 * 与后端 created_at.desc() 不一致）。这里的本地兜底只在字段缺失时启用，
 * 且退化为「is_active → created_at 最新」——前端拿不到消息表，第二级无法复刻，
 * 所以只要后端字段在就永远以后端为准。
 */
import type { CharacterChatSessionBranch } from '@/types';

export interface BranchListPayload {
  branches: CharacterChatSessionBranch[];
  /** 后端判定的活动分支；null = 后端自己也没有分支行 */
  activeBranchId: string | null;
  /** flagged_active / newest_message / newest_created / none（调试与埋点用） */
  activeBranchSource: string | null;
}

function asArray(value: unknown): CharacterChatSessionBranch[] {
  return Array.isArray(value) ? (value as CharacterChatSessionBranch[]) : [];
}

/** 兼容旧的裸数组响应（滚动发布期间前后端版本可能错开）。 */
export function normalizeBranchListResponse(data: unknown): BranchListPayload {
  if (Array.isArray(data)) {
    return { branches: asArray(data), activeBranchId: null, activeBranchSource: null };
  }
  const obj = (data ?? {}) as Record<string, unknown>;
  return {
    branches: asArray(obj.branches),
    activeBranchId: typeof obj.active_branch_id === 'string' ? obj.active_branch_id : null,
    activeBranchSource: typeof obj.active_branch_source === 'string' ? obj.active_branch_source : null,
  };
}

/**
 * 选出要展示的分支：后端 `active_branch_id` 优先；字段缺失才走本地兜底
 * （is_active → created_at 最新，id 决胜），规则与后端第 1/3 条一致。
 */
export function pickSelectedBranch(
  payload: BranchListPayload,
): CharacterChatSessionBranch | null {
  const { branches, activeBranchId } = payload;
  if (activeBranchId) {
    const hit = branches.find((b) => b.id === activeBranchId);
    if (hit) return hit;
  }
  const flagged = branches.find((b) => b.is_active);
  if (flagged) return flagged;
  if (branches.length === 0) return null;
  return [...branches].sort((a, b) => {
    const ta = a.created_at ? new Date(a.created_at).getTime() : -Infinity;
    const tb = b.created_at ? new Date(b.created_at).getTime() : -Infinity;
    if (tb !== ta) return tb - ta;
    return String(b.id).localeCompare(String(a.id));
  })[0];
}
