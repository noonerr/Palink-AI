/**
 * 快捷键管理器
 *
 * 提供注册/注销快捷键、冲突检测与事件匹配能力。
 * 调用方在组件中注册带 handler 的绑定，然后在 keydown 事件中
 * 调用 matchEvent 获取匹配的绑定并执行 handler。
 */

import type { ShortcutBindingDef } from './bindings';

export interface ShortcutBinding extends ShortcutBindingDef {
  /** 匹配时执行的回调 */
  handler: (e: KeyboardEvent) => void;
}

/**
 * 将绑定定义规范化为组合键字符串。
 * 顺序固定为 meta+ctrl+alt+shift+key，便于冲突比对。
 */
export function comboKey(def: {
  key: string;
  ctrl?: boolean;
  shift?: boolean;
  alt?: boolean;
  meta?: boolean;
}): string {
  const parts: string[] = [];
  if (def.meta) parts.push('meta');
  if (def.ctrl) parts.push('ctrl');
  if (def.alt) parts.push('alt');
  if (def.shift) parts.push('shift');
  parts.push(def.key.toLowerCase());
  return parts.join('+');
}

/**
 * 从 KeyboardEvent 提取组合键字符串，与 comboKey 保持一致。
 */
export function eventComboKey(e: KeyboardEvent): string {
  return comboKey({
    key: e.key,
    ctrl: e.ctrlKey,
    shift: e.shiftKey,
    alt: e.altKey,
    meta: e.metaKey,
  });
}

export class ShortcutManager {
  private bindings: Map<string, ShortcutBinding> = new Map();
  private idToCombo: Map<string, string> = new Map();

  /**
   * 注册快捷键。若组合键已被占用（冲突）则返回 false 且不覆盖。
   */
  register(binding: ShortcutBinding): boolean {
    const ck = comboKey(binding);
    if (this.bindings.has(ck)) {
      return false;
    }
    this.bindings.set(ck, binding);
    this.idToCombo.set(binding.id, ck);
    return true;
  }

  /**
   * 按 id 注销快捷键。
   */
  unregister(id: string): void {
    const ck = this.idToCombo.get(id);
    if (ck) {
      this.bindings.delete(ck);
      this.idToCombo.delete(id);
    }
  }

  /**
   * 注销所有快捷键。
   */
  clear(): void {
    this.bindings.clear();
    this.idToCombo.clear();
  }

  /**
   * 检测给定绑定定义是否与已注册快捷键冲突。
   */
  hasConflict(def: ShortcutBindingDef): boolean {
    return this.bindings.has(comboKey(def));
  }

  /**
   * 匹配键盘事件，返回命中的绑定（含 handler），未命中返回 null。
   */
  matchEvent(e: KeyboardEvent): ShortcutBinding | null {
    const ck = eventComboKey(e);
    return this.bindings.get(ck) || null;
  }

  /**
   * 列出当前已注册的所有绑定（用于 UI 展示）。
   */
  list(): ShortcutBinding[] {
    return Array.from(this.bindings.values());
  }
}

/** 单例管理器（聊天输入场景） */
export const chatShortcutManager = new ShortcutManager();
