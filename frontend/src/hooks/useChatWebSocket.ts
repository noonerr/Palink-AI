import { useState, useRef, useCallback, useEffect } from 'react';

interface UseChatWebSocketOptions {
  onChunk: (data: { content?: string; reasoning?: string }) => void;
  onDone: (data: { content: string; usage?: Record<string, number> }) => void;
  onSync: (data: { content: string; reasoning?: string; status: 'streaming' | 'done' }) => void;
  onError: (data: { message: string }) => void;
  onSessionId?: (sessionId: string) => void;
  onQueueUpdate?: (data: { type: string; position: number }) => void;
}

const MAX_RECONNECT_ATTEMPTS = 10;
const INITIAL_RECONNECT_DELAY = 1000;
const MAX_RECONNECT_DELAY = 30000;

function getToken(): string | null {
  return localStorage.getItem('palink_token');
}

function buildWebSocketUrl(sessionType: 'chat' | 'character'): string | null {
  const token = getToken();
  if (!token) return null;

  const { protocol, host } = window.location;
  const wsProtocol = protocol === 'https:' ? 'wss:' : 'ws:';
  const path = sessionType === 'character' ? '/ws/character-chat' : '/ws/chat';

  return `${wsProtocol}//${host}${path}?token=${encodeURIComponent(token)}`;
}

export function useChatWebSocket(options: UseChatWebSocketOptions) {
  const [connected, setConnected] = useState(false);
  const [useWebSocket, setUseWebSocket] = useState(true);

  const wsRef = useRef<WebSocket | null>(null);
  const reconnectTimerRef = useRef<number | null>(null);
  const reconnectAttemptsRef = useRef(0);
  const sessionTypeRef = useRef<'chat' | 'character'>('chat');
  const lastSessionIdRef = useRef<string | null>(null);

  const optionsRef = useRef(options);
  optionsRef.current = options;

  const clearReconnectTimer = useCallback(() => {
    if (reconnectTimerRef.current !== null) {
      window.clearTimeout(reconnectTimerRef.current);
      reconnectTimerRef.current = null;
    }
  }, []);

  const scheduleReconnect = useCallback(() => {
    if (reconnectAttemptsRef.current >= MAX_RECONNECT_ATTEMPTS) {
      setUseWebSocket(false);
      return;
    }

    const delay = Math.min(
      INITIAL_RECONNECT_DELAY * Math.pow(2, reconnectAttemptsRef.current),
      MAX_RECONNECT_DELAY,
    );
    reconnectAttemptsRef.current += 1;

    reconnectTimerRef.current = window.setTimeout(() => {
      connect(sessionTypeRef.current);
    }, delay);
  }, []);

  const handleMessage = useCallback((event: MessageEvent) => {
    let data: Record<string, unknown>;
    try {
      data = JSON.parse(event.data);
    } catch {
      return;
    }

    const type = data.type as string;

    switch (type) {
      case 'chunk':
        optionsRef.current.onChunk({
          content: typeof data.content === 'string' ? data.content : undefined,
          reasoning: typeof data.reasoning === 'string' ? data.reasoning : undefined,
        });
        break;
      case 'done':
        optionsRef.current.onDone({
          content: typeof data.content === 'string' ? data.content : '',
          usage: data.usage as Record<string, number> | undefined,
        });
        break;
      case 'sync':
        optionsRef.current.onSync({
          content: typeof data.content === 'string' ? data.content : '',
          reasoning: typeof data.reasoning === 'string' ? data.reasoning : undefined,
          status: (data.status as 'streaming' | 'done') ?? 'done',
        });
        break;
      case 'error':
        optionsRef.current.onError({
          message: typeof data.message === 'string' ? data.message : 'Unknown error',
        });
        break;
      case 'ping':
        wsRef.current?.send(JSON.stringify({ type: 'pong' }));
        break;
      case 'session_id':
        if (typeof data.session_id === 'string') {
          lastSessionIdRef.current = data.session_id;
          optionsRef.current.onSessionId?.(data.session_id);
        }
        break;
      case 'queue':
        optionsRef.current.onQueueUpdate?.({
          type: typeof data.queue_type === 'string' ? data.queue_type : type,
          position: typeof data.position === 'number' ? data.position : 0,
        });
        break;
    }
  }, []);

  const connect = useCallback((sessionType: 'chat' | 'character') => {
    sessionTypeRef.current = sessionType;

    const url = buildWebSocketUrl(sessionType);
    if (!url) return;

    if (wsRef.current) {
      wsRef.current.close(1000);
      wsRef.current = null;
    }

    clearReconnectTimer();

    const ws = new WebSocket(url);
    wsRef.current = ws;

    ws.onopen = () => {
      reconnectAttemptsRef.current = 0;
      setConnected(true);
      if (lastSessionIdRef.current) {
        ws.send(JSON.stringify({ type: 'sync', session_id: lastSessionIdRef.current }));
      }
    };

    ws.onclose = () => {
      setConnected(false);
      wsRef.current = null;
      scheduleReconnect();
    };

    ws.onerror = () => {
      ws.close();
    };

    ws.onmessage = handleMessage;
  }, [clearReconnectTimer, scheduleReconnect, handleMessage]);

  const disconnect = useCallback(() => {
    clearReconnectTimer();
    reconnectAttemptsRef.current = MAX_RECONNECT_ATTEMPTS;
    if (wsRef.current) {
      wsRef.current.close(1000);
      wsRef.current = null;
    }
    setConnected(false);
  }, [clearReconnectTimer]);

  const sendChatRequest = useCallback((params: Record<string, unknown>) => {
    if (wsRef.current?.readyState === WebSocket.OPEN) {
      wsRef.current.send(JSON.stringify({ type: 'chat_request', ...params }));
    }
  }, []);

  const sendCharacterChatRequest = useCallback((params: Record<string, unknown>) => {
    if (wsRef.current?.readyState === WebSocket.OPEN) {
      wsRef.current.send(JSON.stringify({ type: 'chat_request', ...params }));
    }
  }, []);

  const requestSync = useCallback((sessionId: string) => {
    if (wsRef.current?.readyState === WebSocket.OPEN) {
      wsRef.current.send(JSON.stringify({ type: 'sync', session_id: sessionId }));
    }
  }, []);

  const sendCancel = useCallback(() => {
    if (wsRef.current?.readyState === WebSocket.OPEN) {
      wsRef.current.send(JSON.stringify({ type: 'cancel' }));
    }
  }, []);

  useEffect(() => {
    return () => {
      clearReconnectTimer();
      if (wsRef.current) {
        wsRef.current.close(1000);
        wsRef.current = null;
      }
    };
  }, [clearReconnectTimer]);

  return {
    connected,
    useWebSocket,
    connect,
    disconnect,
    sendChatRequest,
    sendCharacterChatRequest,
    requestSync,
    sendCancel,
  };
}
