/**
 * [MS-3 2026-10-22] `/branch-create {mesId}` 取不到锚点时**不得**创建谱系丢失的分支。
 *
 * 旧行为：anchor 为空也照样 POST，只是 `parent_branch_id/parent_message_id` 双双为空
 * ⇒ 库里 32 行分支父指针全 NULL 的来源之一。这条分支从此不知道自己从第几楼分出去，
 * 变量取值只能当它是从零开始的新故事（取证报告 §9 缺口 1）。
 *
 * 判据是"有没有发出那次写请求"，不是"源码里有没有这句话"。
 */
import { describe, expect, it, vi } from 'vitest';

const { apiPost } = vi.hoisted(() => ({ apiPost: vi.fn() }));

vi.mock('@/services/api', () => ({
  api: {
    get: vi.fn(),
    put: vi.fn(),
    patch: vi.fn(),
    delete: vi.fn(),
    post: (...args: unknown[]) => apiPost(...args),
  },
}));

import { runPalinkSlashCommands } from '../slash-commands-compat';

describe('/branch-create 的谱系守卫', () => {
  it('★ 取不到锚点 ⇒ 不建分支，并如实回一句', async () => {
    apiPost.mockReset();
    const out = await runPalinkSlashCommands('/branch-create 5', {
      sessionId: 's-1',
      resolveMessageAnchor: async () => null,
    });
    expect(apiPost).not.toHaveBeenCalled();
    expect(String(out)).toContain('未创建分支');
  });

  it('锚点只有分支号、没有消息号 ⇒ 同样不建（半截谱系等于没谱系）', async () => {
    apiPost.mockReset();
    const out = await runPalinkSlashCommands('/branch-create 5', {
      sessionId: 's-1',
      resolveMessageAnchor: async () => ({ branchId: 'b-9' }),
    });
    expect(apiPost).not.toHaveBeenCalled();
    expect(String(out)).toContain('未创建分支');
  });

  it('锚点齐备 ⇒ 正常创建，且父指针真的带上（不许回退成空）', async () => {
    apiPost.mockReset();
    apiPost.mockResolvedValue({ branch: { id: 'b-new' } });
    await runPalinkSlashCommands('/branch-create 5 尾巴', {
      sessionId: 's-1',
      resolveMessageAnchor: async () => ({ branchId: 'b-9', messageId: 2788 }),
    });
    expect(apiPost).toHaveBeenCalledTimes(1);
    const [url, body] = apiPost.mock.calls[0] as unknown as [string, Record<string, unknown>];
    expect(url).toContain('/branches');
    expect(body.parent_branch_id).toBe('b-9');
    expect(body.parent_message_id).toBe(2788);
    expect(body.same_level).toBe(false);
    // 如实记既有语义：`/^\/branch-create\s+(\d+)/` 只捕获楼号，分支名仅
    // `/checkpoint-create mesId=X {name}` 那条分支才带 —— 本批不改这条（不属本次范围）。
    expect('branch_name' in body).toBe(false);
  });
});
