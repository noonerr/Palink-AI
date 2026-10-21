/*
 * [批次WU 2026-10-21] 插件网络白名单：存储格式契约 + 运行时判定共用同一份实现。
 *
 * 这一批的由来（REPORT_第三方真实插件实验与链接安装_2026-10-21.md 订正段）：
 * 白名单**机制一直是通的**（sandbox.ts 的 isUrlAllowedByPluginWhitelist），
 * 缺的只是入口 —— 想放行本机 Ollama 只能手工敲 localStorage，普通用户等于没有。
 * 于是本批加设置页控件。**真正的风险不在"有没有 UI"，而在 UI 写的格式
 * 运行时读不读得懂**：如果 UI 写 JSON 数组而运行时按逗号切，
 * 用户加完主机照样被拦，且两边都不报错（静默失效，和历史上那批"接上了但读不到"同一类）。
 *
 * 所以这里钉的是**跨文件契约**，不是模块自洽：
 *   1. 落盘格式 = 逗号分隔裸主机名（不是 JSON），且这是运行时唯一认的格式；
 *   2. 写进去之后，用**沙箱真正的那个判定函数**复核它确实放行了（不是再读一遍 localStorage）；
 *   3. 默认 CDN 五项恒定生效、不可被用户覆盖或删除；同源恒放行；
 *   4. 手工敲的历史值（带空格）仍可读；写成 JSON 的"看着对但没用"的值整条丢弃；
 *   5. 空列表删除键（回到"默认保持空"的初始态）。
 *
 * 运行: npx vitest run src/lib/plugin-system/__tests__/wu-plugin-fetch-whitelist.test.ts
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  DEFAULT_PLUGIN_FETCH_WHITELIST,
  PLUGIN_FETCH_WHITELIST_STORAGE_KEY,
  normalizeWhitelistHostInput,
  parsePluginFetchWhitelist,
  readEffectivePluginFetchWhitelist,
  readUserWhitelist,
  serializePluginFetchWhitelist,
  writeUserWhitelist,
} from '../plugin-fetch-whitelist';
// 判定入口必须是沙箱那一个：另写一份"看起来一样"的断言，就等于没测这条链
import { isUrlAllowedByPluginWhitelist } from '../sandbox';

/** 与页面端口不同的端口 ⇒ 保证测的是"跨源命中白名单"，不是"同源恒放行"。 */
const CROSS_PORT = 43999;

function urlAt(host: string, port?: number): string {
  return `http://${host}${port ? `:${port}` : ''}/api/tags`;
}

let savedValue: string | null = null;

beforeEach(() => {
  savedValue = localStorage.getItem(PLUGIN_FETCH_WHITELIST_STORAGE_KEY);
  localStorage.removeItem(PLUGIN_FETCH_WHITELIST_STORAGE_KEY);
});

afterEach(() => {
  localStorage.removeItem(PLUGIN_FETCH_WHITELIST_STORAGE_KEY);
  if (savedValue !== null) localStorage.setItem(PLUGIN_FETCH_WHITELIST_STORAGE_KEY, savedValue);
});

describe('存储格式契约（UI 与运行时唯一的交汇点）', () => {
  it('默认 CDN 五项与 S-1 既有值逐项一致，顺序也不许漂', () => {
    expect([...DEFAULT_PLUGIN_FETCH_WHITELIST]).toEqual([
      'cdn.jsdelivr.net',
      'unpkg.com',
      'cdnjs.cloudflare.com',
      'raw.githubusercontent.com',
      'github.com',
    ]);
  });

  it('落盘是逗号分隔裸主机名，不是 JSON —— 运行时只认这一种', () => {
    const saved = writeUserWhitelist(['127.0.0.1', 'localhost']);
    expect(localStorage.getItem(PLUGIN_FETCH_WHITELIST_STORAGE_KEY)).toBe('127.0.0.1,localhost');
    expect(saved).toEqual(['127.0.0.1', 'localhost']);
  });

  it('手工写成 JSON 数组：整条丢弃（不"顺手兼容"，也不静默改写用户意图）', () => {
    localStorage.setItem(PLUGIN_FETCH_WHITELIST_STORAGE_KEY, '["localhost"]');
    expect(readUserWhitelist()).toEqual([]);
    expect(isUrlAllowedByPluginWhitelist(urlAt('localhost', CROSS_PORT))).toBe(false);
  });

  it('读旧值按逗号切：带空格、大小写混杂的历史手敲值仍可用', () => {
    localStorage.setItem(PLUGIN_FETCH_WHITELIST_STORAGE_KEY, ' LocalHost , 127.0.0.1 ,LocalHost');
    expect(readUserWhitelist()).toEqual(['localhost', '127.0.0.1']);
  });

  it('空列表删除键 ⇒ 回到"默认保持空"的初始态', () => {
    writeUserWhitelist(['localhost']);
    writeUserWhitelist([]);
    expect(localStorage.getItem(PLUGIN_FETCH_WHITELIST_STORAGE_KEY)).toBe(null);
    expect(readUserWhitelist()).toEqual([]);
  });

  it('序列化会二次归一：混进来的 URL / 端口 / 重复项都被收成裸主机名', () => {
    expect(
      serializePluginFetchWhitelist([
        'http://localhost:11434/v1/chat/completions',
        'LOCALHOST',
        '127.0.0.1:7860',
        'not a host',
      ]),
    ).toBe('localhost,127.0.0.1');
  });

  it('生效名单 = 默认项在前 + 用户项追加；用户重复默认项不产生第二条', () => {
    localStorage.setItem(PLUGIN_FETCH_WHITELIST_STORAGE_KEY, 'unpkg.com,ollama.internal');
    const effective = readEffectivePluginFetchWhitelist();
    expect(effective.slice(0, DEFAULT_PLUGIN_FETCH_WHITELIST.length)).toEqual([
      ...DEFAULT_PLUGIN_FETCH_WHITELIST,
    ]);
    expect(effective).toContain('ollama.internal');
    expect(effective.filter((h) => h === 'unpkg.com')).toEqual(['unpkg.com']);
  });
});

