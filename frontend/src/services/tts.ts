import { api, getCsrfToken } from './api';
import { toast } from 'sonner';
import type { TTSBindingPayload, TTSPreviewRequest, TTSSegment } from '@/types/tts';

interface SpeakOptions {
  voiceDescription?: string | null;
  isNarrator?: boolean;
  role?: 'character' | 'narrator';
  characterId?: string;
  bindingOverride?: Partial<TTSBindingPayload>;
  segmentedPlayback?: boolean;
}

class TTSService {
  private audioElement: HTMLAudioElement | null = null;
  private isPlaying = false;
  private currentProviderId = 'browser';
  private currentObjectUrl: string | null = null;
  private abortController: AbortController | null = null;
  private _segmentedPlayback: boolean | null = null;

  constructor() {
    this.audioElement = new Audio();
    this.audioElement.addEventListener('ended', () => {
      this.isPlaying = false;
      this.abortController = null;
      this.revokeCurrentObjectUrl();
    });
    this.audioElement.addEventListener('error', (e) => {
      console.error('TTS audio error:', e);
      this.isPlaying = false;
      this.abortController = null;
      this.revokeCurrentObjectUrl();
      toast.error('语音播放失败');
    });
  }

  get segmentedPlayback(): boolean {
    if (this._segmentedPlayback !== null) return this._segmentedPlayback;
    const stored = localStorage.getItem('tts_segmented_playback');
    return stored === 'true';
  }

  set segmentedPlayback(value: boolean) {
    this._segmentedPlayback = value;
    localStorage.setItem('tts_segmented_playback', String(value));
  }

  async loadSegmentedPlaybackConfig(): Promise<void> {
    try {
      const config = await api.tts.getConfig();
      const value = !!config.segmented_playback;
      this._segmentedPlayback = value;
      localStorage.setItem('tts_segmented_playback', String(value));
    } catch {
      // fallback to cached value
    }
  }

  extractVoiceDescription(text: string): string | null {
    const cnMatch = text.match(/【(?:声音|语音)[：:]\s*([^】]+)】/);
    if (cnMatch) return cnMatch[1].trim();

    const enMatch = text.match(/\[Voice[：:]\s*([^\]]+)\]/i);
    if (enMatch) return enMatch[1].trim();

