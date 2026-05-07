/**
 * StorylineMap — GalGame-style storyline visualizer using React Flow + dagre
 *
 * Layout: Top → Bottom
 * Each node = one dialogue turn (user prompt + AI reply)
 * Active path (root → current branch) is highlighted in blue/gold
 * Clicking a node triggers onNavigate to fork / switch branches
 */

import React, { useCallback, useEffect, useMemo, useRef } from 'react';
import {
  ReactFlow,
  MiniMap,
  Background,
  BackgroundVariant,
  useNodesState,
  useEdgesState,
  ReactFlowProvider,
  Handle,
  Position,
  type Node,
  type Edge,
  type NodeProps,
} from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import dagre from 'dagre';
import { GitBranch, MessageSquare, Sparkles, ArrowDownCircle, Play, User, ZoomIn, ZoomOut, Maximize2, Crosshair } from 'lucide-react';

const rfInstanceRef: { current: any } = { current: null };

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
  /** Called when user clicks a node to navigate / fork */
  onNavigate: (branchId: string, messageId: number | null, isLeaf: boolean) => void;
  isDark: boolean;
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
  onNavigate: (branchId: string, messageId: number | null, isLeaf: boolean) => void;
  isDark: boolean;
}

function StoryNodeComponent({ data }: NodeProps) {
  const d = data as unknown as StoryNodeData;
  const { node, branchId, branchName, pairIndex, isLeaf, isOnActivePath, isActiveBranch, isDark } = d;

  const isStart = node.user_summary === null;
  const messageId = node.ai_msg_id;

  const handleClick = useCallback(() => {
    d.onNavigate(branchId, messageId, isLeaf);
  }, [branchId, messageId, isLeaf, d]);

  // GalGame-style card colours
  const cardBg = isOnActivePath
    ? isDark
      ? 'bg-gradient-to-br from-indigo-900/80 to-blue-900/80 border-blue-400/60'
      : 'bg-gradient-to-br from-indigo-50 to-blue-50 border-blue-400/70'
    : isDark
    ? 'bg-gray-800/70 border-gray-600/40'
    : 'bg-white/80 border-gray-200/70';

  const shadowStyle = isOnActivePath
    ? '0 0 14px 2px rgba(99,102,241,0.35)'
    : '0 2px 8px rgba(0,0,0,0.12)';

  const primaryTitle = node.node_title || node.user_summary || node.ai_summary || '未命名节点';

  return (
    <div
      className={`rounded-xl border-2 cursor-pointer select-none transition-all duration-200 hover:scale-[1.03] hover:shadow-xl ${cardBg}`}
      style={{
        minWidth: 220,
        maxWidth: 260,
        boxShadow: shadowStyle,
        backdropFilter: 'blur(8px)',
      }}
      onClick={handleClick}
    >
      <Handle type="target" position={Position.Top} className="!bg-indigo-400 !border-white !w-2 !h-2" />

      {/* Header: branch label for first node */}
      {pairIndex === 0 && (
        <div
          className={`flex items-center gap-1.5 px-3 py-1.5 rounded-t-xl text-xs font-semibold border-b ${
            isActiveBranch
              ? 'bg-indigo-500/20 border-indigo-400/30 text-indigo-300'
              : isDark
              ? 'bg-gray-700/60 border-gray-600/30 text-gray-400'
              : 'bg-gray-100/80 border-gray-200/50 text-gray-500'
          }`}
        >
          <GitBranch size={11} />
          <span className="truncate max-w-[160px]">{branchName}</span>
          {isActiveBranch && (
            <span className="ml-auto text-[10px] bg-indigo-500/30 text-indigo-300 px-1.5 py-0.5 rounded-full">当前</span>
          )}
        </div>
      )}

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
        {!isStart && node.user_summary && (
          <div className="flex items-start gap-1.5">
            <div
              className={`flex-shrink-0 w-4 h-4 rounded-full flex items-center justify-center mt-0.5 ${
                isDark ? 'bg-violet-500/30' : 'bg-violet-100'
              }`}
            >
              <MessageSquare size={9} className="text-violet-400" />
            </div>
            <p className={`text-[11px] leading-relaxed line-clamp-2 ${isDark ? 'text-gray-200' : 'text-gray-700'}`}>
              {node.user_summary}
            </p>
          </div>
        )}

        {/* AI line */}
        {node.ai_summary && (
          <div className="flex items-start gap-1.5">
            <div
              className={`flex-shrink-0 w-4 h-4 rounded-full flex items-center justify-center mt-0.5 ${
                isDark ? 'bg-indigo-500/30' : 'bg-indigo-100'
              }`}
            >
              <Sparkles size={9} className="text-indigo-400" />
            </div>
            <p className={`text-[11px] leading-relaxed line-clamp-2 ${isDark ? 'text-gray-300' : 'text-gray-600'}`}>
              {node.ai_summary}
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

const nodeTypes = { storyNode: StoryNodeComponent, characterCard: CharacterCardNode };

function CustomControls({ isDark }: { isDark: boolean }) {
  const btnBase = `w-8 h-8 flex items-center justify-center rounded-lg border transition-all duration-150 active:scale-95 ${
    isDark
      ? 'bg-slate-800/90 border-slate-600/50 text-slate-300 hover:bg-slate-700/90 hover:text-white hover:border-slate-500/70'
      : 'bg-white/90 border-slate-200/70 text-slate-500 hover:bg-slate-50 hover:text-slate-700 hover:border-slate-300/70'
  } backdrop-blur-sm shadow-sm`;

  return (
    <div className="flex flex-col gap-1.5" style={{ position: 'absolute', bottom: 16, left: 16, zIndex: 5 }}>
      <button className={btnBase} onClick={() => rfInstanceRef.current?.zoomIn({ duration: 200 })} title="放大">
        <ZoomIn size={14} />
      </button>
      <button className={btnBase} onClick={() => rfInstanceRef.current?.zoomOut({ duration: 200 })} title="缩小">
        <ZoomOut size={14} />
      </button>
      <button className={btnBase} onClick={() => rfInstanceRef.current?.fitView({ duration: 300, padding: 0.3 })} title="适配视图">
        <Maximize2 size={14} />
      </button>
    </div>
  );
}

function LocateActiveButton({ isDark, activeNodeId }: { isDark: boolean; activeNodeId: string | null }) {
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [highlighting, setHighlighting] = React.useState(false);

  const handleLocate = useCallback(() => {
    if (!activeNodeId) return;
    const instance = rfInstanceRef.current;
    if (!instance) return;
    const node = instance.getNode(activeNodeId);
    if (!node) return;

    const x = node.position.x + (node.measured?.width ?? 240) / 2;
    const y = node.position.y + (node.measured?.height ?? 140) / 2;
    instance.setViewport({ x: window.innerWidth / 4 - x, y: window.innerHeight / 4 - y, zoom: 1 }, { duration: 400 });

    setHighlighting(true);
    if (timerRef.current) clearTimeout(timerRef.current);
    timerRef.current = setTimeout(() => setHighlighting(false), 1500);
  }, [activeNodeId]);

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
      const h = ((n.data as unknown as StoryNodeData).pairIndex === 0 ? NODE_HEIGHT + 28 : NODE_HEIGHT);
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

function buildGraph(
  branchTree: BranchTree,
  activePath: Set<string>,
  onNavigate: (branchId: string, messageId: number | null, isLeaf: boolean) => void,
  isDark: boolean
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
      draggable: true,
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
          onNavigate,
          isDark,
        } satisfies StoryNodeData,
        draggable: true,
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

const StorylineMapInner: React.FC<StorylineMapProps> = ({ branchTree, onNavigate, isDark }) => {
  const activePath = useMemo(
    () => computeActivePath(branchTree.branches, branchTree.active_branch_id),
    [branchTree]
  );

  const { nodes: initNodes, edges: initEdges } = useMemo(
    () => buildGraph(branchTree, activePath, onNavigate, isDark),
    [branchTree, activePath, onNavigate, isDark]
  );

  const [nodes, setNodes, onNodesChange] = useNodesState(initNodes);
  const [edges, setEdges, onEdgesChange] = useEdgesState(initEdges);
  const initialFitDoneRef = useRef(false);

  useEffect(() => {
    const { nodes: n, edges: e } = buildGraph(branchTree, activePath, onNavigate, isDark);
    setNodes(n);
    setEdges(e);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [branchTree, isDark]);

  const bgColor = isDark ? '#0f172a' : '#f8fafc';
  const miniMapNodeColor = (n: Node) =>
    ((n.data as unknown as StoryNodeData).isOnActivePath ? '#6366f1' : isDark ? '#374151' : '#e5e7eb');

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
        onEdgesChange={onEdgesChange}
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
        translateExtent={[[-500, -500], [3000, 5000]]}
      >
        <Background
          variant={BackgroundVariant.Dots}
          gap={20}
          size={1.2}
          color={isDark ? '#1e293b' : '#e2e8f0'}
        />
        <MiniMap
          nodeColor={miniMapNodeColor}
          nodeStrokeWidth={2}
          nodeBorderRadius={4}
          maskColor={isDark ? 'rgba(0,0,0,0.55)' : 'rgba(255,255,255,0.55)'}
          style={{
            bottom: 16,
            right: 16,
            borderRadius: 10,
            width: 140,
            height: 100,
            border: isDark ? '1px solid rgba(71,85,105,0.4)' : '1px solid rgba(203,213,225,0.5)',
            background: isDark ? 'rgba(15,23,42,0.85)' : 'rgba(255,255,255,0.85)',
            backdropFilter: 'blur(8px)',
            boxShadow: isDark ? '0 2px 8px rgba(0,0,0,0.3)' : '0 2px 8px rgba(0,0,0,0.08)',
          }}
          pannable
          zoomable
        />
        <CustomControls isDark={isDark} />
        <LocateActiveButton isDark={isDark} activeNodeId={activeLeafNodeId} />
      </ReactFlow>
    </div>
  );
};

const StorylineMap: React.FC<StorylineMapProps> = (props) => (
  <ReactFlowProvider>
    <StorylineMapInner {...props} />
  </ReactFlowProvider>
);

export default StorylineMap;
