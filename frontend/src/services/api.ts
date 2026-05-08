import { analyzeError, type ErrorInfo } from '@/lib/errorHandler';

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
export const AUTH_FAILURE_EVENT = 'api:auth-failure';

function getToken(): string | null {
  return localStorage.getItem('palink_token');
}

function dispatchAuthFailure() {
  window.dispatchEvent(new CustomEvent(AUTH_FAILURE_EVENT));
}

// ── 内部统一请求 ──────────────────────────────────────────
interface RequestOptions extends RequestInit {
  /** 跳过自动注入 Authorization 头 */
  skipAuth?: boolean;
}

async function request<T = any>(
  url: string,
  options: RequestOptions = {},
): Promise<T> {
  const { skipAuth, headers: rawHeaders, ...fetchOptions } = options;

  const headers = new Headers(rawHeaders);

  // 自动注入 token
  if (!skipAuth) {
    const token = getToken();
    if (token) {
      headers.set('Authorization', `Bearer ${token}`);
    }
  }

  // JSON 请求自动设置 Content-Type（FormData 除外）
  if (
    fetchOptions.body &&
    !(fetchOptions.body instanceof FormData) &&
    !headers.has('Content-Type')
  ) {
    headers.set('Content-Type', 'application/json');
  }

  const res = await fetch(url, { ...fetchOptions, headers });

  // 401 → 派发统一登出事件
  if (res.status === 401) {
    dispatchAuthFailure();
    throw new ApiError(401, 'Unauthorized', analyzeError(new Error('401 Unauthorized')));
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
}

// ── 流式请求（SSE） ──────────────────────────────────────
async function stream(
  url: string,
  body?: unknown,
  options?: RequestInit,
): Promise<Response> {
  const token = getToken();
  const headers = new Headers(options?.headers);
  if (token) headers.set('Authorization', `Bearer ${token}`);
  if (body && !(body instanceof FormData)) {
    headers.set('Content-Type', 'application/json');
  }

  const res = await fetch(url, {
    ...options,
    method: options?.method ?? 'POST',
    headers,
    body: body instanceof FormData ? body : JSON.stringify(body),
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
  get: <T = any>(url: string, options?: RequestOptions) =>
    request<T>(url, { ...options, method: 'GET' }),

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
    const { skipAuth, headers: rawHeaders, ...fetchOptions } = options ?? {};
    const headers = new Headers(rawHeaders);
    if (!skipAuth) {
      const token = getToken();
      if (token) headers.set('Authorization', `Bearer ${token}`);
    }
    const res = await fetch(url, { ...fetchOptions, headers });
    if (res.status === 401) {
      dispatchAuthFailure();
      throw new ApiError(401, 'Unauthorized', analyzeError(new Error('401')));
    }
    return res;
  },
};

export function ws(path: string): string {
  const { protocol, host } = window.location;
  const wsProtocol = protocol === 'https:' ? 'wss:' : 'ws:';
  const token = getToken();
  const url = new URL(path, `${wsProtocol}//${host}`);
  if (token) url.searchParams.set('token', token);
  return url.toString();
}
