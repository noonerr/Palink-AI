/**
 * Image Generation - 图像生成集成
 * 基于 SillyTavern 图像生成系统
 */

import { api } from '@/services/api';
import { emitEvent } from '../event-bus';

// ============================================================
// 类型定义
// ============================================================

export enum ImageProvider {
  STABLE_DIFFUSION = 'stable_diffusion',
  DALLE = 'dalle',
  MIDJOURNEY = 'midjourney',
  CUSTOM = 'custom',
}

export interface ImageGenerationConfig {
  provider: ImageProvider;
  model: string;
  width: number;
  height: number;
  steps: number;
  cfgScale: number;
  seed: number;
  negativePrompt: string;
}

export interface ImageGenerationRequest {
  prompt: string;
  negativePrompt?: string;
  width?: number;
  height?: number;
  steps?: number;
  cfgScale?: number;
  seed?: number;
  characterId?: string;
}

export interface ImageGenerationResult {
  url: string;
  seed: number;
  revisedPrompt?: string;
}

// ============================================================
// 默认配置
// ============================================================

const DEFAULT_CONFIG: ImageGenerationConfig = {
  provider: ImageProvider.STABLE_DIFFUSION,
  model: 'stable-diffusion-xl',
  width: 1024,
  height: 1024,
  steps: 30,
  cfgScale: 7,
  seed: -1,
  negativePrompt: '',
};

// ============================================================
// ImageGenerationService 类
// ============================================================

export class ImageGenerationService {
  private config: ImageGenerationConfig;
  private generating = false;

  constructor(config?: Partial<ImageGenerationConfig>) {
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  /**
   * 生成图像
   */
  async generate(request: ImageGenerationRequest): Promise<ImageGenerationResult> {
    if (this.generating) {
      throw new Error('Image generation already in progress');
    }

    this.generating = true;
    emitEvent('imageGeneration:started', { prompt: request.prompt });

    try {
      const response = await api.post<ImageGenerationResult>('/api/images/generate', {
        ...request,
        provider: this.config.provider,
        model: this.config.model,
        width: request.width ?? this.config.width,
        height: request.height ?? this.config.height,
        steps: request.steps ?? this.config.steps,
        cfgScale: request.cfgScale ?? this.config.cfgScale,
        seed: request.seed ?? this.config.seed,
        negativePrompt: request.negativePrompt ?? this.config.negativePrompt,
      });

      if (!response) {
        throw new Error('No response from image generation API');
      }

      emitEvent('imageGeneration:completed', {
        url: response.url,
        seed: response.seed,
      });

      return response;
    } catch (error) {
      emitEvent('imageGeneration:error', { error: String(error) });
      throw error;
    } finally {
      this.generating = false;
    }
  }

  /**
   * 获取生成状态
   */
  isGenerating(): boolean {
    return this.generating;
  }

  /**
   * 更新配置
   */
  updateConfig(config: Partial<ImageGenerationConfig>): void {
    this.config = { ...this.config, ...config };
  }

  /**
   * 获取配置
   */
  getConfig(): ImageGenerationConfig {
    return { ...this.config };
  }

  /**
   * 获取可用模型
   */
  async getModels(): Promise<string[]> {
    try {
      const response = await api.get<{ models: string[] }>('/api/images/models');
      return response?.models ?? [];
    } catch (error) {
      console.error('[ImageGen] Failed to get models:', error);
      return [];
    }
  }

  /**
   * 获取可用采样器
   */
  async getSamplers(): Promise<string[]> {
    try {
      const response = await api.get<{ samplers: string[] }>('/api/images/samplers');
      return response?.samplers ?? [];
    } catch (error) {
      console.error('[ImageGen] Failed to get samplers:', error);
      return [];
    }
  }
}

/**
 * 创建图像生成服务实例
 */
export function createImageGenerationService(config?: Partial<ImageGenerationConfig>): ImageGenerationService {
  return new ImageGenerationService(config);
}

// 导出单例
export const imageGenerationService = new ImageGenerationService();
