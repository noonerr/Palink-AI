function parseContent(content) {
  let processedContent = content;
  for (let i = 0; i < 3; i++) {
    processedContent = processedContent
      .replace(/&amp;/g, '&')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&quot;/g, '"')
      .replace(/&#39;/g, "'");
  }

  const allTags = [
    { type: 'action', start: '<|a|>', end: '</|a|>' },
    { type: 'thinking', start: '<|t|>', end: '</|t|>' },
    { type: 'action', start: '<|a|>', end: '<|/a|>' },
    { type: 'thinking', start: '<|t|>', end: '<|/t|>' },
    { type: 'modelReasoning', start: '<model_reasoning>', end: '</model_reasoning>' },
    { type: 'thinking', start: '<thinking>', end: '</thinking>' },
    { type: 'thinking', start: '<think>', end: '</think>' },
    { type: 'action', start: '<action>', end: '</action>' },
    { type: 'action', start: '[action]', end: '[/action]' }
  ];

  const parts = [];
  let remainingContent = processedContent;
  let actionIndex = 0;
  let textIndex = 0;

  while (remainingContent.length > 0) {
    let bestMatch = null;

    for (const tag of allTags) {
      const startIdx = remainingContent.indexOf(tag.start);
      if (startIdx !== -1) {
        const endIdx = remainingContent.indexOf(tag.end, startIdx + tag.start.length);
        if (endIdx !== -1) {
          if (!bestMatch || startIdx < bestMatch.startIdx) {
            bestMatch = { tag, startIdx, endIdx };
          }
        }
      }
    }

    if (bestMatch) {
      if (bestMatch.startIdx > 0) {
        const beforeText = remainingContent.substring(0, bestMatch.startIdx);
        if (beforeText.trim()) {
          parts.push({ type: 'text', content: beforeText, id: `text-${textIndex++}` });
        }
      }

      const tagContent = remainingContent.substring(
        bestMatch.startIdx + bestMatch.tag.start.length,
        bestMatch.endIdx
      ).trim();

      let partId;
      if (bestMatch.tag.type === 'action') {
        partId = `action-${actionIndex++}`;
      } else if (bestMatch.tag.type === 'modelReasoning') {
        partId = 'modelReasoning';
      } else {
        partId = 'thinking';
      }

      parts.push({ 
        type: bestMatch.tag.type, 
        content: tagContent, 
        id: partId 
      });

      remainingContent = remainingContent.substring(bestMatch.endIdx + bestMatch.tag.end.length);
    } else {
      if (remainingContent.trim()) {
        parts.push({ type: 'text', content: remainingContent, id: `text-${textIndex++}` });
      }
      break;
    }
  }

  return parts;
}

const testContent1 = '今天天气真好<|a|>佩奇打了你一下</|a|><|t|>真疼</|t|><|a|>佩奇又打了你一下</|a|>';
const testContent2 = '<|t|>思考内容</|t|>对话内容<|a|>动作1</|a|>更多对话<|a|>动作2</|a|>';

console.log('测试1:');
console.log('输入:', testContent1);
console.log('解析结果:', parseContent(testContent1));
console.log('\n测试2:');
console.log('输入:', testContent2);
console.log('解析结果:', parseContent(testContent2));
