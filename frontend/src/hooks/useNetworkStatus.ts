import { useState, useEffect, useCallback } from 'react';

export interface NetworkStatusState {
  isOnline: boolean;
  isSlowConnection: boolean;
  effectiveType: string;
  downlink: number;
  rtt: number;
}

export function useNetworkStatus(): NetworkStatusState {
  const [status, setStatus] = useState<NetworkStatusState>(() => ({
    isOnline: typeof navigator !== 'undefined' ? navigator.onLine : true,
    isSlowConnection: false,
    effectiveType: '4g',
    downlink: 10,
    rtt: 50,
  }));

  const updateConnectionInfo = useCallback(() => {
    const nav = navigator as any;
    const connection = nav.connection || nav.mozConnection || nav.webkitConnection;

    setStatus(prev => ({
      ...prev,
      isOnline: navigator.onLine,
      isSlowConnection: connection
        ? ['slow-2g', '2g', '3g'].includes(connection.effectiveType)
        : false,
      effectiveType: connection?.effectiveType || '4g',
      downlink: connection?.downlink || 10,
      rtt: connection?.rtt || 50,
    }));
  }, []);

  useEffect(() => {
    const handleOnline = () => updateConnectionInfo();
    const handleOffline = () => updateConnectionInfo();

    window.addEventListener('online', handleOnline);
    window.addEventListener('offline', handleOffline);

    const nav = navigator as any;
    const connection = nav.connection || nav.mozConnection || nav.webkitConnection;
    if (connection) {
      connection.addEventListener('change', updateConnectionInfo);
    }

    return () => {
      window.removeEventListener('online', handleOnline);
      window.removeEventListener('offline', handleOffline);
      if (connection) {
        connection.removeEventListener('change', updateConnectionInfo);
      }
    };
  }, [updateConnectionInfo]);

  return status;
}
