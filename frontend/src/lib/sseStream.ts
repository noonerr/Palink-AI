export class SseAbortError extends Error {
  constructor(message: string = 'Stream aborted by user') {
    super(message);
    this.name = 'AbortError';
  }
}

export async function consumeSseStream(
  res: Response,
  onJson: (json: Record<string, unknown>) => void
): Promise<{ cancelled: boolean }> {
  const reader = res.body?.getReader();
  if (!reader) throw new Error('Invalid stream response');

  const decoder = new TextDecoder();
  let buffer = '';
  let eventCount = 0;

  const processChunk = (chunk: string) => {
    buffer += chunk;
    const events = buffer.split('\n\n');
    buffer = events.pop() || '';

    for (const event of events) {
      const lines = event.split('\n');
      for (const line of lines) {
        if (!line.startsWith('data:')) continue;

        const data = line.startsWith('data: ') ? line.slice(6).trim() : line.slice(5).trim();
        if (!data || data === '[DONE]') continue;

        try {
          const json = JSON.parse(data);
          eventCount++;
          onJson(json);
        } catch {
          // skip unparseable lines
        }
      }
    }
  };

  const flushBuffer = () => {
    if (!buffer.trim()) return;
    const lines = buffer.split('\n');
    for (const line of lines) {
      if (!line.startsWith('data:')) continue;
      const data = line.startsWith('data: ') ? line.slice(6).trim() : line.slice(5).trim();
      if (!data || data === '[DONE]') continue;
      try {
        const json = JSON.parse(data);
        eventCount++;
        onJson(json);
      } catch {
        // skip unparseable lines
      }
    }
    buffer = '';
  };

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      processChunk(decoder.decode(value, { stream: true }));
    }

    const tail = decoder.decode();
    if (tail) processChunk(tail);

    flushBuffer();
  } catch (e: any) {
    if (e?.name === 'AbortError') {
      return { cancelled: true };
    }
    throw e;
  }

  return { cancelled: false };
}
