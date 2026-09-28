/**
 * 与后端 schemas/image_generation.py 的 ImageGenerationProviderType 一一对应。
 * 服务层支持三种，此前这里和后端 schema 都是窄字面量，导致自建 SD WebUI /
 * ComfyUI 的配置存不进去。两处必须同步改，否则 tsc 直接挂。
 */
export type ImageGenerationProviderType = 'openai_compatible' | 'sd_webui' | 'comfyui';

/** 执行位置：server = Palink 后端直连；browser = 任务下发用户浏览器驱动本机服务。 */
export type ImageGenerationExecutionMode = 'server' | 'browser';

/** 出图家族：‘auto’ = 由 checkpoint / 模型名启发推断，其余为手动指定。
 *  取值必须与后端 `image_prompt_service._VALID_FAMILIES` 同步，否则会被归一化回 auto。 */
export type ImageGenerationFamily =
  | 'auto'
  | 'nl'
  | 'danbooru'
  | 'qwen_image'
  | 'flux'
  | 'sdxl'
  | 'pony'
  | 'illustrious'
  | 'noobai';

export interface ImageGenerationProvider {
  id: string;
  name: string;
  type: ImageGenerationProviderType;
  enabled: boolean;
  /** 仅 sd_webui / comfyui 有意义；browser 模式下 base_url 是「用户浏览器视角」地址。 */
  execution?: ImageGenerationExecutionMode;
  base_url: string;
  api_key: string;
  model: string;
  size: string;
  quality?: string | null;
  style?: string | null;
  response_format?: 'auto' | 'b64_json' | 'url' | null;
  timeout_seconds: number;
  /** [AUDIT-2026-09-25] SD/ComfyUI 出图参数（后端 schema 已有，前端此前一直缺）。 */
  negative_prompt?: string;
  steps?: number;
  cfg_scale?: number;
  sampler_name?: string;
  seed?: number;
  /** 家族覆盖：决定提示词口味与 ComfyUI 工作流套。默认 auto。 */
  family?: ImageGenerationFamily;
  /** ComfyUI / SD WebUI 真正加载的模型文件名（这两个服务没有 model 输入框）。 */
  checkpoint_name?: string;
  /** ComfyUI 自定义工作流（API 格式 JSON 文本），非空时覆盖内置模板。 */
  workflow_json?: string;
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

/**
 * 浏览器桥接执行任务（后端 local_image_bridge 下发）。
 * `workflow` 是后端组装好的完整 ComfyUI POST /prompt body，执行器原样提交。
 */
export interface LocalImageTask {
  task_id: string;
  kind: 'comfyui';
  message_kind: 'chat' | 'character';
  session_id?: string | null;
  message_id?: number | null;
  media_id: string;
  prompt: string;
  base_url: string;
  workflow: Record<string, unknown>;
  timeout_ms: number;
  created_at: number;
}
