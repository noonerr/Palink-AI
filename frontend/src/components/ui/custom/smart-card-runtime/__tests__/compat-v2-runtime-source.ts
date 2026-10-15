/**
 * 「读源码文本做契约断言」的测试共用的 COMPAT_V2 运行时源码文本。
 *
 * 背景：SillyTavernCompatRuntime.ts 的运行时体原本是一个巨型模板字符串（原第 270-7312 行）。
 * S4 按行把它机械拆成了 `runtime-body/part-01..08.ts`，仍然按单文件 readFileSync 的旧测试
 * 会拿不到被搬走的片段。这里按拆分前的**原文顺序**（入口文件 + 各段）把源码拼回整段文本 ——
 * 断言的依旧是仓库里的真实源码，不是重写出来的副本。
 *
 * ⚠️ 顺序即原文件顺序：入口文件（TS 头 + 拼接壳）在前，part-01..08 按行号升序在后。
 *    不可调换；新增段时必须同步加进 PARTS。
 *
 * 为什么用 readFileSync 而不是 import 各段常量：各段是模板字符串，import 进来拿到的是
 * 求值后的产物；这里要的是「源码文本」本身（含尚未求值的插值占位），与拆分前完全一致。
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const RUNTIME_RELATIVE_DIR = 'src/components/ui/custom/smart-card-runtime';
const PARTS_RELATIVE_DIR = `${RUNTIME_RELATIVE_DIR}/runtime-body`;

/** 顺序 = 原模板行号顺序（part-01 起 270 行，part-08 止 7312 行）。 */
const PARTS = [
  'part-01.ts',
  'part-02.ts',
  'part-03.ts',
  'part-04.ts',
  'part-05.ts',
  'part-06.ts',
  'part-07.ts',
  'part-08.ts',
];

/** vitest 固定以 frontend/ 为 cwd 运行，故用相对仓库根的路径。 */
export const COMPAT_V2_RUNTIME_SOURCE: string = [
  // 入口文件：TS 头（类型、boot payload 白名单等断言目标都在这一段）+ 拼接壳
  readFileSync(join(process.cwd(), RUNTIME_RELATIVE_DIR, 'SillyTavernCompatRuntime.ts'), 'utf8'),
  ...PARTS.map((file) => readFileSync(join(process.cwd(), PARTS_RELATIVE_DIR, file), 'utf8')),
].join('');
