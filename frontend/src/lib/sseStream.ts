export async function consumeSseStream(
  res: Response,
  onJson: (json: Record<string, unknown>) => void
): Promise<void> {
  const reader = res.body?.getReader();
  if (!reader) throw new Error('Invalid stream response');

  const decoder = new TextDecoder();
  let buffer = '';

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
          onJson(JSON.parse(data));
        } catch {
          // Keep stream resilient for malformed chunks.
        }
      }
    }
  };

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    processChunk(decoder.decode(value, { stream: true }));
  }

  const tail = decoder.decode();
  if (tail) processChunk(tail);
}

