import { describe, expect, it } from 'vitest';

import {
  normalizeBranchListResponse,
  pickSelectedBranch,
} from '@/lib/branch-selection';
import type { CharacterChatSessionBranch } from '@/types';

function branch(over: Partial<CharacterChatSessionBranch> & { id: string }): CharacterChatSessionBranch {
  return {
    session_id: 's1',
    branch_name: over.id,
    is_active: false,
    created_at: '2026-10-20T12:00:00Z',
    ...over,
  } as CharacterChatSessionBranch;
}

describe('branch-selection（后端唯一规则的消费端）', () => {
  it('以后端 active_branch_id 为准，不按 last_message_at/created_at 自己重排', () => {
    const older = branch({ id: 'A', is_active: true, created_at: '2026-10-20T12:00:00Z' });
    const newer = branch({
      id: 'B',
      created_at: '2026-10-20T15:00:00Z',
      last_message_at: '2026-10-20T18:00:00Z',
    });
    const payload = normalizeBranchListResponse({
      branches: [older, newer],
      active_branch_id: 'A',
      active_branch_source: 'flagged_active',
      total: 2,
    });
    expect(payload.activeBranchId).toBe('A');
    // 旧前端逻辑会给 B（按 last_message_at 最新）—— 那正是要消灭的分歧
    expect(pickSelectedBranch(payload)?.id).toBe('A');
  });

  it('兼容旧的裸数组响应，并退化为 is_active → created_at 最新', () => {
    const plain = normalizeBranchListResponse([
      branch({ id: 'A', created_at: '2026-10-20T12:00:00Z' }),
      branch({ id: 'B', is_active: true, created_at: '2026-10-20T13:00:00Z' }),
    ]);
    expect(plain.activeBranchId).toBeNull();
    expect(pickSelectedBranch(plain)?.id).toBe('B');

    const noFlag = normalizeBranchListResponse([
      branch({ id: 'A', created_at: '2026-10-20T12:00:00Z' }),
      branch({ id: 'C', created_at: '2026-10-20T15:00:00Z' }),
    ]);
    expect(pickSelectedBranch(noFlag)?.id).toBe('C');
  });

  it('空列表返回 null（不崩、不瞎选）', () => {
    expect(pickSelectedBranch(normalizeBranchListResponse({ branches: [] }))).toBeNull();
    expect(pickSelectedBranch(normalizeBranchListResponse(null))).toBeNull();
  });
});
