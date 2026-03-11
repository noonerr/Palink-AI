
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

console.log('========================================');
console.log('测试 parseContent 函数');
console.log('========================================\n');

// 测试1: 简单的<|a|>标签
console.log('测试1: 简单的<|a|>标签');
const test1 = parseContent('普通对话内容<|a|>这是动作内容</|a|>');
console.log('输入: 普通对话内容<|a|>这是动作内容</|a|>');
console.log('结果:', test1);
console.log();

// 测试2: <|a|>和<|t|>标签混合
console.log('测试2: <|a|>和<|t|>标签混合');
const test2 = parseContent('开始对话<|a|>动作一</|a|>中间内容<|t|>思考内容</|t|>结束');
console.log('输入: 开始对话<|a|>动作一</|a|>中间内容<|t|>思考内容</|t|>结束');
console.log('结果:', test2);
console.log();

// 测试3: HTML实体转义的标签
console.log('测试3: HTML实体转义的标签');
const test3 = parseContent('转义后的标签 &lt;|a|&gt;这是转义的动作&lt;/|a|&gt;');
console.log('输入: 转义后的标签 &lt;|a|&gt;这是转义的动作&lt;/|a|&gt;');
console.log('结果:', test3);
console.log();

// 测试4: 用户实际例子
console.log('测试4: 用户实际例子（简化版）');
const test4Input = '<|a|>我猛地向前跨了一大步</|a|> "你觉得这很好笑，是吗？" <|t|>够了。真的够了。</|t|>';
const test4 = parseContent(test4Input);
console.log('输入:', test4Input);
console.log('结果:');
test4.forEach((part, i) => {
  console.log(`  [${i}] type: ${part.type}, content: "${part.content}"`);
});
console.log();

console.log('========================================');
console.log('所有测试完成！');
console.log('========================================');
