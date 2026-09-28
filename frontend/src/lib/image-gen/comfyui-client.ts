/**
 * ComfyUI 浏览器直连客户端（纯函数，无 React 依赖，可被契约测试直接覆盖）。
 *
 * 背景（SPEC_文生图浏览器桥接执行_本机ComfyUI_2026-09-28）：托管部署下 Palink
 * 后端够不到用户本机的 ComfyUI，改为后端组装工作流 → 本模块在用户浏览器里
 * POST http://127.0.0.1:8188/prompt → 轮询 /history → /view 取图 → 回传后端。
 *
 * 浏览器侧三道闸门的对策：
 * - 混合内容：127.0.0.1 被主流浏览器视为可信来源，HTTPS 页面可发（Safari 除外，已知限制）；
 * - 本机网络授权：Chrome 142+/Firefox 149+ 首次请求会弹权限框，用户允许后持久；
 * - CORS：ComfyUI 必须带 `--enable-cors-header '<站点origin>'` 启动，探测函数
 *   的两段式设计就是为了把「没启动」和「没放行 CORS」区分开，分别给指引。
 */
import type { LocalImageTask } from '@/types/imageGeneration';

export type ComfyUIProbeStatus = 'ok' | 'cors_blocked' | 'unreachable';

export interface ComfyUIProbeResult {
  status: ComfyUIProbeStatus;
  version?: string;
  message: string;
}

/** 执行失败分类：executor 据此把可行动的中文原因回传后端。 */
export type ComfyUIFailureCode =
  | 'connect_failed'
  | 'cors_blocked'
  | 'submit_rejected'
  | 'workflow_error'
  | 'timeout'
  | 'empty_image';

export class ComfyUIError extends Error {
  code: ComfyUIFailureCode;

  constructor(code: ComfyUIFailureCode, message: string) {
    super(message);
    this.name = 'ComfyUIError';
    this.code = code;
  }
}

function normalizeBase(baseUrl: string): string {
  return String(baseUrl || '').trim().replace(/\/+$/, '');
}

async function fetchWithTimeout(url: string, init: RequestInit, timeoutMs: number): Promise<Response> {
  const controller = new AbortController();
  const timer = window.setTimeout(() => controller.abort(), Math.max(timeoutMs, 1));
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } finally {
    window.clearTimeout(timer);
  }
}

/**
 * 两段式探测：(1) no-cors 探端口是否有服务应答；(2) 带 CORS 真请求确认可读。
 * 端口上有服务但 CORS 读不了 → cors_blocked（需要启动参数）；端口无应答 → unreachable。
 * 注意 no-cors 模式读不到响应内容，只能证明「端口上有东西」——所以第二段是必须的。
 */
export async function probeComfyUI(baseUrl: string, timeoutMs = 3000): Promise<ComfyUIProbeResult> {
  const base = normalizeBase(baseUrl);
  if (!base) {
    return { status: 'unreachable', message: '请先填写 ComfyUI 地址' };
  }
  try {
    await fetchWithTimeout(`${base}/system_stats`, { mode: 'no-cors' }, timeoutMs);
  } catch {
    return {
      status: 'unreachable',
      message: '本机端口无服务应答（ComfyUI 未启动，或地址/端口不对）',
    };
  }
  try {
    const resp = await fetchWithTimeout(`${base}/system_stats`, {}, timeoutMs);
    const data = await resp.json().catch(() => null);
    const version = typeof data?.system?.comfyui_version === 'string' ? data.system.comfyui_version : undefined;
    return {
      status: 'ok',
      version,
      message: version ? `在线，ComfyUI ${version}` : '在线，浏览器可直连',
    };
  } catch {
    return {
      status: 'cors_blocked',
      message: '检测到本机 ComfyUI 在运行，但浏览器直连被 CORS 拦截——请按下方连接向导加启动参数',
    };
  }
}

/** 从 /history/{prompt_id} 条目里挑第一张输出图（与后端 _extract_comfyui_image_ref 同规则）。 */
function extractImageRef(entry: unknown): { filename: string; subfolder: string; type: string } | null {
  const outputs = (entry as { outputs?: unknown } | null)?.outputs;
  if (!outputs || typeof outputs !== 'object') return null;
  let fallback: { filename: string; subfolder: string; type: string } | null = null;
  for (const nodeOutput of Object.values(outputs as Record<string, unknown>)) {
    const images = (nodeOutput as { images?: unknown } | null)?.images;
    if (!Array.isArray(images)) continue;
    for (const image of images) {
      const record = image as { filename?: unknown; subfolder?: unknown; type?: unknown } | null;
      if (!record || typeof record.filename !== 'string' || !record.filename) continue;
      const ref = {
        filename: record.filename,
        subfolder: typeof record.subfolder === 'string' ? record.subfolder : '',
        type: typeof record.type === 'string' ? record.type : 'output',
      };
      if (ref.type === 'output') return ref;
      if (!fallback) fallback = ref;
    }
  }
  return fallback;
}

