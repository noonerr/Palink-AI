import { describe, it, expect } from 'vitest';
import {
  buildSystemNoteContent,
  isSystemNoteMessage,
  SYSTEM_NOTE_EXTRA,
} from '../systemMessage';

/**
 * 【报错提示 1.5】失败占位消息统一构造器契约。
 * 背景：角色页与对话主页此前各有一套模板（⚠️/💡 vs ⚠️ **错误**），
 * 同一种失败两种表现，且 ⚠️ 前缀绕开了后端所有 Error: 守卫。
 */
describe('buildSystemNoteContent', () => {
  it('以 "Error: " 开头（本项目错误注入点的统一前缀）', () => {
    const c = buildSystemNoteContent({
      title: '网络连接问题',
      description: '无法连接到服务器',
      suggestion: '请检查网络',
    });
    expect(c.startsWith('Error: ')).toBe(true);
  });

  it('不带 ⚠️ / 💡 / ** 等旧装饰（旧前缀会躲过后端 Error: 守卫）', () => {
    const c = buildSystemNoteContent({
      title: '网络连接问题',
      description: '无法连接到服务器',
      suggestion: '请检查网络',
    });
    expect(c).not.toContain('⚠️');
    expect(c).not.toContain('💡');
    expect(c).not.toContain('**');
  });

  it('三段齐全：标题 / 描述 / 建议', () => {
    const c = buildSystemNoteContent({
      title: 'T',
      description: 'D',
      suggestion: 'S',
    });
    expect(c).toBe('Error: T\nD\nS');
  });

  it('suggestion 缺省时不追加空行', () => {
    const c = buildSystemNoteContent({ title: 'T', description: 'D' });
    expect(c).toBe('Error: T\nD');
  });

  it('同一输入在两个聊天页产出完全相同的内容（模板收敛）', () => {
    const input = { title: 'X', description: 'Y', suggestion: 'Z' };
    expect(buildSystemNoteContent(input)).toBe(buildSystemNoteContent({ ...input }));
  });
});

describe('isSystemNoteMessage', () => {
  it('extra.ignore === true 时命中', () => {
    expect(isSystemNoteMessage({ ignore: true })).toBe(true);
  });

  it('extra 缺失 / ignore 非 true 时不命中', () => {
    expect(isSystemNoteMessage(undefined)).toBe(false);
    expect(isSystemNoteMessage(null)).toBe(false);
    expect(isSystemNoteMessage({})).toBe(false);
    expect(isSystemNoteMessage({ ignore: 'true' })).toBe(false);
    expect(isSystemNoteMessage({ ignore: false })).toBe(false);
  });

  it('SYSTEM_NOTE_EXTRA 是精确的 { ignore: true }（对应装配层 IGNORE_SYMBOL）', () => {
    expect(SYSTEM_NOTE_EXTRA).toEqual({ ignore: true });
    // 装配层 character_message_builder.py:205-216 判 extra.get("ignore") is True
    expect((SYSTEM_NOTE_EXTRA as { ignore: boolean }).ignore).toBe(true);
  });
});
