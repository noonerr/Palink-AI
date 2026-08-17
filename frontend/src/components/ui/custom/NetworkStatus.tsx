import React, { useEffect, useState } from 'react';
import { Wifi, WifiOff, AlertTriangle } from 'lucide-react';
import { useNetworkStatus } from '@/hooks/useNetworkStatus';
import { cn } from '@/lib/utils';

export function NetworkStatus() {
  const { isOnline, isSlowConnection, effectiveType } = useNetworkStatus();
  const [showBanner, setShowBanner] = useState(false);
  const [wasOffline, setWasOffline] = useState(false);

  useEffect(() => {
    if (!isOnline) {
      setShowBanner(true);
      setWasOffline(true);
    } else if (wasOffline) {
      setShowBanner(true);
      const timer = setTimeout(() => {
        setShowBanner(false);
        setWasOffline(false);
      }, 3000);
      return () => clearTimeout(timer);
    } else {
      setShowBanner(false);
    }
  }, [isOnline, wasOffline]);

  if (!showBanner && isOnline && !isSlowConnection) return null;

  return (
    <div
      className={cn(
        "fixed top-0 left-0 right-0 z-[100] flex items-center justify-center gap-2 px-4 py-2 text-sm font-medium transition-all duration-300",
        !isOnline
          ? "bg-red-500 text-white"
          : wasOffline
            ? "bg-green-500 text-white"
            : "bg-yellow-500 text-white"
      )}
    >
      {!isOnline ? (
        <>
          <WifiOff size={16} />
          <span>网络连接已断开</span>
        </>
      ) : wasOffline ? (
        <>
          <Wifi size={16} />
          <span>网络已恢复</span>
        </>
      ) : isSlowConnection ? (
        <>
          <AlertTriangle size={16} />
          <span>网络连接较慢 ({effectiveType})</span>
        </>
      ) : null}
    </div>
  );
}
