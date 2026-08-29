export const SCRIPT_TYPES = { GLOBAL: 0, SCOPED: 1, PRESET: 2 };
export const SCRIPT_TYPE_UNKNOWN = -1;

import { regexPipeline } from '../../regex-pipeline';
// 监听正则缓存失效广播，清除本模块 RegexProvider 单例的已编译 RegExp 缓存
import { onEvent } from '../../event-bus';

export class RegexProvider {
  private cache = new Map<string, RegExp>();
  private maxSize = 1000;
  static instance = new RegexProvider();

  get(regexString: string): RegExp | null {
    const cached = this.cache.get(regexString);
    if (cached) {
      this.cache.delete(regexString);
      this.cache.set(regexString, cached);
      if (cached.global || cached.sticky) {
        cached.lastIndex = 0;
      }
      return cached;
    }

    let regex: RegExp | null = null;
    const match = regexString.match(/^\/(.+)\/([gimsuy]*)$/);
    if (match) {
      try {
        regex = new RegExp(match[1], match[2]);
      } catch {
        return null;
      }
    } else {
      try {
        regex = new RegExp(regexString, 'g');
      } catch {
        return null;
      }
    }

    if (regex) {
      this.cache.set(regexString, regex);
      if (this.cache.size > this.maxSize) {
        const firstKey = this.cache.keys().next().value;
        if (firstKey) {
          this.cache.delete(firstKey);
        }
      }
    }
    return regex;
  }

  clear(): void {
    this.cache.clear();
  }
}

// 注册正则缓存失效广播监听（放在 RegexProvider 类定义之后，确保 instance 已初始化）
onEvent('regex:cache-invalidate', () => {
  RegexProvider.instance.clear();
});

export const regex_placement = {
  MD_DISPLAY: 0,
  USER_INPUT: 1,
  AI_OUTPUT: 2,
  SLASH_COMMAND: 3,
  WORLD_INFO: 5,
  REASONING: 6,
  AI_INPUT: 7,
  USER_OUTPUT: 8,
  MODEL_SETTINGS: 9,
};

export const substitute_find_regex = { NONE: 0, RAW: 1, ESCAPED: 2 };

export const REGEX_PLACEMENT = regex_placement;

export interface RegexScript {
  id?: string;
  scriptName?: string;
  findRegex: string;
  replaceString: string;
  trimStrings?: string[];
  placement?: number[];
  markdownOnly?: boolean;
  promptOnly?: boolean;
  minDepth?: number;
  maxDepth?: number;
  substituteRegex?: number;
  disabled?: boolean;
  runOnEdit?: boolean;
  order?: number;
}

function substituteParams(text: string, params?: { userName?: string; characterName?: string; characterOverride?: string }): string {
  const userName = params?.userName || 'User';
  const characterName = params?.characterOverride || params?.characterName || 'Character';
  return String(text || '')
    .replace(/\{\{user\}\}/gi, userName)
    .replace(/\{\{char\}\}/gi, characterName)
    .replace(/\{\{character\}\}/gi, characterName)
    .replace(/\{\{name1\}\}/gi, userName)
    .replace(/\{\{name2\}\}/gi, characterName);
}

