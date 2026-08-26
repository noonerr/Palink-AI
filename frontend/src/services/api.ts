import { analyzeError, type ErrorInfo } from '@/lib/errorHandler';
import { emitEvent } from '@/lib/event-bus';
import type {
  ImageGenerationConfig,
  ImageGenerationMessageResponse,
  ImageGenerationTestResponse,
} from '@/types/imageGeneration';
import type {
  TTSBindingPayload,
  TTSManagementState,
  TTSPreviewMetadata,
  TTSPreviewRequest,
} from '@/types/tts';

// ── GET 请求缓存 ──────────────────────────────────────────
const _cache = new Map<string, { data: any; expires: number }>();
const _inflight = new Map<string, { promise: Promise<any> }>();
// 失效代次：每次 invalidateCache 递增。用于防止"失效前发起、失效后才返回"
// 的 in-flight 请求用陈旧数据重填缓存（stale set race）——这是导入这类慢操作
// 完成后列表刷新不出来、需等 TTL 过期才更新的根因之一。
let _cacheGeneration = 0;
// 记录每个失效前缀最近一次失效时的代次（'' 表示全局失效）。
// 写入缓存时仅当"发起请求后、返回前"发生过与本请求 key 匹配的失效才跳过写入，
// 避免无关前缀的失效（如 /api/plugins、/api/users/me/settings）误伤所有缓存写入，
// 导致带 TTL 的读接口缓存永远填不进去。
const _invalidatedPrefixGenerations = new Map<string, number>();

// ── GET 请求超时与重试 ────────────────────────────────────
const API_TIMEOUT_MS = 15_000;
const API_MAX_RETRIES = 2;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function backoffDelay(attempt: number): number {
  return 500 * 2 ** attempt;
}

// 合并外部 signal 与内部超时 controller：外部取消或超时任一发生即中断请求。
function combineAbort(outer: AbortSignal | undefined, controller: AbortController): AbortSignal {
  if (!outer) return controller.signal;
  if (typeof AbortSignal !== 'undefined' && typeof (AbortSignal as any).any === 'function') {
    return (AbortSignal as any).any([outer, controller.signal]) as AbortSignal;
  }
  if (outer.aborted) {
    controller.abort();
  } else {
    outer.addEventListener('abort', () => controller.abort(), { once: true });
  }
  return controller.signal;
}

function _headersKey(headers?: HeadersInit): string {
  if (!headers) return '';
  return Array.from(new Headers(headers).entries())
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, value]) => `${key}:${value}`)
    .join('|');
}

function _cacheKey(url: string, options?: Pick<RequestOptions, 'headers' | 'skipAuth'>): string {
  // N8-c 终态：认证唯一依赖 HttpOnly Cookie（浏览器级、无 JS 可读凭据），
  // 缓存键不再按 token 分域——同浏览器内登录态切换由 invalidateCache 全局失效兜底。
  const authScope = options?.skipAuth ? 'skip-auth' : 'auth';
  const headerScope = _headersKey(options?.headers);
  return `GET:${authScope}:${url}:${headerScope}`;
}

export function isAbortError(e: unknown): boolean {
  return e instanceof DOMException && e.name === 'AbortError';
}

function _getCached<T>(key: string): T | null {
  const entry = _cache.get(key);
  if (entry && Date.now() < entry.expires) return entry.data as T;
  if (entry) _cache.delete(key);
  return null;
}

function _setCache<T>(key: string, data: T, ttlMs: number): void {
  _cache.set(key, { data, expires: Date.now() + ttlMs });
}

