/**
 * Expression System 模块入口
 * 基于 SillyTavern 的 expression 系统
 */

// 导出类型
export type {
  ExpressionImage,
  CharacterExpressions,
} from './manager';

// 导出枚举
export { Expression } from './manager';

// 导出类和实例
export { ExpressionManager, createExpressionManager } from './manager';
import { expressionManager } from './manager';
export { expressionManager };

/**
 * React Hook: useExpression
 */
export function useExpression() {
  return {
    manager: expressionManager,
    loadExpressions: expressionManager.loadExpressions.bind(expressionManager),
    getExpressionImage: expressionManager.getExpressionImage.bind(expressionManager),
    setCurrentExpression: expressionManager.setCurrentExpression.bind(expressionManager),
    getCurrentExpression: expressionManager.getCurrentExpression.bind(expressionManager),
    analyzeExpression: expressionManager.analyzeExpression.bind(expressionManager),
    getAvailableExpressions: expressionManager.getAvailableExpressions.bind(expressionManager),
    getCharacterExpressions: expressionManager.getCharacterExpressions.bind(expressionManager),
  };
}
