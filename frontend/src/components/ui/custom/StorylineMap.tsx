/**
 * StorylineMap — GalGame-style storyline visualizer using React Flow + dagre
 *
 * Layout: Top → Bottom
 * Each node = one dialogue turn (user prompt + AI reply)
 * Active path (root → current branch) is highlighted in blue/gold
 * Clicking a node triggers onNavigate to fork / switch branches
 */

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ReactFlow,
  Background,
  BackgroundVariant,
  ReactFlowProvider,
  Handle,
  Position,
  type Node,
  type Edge,
  type NodeProps,
} from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import dagre from 'dagre';
import { GitBranch, MessageSquare, Sparkles, ArrowDownCircle, Play, User, ZoomIn, ZoomOut, Maximize2, Minimize2, ChevronsDown, Crosshair, Star, Snowflake, Trash2, AlertTriangle } from 'lucide-react';
import { api } from '@/services/api';

// rfInstanceRef moved inside StorylineMapInner as useRef to avoid stale references across re-mounts

// ──────────────────────────────────────────────
// Collapsible storyline constants
// ──────────────────────────────────────────────
const COLLAPSE_THRESHOLD = 10; // 总节点数超过此值时启用折叠
const COLLAPSE_SHOW_EDGES = 1; // 折叠时显示开头和结尾的节点数
const COLLAPSE_SHOW_MIDDLE_MIN = 1; // 重要节点周围至少显示的节点数

// ──────────────────────────────────────────────
// Types
// ──────────────────────────────────────────────

export interface StoryNode {
  pair_id: string;
  user_msg_id: number | null;
  ai_msg_id: number | null;
  node_title?: string | null;
  user_summary: string | null;
  ai_summary: string | null;
  created_at: string | null;
}

export interface StoryBranch {
  id: string;
  branch_name: string;
  parent_branch_id: string | null;
  parent_message_id: number | null;
  is_active: boolean;
  is_frozen: boolean;
  is_favorited: boolean;
  last_message_at: string | null;
  created_at: string | null;
  nodes: StoryNode[];
}

export interface CharacterInfo {
  id: string;
  name: string;
  avatar_url: string;
  greeting: string;
  background: string;
  user_nickname: string;
}

export interface BranchTree {
  branches: StoryBranch[];
  active_branch_id: string | null;
  character_info: CharacterInfo | null;
}

interface StorylineMapProps {
  branchTree: BranchTree;
  onNavigate: (branchId: string, messageId: number | null, isLeaf: boolean) => void;
  isDark: boolean;
  sessionId?: string;
  onDeleteBranch?: (branchId: string) => void;
}

// ──────────────────────────────────────────────
// Active path computation
// ──────────────────────────────────────────────

function computeActivePath(branches: StoryBranch[], activeBranchId: string | null): Set<string> {
  const active = new Set<string>();

  // Always include character card root when there are active branches
  if (activeBranchId && branches.length > 0) {
    active.add('char_root');
  }
  if (!activeBranchId) return active;

  // Traverse chain: active branch → parent → ... → root
  const branchMap = new Map(branches.map((b) => [b.id, b]));
  let cur = branchMap.get(activeBranchId);

  while (cur) {
    // All nodes on current branch are on the active path
    cur.nodes.forEach((_, i) => active.add(`${cur!.id}_${i}`));

    if (cur.parent_branch_id) {
      const parent = branchMap.get(cur.parent_branch_id);
      if (parent) {
        // On the parent branch, only nodes UP TO the fork point are on the active path
        const forkMsgId = cur.parent_message_id;
        for (let i = 0; i < parent.nodes.length; i++) {
          const n = parent.nodes[i];
          active.add(`${parent.id}_${i}`);
          if (forkMsgId !== null && (n.user_msg_id === forkMsgId || n.ai_msg_id === forkMsgId)) {
            break; // Stop at fork point
          }
        }
        cur = parent;
      } else {
        break;
      }
    } else {
      break;
    }
  }

  return active;
}

// ──────────────────────────────────────────────
// Identify important nodes (should not be collapsed)
// ──────────────────────────────────────────────

function computeImportantNodes(branches: StoryBranch[], activePath: Set<string>): Set<string> {
  const important = new Set<string>();
  
  // A node is important if:
  // 1. It's on the active path
  // 2. It's a fork point (has child branches)
  // 3. It's the first or last node of a branch
  
  branches.forEach((branch) => {
    // Check for fork points: nodes that have child branches
    const childBranchMap = new Map<string, number>(); // parent_message_id → count
    
    branches.forEach((b) => {
      if (b.parent_branch_id === branch.id && b.parent_message_id !== null) {
        const parentMessageId = String(b.parent_message_id);
        const count = childBranchMap.get(parentMessageId) || 0;
        childBranchMap.set(parentMessageId, count + 1);
      }
    });
    
    branch.nodes.forEach((node, idx) => {
      const nodeId = `${branch.id}_${idx}`;
      const msgId = node.ai_msg_id || node.user_msg_id;
      
      // Is on active path
      if (activePath.has(nodeId)) {
        important.add(nodeId);
      }
      
      // Is a fork point (has child branches)
      if (msgId !== null && (childBranchMap.get(String(msgId)) || 0) > 0) {
        important.add(nodeId);
      }
      
      // Is first node of branch
      if (idx === 0) {
        important.add(nodeId);
      }
      
      // Is last node of active branch
      if (branch.is_active && idx === branch.nodes.length - 1) {
        important.add(nodeId);
      }
    });
  });
  
  return important;
}

// ──────────────────────────────────────────────
// Compute visible nodes with collapse logic
// ──────────────────────────────────────────────

interface CollapsedRegion {
  startIdx: number;
  endIdx: number;
  branchId: string;
  count: number;
}

function computeVisibleNodes(
  branches: StoryBranch[],
  activePath: Set<string>
): {
  visibleNodeIds: Set<string>;
  collapsedRegions: CollapsedRegion[];
  isCollapsed: boolean;
} {
  // Count total nodes
  const totalNodes = branches.reduce((sum, b) => sum + b.nodes.length, 0);
  
  // If below threshold, no collapse needed
  if (totalNodes <= COLLAPSE_THRESHOLD) {
    const allIds = new Set<string>();
    branches.forEach((branch) => {
      branch.nodes.forEach((_, idx) => {
        allIds.add(`${branch.id}_${idx}`);
      });
    });
    return {
      visibleNodeIds: allIds,
      collapsedRegions: [],
      isCollapsed: false,
    };
  }
  
  // Identify important nodes
  const importantNodes = computeImportantNodes(branches, activePath);
  
  const visibleNodeIds = new Set<string>();
  const collapsedRegions: CollapsedRegion[] = [];
  
  // Process each branch
  branches.forEach((branch) => {
    const nodes = branch.nodes;
    
    if (nodes.length <= COLLAPSE_THRESHOLD) {
      // Small branch: show all
      nodes.forEach((_, idx) => {
        visibleNodeIds.add(`${branch.id}_${idx}`);
      });
      return;
    }
    
    // Large branch: apply collapse logic
    const alwaysShowStart = COLLAPSE_SHOW_EDGES;
    const alwaysShowEnd = nodes.length - COLLAPSE_SHOW_EDGES;
    
    // First pass: mark important nodes that must be visible
    const forcedVisible = new Set<number>();
    
    // Add important nodes in the middle region
    for (let idx = alwaysShowStart; idx < alwaysShowEnd; idx++) {
      const nodeId = `${branch.id}_${idx}`;
      if (importantNodes.has(nodeId)) {
        forcedVisible.add(idx);
        // Also show some nodes around important nodes
        for (let offset = -COLLAPSE_SHOW_MIDDLE_MIN; offset <= COLLAPSE_SHOW_MIDDLE_MIN; offset++) {
          const nearbyIdx = idx + offset;
          if (nearbyIdx >= alwaysShowStart && nearbyIdx < alwaysShowEnd) {
            forcedVisible.add(nearbyIdx);
          }
        }
      }
    }
    
    // Second pass: determine visible nodes and collapsed regions
    const visibleIndices = new Set<number>();
    
    // Always show start and end
    for (let idx = 0; idx < alwaysShowStart; idx++) {
      visibleIndices.add(idx);
    }
    for (let idx = alwaysShowEnd; idx < nodes.length; idx++) {
      visibleIndices.add(idx);
    }
    
    // Add forced visible (important) nodes
    forcedVisible.forEach((idx) => visibleIndices.add(idx));
    
    // Build visible set and detect collapsed regions
    const sortedVisible = Array.from(visibleIndices).sort((a, b) => a - b);
    
    sortedVisible.forEach((idx) => {
      visibleNodeIds.add(`${branch.id}_${idx}`);
    });
    
    // Detect gaps (collapsed regions)
    for (let i = 0; i < sortedVisible.length - 1; i++) {
      const current = sortedVisible[i];
      const next = sortedVisible[i + 1];
      
      // If there's a gap > 1, there's a collapsed region
      if (next - current > 1) {
        collapsedRegions.push({
          startIdx: current + 1,
          endIdx: next - 1,
          branchId: branch.id,
          count: next - current - 1,
        });
      }
    }
  });
  
  return {
    visibleNodeIds,
    collapsedRegions,
    isCollapsed: true,
  };
}

