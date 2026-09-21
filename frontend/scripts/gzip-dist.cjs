#!/usr/bin/env node
/**
 * 构建后为 dist 下文本类资源生成 .gz 副本，供 nginx gzip_static 直接投递。
 *
 * 设计约束（勿违反）：
 *  - 只新增文件，从不删除 dist 内任何内容（本环境对批量删除有进程级守卫）。
 *  - 幂等：重复执行直接覆盖同名 .gz。
 *  - 已压缩格式（woff2/png/jpg/webp/woff/br/gz）不在处理列表内，避免浪费 CPU。
 *
 * 用法：node scripts/gzip-dist.cjs
 */
const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');

const DIST = path.resolve(__dirname, '..', 'dist');

// 只处理文本类、压缩收益明显的类型
const EXT = new Set([
  '.js', '.mjs', '.css', '.json', '.svg', '.html',
  '.xml', '.txt', '.webmanifest', '.map',
]);

// 太小不值得压缩；太大不压（避免长时间阻塞构建）
const MIN_BYTES = 1024;
const MAX_BYTES = 20 * 1024 * 1024;

if (!fs.existsSync(DIST)) {
  console.error('[gzip-dist] dist 目录不存在，请先执行构建');
  process.exit(1);
}

let count = 0;
let saved = 0;

(function walk(dir) {
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch (e) {
    console.warn('[gzip-dist] 读取失败，跳过:', dir, String(e && e.message));
    return;
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      walk(full);
      continue;
    }
    if (entry.name.endsWith('.gz')) continue;
    if (!EXT.has(path.extname(entry.name).toLowerCase())) continue;

    let size;
    try {
      size = fs.statSync(full).size;
    } catch {
      continue;
    }
    if (size < MIN_BYTES || size > MAX_BYTES) continue;

    try {
      const gz = zlib.gzipSync(fs.readFileSync(full), { level: 9 });
      // 压缩后反而更大（极端随机数据）时跳过，避免负收益
      if (gz.length >= size) continue;
      fs.writeFileSync(full + '.gz', gz);
      count += 1;
      saved += size - gz.length;
    } catch (e) {
      console.warn('[gzip-dist] 压缩失败，跳过:', full, String(e && e.message));
    }
  }
})(DIST);

const savedKb = (saved / 1024).toFixed(0);
console.log(
  `[gzip-dist] 已生成 ${count} 个 .gz 副本` +
  (count ? `，相对原始体积减少 ${savedKb} KB` : '')
);
