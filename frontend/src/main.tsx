import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import App from './App.tsx'
import { ensureSlashCommandsBootstrapped } from './lib/slash-engine/bootstrap'

// [包B B-1 2026-10-18] 注册内置斜杠命令（幂等）。
// 此前 initSlashCommands() 全仓无调用点 ⇒ 运行时引擎为 0 条内置命令，
// 卡脚本/ST 插件的 /echo /abs /let /if 等一律拿不到结果。
ensureSlashCommandsBootstrapped()

// Suppress harmless ResizeObserver errors
// https://github.com/WICG/resize-observer/issues/38
const isResizeObserverError = (msg?: string) =>
  msg?.includes('ResizeObserver loop') ?? false;

const resizeObserverErrorHandler = (e: ErrorEvent) => {
  if (isResizeObserverError(e.message)) {
    e.stopImmediatePropagation();
    e.preventDefault();
  }
};
window.addEventListener('error', resizeObserverErrorHandler);

const origOnError = window.onerror;
window.onerror = (msg, src, lineno, colno, error) => {
  if (isResizeObserverError(String(msg))) return true;
  return origOnError ? origOnError(msg, src, lineno, colno, error) : false;
};

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
