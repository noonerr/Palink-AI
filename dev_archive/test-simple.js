
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
    { type: 'new_thinking', start: '<|t|>', end: '</|t|>' }
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

console.log('Test 1: Simple <|a|> tag');
const result1 = parseContent('Hello <|a|>this is action</|a|> world');
console.log(result1);

console.log('\nTest 2: Mixed tags');
const result2 = parseContent('Start <|a|>action 1</|a|> middle <|t|>thinking</|t|> end');
console.log(result2);

console.log('\nTest 3: Escaped tags');
const result3 = parseContent('Escaped &lt;|a|&gt;action&lt;/|a|&gt; tags');
console.log(result3);
