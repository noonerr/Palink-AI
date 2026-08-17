import fs from 'fs';
const file = 'src/components/ui/custom/smart-card-runtime/helpers.ts';
const src = fs.readFileSync(file, 'utf8');
const lines = src.split('\n');

// 1) top-level function declarations (col 0): gather name + body range
const declRe = /^(?:export\s+)?(?:async\s+)?function\s+([A-Za-z_$][\w$]*)\s*\(/;
const arrowRe = /^(?:export\s+)?const\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s*)?\([^)]*\)\s*=>/;
const decls = [];
for (let i = 0; i < lines.length; i++) {
  let m = declRe.exec(lines[i]);
  if (m) { decls.push({ name: m[1], start: i + 1, kind: 'fn' }); continue; }
  m = arrowRe.exec(lines[i]);
  if (m) { decls.push({ name: m[1], start: i + 1, kind: 'arrow' }); }
}
decls.sort((a, b) => a.start - b.start);
for (let i = 0; i < decls.length; i++) {
  decls[i].end = (i + 1 < decls.length ? decls[i + 1].start - 1 : lines.length);
}
const names = new Set(decls.map(d => d.name));

// 2) for each decl, find calls to other declared top-level names within its body
function callsWithin(d) {
  const seg = lines.slice(d.start - 1, d.end).join('\n');
  const called = new Set();
  for (const n of names) {
    if (n === d.name) continue;
    const re = new RegExp('\\b' + n + '\\s*\\(', 'g');
    if (re.test(seg)) called.add(n);
  }
  return [...called];
}
const edges = {}; // name -> [callees]
for (const d of decls) edges[d.name] = callsWithin(d);

const all = decls.map(d => d.name);
const isLeaf = (n) => edges[n].length === 0;
const isCalled = (n) => all.some((m) => m !== n && edges[m].includes(n));
const leaves = all.filter(isLeaf);
const roots = all.filter((n) => !isCalled(n));
const hubs = all.filter((n) => !isLeaf(n) && isCalled(n));

console.log('\n=== 顶层函数总数: ' + all.length + ' ===');
console.log('\n--- 叶子函数 (内部零回调, 可安全抽成独立模块): ' + leaves.length + ' ---');
console.log(leaves.join(', '));
console.log('\n--- 入口型 (无人内部调用它): ' + roots.length + ' ---');
console.log(roots.join(', '));
console.log('\n--- 枢纽 (既被调用又调用别人): ' + hubs.length + ' ---');
for (const h of hubs) console.log('  ' + h + ' -> ' + edges[h].join(', '));

console.log('\n=== 非叶子函数间的调用关系（排查环）===');
const nonLeaf = all.filter((n) => !isLeaf(n));
for (const n of nonLeaf) {
  const internal = edges[n].filter((c) => names.has(c));
  console.log('  ' + n + ' -> [' + internal.join(', ') + ']');
}
