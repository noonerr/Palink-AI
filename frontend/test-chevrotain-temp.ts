/**
 * 临时测试脚本：验证 Chevrotain 宏解析器
 * 测试完成后将删除
 */

import { MacroLexer } from './src/lib/macro-engine/lexer';
import { MacroParser } from './src/lib/macro-engine/parser';

function testLexing(input: string): void {
  console.log(`\n=== 词法分析: ${input} ===`);
  const result = MacroLexer.instance.tokenize(input);
  if (result.errors.length > 0) {
    console.log('词法错误:', result.errors);
  }
  console.log('Tokens:');
  for (const token of result.tokens) {
    console.log(`  ${token.tokenType.name}: "${token.image}" [${token.startOffset}-${token.endOffset}]`);
  }
}

function testParsing(input: string): void {
  console.log(`\n=== 语法分析: ${input} ===`);
  const result = MacroParser.instance.parseDocument(input);
  if (result.errors.length > 0) {
    console.log('错误:', result.errors);
  } else {
    console.log('解析成功');
  }
  if (result.cst) {
    printCst(result.cst, 0);
  }
}

function printCst(node: any, depth: number): void {
  const indent = '  '.repeat(depth);
  if (node.name) {
    console.log(`${indent}${node.name}`);
    const children = node.children || {};
    for (const key of Object.keys(children)) {
      for (const child of children[key]) {
        if (child.tokenType) {
          console.log(`${indent}  ${key}: "${child.image}" [${child.startOffset}-${child.endOffset}]`);
        } else if (child.name) {
          console.log(`${indent}  ${key}:`);
          printCst(child, depth + 2);
        }
      }
    }
  }
}

// 测试 1: 简单宏
testLexing('{{user}}');
testParsing('{{user}}');

// 测试 2: 带参数的宏
testLexing('{{random::苹果::香蕉}}');
testParsing('{{random::苹果::香蕉}}');

// 测试 3: 嵌套宏 - 关键测试
const nestedInput = '{{random::{{user}}的{{char}}}}';
testLexing(nestedInput);
testParsing(nestedInput);

// 测试 4: 变量简写
testLexing('{{.varName}}');
testParsing('{{.varName}}');

testLexing('{{$globalVar}}');
testParsing('{{$globalVar}}');

testLexing('{{.varName::=value}}');
testParsing('{{.varName::=value}}');

// 测试 5: 作用域块宏
testLexing('{{#if condition}}content{{/if}}');
testParsing('{{#if condition}}content{{/if}}');

// 测试 6: 注释宏
testLexing('{{// this is a comment}}');
testParsing('{{// this is a comment}}');

// 测试 7: 纯文本
testParsing('Hello world, no macros here.');

// 测试 8: 混合文本
testParsing('Hello {{user}}, welcome to {{char}}\'s world!');

console.log('\n=== 所有测试完成 ===');
