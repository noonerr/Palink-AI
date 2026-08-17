import * as React from 'react';

import { Button } from '@/components/ui/button';
import { usePushToTalk } from '@/hooks/usePushToTalk';
import { cn } from '@/lib/utils';

export interface PushToTalkButtonProps
  extends Omit<
    React.ComponentProps<typeof Button>,
    | 'onPointerDown'
    | 'onPointerUp'
    | 'onPointerLeave'
    | 'onPointerCancel'
    | 'onKeyDown'
    | 'onKeyUp'
    | 'onError'
    | 'children'
    | 'asChild'
  > {
  /** 语言代码，默认 "zh" */
  language?: string;
  /** 转录完成回调 */
  onTranscript?: (text: string) => void;
  /** 错误回调 */
  onError?: (message: string) => void;
  /** 未录音时按钮文本 */
  label?: string;
  /** 录音中按钮文本 */
  recordingLabel?: string;
  /** 转录中按钮文本 */
  transcribingLabel?: string;
}

/* ── 波形 / 红点动画样式（仅注入一次，避免修改全局 CSS） ── */
const WAVEFORM_STYLE_ID = 'palink-ptt-waveform-style';

function injectWaveformStyle(): void {
  if (typeof document === 'undefined') return;
  if (document.getElementById(WAVEFORM_STYLE_ID)) return;
  const style = document.createElement('style');
  style.id = WAVEFORM_STYLE_ID;
  style.textContent = `
@keyframes palink-ptt-wave {
  0%, 100% { transform: scaleY(0.35); }
  50% { transform: scaleY(1); }
}
@keyframes palink-ptt-pulse {
  0%, 100% { opacity: 1; transform: scale(1); }
  50% { opacity: 0.45; transform: scale(0.8); }
}
`;
  document.head.appendChild(style);
}

injectWaveformStyle();

const WAVE_BARS = [0, 1, 2, 3, 4];

/**
 * Push-to-talk 按钮：按下开始录音，松开停止并转录。
 * 录音中显示波形动画与红点，转录中显示加载指示。
 */
export function PushToTalkButton({
  language = 'zh',
  onTranscript,
  onError,
  label = '按住说话',
  recordingLabel = '松开结束',
  transcribingLabel = '识别中…',
  className,
  disabled,
  variant = 'outline',
  size = 'sm',
  ...rest
}: PushToTalkButtonProps) {
  const { isRecording, isTranscribing, transcript, error, startRecording, stopRecording } =
    usePushToTalk({ language });

  const pressedRef = React.useRef(false);

  // 转录结果回调
  React.useEffect(() => {
    if (transcript) {
      onTranscript?.(transcript);
    }
  }, [transcript, onTranscript]);

  // 错误回调
  React.useEffect(() => {
    if (error) {
      onError?.(error);
    }
  }, [error, onError]);

  const beginRecording = React.useCallback(() => {
    if (disabled || isTranscribing) return;
    pressedRef.current = true;
    void startRecording();
  }, [disabled, isTranscribing, startRecording]);

  const endRecording = React.useCallback(() => {
    if (!pressedRef.current) return;
    pressedRef.current = false;
    stopRecording();
  }, [stopRecording]);

  const handlePointerDown = (e: React.PointerEvent<HTMLButtonElement>) => {
    e.preventDefault();
    beginRecording();
  };

  const handlePointerUp = () => {
    endRecording();
  };

  const handlePointerLeave = () => {
    // 按住状态下指针离开按钮视为松开
    endRecording();
  };

  const handlePointerCancel = () => {
    endRecording();
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLButtonElement>) => {
    if (e.repeat) return;
    if (e.key === ' ' || e.key === 'Enter') {
      e.preventDefault();
      beginRecording();
    }
  };

  const handleKeyUp = (e: React.KeyboardEvent<HTMLButtonElement>) => {
    if (e.key === ' ' || e.key === 'Enter') {
      e.preventDefault();
      endRecording();
    }
  };

  const busy = isTranscribing;

  return (
    <Button
      type="button"
      variant={variant}
      size={size}
      className={cn(
        'select-none touch-none',
        isRecording && 'border-red-500 text-red-500 hover:text-red-500',
        busy && 'pointer-events-none opacity-70',
        className,
      )}
      disabled={disabled}
      aria-label={isRecording ? recordingLabel : label}
      aria-pressed={isRecording}
      onPointerDown={handlePointerDown}
      onPointerUp={handlePointerUp}
      onPointerLeave={handlePointerLeave}
      onPointerCancel={handlePointerCancel}
      onKeyDown={handleKeyDown}
      onKeyUp={handleKeyUp}
      {...rest}
    >
      {busy ? (
        <span className="flex items-center gap-1.5">
          <span
            className="inline-block size-2 rounded-full bg-current"
            style={{ animation: 'palink-ptt-pulse 1s ease-in-out infinite' }}
          />
          {transcribingLabel ? <span className="text-xs">{transcribingLabel}</span> : null}
        </span>
      ) : isRecording ? (
        <span className="flex items-center gap-1.5">
          <span className="flex items-end gap-0.5 h-4" aria-hidden="true">
            {WAVE_BARS.map((i) => (
              <span
                key={i}
                className="block w-0.5 rounded-full bg-current"
                style={{
                  height: '100%',
                  transformOrigin: 'bottom',
                  animation: `palink-ptt-wave 0.9s ease-in-out ${i * 0.12}s infinite`,
                }}
              />
            ))}
          </span>
          {recordingLabel ? <span className="text-xs">{recordingLabel}</span> : null}
        </span>
      ) : (
        <span className="flex items-center gap-1.5">
          <MicIcon />
          {label ? <span className="text-xs">{label}</span> : null}
        </span>
      )}
    </Button>
  );
}

function MicIcon() {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      className="size-4"
      aria-hidden="true"
    >
      <path d="M12 2a3 3 0 0 0-3 3v7a3 3 0 0 0 6 0V5a3 3 0 0 0-3-3z" />
      <path d="M19 10v2a7 7 0 0 1-14 0v-2" />
      <line x1="12" y1="19" x2="12" y2="22" />
    </svg>
  );
}
