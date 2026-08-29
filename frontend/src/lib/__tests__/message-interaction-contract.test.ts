/*
 * 批次 B 契约测试：无分框模式消息交互补齐（B1 编辑 / B2 swipe / B3 隐藏）。
 *
 * spec: docs/PLAN_ST兼容修复批次_2026-08-28.md 批次 B
 * 守卫点（源码契约断言，参照现有契约测试风格）：
 * 1. Message.tsx 消费 onEdit/canEdit（不再是 _ 前缀弃置 prop）；
 * 2. 存在编辑按钮 aria-label="编辑消息"，编辑态含 textarea 与 保存/取消；
 * 3. 编辑目标文本取当前显示正文（displayContent）；
 * 4. swipe 箭头计数条仅在 swipes.length > 1 时渲染，onSwipe props 存在；
 * 5. 隐藏/取消隐藏按钮 aria-label 与 onHide props 存在，隐藏消息半透明 opacity-50；
 * 6. memo 比较器补齐新增 props（onSwipe/onHide/swipes/swipeId/isHidden）；
 * 7. CharacterChat.tsx 的 handleSwipeAt / handleHideAt 存在并传给 Message，
 *    分别调用 PATCH swipe 端点与 PATCH 消息可见性端点。
 *
 * 运行: npx vitest run src/lib/__tests__/message-interaction-contract.test.ts
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it, expect } from 'vitest';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// 被守卫的源码文件
const messageSrc = fs.readFileSync(
  path.resolve(__dirname, '../../components/ui/custom/Message.tsx'),
  'utf-8',
);
const chatSrc = fs.readFileSync(
  path.resolve(__dirname, '../../components/views/character/CharacterChat.tsx'),
  'utf-8',
);

describe('B1 消息编辑入口（Message.tsx）', () => {
  it('onEdit/canEdit 不再弃置为 _ 前缀 prop', () => {
    expect(messageSrc.includes('onEdit: _onEdit')).toBe(false);
    expect(messageSrc.includes('canEdit: _canEdit')).toBe(false);
  });

  it('解构消费 onEdit 与 canEdit', () => {
    expect(messageSrc).toMatch(/\bonEdit,/);
    expect(messageSrc).toMatch(/\bcanEdit = false,/);
  });

  it('存在编辑按钮 aria-label="编辑消息"', () => {
    expect(messageSrc.includes('aria-label="编辑消息"')).toBe(true);
  });

  it('编辑态含 textarea 与 保存/取消 两按钮', () => {
    expect(messageSrc.includes('aria-label="编辑消息内容"')).toBe(true);
    expect(messageSrc.includes('aria-label="保存编辑"')).toBe(true);
    expect(messageSrc.includes('aria-label="取消编辑"')).toBe(true);
  });

  it('编辑目标文本取当前显示正文（displayContent）', () => {
    // 预填逻辑须引用 displayContent（剥离思考链后的当前显示正文）
    expect(messageSrc).toMatch(/setEditDraft\([\s\S]{0,120}displayContent/);
  });

  it('保存调用 onEdit(newContent, messageId)', () => {
    expect(messageSrc).toMatch(/onEdit\(\s*editDraft\s*,\s*message\.id\s*\)/);
  });
});

describe('B2 swipe 候选切换箭头（Message.tsx）', () => {
  it('计数条仅在 swipes.length > 1 时条件渲染', () => {
    expect(messageSrc).toMatch(/swipes\.length > 1/);
  });

  it('onSwipe props 存在（direction: prev | next）', () => {
    expect(messageSrc).toMatch(/onSwipe\?:\s*\(messageId:\s*string \| number,\s*direction:\s*'prev' \| 'next'\)\s*=>\s*void/);
  });

  it('swipes / swipeId 数据 props 存在', () => {
    expect(messageSrc).toMatch(/\bswipes\?: string\[\];/);
    expect(messageSrc).toMatch(/\bswipeId\?: number;/);
  });

  it('点击箭头回调 onSwipe(message.id, direction)', () => {
    expect(messageSrc).toMatch(/onSwipe\?\.\(\s*message\.id,\s*'prev'\s*\)/);
    expect(messageSrc).toMatch(/onSwipe\?\.\(\s*message\.id,\s*'next'\s*\)/);
  });

  it('memo 比较器补齐 swipes/swipeId/onSwipe', () => {
    expect(messageSrc).toMatch(/prev\.swipes !== next\.swipes/);
    expect(messageSrc).toMatch(/prev\.swipeId !== next\.swipeId/);
    expect(messageSrc).toMatch(/prev\.onSwipe !== next\.onSwipe/);
  });
});

describe('B3 隐藏/取消隐藏菜单项（Message.tsx）', () => {
  it('onHide props 存在（messageId, hidden）', () => {
    expect(messageSrc).toMatch(/onHide\?:\s*\(messageId:\s*string \| number,\s*hidden:\s*boolean\)\s*=>\s*void/);
  });

  it('依据 is_hidden 状态显示对应文案与 aria-label', () => {
    // aria-label 随消息 is_hidden 状态在 隐藏消息/取消隐藏 间切换（动态表达式）
    expect(messageSrc.includes("aria-label={isHidden ? '取消隐藏' : '隐藏消息'}")).toBe(true);
    expect(messageSrc.includes("title={isHidden ? '取消隐藏' : '隐藏消息'}")).toBe(true);
  });

  it('隐藏消息半透明 opacity-50', () => {
    expect(messageSrc).toMatch(/isHidden && "opacity-50"/);
  });

  it('memo 比较器补齐 isHidden/onHide', () => {
    expect(messageSrc).toMatch(/prev\.isHidden !== next\.isHidden/);
    expect(messageSrc).toMatch(/prev\.onHide !== next\.onHide/);
  });
});

describe('CharacterChat.tsx 接线', () => {
  it('handleSwipeAt 存在并调用 PATCH swipe 端点', () => {
    expect(chatSrc.includes('handleSwipeAt')).toBe(true);
    expect(chatSrc).toMatch(/messages\/\$\{persistedMessageId\}\/swipe/);
    expect(chatSrc).toMatch(/\{\s*swipe_id:\s*next\s*\}/);
  });

  it('handleHideAt 存在并调用 PATCH 消息可见性端点（is_hidden）', () => {
    expect(chatSrc.includes('handleHideAt')).toBe(true);
    expect(chatSrc).toMatch(/\{\s*is_hidden:\s*hidden\s*\}/);
  });

  it('handleSwipeAt/handleHideAt/swipes/swipeId/isHidden 传给 Message', () => {
    expect(chatSrc.includes('onSwipe={handleSwipeAt}')).toBe(true);
    // onHide 按消息 id 存在性接线（无 id 的流式消息不接）
    expect(chatSrc.includes('onHide={msg.id != null ? handleHideAt : undefined}')).toBe(true);
    expect(chatSrc.includes('swipes={msg.swipes}')).toBe(true);
    expect(chatSrc.includes('swipeId={msg.swipe_id}')).toBe(true);
    expect(chatSrc).toMatch(/isHidden=\{/);
  });

  it('user 消息也有编辑入口（canEdit 不再限 assistant）', () => {
    expect(chatSrc.includes('canEdit={msg.role === \'assistant\' && !isGenerating}')).toBe(false);
    expect(chatSrc.includes('canEdit={msg.id != null && !isGenerating}')).toBe(true);
  });
});
