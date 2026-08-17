/**
 * RegexScriptService — 正则脚本解析与导入服务
 * 从 CharacterChat 提取的纯业务逻辑
 */
import { api, invalidateCache } from '@/services/api';
import { emitEvent } from '@/lib/event-bus';

export interface RawRegexScript {
  findRegex?: string;
  find_regex?: string;
  scriptName?: string;
  script_name?: string;
  [key: string]: unknown;
}

export interface RegexImportResult {
  count: number;
}

export class RegexScriptService {
  /**
   * 从 JSON 文件中提取 SillyTavern 正则脚本
   * 支持多种 JSON 结构格式
   */
  static async extractFromFile(file: File): Promise<RawRegexScript[]> {
    const raw = await file.text();
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      throw new Error('无法解析 JSON 文件');
    }

    const candidates = this.parseCandidates(parsed);
    const scripts = this.filterValidScripts(candidates);

    if (scripts.length === 0) {
      throw new Error('文件中没有找到 SillyTavern 正则脚本');
    }

    return scripts;
  }

  /**
   * 根据不同的 JSON 结构解析候选脚本数组
   */
  private static parseCandidates(parsed: unknown): unknown[] {
    if (Array.isArray(parsed)) {
      return parsed;
    }

    const obj = parsed as Record<string, any> | null;
    if (!obj) return [];

    // 标准路径：extensions.regex_scripts
    if (Array.isArray(obj.extensions?.regex_scripts)) {
      return obj.extensions.regex_scripts;
    }

    // 嵌套数据路径：data.extensions.regex_scripts
    if (Array.isArray(obj.data?.extensions?.regex_scripts)) {
      return obj.data.extensions.regex_scripts;
    }

    // 单脚本对象
    if (obj.findRegex || obj.find_regex || obj.scriptName) {
      return [obj];
    }

    return [];
  }

  /**
   * 过滤出有效的正则脚本
   */
  private static filterValidScripts(candidates: unknown[]): RawRegexScript[] {
    return candidates.filter((script): script is RawRegexScript => Boolean(
      script
      && typeof script === 'object'
      && (
        (script as RawRegexScript).findRegex
        || (script as RawRegexScript).find_regex
        || (script as RawRegexScript).scriptName
        || (script as RawRegexScript).script_name
      )
    ));
  }

  /**
   * 将正则脚本导入到指定目标（角色级或预设级）
   */
  static async importToTarget(
    scripts: RawRegexScript[],
    target: 'scoped' | 'preset',
    characterId: string,
    characterName: string,
  ): Promise<RegexImportResult> {
    const result = await api.post('/api/plugins/import/regex-target', {
      scripts,
      target,
      character_id: characterId,
      preset_name: `${characterName || '角色'} 正则脚本`,
    });

    invalidateCache('/api/plugins/active/regex');
    // 广播正则缓存失效，让前端两套 RegexProvider（regex-pipeline + sillytavern/regex）
    // 清除已编译的 RegExp 缓存，确保下次渲染使用最新模式
    emitEvent('regex:cache-invalidate', { reason: 'import' });

    const count = (result as any)?.count || scripts.length;
    return { count };
  }

  /**
   * 获取目标标签文本
   */
  static getTargetLabel(target: 'scoped' | 'preset'): string {
    return target === 'scoped' ? '当前角色' : '当前预设';
  }
}

export default RegexScriptService;
