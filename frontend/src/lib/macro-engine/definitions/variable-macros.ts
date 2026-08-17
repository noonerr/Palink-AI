/**
 * 变量操作宏定义
 * 基于 SillyTavern 1.18.0 variable-macros.js
 * 
 * 使用新的变量管理器 (lib/variables/manager.ts)
 */

import { MacroCategory, MacroValueType } from '../types';
import { MacroRegistry } from '../engine/MacroRegistry';
import { variableManager } from '../../variables/manager';

/**
 * 注册变量操作宏
 */
export function registerVariableMacros(): void {
  // ========== 局部变量 (local) ==========

  // {{setvar::name::value}} - 设置局部变量
  MacroRegistry.registerMacro('setvar', {
    category: MacroCategory.VARIABLE,
    unnamedArgs: [{
      name: 'name',
      optional: false,
      description: 'Variable name',
    }, {
      name: 'value',
      optional: false,
      description: 'Value to set',
    }],
    description: 'Sets a local (chat-scoped) variable',
    returns: 'Empty string',
    exampleUsage: '{{setvar::counter::0}}',
    handler: (ctx) => {
      const name = ctx.unnamedArgs[0];
      const value = ctx.unnamedArgs[1] ?? '';
      if (name) {
        variableManager.local.set(name, value);
      }
      return '';
    },
  });

  // {{addvar::name::value}} - 累加局部变量
  MacroRegistry.registerMacro('addvar', {
    category: MacroCategory.VARIABLE,
    unnamedArgs: [{
      name: 'name',
      optional: false,
      description: 'Variable name',
    }, {
      name: 'value',
      optional: false,
      description: 'Value to add',
    }],
    description: 'Adds a value to a local variable (numeric or string append)',
    returns: 'Empty string',
    exampleUsage: '{{addvar::counter::5}}',
    handler: (ctx) => {
      const name = ctx.unnamedArgs[0];
      const value = ctx.unnamedArgs[1] ?? '';
      if (name) {
        variableManager.local.add(name, value);
      }
      return '';
    },
  });

  // {{incvar::name}} - 自增局部变量
  MacroRegistry.registerMacro('incvar', {
    category: MacroCategory.VARIABLE,
    unnamedArgs: [{
      name: 'name',
      optional: false,
      description: 'Variable name',
    }],
    description: 'Increments a local variable by 1',
    returns: 'New value',
    exampleUsage: '{{incvar::counter}}',
    handler: (ctx) => {
      const name = ctx.unnamedArgs[0];
      if (name) {
        return String(variableManager.local.increment(name));
      }
      return '';
    },
  });

  // {{decvar::name}} - 自减局部变量
  MacroRegistry.registerMacro('decvar', {
    category: MacroCategory.VARIABLE,
    unnamedArgs: [{
      name: 'name',
      optional: false,
      description: 'Variable name',
    }],
    description: 'Decrements a local variable by 1',
    returns: 'New value',
    exampleUsage: '{{decvar::counter}}',
    handler: (ctx) => {
      const name = ctx.unnamedArgs[0];
      if (name) {
        return String(variableManager.local.decrement(name));
      }
      return '';
    },
  });

  // {{getvar::name}} - 获取局部变量
  MacroRegistry.registerMacro('getvar', {
    category: MacroCategory.VARIABLE,
    unnamedArgs: [{
      name: 'name',
      optional: false,
      description: 'Variable name',
    }],
    description: 'Gets a local (chat-scoped) variable value',
    returns: 'Variable value',
    exampleUsage: '{{getvar::counter}}',
    handler: (ctx) => {
      const name = ctx.unnamedArgs[0];
      if (name) {
        return String(variableManager.local.get(name));
      }
      return '';
    },
  });

  // {{hasvar::name}} - 检查局部变量是否存在
  MacroRegistry.registerMacro('hasvar', {
    category: MacroCategory.VARIABLE,
    unnamedArgs: [{
      name: 'name',
      optional: false,
      description: 'Variable name',
    }],
    description: 'Checks if a local variable exists',
    returns: '"true" or "false"',
    exampleUsage: '{{hasvar::counter}}',
    handler: (ctx) => {
      const name = ctx.unnamedArgs[0];
      if (name) {
        return variableManager.local.exists(name) ? 'true' : 'false';
      }
      return 'false';
    },
  });

  // {{deletevar::name}} - 删除局部变量
  MacroRegistry.registerMacro('deletevar', {
    category: MacroCategory.VARIABLE,
    unnamedArgs: [{
      name: 'name',
      optional: false,
      description: 'Variable name',
    }],
    description: 'Deletes a local variable',
    returns: 'Empty string',
    exampleUsage: '{{deletevar::counter}}',
    handler: (ctx) => {
      const name = ctx.unnamedArgs[0];
      if (name) {
        variableManager.local.delete(name);
      }
      return '';
    },
  });

  // ========== 全局变量 (global) ==========

  // {{setglobalvar::name::value}} - 设置全局变量
  MacroRegistry.registerMacro('setglobalvar', {
    category: MacroCategory.VARIABLE,
    unnamedArgs: [{
      name: 'name',
      optional: false,
      description: 'Variable name',
    }, {
      name: 'value',
      optional: false,
      description: 'Value to set',
    }],
    description: 'Sets a global (persistent) variable',
    returns: 'Empty string',
    exampleUsage: '{{setglobalvar::globalCounter::0}}',
    handler: (ctx) => {
      const name = ctx.unnamedArgs[0];
      const value = ctx.unnamedArgs[1] ?? '';
      if (name) {
        variableManager.global.set(name, value);
      }
      return '';
    },
  });

  // {{addglobalvar::name::value}} - 累加全局变量
  MacroRegistry.registerMacro('addglobalvar', {
    category: MacroCategory.VARIABLE,
    unnamedArgs: [{
      name: 'name',
      optional: false,
      description: 'Variable name',
    }, {
      name: 'value',
      optional: false,
      description: 'Value to add',
    }],
    description: 'Adds a value to a global variable',
    returns: 'Empty string',
    exampleUsage: '{{addglobalvar::globalCounter::5}}',
    handler: (ctx) => {
      const name = ctx.unnamedArgs[0];
      const value = ctx.unnamedArgs[1] ?? '';
      if (name) {
        variableManager.global.add(name, value);
      }
      return '';
    },
  });

  // {{incglobalvar::name}} - 自增全局变量
  MacroRegistry.registerMacro('incglobalvar', {
    category: MacroCategory.VARIABLE,
    unnamedArgs: [{
      name: 'name',
      optional: false,
      description: 'Variable name',
    }],
    description: 'Increments a global variable by 1',
    returns: 'New value',
    exampleUsage: '{{incglobalvar::globalCounter}}',
    handler: (ctx) => {
      const name = ctx.unnamedArgs[0];
      if (name) {
        return String(variableManager.global.increment(name));
      }
      return '';
    },
  });

  // {{decglobalvar::name}} - 自减全局变量
  MacroRegistry.registerMacro('decglobalvar', {
    category: MacroCategory.VARIABLE,
    unnamedArgs: [{
      name: 'name',
      optional: false,
      description: 'Variable name',
    }],
    description: 'Decrements a global variable by 1',
    returns: 'New value',
    exampleUsage: '{{decglobalvar::globalCounter}}',
    handler: (ctx) => {
      const name = ctx.unnamedArgs[0];
      if (name) {
        return String(variableManager.global.decrement(name));
      }
      return '';
    },
  });

  // {{getglobalvar::name}} - 获取全局变量
  MacroRegistry.registerMacro('getglobalvar', {
    category: MacroCategory.VARIABLE,
    unnamedArgs: [{
      name: 'name',
      optional: false,
      description: 'Variable name',
    }],
    description: 'Gets a global (persistent) variable value',
    returns: 'Variable value',
    exampleUsage: '{{getglobalvar::globalCounter}}',
    handler: (ctx) => {
      const name = ctx.unnamedArgs[0];
      if (name) {
        return String(variableManager.global.get(name));
      }
      return '';
    },
  });

  // {{hasglobalvar::name}} - 检查全局变量是否存在
  MacroRegistry.registerMacro('hasglobalvar', {
    category: MacroCategory.VARIABLE,
    unnamedArgs: [{
      name: 'name',
      optional: false,
      description: 'Variable name',
    }],
    description: 'Checks if a global variable exists',
    returns: '"true" or "false"',
    exampleUsage: '{{hasglobalvar::globalCounter}}',
    handler: (ctx) => {
      const name = ctx.unnamedArgs[0];
      if (name) {
        return variableManager.global.exists(name) ? 'true' : 'false';
      }
      return 'false';
    },
  });

  // {{deleteglobalvar::name}} - 删除全局变量
  MacroRegistry.registerMacro('deleteglobalvar', {
    category: MacroCategory.VARIABLE,
    unnamedArgs: [{
      name: 'name',
      optional: false,
      description: 'Variable name',
    }],
    description: 'Deletes a global variable',
    returns: 'Empty string',
    exampleUsage: '{{deleteglobalvar::globalCounter}}',
    handler: (ctx) => {
      const name = ctx.unnamedArgs[0];
      if (name) {
        variableManager.global.delete(name);
      }
      return '';
    },
  });
}
