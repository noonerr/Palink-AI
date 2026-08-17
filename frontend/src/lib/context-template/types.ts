/**
 * Context Template 类型定义
 * 基于 SillyTavern 1.18.0 context template 配置
 *
 * Context template 决定消息组装方式：
 *   - story_string: 系统提示词组装模板，含 {{description}}/{{personality}}/...
 *   - chat_start:   聊天开始标记（如 ChatML 的 <|im_start|>）
 *   - system_prompt: 模板自带的前置 system 提示词
 *   - jailbreak:    越狱提示词（追加在前置 system 之后）
 *   - normal_prompt: 普通聊天模板
 *   - group_prompt:  群组聊天模板
 */

export interface ContextTemplate {
  id: number;
  name: string;
  display_name?: string | null;
  story_string?: string | null;
  chat_start?: string | null;
  system_prompt?: string | null;
  jailbreak?: string | null;
  normal_prompt?: string | null;
  group_prompt?: string | null;
  is_builtin: boolean;
  created_at?: string | null;
  updated_at?: string | null;
}

/**
 * 创建/更新请求体（不包含 id / is_builtin / 时间戳）
 */
export interface ContextTemplatePayload {
  name: string;
  display_name?: string | null;
  story_string?: string | null;
  chat_start?: string | null;
  system_prompt?: string | null;
  jailbreak?: string | null;
  normal_prompt?: string | null;
  group_prompt?: string | null;
}
