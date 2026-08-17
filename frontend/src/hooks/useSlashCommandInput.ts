/**
 * 斜杠命令输入Hook
 * 处理命令输入、补全和执行
 */

import { useState, useCallback, useRef, useEffect } from 'react';
import { 
  SlashCommandEngine, 
  initSlashCommands,
  type CommandContext,
  type CompletionItem,
  type CommandResult,
} from '@/lib/slash-engine/mod';

export interface UseSlashCommandInputOptions {
  /** 命令上下文 */
  context?: CommandContext;
  /** 是否启用命令补全 */
  enableCompletion?: boolean;
  /** 命令执行回调 */
  onCommandExecuted?: (result: CommandResult) => void;
}

export function useSlashCommandInput(options: UseSlashCommandInputOptions = {}) {
  const { context, enableCompletion = true, onCommandExecuted } = options;
  
  const [completions, setCompletions] = useState<CompletionItem[]>([]);
  const [showCompletions, setShowCompletions] = useState(false);
  const [selectedCompletion, setSelectedCompletion] = useState(0);
  const initializedRef = useRef(false);

  // 初始化命令系统
  useEffect(() => {
    if (!initializedRef.current) {
      initSlashCommands(context);
      initializedRef.current = true;
    }
  }, [context]);

  // 更新补全列表
  const updateCompletions = useCallback((input: string, position: number) => {
    if (!enableCompletion) return;
    
    const items = SlashCommandEngine.getCompletions(input, position);
    setCompletions(items);
    setShowCompletions(items.length > 0);
    setSelectedCompletion(0);
  }, [enableCompletion]);

  // 处理输入变化
  const handleInputChange = useCallback((value: string, cursorPosition?: number) => {
    if (value.startsWith('/')) {
      updateCompletions(value, cursorPosition ?? value.length);
    } else {
      setShowCompletions(false);
    }
  }, [updateCompletions]);

  // 选择补全项
  const selectCompletion = useCallback((index: number) => {
    setSelectedCompletion(index);
  }, []);

  // 应用补全
  const applyCompletion = useCallback((input: string, completion: CompletionItem): string => {
    if (completion.type === 'command') {
      return `/${completion.name} `;
    }
    
    // 对于参数，在当前输入基础上追加
    const lastSpace = input.lastIndexOf(' ');
    if (lastSpace >= 0) {
      return input.slice(0, lastSpace + 1) + completion.name;
    }
    
    return input + completion.name;
  }, []);

  // 检查是否是命令
  const isCommand = useCallback((input: string): boolean => {
    return input.trim().startsWith('/');
  }, []);

  // 执行命令
  const executeCommand = useCallback(async (input: string): Promise<CommandResult> => {
    const result = await SlashCommandEngine.execute(input);
    
    if (onCommandExecuted) {
      onCommandExecuted(result);
    }
    
    return result;
  }, [onCommandExecuted]);

  // 处理键盘事件（用于补全选择）
  const handleKeyDown = useCallback((e: React.KeyboardEvent, input: string): string | null => {
    if (!showCompletions || completions.length === 0) return null;

    if (e.key === 'Tab') {
      e.preventDefault();
      const completion = completions[selectedCompletion];
      if (completion) {
        const newInput = applyCompletion(input, completion);
        setShowCompletions(false);
        return newInput;
      }
    } else if (e.key === 'ArrowDown') {
      e.preventDefault();
      setSelectedCompletion(prev => (prev + 1) % completions.length);
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setSelectedCompletion(prev => (prev - 1 + completions.length) % completions.length);
    } else if (e.key === 'Escape') {
      setShowCompletions(false);
    }

    return null;
  }, [showCompletions, completions, selectedCompletion, applyCompletion]);

  return {
    completions,
    showCompletions,
    selectedCompletion,
    handleInputChange,
    selectCompletion,
    applyCompletion,
    isCommand,
    executeCommand,
    handleKeyDown,
  };
}
