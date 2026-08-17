/**
 * Tokenizer 模块入口
 * 基于 SillyTavern tokenizers.js
 */

// 导出类型
export type {
  TokenizerInfo,
  TokenCountResult,
} from './service';

// 导出枚举
export { TokenizerType } from './service';

// 导出类和实例
export { TokenizerService, createTokenizerService } from './service';
import { tokenizerService } from './service';
export { tokenizerService };

/**
 * React Hook: useTokenizer
 */
export function useTokenizer() {
  return {
    service: tokenizerService,
    estimate: tokenizerService.estimate.bind(tokenizerService),
    count: tokenizerService.count.bind(tokenizerService),
    encode: tokenizerService.encode.bind(tokenizerService),
    decode: tokenizerService.decode.bind(tokenizerService),
    getTokenizerForModel: tokenizerService.getTokenizerForModel.bind(tokenizerService),
  };
}
