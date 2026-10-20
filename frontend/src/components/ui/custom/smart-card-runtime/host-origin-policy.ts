/**
 * 智能卡「主机档」判定 —— 本机/内网 vs 公网（批次Q1 · 2026-10-21）
 *
 * 用户第三次裁定（原文见 SPEC_向ST学习的子系统缺口与标记方案_2026-10-19.md §2.4）：
 * **分场合放开** —— 本机/内网访客的卡片帧**默认给 `allow-same-origin`**，不要求逐卡点信任；
 * 其余主机名一律视为公网访客，**维持现状**（未授信只给 `allow-scripts`，保持 opaque origin）。
 *
 * 为什么要单一函数：沙箱字符串只有一个计算点（`CharacterCardRenderer.tsx` 的 `sandbox`），
 * 而"这台机器算不算本机"这件事会被沙箱、诊断、真机探针三处问。散落成三份 `includes('localhost')`
 * 迟早在某一处漂掉，所以这里只留一份判据 + 一份取值入口。
 *
 * ⛔ 三条不许动的边界：
 *  1. **默认不放开**：拿不准的一律判公网（空串、畸形 IPv4、隧道域名、`172.15.x` / `172.32.x`）。
 *  2. 本文件**不决定**沙箱字符串，也不写任何信任存储 —— 它只回答"这台主机算哪档"。
 *     信任开关（`storage.ts` 的 read/writeSmartCardTrustGrant）语义一行没变，本机只是"不要求"。
 *  3. `allow-top-navigation` 任何情况都不给，与主机档无关（不在本文件出现）。
 */

/** 主机档：本机/内网 ⇒ 未授信也给同源；公网 ⇒ 维持 P1-1 的 opaque origin。 */
export type SmartCardHostTier = 'local-or-private' | 'public';

export interface SmartCardHostOriginPolicy {
  /** 归一化后的主机名（小写、去尾点）；取不到时为空串。 */
  hostname: string;
  tier: SmartCardHostTier;
  /** true ⇒ 未授信的卡片帧也给 `allow-same-origin`。 */
  grantsSameOrigin: boolean;
  /** 人读判据（进日志/诊断，别让下一个人猜为什么这台机器算本机）。 */
  reason: string;
}

/**
 * 精确命中表（归一化后逐字比较）。
 * `[::1]` 与 `::1` 都收：浏览器 `location.hostname` 对 IPv6 给的是带方括号的形式，
 * 而手写配置/测试里常见不带方括号的写法，两种都得认。
 */
const EXACT_LOCAL_HOSTNAMES: ReadonlySet<string> = new Set([
  'localhost',
  '127.0.0.1',
  '::1',
  '[::1]',
]);

const LOCAL_SUFFIX = '.local';

/** 归一化：去空白、转小写、去掉 FQDN 的尾点（`localhost.` 与 `localhost` 是同一台机器）。 */
export function normalizeSmartCardHostname(raw: string | null | undefined): string {
  return String(raw == null ? '' : raw).trim().toLowerCase().replace(/\.+$/, '');
}

/** 严格四段十进制 IPv4 → 四个 0-255 的数；任何畸形（段数不对/超界/带字母）返回 null。 */
function parseStrictIpv4(hostname: string): number[] | null {
  const parts = hostname.split('.');
  if (parts.length !== 4) return null;
  const octets: number[] = [];
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part)) return null;
    const value = Number(part);
    if (!Number.isFinite(value) || value < 0 || value > 255) return null;
    octets.push(value);
  }
  return octets;
}

/**
 * 本机/内网判定（**纯函数**，不看 `window`）。
 *
 * 命中集合（用户裁定原文）：`localhost` / `127.0.0.1` / `::1` / `[::1]` /
 * RFC1918 三段（`10.` / `172.16–172.31.` / `192.168.`）/ 以 `.local` 结尾（mDNS）。
 *
 * ⚠️ 这是**白名单**语义：不在名单里的一切（含 `trycloudflare.com` 这类公网隧道、
 * `172.15.x` / `172.32.x` 这两个边界、空串、畸形值）都判公网 —— 放开同源是不可逆的
 * 权限提升，宁可让用户在本机多点一次信任，也不能让公网访客误落放开档。
 */
