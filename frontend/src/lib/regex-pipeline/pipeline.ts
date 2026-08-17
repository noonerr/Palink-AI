/**
 * Regex Pipeline - 正则管道引擎
 * 基于 SillyTavern extensions/regex/engine.js
 */

import type {
  RegexScript,
  RegexProcessingOptions,
  RegexPipelineConfig,
  StRegexScript,
  StRegexProcessingOptions,
  SourcedRegexScript,
} from './types';
import { RegexPlacement, RegexScriptSource } from './types';
import { regexProvider } from './provider';
import { emitEvent } from '../event-bus';

// ============================================================
// 默认配置
// ============================================================

const DEFAULT_CONFIG: RegexPipelineConfig = {
  enableCache: true,
  maxCacheSize: 100,
  enableLogging: false,
};

// ============================================================
// ST 兼容辅助函数（迁移自 sillytavern/regex/engine.ts）
// ============================================================

function stSubstituteParams(text: string, params?: { userName?: string; characterName?: string; characterOverride?: string }): string {
  const userName = params?.userName || 'User';
  const characterName = params?.characterOverride || params?.characterName || 'Character';
  return String(text || '')
    .replace(/\{\{user\}\}/gi, userName)
    .replace(/\{\{char\}\}/gi, characterName)
    .replace(/\{\{character\}\}/gi, characterName)
    .replace(/\{\{name1\}\}/gi, userName)
    .replace(/\{\{name2\}\}/gi, characterName);
}

function stSanitizeRegexMacro(text: string): string {
  return String(text || '').replace(/[\n\r\t\v\f\0.^$*+?{}[\]\\/|()]/g, (char) => {
    switch (char) {
      case '\n': return '\\n';
      case '\r': return '\\r';
      case '\t': return '\\t';
      case '\v': return '\\v';
      case '\f': return '\\f';
      case '\0': return '\\0';
      default: return `\\${char}`;
    }
  });
}

function stFilterString(rawString: string, trimStrings: string[]): string {
  let result = rawString;
  for (const trim of trimStrings) {
    if (!trim) continue;
    while (result.includes(trim)) {
      result = result.replace(trim, '');
    }
  }
  return result;
}

function stParseRegex(regexString: string): RegExp | null {
  const match = regexString.match(/^\/(.+)\/([gimsuy]*)$/);
  if (match) {
    try {
      return new RegExp(match[1], match[2]);
    } catch {
      return null;
    }
  }
  try {
    return new RegExp(regexString, 'g');
  } catch {
    return null;
  }
}

// ============================================================
// RegexPipeline 类
// ============================================================

export class RegexPipeline {
  private scripts: Map<string, RegexScript> = new Map();
  private config: RegexPipelineConfig;