export function invalidateCache(urlPrefix?: string): void {
  // 递增代次：使所有"失效前发起、尚未 _setCache"的 in-flight 请求丧失写缓存资格。
  _cacheGeneration++;
  if (!urlPrefix) {
    _invalidatedPrefixGenerations.clear();
    _invalidatedPrefixGenerations.set('', _cacheGeneration);
    _cache.clear();
    _inflight.clear();
    return;
  }
  _invalidatedPrefixGenerations.set(urlPrefix, _cacheGeneration);
  for (const key of _cache.keys()) {
    if (key.includes(urlPrefix)) _cache.delete(key);
  }
  for (const key of _inflight.keys()) {
    if (key.includes(urlPrefix)) _inflight.delete(key);
  }
}

// 判断自 genAtStart 以来是否有与本请求 key 匹配的失效发生
function wasCacheInvalidatedSince(key: string, genAtStart: number): boolean {
  for (const [prefix, gen] of _invalidatedPrefixGenerations) {
    if (gen > genAtStart && (prefix === '' || key.includes(prefix))) return true;
  }
  return false;
}

// ── 错误类型 ──────────────────────────────────────────────
export class ApiError extends Error {
  status: number;
  errorInfo: ErrorInfo;
  constructor(status: number, message: string, errorInfo: ErrorInfo) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.errorInfo = errorInfo;
  }
}

// ── 认证失败事件（App.tsx 监听后执行登出） ──────────────────
// @deprecated 使用事件总线 emitEvent('auth:failure') 替代
export const AUTH_FAILURE_EVENT = 'api:auth-failure';

// ── N8-c 终态：前端凭据直读/续期落地已整体退役 ──
// 认证唯一依赖 HttpOnly Cookie（palink_session），前端不再持有任何可读凭据；
// 滑动续期由服务端续期中间件直接 Set-Cookie 覆盖，前端无需再消费续期响应头。

function dispatchAuthFailure() {
  // 使用统一事件总线派发认证失败事件
  emitEvent('auth:failure', undefined as any);
}

// ── N8-b：CSRF 双提交令牌（palink_csrf 为可读 Cookie，登录时随 palink_session 下发）──
function getCsrfToken(): string {
  try {
    const match = document.cookie.match(/(?:^|;\s*)palink_csrf=([^;]*)/);
    return match ? decodeURIComponent(match[1]) : '';
  } catch {
    return '';
  }
}

const MUTATING_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

// ── 内部统一请求 ──────────────────────────────────────────
interface RequestOptions extends RequestInit {
  /** 已退役（N8-c）：不再注入 Authorization，仅为既有调用方兼容保留；仍参与 GET 缓存键作用域 */
  skipAuth?: boolean;
  /** GET 请求缓存时长（毫秒），设置后启用缓存 */
  cacheTtlMs?: number;
}

