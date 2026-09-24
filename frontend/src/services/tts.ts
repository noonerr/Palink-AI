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

/**
 * 单条消息的语音播放状态（供工具栏按钮渲染三态）。
 * idle=未播、loading=合成中（可能几十秒）、playing=播放中、paused=已暂停。
 */
export type TtsMessageStatus = 'idle' | 'loading' | 'playing' | 'paused';

/** 按消息点播的参数（音色绑定 / 角色）。 */
export interface PlayMessageOptions {
  voiceDescription?: string | null;
  role?: 'character' | 'narrator';
  characterId?: string;
  bindingOverride?: Partial<TTSBindingPayload>;
}

/**
 * 缓存条目：一条消息只留一个条目，正文变了（编辑 / 换候选）就作废重取。
 * 合成结果分三类，都要缓存——否则「再点同一条无新请求」会被
 * api.tts.synthesize 那次元数据探测请求破坏（浏览器语音分支根本没有音频 blob）。
 */
type TtsSegmentPart =
  | { kind: 'browser'; text: string; gender: string }
  | { kind: 'blob'; blob: Blob };

type TtsCacheEntry =
  | { fingerprint: string; kind: 'blob'; blob: Blob }
  | { fingerprint: string; kind: 'browser'; text: string; gender: string }
  /** 分段模式：一条消息的多段音频/浏览器语音，按顺序播完即整条结束。 */
  | { fingerprint: string; kind: 'segments'; parts: TtsSegmentPart[] };

/** 缓存条数上限：实测单条最长约 11 MB，不设上限长会话会失控。 */
const TTS_CACHE_LIMIT = 20;

class TTSService {
  private audioElement: HTMLAudioElement | null = null;
  private isPlaying = false;
  private currentProviderId = 'browser';
  private currentObjectUrl: string | null = null;
  private abortController: AbortController | null = null;
  private _segmentedPlayback: boolean | null = null;

  // [TTS-P3] 按消息点播所需的状态与缓存。放在类内而非 React state，
  // 避免把播放状态经 prop 下发（那会破坏 Message 的 memo 收益）。
  private activeMessageId: string | null = null;
  private activeStatus: TtsMessageStatus = 'idle';
  private readonly statusListeners = new Set<() => void>();
  /** Map 的插入顺序即 LRU 顺序，最近使用过的会重新插入到末尾。 */
  private readonly blobCache = new Map<string, TtsCacheEntry>();

  // [TTS 复核] 分段序列播放：序列期间音频元素的生命周期由 playSegmentParts 收尾，
  // 全局 ended/error 监听必须让位，否则每段之间都会闪一次 idle（按钮图标抖动）。
  private sequenceActive = false;
  private sequenceFailed = false;
  /** stop() 时释放 awaitPlaybackEnd，避免强停后序列仍挂在 await 上。 */
  private pendingPlaybackEnd: (() => void) | null = null;

  constructor() {
    this.audioElement = new Audio();
    this.audioElement.addEventListener('ended', () => {
      this.isPlaying = false;
      if (this.sequenceActive) return;
      this.abortController = null;
      this.revokeCurrentObjectUrl();
      this.setStatus(null, 'idle');
    });
    this.audioElement.addEventListener('error', (e) => {
      console.error('TTS audio error:', e);
      this.isPlaying = false;
      if (this.sequenceActive) {
        // 交给序列循环统一收敛：逐段弹窗会刷屏，且状态该由循环决定
        this.sequenceFailed = true;
        return;
      }
      this.abortController = null;
      this.revokeCurrentObjectUrl();
      this.setStatus(null, 'idle');
      toast.error('语音播放失败');
    });
  }

  // ============================================================
  // [TTS-P3] 播放状态（可订阅）+ 按消息音频缓存
  // ============================================================

  /** 当前正在加载/播放的那条消息的 id；未播任何东西时为 null。 */
  getActiveMessageId(): string | null {
    return this.activeMessageId;
  }

  getStatus(messageId: string | number): TtsMessageStatus {
    const key = String(messageId);
    return this.activeMessageId === key ? this.activeStatus : 'idle';
  }

  /** 供 useSyncExternalStore 订阅；返回值是取消订阅函数。 */
  subscribe(listener: () => void): () => void {
    this.statusListeners.add(listener);
    return () => {
      this.statusListeners.delete(listener);
    };
  }

