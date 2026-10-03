import React from 'react';
import { createPortal } from 'react-dom';
import { AlertCircle, WifiOff, ServerCrash, Clock, Key, CheckCircle2, XCircle, HelpCircle } from 'lucide-react';
import { Alert, AlertTitle, AlertDescription } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { ErrorInfo, ErrorType } from '@/lib/errorHandler';

interface ErrorToastProps {
  errorInfo: ErrorInfo;
  onClose?: () => void;
  onRetry?: () => void;
  showRetry?: boolean;
  className?: string;
  /** 【报错提示 1.4】为 true 时只渲染卡片本体（不带 Portal 与 fixed 定位容器），
   *  供调用方把错误卡与超时提醒放进同一个定位容器，消掉两个浮层的坐标冲突。 */
  inline?: boolean;
}

const errorIcons: Record<ErrorType, React.ReactNode> = {
  network: <WifiOff className="h-5 w-5 text-orange-500" />,
  server: <ServerCrash className="h-5 w-5 text-red-500" />,
  timeout: <Clock className="h-5 w-5 text-yellow-500" />,
  auth: <Key className="h-5 w-5 text-purple-500" />,
  validation: <XCircle className="h-5 w-5 text-red-500" />,
  model_unavailable: <HelpCircle className="h-5 w-5 text-blue-500" />,
  unknown: <AlertCircle className="h-5 w-5 text-gray-500" />
};

// 【报错提示 1.3】底部错误卡的两步修法（只做一件无效）：
// (1) createPortal 到 document.body —— 逃离 MobilePager 槽位的
//     transform/will-change 包含块（App.tsx:407/436）。带 transform 的祖先会把
//     fixed 子元素的包含块改成槽位并另起层叠上下文，导致 z-50 只在槽位内有效，
//     而 dock（同为 z-50，但位于 main 之外）无条件压在它上面。
//     与 ChatInputArea.tsx:102-127 已验证的方案完全一致。
// (2) bottom 由 --palink-kb-vh 驱动 —— iOS 26/27 键盘只缩 visual viewport、
//     布局视口恒不变（WebKit Bug 304976），Portal 之后卡仍锚在布局视口底部，
//     键盘一开照样把它埋掉。默认 bottom = safe-area + dock 高 + 12px；
//     键盘弹起时由 index.css 的 html.palink-kb-open 规则接管，抬到键盘上沿。
//     ⚠「按钮被 dock 压住」是被实测推翻的旧结论（只咬 7.7px），真凶是键盘。
export function ErrorToast({
  errorInfo,
  onClose,
  onRetry,
  showRetry = true,
  className = '',
  inline = false
}: ErrorToastProps) {
  const [showDetails, setShowDetails] = React.useState(false);

  const card = (
      <Alert className="w-full max-w-md border-l-4 border-red-500 bg-card shadow-lg">
        <div className="flex items-start gap-3">
          {errorIcons[errorInfo.type]}
          <div className="flex-1">
            <AlertTitle className="text-base font-semibold flex items-center gap-2">
              {errorInfo.title}
            </AlertTitle>
            <AlertDescription className="mt-1">
              <p className="text-sm mb-2">{errorInfo.description}</p>
              <p className="text-sm text-muted-foreground bg-muted/40 rounded px-2 py-1 inline-flex items-center gap-1">
                <CheckCircle2 className="h-4 w-4" />
                {errorInfo.suggestion}
              </p>

              {errorInfo.technicalDetails && (
                <div className="mt-3">
                  <button
                    onClick={() => setShowDetails(!showDetails)}
                    className="text-xs text-gray-500 hover:text-gray-700 dark:hover:text-gray-300 underline"
                  >
                    {showDetails ? '隐藏技术详情' : '显示技术详情'}
                  </button>
                  {showDetails && (
                    <div className="mt-2 p-2 bg-gray-100 dark:bg-gray-800 rounded text-xs font-mono text-gray-600 dark:text-gray-400 break-all">
                      {errorInfo.technicalDetails}
                    </div>
                  )}
                </div>
              )}
            </AlertDescription>

            <div className="mt-3 flex gap-2">
              {showRetry && onRetry && (
                <Button
                  variant="default"
                  size="sm"
                  onClick={onRetry}
                >
                  重试
                </Button>
              )}
              {onClose && (
                <Button
                  variant="secondary"
                  size="sm"
                  onClick={onClose}
                >
                  关闭
                </Button>
              )}
            </div>
          </div>
        </div>
      </Alert>
  );

  // 【报错提示 1.4】inline 模式：调用方自带定位容器（见 CharacterChat 的
  // 统一 error/timeout 容器），这里只出卡片本体。
  if (inline) return card;

  return <ErrorToastPortalContainer className={className}>{card}</ErrorToastPortalContainer>;
};

export default ErrorToast;

// 【报错提示 1.3 + 1.4】统一的底部浮层定位容器：Portal 到 body + 键盘抬升钩子。
// 错误卡与超时提醒共用这一个容器，消掉两个浮层 bottom-4/right-4/z-50 的坐标冲突。
export function ErrorToastPortalContainer({
  children,
  className = ''
}: {
  children: React.ReactNode;
  className?: string;
}) {
  return createPortal(
    <div
      data-palink-error-overlay="true"
      className={`fixed left-0 right-0 z-[60] flex justify-end px-4 ${className}`}
      style={{
        // 键盘未弹起时的锚点：避开底部安全区 + dock 高度
        // （--palink-dock-height 定义于 index.css:97）
        bottom: 'calc(env(safe-area-inset-bottom, 0px) + var(--palink-dock-height, 90px) + 12px)',
      }}
    >
      {/* 容器 px-4 + 子项 max-w-md：修复旧实现 `w-full max-w-md right-4`
          把左边缘裁到内容区 −16px 的问题（ErrorToast.tsx:35 旧值） */}
      {children}
    </div>,
    document.body
  );
}
