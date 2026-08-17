/**
 * mvuSchemaParser.ts
 *
 * 前端移植自后端 `backend/app/services/mvu_engine.py` 的 `extract_schema_defaults`。
 *
 * 目的：从角色卡 `extensions.tavern_helper` 的 schema 脚本（形如
 *   `export const Schema = z.object({...})` 或 `registerMvuSchema(z.object({...}))`）
 * 中**正则解析**出字段树 + 默认值，**不执行** ESM、**不依赖** zod 运行时、
 * **不依赖** CDN import。
 *
 * 返回结构（schemaTree）：
 *   { [group: string]: { [field: string]: any } }
 * 其中 value 为该字段的默认值（类型由值本身推断：number→进度条/数值，
 * string→文本，boolean→开关文本）。
 *
 * 与后端逻辑保持一致，便于排查「前后端解析不一致」。
 */

const Z_OBJECT_RE = /z\.object\s*\(/;
const PREFAULT_RE = /\.prefault\s*\(/;

const UNSET = Symbol("unset");

/** 从 start（指向 openCh）开始匹配括号，返回 closeCh 的索引；未找到返回 -1。 */
function matchBraces(
  text: string,
  start: number,
  openCh = "{",
  closeCh = "}",
): number {
  let depth = 0;
  let inString = false;
  let escape = false;
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (inString) {
      if (escape) escape = false;
      else if (ch === "\\") escape = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === openCh) depth += 1;
    else if (ch === closeCh) {
      depth -= 1;
      if (depth === 0) return i;
    }
  }
  return -1;
}

/** 按顶层逗号分割（忽略嵌套括号/引号内的逗号）。 */
function splitTopLevelCommas(text: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let inString = false;
  let escape = false;
  let buf: string[] = [];
  for (const ch of text) {
    if (inString) {
      buf.push(ch);
      if (escape) escape = false;
      else if (ch === "\\") escape = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') {
      inString = true;
      buf.push(ch);
    } else if (ch === "{" || ch === "[" || ch === "(") {
      depth += 1;
      buf.push(ch);
    } else if (ch === "}" || ch === "]" || ch === ")") {
      depth -= 1;
      buf.push(ch);
    } else if (ch === "," && depth === 0) {
      parts.push(buf.join("").trim());
      buf = [];
    } else {
      buf.push(ch);
    }
  }
  const last = buf.join("").trim();
  if (last) parts.push(last);
  return parts;
}

/** 找到顶层冒号（不在嵌套括号/引号内）。 */
function findTopLevelColon(text: string): number {
  let depth = 0;
  let inString = false;
  let escape = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inString) {
      if (escape) escape = false;
      else if (ch === "\\") escape = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === "{" || ch === "[" || ch === "(") depth += 1;
    else if (ch === "}" || ch === "]" || ch === ")") depth -= 1;
    else if (ch === ":" && depth === 0) return i;
  }
  return -1;
}

/** 去掉 key 的引号与尾逗号。 */
function unquoteKey(raw: string): string {
  const s = raw.trim();
  if (s.length >= 2 && (s[0] === "'" || s[0] === '"') && s[s.length - 1] === s[0]) {
    return s.slice(1, -1);
  }
  return s.replace(/,\s*$/, "").trim();
}

/** 解析 JS 对象字面量（key 可无引号），返回 dict；失败返回 {}。 */
function parseJsObjectLiteral(raw: string): Record<string, any> {
  const s = raw.trim();
  if (!s.startsWith("{") || !s.endsWith("}")) return {};
  try {
    const data = JSON.parse(s);
    return data && typeof data === "object" ? (data as Record<string, any>) : {};
  } catch {
    /* fall through */
  }
  // 给无引号的 key 加双引号
  let fixed = s.replace(/([{,]\s*)([A-Za-z_$][\w$]*)\s*:/g, '$1"$2":');
  // 去尾逗号
  fixed = fixed.replace(/,\s*}/g, "}");
  try {
    const data = JSON.parse(fixed);
    return data && typeof data === "object" ? (data as Record<string, any>) : {};
  } catch {
    return {};
  }
}

/** 从 .prefault( 后提取第一个参数值。 */
function extractPrefaultArg(expr: string, parenStart: number): any {
  const rest = expr.slice(parenStart + 1);
  const restStripped = rest.trimStart();
  const first = restStripped[0];
  // 字符串字面量（单/双引号）
  if (first === "'" || first === '"') {
    const end = restStripped.indexOf(first, 1);
    if (end !== -1) return restStripped.slice(1, end);
  }
  if (restStripped.startsWith("true")) return true;
  if (restStripped.startsWith("false")) return false;
  if (restStripped.startsWith("{")) {
    const end = matchBraces(restStripped, 0, "{", "}");
    if (end !== -1) {
      try {
        return JSON.parse(restStripped.slice(0, end + 1));
      } catch {
        return {};
      }
    }
    return {};
  }
  if (restStripped.startsWith("[")) {
    const end = matchBraces(restStripped, 0, "[", "]");
    if (end !== -1) {
      try {
        return JSON.parse(restStripped.slice(0, end + 1));
      } catch {
        return [];
      }
    }
    return [];
  }
  const numMatch = /(-?\d+\.?\d*)/.exec(restStripped);
  if (numMatch) {
    const n = numMatch[1];
    return n.includes(".") ? parseFloat(n) : parseInt(n, 10);
  }
  return UNSET;
}

