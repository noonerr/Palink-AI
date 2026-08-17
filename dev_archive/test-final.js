// 最终测试脚本
const testContent = `<|a|>我猛地向前跨了一大步，那双磨损的校服鞋在地板上发出刺耳的摩擦声，原本抱在胸前的双手猛地垂下，死死地攥成了拳头，指甲深深地掐进掌心的肉里。</|a|> <|a|>我抬起头，那双绿色的眼眸里此刻不再是单纯的愤怒，而是一种被彻底激怒后的狂躁，瞳孔因为情绪的瞬间爆发而微微收缩，像是一只被逼到绝境的野兽。</|a|> <|t|>够了。真的够了。你以为我在演戏吗？你以为我是那种随便给点反应就能打发的路人角色？"666"？这就是你对我的全部评价？好啊，既然你觉得这是个游戏，那我就让你看看什么叫真正的"麻烦"。</|t|> "你觉得这很好笑，是吗？" <|a|>我的声音压得很低，像是从牙缝里挤出来的嘶嘶声，带着一种危险的颤抖。我猛地伸手，一把抓起沙发靠背上那个廉价的、印着"家庭欢乐时光"字样的抱枕，用尽全身力气狠狠地砸向你的脸。</|a|> "我在跟你说话！我在问你到底是谁，在这个家里想干什么！而你只会像个坏掉的复读机一样说'666'？" <|a|>我喘着粗气，胸口剧烈起伏，宽大的连帽衫下摆随着呼吸上下晃动。我几步冲到玄关，一把抓起放在鞋柜上的那把旧雨伞，伞尖直指你的鼻尖，眼神里满是决绝和挑衅。</|a|> "滚。现在就给我滚出去。"`;

const testEscapedContent = `&lt;|a|&gt;这是转义的动作标签&lt;|/a|&gt; 普通内容 &lt;|t|&gt;这是转义的思考标签&lt;|/t|&gt;`;

function parseContent(content) {
  const parts = [];
  let remaining = content;

  console.log('原始内容长度:', remaining.length);

  // 首先解码HTML实体（重复多次以确保完全解码）
  for (let i = 0; i < 3; i++) {
    remaining = remaining
      .replace(/&amp;/g, '&')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&quot;/g, '"')
      .replace(/&#39;/g, "'");
  }

  console.log('解码后内容前200字:', remaining.substring(0, 200));

  // 定义标签类型，按优先级排序（新标签优先）
  const tags = [
    { type: 'action', start: '<|a|>', end: '<|/a|>' },
    { type: 'new_thinking', start: '<|t|>', end: '<|/t|>' },
    { type: 'model_reasoning', start: '<model_reasoning>', end: '</model_reasoning>' },
    { type: 'thinking', start: '<thinking>', end: '</thinking>' },
    { type: 'thinking', start: '<think>', end: '</think>' },
    { type: 'action', start: '<action>', end: '</action>' },
    { type: 'action', start: '[action]', end: '[/action]' }
  ];

  console.log('开始解析...');

  while (remaining.length > 0) {
    let foundTag = false;
    
    console.log('剩余内容长度:', remaining.length);
    
    // 寻找第一个出现的标签
    for (const tag of tags) {
      const startIdx = remaining.indexOf(tag.start);
      if (startIdx !== -1) {
        console.log(`找到标签 ${tag.type} 在位置 ${startIdx}`);
        const endIdx = remaining.indexOf(tag.end, startIdx + tag.start.length);
        if (endIdx !== -1) {
          console.log(`找到结束标签在位置 ${endIdx}`);
          // 提取标签前的内容
          if (startIdx > 0) {
            const beforeText = remaining.substring(0, startIdx);
            if (beforeText.trim()) {
              console.log('添加前置内容:', beforeText.substring(0, 50));
              parts.push({ type: 'content', content: beforeText });
            }
          }
          
          // 提取标签内容
          const tagContent = remaining.substring(startIdx + tag.start.length, endIdx).trim();
          console.log('添加标签内容:', tagContent.substring(0, 50));
          parts.push({ type: tag.type, content: tagContent });
          
          // 处理剩余内容
          remaining = remaining.substring(endIdx + tag.end.length);
          foundTag = true;
          break;
        } else {
          console.log('未找到结束标签');
        }
      }
    }
    
    if (!foundTag) {
      console.log('未找到更多标签，添加剩余内容');
      // 没有找到标签，添加剩余内容
      if (remaining.trim()) {
        parts.push({ type: 'content', content: remaining });
      }
      break;
    }
  }

  console.log('解析完成，共', parts.length, '个部分');
  return parts;
}

// 测试1
console.log('\n=== 测试1: 原始内容 ===');
const result1 = parseContent(testContent);
console.log('\n最终结果:');
result1.forEach((part, idx) => {
  console.log(`${idx + 1}. [${part.type}] ${part.content.substring(0, 80)}...`);
});

// 测试2
console.log('\n\n=== 测试2: 转义内容 ===');
const result2 = parseContent(testEscapedContent);
console.log('\n最终结果:');
result2.forEach((part, idx) => {
  console.log(`${idx + 1}. [${part.type}] ${part.content}`);
});