async function request<T = any>(
  url: string,
  options: RequestOptions = {},
): Promise<T> {
  const { cacheTtlMs: _cacheTtlMs, headers: rawHeaders, method = 'GET', credentials, ...fetchOptions } = options;

  // 仅对幂等 GET（且调用方未提供 signal）启用超时 + 自动重试；
  // 其他方法一律不重试（避免重复写入），调用方 signal 的取消语义需被尊重。
  const canRetry = method === 'GET' && !fetchOptions.signal;
  const maxAttempts = canRetry ? API_MAX_RETRIES + 1 : 1;

  let lastError: any = null;
  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    const headers = new Headers(rawHeaders);

    // N8-b：mutating 方法自动注入 CSRF 双提交头（调用方显式传入 X-CSRF-Token 时尊重不覆盖）
    if (MUTATING_METHODS.has(method) && !headers.has('X-CSRF-Token')) {
      headers.set('X-CSRF-Token', getCsrfToken());
    }

    // JSON 请求自动设置 Content-Type（FormData 除外）
    if (
      fetchOptions.body &&
      !(fetchOptions.body instanceof FormData) &&
      !headers.has('Content-Type')
    ) {
      headers.set('Content-Type', 'application/json');
    }

    // 超时保护：15s 未完成则 abort；若调用方提供了 signal，两者任一发生即中断。
    const controller = new AbortController();
    const timeoutId = window.setTimeout(() => controller.abort(), API_TIMEOUT_MS);
    const signal = combineAbort(fetchOptions.signal ?? undefined, controller);

    try {
      const res = await fetch(url, { ...fetchOptions, method, headers, signal, credentials: credentials ?? 'include' });

      // 401 → 派发统一登出事件
      if (res.status === 401) {
        dispatchAuthFailure();
        throw new ApiError(401, 'Unauthorized', analyzeError(new Error('401 Unauthorized')));
      }

      // 5xx → 可重试（仅 GET）
      if (canRetry && res.status >= 500 && attempt < maxAttempts - 1) {
        lastError = new ApiError(res.status, `Server error ${res.status}`, analyzeError(new Error(`HTTP ${res.status}`)));
        await sleep(backoffDelay(attempt));
        continue;
      }

      // 429/503 → 遵循 Retry-After（仅 GET）
      if (canRetry && (res.status === 429 || res.status === 503) && attempt < maxAttempts - 1) {
        const retryAfter = Number(res.headers.get('Retry-After'));
        const waitMs = Number.isFinite(retryAfter) && retryAfter > 0
          ? Math.min(retryAfter * 1000, API_TIMEOUT_MS)
          : backoffDelay(attempt);
        lastError = new ApiError(res.status, res.statusText || `HTTP ${res.status}`, analyzeError(new Error(`HTTP ${res.status}`)));
        await sleep(waitMs);
        continue;
      }

      if (!res.ok) {
        let detail: string;
        try {
          const body = await res.json();
          detail = body.detail || body.message || JSON.stringify(body);
        } catch {
          detail = res.statusText;
        }
        throw new ApiError(res.status, detail, analyzeError(new Error(`${res.status} ${detail}`)));
      }

      // 空响应
      if (res.status === 204) return undefined as T;

      const ct = res.headers.get('content-type');
      if (ct?.includes('application/json')) return res.json();

      return (await res.text()) as unknown as T;
    } catch (e) {
      if (canRetry && attempt < maxAttempts - 1) {
        // 超时(AbortError)/网络错误等 → 重试；canRetry 已排除调用方 signal，AbortError 必来自超时
        lastError = e;
        await sleep(backoffDelay(attempt));
        continue;
      }
      if (isAbortError(e) && canRetry) {
        // 超时且重试已耗尽 → 转成可读的 408
        throw new ApiError(408, `Request timed out after ${API_TIMEOUT_MS}ms`, analyzeError(e as Error));
      }
      throw e;
    } finally {
      clearTimeout(timeoutId);
    }
  }
  throw lastError;
}

// ── 流式请求（SSE） ──────────────────────────────────────
async function stream(
  url: string,
  body?: unknown,
  options?: RequestInit,
): Promise<Response> {
  const headers = new Headers(options?.headers);
  if (body && !(body instanceof FormData)) {
    headers.set('Content-Type', 'application/json');
  }

  const streamMethod = options?.method ?? 'POST';

  // N8-b：mutating 方法自动注入 CSRF 双提交头（调用方显式传入 X-CSRF-Token 时尊重不覆盖）
  if (MUTATING_METHODS.has(streamMethod) && !headers.has('X-CSRF-Token')) {
    headers.set('X-CSRF-Token', getCsrfToken());
  }

  const res = await fetch(url, {
    ...options,
    method: streamMethod,
    headers,
    body: body instanceof FormData ? body : JSON.stringify(body),
    credentials: options?.credentials ?? 'include',
  });

  if (res.status === 401) {
    dispatchAuthFailure();
    throw new ApiError(401, 'Unauthorized', analyzeError(new Error('401')));
  }

  if (!res.ok) {
    let detail: string;
    try {
      const b = await res.json();
      detail = b.detail || res.statusText;
    } catch {
      detail = res.statusText;
    }
    throw new ApiError(
      res.status,
      detail,
      analyzeError(new Error(`${res.status} ${detail}`)),
    );
  }

  return res; // 调用方自行 getReader()
}

