/**
 * 基础斜杠命令定义
 * 为AI对话和角色扮演提供常用命令
 */

import { SlashCommandEngine, ARGUMENT_TYPE } from './index';
import { SlashCommandScope, substituteMacros, evaluateCondition } from './scope';
import { BreakSignal, ContinueSignal } from './closure';

// ============================================================
// 命令上下文接口
// ============================================================

export interface CommandContext {
  // 会话操作
  clearMessages?: () => void;
  exportMessages?: (format: string) => string;
  
  // 模型操作
  getCurrentModel?: () => string;
  setModel?: (model: string) => void;
  getAvailableModels?: () => string[];
  
  // 风格操作
  getResponseStyle?: () => string;
  setResponseStyle?: (style: string) => void;
  
  // 语言操作
  getLanguage?: () => string;
  setLanguage?: (lang: string) => void;
  
  // 参数操作
  getTemperature?: () => number;
  setTemperature?: (temp: number) => void;
  getMaxTokens?: () => number;
  setMaxTokens?: (tokens: number) => void;
  
  // 系统提示
  getSystemPrompt?: () => string;
  setSystemPrompt?: (prompt: string) => void;
  
  // 帮助
  getHelp?: (command?: string) => string;
}

// ============================================================
// 注册基础命令
// ============================================================

