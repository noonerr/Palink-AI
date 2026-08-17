import { useState, useRef, useCallback, useEffect } from 'react';

export interface UsePushToTalkOptions {
  /** 语言代码，默认 "zh" */
  language?: string;
  /** 转录成功后是否清空上一次的 transcript（默认 false） */
  clearOnStart?: boolean;
}

export interface UsePushToTalkReturn {
  isRecording: boolean;
  isTranscribing: boolean;
  transcript: string;
  error: string | null;
  startRecording: () => Promise<void>;
  stopRecording: () => void;
  reset: () => void;
}

/** 选择浏览器支持的录音 MIME 类型 */
function pickMimeType(): string {
  const candidates = [
    'audio/webm;codecs=opus',
    'audio/webm',
    'audio/ogg;codecs=opus',
    'audio/mp4',
  ];
  for (const type of candidates) {
    if (typeof MediaRecorder !== 'undefined' && MediaRecorder.isTypeSupported(type)) {
      return type;
    }
  }
  return 'audio/webm';
}

/** 根据录音 Blob 的 MIME 类型推断文件扩展名 */
function blobExtension(mimeType: string): string {
  if (mimeType.includes('mp4')) return 'm4a';
  if (mimeType.includes('ogg')) return 'ogg';
  if (mimeType.includes('wav')) return 'wav';
  if (mimeType.includes('mpeg')) return 'mp3';
  return 'webm';
}

/**
 * Push-to-talk 语音录入 Hook
 *
 * 使用 MediaRecorder API 录制麦克风音频，停止后自动调用 POST /api/stt 转录。
 * 返回 isRecording / startRecording / stopRecording / transcript / error 等状态。
 */
export function usePushToTalk(options: UsePushToTalkOptions = {}): UsePushToTalkReturn {
  const { language = 'zh', clearOnStart = false } = options;

  const [isRecording, setIsRecording] = useState(false);
  const [isTranscribing, setIsTranscribing] = useState(false);
  const [transcript, setTranscript] = useState('');
  const [error, setError] = useState<string | null>(null);

  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const mediaStreamRef = useRef<MediaStream | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  // 防止组件卸载后异步回调更新状态
  const isMountedRef = useRef(true);

  const cleanupMediaStream = useCallback(() => {
    if (mediaRecorderRef.current && mediaRecorderRef.current.state !== 'inactive') {
      try {
        mediaRecorderRef.current.stop();
      } catch {
        // ignore
      }
    }
    if (mediaStreamRef.current) {
      mediaStreamRef.current.getTracks().forEach((track) => track.stop());
      mediaStreamRef.current = null;
    }
    mediaRecorderRef.current = null;
    chunksRef.current = [];
  }, []);

  useEffect(() => {
    isMountedRef.current = true;
    return () => {
      isMountedRef.current = false;
      // 卸载时释放麦克风资源
      cleanupMediaStream();
    };
  }, [cleanupMediaStream]);

  const transcribe = useCallback(
    async (blob: Blob) => {
      if (!isMountedRef.current) return;
      setIsTranscribing(true);
      setError(null);
      try {
        const token = localStorage.getItem('palink_token');
        const formData = new FormData();
        formData.append('file', blob, `recording.${blobExtension(blob.type)}`);
        formData.append('language', language);

        const response = await fetch('/api/stt', {
          method: 'POST',
          headers: token ? { Authorization: `Bearer ${token}` } : {},
          body: formData,
        });

        if (!response.ok) {
          let detail = `请求失败 (${response.status})`;
          try {
            const body = await response.json();
            detail = body.detail || body.message || detail;
          } catch {
            // ignore parse error
          }
          throw new Error(detail);
        }

        const data = await response.json();
        const text: string = (data?.text ?? '').toString();
        if (isMountedRef.current) {
          setTranscript(text);
        }
      } catch (e) {
        if (!isMountedRef.current) return;
        const msg = e instanceof Error ? e.message : '语音识别失败';
        setError(msg);
      } finally {
        if (isMountedRef.current) {
          setIsTranscribing(false);
        }
      }
    },
    [language],
  );

  const startRecording = useCallback(async () => {
    if (isRecording || isTranscribing) return;
    setError(null);
    if (clearOnStart) {
      setTranscript('');
    }

    if (typeof navigator === 'undefined' || !navigator.mediaDevices?.getUserMedia) {
      setError('当前浏览器不支持麦克风录音');
      return;
    }

    let stream: MediaStream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    } catch (e) {
      const err = e as DOMException;
      if (err.name === 'NotAllowedError' || err.name === 'PermissionDeniedError') {
        setError('麦克风权限被拒绝，请在浏览器设置中允许访问');
      } else if (err.name === 'NotFoundError' || err.name === 'DevicesNotFoundError') {
        setError('未检测到麦克风设备');
      } else {
        setError(err.message || '无法访问麦克风');
      }
      return;
    }

    if (!isMountedRef.current) {
      stream.getTracks().forEach((t) => t.stop());
      return;
    }

    mediaStreamRef.current = stream;
    chunksRef.current = [];

    let recorder: MediaRecorder;
    try {
      recorder = new MediaRecorder(stream, { mimeType: pickMimeType() });
    } catch {
      try {
        recorder = new MediaRecorder(stream);
      } catch (e) {
        stream.getTracks().forEach((t) => t.stop());
        mediaStreamRef.current = null;
        setError(e instanceof Error ? e.message : '录音初始化失败');
        return;
      }
    }

    recorder.ondataavailable = (event: BlobEvent) => {
      if (event.data && event.data.size > 0) {
        chunksRef.current.push(event.data);
      }
    };

    recorder.onstop = () => {
      const chunks = chunksRef.current;
      const mime = recorder.mimeType || 'audio/webm';
      const blob = new Blob(chunks, { type: mime });
      // 释放麦克风资源
      if (mediaStreamRef.current) {
        mediaStreamRef.current.getTracks().forEach((track) => track.stop());
        mediaStreamRef.current = null;
      }
      mediaRecorderRef.current = null;
      chunksRef.current = [];

      if (!isMountedRef.current) return;
      setIsRecording(false);

      if (blob.size === 0) {
        setError('录音内容为空');
        return;
      }
      // 异步转录，不阻塞 onstop
      void transcribe(blob);
    };

    recorder.onerror = () => {
      if (isMountedRef.current) {
        setError('录音过程中发生错误');
        setIsRecording(false);
      }
      cleanupMediaStream();
    };

    mediaRecorderRef.current = recorder;
    try {
      recorder.start();
      setIsRecording(true);
    } catch (e) {
      cleanupMediaStream();
      setError(e instanceof Error ? e.message : '录音启动失败');
    }
  }, [isRecording, isTranscribing, clearOnStart, transcribe, cleanupMediaStream]);

  const stopRecording = useCallback(() => {
    const recorder = mediaRecorderRef.current;
    if (recorder && recorder.state !== 'inactive') {
      try {
        recorder.stop();
      } catch {
        cleanupMediaStream();
        if (isMountedRef.current) setIsRecording(false);
      }
    } else if (isMountedRef.current) {
      setIsRecording(false);
    }
  }, [cleanupMediaStream]);

  const reset = useCallback(() => {
    setTranscript('');
    setError(null);
    setIsTranscribing(false);
  }, []);

  return {
    isRecording,
    isTranscribing,
    transcript,
    error,
    startRecording,
    stopRecording,
    reset,
  };
}
