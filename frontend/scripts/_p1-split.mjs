/**
 * P1-a: 机械拆分 CharacterCardRenderer.tsx
 *   shared.ts   <- L16-219   (常量 / 类型 / 单例状态)
 *   helpers.ts  <- L221-2405 (全部纯函数，连续块，不会撕断函数)
 *   组件文件     <- L2406-3771 (原样保留)
 * 外部仍从 CharacterCardRenderer 导入的名字由组件文件 re-export。
 *
 * 纯机械移动：每段内的引用关系保持不变，所以逻辑零改动。
 */
import fs from 'node:fs';
import path from 'node:path';

const ROOT = process.cwd();
const SRC = 'src/components/ui/custom/CharacterCardRenderer.tsx';
const full = path.resolve(ROOT, SRC);
const lines = fs.readFileSync(full, 'utf8').split('\n');
const n = lines.length;
console.log(`源文件: ${n} 行`);

// 行范围 (1-based, inclusive)
const IMPORT_END = 15;          // L1-15 为 import 块
const SHARED = [16, 219];       // 常量/类型/单例
const HELPERS = [221, 2405];    // 纯函数
const COMP = [2406, n];         // 组件

const slice = (a, b) => lines.slice(a - 1, b);

function stripComments(s) {
  return s.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/\/\/[^\n]*/g, ' ');
}
function tokensOf(arr) {
  const set = new Set();
  const re = /[A-Za-z_$][\w$]*/g;
  for (const ln of arr) {
    const s = stripComments(ln);
    let m;
    while ((m = re.exec(s)) !== null) set.add(m[0]);
  }
  return set;
}

// ---- 解析 import 块 ----
const importStmts = [];
{
  for (let i = 0; i < IMPORT_END; i++) {
    const ln = lines[i];
    let m;
    if ((m = /^import\s+type\s+\{([^}]*)\}\s*from\s*['"]([^'"]+)['"];?\s*$/.exec(ln))) {
      importStmts.push({ isType: true, source: m[2], def: null, specs: m[1].split(',').map(s => s.trim()).filter(Boolean) });
    } else if ((m = /^import\s+([A-Za-z_$][\w$]*)\s*,\s*\{([^}]*)\}\s*from\s*['"]([^'"]+)['"];?\s*$/.exec(ln))) {
      importStmts.push({ isType: false, source: m[3], def: m[1], specs: m[2].split(',').map(s => s.trim()).filter(Boolean) });
    } else if ((m = /^import\s+\{([^}]*)\}\s*from\s*['"]([^'"]+)['"];?\s*$/.exec(ln))) {
      importStmts.push({ isType: false, source: m[2], def: null, specs: m[1].split(',').map(s => s.trim()).filter(Boolean) });
    } else if ((m = /^import\s+([A-Za-z_$][\w$]*)\s+from\s*['"]([^'"]+)['"];?\s*$/.exec(ln))) {
      importStmts.push({ isType: false, source: m[2], def: m[1], specs: [] });
    } else if ((m = /^import\s+['"]([^'"]+)['"];?\s*$/.exec(ln))) {
      importStmts.push({ isType: false, source: m[1], def: null, specs: [], sideEffect: true });
    }
  }
}
// 收集所有导入名 -> {source,isType}
const importedNames = new Map();
for (const st of importStmts) {
  if (st.def) importedNames.set(st.def, { source: st.source, isType: st.isType });
  for (const sp of st.specs) {
    const local = sp.split(/\s+as\s+/).pop().trim();
    importedNames.set(local, { source: st.source, isType: st.isType });
  }
}

