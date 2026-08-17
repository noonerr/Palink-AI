import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { build, loadConfigFromFile } from 'vite';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const configFile = path.resolve(__dirname, '../vite.config.ts');
const loaded = await loadConfigFromFile({ command: 'build', mode: 'production' }, configFile);

if (!loaded) {
  throw new Error(`Unable to load Vite config: ${configFile}`);
}

const config = loaded.config;

// 可选：跳过清空 dist（某些受限环境下批量删除会被安全守卫拦截）
// 用法：VITE_KEEP_OUTDIR=1 node scripts/build-vite.mjs
if (process.env.VITE_KEEP_OUTDIR === '1') {
  config.build = { ...(config.build || {}), emptyOutDir: false };
}

// 可选：输出到全新目录（受限环境下"覆盖已存在文件"会被写入守卫拦截而截断为 0 字节）
// 用法：VITE_OUT_DIR=dist_new node scripts/build-vite.mjs
if (process.env.VITE_OUT_DIR) {
  config.build = {
    ...(config.build || {}),
    outDir: path.resolve(__dirname, '..', process.env.VITE_OUT_DIR),
    emptyOutDir: false,
  };
}

await build(config);