  private setStatus(messageId: string | null, status: TtsMessageStatus): void {
    this.activeStatus = status;
    // idle 表示「没有任何东西在播/在等」，此时不该再持有归属消息
    this.activeMessageId = status === 'idle' ? null : messageId;
    this.statusListeners.forEach((listener) => listener());
  }

  private notifyIfActive(messageId: string, status: TtsMessageStatus): void {
    if (this.activeMessageId === messageId) this.setStatus(messageId, status);
  }

  /**
   * 正文指纹：编辑消息或切换候选后 content 会变，但 message.id 不变，
   * 只按 messageId 缓存会播出旧音频。用长度 + 首尾片段判定足够便宜且够用。
   */
  private fingerprintOf(text: string): string {
    return `${text.length}:${text.slice(0, 64)}:${text.slice(-64)}`;
  }

  private cacheGet(messageId: string, text: string): TtsCacheEntry | null {
    const entry = this.blobCache.get(messageId);
    if (!entry) return null;
    if (entry.fingerprint !== this.fingerprintOf(text)) {
      this.blobCache.delete(messageId);
      return null;
    }
    // 命中即标记为最近使用：删掉再插回末尾
    this.blobCache.delete(messageId);
    this.blobCache.set(messageId, entry);
    return entry;
  }

  private cacheSet(messageId: string, entry: TtsCacheEntry): void {
    this.blobCache.delete(messageId);
    this.blobCache.set(messageId, entry);
    while (this.blobCache.size > TTS_CACHE_LIMIT) {
      const oldest = this.blobCache.keys().next();
      if (oldest.done) break;
      this.blobCache.delete(oldest.value);
    }
  }

  /** 清空缓存（退出会话 / 测试用）。 */
  clearCache(): void {
    this.blobCache.clear();
  }

