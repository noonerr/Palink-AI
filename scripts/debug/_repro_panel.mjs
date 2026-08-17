import fs from 'fs';
import vm from 'vm';

const html = fs.readFileSync('tmp_statusbar.html', 'utf8');
const m = html.match(/<script type="module">([\s\S]*?)<\/script>/);
if (!m) { console.log('未找到 module 脚本'); process.exit(0); }
let panel = m[1];
console.log('原始面板脚本字节:', panel.length);

// 复刻 loosenSmartCardGlobalLexicalDeclarations
const names = ['State', 'GameState', 'CardState', 'CHARACTER_COLORS', 'WEATHER_ICONS'];
const nameRe = new RegExp(`\\b(?:const|let)\\s+(${names.join('|')})\\s*=`, 'g');
const classRe = new RegExp(`\\bclass\\s+(${names.join('|')})\\b`, 'g');
const loosened = panel
  .replace(nameRe, 'var $1 =')
  .replace(classRe, 'var $1 = class $1');

// 复刻 escapeQuotedScriptNewlines
function escapeQuotedScriptNewlines(script) {
  let result = '';
  let quote = null;
  let escaped = false;
  let templateExprDepth = 0;
  for (let i = 0; i < script.length; i += 1) {
    const char = script[i];
    const next = script[i + 1];
    if (quote && quote !== '`' && char === '\r') {
      if (next === '\n') i += 1;
      result += '\\n';
      escaped = false;
      continue;
    }
    if (quote && quote !== '`' && char === '\n') {
      result += '\\n';
      escaped = false;
      continue;
    }
    result += char;
    if (!quote) {
      if (char === '"' || char === "'" || char === '`') {
        quote = char;
        escaped = false;
      }
      continue;
    }
    if (quote === '`') {
      if (!escaped && char === '$' && next === '{') {
        templateExprDepth += 1;
      } else if (!escaped && templateExprDepth > 0 && char === '}') {
        templateExprDepth -= 1;
      } else if (!escaped && char === '`' && templateExprDepth === 0) {
        quote = null;
      }
      if (char === '\\') escaped = true; else escaped = false;
      continue;
    }
    if (escaped) { escaped = false; continue; }
    if (char === '\\') { escaped = true; continue; }
    if (char === quote) { quote = null; }
  }
  return result;
}

const processed = escapeQuotedScriptNewlines(loosened);
console.log('处理后字节:', processed.length);

// 原始语法检查
try { new vm.Script(panel); console.log('原始面板: 语法OK'); }
catch (e) { console.log('原始面板语法错误:', e.message); }

// 处理后语法检查
try {
  new vm.Script(processed);
  console.log('处理后面板: 语法OK');
} catch (e) {
  console.log('处理后面板语法错误:', e.message);
  const ln = e.stack ? (e.stack.match(/<anonymous>:(\d+)/) || [])[1] : null;
  if (ln) {
    const lines = processed.split('\n');
    const n = Number(ln);
    console.log('--- 错误附近行 ---');
    for (let k = Math.max(0, n - 4); k < Math.min(lines.length, n + 3); k++) {
      console.log((k + 1) + ': ' + lines[k].slice(0, 200));
    }
  }
}

// 列出面板里所有正则字面量
const reLiteral = /(?:^|[^$\w.])\/([^/\n\\]|\\.)*\/[a-z]*/g;
let mm; let count = 0;
console.log('--- 面板正则字面量 ---');
while ((mm = reLiteral.exec(panel))) {
  count += 1;
  if (count <= 40) console.log(count + ': ' + mm[0].slice(0, 120));
}
console.log('正则总数:', count);
