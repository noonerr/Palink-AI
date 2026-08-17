/**
 * TTS 模块入口
 * 基于 SillyTavern TTS 系统
 */

// 导出类型
export type {
  TTSConfig,
  TTSJob,
  TTSVoice,
} from './service';

// 导出枚举
export { TTSProvider } from './service';

// 导出类和实例
export { TTSService, createTTSService } from './service';
import { ttsService } from './service';
export { ttsService };

/**
 * React Hook: useTTS
 */
export function useTTS() {
  return {
    service: ttsService,
    speak: ttsService.speak.bind(ttsService),
    stop: ttsService.stop.bind(ttsService),
    pause: ttsService.pause.bind(ttsService),
    resume: ttsService.resume.bind(ttsService),
    isPlaying: ttsService.isPlaying.bind(ttsService),
    getVoices: ttsService.getVoices.bind(ttsService),
    updateConfig: ttsService.updateConfig.bind(ttsService),
    getConfig: ttsService.getConfig.bind(ttsService),
  };
}
