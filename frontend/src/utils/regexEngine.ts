const MAX_REGEX_SCRIPTS = 30;
const MAX_REPLACE_LEN = 200000;
const REGEX_CACHE_LIMIT = 80;
export const REGEX_PLACEMENT = {
    MD_DISPLAY: 0,
    USER_INPUT: 1,
    AI_OUTPUT: 2,
    SLASH_COMMAND: 3,
    WORLD_INFO: 5,
    REASONING: 6,
    AI_INPUT: 7,
    USER_OUTPUT: 8,
    MODEL_SETTINGS: 9,
} as const;
const regexResultCache = new Map<string, string>();
const extensionFingerprints = new WeakMap<object, string>();

export interface RegexScript {
    id?: string;
    plugin_name?: string;
    script_name?: string;
    scriptName?: string;
    findRegex?: string;
    find_regex?: string;
    replaceString?: string;
    replace_string?: string;
    trimStrings?: string[];
    trim_strings?: string[] | string;
    placement?: number[] | number | string;
    markdown_only?: boolean;
    prompt_only?: boolean;
    min_depth?: number;
    max_depth?: number;
    substituteRegex?: number;
    substitute_regex?: number | boolean;
    disabled?: boolean | null;
    enabled?: boolean | null;
    markdownOnly?: boolean;
    promptOnly?: boolean;
    runOnEdit?: boolean;
    minDepth?: number;
    maxDepth?: number;
    order?: number;
}

interface ApplyRegexOptions {
    placement?: number;
    isMarkdown?: boolean;
    isPrompt?: boolean;
    ephemeral?: 'display' | 'prompt' | 'persist' | 'all';
    depth?: number;
    isEdit?: boolean;
    userName?: string;
    characterName?: string;
    characterOverride?: string;
}

function normalizeRegexScripts(extensions: unknown): RegexScript[] {
    let parsed = extensions;
    if (typeof parsed === 'string') {
        try {
            parsed = JSON.parse(parsed);
        } catch {
            return [];
        }
    }
    if (!parsed || typeof parsed !== 'object') return [];
    const source = parsed as Record<string, unknown>;
    const scripts = source.regex_scripts;
    if (Array.isArray(scripts)) return scripts as RegexScript[];
    const nestedExtensions = source.extensions;
    if (nestedExtensions && typeof nestedExtensions === 'object') {
        const nestedScripts = (nestedExtensions as Record<string, unknown>).regex_scripts;
        if (Array.isArray(nestedScripts)) return nestedScripts as RegexScript[];
    }
    const nestedData = source.data;
    if (nestedData && typeof nestedData === 'object') {
        const dataScripts = normalizeRegexScripts(nestedData);
        if (dataScripts.length > 0) return dataScripts;
    }
    const prompts = source.prompts;
    if (Array.isArray(prompts)) {
        return prompts.flatMap((prompt) => (
            prompt && typeof prompt === 'object'
                ? normalizeRegexScripts((prompt as Record<string, unknown>).extensions)
                : []
        ));
    }
    return [];
}

export function normalizeRegexScriptList(source: unknown): RegexScript[] {
    if (!source) return [];
    if (Array.isArray(source)) return source.filter((script): script is RegexScript => Boolean(script && typeof script === 'object'));
    const scripts = normalizeRegexScripts(source);
    return scripts;
}

function hashString(value: string): string {
    let hash = 2166136261;
    for (let i = 0; i < value.length; i += 1) {
        hash ^= value.charCodeAt(i);
        hash = Math.imul(hash, 16777619);
    }
    return (hash >>> 0).toString(36);
}

function getExtensionsFingerprint(extensions: unknown, scripts: RegexScript[]): string {
    if (typeof extensions === 'string') {
        return `s:${extensions.length}:${hashString(extensions)}`;
    }
    if (extensions && typeof extensions === 'object') {
        const cached = extensionFingerprints.get(extensions);
        if (cached) return cached;
        const fingerprint = scripts.map((script) => [
            script.scriptName || script.script_name || '',
            script.findRegex || script.find_regex || '',
            String((script.replaceString ?? script.replace_string)?.length || 0),
            Array.isArray(script.placement) ? script.placement.join(',') : String(script.placement ?? ''),
            script.disabled === true ? 'd' : '',
            script.enabled === false ? 'x' : '',
            (script.markdownOnly ?? script.markdown_only) ? 'm' : '',
            (script.promptOnly ?? script.prompt_only) ? 'p' : '',
            script.minDepth ?? script.min_depth ?? '',
            script.maxDepth ?? script.max_depth ?? '',
            script.order ?? '',
        ].join(':')).join('|');
        const key = `o:${scripts.length}:${hashString(fingerprint)}`;
        extensionFingerprints.set(extensions, key);
        return key;
    }
    return 'none';
}

