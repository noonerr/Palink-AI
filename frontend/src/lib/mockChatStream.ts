const MOCK_REPLY_POOL = [
  "开发者模式已开启。这是一条示例流式回复，用于联调前端交互。你现在看到的是本地模拟输出，不会请求线上模型。",
  "当前为开发者模式演示：消息不会发送给真实模型，系统正在本地分片返回示例文本，方便你验证动画、布局与交互链路。",
  "收到你的输入。这是模拟助手回复：你可以继续提问以测试会话滚动、输入状态、Dock 动效以及移动端页面切换。"
];

const MOCK_SUGGESTION_POOL = [
  "继续返回一段更长的示例",
  "模拟一条包含步骤的回答",
  "再来一条简短回复"
];

function wait(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      cleanup();
      resolve();
    }, ms);

    const onAbort = () => {
      cleanup();
      reject(new DOMException('Aborted', 'AbortError'));
    };

    const cleanup = () => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
    };

    if (signal) {
      if (signal.aborted) {
        cleanup();
        reject(new DOMException('Aborted', 'AbortError'));
        return;
      }
      signal.addEventListener('abort', onAbort);
    }
  });
}

function pickReplyByInput(input: string): string {
  if (!input.trim()) {
    return MOCK_REPLY_POOL[0];
  }
  const hash = Array.from(input).reduce((acc, char) => acc + char.charCodeAt(0), 0);
  return MOCK_REPLY_POOL[hash % MOCK_REPLY_POOL.length];
}

function splitToChunks(content: string): string[] {
  const chunks: string[] = [];
  let index = 0;

  while (index < content.length) {
    const remain = content.length - index;
    const size = remain > 18 ? 6 + Math.floor(Math.random() * 7) : remain;
    chunks.push(content.slice(index, index + size));
    index += size;
  }

  return chunks;
}

export function buildMockSuggestions(): string[] {
  return [...MOCK_SUGGESTION_POOL];
}

export async function streamMockAssistantReply(
  userInput: string,
  onChunk: (chunk: string) => void,
  options?: { signal?: AbortSignal; minDelayMs?: number; maxDelayMs?: number }
): Promise<string> {
  const signal = options?.signal;
  const minDelayMs = options?.minDelayMs ?? 60;
  const maxDelayMs = Math.max(options?.maxDelayMs ?? 140, minDelayMs + 1);
  const fullReply = pickReplyByInput(userInput);
  const chunks = splitToChunks(fullReply);

  for (const chunk of chunks) {
    const delay = minDelayMs + Math.floor(Math.random() * (maxDelayMs - minDelayMs));
    await wait(delay, signal);
    onChunk(chunk);
  }

  return fullReply;
}