export function registerBasicCommands(context: CommandContext = {}): void {
  // /clear - 清空对话
  // T6 (ST 插件兼容·破坏性命令保护): /clear 会清空整个会话且不可恢复。
  // ST 插件脚本可能批量执行 slash 命令，静默清空风险高，故执行前强制确认。
  // named arg force=true 可跳过确认（供用户显式知情使用，与 ST 习惯一致）。
  SlashCommandEngine.register({
    name: 'clear',
    description: 'Clear the current conversation (asks for confirmation; pass force=true to skip)',
    aliases: ['cls', 'reset'],
    namedArgs: [{
      name: 'force',
      description: 'Skip the confirmation prompt',
      type: [ARGUMENT_TYPE.BOOLEAN],
      isRequired: false,
    }],
    callback: (namedArgs: Record<string, string>) => {
      const force = String(namedArgs?.force ?? '').toLowerCase() === 'true';
      if (!force && typeof window !== 'undefined') {
        const confirmed = window.confirm(
          '确定要清空当前对话吗？此操作不可恢复。\nClear the current conversation? This cannot be undone.',
        );
        if (!confirmed) {
          return 'Clear cancelled.';
        }
      }
      if (context.clearMessages) {
        context.clearMessages();
        return 'Conversation cleared.';
      }
      if (typeof window !== 'undefined') {
        window.dispatchEvent(new CustomEvent('slash:clear'));
        return 'Conversation cleared.';
      }
      return '';
    },
  });

  // /export - 导出对话
  SlashCommandEngine.register({
    name: 'export',
    description: 'Export the conversation',
    aliases: ['save'],
    unnamedArgs: [{
      name: 'format',
      description: 'Export format (markdown, json, text)',
      type: [ARGUMENT_TYPE.STRING],
      isRequired: false,
    }],
    callback: (namedArgs, unnamedArgs) => {
      const format = unnamedArgs[0] || namedArgs.format || 'markdown';
      if (context.exportMessages) {
        const exported = context.exportMessages(format);
        return `Exported as ${format}:\n${exported.slice(0, 500)}${exported.length > 500 ? '...' : ''}`;
      }
      if (typeof window !== 'undefined') {
        window.dispatchEvent(new CustomEvent('slash:export', { detail: { format } }));
        return `Export requested as ${format}.`;
      }
      return '';
    },
  });

  // /model - 切换模型
  SlashCommandEngine.register({
    name: 'model',
    description: 'Switch the AI model',
    aliases: ['m'],
    unnamedArgs: [{
      name: 'model',
      description: 'Model name to switch to',
      type: [ARGUMENT_TYPE.STRING],
      isRequired: false,
    }],
    callback: (namedArgs, unnamedArgs) => {
      const modelName = unnamedArgs[0] || namedArgs.model;
      
      if (!modelName) {
        // 显示当前模型
        const current = context.getCurrentModel?.() || 'unknown';
        const available = context.getAvailableModels?.() || [];
        let result = `Current model: ${current}\n`;
        if (available.length > 0) {
          result += `Available models: ${available.join(', ')}`;
        }
        return result;
      }

      // 切换模型
      if (context.setModel) {
        context.setModel(modelName);
        return `Switched to model: ${modelName}`;
      }
      if (typeof window !== 'undefined') {
        window.dispatchEvent(new CustomEvent('slash:model', { detail: { model: modelName } }));
        return `Model: ${modelName}`;
      }
      return '';
    },
  });

  // /style - 切换响应风格
  SlashCommandEngine.register({
    name: 'style',
    description: 'Switch the response style',
    aliases: ['s'],
    unnamedArgs: [{
      name: 'style',
      description: 'Response style (concise, detailed, creative, professional)',
      type: [ARGUMENT_TYPE.STRING],
      isRequired: false,
    }],
    callback: (namedArgs, unnamedArgs) => {
      const style = unnamedArgs[0] || namedArgs.style;
      
      if (!style) {
        const current = context.getResponseStyle?.() || 'default';
        return `Current style: ${current}\nAvailable styles: concise, detailed, creative, professional`;
      }

      if (context.setResponseStyle) {
        context.setResponseStyle(style);
        return `Response style set to: ${style}`;
      }
      if (typeof window !== 'undefined') {
        window.dispatchEvent(new CustomEvent('slash:style', { detail: { style } }));
        return `Response style set to: ${style}`;
      }
      return '';
    },
  });

  // /lang - 切换语言
  SlashCommandEngine.register({
    name: 'lang',
    description: 'Switch the language',
    unnamedArgs: [{
      name: 'language',
      description: 'Language code (zh, en, ja, ko)',
      type: [ARGUMENT_TYPE.STRING],
      isRequired: false,
    }],
    callback: (namedArgs, unnamedArgs) => {
      const lang = unnamedArgs[0] || namedArgs.language;
      
      if (!lang) {
        const current = context.getLanguage?.() || 'zh';
        return `Current language: ${current}\nAvailable languages: zh, en, ja, ko`;
      }

      if (context.setLanguage) {
        context.setLanguage(lang);
        return `Language set to: ${lang}`;
      }
      if (typeof window !== 'undefined') {
        window.dispatchEvent(new CustomEvent('slash:lang', { detail: { lang } }));
        return `Language set to: ${lang}`;
      }
      return '';
    },
  });

  // /temp - 设置温度
  SlashCommandEngine.register({
    name: 'temp',
    description: 'Set the temperature parameter',
    aliases: ['temperature'],
    unnamedArgs: [{
      name: 'value',
      description: 'Temperature value (0.0 - 2.0)',
      type: [ARGUMENT_TYPE.NUMBER],
      isRequired: false,
    }],
    callback: (namedArgs, unnamedArgs) => {
      const valueStr = unnamedArgs[0] || namedArgs.value;
      
      if (!valueStr) {
        const current = context.getTemperature?.() ?? 0.7;
        return `Current temperature: ${current}\nUsage: /temp <value> (0.0 - 2.0)`;
      }

      const value = parseFloat(valueStr);
      if (isNaN(value) || value < 0 || value > 2) {
        return 'Invalid temperature value. Must be between 0.0 and 2.0.';
      }

      if (context.setTemperature) {
        context.setTemperature(value);
        return `Temperature set to: ${value}`;
      }
      if (typeof window !== 'undefined') {
        window.dispatchEvent(new CustomEvent('slash:temp', { detail: { value } }));
        return `Temperature set to: ${value}`;
      }
      return '';
    },
  });

  // /tokens - 设置最大token数
  SlashCommandEngine.register({
    name: 'tokens',
    description: 'Set the maximum tokens',
    aliases: ['max_tokens', 'maxtokens'],
    unnamedArgs: [{
      name: 'value',
      description: 'Maximum tokens value',
      type: [ARGUMENT_TYPE.NUMBER],
      isRequired: false,
    }],
    callback: (namedArgs, unnamedArgs) => {
      const valueStr = unnamedArgs[0] || namedArgs.value;
      
      if (!valueStr) {
        const current = context.getMaxTokens?.() ?? 2048;
        return `Current max tokens: ${current}\nUsage: /tokens <value>`;
      }

      const value = parseInt(valueStr, 10);
      if (isNaN(value) || value < 1) {
        return 'Invalid tokens value. Must be a positive integer.';
      }

      if (context.setMaxTokens) {
        context.setMaxTokens(value);
        return `Max tokens set to: ${value}`;
      }
      if (typeof window !== 'undefined') {
        window.dispatchEvent(new CustomEvent('slash:tokens', { detail: { value } }));
        return `Max tokens set to: ${value}`;
      }
      return '';
    },
  });

  // /system - 查看/设置系统提示
  SlashCommandEngine.register({
    name: 'system',
    description: 'View or set the system prompt',
    aliases: ['sys', 'prompt'],
    unnamedArgs: [{
      name: 'prompt',
      description: 'New system prompt (leave empty to view current)',
      type: [ARGUMENT_TYPE.STRING],
      isRequired: false,
    }],
    callback: (namedArgs, unnamedArgs) => {
      const prompt = unnamedArgs.join(' ') || namedArgs.prompt;
      
      if (!prompt) {
        const current = context.getSystemPrompt?.() || '';
        if (current) {
          return `Current system prompt:\n${current}`;
        }
        return 'No system prompt set.';
      }

      if (context.setSystemPrompt) {
        context.setSystemPrompt(prompt);
        return 'System prompt updated.';
      }
      if (typeof window !== 'undefined') {
        window.dispatchEvent(new CustomEvent('slash:system', { detail: { prompt } }));
        return 'System prompt updated.';
      }
      return '';
    },
  });

  // /help - 帮助
  SlashCommandEngine.register({
    name: 'help',
    description: 'Show help information',
    aliases: ['h', '?'],
    unnamedArgs: [{
      name: 'command',
      description: 'Command name to get help for',
      type: [ARGUMENT_TYPE.STRING],
      isRequired: false,
    }],
    callback: (namedArgs, unnamedArgs) => {
      const commandName = unnamedArgs[0] || namedArgs.command;
      
      if (context.getHelp) {
        return context.getHelp(commandName);
      }
      
      return SlashCommandEngine.getHelp(commandName);
    },
  });

  // /time - 显示当前时间
  SlashCommandEngine.register({
    name: 'time',
    description: 'Show current time',
    callback: () => {
      const now = new Date();
      return `Current time: ${now.toLocaleTimeString()}\nCurrent date: ${now.toLocaleDateString()}`;
    },
  });

  // /version - 显示版本
  SlashCommandEngine.register({
    name: 'version',
    description: 'Show version information',
    aliases: ['v'],
    callback: () => {
      return 'Palink-AI v1.0.0\nSillyTavern Compatible Layer: v1.18.0';
    },
  });
}

