/**
 * 环境/角色宏定义
 * 基于 SillyTavern 1.18.0 env-macros.js
 */

import { MacroCategory, MacroValueType } from '../types';
import { MacroRegistry } from '../engine/MacroRegistry';

/**
 * 注册环境/角色宏
 */
export function registerEnvMacros(): void {
  // ========== 名称类 (NAMES) ==========

  // {{user}} - 当前Persona用户名
  MacroRegistry.registerMacro('user', {
    category: MacroCategory.NAMES,
    unnamedArgs: 0,
    description: 'Current persona username',
    returns: 'Username string',
    handler: (ctx) => ctx.env.names.user,
  });

  // {{char}} - 角色名称
  MacroRegistry.registerMacro('char', {
    category: MacroCategory.NAMES,
    unnamedArgs: 0,
    description: 'Character name',
    returns: 'Character name string',
    handler: (ctx) => ctx.env.names.char,
  });

  // {{group}} - 群组成员列表（含静音）或单人角色名
  MacroRegistry.registerMacro('group', {
    category: MacroCategory.NAMES,
    unnamedArgs: 0,
    description: 'Group member list (including muted) or character name for single chat',
    returns: 'Group members or character name',
    handler: (ctx) => ctx.env.names.group || ctx.env.names.char,
  });

  // {{groupNotMuted}} - 群组成员列表（不含静音）
  MacroRegistry.registerMacro('groupNotMuted', {
    category: MacroCategory.NAMES,
    unnamedArgs: 0,
    description: 'Group member list (excluding muted members)',
    returns: 'Active group members',
    handler: (ctx) => ctx.env.names.groupNotMuted || ctx.env.names.char,
  });

  // {{notChar}} - 除当前发言者外所有参与者
  MacroRegistry.registerMacro('notChar', {
    category: MacroCategory.NAMES,
    unnamedArgs: 0,
    description: 'All participants except the current character',
    returns: 'Other participants',
    handler: (ctx) => ctx.env.names.notChar || ctx.env.names.user,
  });

  // {{groupSize}} - 群聊成员数（单人聊天返回 1）
  MacroRegistry.registerMacro('groupSize', {
    category: MacroCategory.NAMES,
    unnamedArgs: 0,
    description: 'Number of members in the current group chat (1 for single chat)',
    returns: 'Member count as string',
    returnType: MacroValueType.INTEGER,
    handler: (ctx) => {
      // 优先从 extra.groupMembers 数组获取成员数
      const members = ctx.env.extra?.groupMembers;
      if (Array.isArray(members)) {
        return String(Math.max(1, members.length));
      }
      // 其次从 extra.groupSize 数值获取
      const size = ctx.env.extra?.groupSize;
      if (typeof size === 'number') {
        return String(Math.max(1, size));
      }
      // 上下文未提供时，单人聊天返回 1
      // TODO: 群聊上下文尚未注入 groupMembers/groupSize，需在 NativeRoleplayChat 传入
      return '1';
    },
  });

  // ========== 角色卡字段类 (CHARACTER) ==========

  // {{charPrompt}} - 角色主提示覆盖
  MacroRegistry.registerMacro('charPrompt', {
    category: MacroCategory.CHARACTER,
    unnamedArgs: 0,
    description: 'Character main prompt override',
    returns: 'Character prompt text',
    handler: (ctx) => ctx.env.character.charPrompt ?? '',
  });

  // {{charInstruction}} - 角色后历史指令覆盖
  MacroRegistry.registerMacro('charInstruction', {
    category: MacroCategory.CHARACTER,
    unnamedArgs: 0,
    description: 'Character post-history instruction override',
    returns: 'Character instruction text',
    handler: (ctx) => ctx.env.character.charInstruction ?? '',
  });

  // {{charDescription}} / {{description}} - 角色描述
  MacroRegistry.registerMacro('charDescription', {
    category: MacroCategory.CHARACTER,
    unnamedArgs: 0,
    aliases: ['description'],
    description: 'Character description from character card',
    returns: 'Character description text',
    handler: (ctx) => ctx.env.character.description ?? '',
  });

  // {{charPersonality}} / {{personality}} - 角色性格
  MacroRegistry.registerMacro('charPersonality', {
    category: MacroCategory.CHARACTER,
    unnamedArgs: 0,
    aliases: ['personality'],
    description: 'Character personality from character card',
    returns: 'Character personality text',
    handler: (ctx) => ctx.env.character.personality ?? '',
  });

  // {{charScenario}} / {{scenario}} - 角色场景
  MacroRegistry.registerMacro('charScenario', {
    category: MacroCategory.CHARACTER,
    unnamedArgs: 0,
    aliases: ['scenario'],
    description: 'Character scenario from character card',
    returns: 'Character scenario text',
    handler: (ctx) => ctx.env.character.scenario ?? '',
  });

  // {{persona}} - 当前Persona描述
  MacroRegistry.registerMacro('persona', {
    category: MacroCategory.CHARACTER,
    unnamedArgs: 0,
    description: 'Current persona description',
    returns: 'Persona description text',
    handler: (ctx) => ctx.env.character.persona ?? '',
  });

  // {{mesExamplesRaw}} - 原始对话示例
  MacroRegistry.registerMacro('mesExamplesRaw', {
    category: MacroCategory.CHARACTER,
    unnamedArgs: 0,
    description: 'Raw message examples from character card',
    returns: 'Raw examples text',
    handler: (ctx) => ctx.env.character.mesExamplesRaw ?? '',
  });

  // {{mesExamples}} - 格式化对话示例
  MacroRegistry.registerMacro('mesExamples', {
    category: MacroCategory.CHARACTER,
    unnamedArgs: 0,
    description: 'Formatted message examples',
    returns: 'Formatted examples text',
    handler: (ctx) => {
      const raw = ctx.env.character.mesExamplesRaw ?? '';
      if (!raw) return '';
      // 简化版本，直接返回原始内容
      return raw;
    },
  });

  // {{charDepthPrompt}} - @ Depth Note
  MacroRegistry.registerMacro('charDepthPrompt', {
    category: MacroCategory.CHARACTER,
    unnamedArgs: 0,
    description: 'Character depth prompt (@ Depth Note)',
    returns: 'Depth prompt text',
    handler: (ctx) => ctx.env.character.charDepthPrompt ?? '',
  });

  // {{charCreatorNotes}} / {{creatorNotes}} - 创作者注释
  MacroRegistry.registerMacro('charCreatorNotes', {
    category: MacroCategory.CHARACTER,
    unnamedArgs: 0,
    aliases: ['creatorNotes', 'char_notes'],
    description: 'Character creator notes',
    returns: 'Creator notes text',
    handler: (ctx) => ctx.env.character.creatorNotes ?? '',
  });

  // {{charFirstMessage}} / {{greeting}} - 第一条消息/问候
  MacroRegistry.registerMacro('charFirstMessage', {
    category: MacroCategory.CHARACTER,
    unnamedArgs: 0,
    aliases: ['greeting', 'first_msg'],
    description: 'Character first message / greeting',
    returns: 'First message text',
    handler: (ctx) => ctx.env.character.firstMessage ?? '',
  });

  // {{charVersion}} / {{version}} / {{char_version}} - 角色版本号
  MacroRegistry.registerMacro('charVersion', {
    category: MacroCategory.CHARACTER,
    unnamedArgs: 0,
    aliases: ['char_version'],
    description: 'Character version number',
    returns: 'Version string',
    handler: (ctx) => ctx.env.character.version ?? '',
  });

  // 为 version 注册隐藏别名
  MacroRegistry.registerMacroAlias('charVersion', 'version', { visible: false });

  // ========== 系统/状态类 (STATE) ==========

  // {{model}} - 当前API模型名称
  MacroRegistry.registerMacro('model', {
    category: MacroCategory.STATE,
    unnamedArgs: 0,
    description: 'Current API model name',
    returns: 'Model name string',
    handler: (ctx) => ctx.env.system.model ?? '',
  });

  // {{original}} - 原始消息内容（一次性消耗）
  MacroRegistry.registerMacro('original', {
    category: MacroCategory.STATE,
    unnamedArgs: 0,
    description: 'Original message content (consumed after first use)',
    returns: 'Original content',
    handler: (ctx) => {
      if (ctx.env.functions.original) {
        return ctx.env.functions.original();
      }
      return ctx.env.content ?? '';
    },
  });

  // {{isMobile}} - 是否移动环境
  MacroRegistry.registerMacro('isMobile', {
    category: MacroCategory.STATE,
    unnamedArgs: 0,
    description: 'Whether the current environment is mobile',
    returns: '"true" or "false"',
    handler: (ctx) => {
      return ctx.env.extra?.isMobile === true ? 'true' : 'false';
    },
  });
}