// ── 导出便捷方法 ──────────────────────────────────────────
export const api = {
  get: <T = any>(url: string, options?: RequestOptions) => {
    const ttl = options?.cacheTtlMs;
    const key = _cacheKey(url, options);
    if (ttl) {
      const cached = _getCached<T>(key);
      if (cached) return Promise.resolve(cached);
    }
    const canDedupeInflight = !options?.signal;
    const existing = canDedupeInflight ? _inflight.get(key) : undefined;
    if (existing) return existing.promise as Promise<T>;
    // 捕获发起时的代次；若期间发生与本请求匹配的 invalidateCache，则完成后跳过
    // 写缓存，避免陈旧数据在失效之后重填缓存（导致刷新多次仍看到旧列表）。
    const genAtStart = _cacheGeneration;
    const promise = request<T>(url, { ...options, method: 'GET' }).then((data) => {
      if (ttl && !wasCacheInvalidatedSince(key, genAtStart)) _setCache(key, data, ttl);
      return data;
    }).finally(() => {
      if (canDedupeInflight) _inflight.delete(key);
    });
    if (canDedupeInflight) _inflight.set(key, { promise });
    return promise;
  },

  post: <T = any>(url: string, body?: unknown, options?: RequestOptions) =>
    request<T>(url, {
      ...options,
      method: 'POST',
      body: body instanceof FormData ? body : JSON.stringify(body),
    }),

  put: <T = any>(url: string, body?: unknown, options?: RequestOptions) =>
    request<T>(url, {
      ...options,
      method: 'PUT',
      body: body instanceof FormData ? body : JSON.stringify(body),
    }),

  delete: <T = any>(url: string, body?: unknown, options?: RequestOptions) =>
    request<T>(url, {
      ...options,
      method: 'DELETE',
      body: body ? JSON.stringify(body) : undefined,
    }),

  patch: <T = any>(url: string, body?: unknown, options?: RequestOptions) =>
    request<T>(url, {
      ...options,
      method: 'PATCH',
      body: body instanceof FormData ? body : JSON.stringify(body),
    }),

  /** SSE 流式请求，返回原始 Response 供调用方 getReader() */
  stream,

  /** 原始请求，返回 Response 对象（用于 blob 下载等场景） */
  raw: async (url: string, options?: RequestOptions): Promise<Response> => {
    const { headers: rawHeaders, ...fetchOptions } = options ?? {};
    const headers = new Headers(rawHeaders);
    // N8-b：mutating 方法自动注入 CSRF 双提交头（raw 未固定 method，默认 GET 不注入）
    const rawMethod = fetchOptions.method ?? 'GET';
    if (MUTATING_METHODS.has(rawMethod) && !headers.has('X-CSRF-Token')) {
      headers.set('X-CSRF-Token', getCsrfToken());
    }
    const res = await fetch(url, { ...fetchOptions, headers, credentials: fetchOptions.credentials ?? 'include' });
    if (res.status === 401) {
      dispatchAuthFailure();
      throw new ApiError(401, 'Unauthorized', analyzeError(new Error('401')));
    }
    return res;
  },

  /** TTS 语音合成 */
  tts: {
    synthesize: (
      text: string,
      voiceDescription?: string,
      isNarrator?: boolean,
      role?: string,
      characterId?: string,
      bindingOverride?: Partial<TTSBindingPayload>,
      options?: RequestOptions,
    ) =>
      api.post('/api/tts/synthesize', {
        text,
        voice_description: voiceDescription,
        is_narrator: isNarrator,
        role,
        character_id: characterId,
        binding_override: bindingOverride,
      }, options),

    getConfig: () => api.get('/api/tts/config'),
    saveConfig: (config: Record<string, unknown>) => api.post('/api/tts/config', config),

    getProviders: () => api.get('/api/tts/providers'),
    addProvider: (provider: Record<string, unknown>) => api.post('/api/tts/providers', provider),
    updateProvider: (providerId: string, provider: Record<string, unknown>) => api.put(`/api/tts/providers/${providerId}`, provider),
    deleteProvider: (providerId: string) => api.delete(`/api/tts/providers/${providerId}`),

    getVoices: () => api.get('/api/tts/voices'),
    setVoice: (voiceId: string, gender: string = 'female') =>
      api.post('/api/tts/set-voice', { voice_id: voiceId, gender }),
    getMyVoice: () => api.get('/api/tts/my-voice'),
    getManagement: () => api.get<TTSManagementState>('/api/tts/management'),
    saveAdminDefaultBindings: (bindings: TTSBindingPayload[]) =>
      api.put('/api/tts/admin/default-bindings', { bindings }),
    getMyBindings: () => api.get('/api/tts/my/bindings'),
    saveMyBindings: (bindings: TTSBindingPayload[]) =>
      api.put('/api/tts/my/bindings', { bindings }),
    getCharacterVoiceBindings: (characterId: string) =>
      api.get(`/api/tts/characters/${characterId}/voice-bindings`),
    saveCharacterVoiceBindings: (characterId: string, bindings: TTSBindingPayload[]) =>
      api.put(`/api/tts/characters/${characterId}/voice-bindings`, { bindings }),
    listCloneSamples: () => api.get('/api/tts/clone-samples'),
    uploadCloneSample: (formData: FormData) => api.post('/api/tts/clone-samples', formData),
    deleteCloneSample: (sampleId: string) => api.delete(`/api/tts/clone-samples/${sampleId}`),
    previewMetadata: (request: TTSPreviewRequest, options?: RequestOptions) =>
      api.post<TTSPreviewMetadata>('/api/tts/preview/metadata', request, options),
    fetchProviderVoices: (providerId: string) =>
      api.post<{ success: boolean; voices: Array<{ voice_id: string; gender: string; description: string }>; message: string }>(
        `/api/tts/providers/${providerId}/fetch-voices`
      ),
    updateProviderVoices: (providerId: string, voices: Array<{ voice_id: string; gender: string; description: string }>) =>
      api.put<{ success: boolean; message: string }>(`/api/tts/providers/${providerId}/voices`, voices),
    prefetchProviderVoices: (providerId: string, previewText?: string) =>
      api.post<{
        success: boolean;
        cached: Array<{ voice_id: string; gender: string; description: string; audio_b64: string; text: string }>;
        errors: Array<{ voice_id: string; error: string }>;
        message: string;
      }>(`/api/tts/providers/${providerId}/prefetch-voices`, { preview_text: previewText || '你好，我是测试' }),
  },

  /** 图像生成 */
  imageGeneration: {
    getConfig: () => api.get<ImageGenerationConfig>('/api/image-generation/config'),
    updateConfig: (config: ImageGenerationConfig) =>
      api.put<ImageGenerationConfig>('/api/image-generation/config', config),
    test: (prompt: string) =>
      api.post<ImageGenerationTestResponse>('/api/image-generation/test', { prompt }),
    generateForChatMessage: (sessionId: string, messageId: string | number) =>
      api.post<ImageGenerationMessageResponse>(`/api/image-generation/sessions/${sessionId}/messages/${messageId}`),
    generateForCharacterMessage: (sessionId: string, messageId: string | number) =>
      api.post<ImageGenerationMessageResponse>(`/api/image-generation/character-sessions/${sessionId}/messages/${messageId}`),
  },
};

export function ws(path: string): string {
  // N8-c 终态：不再向 URL 追加 query token（前端无可读凭据）；
  // WS 握手为同源请求，浏览器自动携带 palink_session Cookie。
  const { protocol, host } = window.location;
  const wsProtocol = protocol === 'https:' ? 'wss:' : 'ws:';
  const url = new URL(path, `${wsProtocol}//${host}`);
  return url.toString();
}
