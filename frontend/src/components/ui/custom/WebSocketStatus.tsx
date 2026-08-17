import React from 'react';
import { cn } from '@/lib/utils';

interface WebSocketStatusProps {
  connected: boolean;
  className?: string;
}

export function WebSocketStatus({ connected, className }: WebSocketStatusProps) {
  return (
    <div className={cn("flex items-center gap-1.5", className)}>
      <div
        className={cn(
          "w-2 h-2 rounded-full transition-colors duration-300",
          connected ? "bg-green-500" : "bg-yellow-500 animate-pulse"
        )}
      />
      <span className="text-xs text-muted-foreground">
        {connected ? 'WS' : 'SSE'}
      </span>
    </div>
  );
}
