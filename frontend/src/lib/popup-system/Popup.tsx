/**
 * Popup Component - 弹窗渲染组件
 * 基于 SillyTavern popup.js
 */

import React, { useState, useEffect, useCallback, useRef } from 'react';
import DOMPurify from 'dompurify';
import { popupManager } from './manager';
import type { PopupState, PopupOptions, CustomButton } from './types';
import { PopupType, PopupResult } from './types';

// ============================================================
// Popup 组件
// ============================================================

export function Popup() {
  const [state, setState] = useState<PopupState | null>(null);
  const [inputValue, setInputValue] = useState('');
  const inputRef = useRef<HTMLInputElement>(null);

  // [N-20] 订阅弹窗状态变更（替代 100ms 轮询）：isOpen 变化即时反映，卸载时退订
  useEffect(() => {
    const checkState = () => {
      const currentState = popupManager.getState();
      setState(currentState);

      if (currentState?.type === PopupType.INPUT) {
        setInputValue(currentState.options.placeholder || '');
      }
    };

    // 初始检查
    checkState();

    return popupManager.subscribe(checkState);
  }, []);

  // 自动聚焦输入框
  useEffect(() => {
    if (state?.isOpen && state.type === PopupType.INPUT && inputRef.current) {
      inputRef.current.focus();
      inputRef.current.select();
    }
  }, [state]);

  // 处理确认
  const handleConfirm = useCallback(() => {
    if (state?.type === PopupType.INPUT) {
      popupManager.affirm(inputValue);
    } else {
      popupManager.affirm();
    }
  }, [state, inputValue]);

  // 处理取消
  const handleCancel = useCallback(() => {
    popupManager.cancel();
  }, []);

  // 处理键盘事件
  const handleKeyDown = useCallback((e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleConfirm();
    } else if (e.key === 'Escape') {
      handleCancel();
    }
  }, [handleConfirm, handleCancel]);

  // 处理自定义按钮
  const handleCustomButton = useCallback((button: CustomButton) => {
    button.action?.();
    popupManager.close(button.result);
  }, []);

  // 如果没有弹窗状态，不渲染
  if (!state?.isOpen) {
    return null;
  }

  const { header, text, options, type } = state;

  return (
    <div
      className="fixed inset-0 flex items-center justify-center bg-black/50 z-[1000]"
      onClick={handleCancel}
    >
      <div
        className={`bg-background rounded-lg shadow-lg max-w-lg w-full mx-4 ${
          options.wide ? 'max-w-2xl' : ''
        } ${options.large ? 'max-w-4xl' : ''}`}
        onClick={(e) => e.stopPropagation()}
      >
        {/* 头部 */}
        <div className="px-6 py-4 border-b border-border">
          <h3 className="text-lg font-semibold">{header}</h3>
        </div>

        {/* 内容 */}
        <div className="px-6 py-4">
          {type === PopupType.DISPLAY ? (
            // [N-1] DISPLAY 分支经 dangerouslySetInnerHTML 注入主 origin，必须先经 DOMPurify 消毒；
            // TEXT/CONFIRM/INPUT 走 React 文本节点本已安全，不在此处理
            <div
              className="whitespace-pre-wrap"
              dangerouslySetInnerHTML={{
                __html: DOMPurify.sanitize(String(text ?? ''), {
                  FORBID_TAGS: ['script'],
                  FORBID_ATTR: ['onerror', 'onload', 'onclick', 'onmouseover'],
                }),
              }}
            />
          ) : type === PopupType.INPUT ? (
            <div>
              {text && <p className="mb-3 text-muted-foreground">{text}</p>}
              {options.rows && options.rows > 1 ? (
                <textarea
                  ref={inputRef as any}
                  value={inputValue}
                  onChange={(e) => setInputValue(e.target.value)}
                  onKeyDown={handleKeyDown}
                  placeholder={options.placeholder}
                  rows={options.rows}
                  className="w-full p-2 border border-border rounded-md bg-background"
                />
              ) : (
                <input
                  ref={inputRef}
                  type="text"
                  value={inputValue}
                  onChange={(e) => setInputValue(e.target.value)}
                  onKeyDown={handleKeyDown}
                  placeholder={options.placeholder}
                  className="w-full p-2 border border-border rounded-md bg-background"
                />
              )}
            </div>
          ) : (
            <p className="text-muted-foreground">{text}</p>
          )}
        </div>

        {/* 按钮区域 */}
        <div className="px-6 py-4 border-t border-border flex justify-end gap-2">
          {/* 自定义按钮 */}
          {options.customButtons?.map((button, index) => (
            <button
              key={index}
              onClick={() => handleCustomButton(button)}
              className={`px-4 py-2 rounded-md border border-border hover:bg-accent ${
                button.classes?.join(' ') || ''
              }`}
            >
              {button.text}
            </button>
          ))}

          {/* 取消按钮 */}
          {options.cancelButton && (
            <button
              onClick={handleCancel}
              className="px-4 py-2 rounded-md border border-border hover:bg-accent"
            >
              {typeof options.cancelButton === 'string'
                ? options.cancelButton
                : '取消'}
            </button>
          )}

          {/* 确认按钮 */}
          {options.okButton && (
            <button
              onClick={handleConfirm}
              className="px-4 py-2 rounded-md bg-primary text-primary-foreground hover:bg-primary/90"
            >
              {typeof options.okButton === 'string'
                ? options.okButton
                : '确定'}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

export default Popup;
