/**
 * 斜杠命令作用域与宏替换
 * 基于 SillyTavern 1.18.0 SlashCommandScope 实现
 */

// ============================================================
// SlashCommandScope 作用域类
// ============================================================

export class SlashCommandScope {
  /** 父级作用域（根作用域为 null） */
  private parent: SlashCommandScope | null;
  /** 当前作用域的变量表 */
  private variables: Map<string, string> = new Map();
  /** 管道输入值（上一条命令的输出） */
  public pipe: string = '';

  constructor(parent: SlashCommandScope | null) {
    this.parent = parent;
  }

  /**
   * 在当前作用域声明变量（不影响父作用域）
   */
  letVariable(name: string, value: string): void {
    this.variables.set(name, value);
  }

  /**
   * 设置变量（向上查找已有变量并赋值；未找到则在当前作用域创建）
   */
  setVariable(name: string, value: string): void {
    let scope: SlashCommandScope | null = this;
    while (scope) {
      if (scope.variables.has(name)) {
        scope.variables.set(name, value);
        return;
      }
      scope = scope.parent;
    }
    // 未找到则在本作用域创建
    this.variables.set(name, value);
  }

  /**
   * 获取变量（向上查找作用域链）
   */
  getVariable(name: string): string {
    let scope: SlashCommandScope | null = this;
    while (scope) {
      if (scope.variables.has(name)) {
        return scope.variables.get(name) ?? '';
      }
      scope = scope.parent;
    }
    return '';
  }

  /**
   * 判断变量是否存在（向上查找作用域链）
   */
  existsVariable(name: string): boolean {
    let scope: SlashCommandScope | null = this;
    while (scope) {
      if (scope.variables.has(name)) {
        return true;
      }
      scope = scope.parent;
    }
    return false;
  }
}

// ============================================================
// 宏替换
// ============================================================

/**
 * 替换文本中的宏 {{name}} 为作用域变量值
 * 支持 {{pipe}} 取管道值，{{var}} 取作用域变量
 */
export function substituteMacros(text: string, scope: SlashCommandScope): string {
  if (!text) return '';
  return text.replace(/\{\{(\w+)\}\}/g, (match, name: string) => {
    if (name === 'pipe') {
      return scope.pipe;
    }
    const value = scope.getVariable(name);
    return value !== '' ? value : match;
  });
}

// ============================================================
// 条件求值
// ============================================================

/**
 * 求值条件表达式
 * 支持比较运算符 == != <= >= < >，以及真值判断
 */
export function evaluateCondition(condition: string): boolean {
  const trimmed = condition.trim();
  if (!trimmed) return false;

  // 比较运算
  const comparisonMatch = trimmed.match(/^(.+?)\s*(==|!=|<=|>=|<|>)\s*(.+)$/);
  if (comparisonMatch) {
    const left = comparisonMatch[1].trim();
    const op = comparisonMatch[2];
    const right = comparisonMatch[3].trim();

    const leftNum = Number(left);
    const rightNum = Number(right);
    const bothNumeric = !isNaN(leftNum) && !isNaN(rightNum);

    switch (op) {
      case '==':
        return bothNumeric ? leftNum === rightNum : left === right;
      case '!=':
        return bothNumeric ? leftNum !== rightNum : left !== right;
      case '<=':
        return bothNumeric ? leftNum <= rightNum : left <= right;
      case '>=':
        return bothNumeric ? leftNum >= rightNum : left >= right;
      case '<':
        return bothNumeric ? leftNum < rightNum : left < right;
      case '>':
        return bothNumeric ? leftNum > rightNum : left > right;
    }
  }

  // 布尔字面量
  const lower = trimmed.toLowerCase();
  if (lower === 'true') return true;
  if (lower === 'false') return false;
  if (lower === '0') return false;

  // 非空字符串视为真
  return trimmed !== '';
}
