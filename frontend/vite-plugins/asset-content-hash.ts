// [K20 2026-09-30] Vite 插件：把「自身内容变了、但文件名 hash 没变」的产物改名，
// 使 nginx 的 `immutable, max-age=31536000` 长缓存前提（内容变 ⇒ 文件名变）真正成立。
//
// ── 问题 ────────────────────────────────────────────────────────────────
// Vite/Rollup 给纯 CSS 资源算的 `[name]-[hash]` 里的 hash 取**入口 chunk 的依赖图 hash**，
// 不含该 CSS 自身内容。于是只改 CSS（`src/index.css` / tailwind 输入 / 组件内 `<style>`）
// 时，产物**文件名不变**：实测 index.css 新增 37 行后仍产出 `index-DAHj4yWK.css`，
// 且与改动前的文件 SHA256 完全一致（161699 字节）。叠加 nginx 2026-09-21「性能优化 N1」
// 给 hash 资产打的年度 immutable 缓存 ⇒ **iOS 端 CSS 改动永远送不到**：
// 真机实证 iPhone 请求同名 CSS 被回 304、径直吃本地旧副本；桌面 Chrome 因刷新策略不同
// 侥幸拿到新版，从而把这个问题掩盖了一年（用户口径「修过一次又回来了」）。
//
// 为什么不用 `assetFileNames: 'assets/[name]-[hash:8][extname]'`：
// Vite 的 `[hash:8]` 走 `chunk.contentHash`，而纯 CSS chunk 的 `viteMetadata.importedCss`
// 为空 ⇒ hash 退化为空串 ⇒ 产物按原文件名互相覆盖、名字依旧不变（实测验证过这条错路）。
//
// ── 为什么用 writeBundle 而不是 generateBundle ─────────────────────────
// 实测在 `generateBundle`（含 enforce:'post'）改 bundle key 无效：Vite 内建的 CSS
// 处理插件随后会把 CSS 资产按原文件名重新写回，改名被覆盖。`writeBundle` 在所有文件
// 落盘后才跑，此时直接操作磁盘最可靠 —— 改名 + 全局替换引用（HTML/CSS/JS 文本）。
//
// ── 行为 ────────────────────────────────────────────────────────────────
// 对所有产物中**非 JS** 的 hash 资产（CSS / SVG / JSON / txt / xml）按自身内容算 sha256
// 取前 8 位：内容变 ⇒ 新名字（新 URL，天然绕开一切旧缓存）；内容不变 ⇒ 名字不变。
// 新名字形如 `name-<8位hex>.<ext>`，仍命中 nginx 的 `~* -[a-zA-Z0-9_-]+\.(js|css)$`
// immutable 规则，缓存策略不变。JS 产物一律跳过：其 hash 已由 Rollup 按内容负责，
// 手动改名会割裂 import() 与 modulepreload 的引用图。
import type { Plugin } from 'vite';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const HASH_LEN = 8;
// 参与改名的扩展名（浏览器长缓存资产主体；JS 见上文说明，排除）
const TARGET_EXTENSIONS = ['.css', '.svg', '.json', '.webmanifest', '.txt', '.xml', '.map'];
// ⛔ 只处理 Vite 生成的 hash 资产目录。绝不外扩到根级 /st/ /icons/ 等：
//   - `manifest.json` / `manifest-dark.json` 被 PWA 按**固定名**加载，改名即断链；
//   - `/st/css/*.css` 是 public/st 下手工维护的第三方资源，ST 插件按固定路径引用；
//   - `katex.min.css` 等由 index.html 写死路径引用，也无内容指纹契约。
//   这些的缓存策略由 nginx 各 location 单独给 max-age（见 nginx.conf N2 注释），
//   本来就不吃 `immutable` 那条规则，不需要、也不允许在这里改名。
const ASSET_DIR_PREFIX = 'assets/';
// 参考文献做引用的文本产物（build 产物里 index.html 与 CSS/JS 都可能引用被改名资产）
const TEXT_EXTENSIONS = ['.html', '.css', '.js', '.mjs', '.json', '.map', '.svg', '.txt', '.webmanifest', '.xml'];

