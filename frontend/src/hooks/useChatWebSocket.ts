import { useState, useRef, useCallback, useEffect } from 'react';

interface UseChatWebSocketOptions {
  onChunk: (data: { content?: string; reasoning?: string }) => void;
  onDone: (data: { content: string; usage?: Record<string, number> }) => void;
  onSync: (data: { content: string; reasoning?: string; status: 'streaming' | 'done' }) => void;
  onError: (data: { message: string }) => void;
  onSessionId?: (sessionId: string) => void;
  onQueueUpdate?: (data: { type: string; position: number }) => void;
  onMessageImageGenerated?: (data: { message_id: string; content: string }) => void;
  onMessageImageGenerationFailed?: (data: { error: string }) => void;
  onUsage?: () => void;
  onFinalContent?: (data: { content: string; message_id: string | number; variables?: { stat_data?: Record<string, unknown> } & Record<string, unknown> }) => void;
  // PlotLine 阶段推进事件回调
  onPlotLineAdvanced?: (data: { new_stage: { stage_index: number; title: string; summary: string } }) => void;
  // 生成周期回调（供上层在 ws 路径触发 runtime 事件）
  onGenerationStart?: () => void;
  onGenerationEnd?: (content: string) => void;
  onGenerationError?: () => void;
  // slash 命令响应（后端 websocket.py 发送 {"type":"slash_response","response":...}）
  onSlashResponse?: (data: { response: string }) => void;
  // Task 3.4.4: 后端请求前端执行插件 function tool handler
  onToolCallRequest?: (data: { tool_call_id: string; name: string; arguments: unknown }) => void;
}

const MAX_RECONNECT_ATTEMPTS = 10;
const INITIAL_RECONNECT_DELAY = 1000;
const MAX_RECONNECT_DELAY = 30000;
const HEARTBEAT_INTERVAL = 30000;
const HEARTBEAT_TIMEOUT = 10000;
const WS_TICKET_TIMEOUT = 10000;

function getToken(): string | null {
  return localStorage.getItem('palink_token');
}

async function fetchWsTicket(signal?: AbortSignal): Promise<string | null> {
  const token = getToken();
  if (!token) return null;

  try {
    const { protocol, host } = window.location;
    const httpProtocol = protocol === 'https:' ? 'https:' : 'http:';
    const resp = await fetch(`${httpProtocol}//${host}/api/ws/ticket`, {
      method: 'POST',
      signal,
      credentials: 'include',
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
    });
    if (!resp.ok) return null;
    const data = await resp.json();
    return data.ticket || null;
  } catch {
    return null;
  }
}

async function buildWebSocketUrl(sessionType: 'chat' | 'character', signal?: AbortSignal): Promise<string | null> {
  const ticket = await fetchWsTicket(signal);
  if (!ticket) return null;

  const { protocol, host } = window.location;
  const wsProtocol = protocol === 'https:' ? 'wss:' : 'ws:';
  const path = sessionType === 'character' ? '/api/ws/character-chat' : '/api/ws/chat';

  return `${wsProtocol}//${host}${path}?ticket=${encodeURIComponent(ticket)}`;
}

