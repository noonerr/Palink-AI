/**
 * 与后端 schemas/image_generation.py 的 ImageGenerationProviderType 一一对应。
 * 服务层支持三种，此前这里和后端 schema 都是窄字面量，导致自建 SD WebUI /
 * ComfyUI 的配置存不进去。两处必须同步改，否则 tsc 直接挂。
 */
export type ImageGenerationProviderType = 'openai_compatible' | 'sd_webui' | 'comfyui';

export interface ImageGenerationProvider {
  id: string;
  name: string;
  type: ImageGenerationProviderType;
  enabled: boolean;
  base_url: string;
  api_key: string;
  model: string;
  size: string;
  quality?: string | null;
  style?: string | null;
  response_format?: 'auto' | 'b64_json' | 'url' | null;
  timeout_seconds: number;
}

export interface ImageGenerationDefaults {
  prompt_template: string;
  include_recent_context_count: number;
}

export interface ImageGenerationConfig {
  enabled: boolean;
  active_provider_id: string;
  providers: ImageGenerationProvider[];
  defaults: ImageGenerationDefaults;
  can_admin?: boolean;
}

export interface ImageGenerationResult {
  image_url: string;
  provider_id: string;
  model?: string | null;
  metadata: Record<string, unknown>;
  prompt?: string | null;
  revised_prompt?: string | null;
}

export interface ImageGenerationTestResponse {
  status: string;
  image: ImageGenerationResult;
}

export interface ImageGenerationMessageResponse {
  status: string;
  image: ImageGenerationResult;
  updated_message: {
    id: string | number;
    role: 'user' | 'assistant' | 'system';
    content: string;
    model?: string | null;
    created_at?: string;
    tokens?: number;
    branch_id?: string | null;
    short_title?: string | null;
    /**
     * [P1.3] 服务端媒体快照（`extra.media` 三键）。
     * 前端拿到后**整组替换**本地占位 —— 服务端是唯一权威，本地不做字段拼接。
     */
    media?: import('@/lib/messageMedia').MediaItem[];
    media_index?: number;
    media_display?: string;
  };
}