  constructor(config?: Partial<RegexPipelineConfig>) {
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  /**
   * 添加正则脚本
   */
  addScript(script: RegexScript): void {
    const id = script.id || script.scriptName;
    this.scripts.set(id, script);
    emitEvent('regex:added', { scriptName: script.scriptName });
  }

  /**
   * 移除正则脚本
   */
  removeScript(nameOrId: string): boolean {
    const script = this.scripts.get(nameOrId);
    if (script) {
      this.scripts.delete(nameOrId);
      emitEvent('regex:removed', { scriptName: script.scriptName });
      return true;
    }
    return false;
  }

  /**
   * 获取正则脚本
   */
  getScript(nameOrId: string): RegexScript | undefined {
    return this.scripts.get(nameOrId);
  }

  /**
   * 获取所有正则脚本
   */
  getAllScripts(): RegexScript[] {
    return Array.from(this.scripts.values());
  }

  /**
   * 启用/禁用脚本
   */
  toggleScript(nameOrId: string, disabled?: boolean): boolean {
    const script = this.scripts.get(nameOrId);
    if (script) {
      script.disabled = disabled ?? !script.disabled;
      return true;
    }
    return false;
  }

  /**
   * 处理文本
   */
  process(input: string, options: RegexProcessingOptions): string {
    if (!input) return input;

    let result = input;
    const scripts = this.getScriptsForPlacement(options.placement);

    for (const script of scripts) {
      if (this.shouldSkipScript(script, options)) {
        continue;
      }

      result = this.applyScript(result, script, options);
    }

    return result;
  }

  /**
   * ST 兼容：处理带来源标签的外部脚本
   * 执行顺序：GLOBAL → SCOPED → PRESET
   * 权限过滤由调用方（sillytavern/regex/engine.ts）完成
   */
  processScripts(
    input: string,
    sourcedScripts: SourcedRegexScript[],
    options: StRegexProcessingOptions,
  ): string {
    if (!input) return input;

    const ordered = this.orderScriptsBySource(sourcedScripts);

    let result = input;
    for (const { script } of ordered) {
      if (this.shouldSkipStScript(script, options)) {
        continue;
      }
      result = this.applyStScript(result, script, options);
    }

    return result;
  }

  /**
   * ST 兼容：处理扁平脚本列表（已按来源排序）
   */
  processFlatScripts(
    input: string,
    scripts: StRegexScript[],
    options: StRegexProcessingOptions,
  ): string {
    if (!input) return input;

    let result = input;
    for (const script of scripts) {
      if (this.shouldSkipStScript(script, options)) {
        continue;
      }
      result = this.applyStScript(result, script, options);
    }

    return result;
  }

  /**
   * 按来源排序：GLOBAL → SCOPED → PRESET，同来源内按 order 字段排序
   */
  private orderScriptsBySource(sourcedScripts: SourcedRegexScript[]): SourcedRegexScript[] {
    const buckets: Record<number, SourcedRegexScript[]> = {
      [RegexScriptSource.GLOBAL]: [],
      [RegexScriptSource.SCOPED]: [],
      [RegexScriptSource.PRESET]: [],
    };

    for (const item of sourcedScripts) {
      const bucket = buckets[item.source];
      if (bucket) bucket.push(item);
    }

    const sortFn = (a: SourcedRegexScript, b: SourcedRegexScript) =>
      (a.script.order ?? 0) - (b.script.order ?? 0);

    return [
      ...buckets[RegexScriptSource.GLOBAL].sort(sortFn),
      ...buckets[RegexScriptSource.SCOPED].sort(sortFn),
      ...buckets[RegexScriptSource.PRESET].sort(sortFn),
    ];
  }

  /**
   * ST 兼容：检查是否应该跳过脚本
   */
  private shouldSkipStScript(script: StRegexScript, options: StRegexProcessingOptions): boolean {
    if (script.disabled) return true;

    if (script.placement && Array.isArray(script.placement) && script.placement.length > 0) {
      const matched = Array.isArray(options.placement)
        ? options.placement.some((p) => script.placement!.includes(p))
        : script.placement.includes(options.placement);
      if (!matched) return true;
    }

    if (script.markdownOnly && !options.isMarkdown) return true;
    if (script.promptOnly && !options.isPrompt) return true;

    if (typeof options.depth === 'number') {
      if (typeof script.minDepth === 'number' && options.depth < script.minDepth) return true;
      if (typeof script.maxDepth === 'number' && options.depth > script.maxDepth) return true;
    }

    if (options.isEdit && !script.runOnEdit) return true;

    return false;
  }

  /**
   * ST 兼容：应用单个脚本（迁移自 engine.ts runRegexScript）
   */
  private applyStScript(
    input: string,
    script: StRegexScript,
    options: StRegexProcessingOptions,
  ): string {
    if (!script.findRegex || !input) return input;

    const params = {
      characterOverride: options.characterOverride,
      userName: options.userName,
      characterName: options.characterName,
    };

    const substituteMode = script.substituteRegex ?? 0;
    let findRegexSource = script.findRegex;

    if (substituteMode === 2) {
      findRegexSource = stSubstituteParams(findRegexSource, params);
      findRegexSource = stSanitizeRegexMacro(findRegexSource);
    } else if (substituteMode === 1) {
      findRegexSource = stSubstituteParams(findRegexSource, params);
    }

    const findRegex = stParseRegex(findRegexSource);
    if (!findRegex) return input;

    const replaceString = script.replaceString || '';
    const trimStrings = script.trimStrings || [];

    try {
      return input.replace(findRegex, function (match: string, ...args: any[]) {
        const groups = args[args.length - 1];
        const fullArgs = [match, ...args];

        let result = replaceString.replace(/\{\{match\}\}/gi, '$0');

        result = result.replace(/\$(\d+)|\$<([^>]+)>/g, (_: string, num: string, groupName: string) => {
          let captured: string | undefined;
          if (num) {
            captured = fullArgs[Number(num)];
          } else if (groupName && groups && typeof groups === 'object') {
            captured = groups[groupName];
          }
          if (captured === undefined || captured === null) return '';
          return stFilterString(captured, trimStrings);
        });

        return stSubstituteParams(result, params);
      });
    } catch {
      return input;
    }
  }

  /**
   * 获取适用于指定位置的脚本
   */
  private getScriptsForPlacement(placement: RegexPlacement): RegexScript[] {
    return Array.from(this.scripts.values()).filter(script => {
      if (script.disabled) return false;
      if (script.placement.includes(RegexPlacement.ALL)) return true;
      return script.placement.includes(placement);
    });
  }

  /**
   * 检查是否应该跳过脚本
   */
  private shouldSkipScript(script: RegexScript, options: RegexProcessingOptions): boolean {
    // 检查markdownOnly
    if (script.markdownOnly && !options.isMarkdown) {
      return true;
    }

    // 检查promptOnly
    if (script.promptOnly && !options.isPrompt) {
      return true;
    }

    // 检查runOnEdit
    if (script.runOnEdit && !options.isEdit) {
      return true;
    }

    // 检查深度范围
    if (options.depth !== undefined) {
      if (script.minDepth !== null && script.minDepth !== undefined && options.depth < script.minDepth) {
        return true;
      }
      if (script.maxDepth !== null && script.maxDepth !== undefined && options.depth > script.maxDepth) {
        return true;
      }
    }

    return false;
  }

  /**
   * 应用单个脚本
   */
  private applyScript(input: string, script: RegexScript, options: RegexProcessingOptions): string {
    try {
      // 获取正则表达式
      const flags = this.getFlagsForScript(script);
      const regex = regexProvider.get(script.findRegex, flags);
      
      if (!regex) {
        return input;
      }

      // 执行替换
      let result = input;
      
      // 处理trimStrings
      if (script.trimStrings && script.trimStrings.length > 0) {
        for (const trimStr of script.trimStrings) {
          result = result.replace(new RegExp(trimStr, 'g'), '');
        }
      }

      // 处理替换
      if (script.substituteRegex === 1) {
        // 使用替换字符串中的捕获组引用
        result = result.replace(regex, script.replaceString);
      } else {
        // 简单替换
        result = result.replace(regex, () => script.replaceString);
      }

      return result;
    } catch (error) {
      if (this.config.enableLogging) {
        console.error(`[RegexPipeline] Error applying script "${script.scriptName}":`, error);
      }
      return input;
    }
  }

  /**
   * 获取脚本的正则标志
   */
  private getFlagsForScript(script: RegexScript): string {
    let flags = 'g';
    
    // 从正则表达式中提取标志
    const regexMatch = script.findRegex.match(/^\/(.+)\/([gimsuy]*)$/);
    if (regexMatch) {
      flags = regexMatch[2] || 'g';
    }

    return flags;
  }

  /**
   * 清除缓存
   */
  clearCache(): void {
    regexProvider.clear();
  }

  /**
   * 导出脚本
   */
  exportScripts(): string {
    const scripts = Array.from(this.scripts.values());
    return JSON.stringify(scripts, null, 2);
  }

  /**
   * 导入脚本
   */
  importScripts(json: string): number {
    try {
      const scripts = JSON.parse(json) as RegexScript[];
      if (!Array.isArray(scripts)) {
        throw new Error('Invalid format: expected array');
      }

      let imported = 0;
      for (const script of scripts) {
        if (script.scriptName && script.findRegex) {
          this.addScript(script);
          imported++;
        }
      }

      emitEvent('regex:imported', { count: imported });
      return imported;
    } catch (error) {
      console.error('[RegexPipeline] Import failed:', error);
      return 0;
    }
  }

  /**
   * 更新配置
   */
  updateConfig(config: Partial<RegexPipelineConfig>): void {
    this.config = { ...this.config, ...config };
  }

  /**
   * 获取配置
   */
  getConfig(): RegexPipelineConfig {
    return { ...this.config };
  }

  /**
   * 重置
   */
  reset(): void {
    this.scripts.clear();
    this.clearCache();
  }
}

/**
 * 创建正则管道实例
 */
export function createRegexPipeline(config?: Partial<RegexPipelineConfig>): RegexPipeline {
  return new RegexPipeline(config);
}

// 导出单例
export const regexPipeline = new RegexPipeline();
