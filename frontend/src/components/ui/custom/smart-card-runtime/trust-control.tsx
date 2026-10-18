/**
 * 智能卡「信任此卡」入口组件（包D · 2026-10-18）
 *
 * 为什么要抽出来：信任分级的**判定与授权写入**早就写完了
 * （`storage.ts` 的 `readSmartCardTrustGrant` / `writeSmartCardTrustGrant`、
 * `CharacterCardRenderer` 的 sandbox 分级），但发起入口的按钮和确认弹窗
 * 埋在 1800 行的巨型组件里、且只在沉浸式分支渲染 ⇒ 非沉浸式（内联）卡
 * 根本没有可达路径。本文件只把**这层 UI** 抽成可测组件：
 *   ① `shouldShowSmartCardTrustControl` —— 谁能被信任（只有会执行脚本的帧）；
 *   ② `nextSmartCardTrustAction` —— 点一下是"授予"还是"撤销"；
 *   ③ `SmartCardTrustButton` / `SmartCardTrustConfirmDialog` —— 呈现层。
 *
 * ⚠️ 边界（P1-1 红线，不许松动）：
 *   - 本文件**不决定** sandbox 字符串，也**不写**授权存储；它只回调 `onToggle`。
 *     `allow-same-origin` 仍然只由 `CharacterCardRenderer` 的
 *     `trustedNative ? 'allow-scripts allow-same-origin …' : 'allow-scripts …'` 产生。
 *   - `static-html`（不执行脚本的卡）**永远不给入口** —— 没有脚本就没有要信任的东西，
 *     给它开关只会诱导用户白白放开同源。
 *   - 授予前必须过确认弹窗（`SmartCardTrustConfirmDialog`），文案写清代价。不做静默提权。
 */
import React from 'react';
import { Shield, ShieldCheck } from 'lucide-react';
import type { IframeRenderMode } from './shared';

export type SmartCardTrustAction = 'enable' | 'revoke';

/** 确认弹窗需要的文案切片（来自 `SMART_CARD_UI_TEXT[lang]`，此处不重复定义）。 */
export interface SmartCardTrustText {
  nativeEnabled: string;
  enableNative: string;
  revokeNative: string;
  enableNativeConfirm: string;
  revokeNativeConfirm: string;
  cancel: string;
  confirm: string;
}

/**
 * 是否展示信任入口：**只有会跑脚本的 iframe 模式**才有意义。
 * `static-html` 走 DOMPurify 净化、连 `allow-scripts` 都不给 ⇒ 无脚本可信任。
 */
export function shouldShowSmartCardTrustControl(effectiveMode: IframeRenderMode): boolean {
  return effectiveMode === 'iframe-js' || effectiveMode === 'trusted-native';
}

/** 点一下按钮要发起的动作：已信任 → 撤销；未信任 → 授予。 */
export function nextSmartCardTrustAction(trusted: boolean): SmartCardTrustAction {
  return trusted ? 'revoke' : 'enable';
}

export interface SmartCardTrustButtonProps {
  trusted: boolean;
  text: SmartCardTrustText;
  onToggle: (event: React.MouseEvent<HTMLButtonElement>) => void;
  className?: string;
  style?: React.CSSProperties;
  iconClassName?: string;
}

/**
 * 盾牌按钮。`data-palink-card-trust` 是真机取证的锚点
 * （生产包 console 被 terser 剥光，只能靠 DOM 属性读数）。
 */
export function SmartCardTrustButton({
  trusted,
  text,
  onToggle,
  className,
  style,
  iconClassName = 'h-4 w-4',
}: SmartCardTrustButtonProps) {
  const label = trusted ? text.nativeEnabled : text.enableNative;
  return (
    <button
      type="button"
      data-palink-card-trust={trusted ? 'granted' : 'none'}
      className={className}
      style={style}
      title={label}
      aria-label={label}
      aria-pressed={trusted}
      onClick={onToggle}
    >
      {trusted ? (
        <ShieldCheck className={iconClassName} aria-hidden="true" />
      ) : (
        <Shield className={iconClassName} aria-hidden="true" />
      )}
    </button>
  );
}

export interface SmartCardTrustConfirmDialogProps {
  action: SmartCardTrustAction;
  text: SmartCardTrustText;
  titleId: string;
  onConfirm: (event: React.MouseEvent<HTMLButtonElement>) => void;
  onCancel: (event?: React.MouseEvent<HTMLElement>) => void;
  /** 容器定位类名由宿主给（沉浸式 = fixed 覆盖层内绝对定位，内联 = 卡片 wrapper 内绝对定位）。 */
  className?: string;
}

/**
 * 事前确认弹窗（沿用原沉浸式实现的语义：点遮罩 = 取消，不做静默提权）。
 * 标题/正文都按 `action` 取「授予」或「撤销」那份文案。
 */
export function SmartCardTrustConfirmDialog({
  action,
  text,
  titleId,
  onConfirm,
  onCancel,
  className,
}: SmartCardTrustConfirmDialogProps) {
  const isEnable = action === 'enable';
  return (
    <div
      className={className}
      onClick={(event) => onCancel(event)}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        className="w-full max-w-sm rounded-lg border border-white/15 bg-zinc-950/95 p-4 text-white shadow-2xl"
        onClick={(event) => event.stopPropagation()}
      >
        <h2 id={titleId} className="text-base font-semibold">
          {isEnable ? text.enableNative : text.revokeNative}
        </h2>
        <p className="mt-3 whitespace-pre-line text-sm leading-6 text-white/75">
          {isEnable ? text.enableNativeConfirm : text.revokeNativeConfirm}
        </p>
        <div className="mt-5 flex justify-end gap-2">
          <button
            type="button"
            data-palink-card-trust-choice="cancel"
            className="inline-flex h-9 items-center justify-center rounded-md border border-white/15 px-3 text-sm text-white/80 transition-colors hover:bg-white/10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/70"
            onClick={(event) => onCancel(event)}
          >
            {text.cancel}
          </button>
          <button
            type="button"
            data-palink-card-trust-choice="confirm"
            className="inline-flex h-9 items-center justify-center rounded-md bg-white px-3 text-sm font-medium text-zinc-950 transition-colors hover:bg-white/90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/70"
            onClick={onConfirm}
          >
            {text.confirm}
          </button>
        </div>
      </div>
    </div>
  );
}
