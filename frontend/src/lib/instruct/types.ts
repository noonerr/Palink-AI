/**
 * Instruct模式类型定义
 * 基于 SillyTavern 1.18.0 instruct-mode.js
 */

// ============================================================
// Instruct模板
// ============================================================

/**
 * 名称行为类型
 */
export enum NamesBehavior {
  NONE = 'none',     // 不添加名称
  FORCE = 'force',   // 强制添加（非系统消息）
  ALWAYS = 'always', // 始终添加
}

/**
 * Instruct模板
 */
export interface InstructTemplate {
  name: string;
  
  // 序列定义
  input_sequence: string;           // 用户输入前缀
  output_sequence: string;          // 助手输出前缀
  system_sequence: string;          // 系统消息前缀
  input_suffix: string;             // 用户输入后缀
  output_suffix: string;            // 助手输出后缀
  system_suffix: string;            // 系统消息后缀
  
  // 首尾序列
  first_output_sequence: string;    // 首个助手输出前缀
  last_output_sequence: string;     // 最后助手输出前缀
  first_input_sequence: string;     // 首个用户输入前缀
  last_input_sequence: string;      // 最后用户输入前缀
  
  // 系统序列
  last_system_sequence: string;     // 最后系统消息前缀
  system_instruction_prefix: string; // 系统指令前缀
  
  // 停止序列
  stop_sequence: string;            // 停止生成的序列
  
  // 设置
  names_behavior: NamesBehavior;    // 名称行为
  wrap: boolean;                    // 是否包裹
  macro: boolean;                   // 是否启用宏
  skip_examples: boolean;           // 跳过示例
  system_same_as_user: boolean;     // 系统消息使用用户序列
  sequences_as_stop_strings: boolean; // 序列作为停止字符串
  bind_to_context: boolean;         // 绑定到上下文
  
  // 字符串
  story_string_prefix: string;      // 故事字符串前缀
  story_string_suffix: string;      // 故事字符串后缀
  user_alignment_message: string;   // 用户对齐消息
  
  // 激活
  activation_regex: string;         // 激活正则表达式
  
  // 元数据
  enabled: boolean;
}

/**
 * Instruct设置
 */
export interface InstructSettings {
  enabled: boolean;
  template: InstructTemplate | null;
  templateName: string;
}

/**
 * 格式化选项
 */
export interface FormatOptions {
  name?: string;
  isUser?: boolean;
  isSystem?: boolean;
  isNarrator?: boolean;
  forceName?: boolean;
  includeName?: boolean;
}

/**
 * 格式化结果
 */
export interface FormatResult {
  formatted: string;
  prefix: string;
  suffix: string;
  nameIncluded: boolean;
}
