/**
 * [批次UI1 2026-10-21] 预设"全局选中"与"本对话副本"的前端唯一入口。
 *
 * 背景（盘点报告 §1.2-③ / §3.2-③）：后端早就有
 *   GET|PUT /api/prompt-manager/presets/selection
 *   GET      /api/prompt-manager/sessions/{id}/preset
 * 但第一方 UI 一个 PUT 都没有，"当前预设"是组件自身 state ⇒ 用户看到的
 * 与卡片 `in_use` 是两套口径。本模块只做三件事：
 *   ① 读选中名（GET，不缓存）；
 *   ② 写选中名（PUT）+ 广播事件，让卡片侧快照重新拉取；
 *   ③ 读"本对话用的是全局默认还是副本"（只读，**不做**重置副本等写操作）。
 *
 * 事件 `palink-preset-selection-changed` 的消费者是
 * `CharacterCardRenderer` 的预设快照 effect —— 选中变化后必须重拉
 * `/presets/snapshot`，否则帧内三键会继续读到旧快照。
 */

import { api } from '@/services/api';

/** 后端 selection 路由的响应（`prompt_manager.py:95-140`）。 */
export interface PresetSelection {
  selected_name: string | null;
  resolved_name: string | null;
  resolved_id: number | null;
  /** selected = 命中选中名；fallback = 选中名缺失/失效后回落最近更新；none = 一份都没有 */
  source: 'selected' | 'fallback' | 'none' | string;
}

/** 本对话生效预设的来源（`preset_overlay.effective_preset`，只读展示用）。 */
export interface SessionPresetSource {
  source: 'session' | 'global';
  name: string | null;
  base_preset_id: string | number | null;
  base_name: string | null;
  is_session_copy: boolean;
}

export const PRESET_SELECTION_CHANGED_EVENT = 'palink-preset-selection-changed';

/** 读"用户选中的是哪份"（含后端解析结果）。失败由调用方处理。 */
export async function fetchPresetSelection(): Promise<PresetSelection> {
  return api.get<PresetSelection>('/api/prompt-manager/presets/selection');
}

/**
 * 写"用户选中的是哪份"。`null` = 清除选择（回到后端的三层回落口径）。
 * 成功后广播事件，触发卡片侧快照刷新。
 */
export async function putPresetSelection(name: string | null): Promise<PresetSelection> {
  const res = await api.put<PresetSelection>('/api/prompt-manager/presets/selection', { name });
  notifyPresetSelectionChanged(res?.selected_name ?? name);
  return res;
}

/** 只广播（给"不需要写库但要刷新帧内快照"的调用方留的口子）。 */
export function notifyPresetSelectionChanged(name: string | null = null): void {
  if (typeof window === 'undefined') return;
  window.dispatchEvent(
    new CustomEvent(PRESET_SELECTION_CHANGED_EVENT, { detail: { name } }),
  );
}

/**
 * 读本对话的预设来源。**只读**：本批不做"重置副本 / 复制到本对话"。
 * `sessionId` 为空时直接由调用方跳过，不在这里发请求。
 */
export async function fetchSessionPresetSource(sessionId: string): Promise<SessionPresetSource> {
  const id = String(sessionId || '').trim();
  if (!id) throw new Error('session_id_required');
  return api.get<SessionPresetSource>(
    `/api/prompt-manager/sessions/${encodeURIComponent(id)}/preset`,
  );
}
