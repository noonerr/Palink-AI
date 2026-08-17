/**
 * Image Generation 模块入口
 * 基于 SillyTavern 图像生成系统
 */

// 导出类型
export type {
  ImageGenerationConfig,
  ImageGenerationRequest,
  ImageGenerationResult,
} from './service';

// 导出枚举
export { ImageProvider } from './service';

// 导出类和实例
export { ImageGenerationService, createImageGenerationService } from './service';
import { imageGenerationService } from './service';
export { imageGenerationService };

/**
 * React Hook: useImageGeneration
 */
export function useImageGeneration() {
  return {
    service: imageGenerationService,
    generate: imageGenerationService.generate.bind(imageGenerationService),
    isGenerating: imageGenerationService.isGenerating.bind(imageGenerationService),
    getModels: imageGenerationService.getModels.bind(imageGenerationService),
    getSamplers: imageGenerationService.getSamplers.bind(imageGenerationService),
    updateConfig: imageGenerationService.updateConfig.bind(imageGenerationService),
    getConfig: imageGenerationService.getConfig.bind(imageGenerationService),
  };
}
