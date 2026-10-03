/**
 * 【报错提示 1.5】失败占位消息的唯一构造入口。
 *
 * 目标形态：生成失败不再伪装成一条 AI 回复，而是消息流里一个带
 * `extra.ignore === true` 的「系统提示」节点 —— 可见、可重发、
 * 不回喂模型、不被 TTS 朗读。
 *
 * 为什么内容必须以 `Error:` 开头：
 *   `Error:` 是本项目所有错误注入点的统一前缀（见后端
 *   `services/stream_builder.py` StreamResult.is_error_only 的文档串，
 *   以及 WS 轨 websocket.py 的落库守卫）。此前前端用 `⚠️` 起头，
 *   正是因为绕开了这个约定，才躲过所有错误过滤守卫（PROMPT_报错提示系统重写 1.6(d)）。
 *
 * 为什么不需要新字段 / 迁移：
 *   `extra.ignore` 在装配层已生效（character_message_builder.py:205-216，
 *   对齐 ST 1.18.0 IGNORE_SYMBOL），写路径也支持 dict。
 *
 * 消费方：useCharacterChat.ts（角色页 WS/SSE 两处）、useChatView/index.ts（对话主页两处）。
 */

export interface SystemNoteErrorInfo {
  title: string;
  description: string;
  suggestion?: string;
}

/** 装配层 / 前端渲染共用的「这条消息是系统提示，别当 AI 回复」标记。 */
export const SYSTEM_NOTE_EXTRA = Object.freeze({ ignore: true });

/** 判断一条消息是否为系统提示节点（不回喂、不 TTS、特殊外观）。 */
export function isSystemNoteMessage(
  extra: Record<string, unknown> | undefined | null
): boolean {
  return extra?.ignore === true;
}

/** 统一模板。两个聊天页共用，消除「同一种失败两种表现」。 */
export function buildSystemNoteContent(errorInfo: SystemNoteErrorInfo): string {
  const lines = [`Error: ${errorInfo.title}`, errorInfo.description];
  if (errorInfo.suggestion) lines.push(errorInfo.suggestion);
  return lines.join('\n');
}