// ============================================================
// 角色扮演专用命令
// ============================================================

export interface RoleplayCommandContext {
  // 角色操作
  getCharacterName?: () => string;
  getCharacterDescription?: () => string;
  
  // 世界书操作
  getWorldBook?: () => string;
  
  // 分支操作
  getBranches?: () => string[];
  switchBranch?: (branch: string) => void;
  
  // Swipe操作
  swipeLeft?: () => void;
  swipeRight?: () => void;
}

export function registerRoleplayCommands(context: RoleplayCommandContext = {}): void {
  // /char - 显示角色信息
  SlashCommandEngine.register({
    name: 'char',
    description: 'Show character information',
    aliases: ['character'],
    callback: () => {
      const name = context.getCharacterName?.() || 'Unknown';
      const desc = context.getCharacterDescription?.() || 'No description';
      return `Character: ${name}\nDescription: ${desc}`;
    },
  });

  // /world - 显示世界书
  SlashCommandEngine.register({
    name: 'world',
    description: 'Show world book information',
    aliases: ['lorebook', 'wi'],
    callback: () => {
      if (context.getWorldBook) {
        return context.getWorldBook();
      }
      if (typeof window !== 'undefined') {
        window.dispatchEvent(new CustomEvent('slash:world'));
      }
      return '';
    },
  });

  // /branch - 分支操作
  SlashCommandEngine.register({
    name: 'branch',
    description: 'Branch operations',
    unnamedArgs: [{
      name: 'action',
      description: 'Action (list, switch <name>)',
      type: [ARGUMENT_TYPE.STRING],
      isRequired: false,
    }],
    callback: (namedArgs, unnamedArgs) => {
      const action = unnamedArgs[0] || namedArgs.action || 'list';
      
      if (action === 'list') {
        const branches = context.getBranches?.() || [];
        if (branches.length === 0) {
          return 'No branches available.';
        }
        return `Branches:\n${branches.map(b => `  - ${b}`).join('\n')}`;
      }
      
      if (action === 'switch' && unnamedArgs[1]) {
        if (context.switchBranch) {
          context.switchBranch(unnamedArgs[1]);
          return `Switched to branch: ${unnamedArgs[1]}`;
        }
        if (typeof window !== 'undefined') {
          window.dispatchEvent(new CustomEvent('slash:branch', { detail: { action: 'switch', name: unnamedArgs[1] } }));
          return `Switched to branch: ${unnamedArgs[1]}`;
        }
        return '';
      }
      
      return 'Usage: /branch [list|switch <name>]';
    },
  });

  // /swipe - Swipe操作
  SlashCommandEngine.register({
    name: 'swipe',
    description: 'Swipe to previous/next response',
    unnamedArgs: [{
      name: 'direction',
      description: 'Direction (left, right)',
      type: [ARGUMENT_TYPE.STRING],
      isRequired: false,
    }],
    callback: (namedArgs, unnamedArgs) => {
      const direction = unnamedArgs[0] || namedArgs.direction || 'right';
      
      if (direction === 'left') {
        if (context.swipeLeft) {
          context.swipeLeft();
          return 'Swiped left (previous response).';
        }
      } else if (direction === 'right') {
        if (context.swipeRight) {
          context.swipeRight();
          return 'Swiped right (next response).';
        }
      }

      if (typeof window !== 'undefined') {
        window.dispatchEvent(new CustomEvent('slash:swipe', { detail: { direction } }));
        return `Swiped ${direction}.`;
      }
      return '';
    },
  });
}

