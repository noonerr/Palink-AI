/**
 * 插件上下文
 * 提供给插件的API门面
 */

import type { PluginContext, PluginStorage } from './types';
import { eventBus } from '../event-bus';
import { SlashCommandEngine } from '../slash-engine';
import type { CommandDefinition } from '../slash-engine';
import { MacroRegistry } from '../macro-engine';
import type { MacroDefinitionOptions, MacroExecutionContext } from '../macro-engine';
import { messageFormatter, sillyTavernFormattingStage } from '@/utils/sillyTavernDisplayPipeline';

/**
 * ST 兼容钩子类型 — 使用 string 支持任意 ST 事件钩子名
 * （ST 有 generation_before_combine_prompts、chat_changed、character_message_rendered 等多种钩子）
 */
export type PluginHookType = string;

/**
 * registerHook 方法类型
 */
export type RegisterHook = (
  hook: PluginHookType,
  callback: (...args: any[]) => any,
) => void;

/**
 * 扩展的插件上下文（包含 registerHook）
 */
export type PluginContextWithHooks = PluginContext & {
  registerHook: RegisterHook;
  once: (event: string, callback: (...args: any[]) => void) => void;
};

/**
 * 创建插件上下文
 */
export function createPluginContext(
  pluginName: string,
  storage: PluginStorage,
): PluginContextWithHooks {
  // event -> (原始回调 -> 包装回调) 的映射
  // eventBus 以数组 payload 承载 ST 的 ...args 语义，on/once 需解包还原，off 据此精确清理
  const listeners = new Map<string, Map<Function, (payload: any) => void>>();

  const wrapCallback = (callback: (...args: any[]) => void): ((payload: any) => void) => {
    return (payload: any) => {
      const args = Array.isArray(payload) ? payload : [payload];
      callback(...args);
    };
  };

  const getOrCreateEventMap = (event: string): Map<Function, (payload: any) => void> => {
    if (!listeners.has(event)) {
      listeners.set(event, new Map());
    }
    return listeners.get(event)!;
  };

  return {
    // 事件系统
    on: (event: string, callback: (...args: any[]) => void) => {
      const wrapped = wrapCallback(callback);
      getOrCreateEventMap(event).set(callback, wrapped);
      eventBus.on(event as any, wrapped as any);
    },
    off: (event: string, callback: (...args: any[]) => void) => {
      const eventMap = listeners.get(event);
      if (!eventMap) return;
      const wrapped = eventMap.get(callback);
      if (wrapped) {
        eventBus.off(event as any, wrapped as any);
        eventMap.delete(callback);
      }
    },
    emit: (event: string, ...args: any[]) => {
      // 与 EventSourceWrapper.emit 对齐：将 ...args 打包为数组作为 eventBus 单 payload
      // on/once 的 wrapCallback 会解包回 ...args，保证 emit/listen 语义对称
      eventBus.emit(event as any, args as any);
    },
    once: (event: string, callback: (...args: any[]) => void) => {
      const eventMap = getOrCreateEventMap(event);
      const wrapped = (payload: any) => {
        const args = Array.isArray(payload) ? payload : [payload];
        try {
          callback(...args);
        } finally {
          eventMap.delete(callback);
        }
      };
      eventMap.set(callback, wrapped);
      eventBus.once(event as any, wrapped as any);
    },
    // 移除全部（或不指定事件时的全部）监听器。供沙箱 eventSource.removeAllListeners 委托。
    removeAllListeners: (event?: string) => {
      if (event !== undefined && event !== null && event !== '') {
        const eventMap = listeners.get(event);
        if (!eventMap) return;
        for (const [callback, wrapped] of Array.from(eventMap.entries())) {
          eventBus.off(event as any, wrapped as any);
          eventMap.delete(callback);
        }
        if (eventMap.size === 0) listeners.delete(event);
      } else {
        for (const [ev, eventMap] of Array.from(listeners.entries())) {
          for (const [callback, wrapped] of Array.from(eventMap.entries())) {
            eventBus.off(ev as any, wrapped as any);
            eventMap.delete(callback);
          }
          listeners.delete(ev);
        }
      }
    },

    // 存储
    storage,

    // 注册能力 - 委托到 SlashCommandEngine
    registerCommand: (command: any) => {
      // ST 插件格式: { name, callback, aliases, help, ... }
      // SlashCommandEngine 期望: CommandDefinition { name, description, aliases, callback(namedArgs, unnamedArgs, context) }
      if (!command || typeof command !== 'object' || !command.name) {
        console.warn(`[Plugin:${pluginName}] registerCommand: invalid command, missing name`);
        return;
      }

      const pluginCallback = command.callback;
      if (typeof pluginCallback !== 'function') {
        console.warn(`[Plugin:${pluginName}] registerCommand: '${command.name}' missing callback`);
        return;
      }

      const definition: CommandDefinition = {
        name: String(command.name),
        description: String(command.description || command.help || ''),
        aliases: Array.isArray(command.aliases) ? command.aliases.map(String) : undefined,
        returns: command.returns ? String(command.returns) : undefined,
        callback: async (namedArgs, unnamedArgs, context) => {
          // ST 回调签名: (namedArgs, unnamedArgs) => string | void
          const result = await pluginCallback(namedArgs, unnamedArgs, context);
          if (result === null || result === undefined) return '';
          return String(result);
        },
      };

      SlashCommandEngine.register(definition);
    },

    // 注册能力 - 委托到 MacroRegistry
    registerMacro: (name: string, options: any) => {
      // ST 插件格式: (name, { handler: (args) => ..., description, aliases, ... })
      // MacroRegistry 期望: (name, MacroDefinitionOptions { handler: (context) => string, ... })
      if (!name || typeof name !== 'string') {
        console.warn(`[Plugin:${pluginName}] registerMacro: invalid name`);
        return;
      }

      const macroOptions: MacroDefinitionOptions =
        options && typeof options === 'object' ? { ...options } : { handler: () => '' };

      const pluginHandler = options?.handler;
      if (typeof pluginHandler === 'function') {
        // 适配 handler 签名: ST handler(args) -> MacroRegistry handler(context)
        macroOptions.handler = (context: MacroExecutionContext) => {
          const result = pluginHandler(context.args, context);
          if (result === null || result === undefined) return '';
          return String(result);
        };
      }

      if (typeof macroOptions.handler !== 'function') {
        console.warn(`[Plugin:${pluginName}] registerMacro: '${name}' missing handler`);
        return;
      }

      MacroRegistry.registerMacro(name, macroOptions);
    },

    // 注册钩子 - messageFormatting 委托到消息格式化管线，其他委托到 eventBus
    registerHook: (hook: PluginHookType, callback: (...args: any[]) => any) => {
      if (typeof callback !== 'function') {
        console.warn(`[Plugin:${pluginName}] registerHook: '${hook}' callback is not a function`);
        return;
      }

      if (hook === 'messageFormatting') {
        // 委托到消息格式化管线 (messageFormatter)
        // messageFormatter.addHook 期望: (content: string, context: Readonly<SillyTavernFormattingContext>) => string
        try {
          messageFormatter.addHook((content, ctx) => {
            try {
              const result = callback(content, ctx);
              return typeof result === 'string' ? result : content;
            } catch (error) {
              console.error(`[Plugin:${pluginName}] messageFormatting hook error:`, error);
              return content;
            }
          }, { stage: sillyTavernFormattingStage.AFTER_MARKDOWN });
        } catch (error) {
          console.error(`[Plugin:${pluginName}] registerHook messageFormatting failed:`, error);
        }
      } else {
        // 其他钩子委托到 eventBus
        eventBus.on(hook as any, callback as any);
      }
    },

    // 日志
    log: (message: string, level: 'info' | 'warn' | 'error' = 'info') => {
      const prefix = `[Plugin:${pluginName}]`;
      switch (level) {
        case 'warn':
          console.warn(`${prefix} ${message}`);
          break;
        case 'error':
          console.error(`${prefix} ${message}`);
          break;
        default:
          console.log(`${prefix} ${message}`);
      }
    },
  };
}
