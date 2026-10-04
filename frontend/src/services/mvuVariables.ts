/**
 * MVU 会话变量补丁写入（2026-10-05，MVU 补齐第二波/第三波）
 *
 * 后端端点：`POST /api/character-sessions/{sessionId}/variables/patch`
 * （`backend/app/api/mvu_variables_api.py`）
 *
 * ⚠️ 路径口径（踩过坑，别改回去）：
 * 后端 `mvu_engine.apply_patches` 内部先 `target = stat_data.get("stat_data", stat_data)`
 * 再应用补丁，最后包回 `result["stat_data"]`。所以这里的 path 是
 * **相对 stat_data** 的 —— 写成 `/stat_data/角色/好感度` 会多套一层
 * `stat_data.stat_data.角色`。正确写法是 `/角色/好感度`。
 */
import { api } from '@/services/api';

export interface MvuPatch {
  op: 'replace' | 'add' | 'remove' | 'delta';
  path: string;
  value?: unknown;
}

export interface MvuPatchResult {
  ok: boolean;
  variables?: Record<string, unknown>;
  logs?: string[];
  skipped?: number;
}

/** 把「分组 / 字段」两级键转成相对 stat_data 的 JSON Pointer。 */
export function buildStatDataPath(group: string, field: string): string {
  return `/${group}/${field}`;
}

/**
 * 按原值类型还原输入串：原来是数字就还原成数字，否则当字符串。
 * 这样后端拿到的仍是 number，进度条配色才不会退化成文本。
 */
export function coerceValueByOriginal(raw: string, original: unknown): unknown {
  if (typeof original === 'number') {
    const n = Number(raw);
    return Number.isFinite(n) ? n : raw;
  }
  if (typeof original === 'boolean') {
    if (raw === 'true' || raw === '是') return true;
    if (raw === 'false' || raw === '否') return false;
    return raw;
  }
  if (original !== null && typeof original === 'object') {
    try {
      return JSON.parse(raw);
    } catch {
      return raw;
    }
  }
  return raw;
}

/** 提交一组补丁，返回后端应用后的完整变量表（面板可直接拿去刷新）。 */
export async function patchSessionVariables(
  sessionId: string,
  patches: MvuPatch[],
): Promise<MvuPatchResult> {
  if (!sessionId) throw new Error('sessionId 缺失，无法写入会话变量');
  if (!patches.length) return { ok: true };
  return api.post<MvuPatchResult>(
    `/api/character-sessions/${encodeURIComponent(sessionId)}/variables/patch`,
    { patches },
  );
}
