function renderFatalError(message) {
  const root = document.getElementById('root');
  if (!root) {
    return;
  }

  // 关键修复：仅在 React 应用尚未启动时显示致命错误页。
  // 一旦 React 已渲染（#root 有非错误占位的子元素），绝不能用 replaceChildren
  // 销毁 React 管理的 DOM —— 否则 React 协调时抛出 NotFoundError: removeChild，
  // 导致整个应用崩溃。React 渲染错误应由 ErrorBoundary 处理，不在此处接管。
  // 触发本函数的典型非致命场景：ST 插件脚本抛错、CDN 资源（GSAP/pixi.js）
  // 加载失败的 unhandledrejection、插件调用未定义全局 API 的 ReferenceError 等。
  var hasReactContent = false;
  for (var i = 0; i < root.children.length; i++) {
    var child = root.children[i];
    // 跳过我们自己注入的错误占位（特征：inline style 含 color: red）
    if (child.style && child.style.color === 'red' && child.style.textAlign === 'center') {
      continue;
    }
    hasReactContent = true;
    break;
  }
  if (hasReactContent) {
    // React 已启动，错误交给 React 自己的 ErrorBoundary，不破坏 DOM
    return;
  }

  var wrapper = document.createElement('div');
  wrapper.style.padding = '20px';
  wrapper.style.textAlign = 'center';
  wrapper.style.color = 'red';

  var title = document.createElement('h1');
  title.textContent = '发生错误';

  var detail = document.createElement('p');
  detail.textContent = String(message ?? '未知错误');

  var refreshBtn = document.createElement('button');
  refreshBtn.textContent = '刷新页面';
  refreshBtn.addEventListener('click', function () {
    location.reload();
  });

  wrapper.appendChild(title);
  wrapper.appendChild(detail);
  wrapper.appendChild(refreshBtn);

  root.replaceChildren(wrapper);
}

window.onerror = function (msg, url, line, col, error) {
  // 忽略跨域脚本错误：浏览器出于安全原因只返回 "Script error."，
  // 无法调试且通常无害（如 Safari 分享菜单、第三方资源等可能触发）
  if (msg === 'Script error.' || (typeof msg === 'string' && msg.indexOf('Script error') === 0)) {
    console.warn('Cross-origin script error (ignored):', msg);
    return true; // 阻止默认错误处理，不显示错误页面
  }
  console.error('Global error:', msg, url, line, col, error);
  // 仅在 React 启动前显示致命错误页；启动后交给 ErrorBoundary
  renderFatalError(msg);
  return false;
};
window.onunhandledrejection = function (event) {
  console.error('Unhandled promise rejection:', event.reason);
  // Promise rejection 几乎都不是致命的（CDN 加载失败、插件异步报错等），
  // 不应摧毁已启动的 React 应用。仅在 React 未启动时显示致命错误页。
  renderFatalError(event.reason);
};

window.addEventListener('load', function () {
  setTimeout(function () {
    window.scrollTo(0, 1);
  }, 100);
});

window.addEventListener('orientationchange', function () {
  setTimeout(function () {
    window.scrollTo(0, 1);
  }, 100);
});

// === 强制缓存清理（版本驱动） ===
// 每次发布新版本时更新此版本号，浏览器检测到版本变化后
// 会清除所有 Service Worker、Cache API 和 IndexedDB，然后重新加载页面。
var PALINK_CACHE_VERSION = 'v16_generic_fixes';
(function () {
  var VERSION_KEY = 'palink_cache_version';
  var currentVersion = '';
  try { currentVersion = localStorage.getItem(VERSION_KEY) || ''; } catch (e) {}

  if (currentVersion === PALINK_CACHE_VERSION) return; // 版本一致，无需清理

  // 版本不一致，执行清理
  var tasks = [];

  // 1. 清除 Service Worker 注册
  if ('serviceWorker' in navigator) {
    tasks.push(
      navigator.serviceWorker.getRegistrations().then(function (regs) {
        return Promise.all(regs.map(function (r) { return r.unregister(); }));
      }).catch(function () {})
    );
  }

  // 2. 清除 Cache API
  if (window.caches) {
    tasks.push(
      caches.keys().then(function (keys) {
        return Promise.all(keys.map(function (k) { return caches.delete(k); }));
      }).catch(function () {})
    );
  }

  Promise.all(tasks).then(function () {
    try { localStorage.setItem(VERSION_KEY, PALINK_CACHE_VERSION); } catch (e) {}
    // 强制重新加载（使用 location.reload(true) 在某些浏览器中可绕过缓存）
    window.location.reload();
  }).catch(function () {
    try { localStorage.setItem(VERSION_KEY, PALINK_CACHE_VERSION); } catch (e) {}
    window.location.reload();
  });
})();

function updateVh() {
  const vh = window.innerHeight * 0.01;
  document.documentElement.style.setProperty('--vh', vh + 'px');
}
window.addEventListener('resize', updateVh);
updateVh();
