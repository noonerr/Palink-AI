
// 完整的测试脚本，测试parseContent函数的所有功能
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

// 测试用例
const testCases = [
  {
    name: '测试1: 简单的<|a|>标签',
    input: '普通对话内容<|a|>这是动作内容</|a|>',
    expected: [
      { type: 'content', content: '普通对话内容' },
      { type: 'action', content: '这是动作内容' }
    ]
  },
  {
    name: '测试2: <|a|>和<|t|>标签混合',
    input: '开始对话<|a|>动作一</|a|>中间内容<|t|>思考内容</|t|>结束',
    expected: [
      { type: 'content', content: '开始对话' },
      { type: 'action', content: '动作一' },
      { type: 'content', content: '中间内容' },
      { type: 'new_thinking', content: '思考内容' },
      { type: 'content', content: '结束' }
    ]
  },
  {
    name: '测试3: HTML实体转义的标签',
    input: '转义后的标签 &lt;|a|&gt;这是转义的动作&lt;/|a|&gt;',
    expected: [
      { type: 'content', content: '转义后的标签 ' },
      { type: 'action', content: '这是转义的动作' }
    ]
  },
  {
    name: '测试4: 用户实际遇到的复杂例子',
    input: '<|a|>我猛地向前跨了一大步，那双磨损的校服鞋在地板上发出刺耳的摩擦声，原本抱在胸前的双手猛地垂下，死死地攥成了拳头，指甲深深地掐进掌心的肉里。</|a|> <|a|>我抬起头，那双绿色的眼眸里此刻不再是单纯的愤怒，而是一种被彻底激怒后的狂躁，瞳孔因为情绪的瞬间爆发而微微收缩，像是一只被逼到绝境的野兽。</|a|> <|t|>够了。真的够了。你以为我在演戏吗？你以为我是那种随便给点反应就能打发的路人角色？"666"？这就是你对我的全部评价？好啊，既然你觉得这是个游戏，那我就让你看看什么叫真正的"麻烦"。</|t|> "你觉得这很好笑，是吗？" <|a|>我的声音压得很低，像是从牙缝里挤出来的嘶嘶声，带着一种危险的颤抖。我猛地伸手，一把抓起沙发靠背上那个廉价的、印着"家庭欢乐时光"字样的抱枕，用尽全身力气狠狠地砸向你的脸。</|a|> "我在跟你说话！我在问你到底是谁，在这个家里想干什么！而你只会像个坏掉的复读机一样说\'666\'？" <|a|>我喘着粗气，胸口剧烈起伏，宽大的连帽衫下摆随着呼吸上下晃动。我几步冲到玄关，一把抓起放在鞋柜上的那把旧雨伞，伞尖直指你的鼻尖，眼神里满是决绝和挑衅。</|a|> "滚。现在就给我滚出去。"',
    expected: null // 只验证解析，不验证完整结构
  },
  {
    name: '测试5: 旧标签兼容性',
    input: '<thinking>旧思考</thinking> <action>旧动作</action> [action]方括号动作[/action]',
    expected: [
      { type: 'thinking', content: '旧思考' },
      { type: 'content', content: ' ' },
      { type: 'action', content: '旧动作' },
      { type: 'content', content: ' ' },
      { type: 'action', content: '方括号动作' }
    ]
  }
];

// 运行测试
console.log('开始测试 parseContent 函数...\n');
let allPassed = true;

testCases.forEach((test, index) => {
  console.log(`=== ${test.name} ===`);
  const result = parseContent(test.input);
  
  if (test.expected === null) {
    console.log('解析结果:');
    result.forEach((part, i) => {
      console.log(`  [${i}] type: ${part.type}, content: "${part.content.substring(0, 50)}${part.content.length > 50 ? '...' : ''}"`);
    });
    console.log('✅ 解析成功（无预期结果）\n');
  } else {
    const passed = JSON.stringify(result) === JSON.stringify(test.expected);
    if (passed) {
      console.log('✅ 测试通过！');
    } else {
      console.log('❌ 测试失败！');
      console.log('  预期:', test.expected);
      console.log('  实际:', result);
      allPassed = false;
    }
    console.log();
  }
});

console.log('\n测试总结:', allPassed ? '✅ 所有测试通过！' : '❌ 部分测试失败！');