/** 由「文件名 + 内容」算出内容级文件名；不算目标类型或内容未变时返回 null。 */
function contentNameFor(fileName: string, source: Buffer): string | null {
  if (!fileName.startsWith(ASSET_DIR_PREFIX)) return null;

  const slash = fileName.lastIndexOf('/');
  const dir = slash >= 0 ? fileName.slice(0, slash + 1) : '';
  const base = slash >= 0 ? fileName.slice(slash + 1) : fileName;

  const dot = base.lastIndexOf('.');
  if (dot <= 0) return null;
  const ext = base.slice(dot).toLowerCase();
  if (!TARGET_EXTENSIONS.includes(ext)) return null;

  const stem = base.slice(0, dot);
  // 已带 hash 的形态：name-<6~16位十六进制> → 基名取 name
  const m = /^(.*)-([0-9a-f]{6,16})$/.exec(stem);
  const bareName = m ? m[1] : stem;

  const newHash = createHash('sha256').update(source).digest('hex').slice(0, HASH_LEN);
  const newBase = `${bareName}-${newHash}${ext}`;
  if (base === newBase) return null; // 内容未变：保持原名，不吃无谓的缓存失效
  return `${dir}${newBase}`;
}

export function assetContentHashPlugin(): Plugin {
  return {
    name: 'palink-asset-content-hash',
    apply: 'build',
    enforce: 'post',
    writeBundle(options, bundle) {
      const outDir = path.resolve(options.dir ?? 'dist');

      // 第一步：扫已落盘的产物，对非 JS hash 资产算出新名（内容级）
      const renames = new Map<string, string>();
      const collect = (root: string, rel: string) => {
        const full = path.join(root, rel);
        for (const entry of fs.readdirSync(full, { withFileTypes: true })) {
          const childRel = rel ? `${rel}/${entry.name}` : entry.name;
          const childFull = path.join(root, childRel);
          if (entry.isDirectory()) {
            collect(root, childRel);
            continue;
          }
          if (!entry.isFile()) continue;
          const target = contentNameFor(childRel, fs.readFileSync(childFull));
          if (target) renames.set(childRel, target);
        }
      };
      collect(outDir, '');
      if (renames.size === 0) return;

      // 第二步：把产物文本里对被改名资产的引用整体替换（长名优先，避免互为子串时错序）
      const oldNames = [...renames.keys()].sort((a, b) => b.length - a.length);
      const rewrite = (text: string): string => {
        let out = text;
        for (const oldName of oldNames) {
          if (!out.includes(oldName)) continue;
          out = out.split(oldName).join(renames.get(oldName)!);
        }
        return out;
      };

      const walkText = (root: string, rel: string) => {
        const full = path.join(root, rel);
        for (const entry of fs.readdirSync(full, { withFileTypes: true })) {
          const childRel = rel ? `${rel}/${entry.name}` : entry.name;
          const childFull = path.join(root, childRel);
          if (entry.isDirectory()) {
            walkText(root, childRel);
            continue;
          }
          if (!entry.isFile()) continue;
          const ext = path.extname(childRel).toLowerCase();
          if (!TEXT_EXTENSIONS.includes(ext)) continue;
          const before = fs.readFileSync(childFull, 'utf8');
          const after = rewrite(before);
          if (after !== before) fs.writeFileSync(childFull, after);
        }
      };
      walkText(outDir, '');

      // 第三步：真正改名（先改内容引用再动文件，避免中途出现断链）
      for (const [oldRel, newRel] of renames) {
        const oldFull = path.join(outDir, oldRel);
        const newFull = path.join(outDir, newRel);
        if (!fs.existsSync(oldFull)) continue;
        if (fs.existsSync(newFull)) {
          // 内容相同的重复资产会算出同名：保留已有，丢弃重复项
          fs.unlinkSync(oldFull);
          continue;
        }
        fs.renameSync(oldFull, newFull);
      }

      // 第四步：清掉 gzip 兄弟文件（writeBundle 早于 gzip-dist.cjs，正常不存在；
      // 若曾被预压过，旧 .gz 会让 nginx gzip_static 投递到过期内容，必须一并作废）。
      for (const oldRel of renames.keys()) {
        const gz = path.join(outDir, `${oldRel}.gz`);
        if (fs.existsSync(gz)) fs.unlinkSync(gz);
      }

      console.warn(`[asset-content-hash] 按内容重命名 ${renames.size} 个 hash 资产`);
      for (const [oldRel, newRel] of renames) {
        console.warn(`[asset-content-hash]   ${oldRel} → ${newRel}`);
      }
    },
  };
}
