/**
 * Tokenizer Service - Token计数服务
 * 基于 SillyTavern tokenizers.js
 */

import { api } from '@/services/api';

// ============================================================
// 类型定义
// ============================================================

export enum TokenizerType {
  GPT2 = 'gpt2',
  OPENAI = 'openai',
  LLAMA = 'llama',
  CLAUDE = 'claude',
  MISTRAL = 'mistral',
  BEST_MATCH = 'best_match',
}

export interface TokenizerInfo {
  name: string;
  type: string;
  loaded: boolean;
}

export interface TokenCountResult {
  count: number;
  tokenizer: string;
}

// ============================================================
// TokenizerService 类
// ============================================================

export class TokenizerService {
  private cache: Map<string, number> = new Map();
  private cacheSize = 1000;

  /**
   * 估算Token数量（本地计算，不调用API）
   */
  estimate(text: string): number {
    if (!text) return 0;
    
    // 简单估算：英文约4字符=1token，中文约2字符=1token
    const englishChars = text.match(/[a-zA-Z0-9]/g)?.length || 0;
    const chineseChars = text.match(/[\u4e00-\u9fff]/g)?.length || 0;
    const otherChars = text.length - englishChars - chineseChars;
    
    return Math.ceil(englishChars / 4 + chineseChars / 2 + otherChars / 3);
  }

  /**
   * 精确计算Token数量（调用API）
   */
  async count(text: string, tokenizer: TokenizerType = TokenizerType.BEST_MATCH): Promise<TokenCountResult> {
    // 检查缓存
    const cacheKey = `${text}:::${tokenizer}`;
    if (this.cache.has(cacheKey)) {
      return {
        count: this.cache.get(cacheKey)!,
        tokenizer,
      };
    }

    try {
      const response = await api.post<{ count: number }>('/api/tokenizers/count', {
        text,
        tokenizer,
      });

      const count = response?.count ?? this.estimate(text);
      
      // 更新缓存
      this.updateCache(cacheKey, count);

      return { count, tokenizer };
    } catch (error) {
      console.warn('[Tokenizer] API call failed, using estimate:', error);
      return {
        count: this.estimate(text),
        tokenizer: 'estimate',
      };
    }
  }

  /**
   * 编码文本为Token
   */
  async encode(text: string, tokenizer: TokenizerType = TokenizerType.BEST_MATCH): Promise<number[]> {
    try {
      const response = await api.post<{ tokens: number[] }>('/api/tokenizers/encode', {
        text,
        tokenizer,
      });

      return response?.tokens ?? [];
    } catch (error) {
      console.error('[Tokenizer] Encode failed:', error);
      return [];
    }
  }

  /**
   * 解码Token为文本
   */
  async decode(tokens: number[], tokenizer: TokenizerType = TokenizerType.BEST_MATCH): Promise<string> {
    try {
      const response = await api.post<{ text: string }>('/api/tokenizers/decode', {
        tokens,
        tokenizer,
      });

      return response?.text ?? '';
    } catch (error) {
      console.error('[Tokenizer] Decode failed:', error);
      return '';
    }
  }

  /**
   * 获取可用的Tokenizer列表
   */
  async list(): Promise<TokenizerInfo[]> {
    try {
      const response = await api.get<{ tokenizers: TokenizerInfo[] }>('/api/tokenizers/list');
      return response?.tokenizers ?? [];
    } catch (error) {
      console.error('[Tokenizer] List failed:', error);
      return [];
    }
  }

  /**
   * 根据模型名称获取推荐的Tokenizer
   */
  getTokenizerForModel(model: string): TokenizerType {
    const modelLower = model.toLowerCase();

    if (modelLower.includes('gpt-4') || modelLower.includes('gpt-3.5')) {
      return TokenizerType.OPENAI;
    }
    if (modelLower.includes('claude')) {
      return TokenizerType.CLAUDE;
    }
    if (modelLower.includes('llama') || modelLower.includes('meta')) {
      return TokenizerType.LLAMA;
    }
    if (modelLower.includes('mistral')) {
      return TokenizerType.MISTRAL;
    }

    return TokenizerType.BEST_MATCH;
  }

  /**
   * 更新缓存
   */
  private updateCache(key: string, value: number): void {
    // 如果缓存已满，删除最旧的
    if (this.cache.size >= this.cacheSize) {
      const firstKey = this.cache.keys().next().value;
      if (firstKey) {
        this.cache.delete(firstKey);
      }
    }

    this.cache.set(key, value);
  }

  /**
   * 清除缓存
   */
  clearCache(): void {
    this.cache.clear();
  }
}

/**
 * 创建Tokenizer服务实例
 */
export function createTokenizerService(): TokenizerService {
  return new TokenizerService();
}

// 导出单例
export const tokenizerService = new TokenizerService();
