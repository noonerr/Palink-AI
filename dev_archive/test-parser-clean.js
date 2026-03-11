
// 干净的测试脚本
const parseContent = (content) => {
  const parts = [];
  let remaining = content;

  for (let i = 0; i < 3; i++) {
    remaining = remaining
      .replace(/&amp;/g, '&')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&quot;/g, '"')
      .replace(/&#39;/g, "'");
  }

  const tags = [
    { type: 'action', start: '<|a|>', end: '</|a|>' },
    { type: 'new_thinking', start: '<|t|>', end: '</|t|>' },
    { type: 'model_reasoning', start: '<model_reasoning>', end: '</model_reasoning>' },
    { type: 'thinking', start: '<thinking>', end: '</thinking>' },
    { type: 'thinking', start: '<think>', end: '</think>' },
    { type: 'action', start: '<action>', end: '</action>' },
    { type: 'action', start: '[action]', end: '[/action]' }
  ];

  while (remaining.length > 0) {
    let foundTag = false;
    
    for (const tag of tags) {
      const startIdx = remaining.indexOf(tag.start);
      if (startIdx !== -1) {
        const endIdx = remaining.indexOf(tag.end, startIdx + tag.start.length);
        if (endIdx !== -1) {
          if (startIdx > 0) {
            const beforeText = remaining.substring(0, startIdx);
            if (beforeText.trim()) {
              parts.push({ type: 'content', content: beforeText });
            }
          }
          
          const tagContent = remaining.substring(startIdx + tag.start.length, endIdx).trim();
          parts.push({ type: tag.type, content: tagContent });
          
          remaining = remaining.substring(endIdx + tag.end.length);
          foundTag = true;
          break;
        }
      }
    }
    
    if (!foundTag) {
      if (remaining.trim()) {
        parts.push({ type: 'content', content: remaining });
      }
      break;
    }
  }

  return parts;
};

// 简单测试
console.log('=== 测试1: 简单的<|a|>标签 ===');
const test1 = parseContent('普通对话内容<|a|>这是动作内容</|a|>');
console.log('结果:', test1);

console.log('\n=== 测试2: <|a|>和<|t|>标签混合 ===');
const test2 = parseContent('开始<|a|>动作</|a|>中间<|t|>思考</|t|>结束');
console.log('结果:', test2);

console.log('\n=== 测试3: 转义标签 ===');
const test3 = parseContent('转义标签 &lt;|a|&gt;动作&lt;/|a|&gt;');
console.log('结果:', test3);