  getCacheSize(): number {
    return this.blobCache.size;
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
    // [TTS-P3] 正文可能仍带 HTML 标签（角色卡的富文本 / 内联样式），
    // 直接送合成会把标签念出来。只剔「< 紧跟字母或 /」的成对标签形态，
    // 避免误伤「3 < 5」这类正文里的裸小于号。
    cleanText = cleanText.replace(/<\/?[A-Za-z][^<>]*>/g, '');
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

  /**
   * [TTS-P3] 只负责「把音频字节拿到手」，不负责播放——拆开之后
   * 点播路径可以先查缓存，429 也能被单独识别成人话。
   */
  private async requestAudioBlob(
    text: string,
    opts: {
      voiceDescription?: string;
      role: 'character' | 'narrator';
      characterId?: string;
      bindingOverride?: Partial<TTSBindingPayload>;
      preview?: boolean;
      signal?: AbortSignal;
    },
  ): Promise<Blob> {
    const baseUrl = window.location.origin;
    const response = await fetch(`${baseUrl}${opts.preview ? '/api/tts/preview/audio' : '/api/tts/audio'}`, {
      method: 'POST',
      credentials: 'include',
      signal: opts.signal,
      headers: {
        'Content-Type': 'application/json',
        // [CSRF] N8-c 终态后手动 fetch 通道补 X-CSRF-Token 头
        ...(getCsrfToken() ? { 'X-CSRF-Token': getCsrfToken() } : {}),
      },
      body: JSON.stringify({
        text,
        voice_description: opts.voiceDescription,
        is_narrator: opts.role === 'narrator',
        role: opts.role,
        character_id: opts.characterId,
        binding_override: opts.bindingOverride,
      }),
    });

    if (!response.ok) {
      const errorData = await response.json().catch(() => ({}));
      // [TTS-P3] 后端 /api/tts/audio 挂了 enforce_rate_limit（tts.py:401），
      // 连点会吃 429。这里翻成人话，不让用户只看到「请求失败 (429)」。
      if (response.status === 429) {
        const retryAfter = response.headers.get('Retry-After');
        throw new Error(
          retryAfter
            ? `语音合成太频繁，请稍后再试（约 ${retryAfter} 秒后可重试）`
            : '语音合成太频繁，请稍后再试',
        );
      }
      throw new Error(errorData.detail || `请求失败 (${response.status})`);
    }

    return await response.blob();
  }

  /** 播放一个已到手的 blob。播放「开始」即 resolve，结束由 ended 监听收尾。 */
  private async playBlob(audioBlob: Blob, signal?: AbortSignal): Promise<void> {
    if (signal?.aborted) return;
    const audioUrl = URL.createObjectURL(audioBlob);
    if (!this.audioElement) {
      URL.revokeObjectURL(audioUrl);
      throw new Error('音频元素未初始化');
    }
    this.revokeCurrentObjectUrl();
    this.currentObjectUrl = audioUrl;
    this.audioElement.src = audioUrl;
    this.isPlaying = true;
    await this.audioElement.play();
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
    const effectiveSignal = signal ?? this.abortController?.signal;
    try {
      const audioBlob = await this.requestAudioBlob(text, {
        voiceDescription,
        role,
        characterId,
        bindingOverride,
        preview,
        signal: effectiveSignal,
      });
      if (effectiveSignal?.aborted) return;
      await this.playBlob(audioBlob, effectiveSignal);
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
        // 序列播放期间不能清 abortController：它是「本次播放仍归我控制」的凭证，
        // 清掉会让序列在下一段的 interrupted() 检查里误判成已被打断（表现为只播第一段）。
        if (!this.sequenceActive) this.abortController = null;
        resolve();
      };

      utterance.onerror = (e) => {
        this.isPlaying = false;
        if (!this.sequenceActive) this.abortController = null;
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
    // 分段序列若正等在某段的 ended 上，先释放它——否则这个 await 永远不会回头
    this.pendingPlaybackEnd?.();
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
    // [TTS-P3] stop 之后不该再有任何消息显示为加载中/播放中
    this.setStatus(null, 'idle');
  }

  /** [TTS-P3] 暂停当前播放（工具栏按钮「播放中可暂停」）。 */
  pause(): void {
    if (this.audioElement && this.audioElement.src && !this.audioElement.paused) {
      this.audioElement.pause();
    }
    if ('speechSynthesis' in window) {
      window.speechSynthesis.pause();
    }
    this.isPlaying = false;
    if (this.activeMessageId) this.setStatus(this.activeMessageId, 'paused');
  }

  /** [TTS-P3] 续播被暂停的那条。 */
  resume(): void {
    if (this.audioElement && this.audioElement.src && this.audioElement.paused) {
      void this.audioElement.play();
      this.isPlaying = true;
    }
    if ('speechSynthesis' in window) {
      window.speechSynthesis.resume();
    }
    if (this.activeMessageId) this.setStatus(this.activeMessageId, 'playing');
  }

  /**
   * [TTS-P3] 按消息点播：同一条 → 播放/暂停切换；换一条 → 先停旧的再播。
   *
   * 这条路径必须做到两件事，缺一个验收就过：
   * 1. 同一时刻只有一条在播——`stop()` 是显式调用的，不靠「都是单例所以天然互斥」；
   * 2. 命中缓存就一个请求都不发——**包括 `api.tts.synthesize` 那次元数据探测**，
   *    所以浏览器语音分支的结果也要进缓存（它压根没有音频 blob）。
   */
  async playMessage(
    messageId: string | number,
    text: string,
    options: PlayMessageOptions = {},
  ): Promise<void> {
    const key = String(messageId);

    if (this.activeMessageId === key) {
      // 合成中重复点：忽略。否则会走下面的 stop() 再重新发起，用户连点就反复重来。
      if (this.activeStatus === 'loading') return;
      if (this.activeStatus === 'playing') {
        this.pause();
        return;
      }
      if (this.activeStatus === 'paused') {
        this.resume();
        return;
      }
    }

    const cleanText = this.cleanTextForTTS(text);
    if (!cleanText) {
      toast.warning('没有可播放的内容');
      return;
    }

    // 换一条：先停干净。两段叠播正是「两份单例」时代留下的坑，这里显式断掉。
    this.stop();

    const role = options.role ?? 'character';
    const controller = new AbortController();
    this.abortController = controller;
    this.setStatus(key, 'loading');

    try {
      let entry = this.cacheGet(key, cleanText);

      if (!entry) {
        // [TTS 复核] 分段开关此前只作用于 legacy `speak()`，而点播路径完全不认它
        // ——配置项形同虚设。这里接上：开启后按段落逐段合成播放（每段一次付费请求），
        // 关闭时仍是「一次请求念全文」。默认关闭（backend/data/tts_config.json）。
        if (this.segmentedPlayback) {
          await this.playSegmentedMessage(key, cleanText, role, options, controller);
          return;
        }
        entry = await this.buildSingleEntry(cleanText, role, options, controller);
        if (!entry) return;
        this.cacheSet(key, entry);
      }

      if (controller.signal.aborted || this.abortController !== controller) return;

      if (entry.kind === 'segments') {
        await this.playSegmentParts(key, entry.parts, controller);
        return;
      }

      if (entry.kind === 'browser') {
        this.setStatus(key, 'playing');
        await this.speakWithWebSpeechAPI(entry.text, entry.gender);
        this.notifyIfActive(key, 'idle');
        return;
      }

      this.setStatus(key, 'playing');
      await this.playBlob(entry.blob, controller.signal);
    } catch (error: unknown) {
      if (error instanceof DOMException && error.name === 'AbortError') return;
      // 用户已经切到别的消息（stop 会清空 activeMessageId）→ 这是主动打断，
      // 不是故障：浏览器语音被打断会以 onerror 形式 reject，不能弹错误。
      if (this.activeMessageId !== key) return;
      console.error('TTS playMessage error:', error);
      toast.error(this.friendlyErrorMessage(error));
      this.notifyIfActive(key, 'idle');
      this.revokeCurrentObjectUrl();
    }
  }

  /**
   * 单段（默认）路径：一次元数据探测 + 一次音频请求念全文。
   * 返回 null 表示中途被打断（调用方直接收工，不写缓存）。
   */
  private async buildSingleEntry(
    cleanText: string,
    role: 'character' | 'narrator',
    options: PlayMessageOptions,
    controller: AbortController,
  ): Promise<TtsCacheEntry | null> {
    const meta = await api.tts.synthesize(
      cleanText,
      options.voiceDescription || undefined,
      role === 'narrator',
      role,
      options.characterId,
      options.bindingOverride,
      { signal: controller.signal },
    );
    if (controller.signal.aborted || this.abortController !== controller) return null;

    this.currentProviderId = meta.provider_id || 'browser';
    if ((meta.engine_type || meta.provider_id) === 'browser') {
      return {
        fingerprint: this.fingerprintOf(cleanText),
        kind: 'browser',
        text: meta.text || cleanText,
        gender: meta.gender,
      };
    }

    const blob = await this.requestAudioBlob(cleanText, {
      voiceDescription: options.voiceDescription || undefined,
      role,
      characterId: options.characterId,
      bindingOverride: options.bindingOverride,
      signal: controller.signal,
    });
    return { fingerprint: this.fingerprintOf(cleanText), kind: 'blob', blob };
  }

  /**
   * 分段路径：逐段「合成 → 播 → 等这一段播完」。
   *
   * 与单段路径的语义差别：单段时后端 `extract_dialogue_for_tts` 只念引号内对白、
   * 旁白被丢弃；分段后旁白也会念出来（这就是这个开关存在的意义）。
   * 代价是**请求数 = 段数**，故默认关闭（backend/data/tts_config.json）。
   *
   * 刻意**不预取全部段**：首段就绪即出声，不让用户等完整条合成。
   * 也因此缓存要等整条播完才写——被打断的半成品不写，下次重点时重新合成。
   */
  private async playSegmentedMessage(
    key: string,
    cleanText: string,
    role: 'character' | 'narrator',
    options: PlayMessageOptions,
    controller: AbortController,
  ): Promise<void> {
    const segments = this.parseSegments(cleanText);
    const parts: TtsSegmentPart[] = [];

    await this.runSequence(key, controller, async () => {
      for (const segment of segments) {
        if (this.interrupted(controller)) return false;
        const segmentRole: 'character' | 'narrator' = segment.type === 'dialogue' ? role : 'narrator';
        const characterId = segment.characterId ?? options.characterId;

        const meta = await api.tts.synthesize(
          segment.text,
          options.voiceDescription || undefined,
          segmentRole === 'narrator',
          segmentRole,
          characterId,
          options.bindingOverride,
          { signal: controller.signal },
        );
        if (this.interrupted(controller)) return false;

        this.currentProviderId = meta.provider_id || 'browser';
        let part: TtsSegmentPart;
        if ((meta.engine_type || meta.provider_id) === 'browser') {
          part = { kind: 'browser', text: meta.text || segment.text, gender: meta.gender };
        } else {
          const blob = await this.requestAudioBlob(segment.text, {
            voiceDescription: options.voiceDescription || undefined,
            role: segmentRole,
            characterId,
            bindingOverride: options.bindingOverride,
            signal: controller.signal,
          });
          if (this.interrupted(controller)) return false;
          part = { kind: 'blob', blob };
        }

        parts.push(part);
        await this.playOnePart(key, part, controller);
        if (this.interrupted(controller)) return false;
        if (this.sequenceFailed) return 'failed';
      }

      this.cacheSet(key, {
        fingerprint: this.fingerprintOf(cleanText),
        kind: 'segments',
        parts,
      });
      return true;
    });
  }

  /** 播放已缓存的分段结果（命中缓存时走这条，零请求）。 */
  private async playSegmentParts(
    key: string,
    parts: TtsSegmentPart[],
    controller: AbortController,
  ): Promise<void> {
    await this.runSequence(key, controller, async () => {
      for (const part of parts) {
        await this.playOnePart(key, part, controller);
        if (this.interrupted(controller)) return false;
        if (this.sequenceFailed) return 'failed';
      }
      return true;
    });
  }

  /**
   * 序列外壳：状态收尾（idle / 清标志 / 回收 blob 地址）只在这里写一遍，
   * 两条分段入口共用。**必须**保证无论正常播完、被 stop() 打断、还是某段解码
   * 失败，都不会把按钮卡在 playing —— 「状态会不会卡住」是 P3 验收三问之一。
   */
  private async runSequence(
    key: string,
    controller: AbortController,
    body: () => Promise<boolean | 'failed'>,
  ): Promise<void> {
    this.sequenceActive = true;
    this.sequenceFailed = false;
    try {
      const result = await body();
      if (result === 'failed') toast.error('语音播放失败');
    } catch (error: unknown) {
      if (!this.interrupted(controller)) {
        console.error('TTS segmented playback error:', error);
        toast.error(this.friendlyErrorMessage(error));
      }
    } finally {
      // 只有仍持有控制权的序列才做收尾：被 stop()/换条打断时，新那条可能已经
      // 接管了音频元素，这里再去 revoke / 清标志会把**新的**播放弄坏。
      if (this.abortController === controller) {
        this.sequenceActive = false;
        this.sequenceFailed = false;
        this.pendingPlaybackEnd = null;
        this.revokeCurrentObjectUrl();
        this.abortController = null;
      }
      this.notifyIfActive(key, 'idle');
    }
  }

  /** 播一段并等它结束（音频等 ended；浏览器语音本身 await 到 onend）。 */
  private async playOnePart(
    key: string,
    part: TtsSegmentPart,
    controller: AbortController,
  ): Promise<void> {
    this.setStatus(key, 'playing');
    if (part.kind === 'browser') {
      await this.speakWithWebSpeechAPI(part.text, part.gender);
      return;
    }
    await this.playBlob(part.blob, controller.signal);
    // 被 stop() 打断时 playBlob 会直接返回（signal 已 abort），此时**没有**
    // ended 事件会来——不等了，否则这个 await 永远不回头。
    if (this.interrupted(controller)) return;
    await this.awaitPlaybackEnd();
  }

  /** 本序列是否已失去控制权（被 stop() 或被别的消息接管）。 */
  private interrupted(controller: AbortController): boolean {
    return controller.signal.aborted || this.abortController !== controller;
  }

  /** 等当前音频自然播完（ended）或出错（error）；stop() 会主动释放。 */
  private awaitPlaybackEnd(): Promise<void> {
    const element = this.audioElement;
    if (!element) return Promise.resolve();
    return new Promise((resolve) => {
      const finish = () => {
        element.removeEventListener('ended', finish);
        element.removeEventListener('error', finish);
        this.pendingPlaybackEnd = null;
        resolve();
      };
      this.pendingPlaybackEnd = finish;
      element.addEventListener('ended', finish);
      element.addEventListener('error', finish);
    });
  }

  /**
   * [TTS 复核] 把底层异常翻成人话。
   *
   * `fetch` 在网络层失败时抛的是 `TypeError: Failed to fetch` / Safari 的
   * `Load failed`——直接把 message 弹给用户等于没提示（用户看不懂，也不知道
   * 该重试还是该改配置）。这里统一成中文，其余保持后端给的原文（后端文案
   * 已经是人话，例如「语音合成太频繁，请稍后再试（约 30 秒后可重试）」）。
   */
  private friendlyErrorMessage(error: unknown): string {
    const raw = error instanceof Error ? error.message : '';
    if (!raw) return '语音合成失败';
    if (/failed to fetch|load failed|networkerror|network request failed/i.test(raw)) {
      return '网络异常，语音加载失败，请检查网络后重试';
    }
    return raw;
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
