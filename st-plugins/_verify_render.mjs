// 端到端验证：复刻 sandbox.ts 中 P0-1 修复后的完整 renderExtensionTemplateAsync
// （含 normalizeTemplateName + 按名匹配 pluginTemplates），用 backend 抽取后真实的
// 模板路径（根目录 settings.html / scriptTemplate.html 等）喂入，逐一验证每个扩展实际
// 调用的 renderExtensionTemplateAsync(MODULE, NAME) 都能解析到非空 HTML。
import fs from 'fs';
import path from 'path';

const ST_PLUGINS = 'D:/项目/Palink-AI/st-plugins';

// ---- 与 sandbox.ts 完全一致的辅助函数 ----
function escapeHtmlForTemplate(value) {
  return String(value ?? '').replace(/[&<>"']/g, (char) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char] || char
  ));
}
function getByPathForTemplate(source, p, fallback = '') {
  const parts = String(p || '').split('.').map((x) => x.trim()).filter(Boolean);
  let value = source;
  for (const part of parts) {
    if (value == null || typeof value !== 'object') return fallback;
    value = value[part];
  }
  return value == null ? fallback : value;
}
function compileSimpleTemplateForSandbox(template, data = {}) {
  const payload = data && typeof data === 'object' ? data : {};
  return String(template || '')
    .replace(/\{\{\{\s*([\w.$-]+)\s*\}\}\}/g, (_m, key) => String(getByPathForTemplate(payload, key, '')))
    .replace(/\{\{\s*([\w.$-]+)\s*\}\}/g, (_m, key) => escapeHtmlForTemplate(getByPathForTemplate(payload, key, '')));
}
function normalizeTemplateName(name) {
  return String(name || '').replace(/\\/g, '/').replace(/^\/+/, '').replace(/\.(html?|hbs|handlebars|mustache)$/i, '').toLowerCase();
}
// 复刻 P0-1 修复后的 renderExtensionTemplateAsync
function renderExtensionTemplateAsync(templates, extensionName, templateName, data) {
  const wanted = normalizeTemplateName(String(templateName || extensionName || 'template'));
  const found = Array.isArray(templates)
    ? templates.find((t) => {
        if (!t || t.missing || typeof t.content !== 'string') return false;
        const p = normalizeTemplateName(String(t.path || ''));
        return p === wanted || p.endsWith('/' + wanted) || p.endsWith('/templates/' + wanted) || p.endsWith('/template/' + wanted);
      })
    : undefined;
  return found?.content ? compileSimpleTemplateForSandbox(found.content, data || {}) : '';
}

// ---- 各扩展 init() 实际发出的 renderExtensionTemplateAsync(MODULE, NAME) 调用 ----
const CALLS = {
  caption: [['caption', 'settings']],
  vectors: [['vectors', 'settings']],
  tts: [['tts', 'settings']],
  memory: [['memory', 'settings']],
  'stable-diffusion': [['stable-diffusion', 'button'], ['stable-diffusion', 'dropdown'], ['stable-diffusion', 'settings']],
  expressions: [['expressions', 'list-item'], ['expressions', 'add-custom-expression'], ['expressions', 'remove-custom-expression'], ['expressions', 'templates/upload-expression'], ['expressions', 'settings']],
  regex: [['regex', 'scriptTemplate'], ['regex', 'editor'], ['regex', 'debugger'], ['regex', 'embeddedScripts'], ['regex', 'presetEmbeddedScripts'], ['regex', 'dropdown'], ['regex', 'importTarget']],
  'connection-manager': [['connection-manager', 'profile'], ['connection-manager', 'view'], ['connection-manager', 'settings'], ['connection-manager', 'edit']],
  translate: [['translate', 'deleteConfirmation'], ['translate', 'index'], ['translate', 'buttons']],
  'token-counter': [['token-counter', 'window']],
  assets: [['assets', 'installation'], ['assets', 'market'], ['assets', 'character'], ['assets', 'window']],
  attachments: [['attachments', 'manage-button'], ['attachments', 'attach-button']],
};

// quick-reply 不走 renderExtensionTemplateAsync，改用 manager.render() 注入 #qr_container（DOM 挂载，已有挂载点）
const DOM_ONLY = ['quick-reply'];

let pass = 0, fail = 0;
const fails = [];
for (const [ext, calls] of Object.entries(CALLS)) {
  // 收集该扩展下所有真实 .html，模拟 backend 抽取后的 pluginTemplates（根目录路径）
  const extDir = path.join(ST_PLUGINS, ext);
  if (!fs.existsSync(extDir)) { console.log(`⚠️  跳过 ${ext}（目录缺失）`); continue; }
  const templates = [];
  const walk = (dir) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) { walk(full); continue; }
      if (/\.html?$/i.test(e.name)) templates.push({ path: path.relative(ST_PLUGINS, full).replace(/\\/g, '/'), content: fs.readFileSync(full, 'utf-8') });
    }
  };
  walk(extDir);
  for (const [mod, name] of calls) {
    const out = renderExtensionTemplateAsync(templates, mod, name, {});
    const okHtml = /<(div|section|input|button|label|select|span|table|textarea)/i.test(out);
    if (out && okHtml) { pass++; }
    else { fail++; fails.push(`${ext} <- ${mod}/${name} (${out.length}B, html=${okHtml})`); }
    console.log(`${ext.padEnd(16)} ${String(name).padEnd(20)} -> ${String(out.length).padStart(6)}B  ${out && okHtml ? '✅' : '❌'}`);
  }
}
console.log(`\n模板渲染验证: ${pass} 通过, ${fail} 失败`);
for (const f of fails) console.log('  失败: ' + f);
console.log(`DOM 挂载型(不走模板渲染): ${DOM_ONLY.join(', ')} — 依赖 #qr_container 挂载点(已存在)`);
process.exit(fail ? 1 : 0);
