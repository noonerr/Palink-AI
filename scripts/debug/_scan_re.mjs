import fs from 'fs';
const src = fs.readFileSync('frontend/src/components/ui/custom/smart-card-runtime/SillyTavernCompatRuntime.ts', 'utf8');
// 候选正则字面量（粗略：以 / 开头非 // 或 /* ，到 /flags 结束）
const reGlobal = /\/(?![/*])(?:\\.|[^/\\\n\r])+\/[a-z]*/g;
let m;
const bad = [];
while ((m = reGlobal.exec(src))) {
  const lit = m[0];
  const lastSlash = lit.lastIndexOf('/');
  const flags = lit.slice(lastSlash + 1);
  const valid = /^[dgimsuvy]*$/.test(flags) && new Set(flags).size === flags.length;
  if (!valid) {
    const line = src.slice(0, m.index).split('\n').length;
    bad.push({ line, lit: lit.slice(0, 90), flags });
  }
}
console.log('疑似非法 flag 正则数:', bad.length);
bad.slice(0, 40).forEach(f => console.log('L' + f.line + ': flags=[' + f.flags + '] ' + f.lit));
if (bad.length === 0) console.log('（字面量扫描未发现非法 flag）');