// ──────────────────────────────────────────────
// Collapsed Region Node Component
// ──────────────────────────────────────────────

interface CollapsedRegionData {
  region: CollapsedRegion;
  branchName: string;
  onExpand: (branchId: string, startIdx: number, endIdx: number) => void;
  isDark: boolean;
}

function CollapsedRegionNode({ data }: NodeProps) {
  const d = data as unknown as CollapsedRegionData;
  const { region, branchName, onExpand, isDark } = d;

  const handleClick = () => {
    onExpand(region.branchId, region.startIdx, region.endIdx);
  };

  return (
    <div
      className={`rounded-xl border-2 cursor-pointer select-none transition-all duration-200 hover:scale-[1.02] ${
        isDark
          ? 'bg-gray-800/80 border-gray-600/50 hover:bg-gray-700/80'
          : 'bg-gray-100/80 border-gray-300/50 hover:bg-gray-50/80'
      }`}
      style={{
        minWidth: 200,
        maxWidth: 240,
        boxShadow: isDark
          ? '0 2px 8px rgba(0,0,0,0.3)'
          : '0 2px 8px rgba(0,0,0,0.1)',
      }}
      onClick={handleClick}
    >
      <Handle type="target" position={Position.Top} className="!bg-gray-400 !border-white !w-2 !h-2" />
      
      <div className="px-4 py-3 space-y-2">
        <div className="flex items-center justify-center gap-2">
          <GitBranch size={12} className={isDark ? 'text-gray-400' : 'text-gray-500'} />
          <span className={`text-xs font-medium ${isDark ? 'text-gray-300' : 'text-gray-600'}`}>
            {branchName}
          </span>
        </div>
        
        <div className="flex items-center justify-center gap-1.5 py-2">
          <span className={`text-lg ${isDark ? 'text-gray-500' : 'text-gray-400'}`}>⋯</span>
          <span className={`text-xs px-2 py-1 rounded-full ${
            isDark
              ? 'bg-indigo-500/20 text-indigo-300'
              : 'bg-indigo-100 text-indigo-600'
          }`}>
            隐藏 {region.count} 条
          </span>
          <span className={`text-lg ${isDark ? 'text-gray-500' : 'text-gray-400'}`}>⋯</span>
        </div>
        
        <button
          onClick={handleClick}
          className={`w-full text-xs font-medium py-1.5 rounded-lg transition-colors ${
            isDark
              ? 'bg-indigo-500/20 text-indigo-300 hover:bg-indigo-500/30'
              : 'bg-indigo-100 text-indigo-600 hover:bg-indigo-200'
          }`}
        >
          展开查看
        </button>
      </div>
      
      <Handle type="source" position={Position.Bottom} className="!bg-gray-400 !border-white !w-2 !h-2" />
    </div>
  );
}

// ──────────────────────────────────────────────
// Custom Node Component
// ──────────────────────────────────────────────

interface StoryNodeData {
  node: StoryNode;
  branchId: string;
  branchName: string;
  pairIndex: number;
  isLeaf: boolean;
  isOnActivePath: boolean;
  isActiveBranch: boolean;
  isFrozen: boolean;
  isFavorited: boolean;
  isNavigatedNode: boolean;
  isDownstream: boolean;
  hasMultipleBranches: boolean;
  hasSiblingBranches: boolean;
  showBranchLabel: boolean;
  onNavigate: (branchId: string, messageId: number | null, isLeaf: boolean) => void;
  onDeleteBranch?: (branchId: string) => void;
  isDark: boolean;
}

