
// 这个文件用于验证parseContent函数的逻辑

interface ContentPart {
  type: 'model_reasoning' | 'thinking' | 'action' | 'new_thinking' | 'content';
  content: string;
}

const parseContent = (content: string): ContentPart[] => {
  const parts: ContentPart[] = [];
  let remaining = content;

  // 重复3次解码，确保彻底处理转义
  for (let i = 0; i < 3; i++) {
    remaining = remaining
      .replace(/&amp;/g, '&')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&quot;/g, '"')
      .replace(/&#39;/g, "'");
  }

  const tags = [
    { type: 'action' as const, start: '<|a|>', end: '</|a|>' },
    { type: 'new_thinking' as const, start: '<|t|>', end: '</|t|>' },
    { type: 'model_reasoning' as const, start: '<model_reasoning>', end: '</model_reasoning>' },
    { type: 'thinking' as const, start: '<thinking>', end: '</thinking>' },
    { type: 'thinking' as const, start: '<think>', end: '</think>' },
    { type: 'action' as const, start: '<action>', end: '</action>' },
    { type: 'action' as const, start: '[action]', end: '[/action]' }
  ];

  while (remaining.length > 0) {
    let foundTag = false;
    
    for (const tag of tags) {
      const startIdx = remaining.indexOf(tag.start);
      if (startIdx !== -1) {
        const endIdx = remaining.indexOf(tag.end, startIdx + tag.start.length);
        if (endIdx !== -1) {
          // 添加标签前的内容
          if (startIdx > 0) {
            const beforeText = remaining.substring(0, startIdx);
            if (beforeText.trim()) {
              parts.push({ type: 'content', content: beforeText });
            }
          }
          
          // 添加标签内容
          const tagContent = remaining.substring(startIdx + tag.start.length, endIdx).trim();
          parts.push({ type: tag.type, content: tagContent });
          
          // 继续处理剩余内容
          remaining = remaining.substring(endIdx + tag.end.length);
          foundTag = true;
          break;
        }
      }
    }
    
    if (!foundTag) {
      // 没有找到标签，添加剩余内容
      if (remaining.trim()) {
        parts.push({ type: 'content', content: remaining });
      }
      break;
    }
  }

  return parts;
};

// 测试代码 - 在浏览器控制台运行时会显示
console.log('=== parseContent 函数验证 ===');

// 测试1
const test1 = parseContent('普通对话内容<|a|>这是动作内容</|a|>');
console.log('测试1结果:', test1);

// 测试2
const test2 = parseContent('开始对话<|a|>动作一</|a|>中间内容<|t|>思考内容</|t|>结束');
console.log('测试2结果:', test2);

// 测试3
const test3 = parseContent('转义后的标签 &lt;|a|&gt;这是转义的动作&lt;/|a|&gt;');
console.log('测试3结果:', test3);

console.log('=== 验证完成 ===');

export { parseContent };