// ============================================================
// 控制流命令
// ============================================================

export function registerControlFlowCommands(): void {
  // /if condition | /cmd1 | /cmd2
  SlashCommandEngine.register({
    name: 'if',
    description: 'Conditional execution: /if <condition> | /then-cmd | /else-cmd',
    callback: async (_namedArgs, unnamedArgs, context) => {
      const scope = context?.scope;
      const closures = context?.closures ?? [];
      if (!scope) return '';

      const condition = unnamedArgs.join(' ');
      const substituted = substituteMacros(condition, scope);
      const result = evaluateCondition(substituted);

      if (result) {
        if (closures[0]) {
          return await closures[0].execute(scope);
        }
      } else {
        if (closures[1]) {
          return await closures[1].execute(scope);
        }
      }

      return '';
    },
  });

  // /while condition | /cmd
  SlashCommandEngine.register({
    name: 'while',
    description: 'Loop while condition is true: /while <condition> | /cmd',
    callback: async (_namedArgs, unnamedArgs, context) => {
      const scope = context?.scope;
      const closures = context?.closures ?? [];
      if (!scope) return '';

      const condition = unnamedArgs.join(' ');
      const maxIterations = 100000;
      let iterations = 0;
      let lastOutput = '';

      while (iterations < maxIterations) {
        const substituted = substituteMacros(condition, scope);
        if (!evaluateCondition(substituted)) break;

        try {
          for (const closure of closures) {
            lastOutput = await closure.execute(scope);
          }
        } catch (e) {
          if (e instanceof BreakSignal) break;
          if (e instanceof ContinueSignal) {
            iterations++;
            continue;
          }
          throw e;
        }

        iterations++;
      }

      return lastOutput;
    },
  });

  // /for item in list | /cmd
  SlashCommandEngine.register({
    name: 'for',
    description: 'Iterate over a list: /for <item> in <v1 v2 ...> | /cmd',
    callback: async (_namedArgs, unnamedArgs, context) => {
      const scope = context?.scope;
      const closures = context?.closures ?? [];
      if (!scope) return '';

      const inIdx = unnamedArgs.findIndex(a => a.toLowerCase() === 'in');
      if (inIdx < 0) return 'Usage: /for <item> in <list> | /cmd';

      const itemName = unnamedArgs[0];
      const list = unnamedArgs.slice(inIdx + 1);
      let lastOutput = '';

      for (const item of list) {
        const childScope = new SlashCommandScope(scope);
        childScope.letVariable(itemName, item);

        try {
          for (const closure of closures) {
            lastOutput = await closure.execute(childScope);
          }
        } catch (e) {
          if (e instanceof BreakSignal) break;
          if (e instanceof ContinueSignal) continue;
          throw e;
        }
      }

      return lastOutput;
    },
  });

  // /switch value | /case 1 | /cmd1 | /case 2 | /cmd2 | /default | /cmd3
  SlashCommandEngine.register({
    name: 'switch',
    description: 'Multi-branch: /switch <value> | /case <v> | /cmd | /default | /cmd',
    callback: async (_namedArgs, unnamedArgs, context) => {
      const scope = context?.scope;
      const closures = context?.closures ?? [];
      if (!scope) return '';

      const value = substituteMacros(unnamedArgs.join(' '), scope);
      let matched = false;

      for (let i = 0; i < closures.length; i++) {
        const cmd = closures[i].commands.trim();
        const caseMatch = cmd.match(/^\/case\s+([\s\S]*)$/i);
        const isDefault = /^\/default\s*$/i.test(cmd);

        if (caseMatch) {
          const caseValue = substituteMacros(caseMatch[1].trim(), scope);
          if (caseValue === value) {
            matched = true;
            if (i + 1 < closures.length) {
              return await closures[i + 1].execute(scope);
            }
            return '';
          }
        } else if (isDefault && !matched) {
          if (i + 1 < closures.length) {
            return await closures[i + 1].execute(scope);
          }
          return '';
        }
      }

      return '';
    },
  });

  // /break
  SlashCommandEngine.register({
    name: 'break',
    description: 'Break out of the current loop',
    callback: () => {
      throw new BreakSignal();
    },
  });

  // /continue
  SlashCommandEngine.register({
    name: 'continue',
    description: 'Skip to the next iteration of the current loop',
    callback: () => {
      throw new ContinueSignal();
    },
  });
}