function cleanStorylinePreview(text?: string | null): string {
  if (!text) return '';
  const raw = String(text).trim();
  if (/^html$/i.test(raw)) {
    return '';
  }
  if (/^(?:html\s*)?(?:<!?doc(?:type)?|<html\b|<head\b|<body\b|<script\b|<style\b)/i.test(raw)) {
    return '';
  }
  return raw
    .replace(/<palink-html>[\s\S]*?<\/palink-html>/gi, ' ')
    .replace(/<palink-html>[\s\S]*$/gi, ' ')
    .replace(/Error:\s*(?:请求已中断，未收到模型回复。?|Request aborted[^.\n]*(?:\.\s*)?)/gi, ' ')
    .replace(/(`{3,})html\s*\r?\n[\s\S]*?\r?\n\1/gi, ' ')
    .replace(/(?:^|\s)(?:html\s*)?(?:<!?doc(?:type)?|<html\b|<head\b|<body\b|<script\b|<style\b)[\s\S]*$/gi, ' ')
    .replace(/(?:html\s*)?(?:<!DOCTYPE\s+html|<html\b)[\s\S]*?<\/html\s*>/gi, ' ')
    .replace(/<(?:script|style)\b[\s\S]*?<\/(?:script|style)>/gi, ' ')
    .replace(/<\/?[a-zA-Z][a-zA-Z0-9]*(?:\s[^>]*)?\/?>/g, ' ')
    .replace(/`{3,}/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function StoryNodeComponent({ data }: NodeProps) {
  const d = data as unknown as StoryNodeData;
  const { node, branchId, branchName, pairIndex, isLeaf, isOnActivePath, isActiveBranch, isFrozen, isFavorited, isNavigatedNode, isDownstream, isDark } = d;

  const isStart = node.user_summary === null;
  const messageId = node.ai_msg_id;

  const handleClick = useCallback(() => {
    d.onNavigate(branchId, messageId, isLeaf);
  }, [branchId, messageId, isLeaf, d]);

  const handleDelete = useCallback((e: React.MouseEvent) => {
    e.stopPropagation();
    d.onDeleteBranch?.(branchId);
  }, [branchId, d]);

  // 冻结分支的灰色样式 / 导航节点高亮 / 下游节点变灰
  const cardBg = isFrozen
  ? isDark
      ? 'bg-gray-800/40 border-gray-700/30'
    : 'bg-gray-100/60 border-gray-300/40'
    : isNavigatedNode
    ? isDark
      ? 'bg-gradient-to-br from-amber-900/80 to-yellow-900/80 border-amber-400/80'
      : 'bg-gradient-to-br from-amber-50 to-yellow-50 border-amber-400/80'
    : isDownstream
    ? isDark
      ? 'bg-gray-800/30 border-gray-700/20'
      : 'bg-gray-100/40 border-gray-300/30'
    : isOnActivePath
    ? isDark
      ? 'bg-gradient-to-br from-indigo-900/80 to-blue-900/80 border-blue-400/60'
      : 'bg-gradient-to-br from-indigo-50 to-blue-50 border-blue-400/70'
    : isDark
    ? 'bg-gray-800/70 border-gray-600/40'
    : 'bg-white/80 border-gray-200/70';

  const shadowStyle = isFrozen
    ? '0 1px 4px rgba(0,0,0,0.08)'
    : isNavigatedNode
    ? '0 0 18px 4px rgba(251,191,36,0.5)'
    : isDownstream
    ? '0 1px 4px rgba(0,0,0,0.06)'
    : isOnActivePath
    ? '0 0 14px 2px rgba(99,102,241,0.35)'
    : '0 2px 8px rgba(0,0,0,0.12)';

  const cleanTitle = cleanStorylinePreview(node.node_title);
  const cleanAiSummary = cleanStorylinePreview(node.ai_summary);
  const cleanUserSummary = cleanStorylinePreview(node.user_summary);
  // 优先显示 node_title（对话总结标题）
  const primaryTitle = cleanTitle || cleanAiSummary || cleanUserSummary || '开始';

  return (
    <div
      className={`rounded-xl border-2 cursor-pointer select-none transition-all duration-200 hover:scale-[1.03] hover:shadow-xl ${cardBg} ${isFrozen ? 'opacity-60' : isDownstream ? 'opacity-40' : ''}`}
      style={{
        minWidth: 220,
        maxWidth: 260,
        boxShadow: shadowStyle,
      backdropFilter: 'blur(8px)',
      }}
      onClick={handleClick}
    >
      <Handle type="target" position={Position.Top} className="!bg-indigo-400 !border-white !w-2 !h-2" />

      {/* Header: branch label + delete button */}
      <div
        className={`flex items-center gap-1.5 px-3 py-1.5 rounded-t-xl text-xs font-semibold border-b ${
          isActiveBranch
            ? 'bg-indigo-500/20 border-indigo-400/30 text-indigo-300'
            : isDark
            ? 'bg-gray-700/60 border-gray-600/30 text-gray-400'
            : 'bg-gray-100/80 border-gray-200/50 text-gray-500'
        }`}
      >
        {d.showBranchLabel && (
          <>
            <GitBranch size={11} />
            <span className="truncate max-w-[120px]">{branchName}</span>
          </>
        )}
        {d.onDeleteBranch && d.showBranchLabel && (
          <button
            onClick={handleDelete}
            className={`${d.showBranchLabel ? 'ml-auto' : ''} p-1 rounded transition-colors ${
              isDark
                ? 'hover:bg-red-500/30 text-red-400/80 hover:text-red-300'
                : 'hover:bg-red-50 text-red-400 hover:text-red-600'
            }`}
            title={isActiveBranch ? "删除当前分支（将切换到其他分支）" : "删除此分支"}
          >
            <Trash2 size={14} />
          </button>
        )}
      </div>

      <div className="px-3 py-2.5 space-y-2">
        <p className={`text-xs font-semibold leading-relaxed line-clamp-1 ${isDark ? 'text-gray-100' : 'text-gray-900'}`}>
          {primaryTitle}
        </p>

        {/* Turn indicator */}
        <div className="flex items-center gap-1.5">
          <span
            className={`text-[10px] font-bold px-1.5 py-0.5 rounded-full ${
              isOnActivePath ? 'bg-indigo-500/25 text-indigo-300' : isDark ? 'bg-gray-700 text-gray-400' : 'bg-gray-100 text-gray-500'
            }`}
          >
            {isStart ? '开始' : `#${pairIndex + 1}`}
          </span>
          {isOnActivePath && isLeaf && (
            <span className="text-[10px] text-emerald-400 font-medium flex items-center gap-0.5">
              <Play size={9} fill="currentColor" /> 进行中
            </span>
          )}
        </div>

        {/* User line */}
        {!isStart && cleanUserSummary && (
          <div className="flex items-start gap-1.5">
            <div
              className={`flex-shrink-0 w-4 h-4 rounded-full flex items-center justify-center mt-0.5 ${
                isDark ? 'bg-violet-500/30' : 'bg-violet-100'
              }`}
            >
              <MessageSquare size={9} className="text-violet-400" />
            </div>
            <p className={`text-[11px] leading-relaxed line-clamp-2 ${isDark ? 'text-gray-200' : 'text-gray-700'}`}>
              {cleanUserSummary}
            </p>
          </div>
        )}

        {/* AI line */}
        {cleanAiSummary && (
          <div className="flex items-start gap-1.5">
            <div
              className={`flex-shrink-0 w-4 h-4 rounded-full flex items-center justify-center mt-0.5 ${
                isDark ? 'bg-indigo-500/30' : 'bg-indigo-100'
              }`}
            >
              <Sparkles size={9} className="text-indigo-400" />
            </div>
            <p className={`text-[11px] leading-relaxed line-clamp-2 ${isDark ? 'text-gray-300' : 'text-gray-600'}`}>
              {cleanAiSummary}
            </p>
          </div>
        )}

        {/* Navigate hint */}
        {!isLeaf && (
          <div
            className={`mt-1 text-center text-[10px] py-1 rounded-lg border border-dashed transition-all opacity-0 group-hover:opacity-100 ${
              isDark ? 'border-indigo-400/30 text-indigo-400' : 'border-indigo-300/50 text-indigo-500'
            }`}
          >
            <ArrowDownCircle size={10} className="inline mr-1" />
            点击从此处分叉
          </div>
        )}
      </div>

      <Handle type="source" position={Position.Bottom} className="!bg-indigo-400 !border-white !w-2 !h-2" />
    </div>
  );
}

// Character card root node (level 0)
interface CharacterCardData {
  characterInfo: CharacterInfo;
  hasActiveBranches: boolean;
  isDark: boolean;
}

function CharacterCardNode({ data }: NodeProps) {
  const d = data as unknown as CharacterCardData;
  const { characterInfo, hasActiveBranches, isDark } = d;

  const cardBg = isDark
    ? 'bg-gradient-to-br from-rose-900/80 to-pink-900/80 border-rose-400/50'
    : 'bg-gradient-to-br from-rose-50 to-pink-50 border-rose-300/70';

  return (
    <div
      className={`rounded-2xl border-2 ${cardBg}`}
      style={{
        minWidth: 240,
        maxWidth: 280,
        boxShadow: '0 0 16px 3px rgba(244,114,182,0.3)',
        backdropFilter: 'blur(8px)',
      }}
    >
      <div className="px-4 py-3 space-y-2">
        <div className="flex items-center gap-2">
          {characterInfo.avatar_url ? (
            <img src={characterInfo.avatar_url} alt="" className="w-10 h-10 rounded-full object-cover border-2 border-rose-300" />
          ) : (
            <div className={`w-10 h-10 rounded-full flex items-center justify-center ${isDark ? 'bg-rose-700' : 'bg-rose-200'}`}>
              <User size={20} className="text-rose-600" />
            </div>
          )}
          <div>
            <p className={`text-sm font-bold ${isDark ? 'text-gray-100' : 'text-gray-900'}`}>
              {characterInfo.name}
            </p>
            <p className={`text-[10px] ${isDark ? 'text-gray-400' : 'text-gray-500'}`}>角色卡</p>
          </div>
        </div>
        {characterInfo.greeting && (
          <p className={`text-[11px] leading-relaxed line-clamp-2 ${isDark ? 'text-gray-300' : 'text-gray-600'}`}>
            "{characterInfo.greeting.slice(0, 120)}"
          </p>
        )}
        {hasActiveBranches && (
          <div className="text-[10px] text-emerald-500 font-medium flex items-center gap-1">
            <Play size={9} fill="currentColor" /> 进行中
          </div>
        )}
      </div>
      <Handle type="source" position={Position.Bottom} className="!bg-rose-400 !border-white !w-3 !h-3" />
    </div>
  );
}

const nodeTypes = { storyNode: StoryNodeComponent, characterCard: CharacterCardNode, collapsedRegion: CollapsedRegionNode };

function CustomControls({ isDark, showCollapseToggle, isExpanded, onToggleCollapse, rfInstance }: {
  isDark: boolean;
  showCollapseToggle: boolean;
  isExpanded: boolean;
  onToggleCollapse: () => void;
  rfInstance: any;
}) {
  const btnBase = `w-8 h-8 flex items-center justify-center rounded-lg border transition-all duration-150 active:scale-95 ${
    isDark
      ? 'bg-slate-800/90 border-slate-600/50 text-slate-300 hover:bg-slate-700/90 hover:text-white hover:border-slate-500/70'
      : 'bg-white/90 border-slate-200/70 text-slate-500 hover:bg-slate-50 hover:text-slate-700 hover:border-slate-300/70'
  } backdrop-blur-sm shadow-sm`;

  return (
    <div className="flex flex-col gap-1.5" style={{ position: 'absolute', bottom: 16, left: 16, zIndex: 5 }}>
      <button className={btnBase} onClick={() => rfInstance?.zoomIn({ duration: 200 })} title="放大">
        <ZoomIn size={14} />
      </button>
      <button className={btnBase} onClick={() => rfInstance?.zoomOut({ duration: 200 })} title="缩小">
        <ZoomOut size={14} />
      </button>
      <button className={btnBase} onClick={() => rfInstance?.fitView({ duration: 300, padding: 0.3 })} title="适配视图">
        <Maximize2 size={14} />
      </button>
      {showCollapseToggle && (
        <button
          onClick={onToggleCollapse}
          className={`w-8 h-8 flex items-center justify-center rounded-lg border transition-all duration-150 active:scale-95 backdrop-blur-sm shadow-sm ${
            isExpanded
              ? isDark
                ? 'bg-indigo-500/20 border-indigo-400/40 text-indigo-300 hover:bg-indigo-500/30'
                : 'bg-indigo-100 border-indigo-200/70 text-indigo-600 hover:bg-indigo-200'
              : btnBase
          }`}
          title={isExpanded ? '全部收起' : '全部展开'}
        >
          {isExpanded ? <Minimize2 size={14} /> : <ChevronsDown size={14} />}
        </button>
      )}
    </div>
  );
}

function LocateActiveButton({ isDark, activeNodeId, rfInstance }: { isDark: boolean; activeNodeId: string | null; rfInstance: any }) {
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [highlighting, setHighlighting] = React.useState(false);

  const handleLocate = useCallback(() => {
    if (!activeNodeId) return;
    const instance = rfInstance;
    if (!instance) return;
    const node = instance.getNode(activeNodeId);
    if (!node) return;

    const x = node.position.x + (node.measured?.width ?? 240) / 2;
    const y = node.position.y + (node.measured?.height ?? 140) / 2;
    instance.setViewport({ x: window.innerWidth / 4 - x, y: window.innerHeight / 4 - y, zoom: 1 }, { duration: 400 });

    setHighlighting(true);
    if (timerRef.current) clearTimeout(timerRef.current);
    timerRef.current = setTimeout(() => setHighlighting(false), 1500);
  }, [activeNodeId, rfInstance]);

  const btnBase = `w-8 h-8 flex items-center justify-center rounded-lg border transition-all duration-150 active:scale-95 ${
    isDark
      ? 'bg-slate-800/90 border-slate-600/50 text-slate-300 hover:bg-slate-700/90 hover:text-white hover:border-slate-500/70'
      : 'bg-white/90 border-slate-200/70 text-slate-500 hover:bg-slate-50 hover:text-slate-700 hover:border-slate-300/70'
  } backdrop-blur-sm shadow-sm`;

  return (
    <div style={{ position: 'absolute', bottom: 16, left: 56, zIndex: 5 }}>
      <button
        className={`${btnBase} ${highlighting ? (isDark ? '!bg-indigo-600/80 !border-indigo-400/60 !text-white' : '!bg-indigo-500/90 !border-indigo-300/60 !text-white') : ''}`}
        onClick={handleLocate}
        title="定位当前分支"
      >
        <Crosshair size={14} />
      </button>
    </div>
  );
}

// ──────────────────────────────────────────────
// Dagre layout
// ──────────────────────────────────────────────

const NODE_WIDTH = 260;
const NODE_HEIGHT = 140;
const RANK_SEP = 60;
const NODE_SEP = 40;

function applyDagreLayout(nodes: Node[], edges: Edge[]): { nodes: Node[]; edges: Edge[] } {
  const g = new dagre.graphlib.Graph();
  g.setDefaultEdgeLabel(() => ({}));
  g.setGraph({ rankdir: 'TB', ranksep: RANK_SEP, nodesep: NODE_SEP });

  nodes.forEach((n) => {
    if (n.id === 'char_root') {
      g.setNode(n.id, { width: NODE_WIDTH, height: 150 });
    } else {
      const h = NODE_HEIGHT + 28;
      g.setNode(n.id, { width: NODE_WIDTH, height: h });
    }
  });
  edges.forEach((e) => g.setEdge(e.source, e.target));

  dagre.layout(g);

  const layouted = nodes.map((n) => {
    const pos = g.node(n.id);
    return { ...n, position: { x: pos.x - NODE_WIDTH / 2, y: pos.y - NODE_HEIGHT / 2 } };
  });

  return { nodes: layouted, edges };
}

// ──────────────────────────────────────────────
// Build React Flow graph from BranchTree
// ──────────────────────────────────────────────

function computeDownstreamNodes(branches: StoryBranch[], navigatedNodeId: string | null): Set<string> {
  const downstream = new Set<string>();
  if (!navigatedNodeId) return downstream;

  // navigatedNodeId 格式: "branchId_pairIndex"
  const sepIdx = navigatedNodeId.lastIndexOf('_');
  if (sepIdx === -1) return downstream;
  const navBranchId = navigatedNodeId.substring(0, sepIdx);
  const navPairIdx = parseInt(navigatedNodeId.substring(sepIdx + 1), 10);

  // 同分支中，pairIndex > navPairIdx 的节点都是下游
  const branchMap = new Map(branches.map(b => [b.id, b]));
  const navBranch = branchMap.get(navBranchId);
  if (navBranch) {
    for (let i = navPairIdx + 1; i < navBranch.nodes.length; i++) {
      downstream.add(`${navBranchId}_${i}`);
    }
  }

  // 所有以该节点为祖先的子分支中的节点也是下游
  // 找到 navigatedNodeId 对应的 messageId
  let navMsgId: number | null = null;
  if (navBranch) {
    const navNode = navBranch.nodes[navPairIdx];
    if (navNode) {
      navMsgId = navNode.ai_msg_id || navNode.user_msg_id;
    }
  }

  // 递归查找所有后代分支
  const findDescendantBranches = (parentId: string, parentMsgId: number | null) => {
    for (const b of branches) {
      if (b.parent_branch_id === parentId && b.parent_message_id === parentMsgId) {
        // 该分支所有节点都是下游
        b.nodes.forEach((_, i) => downstream.add(`${b.id}_${i}`));
        // 继续递归查找该分支的子分支
        b.nodes.forEach(n => {
          const mid = n.ai_msg_id || n.user_msg_id;
          if (mid) findDescendantBranches(b.id, mid);
        });
      }
    }
  };

  // 从导航节点所在分支的每个下游节点查找子分支
  if (navBranch) {
    for (let i = navPairIdx; i < navBranch.nodes.length; i++) {
      const n = navBranch.nodes[i];
      const mid = n.ai_msg_id || n.user_msg_id;
      if (mid) findDescendantBranches(navBranchId, mid);
    }
  }

  return downstream;
}

function buildGraph(
  branchTree: BranchTree,
  activePath: Set<string>,
  navigatedNodeId: string | null,
  downstreamNodes: Set<string>,
  onNavigate: (branchId: string, messageId: number | null, isLeaf: boolean) => void,
  isDark: boolean,
  onDeleteBranch?: (branchId: string) => void,
  siblingBranchesMap?: Map<string, boolean>
): { nodes: Node[]; edges: Edge[] } {
  const { branches, active_branch_id, character_info } = branchTree;
  const branchMap = new Map(branches.map((b) => [b.id, b]));

  const rawNodes: Node[] = [];
  const rawEdges: Edge[] = [];

  // Map: "branchId_pairIndex" → node id
  const nodeIdOf = (branchId: string, idx: number) => `${branchId}_${idx}`;

  // Add character card root node (level 0)
  if (character_info) {
    const isRootActive = activePath.has('char_root');
    rawNodes.push({
      id: 'char_root',
      type: 'characterCard',
      position: { x: 0, y: 0 },
      data: {
        characterInfo: character_info,
        hasActiveBranches: isRootActive,
        isDark,
      } satisfies CharacterCardData,
      draggable: false,
    });
  }

  branches.forEach((branch) => {
    const isActiveBranch = branch.id === active_branch_id;

    branch.nodes.forEach((node, idx) => {
      const nid = nodeIdOf(branch.id, idx);
      const isLeaf = idx === branch.nodes.length - 1;
      const isOnActivePath = activePath.has(nid);

      rawNodes.push({
        id: nid,
        type: 'storyNode',
        position: { x: 0, y: 0 }, // overwritten by dagre
        data: {
          node,
          branchId: branch.id,
          branchName: branch.branch_name,
          pairIndex: idx,
          isLeaf,
          isOnActivePath,
          isActiveBranch,
          isFrozen: branch.is_frozen,
          isFavorited: branch.is_favorited,
          isNavigatedNode: nid === navigatedNodeId,
          isDownstream: downstreamNodes.has(nid),
          hasMultipleBranches: branches.length > 1,
          hasSiblingBranches: siblingBranchesMap?.get(branch.id) ?? false,
          showBranchLabel: idx === 0 && (siblingBranchesMap?.get(branch.id) ?? false),
          onNavigate,
          onDeleteBranch,
          isDark,
        } satisfies StoryNodeData,
        draggable: false,
      });

      // Edge: sequential within branch
      if (idx > 0) {
        const prevId = nodeIdOf(branch.id, idx - 1);
        const isActiveEdge = activePath.has(prevId) && activePath.has(nid);
        rawEdges.push({
          id: `e_${prevId}_${nid}`,
          source: prevId,
          target: nid,
          type: 'smoothstep',
          animated: isActiveEdge,
          style: {
            stroke: isActiveEdge ? '#6366f1' : isDark ? '#4b5563' : '#d1d5db',
            strokeWidth: isActiveEdge ? 2.5 : 1.5,
            opacity: isActiveEdge ? 1 : 0.5,
          },
        });
      }
    });

    // Edge: connect to parent (character card root or parent branch)
    if (branch.nodes.length > 0) {
      const targetId = nodeIdOf(branch.id, 0);

      if (branch.parent_branch_id) {
        // Fork edge from parent branch
        const parentBranch = branchMap.get(branch.parent_branch_id);
        if (parentBranch) {
          let parentNodeIdx = parentBranch.nodes.length - 1;
          if (branch.parent_message_id !== null) {
            for (let i = 0; i < parentBranch.nodes.length; i++) {
              const pn = parentBranch.nodes[i];
              if (pn.user_msg_id === branch.parent_message_id || pn.ai_msg_id === branch.parent_message_id) {
                parentNodeIdx = i;
                break;
              }
            }
          }
          const sourceId = nodeIdOf(branch.parent_branch_id, parentNodeIdx);
          const isActiveEdge = activePath.has(sourceId) && activePath.has(targetId);
          rawEdges.push({
            id: `e_fork_${sourceId}_${targetId}`,
            source: sourceId,
            target: targetId,
            type: 'smoothstep',
            animated: isActiveEdge,
            label: branch.branch_name,
            labelStyle: { fontSize: 10, fill: isDark ? '#a5b4fc' : '#6366f1', fontWeight: 600 },
            labelBgStyle: { fill: isDark ? 'rgba(30,27,75,0.8)' : 'rgba(238,242,255,0.9)', rx: 4, ry: 4 },
            style: {
              stroke: isActiveEdge ? '#6366f1' : '#8b5cf6',
              strokeWidth: isActiveEdge ? 2.5 : 1.5,
              strokeDasharray: isActiveEdge ? undefined : '5 3',
              opacity: isActiveEdge ? 1 : 0.6,
            },
          });
        }
      } else if (character_info) {
        // Root-level branch: connect from character card
        const isActiveEdge = activePath.has('char_root') && activePath.has(targetId);
        rawEdges.push({
          id: `e_root_${targetId}`,
          source: 'char_root',
          target: targetId,
          type: 'smoothstep',
          animated: isActiveEdge,
          label: branch.branch_name,
          labelStyle: { fontSize: 10, fill: isDark ? '#f9a8d4' : '#db2777', fontWeight: 600 },
          labelBgStyle: { fill: isDark ? 'rgba(76,5,25,0.8)' : 'rgba(255,241,242,0.9)', rx: 4, ry: 4 },
          style: {
            stroke: isActiveEdge ? '#ec4899' : isDark ? '#be185d' : '#f9a8d4',
            strokeWidth: isActiveEdge ? 3 : 2,
            opacity: isActiveEdge ? 1 : 0.6,
          },
        });
      }
    }
  });

  return applyDagreLayout(rawNodes, rawEdges);
}

// ──────────────────────────────────────────────
// Main component
// ──────────────────────────────────────────────

function StorylineMapInner({ branchTree, onNavigate, isDark, sessionId, onDeleteBranch }: StorylineMapProps) {
  const rfInstanceRef = useRef<any>(null);
  const activePath = useMemo(
    () => computeActivePath(branchTree.branches, branchTree.active_branch_id),
    [branchTree]
  );

  const [navigatedNodeId, setNavigatedNodeId] = useState<string | null>(null);

  const downstreamNodes = useMemo(
    () => computeDownstreamNodes(branchTree.branches, navigatedNodeId),
    [branchTree.branches, navigatedNodeId]
  );

  // 计算每个分支是否有平级分支（同一分叉点的兄弟分支）
  const siblingBranchesMap = useMemo(() => {
    const map = new Map<string, boolean>();
    const branches = branchTree.branches;
    branches.forEach((branch) => {
      const siblings = branches.filter(
        b => b.id !== branch.id
          && b.parent_branch_id === branch.parent_branch_id
          && b.parent_message_id === branch.parent_message_id
      );
      map.set(branch.id, siblings.length > 0);
    });
    return map;
  }, [branchTree.branches]);

  const wrappedOnNavigate = useCallback((branchId: string, messageId: number | null, isLeaf: boolean) => {
    const branch = branchTree.branches.find(b => b.id === branchId);
    if (branch && messageId !== null) {
      for (let i = 0; i < branch.nodes.length; i++) {
        if (branch.nodes[i].ai_msg_id === messageId || branch.nodes[i].user_msg_id === messageId) {
          setNavigatedNodeId(`${branchId}_${i}`);
          break;
        }
      }
    } else if (branch && branch.nodes.length > 0) {
      setNavigatedNodeId(`${branchId}_0`);
    }
    onNavigate(branchId, messageId, isLeaf);
  }, [branchTree.branches, onNavigate]);

  const handleDeleteBranch = useCallback(async (branchId: string) => {
    if (!sessionId) {
      onDeleteBranch?.(branchId);
      return;
    }
    try {
      const data = await api.get(`/api/character-sessions/${sessionId}/branches/${branchId}/delete-preview`);
      setDeletePreview({
        branchId,
        branchName: data.branch_name || branchId,
        branchCount: data.branch_count || 1,
        messageCount: data.message_count || 0,
        isActive: data.is_active || false,
        isOnlyBranch: data.is_only_branch || false,
      });
    } catch (e: any) {
      const detail = e?.response?.data?.detail || e?.message || '';
      if (detail.includes('only branch')) {
        setDeletePreview({
          branchId,
          branchName: branchId,
          branchCount: 1,
          messageCount: 0,
          isActive: true,
          isOnlyBranch: true,
        });
      } else {
        console.error('Failed to preview branch deletion:', e);
        onDeleteBranch?.(branchId);
      }
    }
  }, [sessionId, onDeleteBranch]);

  const [deletePreview, setDeletePreview] = useState<{
    branchId: string;
    branchName: string;
    branchCount: number;
    messageCount: number;
    isActive: boolean;
    isOnlyBranch: boolean;
  } | null>(null);
  const [deleting, setDeleting] = useState(false);

  const confirmDelete = useCallback(async () => {
    if (!deletePreview || !sessionId) return;
    setDeleting(true);
    try {
      await api.delete(`/api/character-sessions/${sessionId}/branches/${deletePreview.branchId}`);
      setDeletePreview(null);
      onDeleteBranch?.(deletePreview.branchId);
    } catch (e) {
      console.error('Failed to delete branch:', e);
    } finally {
      setDeleting(false);
    }
  }, [deletePreview, sessionId, onDeleteBranch]);

  const [expandedRegions, setExpandedRegions] = useState<Set<string>>(new Set());
  const [forceExpandAll, setForceExpandAll] = useState(false);

  const { visibleNodeIds, collapsedRegions, isCollapsed } = useMemo(() => {
    return computeVisibleNodes(branchTree.branches, activePath);
  }, [branchTree.branches, activePath]);

  useEffect(() => {
    const validKeys = new Set(
      collapsedRegions.map(r => `${r.branchId}_${r.startIdx}_${r.endIdx}`)
    );
    setExpandedRegions(prev => {
      const next = new Set<string>();
      prev.forEach(key => {
        if (validKeys.has(key)) {
          next.add(key);
        }
      });
      if (next.size === prev.size) return prev;
      return next;
    });
  }, [collapsedRegions]);

  const totalNodes = useMemo(() => {
    return branchTree.branches.reduce((sum, b) => sum + b.nodes.length, 0);
  }, [branchTree.branches]);

  const hasEnoughNodes = totalNodes > COLLAPSE_THRESHOLD;
  const shouldShowCollapsed = hasEnoughNodes && !forceExpandAll;

  const handleExpandRegion = useCallback((branchId: string, startIdx: number, endIdx: number) => {
    const regionKey = `${branchId}_${startIdx}_${endIdx}`;
    setExpandedRegions(prev => {
      const next = new Set(prev);
      next.add(regionKey);
      return next;
    });
  }, []);

  const handleExpandAll = useCallback(() => {
    setForceExpandAll(true);
    setExpandedRegions(new Set());
  }, []);

  const handleCollapseAll = useCallback(() => {
    setForceExpandAll(false);
    setExpandedRegions(new Set());
  }, []);

  const layoutCacheRef = useRef<{ branchTree: BranchTree; result: { nodes: Node[]; edges: Edge[] } } | null>(null);
  const { nodes: initNodes, edges: initEdges } = useMemo(() => {
    if (layoutCacheRef.current && layoutCacheRef.current.branchTree === branchTree) {
      return layoutCacheRef.current.result;
    }
    if (!shouldShowCollapsed) {
      const result = buildGraph(branchTree, activePath, navigatedNodeId, downstreamNodes, wrappedOnNavigate, isDark, handleDeleteBranch, siblingBranchesMap);
      layoutCacheRef.current = { branchTree, result };
      return result;
    }

    const branchMap = new Map(branchTree.branches.map(b => [b.id, b]));
    const allNodes: Node[] = [];
    const allEdges: Edge[] = [];
    
    branchTree.branches.forEach((branch) => {
      const branchName = branch.branch_name;
      const branchRegions = collapsedRegions.filter(r => r.branchId === branch.id);
      
      branch.nodes.forEach((node, idx) => {
        const nodeId = `${branch.id}_${idx}`;
        if (!visibleNodeIds.has(nodeId)) return;
        
        const isLeaf = idx === branch.nodes.length - 1;
        const isOnActivePath = activePath.has(nodeId);

        allNodes.push({
          id: nodeId,
          type: 'storyNode',
          position: { x: 0, y: 0 },
          data: {
            node,
            branchId: branch.id,
            branchName: branchName,
            pairIndex: idx,
            isLeaf,
            isOnActivePath,
            isActiveBranch: branch.is_active,
            isFrozen: branch.is_frozen,
            isFavorited: branch.is_favorited,
            isNavigatedNode: nodeId === navigatedNodeId,
            isDownstream: downstreamNodes.has(nodeId),
            hasMultipleBranches: branchTree.branches.length > 1,
            hasSiblingBranches: siblingBranchesMap.get(branch.id) ?? false,
            showBranchLabel: idx === 0 && (siblingBranchesMap.get(branch.id) ?? false),
            onNavigate: wrappedOnNavigate,
            onDeleteBranch: handleDeleteBranch,
            isDark,
          } satisfies StoryNodeData,
          draggable: false,
        });
      });

      const visibleIndices = Array.from(visibleNodeIds)
        .filter(id => id.startsWith(`${branch.id}_`))
        .map(id => parseInt(id.split('_').pop() || '0', 10))
        .sort((a, b) => a - b);

      for (let i = 0; i < visibleIndices.length - 1; i++) {
        const currentIdx = visibleIndices[i];
        const nextIdx = visibleIndices[i + 1];
        const currentId = `${branch.id}_${currentIdx}`;
        const nextId = `${branch.id}_${nextIdx}`;

        if (nextIdx === currentIdx + 1) {
          const isActiveEdge = activePath.has(currentId) && activePath.has(nextId);
          allEdges.push({
            id: `e_${currentId}_${nextId}`,
            source: currentId,
            target: nextId,
            type: 'smoothstep',
            animated: isActiveEdge,
            style: {
              stroke: isActiveEdge ? '#6366f1' : isDark ? '#4b5563' : '#d1d5db',
              strokeWidth: isActiveEdge ? 2.5 : 1.5,
              opacity: isActiveEdge ? 1 : 0.5,
            },
          });
        } else {
          const regionKey = `${branch.id}_${currentIdx + 1}_${nextIdx - 1}`;
          if (!expandedRegions.has(regionKey)) {
            branchRegions.forEach(region => {
              const rKey = `${region.branchId}_${region.startIdx}_${region.endIdx}`;
              if (rKey === regionKey) {
                allNodes.push({
                  id: `collapse_${rKey}`,
                  type: 'collapsedRegion',
                  position: { x: 0, y: 0 },
                  data: {
                    region,
                    branchName,
                    onExpand: handleExpandRegion,
                    isDark,
                  } satisfies CollapsedRegionData,
                  draggable: false,
                });
              }
            });
          }

          const isActiveEdge = activePath.has(currentId) && activePath.has(nextId);
          allEdges.push({
            id: `e_${currentId}_collapse_${regionKey}`,
            source: currentId,
            target: `collapse_${regionKey}`,
            type: 'smoothstep',
            animated: isActiveEdge,
            style: {
              stroke: isActiveEdge ? '#6366f1' : isDark ? '#4b5563' : '#d1d5db',
              strokeWidth: isActiveEdge ? 2.5 : 1.5,
              opacity: isActiveEdge ? 1 : 0.5,
            },
          });

          const isExpanded = expandedRegions.has(regionKey);
          if (!isExpanded) {
            allEdges.push({
              id: `e_collapse_${regionKey}_${nextId}`,
              source: `collapse_${regionKey}`,
              target: nextId,
              type: 'smoothstep',
              animated: isActiveEdge,
              style: {
                stroke: isActiveEdge ? '#6366f1' : isDark ? '#4b5563' : '#d1d5db',
                strokeWidth: isActiveEdge ? 2.5 : 1.5,
                opacity: isActiveEdge ? 1 : 0.5,
              },
            });
          }
        }
      }

      branchRegions.forEach(region => {
        const regionKey = `${region.branchId}_${region.startIdx}_${region.endIdx}`;
        if (expandedRegions.has(regionKey)) {
          for (let idx = region.startIdx; idx <= region.endIdx; idx++) {
            const nodeId = `${branch.id}_${idx}`;
            const node = branch.nodes[idx];
            if (!node) return;
            
            const isLeaf = idx === branch.nodes.length - 1;
            const isOnActivePath = activePath.has(nodeId);

            allNodes.push({
              id: nodeId,
              type: 'storyNode',
              position: { x: 0, y: 0 },
              data: {
                node,
                branchId: branch.id,
                branchName: branchName,
                pairIndex: idx,
                isLeaf,
                isOnActivePath,
                isActiveBranch: branch.is_active,
                isFrozen: branch.is_frozen,
                isFavorited: branch.is_favorited,
                isNavigatedNode: nodeId === navigatedNodeId,
                isDownstream: downstreamNodes.has(nodeId),
                hasMultipleBranches: branchTree.branches.length > 1,
                hasSiblingBranches: siblingBranchesMap.get(branch.id) ?? false,
                showBranchLabel: idx === 0 && (siblingBranchesMap.get(branch.id) ?? false),
                onNavigate: wrappedOnNavigate,
                onDeleteBranch: handleDeleteBranch,
                isDark,
              } satisfies StoryNodeData,
              draggable: false,
            });

            if (idx > region.startIdx) {
              const prevId = `${branch.id}_${idx - 1}`;
              const isActiveEdge = activePath.has(prevId) && activePath.has(nodeId);
              allEdges.push({
                id: `e_${prevId}_${nodeId}`,
                source: prevId,
                target: nodeId,
                type: 'smoothstep',
                animated: isActiveEdge,
                style: {
                  stroke: isActiveEdge ? '#6366f1' : isDark ? '#4b5563' : '#d1d5db',
                  strokeWidth: isActiveEdge ? 2.5 : 1.5,
                  opacity: isActiveEdge ? 1 : 0.5,
                },
              });
            }
          }
        }
      });
    });

    branchTree.branches.forEach((branch) => {
      if (branch.nodes.length === 0) return;
      
      if (branch.parent_branch_id) {
        const parentBranch = branchMap.get(branch.parent_branch_id);
        if (parentBranch) {
          let parentNodeIdx = parentBranch.nodes.length - 1;
          if (branch.parent_message_id !== null) {
            for (let i = 0; i < parentBranch.nodes.length; i++) {
              const pn = parentBranch.nodes[i];
              if (pn.user_msg_id === branch.parent_message_id || pn.ai_msg_id === branch.parent_message_id) {
                parentNodeIdx = i;
                break;
              }
            }
          }
          const sourceId = `${branch.parent_branch_id}_${parentNodeIdx}`;
          const targetId = `${branch.id}_0`;
          
          if (!visibleNodeIds.has(sourceId)) return;
          
          const isActiveEdge = activePath.has(sourceId) && activePath.has(targetId);
          allEdges.push({
            id: `e_fork_${sourceId}_${targetId}`,
            source: sourceId,
            target: targetId,
            type: 'smoothstep',
            animated: isActiveEdge,
            label: branch.branch_name,
            labelStyle: { fontSize: 10, fill: isDark ? '#a5b4fc' : '#6366f1', fontWeight: 600 },
            labelBgStyle: { fill: isDark ? 'rgba(30,27,75,0.8)' : 'rgba(238,242,255,0.9)', rx: 4, ry: 4 },
            style: {
              stroke: isActiveEdge ? '#6366f1' : '#8b5cf6',
              strokeWidth: isActiveEdge ? 2.5 : 1.5,
              strokeDasharray: isActiveEdge ? undefined : '5 3',
              opacity: isActiveEdge ? 1 : 0.6,
            },
          });
        }
      } else if (branchTree.character_info) {
        const targetId = `${branch.id}_0`;
        if (!visibleNodeIds.has(targetId)) return;
        
        const isActiveEdge = activePath.has('char_root') && activePath.has(targetId);
        allEdges.push({
          id: `e_root_${targetId}`,
          source: 'char_root',
          target: targetId,
          type: 'smoothstep',
          animated: isActiveEdge,
          label: branch.branch_name,
          labelStyle: { fontSize: 10, fill: isDark ? '#f9a8d4' : '#db2777', fontWeight: 600 },
          labelBgStyle: { fill: isDark ? 'rgba(76,5,25,0.8)' : 'rgba(255,241,242,0.9)', rx: 4, ry: 4 },
          style: {
            stroke: isActiveEdge ? '#ec4899' : isDark ? '#be185d' : '#f9a8d4',
            strokeWidth: isActiveEdge ? 3 : 2,
            opacity: isActiveEdge ? 1 : 0.6,
          },
        });
      }
    });

    if (branchTree.character_info) {
      const isRootActive = activePath.has('char_root');
      allNodes.unshift({
        id: 'char_root',
        type: 'characterCard',
        position: { x: 0, y: 0 },
        data: {
          characterInfo: branchTree.character_info,
          hasActiveBranches: isRootActive,
          isDark,
        } satisfies CharacterCardData,
        draggable: false,
      });
    }

    const result = applyDagreLayout(allNodes, allEdges);
    layoutCacheRef.current = { branchTree, result };
    return result;
  }, [branchTree, activePath, navigatedNodeId, downstreamNodes, wrappedOnNavigate, handleDeleteBranch, isDark, shouldShowCollapsed, visibleNodeIds, collapsedRegions, expandedRegions, handleExpandRegion, siblingBranchesMap]);

  const initialFitDoneRef = useRef(false);

  // 直接用 useMemo 计算的 nodes/edges 驱动 React Flow
  // 自行处理拖拽位置变化
  const [localNodes, setLocalNodes] = useState<Record<string, { x: number; y: number }>>({});

  // 当 initNodes 变化（分支切换）时，清理 localNodes 中不再存在的节点位置
  useEffect(() => {
    const currentNodeIds = new Set(initNodes.map(n => n.id));
    setLocalNodes(prev => {
      const next: Record<string, { x: number; y: number }> = {};
      let changed = false;
      for (const [id, pos] of Object.entries(prev)) {
        if (currentNodeIds.has(id)) {
          next[id] = pos;
        } else {
          changed = true;
        }
      }
      return changed ? next : prev;
    });
  }, [initNodes]);

  const nodes = useMemo(() => {
    return initNodes.map(n => {
      const pos = localNodes[n.id];
      if (pos) return { ...n, position: pos };
      return n;
    });
  }, [initNodes, localNodes]);

  const edges = initEdges;

  const onNodesChange = useCallback((changes: any[]) => {
    const positionChanges = changes.filter((c: any) => c.type === 'position' && c.position);
    if (positionChanges.length > 0) {
      setLocalNodes(prev => {
        const next = { ...prev };
        for (const c of positionChanges) {
          next[c.id] = c.position;
        }
        return next;
      });
    }
  }, []);

  const bgColor = isDark ? '#0f172a' : '#f8fafc';

  // 当 branchTree 变化时（切换分支/节点），重新 fitView
  useEffect(() => {
    if (rfInstanceRef.current) {
      requestAnimationFrame(() => {
        rfInstanceRef.current?.fitView({ padding: 0.15, duration: 250, maxZoom: 1 });
      });
    }
  }, [branchTree]);

  const activeLeafNodeId = useMemo(() => {
    if (!branchTree.active_branch_id) return null;
    const activeBranch = branchTree.branches.find(b => b.id === branchTree.active_branch_id);
    if (!activeBranch || activeBranch.nodes.length === 0) return null;
    return `${activeBranch.id}_${activeBranch.nodes.length - 1}`;
  }, [branchTree]);

  return (
    <div className="w-full h-full" style={{ background: bgColor }}>
      <ReactFlow
        nodes={nodes}
        edges={edges}
        onNodesChange={onNodesChange}
        onEdgesChange={undefined}
        nodeTypes={nodeTypes}
        onInit={(instance) => {
          rfInstanceRef.current = instance;
          if (!initialFitDoneRef.current) {
            initialFitDoneRef.current = true;
            requestAnimationFrame(() => {
              instance.fitView({ padding: 0.15, duration: 250, maxZoom: 1 });
            });
          }
        }}
        minZoom={0.2}
        maxZoom={2}
        proOptions={{ hideAttribution: true }}
        translateExtent={[[-2000, -2000], [5000, 20000]]}
      >
        <Background
          variant={BackgroundVariant.Dots}
          gap={20}
          size={1.2}
          color={isDark ? '#1e293b' : '#e2e8f0'}
        />
        <CustomControls
          isDark={isDark}
          showCollapseToggle={hasEnoughNodes && collapsedRegions.length > 0}
          isExpanded={expandedRegions.size > 0 || forceExpandAll}
          onToggleCollapse={expandedRegions.size > 0 || forceExpandAll ? handleCollapseAll : handleExpandAll}
          rfInstance={rfInstanceRef.current}
        />
        <LocateActiveButton isDark={isDark} activeNodeId={activeLeafNodeId} rfInstance={rfInstanceRef.current} />
      </ReactFlow>

      {deletePreview && (
        <div className="fixed inset-0 z-[9999] flex items-center justify-center">
          <div className="absolute inset-0 bg-black/40 backdrop-blur-sm" onClick={() => setDeletePreview(null)} />
          <div
            className={`relative w-80 rounded-2xl border shadow-2xl p-5 ${
              isDark
                ? 'bg-gray-900 border-gray-700 text-white'
                : 'bg-white border-gray-200 text-gray-900'
            }`}
          >
            <div className="flex items-center gap-3 mb-3">
              <div className={`p-2 rounded-xl ${isDark ? 'bg-red-500/20' : 'bg-red-50'}`}>
                <AlertTriangle size={20} className="text-red-500" />
              </div>
              <div>
                <h3 className="font-bold text-sm">删除分支</h3>
                <p className={`text-xs ${isDark ? 'text-gray-400' : 'text-gray-500'}`}>
                  此操作不可撤销
                </p>
              </div>
            </div>

            {deletePreview.isOnlyBranch ? (
              <div className={`mb-4 p-3 rounded-xl text-xs space-y-1 ${
                isDark ? 'bg-red-500/10 border border-red-500/20' : 'bg-red-50 border border-red-200'
              }`}>
                <p className={`font-semibold ${isDark ? 'text-red-300' : 'text-red-700'}`}>
                  无法删除唯一分支
                </p>
                <p className={isDark ? 'text-red-200/80' : 'text-red-600'}>
                  请先创建新分支，再删除此分支。
                </p>
              </div>
            ) : (
              <>
                <p className={`text-sm mb-3 ${isDark ? 'text-gray-300' : 'text-gray-600'}`}>
                  确定要删除分支 <span className="font-semibold">「{deletePreview.branchName}」</span> 吗？
                </p>

                {deletePreview.isActive && (
                  <div className={`mb-3 p-3 rounded-xl text-xs space-y-1 ${
                    isDark ? 'bg-amber-500/10 border border-amber-500/20' : 'bg-amber-50 border border-amber-200'
                  }`}>
                    <p className={`font-semibold ${isDark ? 'text-amber-300' : 'text-amber-700'}`}>
                      当前活动分支
                    </p>
                    <p className={isDark ? 'text-amber-200/80' : 'text-amber-600'}>
                      删除后将自动切换到其他分支。
                    </p>
                  </div>
                )}

                {(deletePreview.branchCount > 1 || deletePreview.messageCount > 0) && (
                  <div className={`mb-4 p-3 rounded-xl text-xs space-y-1 ${
                    isDark ? 'bg-amber-500/10 border border-amber-500/20' : 'bg-amber-50 border border-amber-200'
                  }`}>
                    <p className={`font-semibold ${isDark ? 'text-amber-300' : 'text-amber-700'}`}>
                      受影响的内容：
                    </p>
                    {deletePreview.branchCount > 1 && (
                      <p className={isDark ? 'text-amber-200/80' : 'text-amber-600'}>
                        · {deletePreview.branchCount} 条分支（含子分支）
                      </p>
                    )}
                    {deletePreview.messageCount > 0 && (
                      <p className={isDark ? 'text-amber-200/80' : 'text-amber-600'}>
                        · {deletePreview.messageCount} 条消息
                      </p>
                    )}
                  </div>
                )}
              </>
            )}

            <div className="flex gap-2 justify-end">
              <button
                onClick={() => setDeletePreview(null)}
                className={`px-4 py-2 text-sm rounded-xl font-medium transition-colors ${
                  isDark
                    ? 'bg-gray-800 hover:bg-gray-700 text-gray-300'
                    : 'bg-gray-100 hover:bg-gray-200 text-gray-600'
                }`}
              >
                {deletePreview.isOnlyBranch ? '知道了' : '取消'}
              </button>
              {!deletePreview.isOnlyBranch && (
                <button
                  onClick={confirmDelete}
                  disabled={deleting}
                  className="px-4 py-2 text-sm rounded-xl font-medium bg-red-500 hover:bg-red-600 text-white transition-colors disabled:opacity-50"
                >
                  {deleting ? '删除中...' : '确认删除'}
                </button>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
};

function StorylineMap(props: StorylineMapProps) {
  return (
    <ReactFlowProvider>
      <StorylineMapInner {...props} />
    </ReactFlowProvider>
  );
}

export default StorylineMap;