function getCachedRegexResult(key: string): string | undefined {
    const cached = regexResultCache.get(key);
    if (cached === undefined) return undefined;
    regexResultCache.delete(key);
    regexResultCache.set(key, cached);
    return cached;
}

function setCachedRegexResult(key: string, value: string) {
    regexResultCache.set(key, value);
    if (regexResultCache.size > REGEX_CACHE_LIMIT) {
        const firstKey = regexResultCache.keys().next().value;
        if (firstKey) regexResultCache.delete(firstKey);
    }
}

function regexFromString(regexString: string): RegExp | null {
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

function normalizeBoolean(value: unknown, fallback = false): boolean {
    if (typeof value === 'boolean') return value;
    if (typeof value === 'number') return value !== 0;
    if (typeof value === 'string') {
        const normalized = value.trim().toLowerCase();
        if (['true', '1', 'yes', 'on'].includes(normalized)) return true;
        if (['false', '0', 'no', 'off'].includes(normalized)) return false;
    }
    return fallback;
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
        return value
            .map((item) => Number(item))
            .filter((item) => Number.isFinite(item));
    }
    if (typeof value === 'number' && Number.isFinite(value)) return [value];
    return [];
}

function normalizePlacementListForSillyTavern(value: unknown): number[] {
    return normalizePlacementList(value);
}

function normalizeDepth(value: unknown): number | null {
    if (value === undefined || value === null || value === '') return null;
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
}

function pickString(...values: unknown[]): string {
    for (const value of values) {
        if (typeof value === 'string') return value;
    }
    return '';
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

function substituteParams(text: string, options: ApplyRegexOptions): string {
    const userName = options.userName || 'User';
    const characterName = options.characterOverride || options.characterName || 'Character';
    return String(text || '')
        .replace(/\{\{user\}\}/gi, userName)
        .replace(/\{\{char\}\}/gi, characterName)
        .replace(/\{\{character\}\}/gi, characterName)
        .replace(/\{\{name1\}\}/gi, userName)
        .replace(/\{\{name2\}\}/gi, characterName);
}

function escapeRegexMacro(text: string): string {
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

function filterTrimStrings(rawString: string, trimStrings: string[]): string {
    let result = rawString;
    for (const trim of trimStrings) {
        if (!trim) continue;
        while (result.includes(trim)) {
            result = result.replace(trim, '');
        }
    }
    return result;
}

function normalizeTrimStringsForContext(value: unknown, options: ApplyRegexOptions): string[] {
    return normalizeTrimStrings(value)
        .map((trim) => substituteParams(trim, options))
        .filter((trim) => trim.length > 0);
}

export function runRegexScript(script: RegexScript, text: string, options: ApplyRegexOptions = {}): string {
    const rawFindRegex = pickString(script.findRegex, script.find_regex);
    if (!rawFindRegex || !text) return text;
    if (normalizeBoolean(script.disabled, false)) return text;

    const substituteRegex = script.substituteRegex ?? script.substitute_regex ?? 0;
    const substituteMode = typeof substituteRegex === 'boolean' ? (substituteRegex ? 1 : 0) : Number(substituteRegex);
    const findRegexSource = substituteMode === 2
        ? rawFindRegex.replace(/\{\{(?:user|char|character|name1|name2)\}\}/gi, (match) => escapeRegexMacro(substituteParams(match, options)))
        : substituteMode === 1
            ? substituteParams(rawFindRegex, options)
            : rawFindRegex;

    const findRegex = regexFromString(findRegexSource);
    if (!findRegex) return text;

    let replaceString = pickString(script.replaceString, script.replace_string);

    if (replaceString.length > MAX_REPLACE_LEN) {
        replaceString = replaceString.substring(0, MAX_REPLACE_LEN);
    }

    const trimStrings = normalizeTrimStringsForContext(script.trimStrings ?? script.trim_strings, options);

    try {
        return text.replace(findRegex, function (match: string, ...args: any[]) {
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
                if (!captured) return '';
                return filterTrimStrings(captured, trimStrings);
            });

            return substituteParams(result, options);
        });
    } catch {
        return text;
    }
}

