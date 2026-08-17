/**
 * 本地变量存储
 * 会话级变量，存储在chat_metadata.variables中
 */

import type { VariableStorage, VariableStoreData } from './types';
import { emitEvent } from '../event-bus';

/**
 * 本地变量存储实现
 * 变量绑定到当前会话（chat_metadata）
 */
export class LocalVariableStorage implements VariableStorage {
  private data: VariableStoreData = {};
  private sessionId: string = '';

  /**
   * 设置会话ID
   */
  setSessionId(sessionId: string): void {
    this.sessionId = sessionId;
  }

  /**
   * 加载变量数据
   */
  load(data: VariableStoreData): void {
    this.data = { ...data };
  }

  /**
   * 导出变量数据（用于持久化）
   */
  export(): VariableStoreData {
    return { ...this.data };
  }

  /**
   * 获取变量值
   */
  get(name: string, index?: string | number): string | number {
    const value = this.data[name];
    if (value === undefined) return '';

    // 如果有索引，尝试访问JSON对象/数组
    if (index !== undefined) {
      try {
        const parsed = JSON.parse(value);
        if (Array.isArray(parsed) && typeof index === 'number') {
          return parsed[index] ?? '';
        }
        if (typeof parsed === 'object' && parsed !== null) {
          return parsed[String(index)] ?? '';
        }
      } catch {
        // 不是JSON，返回原值
      }
    }

    // 尝试转换为数字
    const num = Number(value);
    if (!isNaN(num) && value !== '') return num;

    return value;
  }

  /**
   * 设置变量值
   */
  set(name: string, value: string, index?: string | number, asType?: string): string {
    let finalValue = value;

    // 类型转换
    if (asType) {
      switch (asType) {
        case 'int':
          finalValue = String(parseInt(value, 10) || 0);
          break;
        case 'float':
          finalValue = String(parseFloat(value) || 0);
          break;
        case 'bool':
          finalValue = value === 'true' || value === '1' ? 'true' : 'false';
          break;
      }
    }

    // 如果有索引，更新JSON对象/数组
    if (index !== undefined) {
      const existing = this.data[name];
      if (existing) {
        try {
          const parsed = JSON.parse(existing);
          if (Array.isArray(parsed) && typeof index === 'number') {
            parsed[index] = finalValue;
            finalValue = JSON.stringify(parsed);
          } else if (typeof parsed === 'object' && parsed !== null) {
            parsed[String(index)] = finalValue;
            finalValue = JSON.stringify(parsed);
          }
        } catch {
          // 不是JSON，直接设置
        }
      }
    }

    const oldValue = this.data[name];
    this.data[name] = finalValue;

    emitEvent('variable:set', {
      scope: 'local',
      name,
      value: finalValue,
      oldValue,
    });

    return finalValue;
  }

  /**
   * 累加变量值
   */
  add(name: string, value: string): string | number {
    const current = this.data[name];
    if (current === undefined) {
      this.data[name] = value;
      return value;
    }

    // 数值相加
    const currentNum = Number(current);
    const addNum = Number(value);
    if (!isNaN(currentNum) && !isNaN(addNum)) {
      const result = currentNum + addNum;
      this.data[name] = String(result);
      return result;
    }

    // 字符串追加
    const result = current + value;
    this.data[name] = result;
    return result;
  }

  /**
   * 自增1
   */
  increment(name: string): string | number {
    const current = this.data[name];
    const num = current !== undefined ? Number(current) : 0;
    const result = (isNaN(num) ? 0 : num) + 1;
    this.data[name] = String(result);
    return result;
  }

  /**
   * 自减1
   */
  decrement(name: string): string | number {
    const current = this.data[name];
    const num = current !== undefined ? Number(current) : 0;
    const result = (isNaN(num) ? 0 : num) - 1;
    this.data[name] = String(result);
    return result;
  }

  /**
   * 删除变量
   */
  delete(name: string): void {
    const oldValue = this.data[name];
    delete this.data[name];

    emitEvent('variable:deleted', {
      scope: 'local',
      name,
      oldValue,
    });
  }

  /**
   * 检查变量是否存在
   */
  exists(name: string): boolean {
    return name in this.data;
  }

  /**
   * 列出所有变量
   */
  list(): Record<string, string> {
    return { ...this.data };
  }

  /**
   * 清空所有变量
   */
  clear(): void {
    this.data = {};
  }
}

// 导出单例
export const localVariables = new LocalVariableStorage();
