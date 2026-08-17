// 临时验证：remark-parse 如何解析 ``` 围栏输入
const { unified } = require('unified');
const remarkParse = require('remark-parse');
const remarkGfm = require('remark-gfm');

function walk(node, depth = 0) {
  const pad = '  '.repeat(depth);
  const line = `${pad}${node.type}`;
  const extra = [];
  if (node.lang) extra.push(`lang=${node.lang}`);
  if (node.value !== undefined) extra.push(`value=${JSON.stringify(node.value)}`);
  if (node.literal !== undefined) extra.push(`literal=${JSON.stringify(node.literal)}`);
  console.log(extra.length ? `${line} ${extra.join(' ')}` : line);
  for (const key of ['children', 'paragraph']) {
    const ch = node[key];
    if (Array.isArray(ch)) ch.forEach((c) => walk(c, depth + 1));
  }
}

const inputs = [
  ['单行围栏', '```'],
  ['围栏+空行', '```\n\n'],
  ['围栏围栏', '```\n```'],
  ['html围栏块', '```html\n```'],
  ['围栏+正文', '```\n正文'],
  ['正文+围栏', '正文\n```'],
  ['正文+围栏+空行', '正文\n```\n\n'],
  ['三条反引号带空格', '``` \n'],
];

for (const [name, src] of inputs) {
  const tree = unified().use(remarkParse).use(remarkGfm).parse(src);
  console.log(`===== ${name} (${JSON.stringify(src)}) =====`);
  walk(tree);
}
