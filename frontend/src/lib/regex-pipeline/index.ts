/**
 * Regex Pipeline 模块入口
 * 基于 SillyTavern extensions/regex/engine.js
 */

// 导出类型
export type {
  RegexScript,
  RegexProcessingOptions,
  RegexProviderConfig,
  RegexPipelineConfig,
  StRegexScript,
  StRegexProcessingOptions,
  SourcedRegexScript,
} from './types';

// 导出枚举
export { RegexPlacement, RegexScriptSource } from './types';

// 导出类和实例
export { RegexProvider, createRegexProvider } from './provider';
export { RegexPipeline, createRegexPipeline } from './pipeline';
import { regexProvider } from './provider';
import { regexPipeline } from './pipeline';
export { regexProvider, regexPipeline };

// ── 正则缓存失效广播监听 ──────────────────────────────────
// 监听事件总线的 regex:cache-invalidate 事件，清除已编译的 RegExp 缓存。
// 触发时机：正则脚本被导入/编辑/删除时（regexScriptService / 后端写入后前端刷新）。
// 作用：避免使用过期的编译后 RegExp 对象，确保渲染使用最新模式。
import { onEvent } from '../event-bus';

onEvent('regex:cache-invalidate', () => {
  regexProvider.clear();
});

/**
 * React Hook: useRegexPipeline
 */
export function useRegexPipeline() {
  return {
    pipeline: regexPipeline,
    provider: regexProvider,
    process: regexPipeline.process.bind(regexPipeline),
    addScript: regexPipeline.addScript.bind(regexPipeline),
    removeScript: regexPipeline.removeScript.bind(regexPipeline),
    exportScripts: regexPipeline.exportScripts.bind(regexPipeline),
    importScripts: regexPipeline.importScripts.bind(regexPipeline),
  };
}
