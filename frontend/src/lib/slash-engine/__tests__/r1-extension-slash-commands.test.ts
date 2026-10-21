/*
 * 批次R1（2026-10-21）· ST 扩展启停命令（帧内 triggerSlash 的真实落点）。
 *
 * 为什么是斜杠命令而不是 TavernHelper 成员：ST 1.18 把这族能力暴露在
 * public/scripts/extensions-slashcommands.js:89/130/171/230/266，酒馆助手
 * @types/function/ 里**没有** enable/disable/toggle 成员 ⇒ 按"没有对应函数就
 * 不自造键名"，本批只补命令名，不新增 TavernHelper 键。
 *
 * 命令语义照 ST：
 *   /extension-enable  <name>              启用，返回内部扩展名
 *   /extension-disable <name>              停用，返回内部扩展名
 *   /extension-toggle  <name> [state=..]   显式设/取反
 *   /extension-state   <name>              'true' / 'false' / ''（不存在）
 *   /extension-exists  <name>              'true' / 'false'（alias: extension-installed）
 *
 * 运行: npx vitest run src/lib/slash-engine/__tests__/r1-extension-slash-commands.test.ts
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const apiMock = vi.hoisted(() => ({
  get: vi.fn(),
  post: vi.fn(),
  put: vi.fn(),
  delete: vi.fn(),
}));
const invalidateCacheMock = vi.hoisted(() => vi.fn());

vi.mock('@/services/api', () => ({
  api: apiMock,
  invalidateCache: invalidateCacheMock,
}));

import { SlashCommandEngine } from '@/lib/slash-engine';
import { ensureSlashCommandsBootstrapped } from '@/lib/slash-engine/bootstrap';

ensureSlashCommandsBootstrapped();

const RUNTIME_PAYLOAD = {
  plugins: [
    {
      id: 'plugin-local-1',
      name: 'JS-Slash-Runner',
      plugin_type: 'tavern_helper',
      owner_scope: 'local',
      enabled: true,
      version: '5.9.0',
      manifest: { name: 'JS-Slash-Runner' },
      extension_settings: {},
      resources: {},
    },
    {
      id: 'plugin-global-1',
      name: 'Global Ext',
      plugin_type: 'sillytavern_extension',
      owner_scope: 'global',
      enabled: true,
      version: '1.2.3',
      manifest: { name: 'Global-Ext' },
      extension_settings: {},
      resources: {},
    },
  ],
  extension_settings: {},
};

function mockApi(role: 'admin' | 'user') {
  apiMock.get.mockImplementation(async (url: string) => {
    if (url === '/api/users/me') return { id: role === 'admin' ? 1 : 2, username: role, role };
    if (url.indexOf('/api/plugins/runtime/config') === 0) return RUNTIME_PAYLOAD;
    return null;
  });
}

const run = async (input: string) => SlashCommandEngine.execute(input);

beforeEach(() => {
  apiMock.get.mockReset();
  apiMock.put.mockReset();
  invalidateCacheMock.mockReset();
});

describe('extension-state / extension-exists（只读）', () => {
  it('/extension-state 已启用 => "true"', async () => {
    mockApi('user');
    const result = await run('/extension-state JS-Slash-Runner');
    expect(result.success).toBe(true);
    expect(result.output).toBe('true');
  });

  it('/extension-state 不存在 => 空串（ST 的 toastr.warning + return \'\' 口径）', async () => {
    mockApi('user');
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const result = await run('/extension-state Nope');
    expect(result.success).toBe(true);
    expect(result.output).toBe('');
    warn.mockRestore();
  });

  it('/extension-exists 已装 => "true"；未装 => "false"', async () => {
    mockApi('user');
    expect((await run('/extension-exists JS-Slash-Runner')).output).toBe('true');
    expect((await run('/extension-exists Nope')).output).toBe('false');
  });

  it('/extension-installed 是 extension-exists 的别名（ST extensions-slashcommands.js:267）', async () => {
    mockApi('user');
    expect((await run('/extension-installed Global-Ext')).output).toBe('true');
  });
});

describe('extension-enable / disable / toggle（写侧走 PUT toggle）', () => {
  it('/extension-disable 本人插件 => 返回扩展名并调用 PUT', async () => {
    mockApi('user');
    apiMock.put.mockResolvedValue({ enabled: false });
    const result = await run('/extension-disable JS-Slash-Runner');
    expect(result.success).toBe(true);
    expect(result.output).toBe('JS-Slash-Runner');
    expect(apiMock.put).toHaveBeenCalledWith('/api/plugins/plugin-local-1/toggle');
  });

  it('/extension-toggle state=false 显式停用（不依赖当前状态）', async () => {
    mockApi('user');
    apiMock.put.mockResolvedValue({ enabled: false });
    const result = await run('/extension-toggle JS-Slash-Runner state=false');
    expect(result.success).toBe(true);
    expect(apiMock.put).toHaveBeenCalledWith('/api/plugins/plugin-local-1/toggle');
  });

  it('/extension-toggle 目标状态与当前相同 => 不发起 PUT（ST 的 already enabled 分支）', async () => {
    mockApi('user');
    const result = await run('/extension-toggle JS-Slash-Runner state=true');
    expect(result.success).toBe(true);
    expect(result.output).toBe('JS-Slash-Runner');
    expect(apiMock.put).not.toHaveBeenCalled();
  });

  it('非管理员切全局插件 => 可见错误 + 不发起 PUT（越权面）', async () => {
    mockApi('user');
    const result = await run('/extension-enable Global-Ext');
    expect(result.success).toBe(false);
    expect(result.output).toContain('只有管理员才能切换全局扩展');
    expect(apiMock.put).not.toHaveBeenCalled();
  });

  it('未知扩展 => 可见错误 + 不发起 PUT（不静默成功）', async () => {
    mockApi('user');
    const result = await run('/extension-disable Not-Installed');
    expect(result.success).toBe(false);
    expect(result.output).toContain('扩展不存在');
    expect(apiMock.put).not.toHaveBeenCalled();
  });
});
