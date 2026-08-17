/**
 * TTS - 文本转语音集成
 * 基于 SillyTavern TTS 系统
 */

import { api } from '@/services/api';
import { emitEvent } from '../event-bus';

// ============================================================
// 类型定义
// ============================================================

export enum TTSProvider {
  BROWSER = 'browser',
  ELEVENLABS = 'elevenlabs',
  OPENAI = 'openai',
  SILERO = 'silero',
  CUSTOM = 'custom',
}

export interface TTSConfig {
  provider: TTSProvider;
  voice: string;
  rate: number;
  pitch: number;
  volume: number;
  autoPlay: boolean;
}

export interface TTSJob {
  id: string;
  text: string;
  status: 'pending' | 'processing' | 'done' | 'error';
  audioUrl?: string;
  error?: string;
}

export interface TTSVoice {
  id: string;
  name: string;
  language: string;
  gender?: 'male' | 'female' | 'neutral';
}

// ============================================================
// 默认配置
// ============================================================

const DEFAULT_CONFIG: TTSConfig = {
  provider: TTSProvider.BROWSER,
  voice: '',
  rate: 1.0,
  pitch: 1.0,
  volume: 1.0,
  autoPlay: false,
};

// ============================================================
// TTSService 类
// ============================================================

export class TTSService {
  private config: TTSConfig;
  private jobs: Map<string, TTSJob> = new Map();
  private audioElement: HTMLAudioElement | null = null;
  private voices: TTSVoice[] = [];

  constructor(config?: Partial<TTSConfig>) {
    this.config = { ...DEFAULT_CONFIG, ...config };
    this.initAudioElement();
  }

  /**
   * 初始化音频元素
   */
  private initAudioElement(): void {
    if (typeof window !== 'undefined') {
      this.audioElement = new Audio();
      this.audioElement.addEventListener('ended', () => {
        emitEvent('tts:ended', {});
      });
    }
  }

  /**
   * 朗读文本
   */
  async speak(text: string): Promise<void> {
    if (!text) return;

    emitEvent('tts:started', { text });

    switch (this.config.provider) {
      case TTSProvider.BROWSER:
        return this.speakBrowser(text);
      case TTSProvider.ELEVENLABS:
      case TTSProvider.OPENAI:
      case TTSProvider.SILERO:
        return this.speakApi(text);
      default:
        return this.speakBrowser(text);
    }
  }

  /**
   * 浏览器原生TTS
   */
  private speakBrowser(text: string): Promise<void> {
    return new Promise((resolve, reject) => {
      if (!('speechSynthesis' in window)) {
        reject(new Error('Browser TTS not supported'));
        return;
      }

      const utterance = new SpeechSynthesisUtterance(text);
      utterance.rate = this.config.rate;
      utterance.pitch = this.config.pitch;
      utterance.volume = this.config.volume;

      // 查找匹配的语音
      if (this.config.voice) {
        const voices = speechSynthesis.getVoices();
        const matchedVoice = voices.find(v => v.name === this.config.voice);
        if (matchedVoice) {
          utterance.voice = matchedVoice;
        }
      }

      utterance.onend = () => {
        emitEvent('tts:ended', { text });
        resolve();
      };

      utterance.onerror = (event) => {
        emitEvent('tts:error', { error: event.error });
        reject(new Error(event.error));
      };

      speechSynthesis.speak(utterance);
    });
  }

  /**
   * API TTS
   */
  private async speakApi(text: string): Promise<void> {
    try {
      const response = await api.post<{ audioUrl: string }>('/api/tts', {
        text,
        provider: this.config.provider,
        voice: this.config.voice,
        rate: this.config.rate,
        pitch: this.config.pitch,
      });

      if (response?.audioUrl) {
        await this.playAudio(response.audioUrl);
      }
    } catch (error) {
      emitEvent('tts:error', { error: String(error) });
      throw error;
    }
  }

  /**
   * 播放音频
   */
  async playAudio(url: string): Promise<void> {
    if (!this.audioElement) {
      throw new Error('Audio element not initialized');
    }

    return new Promise((resolve, reject) => {
      this.audioElement!.src = url;
      this.audioElement!.volume = this.config.volume;

      this.audioElement!.onended = () => {
        emitEvent('tts:ended', {});
        resolve();
      };

      this.audioElement!.onerror = () => {
        const error = 'Audio playback failed';
        emitEvent('tts:error', { error });
        reject(new Error(error));
      };

      this.audioElement!.play().catch(reject);
    });
  }

  /**
   * 停止播放
   */
  stop(): void {
    if (this.audioElement) {
      this.audioElement.pause();
      this.audioElement.currentTime = 0;
    }

    if ('speechSynthesis' in window) {
      speechSynthesis.cancel();
    }

    emitEvent('tts:stopped', undefined as any);
  }

  /**
   * 暂停播放
   */
  pause(): void {
    if (this.audioElement) {
      this.audioElement.pause();
    }

    if ('speechSynthesis' in window) {
      speechSynthesis.pause();
    }
  }

  /**
   * 恢复播放
   */
  resume(): void {
    if (this.audioElement) {
      this.audioElement.play();
    }

    if ('speechSynthesis' in window) {
      speechSynthesis.resume();
    }
  }

  /**
   * 获取可用语音
   */
  async getVoices(): Promise<TTSVoice[]> {
    if (this.config.provider === TTSProvider.BROWSER) {
      return this.getBrowserVoices();
    }

    try {
      const response = await api.get<{ voices: TTSVoice[] }>('/api/tts/voices');
      return response?.voices ?? [];
    } catch (error) {
      console.error('[TTS] Failed to get voices:', error);
      return [];
    }
  }

  /**
   * 获取浏览器语音
   */
  private getBrowserVoices(): TTSVoice[] {
    if (!('speechSynthesis' in window)) {
      return [];
    }

    const voices = speechSynthesis.getVoices();
    return voices.map(v => ({
      id: v.voiceURI,
      name: v.name,
      language: v.lang,
      gender: undefined,
    }));
  }

  /**
   * 更新配置
   */
  updateConfig(config: Partial<TTSConfig>): void {
    this.config = { ...this.config, ...config };
  }

  /**
   * 获取配置
   */
  getConfig(): TTSConfig {
    return { ...this.config };
  }

  /**
   * 检查是否正在播放
   */
  isPlaying(): boolean {
    if (this.audioElement) {
      return !this.audioElement.paused;
    }

    if ('speechSynthesis' in window) {
      return speechSynthesis.speaking;
    }

    return false;
  }
}

/**
 * 创建TTS服务实例
 */
export function createTTSService(config?: Partial<TTSConfig>): TTSService {
  return new TTSService(config);
}

// 导出单例
export const ttsService = new TTSService();
