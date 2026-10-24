/**
 * 插件网络白名单的解析 / 序列化 / 本地读写（批次WU 2026-10-21）
 *
 * 运行时契约（与 sandbox.ts 的判定严格一致）：
 * - localStorage 键 `palink_plugin_fetch_whitelist` 的值是**逗号分隔的 hostname**
 *   （例：`localhost,127.0.0.1`），**不是 JSON 数组**。
 * - 判定只比 URL 的 hostname（小写、不含端口）；同源恒放行。
 * - 默认 CDN 名单恒定生效、不可由用户删除；用户项默认空。
 *
 * [批次 2026-10-24] loopback 主机默认放行（用户拍板，见
 * docs/_active/spec/SPEC_ST三面一致对齐施工计划_2026-10-24.md §0.1）：
 * - `localhost` / `127.0.0.1` / `[::1]` 三个本机主机名**无需加入名单**即恒定放行
 *   （判定只比 hostname，所以任意端口都放行）。
 * - 私网（192.168.x / 10.x / 172.16-31.x 等）与公网口径**不变**：仍必须显式加入
 *   用户名单才放行。
 * - 实现位置说明：运行时判定 `isUrlAllowedByPluginWhitelist` 在 sandbox.ts（本批不改），
 *   它读取本文件的 `readEffectivePluginFetchWhitelist`。因此 loopback 放行以
 *   「恒定生效项」的形式进入生效名单，与默认 CDN 同一机制 —— 用户清空名单也关不掉。
 *
 * 为什么 JSON 数组是**拒绝**而不是规范化：
 * 运行时只有一种格式契约。若解析器同时接受 JSON，用户"写成 JSON 却没生效"
 * 的既有事实会被悄悄改写，且序列化回归 JSON（本批的反证项）将无法被测试抓到。
 * 因此按逗号切出的 token 若带引号/方括号，通不过主机名校验，整条丢弃。
 * 用户通过设置页保存时会写回逗号格式，旧格式在下一次保存后自然消失。
 */

export const PLUGIN_FETCH_WHITELIST_STORAGE_KEY = 'palink_plugin_fetch_whitelist';

/**
 * 默认 CDN 名单（沙箱网络 S-1 的既有默认值，顺序与内容不得改动）。
 * 这些主机恒定放行，不写入 localStorage，也不可由用户删除。
 */
export const DEFAULT_PLUGIN_FETCH_WHITELIST: readonly string[] = Object.freeze([
  'cdn.jsdelivr.net',
  'unpkg.com',
  'cdnjs.cloudflare.com',
  'raw.githubusercontent.com',
  'github.com',
]);

/**
 * 本机 loopback 主机名（[批次 2026-10-24] 起默认放行，任意端口）。
 * 只认这三个字面形态：`localhost` / `127.0.0.1` / `[::1]`（URL.hostname 对 IPv6
 * 保留方括号）。**不含** 127.0.0.0/8 的其余地址、不含 0.0.0.0、不含私网段 ——
 * 判定只比裸 hostname，带端口/协议的写法本来就不进名单。
 */
export const PLUGIN_FETCH_LOOPBACK_HOSTS: readonly string[] = Object.freeze([
  'localhost',
  '127.0.0.1',
  '[::1]',
]);

/**
 * 判定一个裸 hostname（URL.hostname 形态，IPv6 带方括号）是否属于默认放行的本机 loopback。
 * 与运行时判定同一口径：先 trim 再小写，然后对 PLUGIN_FETCH_LOOPBACK_HOSTS 精确匹配。
 */
export function isLoopbackPluginFetchHost(hostname: string): boolean {
  const host = String(hostname ?? '').trim().toLowerCase();
  return (PLUGIN_FETCH_LOOPBACK_HOSTS as readonly string[]).includes(host);
}

/**
 * 严格主机名校验（运行时解析用）。
 * 允许普通 DNS 主机名 / IPv4 / 带方括号的 IPv6（URL.hostname 对 IPv6 保留方括号）。
 * 协议、端口、路径、引号、方括号数组语法一律不匹配。
 */
function isWhitelistHostname(value: string): boolean {
  if (/^\[[0-9a-f:.]+\]$/.test(value)) return true;
  return /^[a-z0-9](?:[a-z0-9._-]*[a-z0-9])?$/.test(value);
}

