/**
 * [包N C-1 2026-10-19] 导入时的「这张卡会执行自带脚本」提示 + 脚本检测。
 *
 * 背景：信任分级（D 档）早已落地，但入口只在卡片渲染后可见 —— 用户导入一张会跑脚本的卡时
 * 完全不知道它接下来会请求同源权限。本模块补的是**导入这一刻**的告知与一次性选择：
 *   · 检测（纯函数，可单测）：这张卡的内容是否真的会执行脚本；
 *   · 提示（纯呈现）：只负责问，**不写任何存储**（授权写入由调用方决定，见 storage.ts 的
 *     writeSmartCardTrustOptIn —— 边界与 trust-control.tsx 同一条红线）。
 *
 * 为什么检测要复用 `htmlNeedsIframe`：它是渲染侧真正决定「这张卡要不要进 iframe 跑脚本」的
 * 判据（script / on* 内联处理器 / iframe|object|embed|form / window|document|localStorage 引用 /
 * getContext|SillyTavern 调用）。另起一套正则 = 两套口径，迟早打架。
 *
 * ⚠️ 纯文本卡（含只有 <style> 的静态卡）**不提示** —— 没有脚本可信任，弹窗只会造成"狼来了"。
 */
import React from 'react';
import { ShieldAlert } from 'lucide-react';
import { htmlNeedsIframe } from './html-detect';

export interface CardScriptDetection {
  /** 这张卡会不会执行自带脚本 */
  executes: boolean;
  /** 命中的原因（机器可读短码，供真机取证/日志；不含卡片正文） */
  reasons: string[];
}

const TEXT_SURFACES = ['first_mes'] as const;
const TEXT_LIST_SURFACES = ['alternate_greetings', 'group_only_greetings'] as const;

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

/** 从 extensions 里取出 regex 脚本数组（兼容顶层 / extensions.extensions / data 三层）。 */
function collectRegexScripts(extensions: unknown, depth = 0): Array<Record<string, unknown>> {
  const record = asRecord(extensions);
  if (!record || depth > 2) return [];
  const out: Array<Record<string, unknown>> = [];
  const direct = record.regex_scripts;
  if (Array.isArray(direct)) {
    for (const item of direct) {
      const entry = asRecord(item);
      if (entry) out.push(entry);
    }
  }
  const nested = record.extensions ?? record.data;
  if (nested) out.push(...collectRegexScripts(nested, depth + 1));
  return out;
}

/** tavern_helper 脚本清单（与 lib/sillytavern/card-script-runner.ts:115-119 同口径）。 */
function collectTavernHelperScripts(extensions: unknown): Array<Record<string, unknown>> {
  const record = asRecord(extensions);
  const helper = asRecord(record?.tavern_helper);
  const scripts = helper?.scripts;
  if (!Array.isArray(scripts)) return [];
  return scripts.map((item) => asRecord(item)).filter(Boolean) as Array<Record<string, unknown>>;
}

/**
 * 判断一张角色卡（导入接口返回的 `result.character` 形状）是否会执行脚本。
 *
 * 三个来源：
 *   ① extensions.tavern_helper.scripts[] 有非空脚本正文（卡内脚本执行器直接跑）；
 *   ② first_mes / alternate_greetings / group_only_greetings 需要 iframe 跑脚本
 *      （htmlNeedsIframe：<script>、on* 内联处理器、getContext/SillyTavern 调用等）；
 *   ③ extensions.regex_scripts[].replaceString 注入的 HTML 需要 iframe 跑脚本。
 */
