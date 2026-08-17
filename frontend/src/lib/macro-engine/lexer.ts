/**
 * 宏词法分析器（Chevrotain Token 定义）
 * 基于 SillyTavern 1.18.0 MacroLexer
 *
 * 注意：当前为 stub 实现，使用正则替代完整 Chevrotain 词法分析。
 * 完整实现应基于 Chevrotain Lexer 构建，支持多模式词法分析。
 */

import { createToken, Lexer } from 'chevrotain';

// ============================================================
// Token 定义
// ============================================================

/** 左双花括号 {{ */
export const MacroTokens = {
  LBrace: createToken({ name: 'LBrace', pattern: /\{\{/ }),
  RBrace: createToken({ name: 'RBrace', pattern: /\}\}/ }),
  Identifier: createToken({ name: 'Identifier', pattern: /[a-zA-Z][\w\-_]*/ }),
  DoubleColon: createToken({ name: 'DoubleColon', pattern: /::/ }),
  Flag: createToken({ name: 'Flag', pattern: /[!?~>\/#]/ }),
  Text: createToken({ name: 'Text', pattern: /[^{]+/ }),
  LBraceSingle: createToken({ name: 'LBraceSingle', pattern: /\{(?!\{)/ }),
  RBraceSingle: createToken({ name: 'RBraceSingle', pattern: /\}(?!\})/ }),
};

/** 词法分析器模式定义 */
export const MacroLexerModes = {
  defaultMode: [
    MacroTokens.LBrace,
    MacroTokens.RBrace,
    MacroTokens.Identifier,
    MacroTokens.DoubleColon,
    MacroTokens.Flag,
    MacroTokens.Text,
    MacroTokens.LBraceSingle,
    MacroTokens.RBraceSingle,
  ],
};

/** 词法分析器实例（stub，实际解析由 parser.ts 正则实现） */
export const MacroLexer = new Lexer(MacroLexerModes.defaultMode, {
  positionTracking: 'full',
});
