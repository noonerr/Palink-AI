/**
 * 变量系统类型定义
 * 基于 SillyTavern 1.18.0 variables.js
 */

// ============================================================
// 变量存储接口
// ============================================================

/**
 * 变量存储接口 - 统一的变量操作API
 */
export interface VariableStorage {
  /**
   * 获取变量值
   * @param name 变量名
   * @param index 索引（用于JSON对象/数组访问）
   */
  get(name: string, index?: string | number): string | number;

  /**
   * 设置变量值
   * @param name 变量名
   * @param value 值
   * @param index 索引（用于JSON对象/数组访问）
   * @param asType 类型转换（'int', 'float', 'bool'）
   */
  set(name: string, value: string, index?: string | number, asType?: string): string;

  /**
   * 累加变量值（数值相加或字符串追加）
   */
  add(name: string, value: string): string | number;

  /**
   * 自增1
   */
  increment(name: string): string | number;

  /**
   * 自减1
   */
  decrement(name: string): string | number;

  /**
   * 删除变量
   */
  delete(name: string): void;

  /**
   * 检查变量是否存在
   */
  exists(name: string): boolean;

  /**
   * 列出所有变量
   */
  list(): Record<string, string>;
}

// ============================================================
// 变量作用域
// ============================================================

export type VariableScope = 'local' | 'global' | 'scope';

// ============================================================
// 变量存储数据结构
// ============================================================

/**
 * 变量存储数据（用于持久化）
 */
export interface VariableStoreData {
  [key: string]: string;
}

// ============================================================
// 变量操作结果
// ============================================================

export interface VariableOperationResult {
  success: boolean;
  value?: string | number;
  error?: string;
}

// ============================================================
// 布尔运算
// ============================================================

export type BooleanRule =
  | 'eq'    // 等于
  | 'neq'   // 不等于
  | 'gt'    // 大于
  | 'gte'   // 大于等于
  | 'lt'    // 小于
  | 'lte'   // 小于等于
  | 'in'    // 包含
  | 'nin'   // 不包含
  | 'not'   // 非
  | 'and'   // 与
  | 'or';   // 或

// ============================================================
// 变量事件
// ============================================================

export interface VariableEvent {
  scope: VariableScope;
  name: string;
  value?: any;
  oldValue?: any;
}
