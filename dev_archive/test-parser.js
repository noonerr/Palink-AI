// 测试parseContent函数的脚本

const testContent = `<|a|>我猛地向前跨了一大步，那双磨损的校服鞋在地板上发出刺耳的摩擦声，原本抱在胸前的双手猛地垂下，死死地攥成了拳头，指甲深深地掐进掌心的肉里。</|a|> <|a|>我抬起头，那双绿色的眼眸里此刻不再是单纯的愤怒，而是一种被彻底激怒后的狂躁，瞳孔因为情绪的瞬间爆发而微微收缩，像是一只被逼到绝境的野兽。</|a|> <|t|>够了。真的够了。你以为我在演戏吗？你以为我是那种随便给点反应就能打发的路人角色？"666"？这就是你对我的全部评价？好啊，既然你觉得这是个游戏，那我就让你看看什么叫真正的"麻烦"。</|t|> "你觉得这很好笑，是吗？" <|a|>我的声音压得很低，像是从牙缝里挤出来的嘶嘶声，带着一种危险的颤抖。我猛地伸手，一把抓起沙发靠背上那个廉价的、印着"家庭欢乐时光"字样的抱枕，用尽全身力气狠狠地砸向你的脸。</|a|> "我在跟你说话！我在问你到底是谁，在这个家里想干什么！而你只会像个坏掉的复读机一样说'666'？" <|a|>我喘着粗气，胸口剧烈起伏，宽大的连帽衫下摆随着呼吸上下晃动。我几步冲到玄关，一把抓起放在鞋柜上的那把旧雨伞，伞尖直指你的鼻尖，眼神里满是决绝和挑衅。</|a|> "滚。现在就给我滚出去。"`;

// 复制新的parseContent函数
function parseContent(content) {
    const parts = [];
    let remaining = content;

    // 首先解码HTML实体（重复多次以确保完全解码）
    for (let i = 0; i < 3; i++) {
        remaining = remaining
            .replace(/&amp;/g, '&')
            .replace(/&lt;/g, '<')
            .replace(/&gt;/g, '>')
            .replace(/&quot;/g, '"')
            .replace(/&#39;/g, "'");
    }

    // 使用正则表达式直接匹配标签，更可靠
    // 定义标签匹配规则
    const tagPatterns = [
        { type: 'model_reasoning', pattern: /<model_reasoning>([\s\S]*?)<\/model_reasoning>/g },
        { type: 'thinking', pattern: /<thinking>([\s\S]*?)<\/thinking>/g },
        { type: 'thinking', pattern: /<think>([\s\S]*?)<\/think>/g },
        { type: 'action', pattern: /<action>([\s\S]*?)<\/action>/g },
        { type: 'action', pattern: /\[action\]([\s\S]*?)\[\/action\]/g },
        { type: 'action', pattern: /<\|a\|>([\s\S]*?)<\|\/a\|>/g },
        { type: 'new_thinking', pattern: /<\|t\|>([\s\S]*?)<\|\/t\|>/g }
    ];

    let matches = [];

    // 收集所有匹配的标签
    for (const { type, pattern } of tagPatterns) {
        let match;
        pattern.lastIndex = 0;
        while ((match = pattern.exec(remaining)) !== null) {
            matches.push({
                type,
                start: match.index,
                end: match.index + match[0].length,
                content: match[1].trim()
            });
        }
    }

    // 按开始位置排序
    matches.sort((a, b) => a.start - b.start);

    // 构建内容部分
    let currentPos = 0;
    for (const match of matches) {
        // 检查这个匹配是否与前面的重叠
        if (match.start < currentPos) {
            continue;
        }
        
        // 添加标签前的内容
        if (match.start > currentPos) {
            const textBefore = remaining.substring(currentPos, match.start);
            if (textBefore.trim()) {
                parts.push({ type: 'content', content: textBefore });
            }
        }
        
        // 添加标签内容
        parts.push({ type: match.type, content: match.content });
        
        currentPos = match.end;
    }

    // 添加最后的内容
    if (currentPos < remaining.length) {
        const textAfter = remaining.substring(currentPos);
        if (textAfter.trim()) {
            parts.push({ type: 'content', content: textAfter });
        }
    }

    // 如果没有找到任何标签，把整个内容作为content
    if (parts.length === 0 && remaining.trim()) {
        parts.push({ type: 'content', content: remaining });
    }

    return parts;
}

// 测试解析
console.log('=== 开始测试 ===');
console.log('输入内容:');
console.log(testContent);
console.log('\n=== 解析结果 ===');
const result = parseContent(testContent);
console.log('解析到的部分数量:', result.length);
result.forEach((part, index) => {
    console.log(`\n部分 ${index + 1}:`);
    console.log(`  类型: ${part.type}`);
    console.log(`  内容: ${part.content.substring(0, 100)}...`);
});

console.log('\n=== 测试完成 ===');