export function detectCardScripts(card: unknown): CardScriptDetection {
  const reasons: string[] = [];
  const record = asRecord(card);
  if (!record) return { executes: false, reasons };

  const extensions = record.extensions;
  for (const script of collectTavernHelperScripts(extensions)) {
    const content = typeof script.content === 'string' ? script.content.trim() : '';
    const type = typeof script.type === 'string' ? script.type : '';
    if (content && (!type || type === 'script')) {
      reasons.push('tavern_helper_scripts');
      break;
    }
  }

  for (const key of TEXT_SURFACES) {
    const text = record[key];
    if (typeof text === 'string' && htmlNeedsIframe(text)) {
      reasons.push(`${key}_needs_iframe`);
      break;
    }
  }

  for (const key of TEXT_LIST_SURFACES) {
    const list = record[key];
    if (Array.isArray(list) && list.some((item) => typeof item === 'string' && htmlNeedsIframe(item))) {
      reasons.push(`${key}_needs_iframe`);
      break;
    }
  }

  for (const script of collectRegexScripts(extensions)) {
    if (script.disabled === true || script.enabled === false) continue;
    const replacement = script.replaceString ?? script.replace_string;
    if (typeof replacement === 'string' && htmlNeedsIframe(replacement)) {
      reasons.push('regex_scripts_need_iframe');
      break;
    }
  }

  return { executes: reasons.length > 0, reasons };
}

export interface CardScriptTrustPromptText {
  title: string;
  body: string;
  accept: string;
  skip: string;
}

export interface CardScriptTrustPromptProps {
  text: CardScriptTrustPromptText;
  characterName?: string;
  onAccept: () => void;
  onSkip: () => void;
}

/**
 * 导入后的信任询问。`data-palink-card-trust-prompt` 是真机取证锚点
 * （生产包 console 被 terser 剥光，只能靠 DOM 属性读数）。
 * 点遮罩 = 跳过（与 trust-control 的确认弹窗同语义：不做静默授权）。
 */
export function CardScriptTrustPrompt({
  text,
  characterName,
  onAccept,
  onSkip,
}: CardScriptTrustPromptProps) {
  return (
    <div
      className="fixed inset-0 z-[10000] flex items-center justify-center bg-slate-950/60 p-4 backdrop-blur-sm"
      data-palink-card-trust-prompt="1"
      onClick={onSkip}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="palink-card-trust-prompt-title"
        className="w-[min(92vw,420px)] rounded-2xl border border-slate-200 bg-white p-5 shadow-2xl dark:border-slate-700 dark:bg-slate-900"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="flex items-start gap-3">
          <ShieldAlert className="mt-0.5 h-5 w-5 shrink-0 text-amber-500" aria-hidden="true" />
          <div className="min-w-0">
            <h2
              id="palink-card-trust-prompt-title"
              className="text-base font-semibold text-slate-900 dark:text-white"
            >
              {text.title}
            </h2>
            {characterName ? (
              <p className="mt-1 truncate text-xs text-slate-500 dark:text-slate-400">{characterName}</p>
            ) : null}
            <p className="mt-3 whitespace-pre-line text-sm leading-6 text-slate-600 dark:text-slate-300">
              {text.body}
            </p>
          </div>
        </div>
        <div className="mt-5 flex justify-end gap-2">
          <button
            type="button"
            data-palink-card-trust-prompt-choice="skip"
            className="inline-flex h-9 items-center justify-center rounded-md border border-slate-200 px-3 text-sm text-slate-600 transition-colors hover:bg-slate-100 dark:border-slate-700 dark:text-slate-300 dark:hover:bg-slate-800"
            onClick={(event) => { event.stopPropagation(); onSkip(); }}
          >
            {text.skip}
          </button>
          <button
            type="button"
            data-palink-card-trust-prompt-choice="accept"
            className="inline-flex h-9 items-center justify-center rounded-md bg-slate-900 px-3 text-sm font-medium text-white transition-colors hover:bg-slate-800 dark:bg-white dark:text-slate-900 dark:hover:bg-slate-100"
            onClick={(event) => { event.stopPropagation(); onAccept(); }}
          >
            {text.accept}
          </button>
        </div>
      </div>
    </div>
  );
}
