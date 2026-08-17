// Palink 轻插件范本 —— 入口脚本
//
// 演示 Palink 原生 UI 沙箱（sandbox.ts）提供的 ST 兼容能力：
//   1. 多文件模块加载：import 本插件自带的 ./core/constants.js（双源解析）
//   2. extension_settings 全局共享命名空间读写（ST 1.18.0 契约）
//   3. 通过 jQuery 把设置面板注入真实 #extensions_settings 挂载点
//      （注意：沙箱里 document 被代理到插件私有 container，但注入的 jQuery
//       是真实 jQuery，查真实页面 DOM，所以必须用 $('#extensions_settings')
//       而非 document.getElementById，设置面板才会落到真实挂载点）
//   4. 防重复注入 + 事件绑定 + 持久化（saveSettingsDebounced）

import { EXT_ID, VERSION } from './core/constants.js';

// 1) extension_settings 全局共享 store（沙箱已按 ST 契约做成共享 Proxy）
const ns = typeof extension_settings !== 'undefined' ? extension_settings : {};
ns[EXT_ID] = ns[EXT_ID] || { enabled: true, label: '样例' };
const settings = ns[EXT_ID];

// 2) 注入设置面板到真实 #extensions_settings（用 jQuery，走真实 document）
function injectSettingsPanel() {
  const $host = $('#extensions_settings');
  if (!$host || $host.length === 0) return;
  if ($('#' + EXT_ID + '_container').length > 0) return; // 防重复注入

  const html =
    '<div id="' + EXT_ID + '_container" class="extension_container">' +
    '  <h3>' + EXT_ID + ' 设置 (v' + VERSION + ')</h3>' +
    '  <label>' +
    '    <input type="checkbox" id="' + EXT_ID + '_enabled" ' +
    (settings.enabled ? 'checked' : '') + ' /> 启用本插件' +
    '  </label>' +
    '</div>';

  $host.append(html);

  // 3) 事件绑定 + 持久化
  $('#' + EXT_ID + '_enabled').on('change', function (e) {
    settings.enabled = e.target.checked;
    if (typeof saveSettingsDebounced === 'function') saveSettingsDebounced();
  });
}

function ready() {
  injectSettingsPanel();
}

// 等待挂载点就绪（StPluginMountPoints 派发 palink:st_mount_points_ready）
if (typeof document !== 'undefined' && document.readyState !== 'loading') {
  ready();
} else if (typeof window !== 'undefined') {
  window.addEventListener('palink:st_mount_points_ready', ready);
}
