/**
 * 当前登录用户角色的宿主侧只读快照（批次R1 2026-10-21）。
 *
 * 为什么需要它：帧内 `TavernHelper.isAdmin()` 在 ST 契约里是**同步**的
 * （`st-plugins/third-party/JS-Slash-Runner-main/@types/function/extension.d.ts:2`
 * `declare function isAdmin(): boolean`），而帧内唯一的数据通道 requestParent 是异步的。
 * ⇒ 必须由宿主在挂载卡片前把「当前用户是不是管理员」带进 ctx（boot 内联 + context-update），
 * 帧内同步读它。数据源是 `GET /api/users/me` 返回的 `user.role`（与 `App.tsx:896`
 * 的 `user?.role === 'admin'` 同一口径）。
 *
 * ⛔ 这不是权限边界：后端每个写端点仍自己鉴权。它只负责让 ST 卡拿到**真值**，
 * 用来决定要不要显示"安装/更新扩展"这类管理入口。
 */
import type { User } from '@/types';

let currentUserRole: User['role'] | null = null;

/** 登录态探测成功 / 失败 / 登出时由 App 写入；传 null 表示未登录。 */
export function setCurrentUserRole(role: User['role'] | null | undefined): void {
  currentUserRole = role === 'admin' || role === 'user' ? role : null;
}

export function getCurrentUserRole(): User['role'] | null {
  return currentUserRole;
}

export function isCurrentUserAdmin(): boolean {
  return currentUserRole === 'admin';
}
