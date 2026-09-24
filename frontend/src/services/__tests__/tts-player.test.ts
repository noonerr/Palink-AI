/**
 * [TTS-P3] 语音点播播放器契约测试
 *
 * 覆盖验收里能自动化的那几条（其余靠真实浏览器冒烟）：
 *   1. 同一时刻只播一条 —— 点 B 时 A 必须停；
 *   2. 再点同一条不产生新网络请求 —— **连 api.tts.synthesize 那次元数据探测也不能重发**；
 *   3. 缓存 LRU 上限 20，最旧的被淘汰；
 *   4. 正文变了（编辑 / 换候选）缓存必须失效，不能播旧音频；
 *   5. 状态机 loading → playing → idle（ended），以及播放中可暂停/续播；
 *   6. 429 要翻成「稍后再试」而不是静默失败；
 *   7. cleanTextForTTS 剥掉 HTML 标签但不误伤正文里的裸小于号。
 *
 * 环境说明：jsdom 不实现 HTMLMediaElement.play/pause、URL.createObjectURL、
 * speechSynthesis，且服务是模块级单例（构造函数在 import 时就会 new Audio() 并
 * 注册 ended/error 监听）。所以桩必须在**动态 import 之前**装好，
 * 见 beforeAll —— 用静态 import 会因为 ESM 提升而先执行模块、桩来不及生效。
 */
const h = vi.hoisted(() => ({
  synthesize: vi.fn(),
  toastError: vi.fn(),
  toastWarning: vi.fn(),
}));

vi.mock('@/services/api', () => ({
  api: { tts: { synthesize: h.synthesize } },
  getCsrfToken: () => 'csrf-test-token',
}));

vi.mock('sonner', () => ({
  toast: { error: h.toastError, warning: h.toastWarning, success: vi.fn(), info: vi.fn() },
}));

import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

type TtsModule = typeof import('@/services/tts');
let ttsService: TtsModule['ttsService'];

const playMock = vi.fn();
const pauseMock = vi.fn();
const mediaListeners = new Map<string, Set<(e: unknown) => void>>();
let fetchMock: ReturnType<typeof vi.fn>;
/** `URL.revokeObjectURL` 桩：用于断言「被打断的旧序列不回收新那条的 blob 地址」。 */
let revokeObjectUrlMock: ReturnType<typeof vi.fn>;

function installMediaStubs(): void {
  Object.defineProperty(HTMLMediaElement.prototype, 'play', {
    configurable: true,
    writable: true,
    value: function playStub(this: HTMLMediaElement) {
      playMock();
      Object.defineProperty(this, 'paused', { configurable: true, value: false });
      return Promise.resolve();
    },
  });
  Object.defineProperty(HTMLMediaElement.prototype, 'pause', {
    configurable: true,
    writable: true,
    value: function pauseStub(this: HTMLMediaElement) {
      pauseMock();
      Object.defineProperty(this, 'paused', { configurable: true, value: true });
    },
  });
  Object.defineProperty(HTMLMediaElement.prototype, 'currentTime', {
    configurable: true,
    writable: true,
    value: 0,
  });
  // 拦下监听注册：单例在 import 时就注册了 ended/error，测试要靠它模拟自然播完
  Object.defineProperty(HTMLMediaElement.prototype, 'addEventListener', {
    configurable: true,
    writable: true,
    value: function addEventListenerStub(type: string, cb: (e: unknown) => void) {
      if (!mediaListeners.has(type)) mediaListeners.set(type, new Set());
      mediaListeners.get(type)!.add(cb);
    },
  });
}

function fireMediaEvent(type: string): void {
  mediaListeners.get(type)?.forEach((cb) => cb({ type }));
}

/** 后端「非浏览器」分支：先探测元数据，再取音频字节。 */
function useBackendProvider(): void {
  h.synthesize.mockResolvedValue({
    provider_id: 'openai',
    engine_type: 'openai',
    text: '正文',
    gender: 'female',
  });
}

function useBrowserProvider(): void {
  h.synthesize.mockResolvedValue({
    provider_id: 'browser',
    engine_type: 'browser',
    text: '正文',
    gender: 'female',
  });
}

