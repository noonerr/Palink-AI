/**
 * 宏 CST 遍历器
 * 基于 SillyTavern 1.18.0 MacroCstWalker
 *
 * 遍历解析器生成的 CST，对宏项调用 resolveMacro 求值，
 * 对文本项原样输出，最终拼接成完整结果字符串。
 */

import type { MacroEnv, MacroCall } from './types';

// ============================================================
// CST 节点类型
// ============================================================

/** 宏节点信息 */
export interface MacroNode {
  name: string;
  args: string[];
  flags: import('./types').MacroFlags;
  isScoped: boolean;
  rawInner: string;
  rawWithBraces: string;
  rawArgs: string[];
  range: { startOffset: number; endOffset: number };
}

/** 文档项（CST 节点） */
export interface DocumentItem {
  type: 'text' | 'macro';
  /** 文本节点内容（type === 'text' 时有效） */
  text?: string;
  /** 宏节点信息（type === 'macro' 时有效） */
  macro?: MacroNode;
}

// ============================================================
// 求值上下文
// ============================================================

export interface EvaluationContext {
  /** 原始文本 */
  text: string;
  /** 解析得到的 CST */
  cst: DocumentItem[];
  /** 上下文偏移量 */
  contextOffset: number;
  /** 宏环境 */
  env: MacroEnv;
  /** 宏求值回调 */
  resolveMacro: (call: MacroCall) => string;
  /** 内容修剪回调 */
  trimContent: (content: string, options?: { trimIndent?: boolean }) => string;
}

// ============================================================
// MacroCstWalker 单例
// ============================================================

class MacroCstWalkerClass {
  static instance: MacroCstWalkerClass = new MacroCstWalkerClass();

  /**
   * 求值整个文档
   * 遍历 CST，对宏项调用 resolveMacro，对文本项原样输出
   */
  evaluateDocument(context: EvaluationContext): string {
    const { cst, env, resolveMacro, contextOffset } = context;

    if (!cst || cst.length === 0) {
      return context.text;
    }

    let result = '';

    for (const item of cst) {
      if (item.type === 'text') {
        result += item.text ?? '';
      } else if (item.type === 'macro' && item.macro) {
        const macroNode = item.macro;

        // 构建 MacroCall
        const call: MacroCall = {
          name: macroNode.name,
          args: macroNode.args,
          flags: macroNode.flags,
          isScoped: macroNode.isScoped,
          env,
          rawInner: macroNode.rawInner,
          rawWithBraces: macroNode.rawWithBraces,
          rawArgs: macroNode.rawArgs,
          range: macroNode.range,
          globalOffset: macroNode.range.startOffset + contextOffset,
        };

        // 调用求值回调
        try {
          result += resolveMacro(call);
        } catch {
          // 求值失败，保留原始宏文本
          result += macroNode.rawWithBraces;
        }
      }
    }

    return result;
  }
}

export const MacroCstWalker = MacroCstWalkerClass;