function scriptMatchesContext(script: RegexScript, options: ApplyRegexOptions): boolean {
    const placement = options.placement ?? 2;
    const placements = normalizePlacementListForSillyTavern(script.placement);
    if (placements.length > 0 && !placements.includes(placement)) return false;

    const isMarkdown = options.isMarkdown ?? true;
    const isPrompt = options.isPrompt ?? false;
    const markdownOnly = normalizeBoolean(script.markdownOnly ?? script.markdown_only, false);
    const promptOnly = normalizeBoolean(script.promptOnly ?? script.prompt_only, false);
    const ephemeral = options.ephemeral ?? 'all';
    if (ephemeral === 'display' && !markdownOnly && placements.length === 0) return false;
    if (ephemeral === 'prompt' && !promptOnly) return false;
    if (ephemeral === 'persist' && (markdownOnly || promptOnly)) return false;

    if (markdownOnly || promptOnly) {
        if (markdownOnly && isMarkdown) {
            // Match SillyTavern: markdown-only scripts run for display Markdown.
        } else if (promptOnly && isPrompt) {
            // Match SillyTavern: prompt-only scripts run for generation context.
        } else {
            return false;
        }
    } else if (isMarkdown || isPrompt) {
        return false;
    }

    if (options.isEdit && !normalizeBoolean(script.runOnEdit, false)) return false;

    if (typeof options.depth === 'number') {
        const minDepth = normalizeDepth(script.minDepth ?? script.min_depth);
        const maxDepth = normalizeDepth(script.maxDepth ?? script.max_depth);
        if (minDepth !== null && minDepth >= -1 && options.depth < minDepth) {
            return false;
        }
        if (maxDepth !== null && maxDepth >= 0 && options.depth > maxDepth) {
            return false;
        }
    }

    return true;
}

function convertHtmlCodeBlocksToMarkers(text: string): string {
    return text.replace(/(`{3,})html\s*\r?\n([\s\S]*?)\r?\n\1/g, (_match, _ticks, htmlContent: string) => {
        return `<palink-html>${htmlContent}</palink-html>`;
    });
}

export function applyRegexScripts(
    text: string,
    extensions: unknown,
    options: ApplyRegexOptions = {},
): string {
    if (!text || !extensions) return text;

    const scripts = Array.isArray(extensions) ? normalizeRegexScriptList(extensions) : normalizeRegexScripts(extensions);
    if (scripts.length === 0) return text;

    const cacheKey = [
        getExtensionsFingerprint(extensions, scripts),
        options.placement ?? 2,
        options.isMarkdown ?? true,
        options.isPrompt ?? false,
        options.ephemeral ?? 'all',
        options.depth ?? '',
        options.isEdit ? 'edit' : '',
        options.characterOverride || options.characterName || '',
        text.length,
        hashString(text),
    ].join('|');
    const cached = getCachedRegexResult(cacheKey);
    if (cached !== undefined) return cached;

    let result = text;
    let applied = 0;

    for (const script of scripts) {
        if (applied >= MAX_REGEX_SCRIPTS) break;
        if (!script || typeof script !== 'object') continue;
        if (normalizeBoolean(script.disabled, false)) continue;
        if (script.enabled !== undefined && script.enabled !== null && !normalizeBoolean(script.enabled, true)) continue;
        if (!scriptMatchesContext(script, options)) continue;

        result = runRegexScript(script, result, options);
        applied++;
    }

    result = convertHtmlCodeBlocksToMarkers(result);
    setCachedRegexResult(cacheKey, result);
    return result;
}

export function extractHtmlFromCodeBlocks(text: string): { html: string | null; remaining: string } {
    const htmlParts: string[] = [];
    let hasHtml = false;

    const processed = text.replace(/````html\s*\n([\s\S]*?)\n\s*````/g, (_match, htmlContent: string) => {
        hasHtml = true;
        htmlParts.push(htmlContent.trim());
        return '';
    });

    const processed2 = processed.replace(/```html\s*\n([\s\S]*?)\n\s*```/g, (_match, htmlContent: string) => {
        hasHtml = true;
        htmlParts.push(htmlContent.trim());
        return '';
    });

    if (!hasHtml) {
        return { html: null, remaining: text };
    }

    return {
        html: htmlParts.join('\n'),
        remaining: processed2.trim(),
    };
}

export function isFullHtmlDocument(html: string): boolean {
    return /<!DOCTYPE\s+html|<html[\s>]/i.test(html);
}
