/**
 * TavernHelperPanel.tsx
 *
 * Tavern Helper（酒馆助手）兼容「好感度/状态面板」渲染器（高保真复刻其标志性外观）。
 *
 * 重要前提（已核实）：角色卡 extensions.tavern_helper 的 schema 只定义「变量结构 + 默认值」
 * （见 scripts/chara-decoded.json 中 z.object 脚本），**不含任何 HTML/CSS/颜色**。
 * 真实的颜色/特效来自酒馆助手扩展的渲染代码——该代码不在本仓库/容器内，
 * 故此处按酒馆助手状态栏的标志性观感复刻：数值进度条按值变色（红→橙→黄→绿）、
 * 分组带强调色、头像字段渲染缩略图、卡片整体有配色与质感。
 *
 * 数据来源（由 CharacterChat 通过 props 传入，自包含，不依赖 window）：
 *   - tavernHelper: 角色卡 extensions.tavern_helper（含 schema 脚本文本）
 *   - statData:     会话级 stat_data（后端 mvu_engine 生成/更新）
 *
 * 渲染逻辑：
 *   1. utils/mvuSchemaParser.parseMvuSchema 正则解析 z.object 得到字段树（含默认值）。
 *   2. 字段显示值 = statData[group][field] ?? schema 默认值。
 *   3. number 且 0–100 → 按值变色的进度条；头像* 字段且非空 → 缩略图；布尔 → 是/否；其余 → 文本。
 *
 * 样式：独立 TavernHelperPanel.css（.palink-th-panel 前缀），Vite 打包为外部样式表。
 * 布局安全：根节点 flex:0 0 auto + max-height:42vh + overflow-y:auto，避免撑爆聊天容器。
 * 无 schema 的角色卡返回 null。
 */

import React, { useMemo, useState } from "react";
import { ChevronDown, ChevronRight } from "lucide-react";
import { parseMvuSchema } from "../../../utils/mvuSchemaParser";
import "./TavernHelperPanel.css";

interface TavernHelperPanelProps {
  tavernHelper?: { scripts?: Array<{ content?: string }> } | null;
  statData?: Record<string, any> | null;
  /** 初始是否折叠。逐条消息渲染时建议仅最新一条展开（传 !isLast）。 */
  defaultCollapsed?: boolean;
}

function resolveValue(
  statData: Record<string, any> | null | undefined,
  group: string,
  field: string,
  fallback: any,
): any {
  const g = statData?.[group];
  if (g && typeof g === "object" && field in g) {
    const v = (g as Record<string, any>)[field];
    if (v !== undefined && v !== null) return v;
  }
  return fallback;
}

function isBarValue(v: any): boolean {
  return typeof v === "number" && v >= 0 && v <= 100;
}

/** 按数值生成酒馆助手风格进度条配色：红(0)→橙→黄→绿(100)。 */
function barFillStyle(v: number): React.CSSProperties {
  const pct = Math.max(0, Math.min(100, v));
  const hue = (pct / 100) * 125; // 0=红, 125≈绿
  return {
    width: `${pct}%`,
    background: `linear-gradient(90deg, hsl(${hue},85%,52%) 0%, hsl(${hue + 14},92%,62%) 100%)`,
    boxShadow: `0 0 8px hsla(${hue},90%,55%,0.55)`,
  };
}

const AVATAR_RE = /头像|头像通常|头像羞|头像発|头像发/;
function isAvatarField(field: string): boolean {
  return AVATAR_RE.test(field);
}
function looksLikeImage(v: any): boolean {
  return (
    typeof v === "string" &&
    v.length > 0 &&
    (v.startsWith("http") || v.startsWith("/") || /\.(png|jpe?g|gif|webp|avif)$/i.test(v))
  );
}

function formatValue(v: any): string {
  if (typeof v === "boolean") return v ? "是" : "否";
  if (v === null || v === undefined || v === "") return "—";
  if (typeof v === "object") {
    try {
      return JSON.stringify(v);
    } catch {
      return String(v);
    }
  }
  return String(v);
}

/** 为每个分组分配一个稳定的强调色（酒馆助手分组观感）。 */
const GROUP_ACCENTS = [
  "#ec4899", "#8b5cf6", "#3b82f6", "#06b6d4", "#22c55e", "#f59e0b", "#ef4444", "#14b8a6",
];
function groupAccent(index: number): string {
  return GROUP_ACCENTS[index % GROUP_ACCENTS.length];
}

export default function TavernHelperPanel({ tavernHelper, statData, defaultCollapsed = false }: TavernHelperPanelProps) {
  const [collapsed, setCollapsed] = useState(defaultCollapsed);
  const schemaTree = useMemo(() => parseMvuSchema(tavernHelper), [tavernHelper]);
  const groups = schemaTree ? Object.keys(schemaTree) : [];

  if (!groups.length) return null;

  return (
    <div className="palink-th-panel">
      <button
        type="button"
        className="palink-th-panel__title"
        onClick={() => setCollapsed((c) => !c)}
        aria-expanded={!collapsed}
      >
        {collapsed ? <ChevronRight size={14} /> : <ChevronDown size={14} />}
        <span className="palink-th-panel__title-icon">📊</span>
        <span>状态面板</span>
      </button>
      {!collapsed && (
        <div className="palink-th-panel__body">
          {groups.map((group, gi) => {
            const fields = schemaTree[group];
            if (!fields || typeof fields !== "object") return null;
            const accent = groupAccent(gi);
            return (
              <div className="palink-th-panel__group" key={group}>
                <div className="palink-th-panel__group-name" style={{ borderLeftColor: accent }}>
                  <span className="palink-th-panel__group-dot" style={{ background: accent }} />
                  {group}
                </div>
                <div className="palink-th-panel__group-body">
                  {Object.keys(fields).map((field) => {
                    const fallback = (fields as Record<string, any>)[field];
                    const value = resolveValue(statData, group, field, fallback);

                    // 头像字段：渲染缩略图
                    if (isAvatarField(field) && looksLikeImage(value)) {
                      return (
                        <div className="palink-th-panel__avatar-row" key={field}>
                          <img
                            className="palink-th-panel__avatar"
                            src={value}
                            alt={field}
                            loading="lazy"
                          />
                          <span className="palink-th-panel__key">{field}</span>
                        </div>
                      );
                    }

                    if (isBarValue(value)) {
                      const pct = Math.max(0, Math.min(100, Number(value)));
                      return (
                        <div className="palink-th-panel__row" key={field}>
                          <span className="palink-th-panel__key">{field}</span>
                          <span className="palink-th-panel__bar">
                            <span className="palink-th-panel__bar-fill" style={barFillStyle(value)} />
                          </span>
                          <span className="palink-th-panel__bar-num">{formatValue(value)}</span>
                        </div>
                      );
                    }

                    return (
                      <div className="palink-th-panel__row palink-th-panel__row--text" key={field}>
                        <span className="palink-th-panel__key">{field}</span>
                        <span className="palink-th-panel__val">{formatValue(value)}</span>
                      </div>
                    );
                  })}
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
