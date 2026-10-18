// [LEGACY-EXTERNAL 2026-10-18] 外部 legacy shim 资产 URL（Vite 插件经 virtual module 注入）。
//
// 与 runtime-url.ts 同构：用 virtual module（而非 define）注入 URL —— Vite 7 的 define
// 在 dev 模式对客户端模块不生效（vite:define 插件跳过 client consumer），virtual module 的
// resolveId/load 钩子在 dev/build 均执行。插件未加载（如独立测试环境）时回退为空字符串，
// buildShim 据此走全内联回退路径。
import legacyUrl from 'virtual:palink-smart-card-legacy-url';

export const SMART_CARD_LEGACY_URL: string = legacyUrl || '';