function installSpeechSynthesis(): void {
  class FakeUtterance {
    text: string;
    rate = 1;
    pitch = 1;
    volume = 1;
    lang = '';
    voice: unknown = null;
    onstart: (() => void) | null = null;
    onend: (() => void) | null = null;
    onerror: ((e: unknown) => void) | null = null;
    constructor(text: string) {
      this.text = text;
    }
  }
  const synth = {
    speaking: false,
    speak(utterance: FakeUtterance) {
      utterance.onstart?.();
      utterance.onend?.();
    },
    cancel: vi.fn(),
    pause: vi.fn(),
    resume: vi.fn(),
    getVoices: () => [],
  };
  (window as unknown as Record<string, unknown>).SpeechSynthesisUtterance = FakeUtterance;
  (window as unknown as Record<string, unknown>).speechSynthesis = synth;
}

function removeSpeechSynthesis(): void {
  delete (window as unknown as Record<string, unknown>).speechSynthesis;
  delete (window as unknown as Record<string, unknown>).SpeechSynthesisUtterance;
}

beforeAll(async () => {
  installMediaStubs();
  (globalThis.URL as unknown as Record<string, unknown>).createObjectURL = vi.fn(
    () => 'blob:http://localhost/mock',
  );
  revokeObjectUrlMock = vi.fn();
  (globalThis.URL as unknown as Record<string, unknown>).revokeObjectURL = revokeObjectUrlMock;
  const mod = await import('@/services/tts');
  ttsService = mod.ttsService;
});

beforeEach(() => {
  vi.clearAllMocks();
  // 注意：这里**不能**清 mediaListeners —— 服务是模块级单例，ended/error 监听
  // 在 import 时（beforeAll）只注册一次；清掉就等于把单例自己的收尾逻辑删了。
  removeSpeechSynthesis();
  useBackendProvider();
  fetchMock = vi.fn().mockResolvedValue({
    ok: true,
    status: 200,
    headers: { get: () => null },
    blob: async () => new Blob(['audio-bytes']),
  });
  vi.stubGlobal('fetch', fetchMock);
  ttsService.clearCache();
  ttsService.stop();
});