export function isLocalOrPrivateHost(hostname: string): boolean {
  const host = normalizeSmartCardHostname(hostname);
  if (!host) return false;
  if (EXACT_LOCAL_HOSTNAMES.has(host)) return true;
  if (host.length > LOCAL_SUFFIX.length && host.endsWith(LOCAL_SUFFIX)) return true;
  const octets = parseStrictIpv4(host);
  if (!octets) return false;
  const [a, b] = octets;
  if (a === 10) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  return false;
}

/** 纯取值：给定主机名 ⇒ 档位 + 是否放开同源 + 判据。不读 `window`、不写日志。 */
export function resolveSmartCardHostOriginPolicy(hostname?: string | null): SmartCardHostOriginPolicy {
  const host = normalizeSmartCardHostname(hostname);
  const local = isLocalOrPrivateHost(host);
  return {
    hostname: host,
    tier: local ? 'local-or-private' : 'public',
    grantsSameOrigin: local,
    reason: local
      ? '本机/内网主机名命中白名单（localhost / 127.0.0.1 / ::1 / RFC1918 / .local）'
      : (host ? '非本机/内网主机名 ⇒ 按公网访客处理' : '主机名取不到 ⇒ 按公网访客处理（默认不放开）'),
  };
}

/** 人读一行：日志、诊断导出、真机探针共用同一句（别各自拼一套说法）。 */
export function describeSmartCardHostOriginPolicy(policy: SmartCardHostOriginPolicy): string {
  return '[smart-card] host-tier=' + policy.tier
    + ' host=' + (policy.hostname || '(empty)')
    + ' same-origin=' + (policy.grantsSameOrigin ? 'granted-when-untrusted' : 'requires-trust')
    + ' reason=' + policy.reason;
}

/** 读当前页主机名（无 `window` 环境给空串 ⇒ 判公网）。 */
function readCurrentHostname(): string {
  try {
    if (typeof window === 'undefined') return '';
    return String(window.location?.hostname || '');
  } catch {
    return '';
  }
}

let cachedPolicy: SmartCardHostOriginPolicy | null = null;
let cachedHostname: string | null = null;

/**
 * 取值入口（宿主侧唯一调用点）：算一次、缓存、把当前档写进日志与诊断。
 *
 * 为什么带副作用：真机排障时"这台机器算哪档"必须是**可读的**，否则"为什么这张卡没同源"
 * 只能靠猜。生产包 console 会被剥，所以同时挂 `window.__palinkHostOriginPolicy`
 * （真机探针读它，与 `__palinkCompatStats` 同一套取证口径）。
 */
export function getSmartCardHostOriginPolicy(): SmartCardHostOriginPolicy {
  const hostname = readCurrentHostname();
  if (cachedPolicy && cachedHostname === hostname) return cachedPolicy;
  const policy = resolveSmartCardHostOriginPolicy(hostname);
  cachedHostname = hostname;
  cachedPolicy = policy;
  try {
    // 每个主机名只写一次（缓存已保证），不刷屏。
    console.info(describeSmartCardHostOriginPolicy(policy));
  } catch {
    /* 日志失败不影响判定 */
  }
  try {
    if (typeof window !== 'undefined') {
      (window as unknown as Record<string, unknown>).__palinkHostOriginPolicy = policy;
    }
  } catch {
    /* 挂不上就算了：诊断入口是可选取证，不是功能依赖 */
  }
  return policy;
}

/** 测试用：清缓存（模块级缓存会让"换主机名"的用例读到上一台机器的档位）。 */
export function resetSmartCardHostOriginPolicyCache(): void {
  cachedPolicy = null;
  cachedHostname = null;
}
