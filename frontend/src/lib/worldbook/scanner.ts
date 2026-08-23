/**
 * 世界书关键词扫描器
 * 基于 SillyTavern 1.18.0 world-info.js
 */

import type {
  WorldBookEntry,
  ScanConfig,
  ScanContext,
  ScanResult,
  WorldInfoLogic,
} from './types';

/**
 * 解析条目内容中的装饰器（ST 兼容）。
 * 支持 @@activate、@@dont_activate、@@include 语法。
 * - @@activate：强制激活该条目（跳过关键词匹配）
 * - @@dont_activate：强制跳过该条目
 * - @@include <text>：标记要包含的内容（暂存，供调用方按需使用）
 */
export function parseDecorators(content: string): {
  activate: boolean;
  dontActivate: boolean;
  include: string | null;
} {
  const result = {
    activate: false,
    dontActivate: false,
    include: null as string | null,
  };

  if (!content) return result;

  for (const line of content.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed.startsWith('@@')) continue;
    if (trimmed === '@@activate') {
      result.activate = true;
    } else if (trimmed === '@@dont_activate') {
      result.dontActivate = true;
    } else if (trimmed.startsWith('@@include ')) {
      result.include = trimmed.slice('@@include '.length).trim();
    }
  }

  return result;
}

/**
 * 默认扫描配置
 */
const DEFAULT_SCAN_CONFIG: ScanConfig = {
  scanDepth: 4,
  caseSensitive: false,
  matchWholeWords: false,
  useGroupScoring: false,
  maxRecursionDepth: 5,
  minActivations: 0,
  budgetCap: 16000,
};

/**
 * SubTask 9.2: 检测浏览器是否支持 regex lookbehind
 * 旧版 Safari (< 16.4) 不支持 lookbehind，需要 fallback
 */
const supportsLookbehind: boolean = (() => {
  try {
    new RegExp('(?<=a)b');
    return true;
  } catch {
    return false;
  }
})();

/**
 * 关键词扫描器
 */
export class WorldBookScanner {
  private config: ScanConfig;

  constructor(config?: Partial<ScanConfig>) {
    this.config = { ...DEFAULT_SCAN_CONFIG, ...config };
  }

  /**
   * 扫描世界书条目
   */
  scan(
    entries: WorldBookEntry[],
    context: ScanContext,
    scanState: number = 1,
  ): ScanResult {
    const activated: WorldBookEntry[] = [];
    const matchedKeywords = new Map<string, string[]>();

    // 过滤禁用的条目
    const enabledEntries = entries.filter(e => e.enabled !== false);

    for (const entry of enabledEntries) {
      // Feature: characterFilter - 按角色 names/tags 过滤
      if (entry.characterFilter && entry.characterFilter.length > 0) {
        const charName = context.characterName ?? '';
        const charTags = context.characterTags ?? [];
        const nameMatch = charName !== '' && entry.characterFilter.includes(charName);
        const tagMatch = charTags.some(tag => entry.characterFilter!.includes(tag));
        if (!nameMatch && !tagMatch) {
          continue;
        }
      }

      // Feature: decorators - 解析内容中的 @@activate / @@dont_activate
      const decorators = parseDecorators(entry.content || '');
      if (decorators.dontActivate) {
        continue;
      }
      if (decorators.activate) {
        activated.push(entry);
        matchedKeywords.set(entry.id, ['(@@activate)']);
        continue;
      }

      // 检查常驻条目
      if (entry.constant) {
        activated.push(entry);
        matchedKeywords.set(entry.id, ['(constant)']);
        continue;
      }

      // 关键词匹配（D-8 修复：ST world-info.js:4800-4866 权威流程）
      // 主键 plain 匹配；logic 只作用于副键层；主键命中 + 无有效副键 = 直接激活
      if (entry.key.length > 0) {
        const match = this.evaluateEntryMatch(entry, context);
        if (match) {
          activated.push(entry);
          matchedKeywords.set(entry.id, match);
        }
      }
    }

    // 按优先级排序
    activated.sort((a, b) => (a.order ?? 0) - (b.order ?? 0));

    return {
      entries: activated,
      totalTokens: this.estimateTokens(activated),
      matchedKeywords,
    };
  }

