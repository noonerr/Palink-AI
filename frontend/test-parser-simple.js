function parseContent(content) {
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

  const allTags = [
    { type: 'action', start: '<|a|>', end: '</|a|>' },
    { type: 'new_thinking', start: '<|t|>', end: '</|t|>' },
    { type: 'action', start: '<|a|>', end: '<|/a|>' },
    { type: 'new_thinking', start: '<|t|>', end: '<|/t|>' },
    { type: 'model_reasoning', start: '<model_reasoning>', end: '</model_reasoning>' },
    { type: 'thinking', start: '<thinking>', end: '</thinking>' },
    { type: 'thinking', start: '<think>', end: '</think>' },
    { type: 'action', start: '<action>', end: '</action>' },
    { type: 'action', start: '[action]', end: '[/action]' }
  ];

  while (remaining.length > 0) {
    let bestMatch = null;

    for (const tag of allTags) {
      const startIdx = remaining.indexOf(tag.start);
      if (startIdx !== -1) {
        const endIdx = remaining.indexOf(tag.end, startIdx + tag.start.length);
        if (endIdx !== -1) {
          if (!bestMatch || startIdx < bestMatch.startIdx) {
            bestMatch = { tag, startIdx, endIdx };
          }
        }
      }
    }

    if (bestMatch) {
      if (bestMatch.startIdx > 0) {
        const beforeText = remaining.substring(0, bestMatch.startIdx);
        if (beforeText.trim()) {
          parts.push({ type: 'content', content: beforeText });
        }
      }

      const tagContent = remaining.substring(
        bestMatch.startIdx + bestMatch.tag.start.length,
        bestMatch.endIdx
      ).trim();
      parts.push({ type: bestMatch.tag.type, content: tagContent });

      remaining = remaining.substring(bestMatch.endIdx + bestMatch.tag.end.length);
    } else {
      if (remaining.trim()) {
        parts.push({ type: 'content', content: remaining });
      }
      break;
    }
  }

  return parts;
}

const testContent = '<|t|>他在说什么？他也……爱我？别开玩笑了。这绝对是个陷阱。或者是某种新型的恶作剧？就像那些女生在更衣室里做的一样，先给你一点甜头，然后再把你推得更远。不可能有人爱我，尤其是当我表现得像个彻头彻尾的疯婆子之后。我刚刚才对他吼叫，才威胁要倒掉他的啤酒，才像个刺猬一样竖起所有的刺……他怎么敢？他怎么敢在这个时候说这种话？</|t|> “你……';

console.log('测试内容:');
console.log(testContent);
console.log('\n解析结果:');
console.log(parseContent(testContent));
