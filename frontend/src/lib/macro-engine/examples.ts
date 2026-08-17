/**
 * 宏引擎使用示例
 */

import { 
  initRegisterMacros, 
  evaluateMacros, 
  MacroEngine,
  MacroRegistry,
  type MacroEnv 
} from './index';

// 初始化宏引擎（只需调用一次）
initRegisterMacros();

// ========== 基本使用 ==========

// 简单替换
const result1 = evaluateMacros('你好，{{user}}！我是 {{char}}。', {
  names: { user: '小明', char: '艾莉丝', group: '', groupNotMuted: '', notChar: '小明' },
});
console.log(result1); // "你好，小明！我是 艾莉丝。"

// 时间宏
const result2 = evaluateMacros('现在是 {{time}}，日期是 {{isodate}}');
console.log(result2); // "现在是 14:30，日期是 2026-06-12"

// 随机宏
const result3 = evaluateMacros('{{random::苹果::香蕉::橘子}}');
console.log(result3); // 随机输出其中一个

// 骰子宏
const result4 = evaluateMacros('你掷出了 {{roll::2d6}} 点！');
console.log(result4); // "你掷出了 7 点！"

// ========== 条件分支 ==========

const result5 = evaluateMacros('{{if::true::条件为真{{else}}条件为假}}');
console.log(result5); // "条件为真"

// ========== 角色卡字段 ==========

const result6 = evaluateMacros('{{charDescription}}', {
  character: {
    description: '一个活泼开朗的女孩，喜欢冒险。',
  },
});
console.log(result6); // "一个活泼开朗的女孩，喜欢冒险。"

// ========== 注册自定义宏 ==========

MacroRegistry.registerMacro('greeting', {
  category: 'custom',
  unnamedArgs: [{
    name: 'name',
    optional: false,
    description: 'Name to greet',
  }],
  description: 'Custom greeting macro',
  handler: (ctx) => {
    const name = ctx.unnamedArgs[0] ?? 'World';
    return `Hello, ${name}! Welcome to Palink-AI!`;
  },
});

const result7 = evaluateMacros('{{greeting::小明}}');
console.log(result7); // "Hello, 小明! Welcome to Palink-AI!"

// ========== 动态宏 ==========

const result8 = evaluateMacros('当前计数：{{counter}}', {
  dynamicMacros: {
    counter: '42',
  },
});
console.log(result8); // "当前计数：42"

// ========== 嵌套宏 ==========

const result9 = evaluateMacros('{{random::{{user}}的{{char}}}}', {
  names: { user: '小明', char: '宠物', group: '', groupNotMuted: '', notChar: '小明' },
});
console.log(result9); // "小明的宠物"

console.log('\nAll examples completed!');
