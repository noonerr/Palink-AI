/**
 * 附件 URL 凭据处理（N-7 去主 JWT 化）。
 *
 * - `getUploadUrl(path)`（异步）：先向 POST /api/uploads/token 换取
 *   upload-scope 短时效令牌（5 分钟）再拼 URL；主 JWT 从此不进入附件 URL。
 * - `bareUploadHref(url)`：<a href> 专用——上传路径一律返回去掉 token 的
 *   裸路径，断言产物永不携带 token=。
 * - `stripUploadToken(url)` / `isUploadPath(url)`：纯函数工具。
 */
import { api } from '@/services/api';

const UPLOAD_TOKEN_ENDPOINT = '/api/uploads/token';
/** 服务端签发有效期 300s；提前 ~100s 刷新，避免边界 401 */
const UPLOAD_TOKEN_TTL_MS = 5 * 60 * 1000;
const UPLOAD_TOKEN_REFRESH_MARGIN_MS = 100 * 1000;

let cachedUploadToken: { value: string; fetchedAt: number } | null = null;
let inflightFetch: Promise<string | null> | null = null;

export function stripUploadToken(url: string): string {
  if (!url) return url;
  const queryIndex = url.indexOf('?');
  if (queryIndex === -1) return url;
  const base = url.slice(0, queryIndex);
  const kept = url
    .slice(queryIndex + 1)
    .split('&')
    .filter(part => part && !part.startsWith('token='));
  return kept.length ? `${base}?${kept.join('&')}` : base;
}

export function isUploadPath(url: string): boolean {
  if (!url) return false;
  const bare = stripUploadToken(url);
  return bare.startsWith('/api/uploads/') || bare.startsWith('/uploads/');
}

/** <a href> 用：上传路径返回去 token 的裸路径，其余 URL 原样返回。 */
export function bareUploadHref(url: string): string {
  if (!url) return url;
  if (isUploadPath(url)) return stripUploadToken(url);
  return url;
}

async function fetchUploadToken(): Promise<string | null> {
  if (
    cachedUploadToken &&
    Date.now() - cachedUploadToken.fetchedAt <
      UPLOAD_TOKEN_TTL_MS - UPLOAD_TOKEN_REFRESH_MARGIN_MS
  ) {
    return cachedUploadToken.value;
  }
  if (!inflightFetch) {
    inflightFetch = api
      .post<{ token?: string; expires_in?: number }>(UPLOAD_TOKEN_ENDPOINT)
      .then(data => {
        const token = data?.token || '';
        cachedUploadToken = token
          ? { value: token, fetchedAt: Date.now() }
          : null;
        return token || null;
      })
      .catch(() => null)
      .finally(() => {
        inflightFetch = null;
      });
  }
  return inflightFetch;
}

/**
 * 构造附件访问 URL：非上传路径原样返回；上传路径先取短时效令牌再拼接。
 * 令牌获取失败时退回裸路径（<img onError> 回退与旧行为一致）。
 */
export async function getUploadUrl(url: string): Promise<string> {
  if (!url) return url;
  const bare = stripUploadToken(url);
  if (!isUploadPath(bare)) return url;
  const token = await fetchUploadToken();
  if (!token) return bare;
  const sep = bare.includes('?') ? '&' : '?';
  return `${bare}${sep}token=${encodeURIComponent(token)}`;
}