// ---- 顶层声明 ----
const declRe = /^(?:export\s+)?(?:async\s+)?(function|const|let|class|interface|type|enum)\s+([A-Za-z_$][\w$]*)/;
const decls = [];
for (let i = 0; i < n; i++) {
  const m = declRe.exec(lines[i]);
  if (m) decls.push({
    kind: m[1], name: m[2], line: i + 1,
    isExport: lines[i].trimStart().startsWith('export'),
  });
}
const sharedNames = new Set(decls.filter(d => d.line >= SHARED[0] && d.line <= SHARED[1]).map(d => d.name));
const helpersNames = new Set(decls.filter(d => d.line >= HELPERS[0] && d.line <= HELPERS[1]).map(d => d.name));
const compNames = new Set(decls.filter(d => d.line >= COMP[0] && d.line <= COMP[1]).map(d => d.name));
const kindOf = new Map(decls.map(d => [d.name, d.kind]));
const isTypeKind = (nm) => { const k = kindOf.get(nm); return k === 'interface' || k === 'type'; };

const tokShared = tokensOf(slice(...SHARED));
const tokHelpers = tokensOf(slice(...HELPERS));
const tokComp = tokensOf(slice(...COMP));

function intersect(set, names) { const r = []; for (const x of names) if (set.has(x)) r.push(x); return r; }

// helpers 用到的外部 / shared 名
const hExt = intersect(tokHelpers, [...importedNames.keys()]);
const hShared = intersect(tokHelpers, [...sharedNames]);
// shared 用到的外部名
const sExt = intersect(tokShared, [...importedNames.keys()]);
// component 用到的外部 / shared / helpers 名
const cExt = intersect(tokComp, [...importedNames.keys()]);
const cShared = intersect(tokComp, [...sharedNames]);
const cHelpers = intersect(tokComp, [...helpersNames]);

// 安全检查：helpers/shared 不得反向引用 component
const hCompRef = intersect(tokHelpers, [...compNames]);
const sCompRef = intersect(tokShared, [...compNames]);
if (hCompRef.length || sCompRef.length) {
  console.error('❌ 纯函数块反向引用了组件函数，停止:', hCompRef, sCompRef);
  process.exit(2);
}

// ---- 路径重写：相对 import 重新相对于目标文件定位 ----
function rewriteSource(src, targetFile) {
  if (!src.startsWith('.')) return src; // 别名或裸包
  const abs = path.resolve(path.dirname(full), src);
  let rel = path.relative(path.dirname(targetFile), abs).replace(/\\/g, '/');
  if (!rel.startsWith('.')) rel = './' + rel;
  return rel.replace(/\.(tsx?|jsx?|mjs|cjs)$/, '');
}

function serializeImports(stmts, usedSet, targetFile) {
  const out = [];
  for (const st of stmts) {
    const keepSpecs = st.specs.filter(sp => { const local = sp.split(/\s+as\s+/).pop().trim(); return usedSet.has(local); });
    const keepDef = (st.def && usedSet.has(st.def)) ? st.def : null;
    if (st.sideEffect) { out.push(`import '${st.source}';`); continue; }
    if (!keepSpecs.length && !keepDef) continue;
    const src = rewriteSource(st.source, targetFile);
    if (st.isType) {
      out.push(`import type { ${keepSpecs.join(', ')} } from '${src}';`);
    } else if (keepDef && keepSpecs.length) {
      out.push(`import ${keepDef}, { ${keepSpecs.join(', ')} } from '${src}';`);
    } else if (keepDef) {
      out.push(`import ${keepDef} from '${src}';`);
    } else {
      out.push(`import { ${keepSpecs.join(', ')} } from '${src}';`);
    }
  }
  return out;
}

function splitTypeValue(names) {
  const vals = [], types = [];
  for (const nm of names) (isTypeKind(nm) ? types : vals).push(nm);
  return { vals, types };
}
function blockImport(usedNames, modulePath) {
  const { vals, types } = splitTypeValue(usedNames);
  const out = [];
  if (vals.length) out.push(`import { ${vals.join(', ')} } from '${modulePath}';`);
  if (types.length) out.push(`import type { ${types.join(', ')} } from '${modulePath}';`);
  return out;
}

