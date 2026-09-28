/**
 * [P1.5] 出图服务可用性（模块级单例 + `useSyncExternalStore`）。
 *
 * 两个设计取舍：
 * - **只查一次**：配置是全局的，而 `Message` 是逐条渲染的列表项——每条各自
 *   查一遍会在长会话里打出几十个请求。这里模块级缓存，全局共享一份。
 * - **不走 Context / prop**：`Message` 的 memo 比较器是全 props `Object.is`，
 *   新增一个可变 prop 会让整列表重渲染（P0/P1-A 才把 442 次降到 26 次）。
 *   订阅式读法只让真正关心的那两条消息更新。
 *
 * 门控语义（P1.5）：`enabled=false` 或当前服务商连 base_url 都没有时按钮置灰，
 * 不让用户点了才吃错误。更细的校验（api_key / model）留给服务端——前端复刻
 * 那份规则只会两边漂移，点下去拿到的 400 文案已经是人话。
 */
import { useEffect, useSyncExternalStore } from 'react';
import { api } from '@/services/api';
import type { ImageGenerationProvider } from '@/types/imageGeneration';
import { DEFAULT_MEDIA_HEIGHT, DEFAULT_MEDIA_WIDTH } from '@/lib/messageMedia';

export interface ImageGenerationAvailability {
  /** 服务商可用 → 配图按钮可点。 */
  enabled: boolean;
  /** 首次配置尚未取回：按钮先禁用，避免「点了没反应」。 */
  loading: boolean;
  /** 当前激活服务商是否为浏览器桥接执行（任务由本页执行器驱动本机 ComfyUI）。 */
  browserExecution: boolean;
  /** 占位骨架的目标尺寸（取自当前服务商的 size，与后端 media.width/height 同源）。 */
  width: number;
  height: number;
  /** 请求该等多久：服务商配置的 timeout_seconds + 30s 余量（默认 180s）。 */
  requestTimeoutMs: number;
}

/** 服务商超时兜底（后端 `_validate_provider` 默认 120s，见 schemas/image_generation.py）。 */
const DEFAULT_PROVIDER_TIMEOUT_SECONDS = 120;
/** 客户端比服务端多等的余量：让服务端先超时并给出明确错误，而不是客户端先放弃。 */
const REQUEST_TIMEOUT_MARGIN_SECONDS = 30;

const INITIAL: ImageGenerationAvailability = {
  enabled: false,
  loading: true,
  browserExecution: false,
  width: DEFAULT_MEDIA_WIDTH,
  height: DEFAULT_MEDIA_HEIGHT,
  requestTimeoutMs: (DEFAULT_PROVIDER_TIMEOUT_SECONDS + REQUEST_TIMEOUT_MARGIN_SECONDS) * 1000,
};

let state: ImageGenerationAvailability = INITIAL;
const listeners = new Set<() => void>();
let inflight: Promise<void> | null = null;

function emit(next: ImageGenerationAvailability): void {
  state = next;
  listeners.forEach((listener) => listener());
}

/** 解析 `"768x1024"` / `"768*1024"`，与后端 `_parse_size` 同语义。 */
export function parseProviderSize(raw: string | undefined | null): { width: number; height: number } {
  const text = String(raw || '').trim().toLowerCase().replace('*', 'x');
  const [left, right] = text.split('x');
  const width = Number.parseInt(left ?? '', 10);
  const height = Number.parseInt(right ?? '', 10);
  if (Number.isFinite(width) && Number.isFinite(height) && width > 0 && height > 0) {
    return { width, height };
  }
  return { width: DEFAULT_MEDIA_WIDTH, height: DEFAULT_MEDIA_HEIGHT };
}

function activeProvider(
  providers: ImageGenerationProvider[] | undefined,
  activeId: string | undefined,
): ImageGenerationProvider | undefined {
  if (!Array.isArray(providers) || providers.length === 0) return undefined;
  return providers.find((p) => p.id === activeId) ?? providers[0];
}

/** 拉一次配置（并发去重；失败降级为「未启用」，不影响聊天主流程）。 */
export function ensureImageGenerationConfigLoaded(): Promise<void> {
  if (inflight) return inflight;
  inflight = (async () => {
    try {
      const config = await api.imageGeneration.getConfig();
      const provider = activeProvider(config?.providers, config?.active_provider_id);
      const { width, height } = parseProviderSize(provider?.size);
      const providerTimeout = Number(provider?.timeout_seconds);
      const timeoutSeconds = Number.isFinite(providerTimeout) && providerTimeout > 0
        ? providerTimeout
        : DEFAULT_PROVIDER_TIMEOUT_SECONDS;
      emit({
        enabled: Boolean(config?.enabled) && Boolean(provider?.base_url),
        loading: false,
        browserExecution: provider?.type === 'comfyui' && provider?.execution === 'browser',
        width,
        height,
        requestTimeoutMs: (timeoutSeconds + REQUEST_TIMEOUT_MARGIN_SECONDS) * 1000,
      });
    } catch (error) {
      console.warn('[image-gen] 读取出图配置失败，配图按钮按未配置处理', error);
      emit({ ...INITIAL, loading: false });
    }
  })();
  return inflight;
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

function getSnapshot(): ImageGenerationAvailability {
  return state;
}

function getServerSnapshot(): ImageGenerationAvailability {
  return INITIAL;
}

/** 组件侧读法（Message 工具栏按钮用）。 */
export function useImageGenerationAvailability(): ImageGenerationAvailability {
  const snapshot = useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
  useEffect(() => {
    void ensureImageGenerationConfigLoaded();
  }, []);
  return snapshot;
}

/**
 * 非组件侧读法：给消息处理函数取占位尺寸与请求超时用。
 * 不订阅、不触发重渲染——两者只在发起请求那一刻用一次。
 */
export function getMediaPlaceholderSize(): { width: number; height: number } {
  return { width: state.width, height: state.height };
}

/**
 * 出图请求该等多久（服务商 timeout_seconds + 余量）。
 */
export function getImageGenerationRequestTimeoutMs(): number {
  return state.requestTimeoutMs;
}

/**
 * 设置页保存配置后调用：清缓存并通知订阅者（配图按钮、浏览器执行器）立即重新读取。
 */
export function invalidateImageGenerationConfig(): void {
  inflight = null;
  state = { ...INITIAL, loading: false };
  listeners.forEach((listener) => listener());
}

/** 测试用：重置模块级状态。 */
export function __resetImageGenerationAvailabilityForTest(): void {
  state = INITIAL;
  inflight = null;
  listeners.clear();
}