function sanitizeRegexMacro(text: string): string {
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

/**
 * ESCAPED（substituteRegex=2）专用：宏替换值逐个做正则转义后再进入模式，
 * findRegex 模式本体不被整串转义。
 * ST 1.18.0 对齐：engine.js:402-403（postProcessFn 仅作用于每个宏替换值，
 * script.js:2756-2758）+ engine.js:304-324 sanitizeRegexMacro 字符集；
 * 后端 character_ext.py:1157-1163 同语义。
 */
function substituteParamsEscaped(text: string, params?: { userName?: string; characterName?: string; characterOverride?: string }): string {
  const userName = sanitizeRegexMacro(params?.userName || 'User');
  const characterName = sanitizeRegexMacro(params?.characterOverride || params?.characterName || 'Character');
  return String(text || '')
    .replace(/\{\{user\}\}/gi, userName)
    .replace(/\{\{char\}\}/gi, characterName)
    .replace(/\{\{character\}\}/gi, characterName)
    .replace(/\{\{name1\}\}/gi, userName)
    .replace(/\{\{name2\}\}/gi, characterName);
}

function filterString(rawString: string, trimStrings: string[]): string {
  let result = rawString;
  for (const trim of trimStrings) {
    if (!trim) continue;
    while (result.includes(trim)) {
      result = result.replace(trim, '');
    }
  }
  return result;
}

const REGEX_ALLOWED_STORAGE_KEY = 'palink-st-regex-allowed';

function loadRegexAllowedStorage(): { characterAllowed: string[]; presetAllowed: Record<string, string[]> } {
  try {
    const raw = localStorage.getItem(REGEX_ALLOWED_STORAGE_KEY);
    if (!raw) return { characterAllowed: [], presetAllowed: {} };
    const parsed = JSON.parse(raw);
    return {
      characterAllowed: Array.isArray(parsed.characterAllowed) ? parsed.characterAllowed : [],
      presetAllowed: parsed.presetAllowed && typeof parsed.presetAllowed === 'object' ? parsed.presetAllowed : {},
    };
  } catch {
    return { characterAllowed: [], presetAllowed: {} };
  }
}

function saveRegexAllowedStorage(data: { characterAllowed: string[]; presetAllowed: Record<string, string[]> }): void {
  try {
    localStorage.setItem(REGEX_ALLOWED_STORAGE_KEY, JSON.stringify(data));
  } catch {
    // ignore
  }
}

export function isScopedScriptsAllowed(characterAvatar: string, allowedList?: string[]): boolean {
  const list = allowedList ?? loadRegexAllowedStorage().characterAllowed;
  return list.includes(characterAvatar);
}

export function allowScopedScripts(characterAvatar: string, allowedList?: string[]): string[] {
  const storage = loadRegexAllowedStorage();
  const list = allowedList ?? storage.characterAllowed;
  if (!list.includes(characterAvatar)) {
    const updated = [...list, characterAvatar];
    saveRegexAllowedStorage({ ...storage, characterAllowed: updated });
    return updated;
  }
  return list;
}

export function disallowScopedScripts(characterAvatar: string, allowedList?: string[]): string[] {
  const storage = loadRegexAllowedStorage();
  const list = allowedList ?? storage.characterAllowed;
  const updated = list.filter((item) => item !== characterAvatar);
  saveRegexAllowedStorage({ ...storage, characterAllowed: updated });
  return updated;
}

export function isPresetScriptsAllowed(apiId: string, presetName: string, allowedMap?: Record<string, string[]>): boolean {
  const map = allowedMap ?? loadRegexAllowedStorage().presetAllowed;
  return !!map[apiId]?.includes(presetName);
}

export function allowPresetScripts(apiId: string, presetName: string, allowedMap?: Record<string, string[]>): Record<string, string[]> {
  const storage = loadRegexAllowedStorage();
  const map = allowedMap ?? storage.presetAllowed;
  const updated: Record<string, string[]> = { ...map };
  if (!updated[apiId]) updated[apiId] = [];
  if (!updated[apiId].includes(presetName)) {
    updated[apiId] = [...updated[apiId], presetName];
    saveRegexAllowedStorage({ ...storage, presetAllowed: updated });
  }
  return updated;
}

export function disallowPresetScripts(apiId: string, presetName: string, allowedMap?: Record<string, string[]>): Record<string, string[]> {
  const storage = loadRegexAllowedStorage();
  const map = allowedMap ?? storage.presetAllowed;
  const updated: Record<string, string[]> = { ...map };
  if (updated[apiId]) {
    updated[apiId] = updated[apiId].filter((n) => n !== presetName);
    saveRegexAllowedStorage({ ...storage, presetAllowed: updated });
  }
  return updated;
}

export function getRegexScripts(
  globalScripts: RegexScript[],
  scopedScripts: RegexScript[],
  presetScripts: RegexScript[],
  options?: { allowedOnly?: boolean; characterAllowed?: string[]; presetAllowed?: boolean; characterAvatar?: string; presetApiId?: string; presetName?: string; }
): RegexScript[] {
  const result: RegexScript[] = [];

  // ST order: GLOBAL(0) -> SCOPED(1) -> PRESET(2)
  if (globalScripts) {
    result.push(...globalScripts.filter((s) => !s.disabled));
  }

  if (scopedScripts) {
    let filtered = scopedScripts.filter((s) => !s.disabled);
    if (options?.allowedOnly && options.characterAvatar) {
      const allowed = options.characterAllowed || loadRegexAllowedStorage().characterAllowed;
      if (!isScopedScriptsAllowed(options.characterAvatar, allowed)) {
        filtered = [];
      }
    }
    result.push(...filtered);
  }

  if (presetScripts && options?.presetAllowed !== false) {
    let filtered = presetScripts.filter((s) => !s.disabled);
    if (options?.allowedOnly && options.presetApiId && options.presetName) {
      if (!isPresetScriptsAllowed(options.presetApiId, options.presetName)) {
        filtered = [];
      }
    }
    result.push(...filtered);
  }

  return result;
}

export function runRegexScript(
  regexScript: RegexScript,
  rawString: string,
  params?: { characterOverride?: string; userName?: string; characterName?: string; }
): string {
  if (!regexScript.findRegex || !rawString) return rawString;
  if (regexScript.disabled) return rawString;

  const substituteMode = regexScript.substituteRegex ?? 0;
  let findRegexSource = regexScript.findRegex;

  if (substituteMode === 2) {
    // A1 修复（ST 1.18.0 engine.js:402-403 ESCAPED 语义）：仅对宏替换值逐个
    // 转义（postProcessFn = sanitizeRegexMacro，script.js:2756-2758），模式本体
    // 不做整串 sanitize；对齐后端 character_ext.py:1157-1163 逐值转义。
    findRegexSource = substituteParamsEscaped(findRegexSource, params);
  } else if (substituteMode === 1) {
    findRegexSource = substituteParams(findRegexSource, params);
  }

  const findRegex = RegexProvider.instance.get(findRegexSource);
  if (!findRegex) return rawString;

  let replaceString = regexScript.replaceString || '';
  // [C-4b] trimStrings 先做 substituteParams 宏替换再参与 trim 判定（对齐后端
  // _filter_trim_strings 与 ST regex-engine.js:460 / regex-pipeline applyStScript
  // 既有修复）：含 {{user}}/{{char}} 的 trim 串在前端同样生效。
  const trimStrings = (regexScript.trimStrings || [])
    .map((trim) => substituteParams(String(trim || ''), params))
    .filter((trim) => trim.length > 0);

  try {
    return rawString.replace(findRegex, function (match: string, ...args: any[]) {
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
        return filterString(captured, trimStrings);
      });

      return substituteParams(result, params);
    });
  } catch {
    return rawString;
  }
}

