/**
 * showdown 测试桩（仅 vitest alias 使用，不进生产构建）
 *
 * 背景：项目路径含中文（D:/项目/...），showdown 的 CJS 包装在 vitest/node 环境
 * 下用 file:// URL require 内部模块，URL 编码后的 %E9%A1%B9%E7%9B%AE 使
 * require 解析失败（"Cannot find module file:///...showdown.js"）。
 * ST 契约测试只验证 API 形状/事件契约，不测 markdown 渲染，桩替足够。
 */
export class Converter {
  private text = '';
  constructor(_options?: Record<string, unknown>) {}
  makeHtml(text: string): string {
    this.text = String(text ?? '');
    return this.text;
  }
  getRawText(): string {
    return this.text;
  }
}
export default { Converter };
