import type { Model } from '@/types';

export const PRESETS = [
  { name: 'OpenRouter', url: 'https://openrouter.ai/api/v1', icon: '🌐', models: [] },
  { name: 'DeepSeek', url: 'https://api.deepseek.com', icon: '🐋', models: [] },
  { name: '硅基流动', url: 'https://api.siliconflow.cn/v1', icon: '🔮', models: [] },
  { name: '自定义', url: '', icon: '✏️', models: [] },
];

export const EMOJIS = ['🤖', '👨‍💻', '👩‍💻', '🧠', '⚡', '🚀', '🎨', '👾', '🦊', '🐱', '🐶', '🐼', '🐸', '🐵', '🦄', '🐲'];

export const ICON_MAPPING: Record<string, string> = {
  'deepseek': '/icons/openrouter.webp',
  'openai': '/icons/openai.webp',
  'gpt': '/icons/openai.webp',
  'o1-': '/icons/openai.webp',
  'o3-': '/icons/openai.webp',
  'o4-': '/icons/openai.webp',
  'claude': '/icons/claude-color.webp',
  'anthropic': '/icons/anthropic.webp',
  'gemini': '/icons/gemini-color.webp',
  'google': '/icons/gemini-color.webp',
  'qwen': '/icons/qwen-color.webp',
  '通义千问': '/icons/qwen-color.webp',
  'moonshot': '/icons/moonshot.webp',
  'kimi': '/icons/moonshot.webp',
  'doubao': '/icons/doubao-color.webp',
  '豆包': '/icons/doubao-color.webp',
  'chatglm': '/icons/chatglm-color.webp',
  'glm': '/icons/chatglm-color.webp',
  '智谱': '/icons/zhipu-color.webp',
  'zhipu': '/icons/zhipu-color.webp',
  'ollama': '/icons/ollama.webp',
  'llama': '/icons/meta-color.webp',
  'meta-llama': '/icons/meta-color.webp',
  'meta': '/icons/meta-color.webp',
  'gemma': '/icons/gemma-color.webp',
  'grok': '/icons/grok.webp',
  'x-ai': '/icons/grok.webp',
  'xai': '/icons/grok.webp',
  'midjourney': '/icons/midjourney.webp',
  'luma': '/icons/luma-color.webp',
  'kling': '/icons/kling-color.webp',
  'openrouter': '/icons/openrouter.webp',
  'xiaomi': '/icons/xiaomimimo.webp',
  '小米': '/icons/xiaomimimo.webp',
  'siliconflow': '/icons/siliconflow-color.webp',
  'silicon': '/icons/siliconflow-color.webp',
  '硅基流动': '/icons/siliconflow-color.webp',
};

export const AVAILABLE_ICONS = [
  { name: 'openai', path: '/icons/openai.webp', category: '通用' },
  { name: 'anthropic', path: '/icons/anthropic.webp', category: '通用' },
  { name: 'claude-color', path: '/icons/claude-color.webp', category: '通用' },
  { name: 'gemini-color', path: '/icons/gemini-color.webp', category: '通用' },
  { name: 'openrouter', path: '/icons/openrouter.webp', category: '通用' },
  { name: 'qwen-color', path: '/icons/qwen-color.webp', category: '中文' },
  { name: 'moonshot', path: '/icons/moonshot.webp', category: '中文' },
  { name: 'doubao-color', path: '/icons/doubao-color.webp', category: '中文' },
  { name: 'chatglm-color', path: '/icons/chatglm-color.webp', category: '中文' },
  { name: 'zhipu-color', path: '/icons/zhipu-color.webp', category: '中文' },
  { name: 'xiaomimimo', path: '/icons/xiaomimimo.webp', category: '中文' },
  { name: 'siliconflow-color', path: '/icons/siliconflow-color.webp', category: '中文' },
  { name: 'meta-color', path: '/icons/meta-color.webp', category: '开源' },
  { name: 'ollama', path: '/icons/ollama.webp', category: '开源' },
  { name: 'gemma-color', path: '/icons/gemma-color.webp', category: '开源' },
  { name: 'grok', path: '/icons/grok.webp', category: '其他' },
  { name: 'midjourney', path: '/icons/midjourney.webp', category: '图像' },
  { name: 'luma-color', path: '/icons/luma-color.webp', category: '视频' },
  { name: 'kling-color', path: '/icons/kling-color.webp', category: '视频' },
];

