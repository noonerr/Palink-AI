/**
 * VariableChangePanel.tsx
 *
 * 「变量变化」面板：把模型本轮输出引起的变量改动，逐条摊开给用户看。
 *
 * ## 为什么需要它
 *
 * MVU 卡的变量更新指令（`<UpdateVariable>`）在后端解析落库后会被**整块剥离**
 * （后端 3 处 + 前端 `Message.tsx` 兜底 1 处），用户看不到任何更新过程。
 * 现有的 `TavernHelperPanel` 只渲染「当前值」（schema × stat_data 快照），
 * **看不出这一轮改了什么**。SillyTavern 里 MVU 自带变量查看器正是补这一块，
 * Palink 此前缺失。
 *
 * ## 数据来源（全部是已有数据，不新增任何链路）
 *
 * - 本楼变量：`message.extra.variables.stat_data`（后端每轮落库的**消息级快照**，
 *   见 `character_message_builder.py` 的 `apply_mvu_reply_to_session` 调用方）
 * - 上一楼变量：`chatMessages[messageIndex - 1].extra.variables.stat_data`
 * - 都没有时回落会话级 `sessionVariables`（由 `Message.tsx` 计算后传入）
 *
 * 与 `TavernHelperPanel` 的关系：两者**并列**、互不替代。
 * 前者回答「现在是多少」，本组件回答「刚变成了多少」。
 *
 * ## 只读
 *
 * 本组件**只读不写**，不触碰变量写入链路，也不调用任何 MVU/酒馆助手 API。
 */

import React, { useMemo, useState } from 'react';
import { ChevronDown, ChevronRight } from 'lucide-react';
import './VariableChangePanel.css';

/** 单条变量改动。 */
export interface VariableChange {
  /** 完整路径（点号连接，如 `桃汐.好感度`） */
  path: string;
  /** 分组名（路径首段；无分组时为 `_`） */
  group: string;
  /** 字段名（路径其余部分） */
  field: string;
  kind: 'add' | 'change' | 'remove';
  from: unknown;
  to: unknown;
}

/** 只读字段前缀：与后端 `mvu_engine._is_readonly` 同一约定（`_` 开头不参与更新）。 */
const READONLY_PREFIX = '_';

/** 参与比较的最大深度，防御异常深的脏数据（真实 stat_data 两层已够用）。 */
const MAX_DEPTH = 6;

/**
 * 把嵌套变量树压平成 `路径 → 叶子值`。
 *
 * 叶子判定：非普通对象（含 null / 数组 / 基本类型）。数组按整体比较，
 * 不做逐元素 diff —— MVU 的 JSON Patch 对数组是整体 replace，语义一致。
 *
 * 空对象**不产出叶子**：`{桃汐: {}}` 压平后为空表。理由：空分组不携带信息，
 * 若把它当叶子，`{桃汐:{好感度:1}} → {桃汐:{}}` 会同时报出「桃汐: {} 新增」
 * 与「桃汐.好感度 移除」两条，前者是纯噪声。清空分组的正确表达就是"其子字段被移除"。
 */
export function flattenStatData(
  value: unknown,
  prefix = '',
  depth = 0,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if (value === null || value === undefined) return out;

  const isPlainObject =
    typeof value === 'object' && !Array.isArray(value);

  if (!isPlainObject || depth >= MAX_DEPTH) {
    if (prefix) out[prefix] = value;
    return out;
  }

  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    if (key.startsWith(READONLY_PREFIX)) continue;
    const next = prefix ? `${prefix}.${key}` : key;
    Object.assign(out, flattenStatData(child, next, depth + 1));
  }
  return out;
}

/** 稳定的值比较：基本类型用 Object.is，对象/数组用 JSON 序列化（key 顺序不保证，故先排序）。 */
function isSameValue(a: unknown, b: unknown): boolean {
  if (Object.is(a, b)) return true;
  if (a === null || b === null || a === undefined || b === undefined) return false;
  if (typeof a !== 'object' || typeof b !== 'object') return false;
  try {
    return stableStringify(a) === stableStringify(b);
  } catch {
    return false;
  }
}

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify(obj[k])}`).join(',')}}`;
}

/**
 * 对比两次 stat_data，返回按路径排序的改动清单。
 *
 * - 只出现在新值里 → `add`
 * - 两边都有但不同 → `change`
 * - 只出现在旧值里 → `remove`
 * - 完全一致 → 不出现在结果里
 */
