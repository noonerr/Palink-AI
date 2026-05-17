import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import App from './App.tsx'

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