describe('输入归一化', () => {
  it('接受裸主机名 / host:port / 完整 URL，一律回裸主机名', () => {
    expect(normalizeWhitelistHostInput('localhost')).toBe('localhost');
    expect(normalizeWhitelistHostInput('  LocalHost:11434 ')).toBe('localhost');
    expect(normalizeWhitelistHostInput('http://127.0.0.1:7860/api')).toBe('127.0.0.1');
    expect(normalizeWhitelistHostInput('[::1]')).toBe('[::1]');
  });

  it('拒绝带协议却缺主机、带空格、明显不是主机的输入', () => {
    expect(normalizeWhitelistHostInput('')).toBe(null);
    expect(normalizeWhitelistHostInput('localhost:abc')).toBe(null);
    expect(normalizeWhitelistHostInput('my computer')).toBe(null);
    expect(normalizeWhitelistHostInput('<script>')).toBe(null);
  });
});

describe('运行时判定（沙箱真正用的那个函数）', () => {
  it('同源恒放行，用户名单为空也放行', () => {
    expect(isUrlAllowedByPluginWhitelist(`${window.location.origin}/api/plugins`)).toBe(true);
  });

  it('未放行的主机一律拦，本机服务也不例外（这就是加白名单前的现状）', () => {
    expect(isUrlAllowedByPluginWhitelist('https://cdn.jsdelivr.net/npm/gsap@3/dist/gsap.min.js')).toBe(true);
    expect(isUrlAllowedByPluginWhitelist('http://evil.example.com/x.js')).toBe(false);
    expect(isUrlAllowedByPluginWhitelist(urlAt('127.0.0.1', 11434))).toBe(false);
  });

  it('UI 写入 ⇒ 沙箱判定放行：只看主机名，端口与路径被忽略', () => {
    writeUserWhitelist(['127.0.0.1']);
    expect(isUrlAllowedByPluginWhitelist(urlAt('127.0.0.1', 11434))).toBe(true);
    expect(isUrlAllowedByPluginWhitelist('http://127.0.0.1:7860/sdapi/v1/txt2img')).toBe(true);
    // 同主机名之外的主机仍被拦：证明放行是按主机名命中，不是"开了一条口子全通"
    expect(isUrlAllowedByPluginWhitelist(urlAt('192.168.1.9', 11434))).toBe(false);
  });

  it('删除名单项 ⇒ 判定立即回到拦截（无缓存残留）', () => {
    writeUserWhitelist(['localhost']);
    expect(isUrlAllowedByPluginWhitelist(urlAt('localhost', CROSS_PORT))).toBe(true);
    writeUserWhitelist([]);
    expect(isUrlAllowedByPluginWhitelist(urlAt('localhost', CROSS_PORT))).toBe(false);
  });

  it('IPv6 须写成 [::1]，URL.hostname 的方括号形式能对上', () => {
    writeUserWhitelist(['[::1]']);
    expect(isUrlAllowedByPluginWhitelist('http://[::1]:11434/api/tags')).toBe(true);
  });

  it('相对路径按页面基址解析 ⇒ 判同源放行（插件 fetch 自身模板走的就是这条）', () => {
    expect(isUrlAllowedByPluginWhitelist('/scripts/extensions/quick-reply/html/settings.html')).toBe(true);
  });

  it('只有 URL 构造本身失败才判 false（不是"看着不像 URL 就拦"）', () => {
    // 反证记录：'not a url' 会被 new URL(base) 解析成站内相对路径 ⇒ 放行。
    // 白名单只约束**跨源**，任何相对写法都是同源，本就该放行。
    expect(isUrlAllowedByPluginWhitelist('not a url')).toBe(true);
    expect(isUrlAllowedByPluginWhitelist('http://')).toBe(false);
  });

  it('解析层空输入回空数组（localStorage 不可用时也不炸）', () => {
    expect(parsePluginFetchWhitelist(null)).toEqual([]);
    expect(parsePluginFetchWhitelist(undefined)).toEqual([]);
    expect(parsePluginFetchWhitelist('')).toEqual([]);
  });
});