export function useChatWebSocket(options: UseChatWebSocketOptions) {
  const [connected, setConnected] = useState(false);
  const [useWebSocket, setUseWebSocket] = useState(true);

  const wsRef = useRef<WebSocket | null>(null);
  const reconnectTimerRef = useRef<number | null>(null);
  const reconnectAttemptsRef = useRef(0);
  const sessionTypeRef = useRef<'chat' | 'character'>('chat');
  const connectRef = useRef<(sessionType: 'chat' | 'character') => void>(() => {});
  const lastSessionIdRef = useRef<string | null>(null);
  const heartbeatTimerRef = useRef<number | null>(null);
  const heartbeatTimeoutRef = useRef<number | null>(null);
  const connectGenerationRef = useRef(0);
  const ticketAbortRef = useRef<AbortController | null>(null);
  const shouldReconnectRef = useRef(true);

  const optionsRef = useRef(options);
  optionsRef.current = options;

  const clearReconnectTimer = useCallback(() => {
    if (reconnectTimerRef.current !== null) {
      window.clearTimeout(reconnectTimerRef.current);
      reconnectTimerRef.current = null;
    }
  }, []);

  const clearHeartbeat = useCallback(() => {
    if (heartbeatTimerRef.current !== null) {
      window.clearInterval(heartbeatTimerRef.current);
      heartbeatTimerRef.current = null;
    }
    if (heartbeatTimeoutRef.current !== null) {
      window.clearTimeout(heartbeatTimeoutRef.current);
      heartbeatTimeoutRef.current = null;
    }
  }, []);

  const startHeartbeat = useCallback(() => {
    clearHeartbeat();
    heartbeatTimerRef.current = window.setInterval(() => {
      if (wsRef.current?.readyState === WebSocket.OPEN) {
        wsRef.current.send(JSON.stringify({ type: 'ping' }));
        heartbeatTimeoutRef.current = window.setTimeout(() => {
          wsRef.current?.close(4000, 'Heartbeat timeout');
        }, HEARTBEAT_TIMEOUT);
      }
    }, HEARTBEAT_INTERVAL);
  }, [clearHeartbeat]);

  const scheduleReconnect = useCallback(() => {
    if (!shouldReconnectRef.current) return;
    clearReconnectTimer();

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
      connectRef.current(sessionTypeRef.current);
    }, delay);
  }, [clearReconnectTimer]);

  const handleMessage = useCallback((event: MessageEvent) => {
    let data: Record<string, unknown>;
    try {
      data = JSON.parse(event.data);
    } catch {
      return;
    }

    const type = data.type as string;

    if (type === 'pong' || type === 'ping') {
      if (heartbeatTimeoutRef.current !== null) {
        window.clearTimeout(heartbeatTimeoutRef.current);
        heartbeatTimeoutRef.current = null;
      }
      if (type === 'ping') {
        wsRef.current?.send(JSON.stringify({ type: 'pong' }));
      }
      return;
    }

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
        optionsRef.current.onGenerationEnd?.(typeof data.content === 'string' ? data.content : '');
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
        optionsRef.current.onGenerationError?.();
        break;
      case 'session_id':
      case 'session_created':
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
      case 'message_image_generated':
        optionsRef.current.onMessageImageGenerated?.(data as { message_id: string; content: string });
        break;
      case 'message_image_generation_failed':
        optionsRef.current.onMessageImageGenerationFailed?.(data as { error: string });
        break;
      case 'final_content':
        if (typeof data.content === 'string') {
          optionsRef.current.onFinalContent?.({ content: data.content, message_id: typeof data.message_id === 'string' || typeof data.message_id === 'number' ? data.message_id : '', variables: (data as any)?.variables });
        }
        break;
      case 'plotline_advanced':
        // PlotLine 阶段自动推进事件，透传给上层处理
        if (data.new_stage && typeof data.new_stage === 'object') {
          optionsRef.current.onPlotLineAdvanced?.(data as { new_stage: { stage_index: number; title: string; summary: string } });
        }
        break;
      case 'slash_response':
        // slash 命令响应，透传给上层展示为系统消息，不触发 AI 生成流程
        optionsRef.current.onSlashResponse?.({
          response: typeof data.response === 'string' ? data.response : '',
        });
        break;
      case 'tool_call_request':
        // Task 3.4.4: 后端请求前端执行插件 function tool handler
        optionsRef.current.onToolCallRequest?.({
          tool_call_id: typeof data.tool_call_id === 'string' ? data.tool_call_id : '',
          name: typeof data.name === 'string' ? data.name : '',
          arguments: data.arguments,
        });
        break;
    }
  }, []);

  const connect = useCallback((sessionType: 'chat' | 'character') => {
    sessionTypeRef.current = sessionType;
    shouldReconnectRef.current = true;
    setUseWebSocket(true);

    const generation = connectGenerationRef.current + 1;
    connectGenerationRef.current = generation;
    ticketAbortRef.current?.abort();

    const ticketController = new AbortController();
    ticketAbortRef.current = ticketController;
    const ticketTimeout = window.setTimeout(() => {
      ticketController.abort();
    }, WS_TICKET_TIMEOUT);

    buildWebSocketUrl(sessionType, ticketController.signal).then((url) => {
      if (ticketAbortRef.current === ticketController) {
        ticketAbortRef.current = null;
      }
      if (connectGenerationRef.current !== generation || !shouldReconnectRef.current) return;

      if (!url) {
        scheduleReconnect();
        return;
      }

      if (wsRef.current) {
        wsRef.current.close(1000, 'Replacing connection');
        wsRef.current = null;
      }

      clearReconnectTimer();
      clearHeartbeat();

      const ws = new WebSocket(url);
      wsRef.current = ws;

      const isCurrentConnection = () => (
        wsRef.current === ws
        && connectGenerationRef.current === generation
        && shouldReconnectRef.current
      );

      ws.onopen = () => {
        if (!isCurrentConnection()) {
          ws.close(1000, 'Stale connection');
          return;
        }
        reconnectAttemptsRef.current = 0;
        setUseWebSocket(true);
        setConnected(true);
        startHeartbeat();
        if (lastSessionIdRef.current) {
          ws.send(JSON.stringify({ type: 'sync', session_id: lastSessionIdRef.current }));
        }
      };

      ws.onclose = () => {
        if (connectGenerationRef.current !== generation) return;
        setConnected(false);
        if (wsRef.current === ws) {
          wsRef.current = null;
        }
        clearHeartbeat();
        if (shouldReconnectRef.current) {
          scheduleReconnect();
        }
      };

      ws.onerror = () => {
        if (isCurrentConnection()) {
          ws.close();
        }
      };

      ws.onmessage = (event) => {
        if (!isCurrentConnection()) return;
        handleMessage(event);
      };
    }).catch(() => {
      if (connectGenerationRef.current === generation && shouldReconnectRef.current) {
        scheduleReconnect();
      }
    }).finally(() => {
      window.clearTimeout(ticketTimeout);
      if (ticketAbortRef.current === ticketController) {
        ticketAbortRef.current = null;
      }
    });
  }, [clearReconnectTimer, clearHeartbeat, startHeartbeat, scheduleReconnect, handleMessage]);
  connectRef.current = connect;

  const disconnect = useCallback(() => {
    shouldReconnectRef.current = false;
    connectGenerationRef.current += 1;
    ticketAbortRef.current?.abort();
    ticketAbortRef.current = null;
    clearReconnectTimer();
    clearHeartbeat();
    reconnectAttemptsRef.current = MAX_RECONNECT_ATTEMPTS;
    if (wsRef.current) {
      const ws = wsRef.current;
      wsRef.current = null;
      ws.close(1000, 'Client disconnect');
    }
    setConnected(false);
  }, [clearReconnectTimer, clearHeartbeat]);

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

  // Task 3.4.5: 前端执行完插件 handler 后，通过 WebSocket 返回结果给后端
  const sendToolCallResponse = useCallback((params: { tool_call_id: string; result: unknown; session_id?: string }) => {
    if (wsRef.current?.readyState === WebSocket.OPEN) {
      wsRef.current.send(JSON.stringify({ type: 'tool_call_response', ...params }));
    }
  }, []);

  useEffect(() => {
    const handleOnline = () => {
      if (wsRef.current?.readyState !== WebSocket.OPEN) {
        shouldReconnectRef.current = true;
        reconnectAttemptsRef.current = 0;
        connect(sessionTypeRef.current);
      }
    };

    window.addEventListener('online', handleOnline);
    return () => {
      window.removeEventListener('online', handleOnline);
    };
  }, [connect]);

  useEffect(() => {
    return () => {
      shouldReconnectRef.current = false;
      connectGenerationRef.current += 1;
      ticketAbortRef.current?.abort();
      ticketAbortRef.current = null;
      clearReconnectTimer();
      clearHeartbeat();
      if (wsRef.current) {
        const ws = wsRef.current;
        wsRef.current = null;
        ws.close(1000, 'Component unmount');
      }
    };
  }, [clearReconnectTimer, clearHeartbeat]);

  return {
    connected,
    useWebSocket,
    connect,
    disconnect,
    sendChatRequest,
    sendCharacterChatRequest,
    requestSync,
    sendCancel,
    sendToolCallResponse,
  };
}
