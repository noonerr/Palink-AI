import { describe, expect, it } from 'vitest';
import { resolveBranchCreateAnchor } from '../branch-selection';

/**
 * R5 契约（2026-10-23 用户裁定 A：从当前进度分叉）：
 * 侧栏「新分支」必须锚到当前分支的最后一条 assistant 消息，而不是发 same_level=true。
 */
describe('resolveBranchCreateAnchor（R5 从当前进度分叉）', () => {
  const msgs = [
    { id: 1, role: 'assistant' },
    { id: 2, role: 'user' },
    { id: 3, role: 'assistant' },
  ];

  it('锚到最后一条 assistant 消息', () => {
    expect(resolveBranchCreateAnchor('br-1', msgs)).toEqual({
      parent_branch_id: 'br-1',
      parent_message_id: 3,
    });
  });

  it('跳过结尾的系统提示（extra.ignore），不会把错误占位楼当锚点', () => {
    const withNote = [
      ...msgs,
      { id: 4, role: 'assistant', extra: { ignore: true } },
    ];
    expect(resolveBranchCreateAnchor('br-1', withNote)?.parent_message_id).toBe(3);
  });

  it('跳过没有 id 的消息（后端序列化可能缺 id）', () => {
    const withMissingId = [
      { id: 1, role: 'assistant' },
      { id: undefined, role: 'assistant' },
    ];
    expect(resolveBranchCreateAnchor('br-1', withMissingId)?.parent_message_id).toBe(1);
  });

  it('没有 assistant 楼（空分支/只有用户楼）⇒ null，调用方退回同级语义', () => {
    expect(resolveBranchCreateAnchor('br-1', [{ id: 9, role: 'user' }])).toBeNull();
    expect(resolveBranchCreateAnchor('br-1', [])).toBeNull();
  });

  it('没有分支 ⇒ null', () => {
    expect(resolveBranchCreateAnchor(null, msgs)).toBeNull();
    expect(resolveBranchCreateAnchor(undefined, msgs)).toBeNull();
  });
});