export function getRegexedString(
  rawString: string,
  placement: number | number[],
  params?: {
    characterOverride?: string;
    isMarkdown?: boolean;
    isPrompt?: boolean;
    isEdit?: boolean;
    depth?: number;
    globalScripts?: RegexScript[];
    scopedScripts?: RegexScript[];
    presetScripts?: RegexScript[];
    allowedOnly?: boolean;
    characterAllowed?: string[];
    characterAvatar?: string;
    presetApiId?: string;
    presetName?: string;
    userName?: string;
    characterName?: string;
  }
): string {
  if (!rawString) return rawString;

  const globalScripts = params?.globalScripts || [];
  const scopedScripts = params?.scopedScripts || [];
  const presetScripts = params?.presetScripts || [];

  const scripts = getRegexScripts(globalScripts, scopedScripts, presetScripts, {
    allowedOnly: params?.allowedOnly,
    characterAllowed: params?.characterAllowed,
    characterAvatar: params?.characterAvatar,
    presetApiId: params?.presetApiId,
    presetName: params?.presetName,
    presetAllowed: true,
  });

  return regexPipeline.processFlatScripts(rawString, scripts, {
    placement,
    isMarkdown: params?.isMarkdown,
    isPrompt: params?.isPrompt,
    depth: params?.depth,
    isEdit: params?.isEdit,
    userName: params?.userName,
    characterName: params?.characterName,
    characterOverride: params?.characterOverride,
  });
}

