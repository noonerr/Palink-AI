export async function consumeSseStream(
  res: Response,
  onJson: (json: Record<string, unknown>) => void
): Promise<void> {
  console.log('[SSE] Starting stream consumption');
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
        if (!line.startsWith('data: ')) continue;

        const data = line.slice(6).trim();
        if (!data || data === '[DONE]') continue;

        try {
        const json = JSON.parse(data);
          eventCount++;
          console.log(`[SSE] Event #${eventCount}:`, json);
          onJson(json);
        } catch (e) {
          console.warn('[SSE] Failed to parse JSON:', data, e);
        }
      }
    }
  };

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      processChunk(decoder.decode(value, { stream: true }));
    }

    const tail = decoder.decode();
    if (tail) processChunk(tail);
  } catch (e: any) {
    if (e?.name === 'AbortError') {
      console.log('[SSE] Stream aborted');
      return;
    }
    throw e;
  }

  console.log(`[SSE] Stream completed. Total events: ${eventCount}`);
}

