/**
 * 快捷键预置绑定定义
 *
 * 定义快捷键的组合键、描述与唯一 id。handler 在注册时由调用方提供，
 * 此处仅声明组合键与元信息，便于冲突检测与 UI 展示。
 */

export type ModifierKey = 'ctrl' | 'shift' | 'alt' | 'meta';

export interface ShortcutBindingDef {
  /** 唯一标识，用于 register/unregister */
  id: string;
  /** 主键名（小写），如 'enter' / 'escape' / 'k' */
  key: string;
  /** 是否需要 Ctrl */
  ctrl?: boolean;
  /** 是否需要 Shift */
  shift?: boolean;
  /** 是否需要 Alt */
  alt?: boolean;
  /** 是否需要 Meta (Cmd) */
  meta?: boolean;
  /** 人类可读描述 */
  description: string;
  /** 默认是否启用 */
  enabled?: boolean;
}

/**
 * 角色扮演聊天输入框预置快捷键。
 *
 * - Enter：发送消息（由现有输入框逻辑处理，此处仅作声明）
 * - Shift+Enter：换行（浏览器默认行为，此处仅作声明）
 * - Ctrl+Enter：重新生成上一条 AI 回复
 * - Ctrl+Shift+Enter：继续生成
 */
export const CHAT_SHORTCUT_BINDINGS: ShortcutBindingDef[] = [
  {
    id: 'chat.send',
    key: 'enter',
    description: '发送消息',
    enabled: true,
  },
  {
    id: 'chat.newline',
    key: 'enter',
    shift: true,
    description: '换行',
    enabled: true,
  },
  {
    id: 'chat.regenerate',
    key: 'enter',
    ctrl: true,
    description: '重新生成',
    enabled: true,
  },
  {
    id: 'chat.continue',
    key: 'enter',
    ctrl: true,
    shift: true,
    description: '继续生成',
    enabled: true,
  },
];