const HEADER = `// AUTO-GENERATED by scripts/_p1-split.mjs (P1 机械拆分，逻辑未改动)
// 源: src/components/ui/custom/CharacterCardRenderer.tsx
`;

const OUT_DIR = path.resolve(ROOT, 'src/components/ui/custom/smart-card-runtime');
fs.mkdirSync(OUT_DIR, { recursive: true });

// ---- shared.ts ----
{
  const imp = serializeImports(importStmts, new Set(sExt), path.join(OUT_DIR, 'shared.ts'));
  const body = slice(...SHARED).map(ln => {
    const m = declRe.exec(ln);
    if (m && !ln.trimStart().startsWith('export')) return 'export ' + ln;
    return ln;
  });
  fs.writeFileSync(path.join(OUT_DIR, 'shared.ts'), HEADER + imp.join('\n') + (imp.length ? '\n\n' : '') + body.join('\n') + '\n');
  console.log(`shared.ts: ${SHARED[1] - SHARED[0] + 1} 行, 外部导入 ${imp.length}`);
}

// ---- helpers.ts ----
{
  const imp = serializeImports(importStmts, new Set(hExt), path.join(OUT_DIR, 'helpers.ts'));
  const sharedImp = blockImport(hShared, './shared');
  const body = slice(...HELPERS).map(ln => {
    const m = declRe.exec(ln);
    if (m && !ln.trimStart().startsWith('export')) return 'export ' + ln;
    return ln;
  });
  fs.writeFileSync(path.join(OUT_DIR, 'helpers.ts'), HEADER + imp.join('\n') + (imp.length ? '\n' : '') + sharedImp.join('\n') + (sharedImp.length ? '\n\n' : '\n') + body.join('\n') + '\n');
  console.log(`helpers.ts: ${HELPERS[1] - HELPERS[0] + 1} 行, 外部导入 ${imp.length}, shared 导入 ${sharedImp.length}`);
}

// ---- 组件文件 (重写 CharacterCardRenderer.tsx) ----
{
  const imp = serializeImports(importStmts, new Set(cExt), full);
  const sharedImp = blockImport(cShared, './smart-card-runtime/shared');
  const helpersImp = blockImport(cHelpers, './smart-card-runtime/helpers');

  // 原先导出的、现已移走的名字 -> re-export
  const reExportHelpers = decls.filter(d => d.isExport && d.line >= HELPERS[0] && d.line <= HELPERS[1]).map(d => d.name);
  const reExportShared = decls.filter(d => d.isExport && d.line >= SHARED[0] && d.line <= SHARED[1]).map(d => d.name);
  const reExp = [];
  if (reExportHelpers.length) reExp.push(`export { ${reExportHelpers.join(', ')} } from './smart-card-runtime/helpers';`);
  const sv = splitTypeValue(reExportShared);
  if (sv.vals.length) reExp.push(`export { ${sv.vals.join(', ')} } from './smart-card-runtime/shared';`);
  if (sv.types.length) reExp.push(`export type { ${sv.types.join(', ')} } from './smart-card-runtime/shared';`);

  const body = slice(...COMP);
  const out = [HEADER + imp.join('\n')];
  if (imp.length) out.push('');
  out.push(sharedImp.join('\n'));
  if (sharedImp.length) out.push('');
  out.push(helpersImp.join('\n'));
  if (helpersImp.length) out.push('');
  out.push(reExp.join('\n'));
  if (reExp.length) out.push('');
  out.push(body.join('\n'));
  fs.writeFileSync(full, out.join('\n').replace(/\n{3,}/g, '\n\n') + '\n');
  console.log(`组件: ${COMP[1] - COMP[0] + 1} 行, 外部导入 ${imp.length}, shared 导入 ${sharedImp.length}, helpers 导入 ${helpersImp.length}, re-export ${reExp.length}`);
  console.log('  re-export helpers:', reExportHelpers);
  console.log('  re-export shared :', reExportShared);
}

console.log('\n✅ P1-a 拆分完成');
