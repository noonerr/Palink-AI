import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import App from './App.tsx'
import { ensureSlashCommandsBootstrapped } from './lib/slash-engine/bootstrap'
import { installPalinkDiagGlobals } from './components/ui/custom/smart-card-runtime/palink-diag'

// [包W 2026-10-19] 静默失败统一记录器：挂 window.__palinkDiagDump / __palinkDiagExport 等
// 可读入口（本机站点默认开 + localStorage 手动开关，外部站点默认关）。
// 这里只登记全局函数，不打印任何东西 ⇒ 用户可见行为零变化。
installPalinkDiagGlobals()

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
