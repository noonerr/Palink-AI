const fs = require('fs');
const path = require('path');

const projectRoot = path.resolve(__dirname, '..');
const distDir = path.resolve(projectRoot, 'dist');

if (!distDir.startsWith(projectRoot + path.sep)) {
  throw new Error(`Refusing to clean outside project root: ${distDir}`);
}

// 守卫：VITE_OUT_DIR 指向非 dist 目录时（备份式构建工作流，见 build-vite.mjs），
// 本次构建的产物不在 ./dist —— 不应把 ./dist 删掉。
// 历史事故：并行工作流以 VITE_OUT_DIR=dist_fix_* 构建时，clean-dist 无差别删除
// ./dist，而 docker-compose 的 bind mount 指向 ./dist → 挂载失效 → nginx 500。
const outDirOverride = (process.env.VITE_OUT_DIR || '').trim();
if (outDirOverride && outDirOverride !== 'dist') {
  console.log(`[clean-dist] 跳过 ./dist 清理（VITE_OUT_DIR=${outDirOverride}，产物不在 dist）`);
  process.exit(0);
}

function removeEntry(entryPath) {
  const stat = fs.lstatSync(entryPath);
  if (stat.isDirectory() && !stat.isSymbolicLink()) {
    for (const child of fs.readdirSync(entryPath)) {
      removeEntry(path.join(entryPath, child));
    }
    fs.rmdirSync(entryPath);
    return;
  }
  fs.unlinkSync(entryPath);
}

if (fs.existsSync(distDir)) {
  for (const entry of fs.readdirSync(distDir)) {
    removeEntry(path.join(distDir, entry));
  }
  fs.rmdirSync(distDir);
}
