import fs from 'fs';
const b = fs.readFileSync('frontend/dist/assets/index-DXzJGwJC.js', 'utf8');
const idx = b.indexOf('SMART_CARD_ORIGIN =');
if (idx < 0) { console.log('未找到 SMART_CARD_ORIGIN'); process.exit(0); }
// 向前找模板起点（未转义反引号）
let s = idx;
while (s > 0) {
  s--;
  if (b[s] === '`') {
    if (s === 0 || b[s - 1] !== '\\') { break; }
  }
}
const templateStart = s + 1;
console.log('模板起点bundle索引:', templateStart, ' SMART_CARD_ORIGIN 在模板内偏移', idx - templateStart);
const seg = b.slice(templateStart, templateStart + 200000);
const dec = seg
  .replace(/\\r/g, '\r')
  .replace(/\\n/g, '\n')
  .replace(/\\t/g, '\t')
  .replace(/\\\\/g, '\\')
  .replace(/\\`/g, '`');
const lines = dec.split('\n');
console.log('解码后行数:', lines.length);
console.log('--- srcDoc 行 5650-5664 ---');
for (let k = 5649; k < 5664 && k < lines.length; k++) { console.log((k + 1) + ': ' + lines[k].slice(0, 200)); }
console.log('--- srcDoc 行 7785-7800 ---');
for (let k = 7784; k < 7800 && k < lines.length; k++) { console.log((k + 1) + ': ' + lines[k].slice(0, 200)); }
