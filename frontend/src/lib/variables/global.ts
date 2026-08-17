/**
 * 全局变量存储
 * 应用级变量，持久化到后端
 */

import type { VariableStorage, VariableStoreData } from './types';
import { emitEvent } from '../event-bus';
import { api } from '@/services/api';

/**
 * 全局变量存储实现
 * 变量跨会话持久化，存储在后端
 */
export class GlobalVariableStorage implements VariableStorage {
  private data: VariableStoreData = {};
  private loaded = false;
  private saveTimer: ReturnType<typeof setTimeout> | null = null;

  /**
   * 从后端加载变量
   */
  async load(): Promise<void> {
    try {
      const result = await api.get<VariableStoreData>('/api/variables/global');
      if (result && typeof result === 'object') {
        this.data = result;
      }
      this.loaded = true;
    } catch (error) {
      console.error('Failed to load global variables:', error);
      this.loaded = true;
    }
  }

  /**
   * 保存变量到后端（防抖）
   */
  private scheduleSave(): void {
    if (this.saveTimer) {
      clearTimeout(this.saveTimer);
    }
    this.saveTimer = setTimeout(() => {
      this.save();
    }, 1000);
  }

  /**
   * 立即保存到后端
   */
  async save(): Promise<void> {
    try {
      await api.post('/api/variables/global', this.data);
    } catch (error) {
      console.error('Failed to save global variables:', error);
    }
  }

  /**
   * 确保已加载
   */
  private async ensureLoaded(): Promise<void> {
    if (!this.loaded) {
      await this.load();
    }
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
      scope: 'global',
      name,
      value: finalValue,
      oldValue,
    });

    this.scheduleSave();
    return finalValue;
  }

  /**
   * 累加变量值
   */
  add(name: string, value: string): string | number {
    const current = this.data[name];
    if (current === undefined) {
      this.data[name] = value;
      this.scheduleSave();
      return value;
    }

    // 数值相加
    const currentNum = Number(current);
    const addNum = Number(value);
    if (!isNaN(currentNum) && !isNaN(addNum)) {
      const result = currentNum + addNum;
      this.data[name] = String(result);
      this.scheduleSave();
      return result;
    }

    // 字符串追加
    const result = current + value;
    this.data[name] = result;
    this.scheduleSave();
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
    this.scheduleSave();
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
    this.scheduleSave();
    return result;
  }

  /**
   * 删除变量
   */
  delete(name: string): void {
    const oldValue = this.data[name];
    delete this.data[name];

    emitEvent('variable:deleted', {
      scope: 'global',
      name,
      oldValue,
    });

    this.scheduleSave();
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
  async clear(): Promise<void> {
    this.data = {};
    await this.save();
  }
}

// 导出单例
export const globalVariables = new GlobalVariableStorage();
