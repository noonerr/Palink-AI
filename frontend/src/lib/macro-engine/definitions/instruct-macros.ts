/**
 * 指令模式宏定义
 * 基于 SillyTavern 1.18.0 instruct-macros.js
 */

import { MacroCategory } from '../types';
import { MacroRegistry } from '../engine/MacroRegistry';

/**
 * 辅助函数：批量注册简单宏
 */
function registerSimple(
  names: string[],
  getValue: () => string,
  isEnabled: () => boolean,
  description: string,
  category: string = MacroCategory.PROMPTS
): void {
  const primaryName = names[0];
  const aliases = names.slice(1);

  MacroRegistry.registerMacro(primaryName, {
    category,
    unnamedArgs: 0,
    description,
    handler: () => {
      if (!isEnabled()) return '';
      return getValue();
    },
  });

  for (const alias of aliases) {
    MacroRegistry.registerMacroAlias(primaryName, alias);
  }
}

/**
 * 注册指令模式宏
 */
export function registerInstructMacros(): void {
  // 获取instruct设置的辅助函数
  const getInstructSetting = (key: string): string => {
    // 简化版本，从extra中获取
    const instructSettings = (globalThis as any).__palinkInstructSettings;
    if (!instructSettings) return '';
    return instructSettings[key] ?? '';
  };

  const isInstructEnabled = (): boolean => {
    const instructSettings = (globalThis as any).__palinkInstructSettings;
    return instructSettings?.enabled === true;
  };

  // {{instructStoryStringPrefix}} - 指令故事字符串前缀
  registerSimple(
    ['instructStoryStringPrefix'],
    () => getInstructSetting('story_string_prefix'),
    isInstructEnabled,
    'Instruct story string prefix'
  );

  // {{instructStoryStringSuffix}} - 指令故事字符串后缀
  registerSimple(
    ['instructStoryStringSuffix'],
    () => getInstructSetting('story_string_suffix'),
    isInstructEnabled,
    'Instruct story string suffix'
  );

  // {{instructUserPrefix}} / {{instructInput}} - 用户输入前缀序列
  registerSimple(
    ['instructUserPrefix', 'instructInput'],
    () => getInstructSetting('input_sequence'),
    isInstructEnabled,
    'User input prefix sequence'
  );

  // {{instructUserSuffix}} - 用户输入后缀序列
  registerSimple(
    ['instructUserSuffix'],
    () => getInstructSetting('input_suffix'),
    isInstructEnabled,
    'User input suffix sequence'
  );

  // {{instructAssistantPrefix}} / {{instructOutput}} - 助手输出前缀序列
  registerSimple(
    ['instructAssistantPrefix', 'instructOutput'],
    () => getInstructSetting('output_sequence'),
    isInstructEnabled,
    'Assistant output prefix sequence'
  );

  // {{instructAssistantSuffix}} / {{instructSeparator}} - 助手输出后缀序列
  registerSimple(
    ['instructAssistantSuffix', 'instructSeparator'],
    () => getInstructSetting('output_suffix'),
    isInstructEnabled,
    'Assistant output suffix sequence'
  );

  // {{instructSystemPrefix}} - 系统前缀序列
  registerSimple(
    ['instructSystemPrefix'],
    () => getInstructSetting('system_sequence'),
    isInstructEnabled,
    'System prefix sequence'
  );

  // {{instructSystemSuffix}} - 系统后缀序列
  registerSimple(
    ['instructSystemSuffix'],
    () => getInstructSetting('system_suffix'),
    isInstructEnabled,
    'System suffix sequence'
  );

  // {{instructFirstAssistantPrefix}} / {{instructFirstOutputPrefix}} - 首个助手前缀
  registerSimple(
    ['instructFirstAssistantPrefix', 'instructFirstOutputPrefix'],
    () => getInstructSetting('first_output_sequence'),
    isInstructEnabled,
    'First assistant output prefix'
  );

  // {{instructLastAssistantPrefix}} / {{instructLastOutputPrefix}} - 最后助手前缀
  registerSimple(
    ['instructLastAssistantPrefix', 'instructLastOutputPrefix'],
    () => getInstructSetting('last_output_sequence'),
    isInstructEnabled,
    'Last assistant output prefix'
  );

  // {{instructStop}} - 停止序列
  registerSimple(
    ['instructStop'],
    () => getInstructSetting('stop_sequence'),
    isInstructEnabled,
    'Stop sequence'
  );

  // {{instructUserFiller}} - 用户对齐填充
  registerSimple(
    ['instructUserFiller'],
    () => getInstructSetting('user_alignment_message'),
    isInstructEnabled,
    'User alignment filler message'
  );

  // {{instructSystemInstructionPrefix}} - 系统指令前缀
  registerSimple(
    ['instructSystemInstructionPrefix'],
    () => getInstructSetting('system_instruction_prefix'),
    isInstructEnabled,
    'System instruction prefix'
  );

  // {{instructFirstUserPrefix}} / {{instructFirstInput}} - 首个用户前缀
  registerSimple(
    ['instructFirstUserPrefix', 'instructFirstInput'],
    () => getInstructSetting('first_input_sequence'),
    isInstructEnabled,
    'First user input prefix'
  );

  // {{instructLastUserPrefix}} / {{instructLastInput}} - 最后用户前缀
  registerSimple(
    ['instructLastUserPrefix', 'instructLastInput'],
    () => getInstructSetting('last_input_sequence'),
    isInstructEnabled,
    'Last user input prefix'
  );

  // {{defaultSystemPrompt}} / {{instructSystem}} / {{instructSystemPrompt}} - 默认系统提示
  registerSimple(
    ['defaultSystemPrompt', 'instructSystem', 'instructSystemPrompt'],
    () => getInstructSetting('default_system_prompt'),
    isInstructEnabled,
    'Default system prompt'
  );

  // {{systemPrompt}} - 活动系统提示（支持角色覆盖）
  registerSimple(
    ['systemPrompt'],
    () => {
      // 优先使用角色覆盖
      const characterOverride = (globalThis as any).__palinkCharacterSystemPrompt;
      if (characterOverride) return characterOverride;
      return getInstructSetting('system_prompt');
    },
    () => true, // 始终可用
    'Active system prompt (supports character override)'
  );

  // {{exampleSeparator}} / {{chatSeparator}} - 示例分隔符
  registerSimple(
    ['exampleSeparator', 'chatSeparator'],
    () => getInstructSetting('example_separator'),
    isInstructEnabled,
    'Example message separator'
  );

  // {{chatStart}} - 聊天开始标记
  registerSimple(
    ['chatStart'],
    () => getInstructSetting('chat_start'),
    isInstructEnabled,
    'Chat start marker'
  );
}