function blobToBase64(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const dataUrl = String(reader.result || '');
      const commaIndex = dataUrl.indexOf(',');
      if (commaIndex < 0) {
        reject(new ComfyUIError('empty_image', '图片数据为空'));
        return;
      }
      resolve(dataUrl.slice(commaIndex + 1));
    };
    reader.onerror = () => reject(new ComfyUIError('empty_image', '读取图片数据失败'));
    reader.readAsDataURL(blob);
  });
}

function describeFetchError(error: unknown, stage: string): ComfyUIError {
  if (error instanceof ComfyUIError) return error;
  // 浏览器把「连接拒绝」和「CORS 拦截」都归并为 TypeError，无法区分——
  // 文案同时覆盖两种情况的下一步动作（诊断交给设置页的探测按钮）。
  if (error instanceof DOMException && error.name === 'AbortError') {
    return new ComfyUIError('timeout', `本机 ComfyUI ${stage}阶段响应超时`);
  }
  return new ComfyUIError(
    'connect_failed',
    '无法连接本机 ComfyUI（未启动？浏览器未授权「本地网络访问」？或 CORS 未放行本站点）',
  );
}

export interface ComfyUIExecuteOptions {
  /** 阶段回调：submit → poll → fetch（设置页试跑时可展示进度）。 */
  onStage?: (stage: 'submit' | 'poll' | 'fetch') => void;
  /** 比后端任务时限提前收手的余量（毫秒），默认 5s——先上报失败，别让后端先超时。 */
  deadlineMarginMs?: number;
  /** 轮询 /history 的间隔（毫秒），默认 1500；测试里可调快。 */
  pollIntervalMs?: number;
  /** 覆盖 deadline（测试钩子；不传则按 timeout_ms − 余量推算，下限 10s）。 */
  deadlineMs?: number;
}

/**
 * 执行一个本地出图任务，返回「裸 base64」图片数组（回传后端用）。
 * 抛 ComfyUIError（code 分类），由 executor 统一转成 /fail 上报。
 */
export async function executeComfyUITask(task: LocalImageTask, options?: ComfyUIExecuteOptions): Promise<string[]> {
  const base = normalizeBase(task.base_url);
  if (!base) {
    throw new ComfyUIError('submit_rejected', '任务缺少 ComfyUI 地址');
  }
  const margin = options?.deadlineMarginMs ?? 5000;
  const deadline = options?.deadlineMs ?? Date.now() + Math.max(task.timeout_ms - margin, 10_000);
  const remaining = () => deadline - Date.now();
  const pollInterval = options?.pollIntervalMs ?? 1500;

  options?.onStage?.('submit');
  let promptId = '';
  try {
    const submitResp = await fetchWithTimeout(
      `${base}/prompt`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ prompt: task.workflow }),
      },
      remaining(),
    );
    if (!submitResp.ok) {
      throw new ComfyUIError('submit_rejected', `ComfyUI 拒绝了出图请求（HTTP ${submitResp.status}）`);
    }
    const data = await submitResp.json().catch(() => null);
    promptId = typeof data?.prompt_id === 'string' ? data.prompt_id : '';
  } catch (error) {
    throw describeFetchError(error, '提交');
  }
  if (!promptId) {
    throw new ComfyUIError('submit_rejected', 'ComfyUI 未返回 prompt_id');
  }

  options?.onStage?.('poll');
  const historyUrl = `${base}/history/${encodeURIComponent(promptId)}`;
  while (Date.now() < deadline) {
    await new Promise((resolve) => window.setTimeout(resolve, pollInterval));
    if (Date.now() >= deadline) break;
    let entry: unknown = null;
    try {
      const historyResp = await fetchWithTimeout(historyUrl, {}, remaining());
      if (!historyResp.ok) continue;
      const history = await historyResp.json().catch(() => null);
      entry = history ? (history as Record<string, unknown>)[promptId] : null;
    } catch (error) {
      throw describeFetchError(error, '取进度');
    }
    if (!entry || typeof entry !== 'object') continue;
    const statusStr = String((entry as { status?: { status_str?: unknown } }).status?.status_str ?? '').toLowerCase();
    if (statusStr === 'error') {
      throw new ComfyUIError('workflow_error', 'ComfyUI 工作流执行失败（请查看 ComfyUI 服务端日志）');
    }
    const imageRef = extractImageRef(entry);
    if (!imageRef) continue;

    options?.onStage?.('fetch');
    try {
      const viewResp = await fetchWithTimeout(
        `${base}/view?${new URLSearchParams(imageRef)}`,
        {},
        remaining(),
      );
      if (!viewResp.ok) {
        throw new ComfyUIError('empty_image', `ComfyUI 取图失败（HTTP ${viewResp.status}）`);
      }
      const blob = await viewResp.blob();
      if (!blob.size) {
        throw new ComfyUIError('empty_image', 'ComfyUI 返回了空图片');
      }
      return [await blobToBase64(blob)];
    } catch (error) {
      throw describeFetchError(error, '取图');
    }
  }
  throw new ComfyUIError('timeout', '本机 ComfyUI 出图超时');
}
