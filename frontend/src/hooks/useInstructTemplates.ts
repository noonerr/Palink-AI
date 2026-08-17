/**
 * useInstructTemplates — Instruct 模板管理 hook
 * 加载后端 instruct 模板列表，并提供基于 formatter.ts 的格式化预览能力，
 * 使 formatInstructMessage / formatStoryString / getInstructStopSequences
 * 在前端被实际调用。
 */
import { useState, useCallback, useEffect, useRef } from 'react';
import { api } from '@/services/api';
import {
  formatInstructMessage,
  formatStoryString,
  getInstructStopSequences,
} from '@/lib/instruct';
import type {
  InstructTemplate,
  FormatOptions,
  FormatResult,
} from '@/lib/instruct';

/** 后端 /api/instruct-templates 返回的模板原始结构 */
export interface BackendInstructTemplate {
  id: number;
  user_id: number | null;
  name: string;
  system_prompt: string;
  input_prefix: string;
  input_suffix: string;
  output_prefix: string;
  output_suffix: string;
  first_output_prefix: string;
  last_output_prefix: string;
  system_sequence_prefix: string;
  system_sequence_suffix: string;
  stop_sequence: string;
  separator_sequence: string;
  wrap_sequences: boolean;
  is_default: boolean;
  is_system: boolean;
  created_at: string | null;
}

/** 预览用的消息结构 */
export interface InstructPreviewMessage {
  content: string;
  name?: string;
  isUser?: boolean;
  isSystem?: boolean;
  isNarrator?: boolean;
}

/** 故事字符串预览输入 */
export interface InstructStoryPreviewInput {
  systemPrompt: string;
  description?: string;
  personality?: string;
  scenario?: string;
}

interface UseInstructTemplatesReturn {
  templates: BackendInstructTemplate[];
  loading: boolean;
  error: string | null;
  loadTemplates: () => Promise<void>;
  /** 使用 formatter.ts 的 formatInstructMessage 对消息列表进行格式化预览 */
  previewInstruct: (
    template: InstructTemplate | null,
    messages: InstructPreviewMessage[],
  ) => FormatResult[];
  /** 使用 formatter.ts 的 formatStoryString 格式化故事字符串预览 */
  previewStoryString: (
    template: InstructTemplate | null,
    input: InstructStoryPreviewInput,
  ) => string;
  /** 使用 formatter.ts 的 getInstructStopSequences 获取停止序列 */
  getStopSequences: (template: InstructTemplate | null) => string[];
}

export function useInstructTemplates(): UseInstructTemplatesReturn {
  const [templates, setTemplates] = useState<BackendInstructTemplate[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const mountedRef = useRef(true);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  const loadTemplates = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const data = await api.get<BackendInstructTemplate[]>('/api/instruct-templates');
      if (mountedRef.current) setTemplates(data);
    } catch (e) {
      // 容错：后端不可用时静默降级，不影响前端主流程
      if (mountedRef.current) {
        setError(e instanceof Error ? e.message : 'Failed to load instruct templates');
        setTemplates([]);
      }
    } finally {
      if (mountedRef.current) setLoading(false);
    }
  }, []);

  const previewInstruct = useCallback(
    (
      template: InstructTemplate | null,
      messages: InstructPreviewMessage[],
    ): FormatResult[] => {
      return messages.map((msg) => {
        const options: FormatOptions = {
          name: msg.name,
          isUser: msg.isUser,
          isSystem: msg.isSystem,
          isNarrator: msg.isNarrator,
        };
        return formatInstructMessage(msg.content, options, template);
      });
    },
    [],
  );

  const previewStoryString = useCallback(
    (
      template: InstructTemplate | null,
      input: InstructStoryPreviewInput,
    ): string => {
      return formatStoryString(
        input.systemPrompt,
        input.description ?? '',
        input.personality ?? '',
        input.scenario ?? '',
        template,
      );
    },
    [],
  );

  const getStopSequences = useCallback(
    (template: InstructTemplate | null): string[] => {
      return getInstructStopSequences(template);
    },
    [],
  );

  // 启动时加载一次模板列表
  useEffect(() => {
    loadTemplates();
  }, [loadTemplates]);

  return {
    templates,
    loading,
    error,
    loadTemplates,
    previewInstruct,
    previewStoryString,
    getStopSequences,
  };
}