    return null;
  }

  cleanTextForTTS(text: string): string {
    let cleanText = text;
    cleanText = cleanText.replace(/【(?:声音|语音)[：:]\s*[^】]+】/g, '');
    cleanText = cleanText.replace(/\[Voice[：:]\s*[^\]]+\]/gi, '');
    cleanText = cleanText.replace(/<state[\s\S]*?<\/state>/gi, '');
    cleanText = cleanText.replace(/\[state\][\s\S]*?\[\/state\]/gi, '');
    cleanText = cleanText.replace(/---[\s\S]*$/g, '');
    return cleanText.trim();
  }

  parseSegments(text: string): TTSSegment[] {
    const cleanText = this.cleanTextForTTS(text);
    if (!cleanText) return [];

    const segments: TTSSegment[] = [];
    const dialogueRegex = /["\u201C]([^"\u201D]+)["\u201D]/g;
    let cursor = 0;
    let match;

    while ((match = dialogueRegex.exec(cleanText)) !== null) {
      if (match.index > cursor) {
        const narration = cleanText.slice(cursor, match.index).trim();
        if (narration) {
          segments.push({ type: 'narration', text: narration });
        }
      }
      segments.push({ type: 'dialogue', text: match[1].trim() });
      cursor = match.index + match[0].length;
    }

    if (cursor < cleanText.length) {
      const remaining = cleanText.slice(cursor).trim();
      if (remaining) {
        segments.push({ type: 'narration', text: remaining });
      }
    }

    if (segments.length === 0 && cleanText.trim()) {
      segments.push({ type: 'narration', text: cleanText.trim() });
    }

    return segments;
  }

  async speak(
    text: string,
    voiceDescription?: string | null,
    isNarrator = false,
    characterId?: string,
    segmentedPlayback?: boolean,
  ): Promise<void> {
    const useSegmented = segmentedPlayback ?? this.segmentedPlayback;
    await this.speakWithOptions(text, {
      voiceDescription,
      isNarrator,
      role: isNarrator ? 'narrator' : 'character',
      characterId,
      segmentedPlayback: useSegmented,
    });
  }

  async speakWithOptions(text: string, options: SpeakOptions = {}): Promise<void> {
    let controller: AbortController | null = null;
    try {
      this.stop();

      const cleanText = this.cleanTextForTTS(text);
      if (!cleanText) {
        toast.warning('没有可播放的内容');
        return;
      }

      const segmentedPlayback = options.segmentedPlayback ?? false;
      controller = new AbortController();
      this.abortController = controller;

      if (segmentedPlayback) {
        await this.speakSegmented(cleanText, options, controller);
        return;
      }

      const role = options.role ?? (options.isNarrator ? 'narrator' : 'character');
      const ttsResult = await api.tts.synthesize(
        cleanText,
        options.voiceDescription || undefined,
        role === 'narrator',
        role,
        options.characterId,
        options.bindingOverride,
        { signal: controller.signal },
      );
      if (controller.signal.aborted || this.abortController !== controller) return;

      this.currentProviderId = ttsResult.provider_id || 'browser';

      if ((ttsResult.engine_type || ttsResult.provider_id) === 'browser') {
        await this.speakWithWebSpeechAPI(ttsResult.text, ttsResult.gender);
      } else {
        await this.speakWithBackendAudio({
          text: cleanText,
          voiceDescription: options.voiceDescription || undefined,
          role,
          characterId: options.characterId,
          bindingOverride: options.bindingOverride,
          signal: controller.signal,
        });
      }
    } catch (error: unknown) {
      if (error instanceof DOMException && error.name === 'AbortError') return;
      console.error('TTS error:', error);
      const msg = error instanceof Error ? error.message : '语音合成失败';
      toast.error(msg);
    } finally {
      if (controller && this.abortController === controller && !this.isPlaying) {
        this.abortController = null;
      }
    }
  }

  private async speakSegmented(cleanText: string, options: SpeakOptions, controller?: AbortController): Promise<void> {
    const segments = this.parseSegments(cleanText);
    if (segments.length === 0) return;

    const activeController = controller ?? this.abortController ?? new AbortController();
    this.abortController = activeController;
    const signal = activeController.signal;

    for (const segment of segments) {
      if (signal.aborted) break;

      const role = segment.type === 'dialogue' ? 'character' : 'narrator';
      const characterId = segment.characterId ?? options.characterId;

      try {
        const ttsResult = await api.tts.synthesize(
          segment.text,
          options.voiceDescription || undefined,
          role === 'narrator',
          role,
          characterId,
          options.bindingOverride,
          { signal },
        );
        if (signal.aborted || this.abortController !== activeController) break;

        this.currentProviderId = ttsResult.provider_id || 'browser';

        if ((ttsResult.engine_type || ttsResult.provider_id) === 'browser') {
          await this.speakWithWebSpeechAPI(ttsResult.text, ttsResult.gender);
        } else {
          await this.speakWithBackendAudio({
            text: segment.text,
            voiceDescription: options.voiceDescription || undefined,
            role,
            characterId,
            bindingOverride: options.bindingOverride,
            signal,
          });
        }
      } catch (error: unknown) {
        if (signal.aborted) break;
        console.warn('Segment TTS failed, skipping:', error);
      }
    }

    if (this.abortController === activeController && !this.isPlaying) {
      this.abortController = null;
    }
  }

  async preview(request: TTSPreviewRequest): Promise<void> {
    this.stop();
    const text = this.cleanTextForTTS(request.text || '这是一段语音试听。今晚的风很轻，我会用这个声音为你朗读角色对白。');
    if (!text) {
      toast.warning('没有可试听的内容');
      return;
    }

    const controller = new AbortController();
    this.abortController = controller;
    const metadata = await api.tts.previewMetadata(
      { ...request, text },
      { signal: controller.signal },
    );
    if (controller.signal.aborted || this.abortController !== controller) return;
    if ((metadata.engine_type || metadata.provider_id) === 'browser') {
      await this.speakWithWebSpeechAPI(metadata.text || text, metadata.gender);
      return;
    }

    await this.speakWithBackendAudio({
      text,
      voiceDescription: request.voice_description,
      role: request.role,
      characterId: request.character_id,
      bindingOverride: request.binding_override,
      preview: true,
      signal: controller.signal,
    });
  }

  private async speakWithBackendAudio({
    text,
    voiceDescription,
    role,
    characterId,
    bindingOverride,
    preview = false,
    signal,
  }: {
    text: string;
    voiceDescription?: string;
    role: 'character' | 'narrator';
    characterId?: string;
    bindingOverride?: Partial<TTSBindingPayload>;
    preview?: boolean;
    signal?: AbortSignal;
  }): Promise<void> {
    try {
      const baseUrl = window.location.origin;
      const response = await fetch(`${baseUrl}${preview ? '/api/tts/preview/audio' : '/api/tts/audio'}`, {
        method: 'POST',
        credentials: 'include',
        signal: signal ?? this.abortController?.signal,
        headers: {
          'Content-Type': 'application/json',
          // [CSRF] N8-c 终态后手动 fetch 通道补 X-CSRF-Token 头
          ...(getCsrfToken() ? { 'X-CSRF-Token': getCsrfToken() } : {}),
        },
        body: JSON.stringify({
          text,
          voice_description: voiceDescription,
          is_narrator: role === 'narrator',
          role,
          character_id: characterId,
          binding_override: bindingOverride,
        }),
      });

      if (!response.ok) {
        const errorData = await response.json().catch(() => ({}));
        throw new Error(errorData.detail || `请求失败 (${response.status})`);
      }

      const audioBlob = await response.blob();
      if ((signal ?? this.abortController?.signal)?.aborted) return;
      const audioUrl = URL.createObjectURL(audioBlob);

      if (this.audioElement) {
        this.revokeCurrentObjectUrl();
        this.currentObjectUrl = audioUrl;
        this.audioElement.src = audioUrl;
        this.isPlaying = true;
        await this.audioElement.play();
      }
    } catch (error: unknown) {
      this.isPlaying = false;
      this.revokeCurrentObjectUrl();
      throw error;
    }
  }

  private speakWithWebSpeechAPI(text: string, gender: string): Promise<void> {
    return new Promise((resolve, reject) => {
      if (!('speechSynthesis' in window)) {
        toast.error('您的浏览器不支持语音合成');
        reject(new Error('Web Speech API not supported'));
        return;
      }

      window.speechSynthesis.cancel();

      const utterance = new SpeechSynthesisUtterance(text);
      const voices = window.speechSynthesis.getVoices();
      if (voices.length > 0) {
        const chineseVoice = voices.find(v => v.lang.includes('zh'));
        utterance.voice = chineseVoice || voices[0];
      }

      utterance.lang = 'zh-CN';
      utterance.rate = 1.0;
      utterance.pitch = gender === 'female' ? 1.2 : 0.8;

      utterance.onstart = () => {
        this.isPlaying = true;
      };

      utterance.onend = () => {
        this.isPlaying = false;
        this.abortController = null;
        resolve();
      };

      utterance.onerror = (e) => {
        this.isPlaying = false;
        this.abortController = null;
        console.error('Speech synthesis error:', e);
        reject(e);
      };

      window.speechSynthesis.speak(utterance);
    });
  }

  stop(): void {
    if (this.abortController) {
      this.abortController.abort();
      this.abortController = null;
    }
    if (this.audioElement) {
      this.audioElement.pause();
      this.audioElement.currentTime = 0;
      this.audioElement.removeAttribute('src');
    }
    if ('speechSynthesis' in window) {
      window.speechSynthesis.cancel();
    }
    this.isPlaying = false;
    this.revokeCurrentObjectUrl();
  }

  isPlayingState(): boolean {
    return this.isPlaying;
  }

  setVoice(_voiceId: string, _gender = 'female'): void {
  }

  getCurrentVoice(): { voiceId: string; gender: string } {
    return { voiceId: '', gender: 'female' };
  }

  private revokeCurrentObjectUrl(): void {
    if (this.currentObjectUrl) {
      URL.revokeObjectURL(this.currentObjectUrl);
      this.currentObjectUrl = null;
    }
  }
}

export const ttsService = new TTSService();
