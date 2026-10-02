/**
 * 卡脚本扩展提示词持久化中继（[PROMPT-EVERY-TURN 2026-10-02]）
 *
 * 背景：卡插件经 setExtensionPrompt 注册的格式规范随 iframe 生命周期起伏
 * （开场卡卸载后规范缺席 → AI 回复失去排版框）。主方案（用户拍板）：
 * 帧上报 extensionPrompts 时同步落库到后端 extension_prompts 表，
 * 装配层每轮无条件带上；本模块负责把帧快照中继给后端。
 *
 * - source_key：按插件脚本包内容计算的稳定哈希（内容变了键就变；卡名、
 *   角色 id 都不进键——重导入换 char id 不失效、同名不同卡不串）。
 * - 幂等：同 (character, identifier) 内容未变则不重复 POST。
 * - 本模块只做 console 级诊断，绝不弹用户可见 UI（用户拍板：缺席提示不进
 *   用户屏幕；可见性如需做，单独加开关，不复用无门控的诊断通道）。
 */

import { api } from './api';
import { hashSmartCardSource, type SmartCardPluginScriptBundle } from '../components/ui/custom/smart-card-runtime/primitives';

/** 每轮发送时记录的 identifier 集合（用于回归检测），key = characterId:sessionId */
const lastSendIdentifiers = new Map<string, Set<string>>();
/** 回归警告的限频，key = characterId:sessionId:identifier */
const lastWarnTimes = new Map<string, number>();
/** 上次成功中继的内容签名，key = characterId:identifier */
const lastRelaySignatures = new Map<string, string>();

const WARN_COOLDOWN_MS = 60_000;

let lastSourceKeyBundle: SmartCardPluginScriptBundle | null = null;
let lastSourceKey = '';

/**
 * 计算当前插件脚本包的内容来源键（source_key）。
 * 规范文本由包内脚本产生，包内容不变则键不变；按 bundle 对象记忆化
 * （bundle 每次重新 fetch 都是新对象，按身份缓存即可）。
 */
export function computeSmartCardBundleSourceKey(bundle: SmartCardPluginScriptBundle | null): string {
  if (bundle === lastSourceKeyBundle) return lastSourceKey;
  let canonical = '';
  const scripts = (bundle && Array.isArray(bundle.scripts) ? bundle.scripts : [])
    .filter((s): s is NonNullable<typeof s> => !!s && typeof s.content === 'string')
    .sort((a, b) => `${a.pluginId}\u0000${a.zip_path || a.path || ''}`.localeCompare(`${b.pluginId}\u0000${b.zip_path || b.path || ''}`));
  for (const s of scripts) {
    // 长度前缀防拼接歧义
    canonical += `${s.pluginId || ''}\u0000${s.zip_path || s.path || ''}\u0000${(s.content || '').length}\u0000${s.content || ''}\u0001`;
  }
  lastSourceKeyBundle = bundle;
  lastSourceKey = canonical ? `fnv1a-${hashSmartCardSource(canonical)}` : '';
  return lastSourceKey;
}

/**
 * 中继帧上报的扩展提示词快照到后端持久化。
 * 帧初始化/每次 setExtensionPrompt 都会上报同一份快照——按内容签名去重，
 * 只有实际变化（或首次）才发请求。失败只 console，不影响生成链路。
 */
export function persistFrameExtensionPrompts(
  characterId: string | number | undefined,
  prompts: Record<string, unknown> | undefined,
  sourceKey: string,
): void {
  if (!characterId || !sourceKey || !prompts || typeof prompts !== 'object') return;
  const entries: Record<string, { content: string; position: number | undefined; depth: number | undefined; role: unknown; scan: boolean | undefined }> = {};
  for (const [identifier, raw] of Object.entries(prompts)) {
    if (!raw || typeof raw !== 'object') continue;
    const value = (raw as { value?: unknown }).value;
    const content = typeof value === 'string' ? value.trim() : '';
    if (!content) continue;
    const r = raw as { position?: number; depth?: number; role?: unknown; scan?: boolean };
    entries[identifier] = { content, position: r.position, depth: r.depth, role: r.role, scan: r.scan };
  }
  if (Object.keys(entries).length === 0) return;

  // 去重：只对内容有变化的 identifier 发送
  const changed: typeof entries = {};
  for (const [identifier, entry] of Object.entries(entries)) {
    const key = `${characterId}:${identifier}`;
    const signature = hashSmartCardSource(entry.content);
    if (lastRelaySignatures.get(key) === signature) continue;
    lastRelaySignatures.set(key, signature);
    changed[identifier] = entry;
  }
  if (Object.keys(changed).length === 0) return;

  api.post('/api/extension-prompts/persist', {
    character_id: String(characterId),
    source_key: sourceKey,
    prompts: changed,
  }).catch((err) => {
    console.warn('[EP-PERSIST] 扩展提示词持久化失败（不影响本轮生成）:', err);
  });
}

/**
 * 每轮发送时的回归检测（纯 console 诊断）：上一轮携带、本轮缺失的
 * identifier 打一条 warn。不弹 toast、不进用户 UI。
 */
export function noteSentExtensionPrompts(
  characterId: string | number | undefined,
  sessionId: string | null | undefined,
  identifiers: string[],
): void {
  if (!characterId) return;
  const key = `${characterId}:${sessionId || ''}`;
  const previous = lastSendIdentifiers.get(key);
  const current = new Set(identifiers);
  if (previous) {
    for (const identifier of previous) {
      if (current.has(identifier)) continue;
      const warnKey = `${key}:${identifier}`;
      const now = Date.now();
      if (now - (lastWarnTimes.get(warnKey) || 0) < WARN_COOLDOWN_MS) continue;
      lastWarnTimes.set(warnKey, now);
      console.warn(
        `[EP-BRIDGE] 本轮请求未携带扩展提示词「${identifier}」（上一轮在场）。` +
        '该轮模型可能失去对应格式约束；详情见消息 extra.ext_prompts。',
      );
    }
  }
  lastSendIdentifiers.set(key, current);
}
