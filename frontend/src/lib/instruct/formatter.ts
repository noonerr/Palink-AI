/**
 * Instruct模式格式化器
 * 将消息格式化为Instruct模板格式
 */

import type { InstructTemplate, FormatOptions, FormatResult } from './types';
import { NamesBehavior } from './types';

/**
 * 格式化消息为Instruct模式
 */
export function formatInstructMessage(
  content: string,
  options: FormatOptions,
  template: InstructTemplate | null,
): FormatResult {
  if (!template || !template.enabled) {
    return {
      formatted: content,
      prefix: '',
      suffix: '',
      nameIncluded: false,
    };
  }

  let prefix = '';
  let suffix = '';
  let nameIncluded = false;

  if (options.isSystem) {
    prefix = template.system_sequence;
    suffix = template.system_suffix;
  } else if (options.isUser) {
    prefix = template.input_sequence;
    suffix = template.input_suffix;
  } else {
    prefix = template.output_sequence;
    suffix = template.output_suffix;
  }

  // 名称处理
  const shouldIncludeName =
    template.names_behavior === NamesBehavior.ALWAYS ||
    (template.names_behavior === NamesBehavior.FORCE && !options.isSystem);

  if (shouldIncludeName && options.name) {
    content = `${options.name}: ${content}`;
    nameIncluded = true;
  }

  return {
    formatted: `${prefix}${content}${suffix}`,
    prefix,
    suffix,
    nameIncluded,
  };
}

/**
 * 格式化故事字符串（系统提示词部分）
 */
export function formatStoryString(
  systemPrompt: string,
  description: string,
  personality: string,
  scenario: string,
  template: InstructTemplate | null,
): string {
  if (!template || !template.enabled) {
    return systemPrompt;
  }

  const parts: string[] = [];

  if (template.story_string_prefix) {
    parts.push(template.story_string_prefix);
  }

  if (systemPrompt) {
    parts.push(systemPrompt);
  }

  if (description) {
    parts.push(description);
  }

  if (personality) {
    parts.push(personality);
  }

  if (scenario) {
    parts.push(scenario);
  }

  if (template.story_string_suffix) {
    parts.push(template.story_string_suffix);
  }

  return parts.join('\n\n');
}

/**
 * 获取停止序列
 */
export function getInstructStopSequences(template: InstructTemplate | null): string[] {
  if (!template || !template.enabled) return [];

  const sequences: string[] = [];

  if (template.stop_sequence) {
    sequences.push(template.stop_sequence);
  }

  if (template.sequences_as_stop_strings) {
    if (template.input_sequence) sequences.push(template.input_sequence);
    if (template.output_sequence) sequences.push(template.output_sequence);
    if (template.system_sequence) sequences.push(template.system_sequence);
  }

  return sequences.filter(s => s.length > 0);
}
