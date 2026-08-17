(function () {
  try {
    var theme = localStorage.getItem('palink-silly-tavern-theme') || 'palink';
    document.documentElement.setAttribute('data-palink-tavern-theme', theme);

    // 加载 Smart Card 脚本（拦截 fetch 响应提取 <script>，在消息插入后执行）
    // 关键：必须用同步 XHR 加载并 eval，确保在 ST 的 <script type="module"> 之前
    // 安装 fetch/XHR 拦截器。
    // - createElement('script', async=false) 会因网络请求延迟而落后于 ST 已预加载的 module script
    // - document.write 会破坏 ST 的 DOM 解析（ST UI 不渲染）
    // - 同步 XHR 在 head 解析时执行（loader.js 是同步 classic script），阻塞解析直到加载完成
    //   虽然同步 XHR 已被废弃，但在本场景（沙箱 sidecar、可信源、单个小文件）下是可接受的
    try {
      var xhr = new XMLHttpRequest();
      xhr.open('GET', '/palink-smart-card.js?v=11', false);
      xhr.send();
      if (xhr.status === 200 && xhr.responseText) {
        var inlineScript = document.createElement('script');
        inlineScript.textContent = xhr.responseText;
        document.head.appendChild(inlineScript);
      } else {
        console.warn('[Palink] Failed to load palink-smart-card.js: status=' + xhr.status);
      }
    } catch (e) {
      console.warn('[Palink] Failed to load palink-smart-card.js:', e);
    }

    if (theme !== 'palink') return;

    var existing = document.getElementById('palink-silly-tavern-theme');
    if (!existing) {
      var link = document.createElement('link');
      link.id = 'palink-silly-tavern-theme';
      link.rel = 'stylesheet';
      link.href = '/palink-silly-tavern-theme.css?v=dark-20260616';
      document.head.appendChild(link);
    }

    var badge = document.createElement('a');
    badge.className = 'palink-tavern-return';
    badge.href = '/characters';
    badge.textContent = 'Palink';
    badge.title = '返回 Palink';
    document.addEventListener('DOMContentLoaded', function () {
      if (!document.querySelector('.palink-tavern-return')) {
        document.body.appendChild(badge);
      }
    });
  } catch (error) {
    console.warn('[Palink] Failed to load SillyTavern theme bridge:', error);
  }
})();