// ============================================================
// 作用域变量命令
// ============================================================

export function registerScopeVariableCommands(): void {
  // /let name=value — 声明作用域变量
  SlashCommandEngine.register({
    name: 'let',
    description: 'Declare a scope variable: /let <name>=<value>',
    callback: (namedArgs, unnamedArgs, context) => {
      const scope = context?.scope;
      if (!scope) return '';

      let lastValue = '';
      for (const [key, value] of Object.entries(namedArgs)) {
        scope.letVariable(key, value);
        lastValue = value;
      }
      for (const name of unnamedArgs) {
        if (!scope.existsVariable(name)) {
          scope.letVariable(name, '');
        }
      }

      return lastValue;
    },
  });

  // /set name=value — 设置变量（向上查找）
  SlashCommandEngine.register({
    name: 'set',
    description: 'Set a variable: /set <name>=<value>',
    callback: (namedArgs, _unnamedArgs, context) => {
      const scope = context?.scope;
      if (!scope) return '';

      let lastValue = '';
      for (const [key, value] of Object.entries(namedArgs)) {
        scope.setVariable(key, value);
        lastValue = value;
      }

      return lastValue;
    },
  });

  // /get name — 获取变量
  SlashCommandEngine.register({
    name: 'get',
    description: 'Get a variable value: /get <name>',
    unnamedArgs: [{
      name: 'name',
      description: 'Variable name',
      type: [ARGUMENT_TYPE.STRING],
      isRequired: true,
    }],
    callback: (_namedArgs, unnamedArgs, context) => {
      const scope = context?.scope;
      if (!scope) return '';
      const name = unnamedArgs[0];
      if (!name) return '';
      return scope.getVariable(name);
    },
  });

  // /var name — 获取变量（/get 别名）
  SlashCommandEngine.register({
    name: 'var',
    description: 'Get a variable value (alias of /get)',
    unnamedArgs: [{
      name: 'name',
      description: 'Variable name',
      type: [ARGUMENT_TYPE.STRING],
      isRequired: true,
    }],
    callback: (_namedArgs, unnamedArgs, context) => {
      const scope = context?.scope;
      if (!scope) return '';
      const name = unnamedArgs[0];
      if (!name) return '';
      return scope.getVariable(name);
    },
  });

  // /inc name — 变量自增
  SlashCommandEngine.register({
    name: 'inc',
    description: 'Increment a variable by 1: /inc <name>',
    unnamedArgs: [{
      name: 'name',
      description: 'Variable name',
      type: [ARGUMENT_TYPE.STRING],
      isRequired: true,
    }],
    callback: (_namedArgs, unnamedArgs, context) => {
      const scope = context?.scope;
      if (!scope) return '';
      const name = unnamedArgs[0];
      if (!name) return '';
      const current = Number(scope.getVariable(name)) || 0;
      const newValue = String(current + 1);
      scope.setVariable(name, newValue);
      return newValue;
    },
  });

  // /dec name — 变量自减
  SlashCommandEngine.register({
    name: 'dec',
    description: 'Decrement a variable by 1: /dec <name>',
    unnamedArgs: [{
      name: 'name',
      description: 'Variable name',
      type: [ARGUMENT_TYPE.STRING],
      isRequired: true,
    }],
    callback: (_namedArgs, unnamedArgs, context) => {
      const scope = context?.scope;
      if (!scope) return '';
      const name = unnamedArgs[0];
      if (!name) return '';
      const current = Number(scope.getVariable(name)) || 0;
      const newValue = String(current - 1);
      scope.setVariable(name, newValue);
      return newValue;
    },
  });
}