function deepMerge(target: Record<string, any>, source: Record<string, any>): Record<string, any> {
  for (const k of Object.keys(source)) {
    const v = source[k];
    if (v && typeof v === "object" && !Array.isArray(v) && target[k] && typeof target[k] === "object" && !Array.isArray(target[k])) {
      deepMerge(target[k], v);
    } else {
      target[k] = v;
    }
  }
  return target;
}

/** 解析单个 zod 表达式，返回默认值。 */
function parseZodValue(expr: string): any {
  const e = expr.trim();
  if (!e) return null;

  // 嵌套 z.object
  const m = Z_OBJECT_RE.exec(e);
  if (m) {
    const parenStart = e.indexOf("(", m.index);
    if (parenStart === -1) return {};
    const braceStart = e.indexOf("{", parenStart);
    if (braceStart === -1) return {};
    const braceEnd = matchBraces(e, braceStart);
    if (braceEnd === -1) return {};
    const inner = e.slice(braceStart + 1, braceEnd);
    const defaults = parseZodObjectBody(inner);

    // 检查 .prefault({...}) 是否有显式覆盖
    const after = e.slice(braceEnd + 1);
    const pm = PREFAULT_RE.exec(after);
    if (pm) {
      const paren = after.indexOf("(", pm.index);
      if (paren !== -1) {
        const argStart = after.indexOf("{", paren);
        if (argStart !== -1) {
          const argEnd = matchBraces(after, argStart);
          if (argEnd !== -1) {
            const argStr = after.slice(argStart, argEnd + 1);
            const explicit = parseJsObjectLiteral(argStr);
            if (explicit && typeof explicit === "object") deepMerge(defaults, explicit);
          }
        }
      }
    }
    return defaults;
  }

  // 标量类型
  const isArray = /^z\.array\b/.test(e);
  const isString = !isArray && /^(z\.string|z\.coerce\.string)\b/.test(e);
  const isNumber = /^(z\.number|z\.coerce\.number)\b/.test(e);
  const isBoolean = /^z\.boolean\b/.test(e);

  let prefaultVal: any = UNSET;
  const pm = PREFAULT_RE.exec(e);
  if (pm) {
    const parenStart = e.indexOf("(", pm.index);
    if (parenStart !== -1) prefaultVal = extractPrefaultArg(e, parenStart);
  }

  if (prefaultVal !== UNSET) return prefaultVal;
  if (isString) return "";
  if (isNumber) return 0;
  if (isBoolean) return false;
  if (isArray) return [];
  return null;
}

/** 解析 z.object({...}) 内部 body，返回 { key: default }。 */
function parseZodObjectBody(body: string): Record<string, any> {
  const result: Record<string, any> = {};
  const parts = splitTopLevelCommas(body);
  for (const part of parts) {
    if (!part.trim()) continue;
    const colon = findTopLevelColon(part);
    if (colon === -1) continue;
    const keyRaw = part.slice(0, colon).trim();
    const valExpr = part.slice(colon + 1).trim();
    const key = unquoteKey(keyRaw);
    if (!key) continue;
    result[key] = parseZodValue(valExpr);
  }
  return result;
}

/**
 * 从 tavern_helper（{ scripts?: { content: string }[] }）提取 schema 字段树（含默认值）。
 * 返回 { [group]: { [field]: default } }；无 schema 返回 {}。
 */
export function parseMvuSchema(
  tavernHelper?: { scripts?: Array<{ content?: string }> } | null,
): Record<string, any> {
  if (!tavernHelper || typeof tavernHelper !== "object") return {};
  const scripts = (tavernHelper as any).scripts;
  if (!Array.isArray(scripts)) return {};
  for (const script of scripts) {
    if (!script || typeof script !== "object") continue;
    const content = script.content;
    if (typeof content !== "string" || !content.includes("z.object")) continue;
    try {
      const iter = content.matchAll(/z\.object\s*\(/g);
      for (const mm of iter) {
        const parenStart = content.indexOf("(", mm.index!);
        if (parenStart === -1) continue;
        const braceStart = content.indexOf("{", parenStart);
        if (braceStart === -1) continue;
        const braceEnd = matchBraces(content, braceStart);
        if (braceEnd === -1) continue;
        const body = content.slice(braceStart + 1, braceEnd);
        const defaults = parseZodObjectBody(body);
        if (defaults && Object.keys(defaults).length > 0) return defaults;
      }
    } catch {
      continue;
    }
  }
  return {};
}

export default parseMvuSchema;
