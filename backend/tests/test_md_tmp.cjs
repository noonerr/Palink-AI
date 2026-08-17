// 临时验证：ReactMarkdown 渲染哪些输入会产生 ``` 文本 + 空 <p></p>
const { renderToStaticMarkup } = require('react-dom/server');
const React = require('react');
const ReactMarkdown = require('react-markdown');
const remarkGfm = require('remark-gfm');

const inputs = [
  ['单行围栏', '```'],
  ['围栏+空行', '```\n\n'],
  ['空围栏块', '```\n```'],
  ['围栏包空', '```\n\n```'],
  ['html围栏块', '```html\n```'],
  ['围栏+正文', '```\n正文'],
  ['正文+围栏', '正文\n```'],
  ['正文+围栏+空行', '正文\n```\n\n'],
  ['正文空行围栏', '正文\n\n```\n\n'],
];

for (const [name, src] of inputs) {
  try {
    const html = renderToStaticMarkup(
      React.createElement(ReactMarkdown, { remarkPlugins: [remarkGfm] }, src)
    );
    console.log(`== ${name} (${JSON.stringify(src)}) => ${html}`);
  } catch (e) {
    console.log(`== ${name} ERROR: ${e.message}`);
  }
}
