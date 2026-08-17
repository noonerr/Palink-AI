/**
 * Expression System - 角色表情系统
 * 基于 SillyTavern 的 expression 系统
 */

import { api } from '@/services/api';
import { emitEvent } from '../event-bus';

// ============================================================
// 类型定义
// ============================================================

export enum Expression {
  NEUTRAL = 'neutral',
  HAPPY = 'happy',
  SAD = 'sad',
  ANGRY = 'angry',
  SURPRISED = 'surprised',
  SCARED = 'scared',
  DISGUSTED = 'disgusted',
  CONTEMPLATIVE = 'contemplative',
  LOVE = 'love',
  EMBARRASSED = 'embarrassed',
  SMIRKING = 'smirking',
  EXCITED = 'excited',
  TIRED = 'tired',
  CONFUSED = 'confused',
  CUSTOM = 'custom',
}

export interface ExpressionImage {
  expression: Expression;
  url: string;
  isCustom: boolean;
}

export interface CharacterExpressions {
  characterId: string;
  expressions: Map<Expression, string>;
  defaultExpression: Expression;
}

// ============================================================
// ExpressionManager 类
// ============================================================

export class ExpressionManager {
  private characterExpressions: Map<string, CharacterExpressions> = new Map();
  private currentExpression: Map<string, Expression> = new Map();

  /**
   * 加载角色表情
   */
  async loadExpressions(characterId: string): Promise<void> {
    try {
      const response = await api.get<{ expressions: Record<string, string> }>(
        `/api/characters/${characterId}/expressions`
      );

      if (response?.expressions) {
        const expressions = new Map<Expression, string>();
        for (const [expr, url] of Object.entries(response.expressions)) {
          expressions.set(expr as Expression, url);
        }

        this.characterExpressions.set(characterId, {
          characterId,
          expressions,
          defaultExpression: Expression.NEUTRAL,
        });
      }
    } catch (error) {
      console.error('[Expression] Failed to load expressions:', error);
    }
  }

  /**
   * 获取角色表情图片
   */
  getExpressionImage(characterId: string, expression: Expression): string | null {
    const charExpr = this.characterExpressions.get(characterId);
    if (!charExpr) return null;

    return charExpr.expressions.get(expression) ?? null;
  }

  /**
   * 设置当前表情
   */
  setCurrentExpression(characterId: string, expression: Expression): void {
    this.currentExpression.set(characterId, expression);
    emitEvent('expression:changed', { characterId, expression });
  }

  /**
   * 获取当前表情
   */
  getCurrentExpression(characterId: string): Expression {
    return this.currentExpression.get(characterId) ?? Expression.NEUTRAL;
  }

  /**
   * 根据文本分析表情
   */
  async analyzeExpression(text: string): Promise<Expression> {
    try {
      const response = await api.post<{ expression: Expression }>(
        '/api/expressions/analyze',
        { text }
      );

      return response?.expression ?? Expression.NEUTRAL;
    } catch (error) {
      console.error('[Expression] Failed to analyze expression:', error);
      return Expression.NEUTRAL;
    }
  }

  /**
   * 上传自定义表情图片
   */
  async uploadExpression(
    characterId: string,
    expression: Expression,
    file: File
  ): Promise<string | null> {
    try {
      const formData = new FormData();
      formData.append('expression', expression);
      formData.append('image', file);

      const response = await api.post<{ url: string }>(
        `/api/characters/${characterId}/expressions`,
        formData
      );

      if (response?.url) {
        // 更新本地缓存
        const charExpr = this.characterExpressions.get(characterId);
        if (charExpr) {
          charExpr.expressions.set(expression, response.url);
        }

        emitEvent('expression:uploaded', { characterId, expression });
        return response.url;
      }

      return null;
    } catch (error) {
      console.error('[Expression] Failed to upload expression:', error);
      return null;
    }
  }

  /**
   * 删除表情图片
   */
  async deleteExpression(characterId: string, expression: Expression): Promise<boolean> {
    try {
      await api.delete(`/api/characters/${characterId}/expressions/${expression}`);

      // 更新本地缓存
      const charExpr = this.characterExpressions.get(characterId);
      if (charExpr) {
        charExpr.expressions.delete(expression);
      }

      emitEvent('expression:deleted', { characterId, expression });
      return true;
    } catch (error) {
      console.error('[Expression] Failed to delete expression:', error);
      return false;
    }
  }

  /**
   * 获取所有可用表情
   */
  getAvailableExpressions(): Expression[] {
    return Object.values(Expression);
  }

  /**
   * 获取角色的所有表情
   */
  getCharacterExpressions(characterId: string): Map<Expression, string> {
    return this.characterExpressions.get(characterId)?.expressions ?? new Map();
  }

  /**
   * 检查表情是否存在
   */
  hasExpression(characterId: string, expression: Expression): boolean {
    const charExpr = this.characterExpressions.get(characterId);
    return charExpr?.expressions.has(expression) ?? false;
  }
}

/**
 * 创建表情管理器实例
 */
export function createExpressionManager(): ExpressionManager {
  return new ExpressionManager();
}

// 导出单例
export const expressionManager = new ExpressionManager();
