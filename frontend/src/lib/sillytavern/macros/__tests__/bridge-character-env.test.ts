/*
 * P1-12 守卫：env.* 系列宏必须有 character 分支可读，不能展开成空串。
 *
 * 背景：`macros/bridge.ts` 的 `convertToNewEnv` 负责把旧的 MacroEnv 转成新引擎的
 * env 结构。env-macros.ts 里的处理器统一读 `ctx.env.character.description` 这类路径，
 * 而 `convertToNewEnv` 此前**从不产出 `character` 这一块** —— 处理器拿到 undefined，
 * `?? ''` 兜底成空串，于是 {{charDescription}} / {{charPersonality}} / {{charScenario}}
 * 等卡内最常用的宏全部静默展开为空，不报错。
 *
 * 走真实 evaluateMacros 链路验证，不用源码字符串断言。
 */
import { describe, it, expect } from 'vitest';
import { substituteParams } from '@/lib/sillytavern/macros/bridge';

describe('P1-12: env.character 分支可达', () => {
  it('charDescription 取自传入的 character.description', () => {
    const out = substituteParams('描述:{{charDescription}}', {
      characterName: '露缇雅',
      character: { description: '猫娘神域的管理者' },
    } as any);
    expect(out).toContain('猫娘神域的管理者');
  });

  it('charPersonality / charScenario 同理生效', () => {
    const env = {
      characterName: '露缇雅',
      character: {
        personality: '傲娇但可靠',
        scenario: '公寓日常',
      },
    } as any;
    expect(substituteParams('{{charPersonality}}', env)).toContain('傲娇但可靠');
    expect(substituteParams('{{charScenario}}', env)).toContain('公寓日常');
  });

  it('不传 character 时展开为空串但不抛错（此前是 undefined 崩溃）', () => {
    expect(() => substituteParams('{{charDescription}}', { characterName: 'X' } as any))
      .not.toThrow();
    expect(substituteParams('{{charDescription}}', { characterName: 'X' } as any)).toBe('');
  });

  it('基础宏未被这次改动破坏', () => {
    expect(substituteParams('{{char}}', { characterName: '露缇雅' } as any)).toContain('露缇雅');
  });
});