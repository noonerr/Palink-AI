/**
 * Smart Card 帧内运行时 · 旧版 SillyTavern 全局模拟段
 *
 * 来源：CharacterCardRenderer.tsx `buildShim()` 原 L2373-4372，逐字节搬运，未改动任何逻辑。
 * 该段是注入到卡片 iframe 内的 JS 源码文本，运行在 iframe 作用域内，
 * 与后续 `buildFrameMeasureSegment()` 产物同处一个 IIFE，共享词法作用域
 * （例如本段定义的 getContext / parentDocumentStore 会被测量段引用，反之
 *  本段结尾的 window.sendToTavern 之后紧接测量段的 imageQueue* 常量）。
 *
 * 约束（改动前必读）：
 *  1. 各分段是模板字符串常量，内部**不得**出现反引号或 \${，否则会被宿主模板解析。
 *  2. 拼接顺序固定：HEAD(ctx/frameId) → 本段 → 测量段 → IIFE 收尾，不可调换。
 *  3. 修改后必须跑 `node scripts/verify-shim-identity.mjs` 比对字节快照。
 *
 * [S4 2026-10-15] 本文件原本是单个 2482 行的模板字符串常量，已按行机械拆成
 * legacy-st-sim-parts/part-a|b|c.ts 三段，本文件只负责按 a → b → c 顺序拼接；
 * 拆分已由 verify-shim-identity.mjs 证明产物 SHA-256 未变。
 */
import { LEGACY_ST_SIM_SEGMENT_PART_A } from './legacy-st-sim-parts/part-a';
import { LEGACY_ST_SIM_SEGMENT_PART_B } from './legacy-st-sim-parts/part-b';
import { LEGACY_ST_SIM_SEGMENT_PART_C } from './legacy-st-sim-parts/part-c';

export const LEGACY_ST_SIM_SEGMENT = (
  LEGACY_ST_SIM_SEGMENT_PART_A +
  LEGACY_ST_SIM_SEGMENT_PART_B +
  LEGACY_ST_SIM_SEGMENT_PART_C
);