  /**
   * 条目级匹配判定（D-8 修复，2026-08-23）。
   *
   * ST 权威流程（world-info.js:4800-4866）：
   * 1. 主关键词 plain 匹配（任一命中即推进，logic 不参与）；
   * 2. 主键未命中 → 条目不激活；
   * 3. 无有效副键（非 selective 或 keysecondary 为空）→ 主键命中即激活；
   * 4. selectiveLogic 四态只作用于副键匹配结果：
   *    AND_ANY(0) 任一副键命中 / NOT_ALL(1) 存在未命中的副键 /
   *    NOT_ANY(2) 全部副键未命中 / AND_ALL(3) 全部副键命中。
   *
   * 旧实现把 logic 错位作用于主键（NOT_ANY 在主键命中时恒拒绝 = 条目永不激活），
   * 且副键硬编码 ANY——与 ST 语义完全相反。
   *
   * @returns 激活时的匹配关键词列表（主 + 副），未激活返回 null
   */
  private evaluateEntryMatch(
    entry: WorldBookEntry,
    context: ScanContext,
  ): string[] | null {
    const haystack = this.getHaystack(entry, context);

    // PRIMARY KEYWORDS — plain any-match（ST :4801-4809）
    const primaryMatches: string[] = [];
    for (const key of entry.key) {
      if (this.matchKey(haystack, key, entry)) {
        primaryMatches.push(key);
      }
    }
    if (primaryMatches.length === 0) return null;

    // SECONDARY KEYWORDS（ST :4811-4822）
    const hasSecondaryKeywords =
      entry.selective === true && entry.keysecondary.length > 0;
    if (!hasSecondaryKeywords) {
      return primaryMatches;
    }

    const secondaryMatches: string[] = [];
    for (const key of entry.keysecondary) {
      if (this.matchKey(haystack, key, entry)) {
        secondaryMatches.push(key);
      }
    }

    const logic = entry.selectiveLogic as WorldInfoLogic;
    switch (logic) {
      case 1: // NOT_ALL - 任一副键不匹配即激活（ST :4846-4849）
        return secondaryMatches.length < entry.keysecondary.length
          ? [...primaryMatches, ...secondaryMatches]
          : null;
      case 2: // NOT_ANY - 全部副键未命中才激活（ST :4853+）
        return secondaryMatches.length === 0
          ? primaryMatches
          : null;
      case 3: // AND_ALL - 全部副键命中才激活
        return secondaryMatches.length === entry.keysecondary.length
          ? [...primaryMatches, ...secondaryMatches]
          : null;
      case 0: // AND_ANY - 任一副键命中即激活（ST :4842-4845）
      default:
        return secondaryMatches.length > 0
          ? [...primaryMatches, ...secondaryMatches]
          : null;
    }
  }

  /**
   * 获取匹配的文本
   */
  private getHaystack(entry: WorldBookEntry, context: ScanContext): string {
    const parts: string[] = [];

    // 最近的消息
    const depth = entry.scanDepth ?? this.config.scanDepth;
    const recentMessages = context.messages.slice(-depth);
    parts.push(...recentMessages);

    // 角色描述
    if (entry.matchCharacterDescription && context.characterDescription) {
      parts.push(context.characterDescription);
    }

    // 角色性格
    if (entry.matchCharacterPersonality && context.characterPersonality) {
      parts.push(context.characterPersonality);
    }

    // 角色深度提示
    if (entry.matchCharacterDepthPrompt && context.characterDepthPrompt) {
      parts.push(context.characterDepthPrompt);
    }

    // 场景
    if (entry.matchScenario && context.scenario) {
      parts.push(context.scenario);
    }

    // 创作者注释
    if (entry.matchCreatorNotes && context.creatorNotes) {
      parts.push(context.creatorNotes);
    }

    // 用户人设
    if (entry.matchPersonaDescription && context.personaDescription) {
      parts.push(context.personaDescription);
    }

    return parts.join('\n');
  }

  /**
   * 匹配单个关键词
   */
  private matchKey(haystack: string, needle: string, entry: WorldBookEntry): boolean {
    if (!needle || !haystack) return false;

    let text = haystack;
    let key = needle;

    // 大小写处理
    if (!entry.caseSensitive && !this.config.caseSensitive) {
      text = text.toLowerCase();
      key = key.toLowerCase();
    }

    // 全词匹配
    if (entry.matchWholeWords || this.config.matchWholeWords) {
      const escapedKey = this.escapeRegex(key);

      // SubTask 9.2: 检查是否为 ASCII 关键词
      const isAscii = /^[\x00-\x7F]+$/.test(key);

      if (isAscii) {
        // ASCII 关键词使用 \b 边界
        const regex = new RegExp(`\\b${escapedKey}\\b`, 'i');
        return regex.test(text);
      }

      // SubTask 9.2: 非 ASCII 关键词（如中文）使用 Unicode 属性边界
      // 支持 lookbehind 时使用零宽断言，不支持时使用 fallback
      if (supportsLookbehind) {
        // 零宽断言：不消耗边界字符
        const regex = new RegExp(`(?<![\\p{L}\\p{N}])${escapedKey}(?![\\p{L}\\p{N}])`, 'u');
        return regex.test(text);
      } else {
        // Fallback：非捕获组会消耗边界字符，但对 regex.test() 的布尔结果无影响
        const regex = new RegExp(`(?:^|[^\\p{L}\\p{N}])${escapedKey}(?:$|[^\\p{L}\\p{N}])`, 'u');
        return regex.test(text);
      }
    }

    // 普通包含匹配
    return text.includes(key);
  }

  /**
   * 转义正则特殊字符
   */
  private escapeRegex(str: string): string {
    return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }

  /**
   * 估算token数
   */
  private estimateTokens(entries: WorldBookEntry[]): number {
    let total = 0;
    for (const entry of entries) {
      // 粗略估算：1个中文字符约2个token，1个英文单词约1个token
      const content = entry.content || '';
      const chineseChars = (content.match(/[\u4e00-\u9fff]/g) || []).length;
      const englishWords = (content.match(/[a-zA-Z]+/g) || []).length;
      total += chineseChars * 2 + englishWords;
    }
    return total;
  }

  /**
   * 更新配置
   */
  updateConfig(config: Partial<ScanConfig>): void {
    this.config = { ...this.config, ...config };
  }

  /**
   * 获取配置
   */
  getConfig(): ScanConfig {
    return { ...this.config };
  }
}

/**
 * 创建扫描器实例
 */
export function createScanner(config?: Partial<ScanConfig>): WorldBookScanner {
  return new WorldBookScanner(config);
}
