import {
  getRegexedString,
  type RegexScript,
} from './engine';

function normalizeBoolean(value: unknown): boolean {
  if (typeof value === 'boolean') return value;
  if (typeof value === 'number') return value !== 0;
  if (typeof value === 'string') {
    const normalized = value.trim().toLowerCase();
    if (['true', '1', 'yes', 'on'].includes(normalized)) return true;
    if (['false', '0', 'no', 'off'].includes(normalized)) return false;
  }
  return false;
}

function normalizePlacementList(value: unknown): number[] {
  if (typeof value === 'string') {
    try {
      return normalizePlacementList(JSON.parse(value));
    } catch {
      const parsed = Number(value);
      return Number.isFinite(parsed) ? [parsed] : [];
    }
  }
  if (Array.isArray(value)) {
    return value.map((item) => Number(item)).filter((item) => Number.isFinite(item));
  }
  if (typeof value === 'number' && Number.isFinite(value)) return [value];
  return [];
}

function normalizeTrimStrings(value: unknown): string[] {
  if (Array.isArray(value)) return value.filter((item): item is string => typeof item === 'string' && item.length > 0);
  if (typeof value === 'string') {
    try {
      const parsed = JSON.parse(value);
      if (Array.isArray(parsed)) return normalizeTrimStrings(parsed);
    } catch {
      return value ? [value] : [];
    }
  }
  return [];
}

function extractRegexScriptsFromExtensions(extensions: unknown): any[] {
  if (!extensions || typeof extensions !== 'object') return [];
  const source = extensions as Record<string, unknown>;
  const scripts = source.regex_scripts;
  if (Array.isArray(scripts)) return scripts;
  const nestedExtensions = source.extensions;
  if (nestedExtensions && typeof nestedExtensions === 'object') {
    const nestedScripts = (nestedExtensions as Record<string, unknown>).regex_scripts;
    if (Array.isArray(nestedScripts)) return nestedScripts;
  }
  const nestedData = source.data;
  if (nestedData && typeof nestedData === 'object') {
    const dataScripts = extractRegexScriptsFromExtensions(nestedData);
    if (dataScripts.length > 0) return dataScripts;
  }
  const prompts = source.prompts;
  if (Array.isArray(prompts)) {
    return prompts.flatMap((prompt) => (
      prompt && typeof prompt === 'object'
        ? extractRegexScriptsFromExtensions((prompt as Record<string, unknown>).extensions)
        : []
    ));
  }
  return [];
}

export const normalizeRegexScriptList = convertPalinkRegexToSt;

export function convertPalinkRegexToSt(scripts: unknown): RegexScript[] {
  // Support extensions objects (e.g. character.extensions, preset_data) by
  // extracting the regex_scripts array first. Without this, callers that pass
  // the raw extensions object would silently get [] back, dropping all
  // scoped/preset regex scripts (the root cause of HTML card rendering bugs).
  if (scripts && typeof scripts === 'object' && !Array.isArray(scripts)) {
    scripts = extractRegexScriptsFromExtensions(scripts);
  }
  if (!Array.isArray(scripts)) return [];
  return scripts.filter((s) => s && typeof s === 'object').map((s) => {
    const disabled = s.disabled === true || s.enabled === false;
    const substituteRegex = typeof s.substituteRegex === 'number'
      ? s.substituteRegex
      : typeof s.substitute_regex === 'number'
        ? s.substitute_regex
        : typeof s.substituteRegex === 'boolean'
          ? (s.substituteRegex ? 1 : 0)
          : typeof s.substitute_regex === 'boolean'
            ? (s.substitute_regex ? 1 : 0)
            : 0;

    return {
      id: s.id,
      scriptName: s.scriptName || s.script_name || s.scriptName,
      findRegex: s.findRegex || s.find_regex || '',
      replaceString: s.replaceString || s.replace_string || '',
      trimStrings: normalizeTrimStrings(s.trimStrings ?? s.trim_strings),
      placement: normalizePlacementList(s.placement),
      markdownOnly: normalizeBoolean(s.markdownOnly ?? s.markdown_only),
      promptOnly: normalizeBoolean(s.promptOnly ?? s.prompt_only),
      minDepth: typeof s.minDepth === 'number' ? s.minDepth : typeof s.min_depth === 'number' ? s.min_depth : undefined,
      maxDepth: typeof s.maxDepth === 'number' ? s.maxDepth : typeof s.max_depth === 'number' ? s.max_depth : undefined,
      substituteRegex,
      disabled,
      runOnEdit: normalizeBoolean(s.runOnEdit),
    };
  });
}

export function getRegexedStringForMessage(
  content: string,
  placement: number,
  options: {
    characterName?: string;
    userName?: string;
    characterAvatar?: string;
    characterExtensions?: Record<string, unknown> | null;
    characterPresetData?: Record<string, unknown> | null;
    globalRegexScripts?: any[];
    characterAllowed?: string[];
    allowedOnly?: boolean;
    depth?: number;
    isMarkdown?: boolean;
    isPrompt?: boolean;
    isEdit?: boolean;
  } = {},
): string {
  const globalScripts = convertPalinkRegexToSt(options.globalRegexScripts || []);

  const scopedSource = options.characterExtensions;
  let scopedScripts: RegexScript[] = [];
  if (scopedSource) {
    if (Array.isArray(scopedSource)) {
      scopedScripts = convertPalinkRegexToSt(scopedSource);
    } else {
      const extracted = extractRegexScriptsFromExtensions(scopedSource);
      scopedScripts = convertPalinkRegexToSt(extracted);
    }
  }

  const presetSource = options.characterPresetData;
  let presetScripts: RegexScript[] = [];
  if (presetSource) {
    if (Array.isArray(presetSource)) {
      presetScripts = convertPalinkRegexToSt(presetSource);
    } else {
      const extracted = extractRegexScriptsFromExtensions(presetSource);
      presetScripts = convertPalinkRegexToSt(extracted);
    }
  }

  return getRegexedString(content, placement, {
    globalScripts,
    scopedScripts,
    presetScripts,
    characterOverride: options.characterName,
    userName: options.userName,
    characterAvatar: options.characterAvatar,
    characterAllowed: options.characterAllowed,
    allowedOnly: options.allowedOnly,
    depth: options.depth,
    isMarkdown: options.isMarkdown,
    isPrompt: options.isPrompt,
    isEdit: options.isEdit,
  });
}
