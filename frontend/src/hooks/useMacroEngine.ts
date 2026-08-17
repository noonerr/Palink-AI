/**
 * 宏引擎集成Hook
 * 将宏引擎集成到system prompt和消息处理中
 */

import { useCallback, useRef, useEffect } from 'react';
import { 
  evaluateMacros, 
  initRegisterMacros, 
  type MacroEnv 
} from '@/lib/macro-engine';

export interface UseMacroEngineOptions {
  /** 用户名 */
  userName?: string;
  /** 角色名（用于角色扮演） */
  characterName?: string;
  /** 当前模型 */
  modelName?: string;
  /** 自定义宏 */
  dynamicMacros?: Record<string, string | (() => string)>;
}

export function useMacroEngine(options: UseMacroEngineOptions = {}) {
  const { userName = 'User', characterName = 'Assistant', modelName = '', dynamicMacros = {} } = options;
  const initializedRef = useRef(false);

  // 初始化宏引擎
  useEffect(() => {
    if (!initializedRef.current) {
      initRegisterMacros();
      initializedRef.current = true;
    }
  }, []);

  // 构建宏环境
  const buildEnv = useCallback((extra?: Record<string, any>): Partial<MacroEnv> => {
    return {
      names: {
        user: userName,
        char: characterName,
        group: '',
        groupNotMuted: '',
        notChar: userName,
      },
      system: {
        model: modelName,
      },
      dynamicMacros,
      extra: extra || {},
    };
  }, [userName, characterName, modelName, dynamicMacros]);

  // 处理文本中的宏
  const processMacros = useCallback((text: string, extra?: Record<string, any>): string => {
    if (!text) return '';
    
    const env = buildEnv(extra);
    return evaluateMacros(text, env);
  }, [buildEnv]);

  // 处理system prompt
  const processSystemPrompt = useCallback((prompt: string, extra?: Record<string, any>): string => {
    return processMacros(prompt, extra);
  }, [processMacros]);

  // 处理用户消息
  const processUserMessage = useCallback((message: string, extra?: Record<string, any>): string => {
    return processMacros(message, extra);
  }, [processMacros]);

  return {
    processMacros,
    processSystemPrompt,
    processUserMessage,
    buildEnv,
  };
}