export function diffStatData(
  prevStat: unknown,
  currStat: unknown,
): VariableChange[] {
  const before = flattenStatData(prevStat);
  const after = flattenStatData(currStat);
  const paths = Array.from(new Set([...Object.keys(before), ...Object.keys(after)])).sort();

  const changes: VariableChange[] = [];
  for (const path of paths) {
    const hadPrev = Object.prototype.hasOwnProperty.call(before, path);
    const hasNext = Object.prototype.hasOwnProperty.call(after, path);
    const from = before[path];
    const to = after[path];

    if (hadPrev && hasNext) {
      if (isSameValue(from, to)) continue;
      changes.push({ ...splitPath(path), kind: 'change', from, to });
    } else if (hasNext) {
      changes.push({ ...splitPath(path), kind: 'add', from: undefined, to });
    } else {
      changes.push({ ...splitPath(path), kind: 'remove', from, to: undefined });
    }
  }
  return changes;
}

function splitPath(path: string): { path: string; group: string; field: string } {
  const dot = path.indexOf('.');
  if (dot <= 0) return { path, group: '_', field: path };
  return { path, group: path.slice(0, dot), field: path.slice(dot + 1) };
}

/** 值 → 单行展示文本（与 TavernHelperPanel.formatValue 同口径，长文本截断）。 */
export function formatChangeValue(v: unknown, maxLen = 48): string {
  if (v === undefined) return '（无）';
  if (typeof v === 'boolean') return v ? '是' : '否';
  if (v === null || v === '') return '—';
  if (typeof v === 'object') {
    try {
      const s = JSON.stringify(v);
      return s.length > maxLen ? `${s.slice(0, maxLen)}…` : s;
    } catch {
      return String(v);
    }
  }
  const s = String(v);
  return s.length > maxLen ? `${s.slice(0, maxLen)}…` : s;
}

const KIND_LABEL: Record<VariableChange['kind'], string> = {
  add: '新增',
  change: '变化',
  remove: '移除',
};

export interface VariableChangePanelProps {
  /** 上一楼（或初始）的 stat_data */
  prevStatData?: Record<string, unknown> | null;
  /** 本楼的 stat_data */
  statData?: Record<string, unknown> | null;
  /** 初始是否折叠。逐条消息渲染时建议仅最新一条展开（传 !isLast）。 */
  defaultCollapsed?: boolean;
}

export default function VariableChangePanel({
  prevStatData,
  statData,
  defaultCollapsed = true,
}: VariableChangePanelProps) {
  const [collapsed, setCollapsed] = useState(defaultCollapsed);

  const changes = useMemo(() => {
    // 拿不到"上一楼"就无法判定变化 —— 宁可不显示，也不把"全量初始值"谎报成变化。
    if (!prevStatData || !statData) return [];
    try {
      return diffStatData(prevStatData, statData);
    } catch {
      return [];
    }
  }, [prevStatData, statData]);

  if (changes.length === 0) return null;

  return (
    <div className="palink-vc-panel" data-palink-contrast-skip>
      <button
        type="button"
        className="palink-vc-panel__title"
        onClick={() => setCollapsed((c) => !c)}
        aria-expanded={!collapsed}
      >
        {collapsed ? <ChevronRight size={14} /> : <ChevronDown size={14} />}
        <span className="palink-vc-panel__title-text">变量变化</span>
        <span className="palink-vc-panel__count">{changes.length}</span>
      </button>
      {!collapsed && (
        <div className="palink-vc-panel__body">
          {changes.map((c) => (
            <div
              className={`palink-vc-panel__row palink-vc-panel__row--${c.kind}`}
              key={`${c.kind}:${c.path}`}
            >
              <span className="palink-vc-panel__badge">{KIND_LABEL[c.kind]}</span>
              <span className="palink-vc-panel__key" title={c.path}>
                <span className="palink-vc-panel__group">{c.group}</span>
                <span className="palink-vc-panel__sep">·</span>
                {c.field}
              </span>
              <span className="palink-vc-panel__value">
                {c.kind !== 'add' && (
                  <>
                    <span className="palink-vc-panel__from" title={formatChangeValue(c.from, 500)}>
                      {formatChangeValue(c.from)}
                    </span>
                    <span className="palink-vc-panel__arrow">→</span>
                  </>
                )}
                {c.kind !== 'remove' && (
                  <span className="palink-vc-panel__to" title={formatChangeValue(c.to, 500)}>
                    {formatChangeValue(c.to)}
                  </span>
                )}
              </span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
