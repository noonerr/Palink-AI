/**
 * Palink ST Native 初始化脚本。
 *
 * 在 ST sidecar 容器启动时（docker-entrypoint.sh 中 npm run init 之后）运行，
 * 将 Palink 专用配置写入 config/config.yaml。
 *
 * 设计目标：
 *   - ST sidecar 仅通过 Docker 内部网络被 Palink backend 代理访问，不直接暴露
 *   - CSRF 由 Palink backend 处理，ST sidecar 无需 CSRF 保护
 *   - 关闭 IP 白名单/Host 白名单等会阻断 backend 容器访问的安全限制
 *   - 保留 whitelist 条目作为防御纵深（即使 whitelistMode 关闭）
 *
 * 幂等：多次运行不会破坏已有用户设置，只覆盖下述 Palink 专用键。
 */

import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { parse, stringify } from 'yaml';

const CONFIG_PATH = './config/config.yaml';

if (!existsSync(CONFIG_PATH)) {
  console.log('[palink-init] config/config.yaml not found, skipping.');
  process.exit(0);
}

const raw = readFileSync(CONFIG_PATH, 'utf8');
const config = parse(raw);

// --- 安全设置 ---
// ST sidecar 不直接暴露给外网，仅被 backend 容器代理访问
config.whitelistMode = false;
config.securityOverride = true;
config.disableCsrfProtection = true;

// 防御纵深：即使 whitelistMode=false，仍添加 Docker 内部 IP 段
if (!Array.isArray(config.whitelist)) {
  config.whitelist = ['::1', '127.0.0.1'];
}
const DOCKER_RANGES = ['172.16.0.0/12', '192.168.0.0/16'];
for (const range of DOCKER_RANGES) {
  if (!config.whitelist.includes(range)) {
    config.whitelist.push(range);
  }
}

// --- Host 白名单 ---
if (!config.hostWhitelist || typeof config.hostWhitelist !== 'object') {
  config.hostWhitelist = {};
}
config.hostWhitelist.enabled = false;
config.hostWhitelist.scan = false;

// --- SSRF 防护（对内部代理场景过于严格）---
if (config.privateAddressWhitelist && typeof config.privateAddressWhitelist === 'object') {
  config.privateAddressWhitelist.enabled = false;
}

// --- 浏览器启动（Docker 内无需）---
if (config.browserLaunch && typeof config.browserLaunch === 'object') {
  config.browserLaunch.enabled = false;
}

// --- CORS ---
if (config.cors && typeof config.cors === 'object') {
  config.cors.enabled = true;
  if (!Array.isArray(config.cors.origin)) {
    config.cors.origin = ['*'];
  } else if (!config.cors.origin.includes('*')) {
    config.cors.origin.push('*');
  }
  config.cors.credentials = false;
}

const output = stringify(config);
writeFileSync(CONFIG_PATH, output, 'utf8');

console.log('[palink-init] Palink-specific config applied to config/config.yaml:');
console.log('  whitelistMode = false');
console.log('  disableCsrfProtection = true');
console.log('  securityOverride = true');
console.log('  hostWhitelist.enabled = false, scan = false');
console.log('  whitelist += 172.16.0.0/12, 192.168.0.0/16');
console.log('  browserLaunch.enabled = false');
