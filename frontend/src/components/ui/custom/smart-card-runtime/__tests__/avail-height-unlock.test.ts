import { describe, expect, it } from 'vitest';
import {
  clampSmartCardOverrideHeight,
  resolveAvailableHeightCardResize,
} from '../avail-height-unlock';
import { IFRAME_INLINE_MAX_HEIGHT, INLINE_MIN_HEIGHT, SMART_CARD_AVAILHEIGHT_UNLOCK_MARGIN_PX } from '../shared';

describe('clampSmartCardOverrideHeight', () => {
  it('向上取整并夹取到 [INLINE_MIN_HEIGHT, IFRAME_INLINE_MAX_HEIGHT]', () => {
    expect(clampSmartCardOverrideHeight(3889.4)).toBe(3890);
    expect(clampSmartCardOverrideHeight(999_999)).toBe(IFRAME_INLINE_MAX_HEIGHT);
    expect(clampSmartCardOverrideHeight(10)).toBe(INLINE_MIN_HEIGHT);
  });

  it('非正数与非有限值返回 0（调用方按 keep-available 处理）', () => {
    expect(clampSmartCardOverrideHeight(0)).toBe(0);
    expect(clampSmartCardOverrideHeight(-5)).toBe(0);
    expect(clampSmartCardOverrideHeight(Number.NaN)).toBe(0);
  });
});

describe('resolveAvailableHeightCardResize', () => {
  const base = {
    reportedHeight: 3890,
    reportedRealContent: 3890,
    currentAvailableHeight: 830,
    overrideActive: false,
  };

  it('故事卡（min-height:100vh 长文）：realContent 远超可用空间 → 解锁按内容高', () => {
    expect(resolveAvailableHeightCardResize(base)).toEqual({
      action: 'unlock-content',
      height: 3890,
    });
  });

  it('pinned 界面卡：realContent ≈ 可用空间 → 不解锁，维持视口切片', () => {
    expect(
      resolveAvailableHeightCardResize({ ...base, reportedHeight: 830, reportedRealContent: 830 }),
    ).toEqual({ action: 'keep-available-height' });
  });

  it(`边际噪音（< +${SMART_CARD_AVAILHEIGHT_UNLOCK_MARGIN_PX}px）不解锁，恰好达到阈值才解锁`, () => {
    const below = resolveAvailableHeightCardResize({
      ...base,
      reportedHeight: 834,
      reportedRealContent: 834,
    });
    expect(below).toEqual({ action: 'keep-available-height' });

    const at = resolveAvailableHeightCardResize({
      ...base,
      reportedHeight: 830 + SMART_CARD_AVAILHEIGHT_UNLOCK_MARGIN_PX,
      reportedRealContent: 830 + SMART_CARD_AVAILHEIGHT_UNLOCK_MARGIN_PX,
    });
    expect(at).toEqual({ action: 'unlock-content', height: 838 });
  });

  it('可用空间未知（首帧几何未就绪）时不解锁', () => {
    expect(
      resolveAvailableHeightCardResize({ ...base, currentAvailableHeight: 0 }),
    ).toEqual({ action: 'keep-available-height' });
  });

  it('realContent 缺失（=0）时回退用 reportedHeight 判定', () => {
    expect(
      resolveAvailableHeightCardResize({ ...base, reportedRealContent: 0 }),
    ).toEqual({ action: 'unlock-content', height: 3890 });
  });

  it('解锁态：跟随后续内容上报（增长与收缩都跟随，支持内容收缩不残留空白）', () => {
    expect(
      resolveAvailableHeightCardResize({ ...base, overrideActive: true, reportedRealContent: 4200 }),
    ).toEqual({ action: 'follow-content', height: 4200 });
    expect(
      resolveAvailableHeightCardResize({
        ...base,
        overrideActive: true,
        reportedHeight: 500,
        reportedRealContent: 500,
        currentAvailableHeight: 2000,
      }),
    ).toEqual({ action: 'follow-content', height: 500 });
  });

  it('解锁态：上报无有效数值时维持现状（不回退视口切片）', () => {
    expect(
      resolveAvailableHeightCardResize({ ...base, overrideActive: true, reportedHeight: 0, reportedRealContent: 0 }),
    ).toEqual({ action: 'keep-available-height' });
  });

  it('解锁态：夹取上限 IFRAME_INLINE_MAX_HEIGHT，避免异常上报撑出视口', () => {
    expect(
      resolveAvailableHeightCardResize({ ...base, overrideActive: true, reportedRealContent: 99_999 }),
    ).toEqual({ action: 'follow-content', height: IFRAME_INLINE_MAX_HEIGHT });
  });
});
