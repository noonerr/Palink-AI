/**
 * 生成 ST 1.18.0 权威 `SillyTavern.libs` 键清单 fixture（包G G-2 契约测试的数据源）。
 *
 * 为什么要有生成器而不是手抄：libs 的权威面必须**从 ST 源码数出来**。
 * 上一轮就栽过一次 —— 旧报告把 libs 写成 ~17 项，实际 lib.js:84-110 数出来是 25 项。
 * 手抄会漂，生成器不会。
 *
 * 用法（cwd = frontend/）：
 *   node scripts/gen-st-libs-fixture.cjs            # 写 fixture
 *   node scripts/gen-st-libs-fixture.cjs --check    # 只校验 fixture 与源码是否一致
 *
 * 数据源：../_reference/sillytavern-1.18.0/public/lib.js 的 default export 块（84-110 行）。
 * 三个易错点（生成器已按源码逐键处理，改源码结构时注意别退回旧口径）：
 *   · `css` 是 @adobe/css-tools（lib.js:11），**不是 emotion**；
 *   · `gzipSync` 与 `gzip` 同出 fflate（lib.js:26）⇒ 是两个键、一个模块；
 *   · `Readability` 与 `isProbablyReaderable` 同出 @mozilla/readability（lib.js:14）⇒ 同上。
 */
const fs = require('node:fs');
const path = require('node:path');

const ST_LIB_JS = path.resolve(__dirname, '../../_reference/sillytavern-1.18.0/public/lib.js');
const FIXTURE = path.resolve(
  __dirname,
  '../src/components/ui/custom/smart-card-runtime/__tests__/fixtures/st-libs-25.json',
);

function extractDefaultExportKeys(source) {
  const lines = String(source).split(/\r?\n/);
  const start = lines.findIndex((line) => /export\s+default\s*\{/.test(line));
  if (start < 0) throw new Error(`找不到 export default { 块：${ST_LIB_JS}`);
  const keys = [];
  for (let i = start + 1; i < lines.length; i += 1) {
    const line = lines[i].trim();
    if (line === '};' || line === '}') break;
    if (!line || line.startsWith('/**') || line.startsWith('*') || line.startsWith('//')) continue;
    const key = line.replace(/,+$/, '').split(':')[0].trim();
    if (!/^[A-Za-z_$][\w$]*$/.test(key)) throw new Error(`第 ${i + 1} 行解析不出键名：${line}`);
    keys.push(key);
  }
  return keys;
}

function main() {
  const check = process.argv.includes('--check');
  const keys = extractDefaultExportKeys(fs.readFileSync(ST_LIB_JS, 'utf8'));

  if (!fs.existsSync(FIXTURE)) {
    if (check) {
      console.log(`MISSING fixture (${keys.length} keys expected): ${path.relative(process.cwd(), FIXTURE)}`);
      process.exitCode = 1;
      return;
    }
  }

  let previous = null;
  if (fs.existsSync(FIXTURE)) {
    previous = JSON.parse(fs.readFileSync(FIXTURE, 'utf8'));
  }

  const next = {
    libs: keys,
    count: keys.length,
    _source: previous?._source
      || 'ST 1.18.0 权威 libs 面：_reference/sillytavern-1.18.0/public/lib.js:84-110 的 default export。',
    _generatedBy: previous?._generatedBy || 'node scripts/gen-st-libs-fixture.cjs',
    _generatedAt: previous?._generatedAt || new Date().toISOString().slice(0, 10),
    _consumedBy: previous?._consumedBy
      || 'src/components/ui/custom/smart-card-runtime/__tests__/g-getcontext-and-libs-contract.test.ts',
  };

  if (check) {
    const same = previous && JSON.stringify(previous.libs) === JSON.stringify(keys);
    console.log(`${same ? 'OK' : 'STALE'} ${keys.length} libs, fixture ${same ? 'up to date' : 'out of date'}`);
    if (!same) process.exitCode = 1;
    return;
  }

  fs.writeFileSync(FIXTURE, `${JSON.stringify(next, null, 2)}\n`);
  console.log(`WROTE ${path.relative(process.cwd(), FIXTURE)} (${keys.length} libs)`);
}

main();