export const MODEL_FAMILIES = [
  { id: 'gpt', name: 'GPT 系列', icon: '/icons/openai.webp', keywords: ['gpt', 'openai', 'o1-', 'o3-', 'o4-'] },
  { id: 'claude', name: 'Claude 系列', icon: '/icons/claude-color.webp', keywords: ['claude', 'anthropic'] },
  { id: 'gemini', name: 'Gemini 系列', icon: '/icons/gemini-color.webp', keywords: ['gemini', 'google/gemini'] },
  { id: 'qwen', name: '千问 系列', icon: '/icons/qwen-color.webp', keywords: ['qwen', '通义千问'] },
  { id: 'grok', name: 'Grok 系列', icon: '/icons/grok.webp', keywords: ['grok', 'x-ai/', 'xai'] },
  { id: 'glm', name: 'GLM 系列', icon: '/icons/chatglm-color.webp', keywords: ['glm', 'chatglm', 'zhipu', '智谱'] },
  { id: 'gemma', name: 'Gemma 系列', icon: '/icons/gemma-color.webp', keywords: ['gemma'] },
  { id: 'llama', name: 'LLaMA 系列', icon: '/icons/meta-color.webp', keywords: ['llama', 'meta-llama'] },
  { id: 'deepseek', name: 'DeepSeek 系列', icon: '/icons/openrouter.webp', keywords: ['deepseek'] },
  { id: 'moonshot', name: 'Kimi 系列', icon: '/icons/moonshot.webp', keywords: ['moonshot', 'kimi'] },
  { id: 'doubao', name: '豆包 系列', icon: '/icons/doubao-color.webp', keywords: ['doubao', '豆包'] },
  { id: 'midjourney', name: 'Midjourney 系列', icon: '/icons/midjourney.webp', keywords: ['midjourney'] },
  { id: 'luma', name: 'Luma 系列', icon: '/icons/luma-color.webp', keywords: ['luma'] },
  { id: 'kling', name: 'Kling 系列', icon: '/icons/kling-color.webp', keywords: ['kling'] },
  { id: 'xiaomi', name: '小米 系列', icon: '/icons/xiaomimimo.webp', keywords: ['xiaomi', '小米'] },
  { id: 'siliconflow', name: '硅基流动 系列', icon: '/icons/siliconflow-color.webp', keywords: ['siliconflow', 'silicon', '硅基'] },
] as const;

export function detectModelFamily(modelId: string, displayName?: string): { id: string; name: string; icon: string } {
  const lowerId = modelId.toLowerCase();
  for (const family of MODEL_FAMILIES) {
    for (const keyword of family.keywords) {
      if (lowerId.includes(keyword.toLowerCase())) {
        return { id: family.id, name: family.name, icon: family.icon };
      }
    }
  }
  if (displayName) {
    const lowerName = displayName.toLowerCase();
    for (const family of MODEL_FAMILIES) {
      for (const keyword of family.keywords) {
        if (lowerName.includes(keyword.toLowerCase())) {
          return { id: family.id, name: family.name, icon: family.icon };
        }
      }
    }
  }
  return { id: 'other', name: '其他模型', icon: '/icons/ollama.webp' };
}

export function autoMatchIcon(modelId: string, displayName?: string): string {
  const lowerId = modelId.toLowerCase();
  for (const [key, iconPath] of Object.entries(ICON_MAPPING)) {
    if (lowerId.includes(key.toLowerCase())) {
      return iconPath;
    }
  }
  if (displayName) {
    const lowerName = displayName.toLowerCase();
    for (const [key, iconPath] of Object.entries(ICON_MAPPING)) {
      if (lowerName.includes(key.toLowerCase())) {
        return iconPath;
      }
    }
  }
  return '/icons/openrouter.webp';
}

export function normalizeModelForSave(model: Model): Model {
  return {
    ...model,
    name: model.name || model.id,
    id: (model as any).alias || model.id,
  };
}