/**
 * 把用户输入规范化为裸 hostname（仅 UI 输入/序列化使用）。
 * 接受 `localhost`、`127.0.0.1`、`localhost:11434`、`http://localhost:11434/path`，
 * 统一返回小写 hostname；无法识别返回 null。IPv6 须写成 `[::1]`。
 */
export function normalizeWhitelistHostInput(input: string): string | null {
  const raw = String(input ?? '').trim().toLowerCase();
  if (!raw) return null;
  if (isWhitelistHostname(raw)) return raw;
  // 粘贴完整 URL / host:port 时交给 URL 解析取 hostname（端口与路径被丢弃，
  // 与运行时"只按主机名匹配"的语义一致）。
  const looksLikeUrl = raw.includes('://') || raw.includes('/') || /:\d+$/.test(raw);
  if (!looksLikeUrl) return null;
  try {
    const parsed = new URL(raw.includes('://') ? raw : `http://${raw}`);
    const hostname = parsed.hostname.toLowerCase();
    return hostname && isWhitelistHostname(hostname) ? hostname : null;
  } catch {
    return null;
  }
}

/**
 * 解析 localStorage 原始值（或任意逗号分隔字符串）为用户白名单。
 * 规则：按逗号切分 → trim → 小写 → 仅保留合法裸 hostname → 按出现顺序去重。
 * JSON 数组、带协议/端口/路径的 token 会被丢弃（见文件头说明）。
 */
export function parsePluginFetchWhitelist(raw: string | null | undefined): string[] {
  if (!raw) return [];
  const result: string[] = [];
  for (const token of String(raw).split(',')) {
    const host = token.trim().toLowerCase();
    if (host && isWhitelistHostname(host) && !result.includes(host)) {
      result.push(host);
    }
  }
  return result;
}

/**
 * 序列化为存储格式：小写、去重、逗号分隔（无空格）。
 * 空列表返回空串（写入侧会删除键）。
 */
export function serializePluginFetchWhitelist(list: readonly string[]): string {
  const result: string[] = [];
  for (const item of list) {
    const host = normalizeWhitelistHostInput(item);
    if (host && !result.includes(host)) {
      result.push(host);
    }
  }
  return result.join(',');
}

/** 读取用户配置项（不含默认 CDN）；localStorage 不可用时返回空数组。 */
export function readUserWhitelist(): string[] {
  try {
    return parsePluginFetchWhitelist(localStorage.getItem(PLUGIN_FETCH_WHITELIST_STORAGE_KEY));
  } catch {
    return [];
  }
}

/**
 * 写入用户配置项，返回实际落盘（规范化后）的列表。
 * 空列表删除键，保持"默认保持空"的初始状态。
 */
export function writeUserWhitelist(list: readonly string[]): string[] {
  const serialized = serializePluginFetchWhitelist(list);
  const hosts = serialized ? serialized.split(',') : [];
  try {
    if (serialized) {
      localStorage.setItem(PLUGIN_FETCH_WHITELIST_STORAGE_KEY, serialized);
    } else {
      localStorage.removeItem(PLUGIN_FETCH_WHITELIST_STORAGE_KEY);
    }
  } catch {
    // localStorage 不可用时静默：运行时读取同样回退为默认 CDN 名单
  }
  return hosts;
}

/**
 * 当前生效的完整白名单 = 默认 CDN 名单 + 本机 loopback（默认放行，2026-10-24）+ 用户项
 * （按出现顺序去重）。与旧 sandbox.ts 内联实现逐项等价：默认项在前、loopback 恒定生效
 * （用户清空名单也关不掉）、用户项去重追加。
 */
export function readEffectivePluginFetchWhitelist(): string[] {
  const effective = [...DEFAULT_PLUGIN_FETCH_WHITELIST];
  // [2026-10-24] loopback 恒定生效项：插在默认 CDN 之后、用户项之前。
  // 用户若手动加过同名项，这里去重后不会出现第二条。
  for (const host of PLUGIN_FETCH_LOOPBACK_HOSTS) {
    if (!effective.includes(host)) effective.push(host);
  }
  for (const host of readUserWhitelist()) {
    if (!effective.includes(host)) effective.push(host);
  }
  return effective;
}
