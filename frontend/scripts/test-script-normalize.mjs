/**
 * escapeQuotedScriptNewlines 回归测试
 *
 * 背景：卡片 HTML 里的内联 <script> 常含"引号字符串内部有裸换行"的写法，
 * 这在 JS 里非法。该函数把这类换行转义为 \n，同时必须保持
 * 模板字符串 / 注释 / 正则字面量 内部原样不动。
 *
 * 判据只有一条且不可能误报：**输出必须能被 JS 解析器解析**，
 * 且模板字符串里的真实换行必须保留（转义了会改变运行时字符串内容）。
 *
 * 用法：node scripts/test-script-normalize.mjs
 * 退出码 0 = 全通过，1 = 有失败。
 */
import fs from 'node:fs';
import vm from 'node:vm';

const TSX = 'src/components/ui/custom/smart-card-runtime/primitives.ts';

function loadFn() {
  const src = fs.readFileSync(TSX, 'utf8');
  // 从依赖的模块级常量开始抠，否则函数体内引用会 ReferenceError
  const constStart = src.indexOf('const REGEX_PRECEDING_KEYWORDS');
  const fnStart = src.indexOf('function escapeQuotedScriptNewlines(');
  const start = constStart >= 0 && constStart < fnStart ? constStart : fnStart;
  // 结束点 = escapeQuotedScriptNewlines 之后的下一个顶层声明行的起始字符
  const linesArr = src.split('\n');
  const fnLine = src.slice(0, fnStart).split('\n').length - 1;
  let endLine = linesArr.length;
  for (let i = fnLine + 1; i < linesArr.length; i++) {
    if (/^(export\s+)?(function|const|let|class|interface|type|enum)\s+/.test(linesArr[i])) { endLine = i; break; }
  }
  let endChar = 0;
  for (let i = 0; i < endLine; i++) endChar += linesArr[i].length + 1;
  if (fnStart < 0 || endLine >= linesArr.length) throw new Error('未能在 primitives.ts 中定位 escapeQuotedScriptNewlines');
  const fnSrc = src
    .slice(start, endChar)
    .replace(/^export /gm, '')
    .replace('function escapeQuotedScriptNewlines(script: string): string {', 'function escapeQuotedScriptNewlines(script) {')
    .replace(/let quote: [^=]+=/, 'let quote =');
  const sandbox = {};
  vm.createContext(sandbox);
  vm.runInContext(`${fnSrc}\nglobalThis.__fn = escapeQuotedScriptNewlines;`, sandbox);
  return sandbox.__fn;
}

const parses = (code) => {
  try { new vm.Script(code); return true; } catch { return false; }
};

/**
 * @typedef {{name:string, input:string, keepTemplateNewline?:string}} Case
 * 每个用例的输入都是"卡片里可能出现的脚本片段"，输出必须可解析。
 */
const CASES = [
  // ---- 基础：引号字符串内裸换行 ----
  { name: '单引号内裸换行', input: "const s = 'line1\nline2';" },
  { name: '双引号内裸换行', input: 'const s = "line1\nline2";' },
  { name: 'CRLF 换行', input: "const s = 'line1\r\nline2';" },
  { name: '字符串内含已转义引号', input: "const s = 'it\\'s\nfine';" },

  // ---- 注释上下文 ----
  { name: '行注释含撇号', input: "// it's a comment\nconst s = 'p\nq';" },
  { name: '行注释含双引号', input: '// he said "hi"\nconst s = \'p\nq\';' },
  { name: '行注释含斜杠', input: "// see http://x.com/a/b\nconst s = 'p\nq';" },
  { name: '块注释含引号', input: '/* he said "hi" and it\'s ok */\nconst s = \'p\nq\';' },
  { name: '块注释含斜杠', input: "/* a / b / c */\nconst s = 'p\nq';" },

  // ---- 正则字面量（必须仍被识别为正则）----
  { name: '赋值后的正则', input: "const re = /ab+c/g;\nconst s = 'x\ny';" },
  { name: '正则含引号字符类', input: "const re = /['\"]/g;\nconst s = 'x\ny';" },
  { name: '正则含转义斜杠', input: "const re = /a\\/b/;\nconst s = 'x\ny';" },
  { name: 'return 后接正则', input: "function f(){ return /x/.test('a'); }\nconst s = 'p\nq';" },
  { name: '括号内正则', input: "'abc'.replace(/b/, 'B');\nconst s = 'p\nq';" },
  { name: 'typeof 后接正则', input: "const t = typeof /x/;\nconst s = 'p\nq';" },

  // ---- 除法运算符（不得误判为正则）★ 缺陷用例 ----
  { name: '★ 除法：两侧带空格 + 后接含换行字符串', input: "const r = w / h;\nconst s = 'line1\nline2';\nconst t = a / b;" },
  { name: '★ 除法：链式比例计算', input: "const ratio = width / height;\nconst pct = value / total;\nconst s = 'a\nb';" },
  { name: '★ 除法：括号闭合后除', input: "const v = (a + b) / 2;\nconst s = 'a\nb';\nconst w = (c + d) / 3;" },
  { name: '★ 除法：属性访问后除', input: "const v = obj.count / 100;\nconst s = 'a\nb';\nconst w = obj.total / 50;" },
  { name: '★ 除法：数组下标后除', input: "const v = arr[0] / 2;\nconst s = 'a\nb';\nconst w = arr[1] / 4;" },

  // ---- 模板字符串（换行必须保留）----
  { name: '模板字符串保留换行', input: 'const s = `line1\nline2`;', keepTemplateNewline: 'line1\nline2' },
  { name: '模板内插值含引号', input: 'const s = `v=${obj["k"]}\nnext`;', keepTemplateNewline: '\nnext' },
  { name: '模板内嵌套模板', input: 'const s = `a${`b\nc`}d`;', keepTemplateNewline: 'b\nc' },

  // ---- 真实卡片常见形态 ----
  {
    name: '卡片：DOM 查询 + 比例 + 多行提示串',
    input: [
      "const el = document.querySelector('.status-bar');",
      'const scale = el.clientWidth / 360;',
      "const tip = '第一行\n第二行';",
      'const pad = el.clientHeight / 2;',
      "el.setAttribute('title', tip);",
    ].join('\n'),
  },
  {
    name: '卡片：正则替换 + 除法混用',
    input: [
      "const clean = raw.replace(/\\s+/g, ' ');",
      'const half = clean.length / 2;',
      "const msg = 'ok\ndone';",
    ].join('\n'),
  },
];

const fn = loadFn();
let pass = 0;
const failures = [];

for (const c of CASES) {
  const out = fn(c.input);
  const ok = parses(out);
  let detail = '';
  let good = ok;
  if (!ok) {
    detail = '输出无法解析（iframe 内会抛 SyntaxError）';
  } else if (c.keepTemplateNewline && !out.includes(c.keepTemplateNewline)) {
    good = false;
    detail = '模板字符串内的换行被错误转义（会改变运行时字符串内容）';
  }
  if (good) { pass += 1; } else { failures.push({ ...c, out, detail }); }
}

console.log(`\n结果: ${pass}/${CASES.length} 通过`);
if (failures.length) {
  console.log(`\n失败用例 (${failures.length}):`);
  for (const f of failures) {
    console.log(`\n  ✗ ${f.name}`);
    console.log(`    原因: ${f.detail}`);
    console.log(`    输入: ${JSON.stringify(f.input)}`);
    console.log(`    输出: ${JSON.stringify(f.out)}`);
  }
  process.exitCode = 1;
} else {
  console.log('全部通过 ✅');
}
