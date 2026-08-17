/**
 * Context Template 模块入口
 * 基于 SillyTavern 1.18.0 context template 配置
 */

export type {
  ContextTemplate,
  ContextTemplatePayload,
} from './types';

export {
  ContextTemplateManager,
  contextTemplateManager,
  createContextTemplateManager,
} from './manager';
