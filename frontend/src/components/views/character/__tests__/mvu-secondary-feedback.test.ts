/*
 * [MVU-SECONDARY-FEEDBACK] 副 AI 结果反馈映射契约
 *
 * 钉住的是**最容易骗到用户的一环**：
 * 后端 `character_ext.py` 的 `trigger_mvu_secondary` 会返回 7 个 reason，
 * 而前端原来只覆盖了 4 个 —— `call_failed`（副模型调用抛异常）没有分支，
 * 掉进兜底 else 显示「变量更新完成（无变化）」。用户看到"完成"，
 * 实际变量一个字都没改，且没有任何报错。
 *
 * 本测试要保证：
 *   1. `call_failed` 必须是 error，且文案里**不能出现"完成"**；
 *   2. 后端可能返回的**每一个** reason 都被显式处理（不靠 default 兜底）；
 *   3. 未知 reason 一律报 error，不许静默当成"成功/无变化"。
 *
 * 运行: npx vitest run
 */
import { describe, it, expect } from 'vitest';
import { resolveMvuSecondaryFeedback } from '../mvuSecondaryFeedback';

/** 后端 `character_ext.py::trigger_mvu_secondary` 实际会返回的 reason 全集。 */
const BACKEND_REASONS = [
  'secondary_disabled',
  'secondary_model_missing',
  'no_schema',
  'call_failed',
  'no_patches',
  'ok',
  'no_change',
] as const;

describe('resolveMvuSecondaryFeedback', () => {
  it('applied=true → success「变量已更新」（不看 reason）', () => {
    const fb = resolveMvuSecondaryFeedback(true, 'ok');
    expect(fb.level).toBe('success');
    expect(fb.message).toBe('变量已更新');
  });

  it('★ call_failed → error，且文案不得含"完成"（这是本批修的 bug）', () => {
    const fb = resolveMvuSecondaryFeedback(false, 'call_failed');
    expect(fb.level).toBe('error');
    expect(fb.message).toContain('调用失败');
    expect(fb.message).not.toContain('完成');
  });

  it('副模型未配置族 → error', () => {
    for (const reason of ['secondary_disabled', 'secondary_model_missing']) {
      const fb = resolveMvuSecondaryFeedback(false, reason);
      expect(fb.level, reason).toBe('error');
      expect(fb.message, reason).toContain('副 AI 未配置');
    }
  });

  it('no_schema → error', () => {
    const fb = resolveMvuSecondaryFeedback(false, 'no_schema');
    expect(fb.level).toBe('error');
    expect(fb.message).toContain('无变量系统');
  });

  it('no_patches / no_change → info（这两个确实不是错误）', () => {
    const noPatches = resolveMvuSecondaryFeedback(false, 'no_patches');
    expect(noPatches.level).toBe('info');
    expect(noPatches.message).toContain('未解析出变量变化');

    const noChange = resolveMvuSecondaryFeedback(false, 'no_change');
    expect(noChange.level).toBe('info');
    expect(noChange.message).toBe('变量更新完成（无变化）');
  });

  it('reason 缺失时回落 no_patches（与组件原行为一致）', () => {
    const fb = resolveMvuSecondaryFeedback(false, undefined);
    expect(fb.level).toBe('info');
    expect(fb.message).toContain('未解析出变量变化');
  });

  it('★ 未知 reason → error，绝不谎报成功（防"下次新增 reason 又掉兜底"）', () => {
    const fb = resolveMvuSecondaryFeedback(false, 'some_future_reason');
    expect(fb.level).toBe('error');
    expect(fb.message).not.toContain('完成');
  });

  it('★ 后端 reason 全集穷举：每个都必须被显式处理（不得落进"未知原因"）', () => {
    // 反证口径：若某个 reason 被漏掉，它就会走到 default 分支、
    // 文案带"未知原因" → 这条断言立刻变红。
    const notOkButKnown = BACKEND_REASONS.filter((r) => r !== 'ok');
    for (const reason of notOkButKnown) {
      const fb = resolveMvuSecondaryFeedback(false, reason);
      expect(fb.message, `reason=${reason} 未被显式处理`).not.toContain('未知原因');
    }
  });
});
