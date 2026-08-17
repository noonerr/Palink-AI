const createDOMPurify = require('dompurify');
const { JSDOM } = require('jsdom');
const window = new JSDOM('').window;
const DOMPurify = createDOMPurify(window);

const testHtml = '<style>.status-panel{background:linear-gradient(135deg,#1e3a8a,#3b82f6);color:#fff;padding:16px}.status-btn{background:#2563eb;color:#fff}</style><div class="status-panel">hello</div><button class="status-btn">btn</button>';

const res = DOMPurify.sanitize(testHtml, {
  ADD_TAGS: ['style','svg','path','circle','rect','line','polyline','polygon','g','defs','use','ellipse','text','tspan','marker','clipPath','linearGradient','radialGradient','stop','filter','feGaussianBlur','mask','pattern','image','symbol','foreignObject'],
  ADD_ATTR: ['style','class','id','data-*','role','aria-*','tabindex','viewBox','fill','stroke','stroke-width','stroke-linecap','stroke-linejoin','d','points','cx','cy','r','rx','ry','x','y','x1','y1','x2','y2','transform','offset','stop-color','stop-opacity','gradientUnits','preserveAspectRatio','xmlns','loading','decoding','referrerpolicy'],
  FORBID_TAGS: ['script','iframe','object','embed','base','form'],
});

console.log('HAS_STYLE_TAG:', res.indexOf('<style') >= 0);
console.log('RESULT:', res);