/**
 * 本设备的身份与算力角色（B2-T3：多设备算力路由）。
 *
 * 两个 localStorage 键：
 * - `palink_device_id`：**随机 uuid**，只用于区分"哪台设备的浏览器"，不是设备指纹，
 *   清除浏览器数据或点重置就会变。它的唯一用途是让后端知道"上一次认领也是你"，
 *   从而把重复认领当心跳续期（渲染中不被第二台机器抢走，见 §9 R2）。
 * - `palink_image_compute_role`：本设备是「出图算力」还是「只当遥控器」。
 *
 * 注意：这个模块**只决定"要不要接单"**，不参与"图片存在哪"——图一律落在服务端
 * `extra.media`，所有设备天然可见，调度关心的是"哪台浏览器去打本机服务"。
 */

export const DEVICE_ID_KEY = 'palink_device_id';
export const COMPUTE_ROLE_KEY = 'palink_image_compute_role';
/** 角色变更事件：设置页改完后广播，让 App 根部的执行器重挂。 */
export const COMPUTE_ROLE_EVENT = 'palink:compute-role-changed';

export type ComputeRole = 'auto' | 'provider' | 'controller';
export type DeviceCapability = 'provider' | 'controller';

function storage(): Storage | null {
  try {
    return typeof window !== 'undefined' ? window.localStorage : null;
  } catch {
    return null; // 隐私模式 / 禁用存储
  }
}

function randomId(): string {
  const cryptoObj = typeof globalThis !== 'undefined' ? (globalThis.crypto as Crypto | undefined) : undefined;
  if (cryptoObj?.randomUUID) return cryptoObj.randomUUID();
  return `dev-${Math.random().toString(36).slice(2)}-${Date.now().toString(36)}`;
}

export function getDeviceId(): string {
  const store = storage();
  if (!store) return '';
  let value = store.getItem(DEVICE_ID_KEY);
  if (!value) {
    value = randomId();
    store.setItem(DEVICE_ID_KEY, value);
  }
  return value;
}

export function resetDeviceId(): string {
  const store = storage();
  if (!store) return '';
  const value = randomId();
  store.setItem(DEVICE_ID_KEY, value);
  return value;
}

export function getComputeRole(): ComputeRole {
  const store = storage();
  const value = store?.getItem(COMPUTE_ROLE_KEY);
  return value === 'provider' || value === 'controller' ? value : 'auto';
}

export function setComputeRole(role: ComputeRole): void {
  storage()?.setItem(COMPUTE_ROLE_KEY, role);
  if (typeof window !== 'undefined') {
    window.dispatchEvent(new Event(COMPUTE_ROLE_EVENT));
  }
}

/**
 * auto 的默认建议值：桌面（指针精确）当算力，移动端当遥控器。
 * 这是**默认值而非硬判**——能力由设备自报，用户可以手改（不读 UA 硬判）。
 */
export function isPointerFine(): boolean {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return true;
  return window.matchMedia('(pointer: fine)').matches;
}

export function resolveCapability(role: ComputeRole = 'auto'): DeviceCapability {
  if (role === 'provider') return 'provider';
  if (role === 'controller') return 'controller';
  return isPointerFine() ? 'provider' : 'controller';
}