describe('TTS 点播播放器', () => {
  it('点第二条会停掉第一条（同一时刻只播一条）', async () => {
    await ttsService.playMessage('m-a', 'A 的正文');
    expect(ttsService.getStatus('m-a')).toBe('playing');

    const pauseCallsBefore = pauseMock.mock.calls.length;
    await ttsService.playMessage('m-b', 'B 的正文');

    expect(pauseMock.mock.calls.length).toBeGreaterThan(pauseCallsBefore);
    expect(ttsService.getStatus('m-a')).toBe('idle');
    expect(ttsService.getStatus('m-b')).toBe('playing');
  });

  it('播放结束后状态回到 idle', async () => {
    await ttsService.playMessage('m-a', 'A 的正文');
    expect(ttsService.getStatus('m-a')).toBe('playing');
    fireMediaEvent('ended');
    expect(ttsService.getStatus('m-a')).toBe('idle');
  });

  it('再点同一条不产生新请求（连元数据探测都不重发）', async () => {
    await ttsService.playMessage('m-a', 'A 的正文');
    const fetchAfterFirst = fetchMock.mock.calls.length;
    const synthAfterFirst = h.synthesize.mock.calls.length;
    expect(fetchAfterFirst).toBe(1);
    expect(synthAfterFirst).toBe(1);

    ttsService.stop(); // 模拟播完 / 手动停止
    await ttsService.playMessage('m-a', 'A 的正文');

    expect(fetchMock.mock.calls.length).toBe(fetchAfterFirst);
    expect(h.synthesize.mock.calls.length).toBe(synthAfterFirst);
    expect(playMock.mock.calls.length).toBe(2);
  });

  it('浏览器语音分支同样命中缓存，不再探测元数据', async () => {
    installSpeechSynthesis();
    useBrowserProvider();

    await ttsService.playMessage('m-a', 'A 的正文');
    const synthAfterFirst = h.synthesize.mock.calls.length;
    expect(synthAfterFirst).toBe(1);
    expect(fetchMock.mock.calls.length).toBe(0);

    ttsService.stop();
    await ttsService.playMessage('m-a', 'A 的正文');

    expect(h.synthesize.mock.calls.length).toBe(synthAfterFirst);
    expect(fetchMock.mock.calls.length).toBe(0);
  });

  it('正文变了缓存失效（不会被编辑前的旧音频顶上）', async () => {
    await ttsService.playMessage('m-a', '旧的正文');
    expect(fetchMock.mock.calls.length).toBe(1);

    ttsService.stop();
    await ttsService.playMessage('m-a', '改过之后的正文，内容完全不同');

    expect(fetchMock.mock.calls.length).toBe(2);
  });

  it('缓存条数上限 20，最旧的被淘汰', async () => {
    for (let i = 1; i <= 20; i += 1) {
      await ttsService.playMessage(`m-${i}`, `第 ${i} 条正文`);
    }
    expect(ttsService.getCacheSize()).toBe(20);
    const fetchBeforeEvict = fetchMock.mock.calls.length;

    // 第 21 条挤进来，m-1 应被淘汰
    await ttsService.playMessage('m-21', '第 21 条正文');
    expect(ttsService.getCacheSize()).toBe(20);
    expect(fetchMock.mock.calls.length).toBe(fetchBeforeEvict + 1);

    ttsService.stop();
    const fetchBeforeReplay = fetchMock.mock.calls.length;
    await ttsService.playMessage('m-1', '第 1 条正文');
    expect(fetchMock.mock.calls.length).toBe(fetchBeforeReplay + 1);
  });

  it('播放中点击切到暂停，再点续播', async () => {
    await ttsService.playMessage('m-a', 'A 的正文');
    expect(ttsService.getStatus('m-a')).toBe('playing');

    await ttsService.playMessage('m-a', 'A 的正文');
    expect(ttsService.getStatus('m-a')).toBe('paused');

    await ttsService.playMessage('m-a', 'A 的正文');
    expect(ttsService.getStatus('m-a')).toBe('playing');

    // 三态切换不该触发任何合成请求
    expect(h.synthesize.mock.calls.length).toBe(1);
  });

  it('429 翻成「稍后再试」并回到 idle，不静默失败', async () => {
    fetchMock.mockResolvedValueOnce({
      ok: false,
      status: 429,
      headers: { get: (k: string) => (k === 'Retry-After' ? '30' : null) },
      json: async () => ({ detail: 'rate limited' }),
    });

    await ttsService.playMessage('m-a', 'A 的正文');

    expect(h.toastError).toHaveBeenCalledTimes(1);
    expect(String(h.toastError.mock.calls[0][0])).toContain('稍后再试');
    expect(ttsService.getStatus('m-a')).toBe('idle');
  });

  it('正文含 HTML 标签时剥标签，但不误伤裸小于号', () => {
    expect(ttsService.cleanTextForTTS('<b>你好</b>世界')).toBe('你好世界');
    expect(ttsService.cleanTextForTTS('她说：<br/>走吧')).toBe('她说：走吧');
    expect(ttsService.cleanTextForTTS('这里有 3 < 5 的写法')).toBe('这里有 3 < 5 的写法');
  });

  it('网络层异常翻成中文提示（不把 Failed to fetch 直接弹给用户）', async () => {
    fetchMock.mockRejectedValueOnce(new TypeError('Failed to fetch'));

    await ttsService.playMessage('m-a', 'A 的正文');

    expect(h.toastError).toHaveBeenCalledTimes(1);
    expect(String(h.toastError.mock.calls[0][0])).toContain('网络异常');
    expect(ttsService.getStatus('m-a')).toBe('idle');
  });
});

/**
 * [TTS 复核] 分段播放（`segmented_playback`）在点播路径上的行为。
 *
 * 改之前这个开关**只作用于 legacy `speak()`**，而 `speak()` 已经没有生产调用方
 * ——配置项形同虚设。这里锁定接通后的语义：
 * 每段一次合成请求（成本 = 段数，故默认关闭）、逐段顺序播放、缓存命中不重发、
 * 中途换条能立即打断且不把新那条的播放弄坏。
 */
