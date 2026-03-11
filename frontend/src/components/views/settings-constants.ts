import type { Model } from '@/types';

export const PRESETS = [
  { name: 'OpenRouter', url: 'https://openrouter.ai/api/v1', icon: '🌐', models: ['openai/gpt-3.5-turbo'] },
  { name: 'DeepSeek', url: 'https://api.deepseek.com', icon: '🐋', models: ['deepseek-chat'] },
  { name: 'OpenAI', url: 'https://api.openai.com/v1', icon: '🅾️', models: ['gpt-4', 'gpt-3.5-turbo'] },
  { name: 'Anthropic', url: 'https://api.anthropic.com/v1', icon: '🅰️', models: ['claude-3-opus', 'claude-3-sonnet'] },
];

export const EMOJIS = ['🤖', '👨‍💻', '👩‍💻', '🧠', '⚡', '🚀', '🎨', '👾', '🦊', '🐱', '🐶', '🐼', '🐸', '🐵', '🦄', '🐲'];

export const ICON_MAPPING: Record<string, string> = {
  'deepseek': '/icons/openrouter.webp',
  'openai': '/icons/openai.webp',
  'gpt': '/icons/openai.webp',
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
  '智谱': '/icons/zhipu-color.webp',
  'zhipu': '/icons/zhipu-color.webp',
  'ollama': '/icons/ollama.webp',
  'llama': '/icons/meta-color.webp',
  'meta': '/icons/meta-color.webp',
  'gemma': '/icons/gemma-color.webp',
  'grok': '/icons/grok.webp',
  'xai': '/icons/grok.webp',
  'midjourney': '/icons/midjourney.webp',
  'luma': '/icons/luma-color.webp',
  'kling': '/icons/kling-color.webp',
  'openrouter': '/icons/openrouter.webp',
  'xiaomi': '/icons/xiaomimimo.webp',
  '小米': '/icons/xiaomimimo.webp',
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
  { name: 'meta-color', path: '/icons/meta-color.webp', category: '开源' },
  { name: 'ollama', path: '/icons/ollama.webp', category: '开源' },
  { name: 'gemma-color', path: '/icons/gemma-color.webp', category: '开源' },
  { name: 'grok', path: '/icons/grok.webp', category: '其他' },
  { name: 'midjourney', path: '/icons/midjourney.webp', category: '图像' },
  { name: 'luma-color', path: '/icons/luma-color.webp', category: '视频' },
  { name: 'kling-color', path: '/icons/kling-color.webp', category: '视频' },
];

export function autoMatchIcon(modelName: string): string {
  const lowerName = modelName.toLowerCase();
  for (const [key, iconPath] of Object.entries(ICON_MAPPING)) {
    if (lowerName.includes(key.toLowerCase())) {
      return iconPath;
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
