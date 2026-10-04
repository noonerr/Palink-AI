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
import { ChevronDown, ChevronRight, Pencil } from "lucide-react";
import { parseMvuSchema } from "../../../utils/mvuSchemaParser";
import {
  buildStatDataPath,
  coerceValueByOriginal,
  patchSessionVariables,
} from "../../../services/mvuVariables";
import "./TavernHelperPanel.css";

interface TavernHelperPanelProps {
  tavernHelper?: { scripts?: Array<{ content?: string }> } | null;
  statData?: Record<string, any> | null;
  /** 初始是否折叠。逐条消息渲染时建议仅最新一条展开（传 !isLast）。 */
  defaultCollapsed?: boolean;
  /**
   * 会话 id。**只有传了它才启用编辑** —— 拿不到会话 id 时面板保持纯只读，
   * 与加这个功能之前逐字节一致（不引入一个恒不生效的假按钮）。
   */
  sessionId?: string | null;
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

export default function TavernHelperPanel({
  tavernHelper,
  statData,
  defaultCollapsed = false,
  sessionId,
}: TavernHelperPanelProps) {
  const [collapsed, setCollapsed] = useState(defaultCollapsed);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState<Record<string, string>>({});
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const schemaTree = useMemo(() => parseMvuSchema(tavernHelper), [tavernHelper]);
  const groups = schemaTree ? Object.keys(schemaTree) : [];
  const canEdit = Boolean(sessionId);

  if (!groups.length) return null;

  // 用 JSON 数组作键，避免选分隔符（早先误用了字面 NUL 字节，
  // 会让 git 把整个文件判成二进制）。
  const draftKey = (group: string, field: string) => JSON.stringify([group, field]);

  const commitEdits = async () => {
    if (!sessionId) return;
    const patches = Object.keys(draft).map((key) => {
      const [group, field] = JSON.parse(key) as [string, string];
      const fallback = (schemaTree?.[group] as Record<string, any> | undefined)?.[field];
      const original = resolveValue(statData, group, field, fallback);
      return {
        op: "replace" as const,
        path: buildStatDataPath(group, field),
        value: coerceValueByOriginal(draft[key], original),
      };
    });
    if (!patches.length) {
      setEditing(false);
      return;
    }
    setSaving(true);
    setError(null);
    try {
      await patchSessionVariables(sessionId, patches);
      setDraft({});
      setEditing(false);
      // 父组件会在下一轮 refetch 时拿到新值；此处不自行改写 props.statData，
      // 避免与后端的真源产生两份互相打架的状态。
      window.dispatchEvent(new CustomEvent("palink:mvuVariablesEdited"));
    } catch (e: any) {
      setError(e?.message || "变量写入失败");
    } finally {
      setSaving(false);
    }
  };

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
      {/* 编辑入口只在拿得到 sessionId 时出现：拿不到就是纯只读，不摆一个点了没反应的按钮。 */}
      {canEdit && !collapsed && (
        <button
          type="button"
          className="palink-th-panel__edit-toggle"
          onClick={() => (editing ? commitEdits() : setEditing(true))}
          disabled={saving}
        >
          <Pencil size={12} />
          {saving ? "保存中…" : editing ? "保存" : "编辑"}
        </button>
      )}
      {error && <div className="palink-th-panel__error">{error}</div>}
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

                    if (editing) {
                      const key = draftKey(group, field);
                      return (
                        <div className="palink-th-panel__row palink-th-panel__row--edit" key={field}>
                          <span className="palink-th-panel__key">{field}</span>
                          <input
                            className="palink-th-panel__input"
                            type={isBarValue(value) ? "number" : "text"}
                            value={draft[key] ?? formatValue(value)}
                            onChange={(e) =>
                              setDraft((d) => ({ ...d, [key]: e.target.value }))
                            }
                            aria-label={`${group} ${field}`}
                          />
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
