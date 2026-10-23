import { describe, expect, it } from 'vitest';
import { AppError } from '../index';
import { analyzeError } from '../../errorHandler';

/**
 * L2-4 契约：AppError 的标题/建议必须取自 `lib/errorHandler.ts::errorMessages`
 * （唯一文案基准），描述保留具体错误；429 不再落到 unknown。
 */
describe('AppError ↔ errorMessages 单一文案基准（L2-4）', () => {
  it('标题/建议取自 errorMessages，描述保留具体错误', () => {
    const err = AppError.fromStreamError('boom');
    expect(err.type).toBe('unknown');
    expect(err.title).toBe('发生错误');
    expect(err.description).toBe('生成失败: boom');
    expect(err.suggestion).toBe('请稍后重试，或联系技术支持。');
  });

  it('模型错误映射到 model_unavailable（ErrorToast 图标表有该键）', () => {
    const err = AppError.fromModelError('no model');
    expect(err.type).toBe('model_unavailable');
    expect(err.title).toBe('模型不可用');
    expect(err.suggestion).toBe('请尝试切换到其他可用的模型。');
  });

  it('429 归到 rate_limit：AppError 与 analyzeError 口径一致', () => {
    const err = AppError.fromApiError(429, 'too many');
    expect(err.type).toBe('rate_limit');
    expect(err.title).toBe('请求过于频繁');
    expect(analyzeError('HTTP 429 Too Many Requests').type).toBe('rate_limit');
    expect(analyzeError('HTTP 429 Too Many Requests').title).toBe('请求过于频繁');
  });

  it('401 / 5xx 类型不变', () => {
    expect(AppError.fromApiError(401, 'x').type).toBe('auth');
    expect(AppError.fromApiError(503, 'x').type).toBe('server');
    expect(AppError.fromApiError(400, 'bad').type).toBe('validation');
  });
});
