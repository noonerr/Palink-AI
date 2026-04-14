/**
 * StorylineMap — GalGame-style storyline visualizer using React Flow + dagre
 *
 * Layout: Top → Bottom
 * Each node = one dialogue turn (user prompt + AI reply)
 * Active path (root → current branch) is highlighted in blue/gold
 * Clicking a node triggers onNavigate to fork / switch branches
 */

import React, { useCallback, useEffect, useMemo } from 'react';
import {
  ReactFlow,
  MiniMap,
  Controls,
  Background,
  BackgroundVariant,
  useNodesState,
  useEdgesState,
  Handle,
  Position,
  type Node,
  type Edge,
  type NodeProps,
} from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import dagre from 'dagre';
import { GitBranch, MessageSquare, Sparkles, ArrowDownCircle, Play } from 'lucide-react';
import { LoadingDots } from './LoadingDots';

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

export interface BranchTree {
  branches: StoryBranch[];
  active_branch_id: string | null;
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

const nodeTypes = { storyNode: StoryNodeComponent };

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
    const h = ((n.data as unknown as StoryNodeData).pairIndex === 0 ? NODE_HEIGHT + 28 : NODE_HEIGHT);
    g.setNode(n.id, { width: NODE_WIDTH, height: h });
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
  const { branches, active_branch_id } = branchTree;
  const branchMap = new Map(branches.map((b) => [b.id, b]));

  const rawNodes: Node[] = [];
  const rawEdges: Edge[] = [];

  // Map: "branchId_pairIndex" → node id
  const nodeIdOf = (branchId: string, idx: number) => `${branchId}_${idx}`;

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

    // Fork edge: connect parent branch node → first node of this branch
    if (branch.parent_branch_id && branch.nodes.length > 0) {
      const parentBranch = branchMap.get(branch.parent_branch_id);
      if (parentBranch) {
        // Find which node in parentBranch contains parent_message_id
        let parentNodeIdx = parentBranch.nodes.length - 1; // default: last node
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
        const targetId = nodeIdOf(branch.id, 0);
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
    }
  });

  return applyDagreLayout(rawNodes, rawEdges);
}

// ──────────────────────────────────────────────
// Main component
// ──────────────────────────────────────────────

const StorylineMap: React.FC<StorylineMapProps> = ({ branchTree, onNavigate, isDark }) => {
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

  // Re-layout when branchTree changes
  useEffect(() => {
    const { nodes: n, edges: e } = buildGraph(branchTree, activePath, onNavigate, isDark);
    setNodes(n);
    setEdges(e);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [branchTree, isDark]);

  const bgColor = isDark ? '#0f172a' : '#f8fafc';
  const miniMapNodeColor = (n: Node) =>
    ((n.data as unknown as StoryNodeData).isOnActivePath ? '#6366f1' : isDark ? '#374151' : '#e5e7eb');

  return (
    <div className="w-full h-full" style={{ background: bgColor }}>
      <ReactFlow
        nodes={nodes}
        edges={edges}
        onNodesChange={onNodesChange}
        onEdgesChange={onEdgesChange}
        nodeTypes={nodeTypes}
        fitView
        fitViewOptions={{ padding: 0.3 }}
        minZoom={0.2}
        maxZoom={2}
        proOptions={{ hideAttribution: true }}
      >
        <Background
          variant={BackgroundVariant.Dots}
          gap={20}
          size={1.2}
          color={isDark ? '#1e293b' : '#e2e8f0'}
        />
        <Controls
          className="!bg-transparent"
          style={{ bottom: 16, left: 16 }}
          showInteractive={false}
        />
        <MiniMap
          nodeColor={miniMapNodeColor}
          maskColor={isDark ? 'rgba(0,0,0,0.6)' : 'rgba(255,255,255,0.6)'}
          style={{ bottom: 16, right: 16, borderRadius: 12 }}
          pannable
          zoomable
        />
      </ReactFlow>
    </div>
  );
};

export default StorylineMap;
