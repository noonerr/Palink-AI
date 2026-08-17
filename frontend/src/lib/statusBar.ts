import type { CharacterStatusBar } from '@/components/ui/custom/StatusBarPanel';

// 匹配模型输出的状态块：<NSFW>...</NSFW> 或 <luomo_nsfw>...</luomo_nsfw>
// 大小写不敏感；块内以竖线 `|` 分隔 22 个字段。
const NSFW_BLOCK_RE = /<(nsfw|luomo_nsfw)\b[^>]*>([\s\S]*?)<\/\1>/gi;

const PART_LABELS = ['表情', '呼吸', '阴蒂', '阴道', '尿道', '后庭', '双手', '双脚', '体表'];
const CLOTHES_LABELS = ['外衣(上)', '外衣(下)', '内衣(胸)', '内裤', '袜子', '鞋履', '配饰/道具'];
const DEV_LABELS = ['嘴部', '阴道', '后庭', '尿道'];

export interface ExtractResult {
  bars: CharacterStatusBar[];
  clean: string;
}

/**
 * 从角色消息正文中提取状态栏块并解析为结构化数据。
 * 返回清理后的正文（已移除原始 <NSFW> 标签）与解析出的状态栏数组。
 */
export function extractCharacterStatusBars(content: string): ExtractResult {
  if (!content) return { bars: [], clean: content };

  const bars: CharacterStatusBar[] = [];

  const clean = content.replace(NSFW_BLOCK_RE, (_m, _tag, body) => {
    const fields = String(body)
      .split('|')
      .map((s) => s.trim());
    while (fields.length < 22) fields.push('');
    const f = (i: number) => fields[i] ?? '';

    bars.push({
      name: f(0),
      inner: f(1),
      parts: PART_LABELS.map((label, i) => ({ label, value: f(2 + i) })),
      clothes: CLOTHES_LABELS.map((label, i) => ({ label, value: f(11 + i) })),
      dev: DEV_LABELS.map((label, i) => ({ label, value: f(18 + i) })),
    });
    return '';
  });

  return { bars, clean: clean.trim() };
}