// ============================================================
// 文本处理命令（用于管道与闭包测试）
// ============================================================

export function registerTextProcessingCommands(): void {
  // /upcase — 转大写
  SlashCommandEngine.register({
    name: 'upcase',
    description: 'Convert text to uppercase (uses pipe or args)',
    callback: (_namedArgs, unnamedArgs, context) => {
      const text = unnamedArgs.join(' ') || context?.pipe || '';
      return text.toUpperCase();
    },
  });

  // /downcase — 转小写
  SlashCommandEngine.register({
    name: 'downcase',
    description: 'Convert text to lowercase (uses pipe or args)',
    callback: (_namedArgs, unnamedArgs, context) => {
      const text = unnamedArgs.join(' ') || context?.pipe || '';
      return text.toLowerCase();
    },
  });

  // /trim — 去除首尾空白
  SlashCommandEngine.register({
    name: 'trim',
    description: 'Trim leading and trailing whitespace (uses pipe or args)',
    callback: (_namedArgs, unnamedArgs, context) => {
      const text = unnamedArgs.join(' ') || context?.pipe || '';
      return text.trim();
    },
  });

  // /length — 返回文本长度
  SlashCommandEngine.register({
    name: 'length',
    description: 'Return the length of the text (uses pipe or args)',
    callback: (_namedArgs, unnamedArgs, context) => {
      const text = unnamedArgs.join(' ') || context?.pipe || '';
      return String(text.length);
    },
  });
}
