import React, { useRef, useEffect, useCallback, useState } from 'react';
import type { Character, CharacterChatMessage, User as UserType } from '@/types';

export interface SillyTavernIframeProps {
  character: Character;
  messages: CharacterChatMessage[];
  user: UserType;
  sessionId?: string | null;
  branchId?: string | null;
  selectedModel?: string | null;
  onSendMessage: (content: string) => void;
  isGenerating: boolean;
  useNative?: boolean;
  onBackToPalink?: () => void;
}

export function SillyTavernIframe({
  character,
  messages,
  user,
  sessionId,
  branchId,
  selectedModel,
  onSendMessage,
  isGenerating,
  useNative = false,
  onBackToPalink,
}: SillyTavernIframeProps) {
  const iframeRef = useRef<HTMLIFrameElement>(null);
  const [stReady, setStReady] = useState(false);
  const [nativeStUrl, setNativeStUrl] = useState<string>('');
  const [nativeStError, setNativeStError] = useState<string>('');
  const onSendMessageRef = useRef(onSendMessage);
  onSendMessageRef.current = onSendMessage;

  const sendToST = useCallback((action: string, payload: unknown) => {
    if (iframeRef.current?.contentWindow) {
      iframeRef.current.contentWindow.postMessage(
        { source: 'palink-bridge', action, payload },
        '*',
      );
    }
  }, []);

  useEffect(() => {
    function handleMessage(event: MessageEvent) {
      if (event.data?.source !== 'st-bridge') return;

      switch (event.data.type) {
        case 'ready':
          setStReady(true);
          break;
        case 'sendMessage':
          if (event.data.content && onSendMessageRef.current) {
            onSendMessageRef.current(event.data.content);
          }
          break;
      }
    }

    window.addEventListener('message', handleMessage);
    return () => window.removeEventListener('message', handleMessage);
  }, []);

  useEffect(() => {
    if (!stReady) return;
    sendToST('bootContext', {
      characterId: character.id,
      sessionId,
      branchId,
      model: selectedModel,
    });
  }, [stReady, character.id, sessionId, branchId, selectedModel, sendToST]);

  useEffect(() => {
    if (!stReady) return;
    sendToST('setGenerating', isGenerating);
  }, [stReady, isGenerating, sendToST]);

  useEffect(() => {
    if (!useNative) return;
    let cancelled = false;
    setNativeStError('');
    fetch('/api/st/native/status', {
      headers: {
        Authorization: `Bearer ${localStorage.getItem('palink_token') || ''}`,
      },
    })
      .then(async (res) => {
        if (res.ok) return res.json();
        let detail = '';
        try {
          const payload = await res.json();
          detail = typeof payload?.detail === 'string' ? payload.detail : '';
        } catch {
          detail = '';
        }
        throw new Error(detail || `ST native status request failed (${res.status})`);
      })
      .then((data) => {
        if (!cancelled && data?.url) {
          setNativeStUrl(String(data.url));
        }
      })
      .catch((err) => {
        console.error('Failed to load native ST status:', err);
        if (!cancelled) {
          setNativeStError(err instanceof Error ? err.message : 'SillyTavern native service is unavailable.');
        }
      });
    return () => {
      cancelled = true;
    };
  }, [useNative]);

  const iframeSrc = useNative
    ? (() => {
        if (!nativeStUrl) return '';
        const base = nativeStUrl;
        const token = localStorage.getItem('palink_token') || '';
        const query = new URLSearchParams({
          next: '/',
          palinkToken: token,
          palinkCharacterId: String(character.id),
        });
        if (sessionId) query.set('palinkSessionId', String(sessionId));
        if (branchId) query.set('palinkBranchId', String(branchId));
        if (selectedModel) query.set('palinkModel', String(selectedModel));
        return `${base}/__palink_st_native_login?${query.toString()}`;
      })()
    : `/st/index.html?palinkCharacterId=${encodeURIComponent(String(character.id))}${sessionId ? `&palinkSessionId=${encodeURIComponent(String(sessionId))}` : ''}${branchId ? `&palinkBranchId=${encodeURIComponent(String(branchId))}` : ''}${selectedModel ? `&palinkModel=${encodeURIComponent(String(selectedModel))}` : ''}`;

  const handleLoad = useCallback(() => {
    setStReady(true);
  }, []);

  return (
    <div className="w-full h-full relative bg-[#242425]">
      {useNative && onBackToPalink && (
        <button
          type="button"
          onClick={onBackToPalink}
          className="absolute left-[max(0.75rem,env(safe-area-inset-left))] top-[max(0.75rem,env(safe-area-inset-top))] z-20 inline-flex h-10 w-10 items-center justify-center rounded-full border border-white/15 bg-slate-950/70 text-white shadow-lg shadow-black/30 backdrop-blur-md transition-colors hover:bg-slate-900/85 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/70"
          aria-label="返回 Palink"
          title="返回 Palink"
        >
          <span className="text-xl leading-none" aria-hidden="true">&lsaquo;</span>
        </button>
      )}
      {iframeSrc && (
        <iframe
          key={iframeSrc}
          ref={iframeRef}
          src={iframeSrc}
          onLoad={handleLoad}
          className="w-full h-full border-0 bg-[#242425]"
          title="SillyTavern"
          allow="clipboard-write"
        />
      )}
      {nativeStError && (
        <div className="absolute inset-0 flex items-center justify-center bg-[#242425] px-6 text-slate-100">
          <div className="max-w-md rounded-2xl border border-white/10 bg-black/30 p-5 text-center shadow-2xl backdrop-blur-sm">
            <p className="text-base font-medium text-white">SillyTavern 无法启动</p>
            <p className="mt-2 text-sm text-slate-300">{nativeStError}</p>
          </div>
        </div>
      )}
      {(!nativeStError && (!iframeSrc || (!useNative && !stReady))) && (
        <div className="absolute inset-0 flex items-center justify-center bg-[#242425] text-slate-100">
          <div className="flex flex-col items-center gap-3">
            <div className="w-8 h-8 border-2 border-primary border-t-transparent rounded-full animate-spin" />
            <p className="text-sm text-muted-foreground">正在加载 SillyTavern...</p>
          </div>
        </div>
      )}
    </div>
  );
}
