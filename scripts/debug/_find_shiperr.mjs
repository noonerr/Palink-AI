import fs from 'fs';
import vm from 'vm';
const dir = 'frontend/dist/assets';
const candidates = fs.readdirSync(dir).filter((f) => /^index-.*\.js$/.test(f))
  .map((f) => ({ f, m: fs.statSync(dir + '/' + f).mtimeMs }))
  .sort((a, b) => b.m - a.m);
const bundlePath = dir + '/' + candidates[0].f;
console.log('使用 bundle:', bundlePath);
const b = fs.readFileSync(bundlePath, 'utf8');

// 找 compatV2Shim 模板起点：第一个 '(() => {' 之前最近的未转义反引号
const marker = '(() => {';
const firstIdx = b.indexOf(marker);
if (firstIdx < 0) { console.log('未找到 shim 标记'); process.exit(0); }
let s = firstIdx;
while (s > 0) { s--; if (b[s] === '`') { if (s === 0 || b[s - 1] !== '\\') break; } }
const start = s + 1;
console.log('模板起点索引:', start, ' 标记前字符:', JSON.stringify(b.slice(firstIdx - 20, firstIdx)));

// 向后找匹配的结束反引号：维护转义与 ${...} 深度，只在 depth==0 且未转义时遇到的反引号才是结束
let end = -1;
let escaped = false;
let exprDepth = 0;
for (let i = start; i < b.length; i++) {
  const c = b[i];
  if (escaped) { escaped = false; continue; }
  if (c === '\\') { escaped = true; continue; }
  if (c === '`') {
    if (exprDepth === 0) { end = i; break; }
  } else if (c === '$' && b[i + 1] === '{') {
    exprDepth += 1;
  } else if (c === '}' && exprDepth > 0) {
    // 粗略：} 可能关闭 ${...}
    exprDepth -= 1;
  }
}
console.log('模板结束索引:', end, ' 长度:', end - start);
let raw = b.slice(start, end);
// 跳过开头的 <script ...> 标签，从 (() => { 开始
const jsStart = raw.indexOf('(() => {');
if (jsStart > 0) raw = raw.slice(jsStart);
// 截到 shim 立即执行函数结束 }();
const lastIife = raw.lastIndexOf('})();');
if (lastIife > 0) raw = raw.slice(0, lastIife + 5);
// 把 ${...} 插值占位符替换为 0（不影响静态正则字面量检测）
raw = raw.replace(/\$\{(?:[^{}]|\{[^}]*\})*\}/g, '0');
// 用 JS 引擎自身的反引号字符串解析还原转义（正确处理 \n 与字符串内 \n 的歧义）
let code;
try {
  code = eval('`' + raw + '`');
} catch (ev) {
  console.log('eval 还原失败:', ev.message);
  process.exit(0);
}
console.log('解码后 shim JS 行数:', code.split('\n').length);

try {
  new vm.Script(code, { filename: 'compatV2Shim.js' });
  console.log('shim 语法 OK（未复现错误）');
} catch (e) {
  console.log('shim 语法错误:', e.message);
  const m = String(e.stack || '').match(/compatV2Shim\.js:(\d+)/);
  if (m) {
    const ln = Number(m[1]);
    const lines = code.split('\n');
    console.log('错误行号(相对shim):', ln);
    for (let k = Math.max(0, ln - 6); k < Math.min(lines.length, ln + 6); k++) {
      console.log((k + 1) + (k + 1 === ln ? ' >>> ' : ': ') + lines[k].slice(0, 240));
    }
  }
}
