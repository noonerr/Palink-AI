/*
 * 批次Q1 · 主机档判定契约（2026-10-21）
 *
 * 依据：用户第三次裁定（SPEC_向ST学习的子系统缺口与标记方案_2026-10-19.md §2.4）——
 *   本机/内网访客 ⇒ 卡片帧默认给 allow-same-origin，不要求逐卡点信任；
 *   其它主机名 ⇒ 视为公网访客，维持 P1-1（未授信只给 allow-scripts，opaque origin）。
 *
 * 这个文件的判据就是"哪些主机名算本机"，所以**边界必须逐条测到**：
 *   172.15.x / 172.32.x 是 RFC1918 的上下边界（不在段内 ⇒ 公网）；
 *   trycloudflare.com 这类公网隧道名必须判公网（本机开发者最容易踩的误判）；
 *   空串 / 畸形 IPv4 / 超界段一律公网（默认不放开）。
 *
 * 运行: npx vitest run src/components/ui/custom/smart-card-runtime/__tests__/host-origin-policy.test.ts
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  isLocalOrPrivateHost,
  normalizeSmartCardHostname,
  resolveSmartCardHostOriginPolicy,
  describeSmartCardHostOriginPolicy,
  getSmartCardHostOriginPolicy,
  resetSmartCardHostOriginPolicyCache,
} from '../host-origin-policy';

describe('A 命中集合（用户裁定原文逐项）', () => {
  it('localhost / 127.0.0.1 / ::1 / [::1]', () => {
    for (const host of ['localhost', '127.0.0.1', '::1', '[::1]']) {
      expect(isLocalOrPrivateHost(host), host).toBe(true);
    }
  });

  it('大小写、首尾空白、FQDN 尾点都不影响判定', () => {
    for (const host of ['LOCALHOST', '  localhost  ', 'localhost.', 'LocalHost.']) {
      expect(isLocalOrPrivateHost(host), host).toBe(true);
    }
  });

  it('RFC1918 三段：10. / 172.16-172.31. / 192.168.', () => {
    const hits = [
      '10.0.0.1', '10.255.255.254',
      '172.16.0.1', '172.20.10.2', '172.31.255.255',
      '192.168.1.1', '192.168.0.254',
    ];
    for (const host of hits) expect(isLocalOrPrivateHost(host), host).toBe(true);
  });

  it('以 .local 结尾（mDNS）', () => {
    for (const host of ['palink.local', 'my-nas.local']) {
      expect(isLocalOrPrivateHost(host), host).toBe(true);
    }
  });
});

describe('B 边界：RFC1918 上下沿与公网隧道名', () => {
  it('172.15.x 与 172.32.x 不在 172.16/12 段内 ⇒ 公网', () => {
    expect(isLocalOrPrivateHost('172.15.255.255')).toBe(false);
    expect(isLocalOrPrivateHost('172.32.0.1')).toBe(false);
    expect(isLocalOrPrivateHost('172.0.0.1')).toBe(false);
    expect(isLocalOrPrivateHost('172.255.255.255')).toBe(false);
  });

  it('相邻的 9.x / 11.x / 192.169.x / 192.167.x ⇒ 公网', () => {
    for (const host of ['9.255.255.255', '11.0.0.1', '192.169.1.1', '192.167.1.1']) {
      expect(isLocalOrPrivateHost(host), host).toBe(false);
    }
  });

  it('公网隧道/穿透域名必须判公网（含 localhost 字样的也不行）', () => {
    for (const host of [
      'trycloudflare.com',
      'abc-def-ghi.trycloudflare.com',
      'xxx.ngrok-free.app',
      'localhost.evil.com',   // 前缀冒充
      'notlocalhost',         // 子串冒充
      '.local',               // 只有后缀、没有主机名
      'local',
    ]) {
      expect(isLocalOrPrivateHost(host), host).toBe(false);
    }
  });

  it('空串 / 畸形 IPv4 / 超界段 ⇒ 公网（默认不放开）', () => {
    for (const host of [
      '',
      '   ',
      '0.0.0.0',
      '127.0.0.2',            // 用户裁定只点名 127.0.0.1，其余不擅自放大
      '256.1.1.1',
      '10.0.0',
      '10.0.0.1.5',
      '10.0.0.a',
      '10..0.1',
      '::ffff:10.0.0.1',      // 未登记的 IPv6 映射写法，按"拿不准算公网"处理
    ]) {
      expect(isLocalOrPrivateHost(host), JSON.stringify(host)).toBe(false);
    }
  });

  it('null / undefined 不抛错且判公网', () => {
    expect(isLocalOrPrivateHost(null as unknown as string)).toBe(false);
    expect(isLocalOrPrivateHost(undefined as unknown as string)).toBe(false);
  });
});

describe('C 取值函数：档位、放开标志、判据文案', () => {
  it('本机 ⇒ tier=local-or-private 且 grantsSameOrigin=true', () => {
    const policy = resolveSmartCardHostOriginPolicy('192.168.1.20');
    expect(policy).toMatchObject({ hostname: '192.168.1.20', tier: 'local-or-private', grantsSameOrigin: true });
    expect(policy.reason).toContain('白名单');
  });

  it('公网 ⇒ tier=public 且 grantsSameOrigin=false', () => {
    const policy = resolveSmartCardHostOriginPolicy('example.com');
    expect(policy).toMatchObject({ tier: 'public', grantsSameOrigin: false });
  });

  it('主机名取不到 ⇒ public（默认不放开，reason 说清是"取不到"）', () => {
    const policy = resolveSmartCardHostOriginPolicy('');
    expect(policy.tier).toBe('public');
    expect(policy.grantsSameOrigin).toBe(false);
    expect(policy.reason).toContain('取不到');
  });

  it('describe 一行里同时有档位、主机名与同源状态（真机探针与日志共用）', () => {
    const local = describeSmartCardHostOriginPolicy(resolveSmartCardHostOriginPolicy('localhost'));
    expect(local).toContain('host-tier=local-or-private');
    expect(local).toContain('host=localhost');
    expect(local).toContain('same-origin=granted-when-untrusted');
    const remote = describeSmartCardHostOriginPolicy(resolveSmartCardHostOriginPolicy('card.example.com'));
    expect(remote).toContain('host-tier=public');
    expect(remote).toContain('same-origin=requires-trust');
  });

  it('normalize 只做归一化，不做判定（判据不许藏在归一化里）', () => {
    expect(normalizeSmartCardHostname('  A.B.C.  ')).toBe('a.b.c');
    expect(normalizeSmartCardHostname(null)).toBe('');
  });
});

describe('D 取值入口：缓存与诊断挂载', () => {
  const originalLocation = window.location;

  function setHostname(hostname: string) {
    Object.defineProperty(window, 'location', {
      configurable: true,
      value: { ...originalLocation, hostname },
    });
  }

  beforeEach(() => {
    resetSmartCardHostOriginPolicyCache();
  });

  afterEach(() => {
    Object.defineProperty(window, 'location', { configurable: true, value: originalLocation });
    resetSmartCardHostOriginPolicyCache();
    delete (window as unknown as Record<string, unknown>).__palinkHostOriginPolicy;
    vi.restoreAllMocks();
  });

  it('读 window.location.hostname ⇒ 本机档放开、公网档不放开', () => {
    vi.spyOn(console, 'info').mockImplementation(() => {});
    setHostname('localhost');
    expect(getSmartCardHostOriginPolicy().grantsSameOrigin).toBe(true);
    resetSmartCardHostOriginPolicyCache();
    setHostname('palink.example.com');
    expect(getSmartCardHostOriginPolicy().grantsSameOrigin).toBe(false);
  });

  it('同一主机名只写一次日志，并把当前档挂到 window 上供真机探针读取', () => {
    const info = vi.spyOn(console, 'info').mockImplementation(() => {});
    setHostname('10.1.2.3');
    getSmartCardHostOriginPolicy();
    getSmartCardHostOriginPolicy();
    getSmartCardHostOriginPolicy();
    expect(info).toHaveBeenCalledTimes(1);
    expect(info.mock.calls[0][0]).toContain('host-tier=local-or-private');
    const exposed = (window as unknown as Record<string, { tier?: string; grantsSameOrigin?: boolean }>)
      .__palinkHostOriginPolicy;
    expect(exposed?.tier).toBe('local-or-private');
    expect(exposed?.grantsSameOrigin).toBe(true);
  });

  it('换主机名会重算（缓存按主机名，不是进程级一次）', () => {
    vi.spyOn(console, 'info').mockImplementation(() => {});
    setHostname('localhost');
    expect(getSmartCardHostOriginPolicy().grantsSameOrigin).toBe(true);
    setHostname('evil.example.com');
    expect(getSmartCardHostOriginPolicy().grantsSameOrigin).toBe(false);
  });
});
