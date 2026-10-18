/*
 * 包J J-2 —— getContext().characterId 在 Palink 帧内拿得到真实角色标识（2026-10-18）
 *
 * 病灶（包E §4 F-2）：Palink 的角色 id 是 UUID 字符串，
 *   Number(uuid) = NaN → 回退 characters.findIndex(...) → 卡帧里 characters 不含该 UUID
 *   → idx = -1 → 兜底 return 0。实测露缇雅全 7 帧 characterId 恒为 0，
 *   「按 characterId 分区 / 按 extensions 水合」一类的插件功能静默降级。
 *
 * 修法与口径（交接单 §2.2）：
 *   1) 把 UUID→下标的匹配面铺到 Palink 真正携带身份的字段（id / character_id / uuid /
 *      name / avatar 的 palink-<uuid>.png 形态）⇒ characters 里有这张卡时数字下标**命中**；
 *   2) 命中不了时照 ST 语义**保持 0**（不填假值），但真实字符串身份必须可达
 *      （context.characterIdString / context.palink_character_id）。
 *
 * 本测试钉住这两条，并钉住「数字 characterId 原样透传」不回归。
 * 注意：plugin-character-id.test.ts 管的是**另一件事**（存储分区用的派生数字 id，
 * 由 UUID 哈希得到、恒不为 0），那个契约不许被本包的改动影响，两者不要混。
 *
 * 运行: npx vitest run src/lib/sillytavern/__tests__/plugin-frame-character-id.test.ts
 */
import { describe, it, expect, afterEach } from 'vitest';
import {
  SillyTavernRuntime,
  getGlobalSillyTavernRuntime,
  setGlobalSillyTavernRuntime,
} from '../runtime';

// getContext 的 import 链带 .css 副作用与浏览器包，需 jsdom + vite 插件图就位后再解析
// （与 getcontext-parity.test.ts 同一套 top-level await 写法）。
const { getContext } = await import('../getContext');

const UUID = 'a36680d6-d714-4be9-98b8-f145173c3ae9';
const OTHER_UUID = '13db28eb-0000-4000-8000-000000000001';
const NAME = '露缇雅1.2';

const previousRuntime = getGlobalSillyTavernRuntime();

/** 用给定 ST 上下文调用一次 getContext()，返回算出来的角色标识三元组。 */
function readCharacterIdentity(initial: Record<string, unknown>) {
  const runtime = new SillyTavernRuntime({
    name: 'User',
    character: { name: NAME, description: '' },
    chat: [],
    chatId: 'chat-j2',
    ...initial,
  } as any);
  setGlobalSillyTavernRuntime(runtime);
  const ctx: any = getContext();
  return {
    characterId: ctx.characterId as number,
    characterIdString: ctx.characterIdString as string,
    palinkCharacterId: ctx.palink_character_id as string,
    thisChid: ctx.thisChid as number,
  };
}

afterEach(() => {
  setGlobalSillyTavernRuntime(previousRuntime);
});

describe('getContext().characterId —— 包J J-2', () => {
  it('J2-1 UUID 在 characters 里（id 字段）→ 数字下标命中，字符串 id 同时可达', () => {
    const got = readCharacterIdentity({
      characterId: UUID,
      characters: [
        { name: '甲', description: '', id: OTHER_UUID },
        { name: '乙', description: '' },
        { name: NAME, description: '', id: UUID },
      ],
    });
    expect(got.characterId).toBe(2);
    expect(got.characterIdString).toBe(UUID);
    expect(got.palinkCharacterId).toBe(UUID);
    // ST 里 thisChid 与 characterId 同值，插件两条路都要能拿到
    expect(got.thisChid).toBe(2);
  });

  it('J2-2 characters 条目只带 avatar（palink-<uuid>.png 形态）也命中', () => {
    const got = readCharacterIdentity({
      characterId: UUID,
      characters: [
        { name: '甲', description: '', avatar: 'palink-' + OTHER_UUID + '.png' },
        { name: NAME, description: '', avatar: 'palink-' + UUID + '.png' },
      ],
    });
    expect(got.characterId).toBe(1);
    expect(got.characterIdString).toBe(UUID);
  });

  it('J2-3 条目只有 character_id / uuid 两种键名也命中；只有 name 时保持旧行为', () => {
    expect(readCharacterIdentity({
      characterId: UUID,
      characters: [{ name: '甲', description: '' }, { name: '乙', description: '', character_id: UUID }],
    }).characterId).toBe(1);
    expect(readCharacterIdentity({
      characterId: UUID,
      characters: [{ name: UUID, description: '' }],
    }).characterId).toBe(0);
    expect(readCharacterIdentity({
      characterId: NAME,
      characters: [{ name: '甲', description: '' }, { name: NAME, description: '' }],
    }).characterId).toBe(1);
  });

  it('J2-4 拿不到索引时数字照 ST 语义保持 0（禁止填假值），但字符串 id 必须可达', () => {
    const got = readCharacterIdentity({ characterId: UUID, characters: [] });
    expect(got.characterId).toBe(0);
    expect(got.characterIdString).toBe(UUID);
    expect(got.palinkCharacterId).toBe(UUID);

    // characters 有内容但不含这张卡 —— 同样不许错配到别的下标
    const other = readCharacterIdentity({
      characterId: UUID,
      characters: [{ name: '别的卡', description: '', id: OTHER_UUID }],
    });
    expect(other.characterId).toBe(0);
    expect(other.characterIdString).toBe(UUID);
  });

  it('J2-5 数字 characterId 原样透传（ST 语义不回归），缺失时字符串为空串', () => {
    expect(readCharacterIdentity({ characterId: 7, characters: [] }).characterId).toBe(7);
    const missing = readCharacterIdentity({ characters: [] });
    expect(missing.characterId).toBe(0);
    expect(missing.characterIdString).toBe('');
    expect(missing.palinkCharacterId).toBe('');
  });
});
