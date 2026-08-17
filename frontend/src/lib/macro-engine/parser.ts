/**
 * 宏解析器
 * 基于 SillyTavern 1.18.0 MacroParser
 *
 * 注意：当前为 stub 实现，使用栈匹配算法替代完整 Chevrotain 解析器。
 * 解析 {{macroname}}, {{macroname::arg1::arg2}}, {{!flags macroname}} 等语法。
 * 支持嵌套花括号（如 {{getvar::{{roll::1d2}}}}）与转义（\{\{...\}\} 保留为字面量）。
 */

import type { MacroFlags } from './types';
import { parseFlags } from './engine/MacroFlags';
import type { DocumentItem } from './cst-walker';

// ============================================================
// 解析结果类型
// ============================================================

export interface MacroParseResult {
  /** 解析得到的 CST（文档项数组），解析失败时为 null */
  cst: DocumentItem[] | null;
  /** 解析错误列表 */
  errors: Array<{ message: string; offset?: number }>;
}

// ============================================================
// 宏花括号匹配
// ============================================================

/**
 * 标志字符集合
 */
const FLAG_CHARS = new Set(['!', '?', '~', '>', '/', '#']);

// ============================================================
// MacroParser 单例
// ============================================================

class MacroParserClass {
  static instance: MacroParserClass = new MacroParserClass();

  /**
   * 解析文档，生成 CST
   * CST 是文档项数组，包含文本项与宏项
   *
   * 使用基于栈的花括号匹配算法，支持嵌套宏（如 {{getvar::{{roll::1d2}}}}）。
   * 提取最外层宏，内层 {{...}} 保留在 rawInner 中，由 resolve 函数递归处理。
   * 支持转义：\{\{...\}\} 保留为字面量 {{...}}（不作为宏解析）。
   */
  parseDocument(input: string): MacroParseResult {
    if (!input) {
      return { cst: [], errors: [] };
    }

    const items: DocumentItem[] = [];
    const errors: Array<{ message: string; offset?: number }> = [];
    const len = input.length;
    let i = 0;
    let textBuffer = '';

    const flushText = () => {
      if (textBuffer.length > 0) {
        items.push({ type: 'text', text: textBuffer });
        textBuffer = '';
      }
    };

    while (i < len) {
      // 转义：\{ 或 \} 保留为字面量花括号（去除反斜杠）
      if (input[i] === '\\' && i + 1 < len && (input[i + 1] === '{' || input[i + 1] === '}')) {
        textBuffer += input[i + 1];
        i += 2;
        continue;
      }

      // 潜在宏起始：{{
      if (input[i] === '{' && i + 1 < len && input[i + 1] === '{') {
        const endBraceIndex = this.matchBraces(input, i);
        if (endBraceIndex !== null) {
          flushText();
          const startOffset = i;
          const endOffset = endBraceIndex + 2; // }} 之后
          const inner = input.slice(i + 2, endBraceIndex);
          const rawWithBraces = input.slice(startOffset, endOffset);
          const macroItem = this.parseMacro(inner, startOffset, endOffset, rawWithBraces);
          if (macroItem) {
            items.push(macroItem);
          } else {
            // 解析失败，按文本处理
            items.push({ type: 'text', text: rawWithBraces });
          }
          i = endOffset;
          continue;
        }
      }

      // 普通字符
      textBuffer += input[i];
      i++;
    }

    flushText();
    return { cst: items, errors };
  }

  /**
   * 从 startIndex（指向第一个 {）开始，用计数器匹配完整的 {{...}}。
   * 支持嵌套花括号与转义。每遇到 {{ 计数 +1，每遇到 }} 计数 -1，
   * 计数归零时匹配到一个完整宏（可能包含嵌套）。
   *
   * 返回内层结束 } 的索引（即闭合 }} 的第一个 } 的索引）；
   * 若花括号不平衡则返回 null。
   */
  private matchBraces(input: string, startIndex: number): number | null {
    const len = input.length;
    let depth = 0;
    let i = startIndex;

    while (i < len) {
      // 转义：跳过 \{ 或 \}
      if (input[i] === '\\' && i + 1 < len && (input[i + 1] === '{' || input[i + 1] === '}')) {
        i += 2;
        continue;
      }

      // 开 {{
      if (input[i] === '{' && i + 1 < len && input[i + 1] === '{') {
        depth++;
        i += 2;
        continue;
      }

      // 闭 }}
      if (input[i] === '}' && i + 1 < len && input[i + 1] === '}') {
        depth--;
        i += 2;
        if (depth === 0) {
          return i - 2; // 闭合 }} 的第一个 } 的索引
        }
        if (depth < 0) {
          return null;
        }
        continue;
      }

      i++;
    }

    return null; // 花括号不平衡
  }

  /**
   * 解析单个宏内容
   * 格式: [flags]name[::arg1::arg2...]
   */
  private parseMacro(
    inner: string,
    startOffset: number,
    endOffset: number,
    rawWithBraces: string,
  ): DocumentItem | null {
    let content = inner;

    // 提取标志字符（位于开头的特殊字符）
    const flagChars: string[] = [];
    while (content.length > 0 && FLAG_CHARS.has(content[0])) {
      flagChars.push(content[0]);
      content = content.slice(1);
    }

    // 去除首尾空白
    content = content.trim();
    if (!content) {
      return null;
    }

    // 分割宏名与参数（以 :: 分隔）
    const parts = content.split('::');
    const name = parts[0];
    const rawArgs = parts.slice(1);

    if (!name) {
      return null;
    }

    const flags: MacroFlags = parseFlags(flagChars);

    return {
      type: 'macro',
      macro: {
        name,
        args: rawArgs,
        flags,
        isScoped: false,
        rawInner: inner,
        rawWithBraces,
        rawArgs,
        range: { startOffset, endOffset },
      },
    };
  }
}

export const MacroParser = MacroParserClass;
