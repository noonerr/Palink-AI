// [P1-SHIM-EXTERNAL] 外部运行时资产 URL（Vite 插件经 virtual module 注入）。
//
// 用 virtual module（而非 define）注入 URL：Vite 7 的 define 在 dev 模式对客户端
// 模块不生效（vite:define 插件跳过 client consumer），virtual module 的 resolveId/load
// 钩子在 dev/build 均执行。插件未加载（如独立测试环境）时回退为空字符串，
// buildSillyTavernCompatRuntimeV2Shim 据此走全内联回退路径。
import runtimeUrl from 'virtual:palink-smart-card-runtime-url';

export const SMART_CARD_RUNTIME_URL: string = runtimeUrl || '';
