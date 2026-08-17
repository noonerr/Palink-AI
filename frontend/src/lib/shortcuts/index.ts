/**
 * 快捷键系统模块入口
 */

export type { ShortcutBindingDef, ModifierKey } from './bindings';
export { CHAT_SHORTCUT_BINDINGS } from './bindings';
export type { ShortcutBinding } from './manager';
export {
  ShortcutManager,
  chatShortcutManager,
  comboKey,
  eventComboKey,
} from './manager';
