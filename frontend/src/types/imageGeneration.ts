export interface ImageGenerationProvider {
  id: string;
  name: string;
  type: 'openai_compatible';
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
  };
}
