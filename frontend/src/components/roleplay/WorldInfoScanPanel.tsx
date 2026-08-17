/**
 * 世界书扫描结果面板
 * 显示世界书关键词扫描的详细结果
 */

import React from 'react';
import type { WorldBookEntry } from '../../lib/worldbook/types';

export interface WorldInfoScanResult {
  /** 激活的条目 */
  entries: WorldBookEntry[];
  /** 总 token 数 */
  totalTokens: number;
  /** 预算上限（token） */
  budgetMax: number;
}

export interface WorldInfoScanPanelProps {
  scanResult: WorldInfoScanResult | null;
  isScanning: boolean;
  onScan?: () => void;
  className?: string;
}

/**
 * 世界书扫描结果面板
 */
export const WorldInfoScanPanel: React.FC<WorldInfoScanPanelProps> = ({
  scanResult,
  isScanning,
  onScan,
  className,
}) => {
  return (
    <div className={`border border-border rounded-md p-3 bg-muted/30 ${className ?? ''}`}>
      <div className="flex items-center justify-between mb-2">
        <h3 className="text-sm font-medium">世界书扫描</h3>
        <button
          onClick={onScan}
          disabled={isScanning || !onScan}
          className="text-xs px-2 py-1 rounded bg-secondary text-secondary-foreground hover:bg-accent disabled:opacity-50"
        >
          {isScanning ? '扫描中...' : '扫描'}
        </button>
      </div>
      {scanResult && (
        <div className="text-xs text-muted-foreground space-y-1">
          <p>
            激活: {scanResult.entries.length} 条目
          </p>
          <p>Token: {scanResult.totalTokens} / {scanResult.budgetMax}</p>
          {scanResult.entries.length > 0 && (
            <details className="mt-2">
              <summary className="cursor-pointer">激活条目详情</summary>
              <ul className="mt-1 space-y-1 ml-4">
                {scanResult.entries.map((entry) => (
                  <li key={entry.id} className="list-disc">
                    {entry.comment || entry.key.join(', ')}
                  </li>
                ))}
              </ul>
            </details>
          )}
        </div>
      )}
    </div>
  );
};

export default WorldInfoScanPanel;
