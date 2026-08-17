import { debounceAsync } from '../../utils.js';

export { debounceAsync };


const _VERBOSE = true;
export const debug = (...msg) => _VERBOSE ? console.debug('[QR2]', ...msg) : null;
export const log = (...msg) => _VERBOSE ? console.log('[QR2]', ...msg) : null;
export const warn = (...msg) => _VERBOSE ? console.warn('[QR2]', ...msg) : null;


let _quickReplyApi = null;
export function setQuickReplyApi(api) {
    _quickReplyApi = api;
}
export function getQuickReplyApi() {
    return _quickReplyApi;
}

/**
 * QuickReply.js 在编辑器事件回调中通过 quickReplyApi.listSets() 等调用 API。
 * 由于沙箱的 CommonJS 转译在模块顶层解构时就快照导出值，无法像 ESM live
 * binding 那样拿到入口 index.js 运行时才赋值的 quickReplyApi，因此这里用
 * 一个状态可变的 Proxy：解构拿到的是 Proxy 引用本身，方法调用延迟到运行时转发。
 */
export const quickReplyApi = new Proxy({}, {
    get: (_t, prop) => {
        if (!_quickReplyApi) return undefined;
        const v = _quickReplyApi[prop];
        return typeof v === 'function' ? v.bind(_quickReplyApi) : v;
    },
});