describe('TTS 分段播放（segmented_playback）', () => {
  beforeEach(() => {
    ttsService.segmentedPlayback = false;
  });

  afterEach(() => {
    ttsService.segmentedPlayback = false;
  });

  it('开启后按段请求并顺序播完（浏览器语音分支：可直接断言段数）', async () => {
    installSpeechSynthesis();
    useBrowserProvider();
    ttsService.segmentedPlayback = true;

    // 三段：旁白 / 对白 / 旁白
    await ttsService.playMessage('m-a', '她笑了。“走吧。”他看着窗外。');

    // 每段一次元数据探测；浏览器分支没有音频字节请求
    expect(h.synthesize.mock.calls.length).toBe(3);
    expect(fetchMock.mock.calls.length).toBe(0);
    expect(ttsService.getStatus('m-a')).toBe('idle');
  });

  it('关闭时仍是一次请求念全文（默认行为不受影响）', async () => {
    installSpeechSynthesis();
    useBrowserProvider();

    await ttsService.playMessage('m-a', '她笑了。“走吧。”他看着窗外。');

    expect(h.synthesize.mock.calls.length).toBe(1);
  });

  it('分段结果同样进缓存：再点同一条零新请求', async () => {
    installSpeechSynthesis();
    useBrowserProvider();
    ttsService.segmentedPlayback = true;

    await ttsService.playMessage('m-a', '她笑了。“走吧。”');
    const first = h.synthesize.mock.calls.length;
    expect(first).toBe(2);

    ttsService.stop();
    await ttsService.playMessage('m-a', '她笑了。“走吧。”');

    expect(h.synthesize.mock.calls.length).toBe(first);
  });

  it('后端音频分支：前一段播完才播下一段（不是叠播）', async () => {
    ttsService.segmentedPlayback = true;

    // 两段：对白 + 旁白
    const done = ttsService.playMessage('m-a', '“A。”中间那句。');

    // 首段就绪即出声（不预取全部段），此时第二段还没开始请求
    await vi.waitFor(() => expect(playMock).toHaveBeenCalledTimes(1));
    expect(fetchMock.mock.calls.length).toBe(1);

    fireMediaEvent('ended'); // 第一段播完
    await vi.waitFor(() => expect(playMock).toHaveBeenCalledTimes(2));

    fireMediaEvent('ended'); // 第二段播完
    await done;

    expect(fetchMock.mock.calls.length).toBe(2);
    expect(ttsService.getStatus('m-a')).toBe('idle');
  });

  it('分段播放中切到别的消息：旧序列立即停，新那条照常播', async () => {
    ttsService.segmentedPlayback = true;

    const first = ttsService.playMessage('m-a', '“A。”中间那句。');
    await vi.waitFor(() => expect(playMock).toHaveBeenCalledTimes(1));

    // m-b 也开着分段：这里不 await 它的完整播完，只看它是否接管了播放
    const second = ttsService.playMessage('m-b', 'B 的正文');
    await vi.waitFor(() => expect(playMock).toHaveBeenCalledTimes(2));
    await first;

    expect(ttsService.getStatus('m-a')).toBe('idle');
    expect(ttsService.getStatus('m-b')).toBe('playing');
    // stop() 回收了 m-a 的 blob 地址（1 次）；被打断的旧序列**不得**再回收一次
    // ——那会把 m-b 正在播的 blob 地址释放掉（真实浏览器里表现为新那条瞬间哑掉）。
    expect(revokeObjectUrlMock.mock.calls.length).toBe(1);

    // 收尾：让 m-b 播完，避免把播放态留给后面的用例
    fireMediaEvent('ended');
    await second;
    expect(ttsService.getStatus('m-b')).toBe('idle');
  });

  it('分段播放中 stop() 不会挂在 await 上（状态能回到 idle）', async () => {
    ttsService.segmentedPlayback = true;

    const done = ttsService.playMessage('m-a', '“A。”中间那句。“B。”');
    await vi.waitFor(() => expect(playMock).toHaveBeenCalledTimes(1));

    ttsService.stop();
    await done;

    expect(ttsService.getStatus('m-a')).toBe('idle');
  });
});
