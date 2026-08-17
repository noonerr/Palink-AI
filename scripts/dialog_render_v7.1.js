/**
 * 对话渲染系统 v7.1 — 对话气泡管理脚本
 * 包含：头像管理（含角色主题色 + 情绪差分头像 + 角色卡隔离 + 网络图床 + CG 图片库）+ 正文美化设置 + 情绪配置 + 格式规则注入
 * 对话渲染由正则模板内的 JS 完成，本脚本负责管理面板 UI、配置写入和 prompt 动态注入
 * v6.0: 取消别名机制，改用角色全名作为唯一标识；世界书彻底清空，格式规则+情绪词由脚本动态注入
 * v7.0: 网络图床（头像 sourceUrl 懒加载）+ CG 图片库（按组管理 + 公开 API）+ 旁白三滑块 + 魔法棒修复 + 全局头像 + 图片压缩
 * 依赖：酒馆助手（JS-Slash-Runner）
 */

// ████████████████████████████████████████████████████████████
// █                                                        █
// █  Part 1: IndexedDB 存储层                               █
// █                                                        █
// ████████████████████████████████████████████████████████████

const DB_NAME = 'BubbleDialogueAvatars';
const DB_VERSION = 4;
const STORE_AVATARS = 'avatars';
const STORE_CONFIG = 'config';
const STORE_MOOD_AVATARS = 'mood_avatars';
const STORE_LOCAL_FONTS = 'local_fonts';
const STORE_CG_GROUPS = 'cg_groups';
const STORE_CG_IMAGES = 'cg_images';
const CHAR_ID_SEPARATOR = '__';
const GLOBAL_CHAR_ID = '_global_';
const CG_FETCH_TIMEOUT = 15000;
const IMAGE_EXTS_RE = /\.(webp|png|jpg|jpeg|gif|bmp|avif)$/i;
const LOCAL_FONT_MAX_SIZE = 8 * 1024 * 1024;
const LOCAL_FONT_ACCEPT = '.woff2,.woff,.ttf,.otf';
const FONT_EXT_FORMAT_MAP = {
  woff2: 'woff2', woff: 'woff', ttf: 'truetype', otf: 'opentype'
};
const FONT_EXT_MIME_MAP = {
  woff2: 'font/woff2', woff: 'font/woff', ttf: 'font/ttf', otf: 'font/opentype'
};

const MOOD_GROUPS = [
  { id: 'mood-joy',     label: '喜悦', color: '#f59e0b' },
  { id: 'mood-anger',   label: '愤怒', color: '#ef4444' },
  { id: 'mood-sad',     label: '悲伤', color: '#3b82f6' },
  { id: 'mood-anxious', label: '紧张', color: '#eab308' },
  { id: 'mood-calm',    label: '平和', color: '#22c55e' },
  { id: 'mood-shy',     label: '害羞', color: '#06b6d4' },
  { id: 'mood-disgust', label: '嫌弃', color: '#8b5cf6' },
  { id: 'mood-love',    label: '爱恋', color: '#ec4899' },
];

// ===== v6.0 默认情绪词配置（8 组 108 词） =====
const DEFAULT_MOOD_GROUPS = Object.freeze([
  { id: 'mood-joy',     label: '喜悦', color: '#f59e0b', words: ['开心','欢喜','欣喜','愉悦','满足','幸福','甜蜜','狂喜','兴奋','雀跃','畅快','陶醉','得意','骄傲','自豪','自信'] },
  { id: 'mood-anger',   label: '愤怒', color: '#ef4444', words: ['愤怒','暴怒','气愤','愤慨','暴躁','怨恨','敌意','恼火','窝火','生气','烦躁','烦闷'] },
  { id: 'mood-sad',     label: '悲伤', color: '#3b82f6', words: ['难过','伤心','心酸','忧伤','惆怅','失落','低落','沮丧','悲伤','心痛','悲痛','痛苦','委屈','不甘','失望','受伤','孤独','寂寞','落寞'] },
  { id: 'mood-anxious', label: '紧张', color: '#eab308', words: ['焦虑','紧张','不安','忐忑','担忧','慌张','焦躁','害怕','恐惧','惊恐','畏惧','胆怯','心慌','警惕','戒备'] },
  { id: 'mood-calm',    label: '平和', color: '#22c55e', words: ['平静','淡然','冷静','沉稳','从容','坦然','淡定','温馨','舒畅','惬意','温暖','欣慰','释然','感动','感恩'] },
  { id: 'mood-shy',     label: '害羞', color: '#06b6d4', words: ['害羞','尴尬','窘迫','难堪','困惑','迷茫','疑惑','纠结','犹豫','无奈','无语'] },
  { id: 'mood-disgust', label: '嫌弃', color: '#8b5cf6', words: ['厌恶','嫌弃','鄙视','反感','排斥','抗拒','不屑','冷淡','冷漠','疏离','麻木'] },
  { id: 'mood-love',    label: '爱恋', color: '#ec4899', words: ['喜欢','爱慕','迷恋','倾慕','宠溺','依恋','心动','认真'] },
]);

// ===== v7.0 默认格式规则（三段式） =====
const DEFAULT_FORMAT_RULE = `[对话渲染格式规范]
当角色产生想法、进行对白、突然的反应或者有莫名的声音、奇怪的低语出现时必须严格使用以下格式（全部在同一行内）：

@bubble:角色名|情绪|[对白]

格式规则：
1. @bubble: 是固定前缀，不可更改
2. 角色名、情绪、台词之间用 | 分隔，全部在一行内
3. 角色名必须输出完整全名，不允许省略（如"城崎诺亚"不能只写"诺亚"）
4. 角色名是头像关联的唯一标识，每次输出必须完全一致
5. 只有名没有姓的角色直接写名字（如"云儿"）
6. 台词必须用 [ ] 方括号包裹
7. 旁白和叙述文字正常书写，不加任何标记
8. 每次角色说话都必须带上 @bubble 标记，不可省略
9. 多个角色说话时，每个角色分别使用自己的角色名，包括系统声音
10. 角内心活动或心理描写也要使用此格式，写法为 @bubble:角色名|情绪|[*内心活动*]
11. 心里话只按 *...* 外层结构识别
12. 台词中不能包含 | 符号和 [ ] 符号
13. 情绪字段不能省略，必须填写
14. 如果场景内出现路人/同学/同事这类不重要的NPC，则使用@bubble:男/女路人X|情绪|[对白]/@bubble:男/女同学X|情绪|[对白]/@bubble:男/女同事X|情绪|[对白]
15. 如果场景内出现敌人，如果是怪物类型敌人，则使用@bubble:怪物名X|情绪|[对白]，例如：@bubble:夜魔A|生气|[你！]，如果是路人/同学/同事型敌人和14一样
16. 如果是不知道名字的角色或者角色名字在后文现在还没出现名字的角色，都用@bubble:？？？|情绪|[对白]或者@bubble:？？？|情绪|[*内心活动*]代替

[正文标签规则]
<content> 标签外面必须包一层 <now_plot> 标签。

[背景标签规则（强制）]
场景切换时，必须在 <content> 内的正文开头输出背景标签：
- 格式: <background scene="场景名" />
- 场景名必须从Galgame插件配置的可用场景列表中选取
- 每次场景发生变化时都必须输出，不可省略
- 不需要每段都写，仅在场景切换时输出一次

输出结构：
<now_plot>
<content>
（正文内容）
</content>
</now_plot>

示例：
<now_plot>
<content>
诺亚傻站着愣了半秒，忽闪着大眼睛直勾勾盯着我。

@bubble:城崎诺亚|欣喜|[咦？真的吗？]

@bubble:城崎诺亚|紧张|[*（我真的能做好吗？）*]

她似乎在脑海里搜索着相关的经验，过了一会儿，她居然真的点了点头。

@bubble:城崎诺亚|开心|[听起来好像挺简单的。那诺亚试试看好了！]

樱在旁边叹了口气，看起来并不想掺和这件事。

@bubble:樱|无奈|[别把我拉进去啊。]

@bubble:？？？|兴奋|[喂！你们！]

@bubble:男同学A|慌张|[是……是清野同学，我们该撤了]

@bubble:男同学B|紧张|[对，你们先聊，我们走了]

那两个同学飞快的跑了，几人看到清野飞快的跑了过来

@bubble:清野|兴奋|[刚刚你们在这边干什么呢！]

</content>
</now_plot>`;

// ===== v7.0 默认情绪词提示词模板 =====
// 模板中 {{mood_groups}} 会在注入时被替换为实际的情绪词分组列表
const DEFAULT_MOOD_PROMPT_TEMPLATE = `[情绪词约束]
对话格式中情绪字段必须从以下固定池中选取（2-3字词），禁止自造新词：
{{mood_groups}}
情绪字段不能省略，必须填写。`;

function getCurrentContext() {
  function tryGetContext(target) {
    try {
      if (target && target.SillyTavern && typeof target.SillyTavern.getContext === 'function') {
        return target.SillyTavern.getContext();
      }
    } catch (e) {}
    return null;
  }

  try {
    const localContext = tryGetContext(window);
    if (localContext) return localContext;
    if (window.parent && window.parent !== window) {
      const parentContext = tryGetContext(window.parent);
      if (parentContext) return parentContext;
    }
  } catch (e) {}
  return null;
}

function getCurrentCharId() {
  function tryGetChid(target) {
    try {
      if (target && typeof target.this_chid !== 'undefined' && target.this_chid !== null) {
        return target.this_chid;
      }
    } catch (e) {}
    return undefined;
  }

  try {
    const context = getCurrentContext();
    let chid = context?.characterId ?? tryGetChid(window);
    if (chid == null && window.parent && window.parent !== window) {
      chid = tryGetChid(window.parent);
    }
    return chid != null ? String(chid) : '';
  } catch (e) {
    return '';
  }
}

function getCurrentCharName() {
  try {
    const context = getCurrentContext();
    return context?.name2 || '未知角色卡';
  } catch (e) {
    return '未知角色卡';
  }
}

function buildAvatarKey(charId, name) {
  const safeCharId = String(charId || GLOBAL_CHAR_ID);
  const safeName = name.trim().toLowerCase();
  return safeCharId + CHAR_ID_SEPARATOR + safeName;
}

function buildMoodAvatarKey(charId, name, moodId) {
  const safeCharId = String(charId || GLOBAL_CHAR_ID);
  const safeName = name.trim().toLowerCase();
  return safeCharId + CHAR_ID_SEPARATOR + safeName + CHAR_ID_SEPARATOR + moodId;
}

function buildColorConfigKey(charId, name) {
  const safeCharId = String(charId || GLOBAL_CHAR_ID);
  const safeName = name.trim().toLowerCase();
  return 'color_' + safeCharId + CHAR_ID_SEPARATOR + safeName;
}

function extractDisplayName(storedKey, charId) {
  // 有 charId 时精确切割
  if (charId != null) {
    const prefix = String(charId) + CHAR_ID_SEPARATOR;
    if (storedKey.startsWith(prefix)) return storedKey.slice(prefix.length);
  }
  // 尝试 _global_ 前缀
  const globalPrefix = GLOBAL_CHAR_ID + CHAR_ID_SEPARATOR;
  if (storedKey.startsWith(globalPrefix)) return storedKey.slice(globalPrefix.length);
  // 回退：数字型 charId 不含下划线，第一个 __ 就是分隔符
  const sepIndex = storedKey.indexOf(CHAR_ID_SEPARATOR);
  return sepIndex >= 0 ? storedKey.slice(sepIndex + CHAR_ID_SEPARATOR.length) : storedKey;
}

function escapeHtmlAttr(value) {
  return String(value == null ? '' : value)
    .replace(/&/g, '&amp;').replace(/"/g, '&quot;')
    .replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

const FONT_CACHE_PREFIX = 'bubbleDialogueFontCache:';
const FONT_FETCH_TIMEOUT_MS = 8000;
const STYLE_CACHE_KEY = 'bubbleDialogueStyleSnapshot';
const STYLE_DEFAULTS = {
  style_dialogueFontSize: 14.5,
  style_narrationFontSize: 14,
  style_dialogueSpacing: 10,
  style_textColorMode: 'global',
  style_globalTextColor: '#d9d9d9',
  style_markdownMode: 'basic',
  style_dialogueFontWeight: 400,
  style_narrationFontWeight: 400,
  style_nameFontWeight: 800,
  style_narrationBgColor: '#ffffff',
  style_narrationBgOpacity: 0.04,
  style_avatarSize: 52,
  style_narrationIndent: 76,
  style_narrationFontFamily: 'Noto Sans SC',
  style_dialogueFontFamily: 'Noto Serif SC',
  style_nameFontFamily: 'Noto Serif SC',
  style_fontConfigUrl: '',
  style_narrationBorderRadius: 0,
  style_avatarShape: 'rounded',
  style_thoughtSuffixGap: 6,
  style_thoughtSuffixOffsetY: 5,
  // v7.0
  style_narrationTextIndent: 0,
  style_narrationLineHeight: 1.75,
  style_narrationPaddingRight: 16,
  style_imageCompressEnabled: true,
  style_imageCompressQuality: 0.82,
};
const STYLE_CONFIG_KEYS = Object.freeze(Object.keys(STYLE_DEFAULTS));
const BUILTIN_FONT_OPTIONS = [
  { id: 'noto-sans-sc', name: 'Noto Sans SC', family: 'Noto Sans SC', type: 'builtin' },
  { id: 'source-han-sans-sc', name: 'Source Han Sans SC', family: 'Source Han Sans SC', type: 'builtin' },
  { id: 'noto-serif-sc', name: 'Noto Serif SC', family: 'Noto Serif SC', type: 'builtin' },
  { id: 'source-han-serif-sc', name: 'Source Han Serif SC', family: 'Source Han Serif SC', type: 'builtin' },
  { id: 'lxgw-wenkai', name: 'LXGW WenKai', family: 'LXGW WenKai', type: 'builtin' },
  { id: 'fira-code', name: 'Fira Code', family: 'Fira Code', type: 'builtin' }
];

// ===== ZIP 工具函数（store 模式，无压缩） =====
// 图片文件本身已是压缩格式（webp/jpeg/png），不需要 deflate 再压缩

const _zipCrc32Table = (() => {
  const table = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let j = 0; j < 8; j++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
    table[i] = c;
  }
  return table;
})();

function zipCrc32(buf) {
  const u8 = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
  let crc = 0xFFFFFFFF;
  for (let i = 0; i < u8.length; i++) crc = _zipCrc32Table[(crc ^ u8[i]) & 0xFF] ^ (crc >>> 8);
  return (crc ^ 0xFFFFFFFF) >>> 0;
}

/**
 * 将文件列表打包为 ZIP Blob（store 模式，无压缩）
 * @param {Array<{name: string, data: Uint8Array}>} files - 文件列表
 * @returns {Blob} ZIP 文件 Blob
 */
function zipCreate(files) {
  const encoder = new TextEncoder();
  const localHeaders = [];
  const centralHeaders = [];
  let offset = 0;

  for (const file of files) {
    const nameBytes = encoder.encode(file.name);
    const crc = zipCrc32(file.data);
    const size = file.data.length;

    // Local file header (30 + nameLen + data)
    const local = new ArrayBuffer(30 + nameBytes.length);
    const lv = new DataView(local);
    lv.setUint32(0, 0x04034B50, true);   // 签名
    lv.setUint16(4, 20, true);            // 版本
    lv.setUint16(6, 0, true);             // 标志
    lv.setUint16(8, 0, true);             // 压缩方法: store
    lv.setUint16(10, 0, true);            // 修改时间
    lv.setUint16(12, 0, true);            // 修改日期
    lv.setUint32(14, crc, true);          // CRC-32
    lv.setUint32(18, size, true);         // 压缩大小
    lv.setUint32(22, size, true);         // 原始大小
    lv.setUint16(26, nameBytes.length, true); // 文件名长度
    lv.setUint16(28, 0, true);            // 额外字段长度
    new Uint8Array(local, 30).set(nameBytes);
    localHeaders.push(new Uint8Array(local));

    // Central directory header (46 + nameLen)
    const central = new ArrayBuffer(46 + nameBytes.length);
    const cv = new DataView(central);
    cv.setUint32(0, 0x02014B50, true);    // 签名
    cv.setUint16(4, 20, true);            // 创建版本
    cv.setUint16(6, 20, true);            // 解压版本
    cv.setUint16(8, 0, true);             // 标志
    cv.setUint16(10, 0, true);            // 压缩方法: store
    cv.setUint16(12, 0, true);            // 修改时间
    cv.setUint16(14, 0, true);            // 修改日期
    cv.setUint32(16, crc, true);          // CRC-32
    cv.setUint32(20, size, true);         // 压缩大小
    cv.setUint32(24, size, true);         // 原始大小
    cv.setUint16(28, nameBytes.length, true); // 文件名长度
    cv.setUint16(30, 0, true);            // 额外字段长度
    cv.setUint16(32, 0, true);            // 文件注释长度
    cv.setUint16(34, 0, true);            // 磁盘编号
    cv.setUint16(36, 0, true);            // 内部属性
    cv.setUint32(38, 0, true);            // 外部属性
    cv.setUint32(42, offset, true);       // 本地头偏移
    new Uint8Array(central, 46).set(nameBytes);
    centralHeaders.push(new Uint8Array(central));

    offset += 30 + nameBytes.length + size;
  }

  // End of central directory (22 bytes)
  const centralDirOffset = offset;
  let centralDirSize = 0;
  for (const ch of centralHeaders) centralDirSize += ch.length;

  const eocd = new ArrayBuffer(22);
  const ev = new DataView(eocd);
  ev.setUint32(0, 0x06054B50, true);      // 签名
  ev.setUint16(4, 0, true);               // 磁盘编号
  ev.setUint16(6, 0, true);               // 中央目录磁盘
  ev.setUint16(8, files.length, true);     // 本磁盘条目数
  ev.setUint16(10, files.length, true);    // 总条目数
  ev.setUint32(12, centralDirSize, true);  // 中央目录大小
  ev.setUint32(16, centralDirOffset, true);// 中央目录偏移
  ev.setUint16(20, 0, true);              // 注释长度

  // 组装最终 Blob
  const parts = [];
  for (let i = 0; i < files.length; i++) {
    parts.push(localHeaders[i]);
    parts.push(files[i].data);
  }
  for (const ch of centralHeaders) parts.push(ch);
  parts.push(new Uint8Array(eocd));

  return new Blob(parts, { type: 'application/zip' });
}

/**
 * 从 ZIP Blob 中逐文件提取（store 模式）
 * @param {ArrayBuffer} buffer - ZIP 文件的 ArrayBuffer
 * @returns {Map<string, Uint8Array>} 文件名 -> 文件数据的 Map
 */
function zipExtract(buffer) {
  const u8 = new Uint8Array(buffer);
  const dv = new DataView(buffer);
  const decoder = new TextDecoder();
  const files = new Map();

  // 从末尾查找 EOCD 签名
  let eocdOffset = -1;
  for (let i = u8.length - 22; i >= 0; i--) {
    if (dv.getUint32(i, true) === 0x06054B50) { eocdOffset = i; break; }
  }
  if (eocdOffset < 0) throw new Error('无效的 ZIP 文件：找不到 EOCD 签名');

  const entryCount = dv.getUint16(eocdOffset + 10, true);
  let cdOffset = dv.getUint32(eocdOffset + 16, true);

  for (let i = 0; i < entryCount; i++) {
    if (dv.getUint32(cdOffset, true) !== 0x02014B50) throw new Error('ZIP 中央目录损坏');
    const method = dv.getUint16(cdOffset + 10, true);
    const crc = dv.getUint32(cdOffset + 16, true);
    const compSize = dv.getUint32(cdOffset + 20, true);
    const nameLen = dv.getUint16(cdOffset + 28, true);
    const extraLen = dv.getUint16(cdOffset + 30, true);
    const commentLen = dv.getUint16(cdOffset + 32, true);
    const localOffset = dv.getUint32(cdOffset + 42, true);
    const name = decoder.decode(u8.subarray(cdOffset + 46, cdOffset + 46 + nameLen));

    if (method !== 0) throw new Error(`ZIP 条目 "${name}" 使用了不支持的压缩方法 ${method}，仅支持 store 模式`);

    // 从 local header 中读取实际数据偏移
    const localNameLen = dv.getUint16(localOffset + 26, true);
    const localExtraLen = dv.getUint16(localOffset + 28, true);
    const dataOffset = localOffset + 30 + localNameLen + localExtraLen;
    const data = u8.slice(dataOffset, dataOffset + compSize);

    // CRC32 校验
    const actualCrc = zipCrc32(data);
    if (actualCrc !== crc) throw new Error(`ZIP 条目 "${name}" CRC32 校验失败（期望 ${crc}，实际 ${actualCrc}）`);

    files.set(name, data);
    cdOffset += 46 + nameLen + extraLen + commentLen;
  }

  return files;
}

/** mimeType 转文件扩展名 */
function mimeToExt(mime) {
  const map = { 'image/jpeg': '.jpg', 'image/png': '.png', 'image/webp': '.webp', 'image/gif': '.gif', 'image/bmp': '.bmp', 'image/avif': '.avif' };
  return map[mime] || '.bin';
}

/** 文件扩展名转 mimeType */
function extToMime(ext) {
  const map = { '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.webp': 'image/webp', '.gif': 'image/gif', '.bmp': 'image/bmp', '.avif': 'image/avif' };
  return map[ext.toLowerCase()] || 'image/webp';
}

/** 安全化文件名（去除路径分隔符和特殊字符） */
function safeFileName(name) {
  return (name || 'unnamed').replace(/[\/\\:*?"<>|]/g, '_').substring(0, 100);
}

function clampNumber(value, min, max) {
  if (!Number.isFinite(value)) return min;
  return Math.min(Math.max(value, min), max);
}

async function compressImage(blob, options = {}) {
  const {
    quality = STYLE_DEFAULTS.style_imageCompressQuality,
    skipBelowKB = 50,
    enabled = true
  } = options;
  if (!enabled) return blob;
  if (blob.size < skipBelowKB * 1024) return blob;
  if (blob.type === 'image/gif') return blob;
  try {
    const bitmap = await createImageBitmap(blob);
    const { width, height } = bitmap;
    const canvas = new OffscreenCanvas(width, height);
    const ctx = canvas.getContext('2d');
    ctx.drawImage(bitmap, 0, 0);
    bitmap.close();
    const compressed = await canvas.convertToBlob({ type: 'image/webp', quality });
    if (compressed.size >= blob.size) return blob;
    return compressed;
  } catch (e) {
    console.warn('[compressImage] 压缩失败，使用原图:', e);
    return blob;
  }
}

async function getCompressOptions(db) {
  try {
    const enabled = await db.getConfig('style_imageCompressEnabled', STYLE_DEFAULTS.style_imageCompressEnabled);
    const quality = await db.getConfig('style_imageCompressQuality', STYLE_DEFAULTS.style_imageCompressQuality);
    return { enabled: enabled !== false && enabled !== 'false', quality: Number(quality) || 0.82 };
  } catch (_) {
    return { enabled: true, quality: 0.82 };
  }
}

function hexToRgba(hex, opacity) {
  if (typeof hex !== 'string' || !/^#[0-9a-f]{6}$/i.test(hex)) {
    return `rgba(255,255,255,${clampNumber(opacity, 0, 1)})`;
  }
  const safeOpacity = clampNumber(opacity, 0, 1);
  const r = parseInt(hex.slice(1, 3), 16);
  const g = parseInt(hex.slice(3, 5), 16);
  const b = parseInt(hex.slice(5, 7), 16);
  return `rgba(${r},${g},${b},${safeOpacity})`;
}

function normalizeFontPayload(payload) {
  const fonts = Array.isArray(payload?.fonts) ? payload.fonts : [];
  return fonts
    .map((item, index) => {
      const family = typeof item?.family === 'string' ? item.family.trim() : '';
      const name = typeof item?.name === 'string' ? item.name.trim() : family;
      const url = typeof item?.url === 'string' ? item.url.trim() : '';
      const type = item?.type === 'file' ? 'file' : item?.type === 'css' ? 'css' : '';
      const format = typeof item?.format === 'string' ? item.format.trim() : '';
      const id = typeof item?.id === 'string' && item.id.trim() ? item.id.trim() : `remote-font-${index}`;
      if (!family || !name || !url || !type) return null;
      return { id, name, family, url, type, format };
    })
    .filter(Boolean);
}

function readStyleSnapshot() {
  try {
    const raw = localStorage.getItem(STYLE_CACHE_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch (_) {
    return {};
  }
}

function writeStyleSnapshot(settings, { replace = false } = {}) {
  try {
    const next = replace ? {} : readStyleSnapshot();
    STYLE_CONFIG_KEYS.forEach((key) => {
      if (Object.prototype.hasOwnProperty.call(settings, key)) next[key] = settings[key];
    });
    localStorage.setItem(STYLE_CACHE_KEY, JSON.stringify(next));
  } catch (_) {
    // ignore local cache errors
  }
}

function clearStyleSnapshot() {
  try {
    localStorage.removeItem(STYLE_CACHE_KEY);
  } catch (_) {
    // ignore local cache errors
  }
}

class AvatarDB {
  constructor() {
    this.db = null;
    this._blobUrlCache = new Map();
  }

  async init() {
    if (this.db) return this.db;
    return new Promise((resolve, reject) => {
      const request = indexedDB.open(DB_NAME, DB_VERSION);
      request.onupgradeneeded = (event) => {
        const db = event.target.result;
        const tx = event.target.transaction;
        if (!db.objectStoreNames.contains(STORE_AVATARS)) {
          const store = db.createObjectStore(STORE_AVATARS, { keyPath: 'alias' });
          store.createIndex('createdAt', 'createdAt', { unique: false });
        }
        if (!db.objectStoreNames.contains(STORE_CONFIG)) {
          db.createObjectStore(STORE_CONFIG, { keyPath: 'key' });
        }
        if (!db.objectStoreNames.contains(STORE_MOOD_AVATARS)) {
          const moodStore = db.createObjectStore(STORE_MOOD_AVATARS, { keyPath: 'id' });
          moodStore.createIndex('charId', 'charId', { unique: false });
          moodStore.createIndex('alias', 'alias', { unique: false });
          moodStore.createIndex('moodId', 'moodId', { unique: false });
        }
        if (!db.objectStoreNames.contains(STORE_LOCAL_FONTS)) {
          db.createObjectStore(STORE_LOCAL_FONTS, { keyPath: 'id' });
        }
        // v7.0: CG 图片库
        if (!db.objectStoreNames.contains(STORE_CG_GROUPS)) {
          db.createObjectStore(STORE_CG_GROUPS, { keyPath: 'id' });
        }
        if (!db.objectStoreNames.contains(STORE_CG_IMAGES)) {
          const cgImgStore = db.createObjectStore(STORE_CG_IMAGES, { keyPath: 'id' });
          cgImgStore.createIndex('group', 'group', { unique: false });
        }
        if (event.oldVersion < 2) {
          const avatarStore = tx.objectStore(STORE_AVATARS);
          const cursorReq = avatarStore.openCursor();
          const toDelete = [];
          const toAdd = [];
          cursorReq.onsuccess = (e) => {
            const cursor = e.target.result;
            if (cursor) {
              const record = cursor.value;
              if (!record.alias.includes(CHAR_ID_SEPARATOR)) {
                toDelete.push(record.alias);
                toAdd.push({ ...record, alias: GLOBAL_CHAR_ID + CHAR_ID_SEPARATOR + record.alias });
              }
              cursor.continue();
            } else {
              for (const key of toDelete) avatarStore.delete(key);
              for (const rec of toAdd) avatarStore.put(rec);
              const configStore = tx.objectStore(STORE_CONFIG);
              const cfgCursorReq = configStore.openCursor();
              const cfgToDelete = [];
              const cfgToAdd = [];
              cfgCursorReq.onsuccess = (ce) => {
                const cfgCursor = ce.target.result;
                if (cfgCursor) {
                  const cfgRecord = cfgCursor.value;
                  if (cfgRecord.key.startsWith('color_') && !cfgRecord.key.includes(CHAR_ID_SEPARATOR)) {
                    const rawAlias = cfgRecord.key.slice(6);
                    cfgToDelete.push(cfgRecord.key);
                    cfgToAdd.push({ ...cfgRecord, key: 'color_' + GLOBAL_CHAR_ID + CHAR_ID_SEPARATOR + rawAlias });
                  }
                  cfgCursor.continue();
                } else {
                  for (const key of cfgToDelete) configStore.delete(key);
                  for (const rec of cfgToAdd) configStore.put(rec);
                }
              };
            }
          };
        }
      };
      request.onsuccess = (event) => { this.db = event.target.result; resolve(this.db); };
      request.onerror = (event) => { reject(new Error(`IndexedDB 打开失败: ${event.target.error}`)); };
    });
  }

  async _ensureDB() { if (!this.db) await this.init(); }

  // -- 头像 CRUD --

  async add(charId, name, imageBlob, metadata = {}) {
    await this._ensureDB();
    const key = buildAvatarKey(charId, name);
    const existing = await this.get(charId, name);
    if (existing) throw new Error(`角色名 "${name}" 已存在，请使用 update() 或换一个角色名`);
    const record = {
      alias: key, imageBlob,
      sourceUrl: metadata.sourceUrl || null,
      mimeType: imageBlob ? (imageBlob.type || 'image/jpeg') : (metadata.mimeType || 'image/webp'),
      fileName: metadata.fileName || `${name.trim().toLowerCase()}.jpg`,
      fileSize: imageBlob ? imageBlob.size : 0,
      width: metadata.width || 0,
      height: metadata.height || 0,
      createdAt: Date.now(),
      updatedAt: Date.now()
    };
    return this._put(STORE_AVATARS, record);
  }

  async get(charId, name) {
    await this._ensureDB();
    const key = buildAvatarKey(charId, name);
    return this._getByKey(STORE_AVATARS, key);
  }

  async getBlobUrl(charId, name) {
    const key = buildAvatarKey(charId, name);
    if (this._blobUrlCache.has(key)) return this._blobUrlCache.get(key);
    const record = await this.get(charId, name);
    if (!record || !record.imageBlob) return null;
    const url = URL.createObjectURL(record.imageBlob);
    this._blobUrlCache.set(key, url);
    return url;
  }

  async update(charId, name, imageBlob, metadata = {}) {
    await this._ensureDB();
    const key = buildAvatarKey(charId, name);
    const existing = await this.get(charId, name);
    if (!existing) throw new Error(`角色名 "${name}" 不存在`);
    this._revokeCachedUrl(key);
    const record = {
      ...existing, imageBlob,
      sourceUrl: metadata.sourceUrl !== undefined ? metadata.sourceUrl : (existing.sourceUrl || null),
      mimeType: imageBlob.type || existing.mimeType,
      fileName: metadata.fileName || existing.fileName,
      fileSize: imageBlob.size,
      width: metadata.width || existing.width,
      height: metadata.height || existing.height,
      updatedAt: Date.now()
    };
    return this._put(STORE_AVATARS, record);
  }

  async rename(charId, oldName, newName) {
    await this._ensureDB();
    const oldKey = buildAvatarKey(charId, oldName);
    const newKey = buildAvatarKey(charId, newName);
    if (oldKey === newKey) return;
    if (await this.get(charId, newName)) throw new Error(`角色名 "${newName}" 已被占用`);
    const record = await this.get(charId, oldName);
    if (!record) throw new Error(`角色名 "${oldName}" 不存在`);
    this._revokeCachedUrl(oldKey);
    const newRecord = { ...record, alias: newKey, updatedAt: Date.now() };
    const tx = this.db.transaction(STORE_AVATARS, 'readwrite');
    const store = tx.objectStore(STORE_AVATARS);
    return new Promise((resolve, reject) => {
      const del = store.delete(oldKey);
      del.onsuccess = () => {
        const add = store.put(newRecord);
        add.onsuccess = () => resolve();
        add.onerror = () => reject(new Error(`重命名写入失败`));
      };
      del.onerror = () => reject(new Error(`重命名删除失败`));
    });
  }

  async delete(charId, name) {
    await this._ensureDB();
    const key = buildAvatarKey(charId, name);
    this._revokeCachedUrl(key);
    return new Promise((resolve, reject) => {
      const tx = this.db.transaction(STORE_AVATARS, 'readwrite');
      const req = tx.objectStore(STORE_AVATARS).delete(key);
      req.onsuccess = () => resolve();
      req.onerror = () => reject(new Error(`删除失败`));
    });
  }

  async list(charId) {
    await this._ensureDB();
    const safeCharId = String(charId || GLOBAL_CHAR_ID);
    const prefix = safeCharId + CHAR_ID_SEPARATOR;
    const range = IDBKeyRange.bound(prefix, prefix + '\uffff', false, false);
    return new Promise((resolve, reject) => {
      const req = this.db.transaction(STORE_AVATARS, 'readonly').objectStore(STORE_AVATARS).getAll(range);
      req.onsuccess = () => {
        resolve(req.result.map(r => ({
          alias: r.alias, displayName: extractDisplayName(r.alias, safeCharId),
          mimeType: r.mimeType, fileName: r.fileName,
          fileSize: r.fileSize, width: r.width, height: r.height,
          createdAt: r.createdAt, updatedAt: r.updatedAt
        })));
      };
      req.onerror = () => reject(new Error(`列表查询失败`));
    });
  }

  async getStats(charId) {
    await this._ensureDB();
    const prefix = String(charId || GLOBAL_CHAR_ID) + CHAR_ID_SEPARATOR;
    const range = IDBKeyRange.bound(prefix, prefix + '\uffff', false, false);
    return new Promise((resolve, reject) => {
      const req = this.db.transaction(STORE_AVATARS, 'readonly').objectStore(STORE_AVATARS).getAll(range);
      req.onsuccess = () => {
        const records = req.result;
        resolve({ count: records.length, totalSize: records.reduce((s, r) => s + (r.fileSize || 0), 0) });
      };
      req.onerror = () => reject(new Error(`统计查询失败`));
    });
  }

  // -- 情绪差分头像 CRUD --

  async addMoodAvatar(charId, name, moodId, imageBlob, metadata = {}) {
    await this._ensureDB();
    const id = buildMoodAvatarKey(charId, name, moodId);
    const safeName = name.trim().toLowerCase();
    const safeCharId = String(charId || GLOBAL_CHAR_ID);
    const record = {
      id, charId: safeCharId, alias: safeName, moodId,
      imageBlob,
      mimeType: imageBlob ? (imageBlob.type || 'image/jpeg') : (metadata.mimeType || 'image/webp'),
      fileName: metadata.fileName || `${safeName}-${moodId}.jpg`,
      fileSize: imageBlob ? imageBlob.size : 0,
      width: metadata.width || 0,
      height: metadata.height || 0,
      createdAt: Date.now(),
      updatedAt: Date.now()
    };
    return this._put(STORE_MOOD_AVATARS, record);
  }

  async getMoodAvatar(charId, name, moodId) {
    await this._ensureDB();
    const id = buildMoodAvatarKey(charId, name, moodId);
    return this._getByKey(STORE_MOOD_AVATARS, id);
  }

  async getMoodAvatarBlobUrl(charId, name, moodId) {
    const cacheKey = 'mood_' + buildMoodAvatarKey(charId, name, moodId);
    if (this._blobUrlCache.has(cacheKey)) return this._blobUrlCache.get(cacheKey);
    const record = await this.getMoodAvatar(charId, name, moodId);
    if (!record || !record.imageBlob) return null;
    const url = URL.createObjectURL(record.imageBlob);
    this._blobUrlCache.set(cacheKey, url);
    return url;
  }

  async listMoodAvatars(charId, name) {
    await this._ensureDB();
    const safeName = name.trim().toLowerCase();
    const safeCharId = String(charId || GLOBAL_CHAR_ID);
    return new Promise((resolve, reject) => {
      const tx = this.db.transaction(STORE_MOOD_AVATARS, 'readonly');
      const index = tx.objectStore(STORE_MOOD_AVATARS).index('charId');
      const req = index.getAll(IDBKeyRange.only(safeCharId));
      req.onsuccess = () => {
        resolve(req.result.filter(r => r.alias === safeName));
      };
      req.onerror = () => reject(new Error(`情绪差分列表查询失败`));
    });
  }

  async deleteMoodAvatar(charId, name, moodId) {
    await this._ensureDB();
    const id = buildMoodAvatarKey(charId, name, moodId);
    const cacheKey = 'mood_' + id;
    if (this._blobUrlCache.has(cacheKey)) {
      URL.revokeObjectURL(this._blobUrlCache.get(cacheKey));
      this._blobUrlCache.delete(cacheKey);
    }
    return new Promise((resolve, reject) => {
      const tx = this.db.transaction(STORE_MOOD_AVATARS, 'readwrite');
      const req = tx.objectStore(STORE_MOOD_AVATARS).delete(id);
      req.onsuccess = () => resolve();
      req.onerror = () => reject(new Error(`情绪差分删除失败`));
    });
  }

  async deleteAllMoodAvatars(charId, name) {
    await this._ensureDB();
    const moodAvatars = await this.listMoodAvatars(charId, name);
    const tx = this.db.transaction(STORE_MOOD_AVATARS, 'readwrite');
    const store = tx.objectStore(STORE_MOOD_AVATARS);
    for (const ma of moodAvatars) {
      store.delete(ma.id);
      const cacheKey = 'mood_' + ma.id;
      if (this._blobUrlCache.has(cacheKey)) {
        URL.revokeObjectURL(this._blobUrlCache.get(cacheKey));
        this._blobUrlCache.delete(cacheKey);
      }
    }
    return new Promise((resolve, reject) => {
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(new Error(`情绪差分批量删除失败`));
    });
  }

  // -- 本地字体 CRUD --

  _buildLocalFontId(family) {
    return 'local__' + family.trim();
  }

  async addLocalFont(family, fontBlob, metadata = {}) {
    await this._ensureDB();
    const id = this._buildLocalFontId(family);
    const ext = (metadata.fileName || '').split('.').pop()?.toLowerCase() || '';
    const record = {
      id, family: family.trim(), name: metadata.name || family.trim(),
      fontBlob,
      mimeType: metadata.mimeType || FONT_EXT_MIME_MAP[ext] || 'application/octet-stream',
      fileName: metadata.fileName || `${family}.${ext || 'woff2'}`,
      fileSize: fontBlob.size,
      format: FONT_EXT_FORMAT_MAP[ext] || '',
      createdAt: Date.now(),
    };
    return this._put(STORE_LOCAL_FONTS, record);
  }

  async getLocalFont(family) {
    await this._ensureDB();
    const id = this._buildLocalFontId(family);
    return this._getByKey(STORE_LOCAL_FONTS, id);
  }

  async listLocalFonts() {
    await this._ensureDB();
    return new Promise((resolve, reject) => {
      const req = this.db.transaction(STORE_LOCAL_FONTS, 'readonly').objectStore(STORE_LOCAL_FONTS).getAll();
      req.onsuccess = () => resolve(req.result || []);
      req.onerror = () => reject(new Error('本地字体列表查询失败'));
    });
  }

  async deleteLocalFont(family) {
    await this._ensureDB();
    const id = this._buildLocalFontId(family);
    return new Promise((resolve, reject) => {
      const tx = this.db.transaction(STORE_LOCAL_FONTS, 'readwrite');
      const req = tx.objectStore(STORE_LOCAL_FONTS).delete(id);
      req.onsuccess = () => resolve();
      req.onerror = () => reject(new Error('本地字体删除失败'));
    });
  }

  // -- CSS 字体源管理 --

  async getCssFontSources() {
    const raw = await this.getConfig('style_cssFontUrls', '[]');
    try { return JSON.parse(raw); } catch (_) { return []; }
  }

  async addCssFontSource(url, families) {
    const sources = await this.getCssFontSources();
    const existing = sources.findIndex(s => s.url === url);
    const entry = { url, families: families || [], importedAt: Date.now() };
    if (existing >= 0) sources[existing] = entry;
    else sources.push(entry);
    await this.setConfig('style_cssFontUrls', JSON.stringify(sources));
  }

  async deleteCssFontSource(url) {
    const sources = await this.getCssFontSources();
    const filtered = sources.filter(s => s.url !== url);
    await this.setConfig('style_cssFontUrls', JSON.stringify(filtered));
  }

  // -- 配置管理 --

  async getConfig(key, defaultValue = null) {
    await this._ensureDB();
    const record = await this._getByKey(STORE_CONFIG, key);
    return record ? record.value : defaultValue;
  }

  async setConfig(key, value) {
    await this._ensureDB();
    const result = await this._put(STORE_CONFIG, { key, value });
    if (STYLE_CONFIG_KEYS.includes(key)) {
      writeStyleSnapshot({ [key]: value });
    }
    return result;
  }

  async getAllConfig() {
    await this._ensureDB();
    return new Promise((resolve, reject) => {
      const req = this.db.transaction(STORE_CONFIG, 'readonly').objectStore(STORE_CONFIG).getAll();
      req.onsuccess = () => {
        const config = {};
        req.result.forEach(r => { config[r.key] = r.value; });
        resolve(config);
      };
      req.onerror = () => reject(new Error(`配置查询失败`));
    });
  }

  // -- 导入导出（v6.0 三文件拆分） --

  _downloadJsonFile(data, filename) {
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  }

  _downloadZipFile(blob, filename) {
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  }

  //  角色卡配置 
  async exportCharacterData(charId, { urlOnly = false } = {}) {
    await this._ensureDB();
    const safeCharId = String(charId || GLOBAL_CHAR_ID);
    const prefix = safeCharId + CHAR_ID_SEPARATOR;

    const allAvatars = await new Promise((resolve, reject) => {
      const req = this.db.transaction(STORE_AVATARS, 'readonly').objectStore(STORE_AVATARS).getAll();
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(new Error('导出失败'));
    });
    const avatars = [];
    for (const r of allAvatars.filter(r => r.alias.startsWith(prefix))) {
      const entry = {
        name: extractDisplayName(r.alias, safeCharId), mimeType: r.mimeType, fileName: r.fileName,
        fileSize: r.fileSize, width: r.width, height: r.height,
        createdAt: r.createdAt, updatedAt: r.updatedAt,
        imageUrl: r.sourceUrl || null,
        imageBase64: (urlOnly && r.sourceUrl) ? null : await this._blobToBase64(r.imageBlob)
      };
      avatars.push(entry);
    }

    const allMoodAvatars = await new Promise((resolve, reject) => {
      const req = this.db.transaction(STORE_MOOD_AVATARS, 'readonly').objectStore(STORE_MOOD_AVATARS).getAll();
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(new Error('情绪差分导出失败'));
    });
    const moodAvatars = [];
    for (const r of allMoodAvatars.filter(r => r.charId === safeCharId)) {
      moodAvatars.push({
        name: r.alias, moodId: r.moodId, mimeType: r.mimeType, fileName: r.fileName,
        fileSize: r.fileSize, width: r.width, height: r.height,
        createdAt: r.createdAt, updatedAt: r.updatedAt,
        imageUrl: r.sourceUrl || null,
        imageBase64: (urlOnly && r.sourceUrl) ? null : await this._blobToBase64(r.imageBlob)
      });
    }

    const allConfig = await this.getAllConfig();
    const colors = {};
    const colorPrefix = 'color_' + prefix;
    for (const [k, v] of Object.entries(allConfig)) {
      if (k.startsWith(colorPrefix)) {
        colors[k.slice(colorPrefix.length)] = v;
      }
    }

    // v7.0: CG groups（含本地上传图片的 base64）
    const cgGroups = await this.listCgGroups(safeCharId);
    const cgGroupsExport = [];
    for (const g of cgGroups) {
      const entry = { group: g.group, albumUrl: g.albumUrl, localImages: [] };
      const urls = g.imageUrls || [];
      for (let i = 0; i < urls.length; i++) {
        if (urls[i].startsWith('local://')) {
          const cached = await this.getCgImage(g.group, i + 1);
          if (cached && cached.imageBlob) {
            entry.localImages.push({
              index: i + 1,
              fileName: urls[i].replace('local://', ''),
              mimeType: cached.mimeType || 'image/webp',
              imageBase64: await this._blobToBase64(cached.imageBlob)
            });
          }
        }
      }
      if (!entry.localImages.length) delete entry.localImages;
      cgGroupsExport.push(entry);
    }

    return {
      type: 'bubble-character',
      version: '7.0',
      exportedAt: new Date().toISOString(),
      charId: safeCharId,
      charName: getCurrentCharName(),
      avatars,
      moodAvatars,
      colors,
      cgGroups: cgGroupsExport.length ? cgGroupsExport : undefined
    };
  }

  async exportCharacterDataToFile(charId) {
    await this._exportCharacterDataToZip(charId);
  }

  /**
   * 将角色数据导出为 ZIP 格式（图片以二进制文件存储，不再用 base64）
   * ZIP 结构：
   *   manifest.json          — 元数据（不含图片数据）
   *   avatars/0_name.webp    — 头像图片
   *   mood/0_name_moodId.webp — 情绪差分头像
   *   cg/group/1_file.webp   — CG 本地图片
   */
  async _exportCharacterDataToZip(charId) {
    await this._ensureDB();
    const safeCharId = String(charId || GLOBAL_CHAR_ID);
    const prefix = safeCharId + CHAR_ID_SEPARATOR;
    const zipFiles = [];

    // - 头像 -
    const allAvatars = await new Promise((resolve, reject) => {
      const req = this.db.transaction(STORE_AVATARS, 'readonly').objectStore(STORE_AVATARS).getAll();
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(new Error('导出失败'));
    });
    const avatarsMeta = [];
    let avatarIdx = 0;
    for (const r of allAvatars.filter(r => r.alias.startsWith(prefix))) {
      const displayName = extractDisplayName(r.alias, safeCharId);
      const meta = {
        name: displayName, mimeType: r.mimeType, fileName: r.fileName,
        fileSize: r.fileSize, width: r.width, height: r.height,
        createdAt: r.createdAt, updatedAt: r.updatedAt,
        imageUrl: r.sourceUrl || null, zipPath: null
      };
      if (r.imageBlob) {
        const ext = mimeToExt(r.mimeType);
        const zipPath = `avatars/${avatarIdx}_${safeFileName(displayName)}${ext}`;
        const buf = await r.imageBlob.arrayBuffer();
        zipFiles.push({ name: zipPath, data: new Uint8Array(buf) });
        meta.zipPath = zipPath;
      }
      avatarsMeta.push(meta);
      avatarIdx++;
    }

    // - 情绪差分头像 -
    const allMoodAvatars = await new Promise((resolve, reject) => {
      const req = this.db.transaction(STORE_MOOD_AVATARS, 'readonly').objectStore(STORE_MOOD_AVATARS).getAll();
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(new Error('情绪差分导出失败'));
    });
    const moodAvatarsMeta = [];
    let moodIdx = 0;
    for (const r of allMoodAvatars.filter(r => r.charId === safeCharId)) {
      const meta = {
        name: r.alias, moodId: r.moodId, mimeType: r.mimeType, fileName: r.fileName,
        fileSize: r.fileSize, width: r.width, height: r.height,
        createdAt: r.createdAt, updatedAt: r.updatedAt,
        imageUrl: r.sourceUrl || null, zipPath: null
      };
      if (r.imageBlob) {
        const ext = mimeToExt(r.mimeType);
        const zipPath = `mood/${moodIdx}_${safeFileName(r.alias)}_${r.moodId}${ext}`;
        const buf = await r.imageBlob.arrayBuffer();
        zipFiles.push({ name: zipPath, data: new Uint8Array(buf) });
        meta.zipPath = zipPath;
      }
      moodAvatarsMeta.push(meta);
      moodIdx++;
    }

    // - 颜色配置 -
    const allConfig = await this.getAllConfig();
    const colors = {};
    const colorPrefix = 'color_' + prefix;
    for (const [k, v] of Object.entries(allConfig)) {
      if (k.startsWith(colorPrefix)) colors[k.slice(colorPrefix.length)] = v;
    }

    // - CG 组 -
    const cgGroups = await this.listCgGroups(safeCharId);
    const cgGroupsMeta = [];
    for (const g of cgGroups) {
      const entry = { group: g.group, albumUrl: g.albumUrl, localImages: [] };
      const urls = g.imageUrls || [];
      for (let i = 0; i < urls.length; i++) {
        if (urls[i].startsWith('local://')) {
          const cached = await this.getCgImage(g.group, i + 1);
          if (cached && cached.imageBlob) {
            const origName = urls[i].replace('local://', '');
            const ext = mimeToExt(cached.mimeType || 'image/webp');
            const zipPath = `cg/${safeFileName(g.group)}/${i + 1}_${safeFileName(origName)}${ext}`;
            const buf = await cached.imageBlob.arrayBuffer();
            zipFiles.push({ name: zipPath, data: new Uint8Array(buf) });
            entry.localImages.push({
              index: i + 1, fileName: origName,
              mimeType: cached.mimeType || 'image/webp', zipPath
            });
          }
        }
      }
      if (!entry.localImages.length) delete entry.localImages;
      cgGroupsMeta.push(entry);
    }

    // - manifest.json -
    const manifest = {
      type: 'bubble-character',
      version: '7.1-zip',
      exportedAt: new Date().toISOString(),
      charId: safeCharId,
      charName: getCurrentCharName(),
      avatars: avatarsMeta,
      moodAvatars: moodAvatarsMeta,
      colors,
      cgGroups: cgGroupsMeta.length ? cgGroupsMeta : undefined
    };
    const manifestJson = JSON.stringify(manifest, null, 2);
    const encoder = new TextEncoder();
    zipFiles.unshift({ name: 'manifest.json', data: encoder.encode(manifestJson) });

    // - 打包并下载 -
    const zipBlob = zipCreate(zipFiles);
    const charName = manifest.charName || 'unknown';
    const date = new Date().toISOString().slice(0, 10);
    this._downloadZipFile(zipBlob, `bubble-character-${charName}-${date}.zip`);
  }

  async _importCharacterData(data, charId) {
    await this._ensureDB();
    const safeCharId = String(charId || GLOBAL_CHAR_ID);
    const result = { imported: 0, skipped: 0, errors: [] };
    const compOpts = await getCompressOptions(this);

    if (Array.isArray(data.avatars)) {
      for (const item of data.avatars) {
        try {
          const itemName = item.name || item.alias;
          if (item.imageBase64) {
            let blob = this._base64ToBlob(item.imageBase64, item.mimeType);
            blob = await compressImage(blob, compOpts);
            const existing = await this.get(safeCharId, itemName);
            if (existing) {
              await this.update(safeCharId, itemName, blob, { fileName: item.fileName, width: item.width, height: item.height });
            } else {
              await this.add(safeCharId, itemName, blob, { fileName: item.fileName, width: item.width, height: item.height });
            }
          } else if (item.imageUrl) {
            const existing = await this.get(safeCharId, itemName);
            if (existing) {
              await this.update(safeCharId, itemName, existing.imageBlob || null, {
                sourceUrl: item.imageUrl, fileName: item.fileName, width: item.width, height: item.height, mimeType: item.mimeType
              });
            } else {
              await this.add(safeCharId, itemName, null, {
                sourceUrl: item.imageUrl, fileName: item.fileName, width: item.width, height: item.height, mimeType: item.mimeType
              });
            }
          } else { result.skipped++; continue; }
          result.imported++;
        } catch (err) { result.errors.push(`${item.name || item.alias}: ${err.message}`); }
      }
    }

    if (Array.isArray(data.moodAvatars)) {
      for (const item of data.moodAvatars) {
        try {
          const itemName = item.name || item.alias;
          if (item.imageBase64) {
            let blob = this._base64ToBlob(item.imageBase64, item.mimeType);
            blob = await compressImage(blob, compOpts);
            await this.addMoodAvatar(safeCharId, itemName, item.moodId, blob, {
              fileName: item.fileName, width: item.width, height: item.height
            });
          } else if (item.imageUrl) {
            // 情绪差分头像：注册 URL 空壳
            const id = buildMoodAvatarKey(safeCharId, itemName, item.moodId);
            const record = {
              id, charId: safeCharId, alias: itemName.trim().toLowerCase(), moodId: item.moodId,
              imageBlob: null, sourceUrl: item.imageUrl,
              mimeType: item.mimeType || 'image/webp',
              fileName: item.fileName || '',
              fileSize: 0, width: item.width || 0, height: item.height || 0,
              createdAt: Date.now(), updatedAt: Date.now()
            };
            await this._put(STORE_MOOD_AVATARS, record);
          } else { result.skipped++; continue; }
          result.imported++;
        } catch (err) { result.errors.push(`${item.name || item.alias}/${item.moodId}: ${err.message}`); }
      }
    }

    if (data.colors) {
      for (const [name, color] of Object.entries(data.colors)) {
        await this.setConfig(buildColorConfigKey(safeCharId, name), color);
      }
    }

    // v7.0: CG groups + 本地图片还原
    if (Array.isArray(data.cgGroups)) {
      for (const cg of data.cgGroups) {
        try {
          if (cg.group) {
            await this.addCgGroup(cg.group, cg.albumUrl || '', safeCharId);
            if (cg.albumUrl && cg.albumUrl.trim()) {
              try { await ensureCgGroupIndex(this, cg.group); } catch (_) {}
            }
            // 还原本地上传的图片
            if (Array.isArray(cg.localImages)) {
              const groupInfo = await this.getCgGroup(cg.group);
              let urls = groupInfo ? (groupInfo.imageUrls || []) : [];
              let count = groupInfo ? (groupInfo.count || urls.length) : 0;
              for (const img of cg.localImages) {
                if (!img.imageBase64) continue;
                try {
                  let blob = this._base64ToBlob(img.imageBase64, img.mimeType);
                  blob = await compressImage(blob, compOpts);
                  const idx = img.index || (count + 1);
                  await this.putCgImage(cg.group, idx, blob, 'local://' + (img.fileName || idx));
                  // 确保 imageUrls 有对应条目
                  while (urls.length < idx) urls.push('');
                  urls[idx - 1] = 'local://' + (img.fileName || idx);
                  if (idx > count) count = idx;
                } catch (_) {}
              }
              await this.updateCgGroup(cg.group, { count, imageUrls: urls });
            }
            result.imported++;
          }
        } catch (err) { result.errors.push(`CG:${cg.group}: ${err.message}`); }
      }
    }

    return result;
  }

  //  样式配置 
  async exportStyleSettings() {
    const allConfig = await this.getAllConfig();
    const settings = {};
    for (const key of STYLE_CONFIG_KEYS) {
      settings[key] = allConfig[key] !== undefined ? allConfig[key] : STYLE_DEFAULTS[key];
    }
    return {
      type: 'bubble-style',
      version: '6.0',
      exportedAt: new Date().toISOString(),
      settings
    };
  }

  async exportStyleSettingsToFile() {
    const data = await this.exportStyleSettings();
    const date = new Date().toISOString().slice(0, 10);
    this._downloadJsonFile(data, `bubble-style-${date}.json`);
  }

  async _importStyleSettings(data) {
    if (!data.settings || typeof data.settings !== 'object') throw new Error('样式配置数据无效');
    for (const [key, value] of Object.entries(data.settings)) {
      if (STYLE_CONFIG_KEYS.includes(key)) {
        await this.setConfig(key, value);
      }
    }
    return { imported: Object.keys(data.settings).length };
  }

  //  情绪与格式模板 
  async exportTemplate() {
    const formatRule = await this.getConfig('format_rule', DEFAULT_FORMAT_RULE);
    const moodConfigRaw = await this.getConfig('mood_config', null);
    let moodConfig;
    if (moodConfigRaw) {
      try { moodConfig = JSON.parse(moodConfigRaw); } catch (_) { moodConfig = null; }
    }
    if (!moodConfig) {
      moodConfig = { version: '6.0', groups: DEFAULT_MOOD_GROUPS.map(g => ({ ...g, words: [...g.words] })) };
    }

    return {
      type: 'bubble-template',
      version: '6.0',
      exportedAt: new Date().toISOString(),
      formatRule,
      moodConfig
    };
  }

  async exportTemplateToFile() {
    const data = await this.exportTemplate();
    const date = new Date().toISOString().slice(0, 10);
    this._downloadJsonFile(data, `bubble-template-${date}.json`);
  }

  async _importTemplate(data) {
    if (data.formatRule !== undefined) {
      await this.setConfig('format_rule', data.formatRule);
    }
    if (data.moodConfig) {
      await this.setConfig('mood_config', JSON.stringify(data.moodConfig));
    }
    invalidateInjectionCache();
    await applyInjection(this);
    return { imported: 1 };
  }

  //  v7.0: CG 图片库 CRUD 

  async addCgGroup(group, albumUrl, charId) {
    await this._ensureDB();
    const id = 'cg_group__' + group;
    const record = {
      id, group, albumUrl,
      charId: String(charId || GLOBAL_CHAR_ID),
      count: 0,
      imageUrls: [],
      createdAt: Date.now(),
      updatedAt: Date.now()
    };
    return this._put(STORE_CG_GROUPS, record);
  }

  async getCgGroup(group) {
    await this._ensureDB();
    const id = 'cg_group__' + group;
    return this._getByKey(STORE_CG_GROUPS, id);
  }

  async listCgGroups(charId) {
    await this._ensureDB();
    const safeCharId = String(charId || GLOBAL_CHAR_ID);
    return new Promise((resolve, reject) => {
      const req = this.db.transaction(STORE_CG_GROUPS, 'readonly').objectStore(STORE_CG_GROUPS).getAll();
      req.onsuccess = () => resolve(req.result.filter(g => g.charId === safeCharId));
      req.onerror = () => reject(new Error('CG 组列表查询失败'));
    });
  }

  async updateCgGroup(group, updates) {
    await this._ensureDB();
    const existing = await this.getCgGroup(group);
    if (!existing) throw new Error(`CG 组 "${group}" 不存在`);
    const record = { ...existing, ...updates, updatedAt: Date.now() };
    return this._put(STORE_CG_GROUPS, record);
  }

  async deleteCgGroup(group) {
    await this._ensureDB();
    const id = 'cg_group__' + group;
    // 删除该组所有图片（本地+远程全清）
    await new Promise((resolve, reject) => {
      const tx = this.db.transaction(STORE_CG_IMAGES, 'readwrite');
      const store = tx.objectStore(STORE_CG_IMAGES);
      const index = store.index('group');
      const req = index.openCursor(IDBKeyRange.only(group));
      req.onsuccess = (e) => {
        const cursor = e.target.result;
        if (cursor) { cursor.delete(); cursor.continue(); }
      };
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(new Error('CG 图片清除失败'));
    });
    // 删除组注册
    return new Promise((resolve, reject) => {
      const tx = this.db.transaction(STORE_CG_GROUPS, 'readwrite');
      const req = tx.objectStore(STORE_CG_GROUPS).delete(id);
      req.onsuccess = () => resolve();
      req.onerror = () => reject(new Error('CG 组删除失败'));
    });
  }

  async getCgImage(group, index) {
    await this._ensureDB();
    const id = 'cg__' + group + '__' + index;
    return this._getByKey(STORE_CG_IMAGES, id);
  }

  async putCgImage(group, index, blob, sourceUrl) {
    await this._ensureDB();
    const id = 'cg__' + group + '__' + index;
    const record = {
      id, group, index,
      imageBlob: blob,
      sourceUrl: sourceUrl || '',
      mimeType: blob.type || 'image/webp',
      fileSize: blob.size,
      cachedAt: Date.now()
    };
    return this._put(STORE_CG_IMAGES, record);
  }

  async clearCgGroupCache(group) {
    await this._ensureDB();
    return new Promise((resolve, reject) => {
      const tx = this.db.transaction(STORE_CG_IMAGES, 'readwrite');
      const store = tx.objectStore(STORE_CG_IMAGES);
      const index = store.index('group');
      const req = index.openCursor(IDBKeyRange.only(group));
      req.onsuccess = (e) => {
        const cursor = e.target.result;
        if (cursor) {
          // 只删远程拉取的，保留本地上传的
          const record = cursor.value;
          if (!record.sourceUrl || !record.sourceUrl.startsWith('local://')) {
            cursor.delete();
          }
          cursor.continue();
        }
      };
      tx.oncomplete = async () => {
        try {
          const groupInfo = await this.getCgGroup(group);
          if (groupInfo) {
            const isDirectList = (groupInfo.albumUrl || '').split(/[\n\r]+/).filter(l => l.trim() && IMAGE_EXTS_RE.test(l)).length > 1;
            if (!isDirectList) {
              // 远程清单模式：清空远程 URL 列表但保留本地上传的条目
              const localUrls = (groupInfo.imageUrls || []).filter(u => u.startsWith('local://'));
              await this.updateCgGroup(group, { count: localUrls.length, imageUrls: localUrls });
            }
          }
        } catch (_) {}
        resolve();
      };
      tx.onerror = () => reject(new Error('CG 缓存清除失败'));
    });
  }

  async clearAllCgCache() {
    await this._ensureDB();
    // 只清远程拉取的图片，保留本地上传的
    await new Promise((resolve, reject) => {
      const tx = this.db.transaction(STORE_CG_IMAGES, 'readwrite');
      const store = tx.objectStore(STORE_CG_IMAGES);
      const req = store.openCursor();
      req.onsuccess = (e) => {
        const cursor = e.target.result;
        if (cursor) {
          if (!cursor.value.sourceUrl || !cursor.value.sourceUrl.startsWith('local://')) {
            cursor.delete();
          }
          cursor.continue();
        }
      };
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(new Error('CG 全部缓存清除失败'));
    });
    // 远程清单来源的组：清空远程 URL 但保留本地条目
    const allGroups = await new Promise((resolve, reject) => {
      const req = this.db.transaction(STORE_CG_GROUPS, 'readonly').objectStore(STORE_CG_GROUPS).getAll();
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(new Error('查询失败'));
    });
    for (const g of allGroups) {
      const localUrls = (g.imageUrls || []).filter(u => u.startsWith('local://'));
      const isDirectList = (g.albumUrl || '').split(/[\n\r]+/).filter(l => l.trim() && IMAGE_EXTS_RE.test(l)).length > 1;
      if (!isDirectList) {
        await this.updateCgGroup(g.group, { count: localUrls.length, imageUrls: localUrls });
      }
    }
  }

  async getCgGroupCacheStats(group) {
    await this._ensureDB();
    return new Promise((resolve, reject) => {
      const tx = this.db.transaction(STORE_CG_IMAGES, 'readonly');
      const index = tx.objectStore(STORE_CG_IMAGES).index('group');
      const req = index.count(IDBKeyRange.only(group));
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(new Error('CG 统计失败'));
    });
  }

  //  统一导入路由 
  async importFromFile(file, charId) {
    // 读取文件头 4 字节判断是 ZIP 还是 JSON
    const headerBuf = await file.slice(0, 4).arrayBuffer();
    const headerView = new DataView(headerBuf);
    const isZip = headerView.getUint32(0, true) === 0x04034B50; // PK\x03\x04

    if (isZip) {
      return this._importCharacterDataFromZip(file, charId);
    }

    // JSON 格式（向后兼容）
    const data = JSON.parse(await file.text());
    switch (data.type) {
      case 'bubble-character':
        return this._importCharacterData(data, charId);
      case 'bubble-style':
        return this._importStyleSettings(data);
      case 'bubble-template':
        return this._importTemplate(data);
      case 'bubble-cg':
        return this._importCgData(data, charId);
      default:
        if (data.version === '2.0' && Array.isArray(data.avatars)) {
          throw new Error('此文件为 v5.x 旧格式，v6.0 不兼容导入。请使用 v6.0 重新导出。');
        }
        throw new Error('无法识别的文件格式');
    }
  }

  /**
   * 从 ZIP 文件导入角色数据（逐文件处理，内存友好）
   * 每处理完一张图片就释放其 Uint8Array 引用，避免峰值内存过高
   */
  async _importCharacterDataFromZip(file, charId) {
    await this._ensureDB();
    const safeCharId = String(charId || GLOBAL_CHAR_ID);
    const result = { imported: 0, skipped: 0, errors: [] };
    const compOpts = await getCompressOptions(this);

    // 解包 ZIP
    const buffer = await file.arrayBuffer();
    const zipEntries = zipExtract(buffer);

    // 读取 manifest.json
    const manifestData = zipEntries.get('manifest.json');
    if (!manifestData) throw new Error('ZIP 文件中缺少 manifest.json');
    const manifest = JSON.parse(new TextDecoder().decode(manifestData));
    zipEntries.delete('manifest.json'); // 释放 manifest 的 Uint8Array

    if (manifest.type !== 'bubble-character') {
      throw new Error(`ZIP 中的 manifest 类型不匹配：期望 bubble-character，实际 ${manifest.type}`);
    }

    // - 导入头像 -
    if (Array.isArray(manifest.avatars)) {
      for (const item of manifest.avatars) {
        try {
          const itemName = item.name || item.alias;
          if (item.zipPath && zipEntries.has(item.zipPath)) {
            // 从 ZIP 条目中取出二进制数据，转为 Blob
            const imgData = zipEntries.get(item.zipPath);
            zipEntries.delete(item.zipPath); // 立即释放引用
            const ext = item.zipPath.substring(item.zipPath.lastIndexOf('.'));
            const mime = item.mimeType || extToMime(ext);
            let blob = new Blob([imgData], { type: mime });
            blob = await compressImage(blob, compOpts);
            const existing = await this.get(safeCharId, itemName);
            if (existing) {
              await this.update(safeCharId, itemName, blob, { fileName: item.fileName, width: item.width, height: item.height });
            } else {
              await this.add(safeCharId, itemName, blob, { fileName: item.fileName, width: item.width, height: item.height });
            }
            result.imported++;
          } else if (item.imageUrl) {
            // 仅有 URL 的头像（无本地图片）
            const existing = await this.get(safeCharId, itemName);
            if (existing) {
              await this.update(safeCharId, itemName, existing.imageBlob || null, {
                sourceUrl: item.imageUrl, fileName: item.fileName, width: item.width, height: item.height, mimeType: item.mimeType
              });
            } else {
              await this.add(safeCharId, itemName, null, {
                sourceUrl: item.imageUrl, fileName: item.fileName, width: item.width, height: item.height, mimeType: item.mimeType
              });
            }
            result.imported++;
          } else { result.skipped++; }
        } catch (err) { result.errors.push(`${item.name || item.alias}: ${err.message}`); }
      }
    }

    // - 导入情绪差分头像 -
    if (Array.isArray(manifest.moodAvatars)) {
      for (const item of manifest.moodAvatars) {
        try {
          const itemName = item.name || item.alias;
          if (item.zipPath && zipEntries.has(item.zipPath)) {
            const imgData = zipEntries.get(item.zipPath);
            zipEntries.delete(item.zipPath);
            const ext = item.zipPath.substring(item.zipPath.lastIndexOf('.'));
            const mime = item.mimeType || extToMime(ext);
            let blob = new Blob([imgData], { type: mime });
            blob = await compressImage(blob, compOpts);
            await this.addMoodAvatar(safeCharId, itemName, item.moodId, blob, {
              fileName: item.fileName, width: item.width, height: item.height
            });
            result.imported++;
          } else if (item.imageUrl) {
            const id = buildMoodAvatarKey(safeCharId, itemName, item.moodId);
            const record = {
              id, charId: safeCharId, alias: itemName.trim().toLowerCase(), moodId: item.moodId,
              imageBlob: null, sourceUrl: item.imageUrl,
              mimeType: item.mimeType || 'image/webp',
              fileName: item.fileName || '',
              fileSize: 0, width: item.width || 0, height: item.height || 0,
              createdAt: Date.now(), updatedAt: Date.now()
            };
            await this._put(STORE_MOOD_AVATARS, record);
            result.imported++;
          } else { result.skipped++; }
        } catch (err) { result.errors.push(`${item.name || item.alias}/${item.moodId}: ${err.message}`); }
      }
    }

    // - 导入颜色配置 -
    if (manifest.colors) {
      for (const [name, color] of Object.entries(manifest.colors)) {
        await this.setConfig(buildColorConfigKey(safeCharId, name), color);
      }
    }

    // - 导入 CG 组 + 本地图片 -
    if (Array.isArray(manifest.cgGroups)) {
      for (const cg of manifest.cgGroups) {
        try {
          if (cg.group) {
            await this.addCgGroup(cg.group, cg.albumUrl || '', safeCharId);
            if (cg.albumUrl && cg.albumUrl.trim()) {
              try { await ensureCgGroupIndex(this, cg.group); } catch (_) {}
            }
            if (Array.isArray(cg.localImages)) {
              const groupInfo = await this.getCgGroup(cg.group);
              let urls = groupInfo ? (groupInfo.imageUrls || []) : [];
              let count = groupInfo ? (groupInfo.count || urls.length) : 0;
              for (const img of cg.localImages) {
                if (!img.zipPath || !zipEntries.has(img.zipPath)) continue;
                try {
                  const imgData = zipEntries.get(img.zipPath);
                  zipEntries.delete(img.zipPath);
                  const mime = img.mimeType || 'image/webp';
                  let blob = new Blob([imgData], { type: mime });
                  blob = await compressImage(blob, compOpts);
                  const idx = img.index || (count + 1);
                  await this.putCgImage(cg.group, idx, blob, 'local://' + (img.fileName || idx));
                  while (urls.length < idx) urls.push('');
                  urls[idx - 1] = 'local://' + (img.fileName || idx);
                  if (idx > count) count = idx;
                } catch (_) {}
              }
              await this.updateCgGroup(cg.group, { count, imageUrls: urls });
            }
            result.imported++;
          }
        } catch (err) { result.errors.push(`CG:${cg.group}: ${err.message}`); }
      }
    }

    return result;
  }

  async _importCgData(data, charId) {
    const safeCharId = String(charId || GLOBAL_CHAR_ID);
    const result = { imported: 0, skipped: 0, errors: [] };
    const compOpts = await getCompressOptions(this);
    if (Array.isArray(data.groups)) {
      for (const cg of data.groups) {
        try {
          if (cg.group) {
            await this.addCgGroup(cg.group, cg.albumUrl || '', safeCharId);
            if (cg.albumUrl && cg.albumUrl.trim()) {
              try { await ensureCgGroupIndex(this, cg.group); } catch (_) {}
            }
            if (Array.isArray(cg.localImages)) {
              const groupInfo = await this.getCgGroup(cg.group);
              let urls = groupInfo ? (groupInfo.imageUrls || []) : [];
              let count = groupInfo ? (groupInfo.count || urls.length) : 0;
              for (const img of cg.localImages) {
                if (!img.imageBase64) continue;
                try {
                  let blob = this._base64ToBlob(img.imageBase64, img.mimeType);
                  blob = await compressImage(blob, compOpts);
                  const idx = img.index || (count + 1);
                  await this.putCgImage(cg.group, idx, blob, 'local://' + (img.fileName || idx));
                  while (urls.length < idx) urls.push('');
                  urls[idx - 1] = 'local://' + (img.fileName || idx);
                  if (idx > count) count = idx;
                } catch (_) {}
              }
              await this.updateCgGroup(cg.group, { count, imageUrls: urls });
            }
            result.imported++;
          } else { result.skipped++; }
        } catch (err) { result.errors.push(`CG:${cg.group}: ${err.message}`); }
      }
    }
    return result;
  }

  // -- 缓存管理 --

  _revokeCachedUrl(key) {
    if (this._blobUrlCache.has(key)) {
      URL.revokeObjectURL(this._blobUrlCache.get(key));
      this._blobUrlCache.delete(key);
    }
  }

  revokeAllUrls() {
    for (const url of this._blobUrlCache.values()) URL.revokeObjectURL(url);
    this._blobUrlCache.clear();
  }

  async clearAll() {
    await this._ensureDB();
    this.revokeAllUrls();
    const stores = [STORE_AVATARS, STORE_CONFIG, STORE_MOOD_AVATARS];
    if (this.db.objectStoreNames.contains(STORE_LOCAL_FONTS)) stores.push(STORE_LOCAL_FONTS);
    const tx = this.db.transaction(stores, 'readwrite');
    for (const s of stores) tx.objectStore(s).clear();
    return new Promise((resolve, reject) => {
      tx.oncomplete = () => {
        clearStyleSnapshot();
        resolve();
      };
      tx.onerror = () => reject(new Error(`清空失败`));
    });
  }

  // -- 内部工具 --

  _put(storeName, record) {
    return new Promise((resolve, reject) => {
      const req = this.db.transaction(storeName, 'readwrite').objectStore(storeName).put(record);
      req.onsuccess = () => resolve();
      req.onerror = () => reject(new Error(`写入失败`));
    });
  }

  _getByKey(storeName, key) {
    return new Promise((resolve, reject) => {
      const req = this.db.transaction(storeName, 'readonly').objectStore(storeName).get(key);
      req.onsuccess = () => resolve(req.result || null);
      req.onerror = () => reject(new Error(`读取失败`));
    });
  }

  _blobToBase64(blob) {
    if (!blob) return Promise.resolve(null);
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onloadend = () => resolve(reader.result.split(',')[1]);
      reader.onerror = () => reject(new Error('Blob 转 Base64 失败'));
      reader.readAsDataURL(blob);
    });
  }

  _base64ToBlob(base64, mimeType = 'image/jpeg') {
    const byteChars = atob(base64);
    const chunks = [];
    for (let i = 0; i < byteChars.length; i += 512) {
      const slice = byteChars.slice(i, i + 512);
      const bytes = new Uint8Array(slice.length);
      for (let j = 0; j < slice.length; j++) bytes[j] = slice.charCodeAt(j);
      chunks.push(bytes);
    }
    return new Blob(chunks, { type: mimeType });
  }
}

// ████████████████████████████████████████████████████████████
// █                                                        █
// █  Part 2: 对话气泡面板 UI（头像管理 + 正文美化）          █
// █                                                        █
// ████████████████████████████████████████████████████████████

class AvatarManagerPanel {
  constructor(db) {
    this.db = db;
    this.pendingFile = null;
    this.isOpen = false;
    this._mainWindow = null;
    this._syncOverlayLayoutBound = null;
    this._livePreviewTimer = null;
    this._styleDraftLoaded = false;
    this._styleDraftDirty = false;
    this._pendingBubbleRefresh = false;
    this._pendingBubbleRefreshDelay = 0;
    this._panelOffset = { x: 0, y: 0 };
    this._panelDragState = null;
    this._panelDragBindings = null;
    this.currentTab = 'avatar';
    this._charId = '';
    this._charName = '';
    this._expandedMoodName = null;
    this._moodConfigLoaded = false;
    this._moodConfigDirty = false;
    this._moodConfigDraft = null;
    this._formatRuleDraft = null;
  }

  /**
   * 判断当前是否为移动端（触屏 + 窄屏）
   */
  _isMobile() {
    try {
      const w = this._mainWindow || this._getMainWindow();
      return ('ontouchstart' in w) && (w.innerWidth <= 768);
    } catch { return false; }
  }

  _normalizeHexColor(value, fallback = '#58a6ff') {
    if (typeof value !== 'string') return fallback;
    let hex = value.trim();
    if (!hex) return fallback;
    if (!hex.startsWith('#')) hex = `#${hex}`;
    if (/^#[0-9a-fA-F]{3}$/.test(hex)) {
      hex = `#${hex[1]}${hex[1]}${hex[2]}${hex[2]}${hex[3]}${hex[3]}`;
    }
    if (/^#[0-9a-fA-F]{6}$/.test(hex)) return hex.toLowerCase();
    return fallback;
  }

  _hexToRgb(hex) {
    const normalized = this._normalizeHexColor(hex, '#58a6ff');
    return {
      r: parseInt(normalized.slice(1, 3), 16),
      g: parseInt(normalized.slice(3, 5), 16),
      b: parseInt(normalized.slice(5, 7), 16)
    };
  }

  _rgbToHex(r, g, b) {
    const clamp = (value) => Math.min(255, Math.max(0, Number.parseInt(value, 10) || 0));
    return `#${[clamp(r), clamp(g), clamp(b)].map(v => v.toString(16).padStart(2, '0')).join('')}`;
  }

  _openImagePreview(src, title = '') {
    const doc = this._getMainDocument();
    doc.getElementById('bam-image-preview')?.remove();
    const overlay = doc.createElement('div');
    overlay.id = 'bam-image-preview';
    overlay.style.cssText = 'position:fixed;inset:0;z-index:100010;background:rgba(0,0,0,0.85);display:flex;align-items:center;justify-content:center;flex-direction:column;cursor:pointer;';
    overlay.innerHTML = `
      <div style="color:#999;font-size:12px;margin-bottom:8px;">${escapeHtmlAttr(title)}<span style="margin-left:12px;color:#666;">点击任意处关闭</span></div>
      <img src="${src}" style="max-width:90vw;max-height:80vh;object-fit:contain;border-radius:8px;box-shadow:0 8px 40px rgba(0,0,0,0.6);" />
    `;
    overlay.addEventListener('click', () => overlay.remove());
    doc.body.appendChild(overlay);
  }

  _showTextareaDialog({ title = '', placeholder = '', onConfirm } = {}) {
    const doc = this._getMainDocument();
    const mainWindow = this._mainWindow || this._getMainWindow();
    doc.getElementById('bam-textarea-dialog')?.remove();
    const overlay = doc.createElement('div');
    overlay.id = 'bam-textarea-dialog';
    overlay.innerHTML = `
      <div class="bam-ta-backdrop" style="position:fixed;inset:0;z-index:100010;background:rgba(0,0,0,0.7);"></div>
      <div class="bam-ta-shell" style="position:fixed;inset:0;z-index:100011;pointer-events:none;">
        <div class="bam-ta-card" style="position:absolute;left:50%;top:30%;transform:translate(-50%,0);width:min(480px,92vw);max-height:70vh;background:#1a1a2e;border:1px solid rgba(255,255,255,0.08);border-radius:14px;box-shadow:0 16px 48px rgba(0,0,0,0.5);display:flex;flex-direction:column;pointer-events:auto;overflow:hidden;">
          <div class="bam-ta-drag" style="display:flex;align-items:center;justify-content:center;padding:10px 16px 6px;cursor:grab;touch-action:none;">
            <div style="width:36px;height:4px;border-radius:2px;background:rgba(255,255,255,0.15);"></div>
          </div>
          <div style="padding:0 16px 8px;">
            <div style="color:#ccc;font-size:13px;font-weight:600;">${escapeHtmlAttr(title)}</div>
          </div>
          <div style="padding:0 16px;flex:1;overflow:auto;">
            <textarea id="bam-textarea-input" placeholder="${escapeHtmlAttr(placeholder)}" style="width:100%;min-height:120px;max-height:40vh;background:rgba(0,0,0,0.3);border:1px solid rgba(255,255,255,0.1);border-radius:8px;color:#ddd;font-size:12px;font-family:monospace;padding:10px;resize:vertical;box-sizing:border-box;"></textarea>
          </div>
          <div style="display:flex;gap:8px;justify-content:flex-end;padding:10px 16px;">
            <button id="bam-textarea-cancel" style="background:rgba(255,255,255,0.06);border:none;color:#888;padding:8px 20px;border-radius:6px;cursor:pointer;font-size:12px;">取消</button>
            <button id="bam-textarea-ok" style="background:rgba(74,108,247,0.2);border:1px solid rgba(74,108,247,0.3);color:#b9c7ff;padding:8px 20px;border-radius:6px;cursor:pointer;font-size:12px;">确定</button>
          </div>
          <div class="bam-ta-drag" style="display:flex;align-items:center;justify-content:center;padding:6px 16px 10px;cursor:grab;touch-action:none;">
            <div style="width:36px;height:4px;border-radius:2px;background:rgba(255,255,255,0.15);"></div>
          </div>
        </div>
      </div>
    `;
    doc.body.appendChild(overlay);

    const card = overlay.querySelector('.bam-ta-card');
    const textarea = doc.getElementById('bam-textarea-input');
    textarea.focus();

    // 拖动逻辑（顶部+底部拖动条都能拖）
    let dragState = null;
    overlay.querySelectorAll('.bam-ta-drag').forEach(handle => {
      handle.addEventListener('pointerdown', (e) => {
        e.preventDefault();
        handle.setPointerCapture(e.pointerId);
        const rect = card.getBoundingClientRect();
        dragState = { startX: e.clientX, startY: e.clientY, startLeft: rect.left + rect.width / 2, startTop: rect.top, pointerId: e.pointerId };
        handle.style.cursor = 'grabbing';
      });
      handle.addEventListener('pointermove', (e) => {
        if (!dragState || e.pointerId !== dragState.pointerId) return;
        const dx = e.clientX - dragState.startX;
        const dy = e.clientY - dragState.startY;
        card.style.left = (dragState.startLeft + dx) + 'px';
        card.style.top = (dragState.startTop + dy) + 'px';
        card.style.transform = 'translate(-50%,0)';
      });
      const endDrag = (e) => {
        if (!dragState || e.pointerId !== dragState.pointerId) return;
        dragState = null;
        handle.style.cursor = 'grab';
      };
      handle.addEventListener('pointerup', endDrag);
      handle.addEventListener('pointercancel', endDrag);
    });

    // 点背景关闭
    overlay.querySelector('.bam-ta-backdrop').addEventListener('click', () => overlay.remove());
    doc.getElementById('bam-textarea-cancel').addEventListener('click', () => overlay.remove());
    doc.getElementById('bam-textarea-ok').addEventListener('click', () => {
      const value = textarea.value;
      overlay.remove();
      if (onConfirm) onConfirm(value);
    });
  }

  _openMobileColorDialog({ title = '选择颜色', initialValue = '#58a6ff', onConfirm } = {}) {
    const doc = this._getMainDocument();
    const mainWindow = this._mainWindow || this._getMainWindow();
    doc.getElementById('bam-mobile-color-dialog')?.remove();

    const presetColors = ['#f47b67', '#45ddc0', '#e78bff', '#f0b232', '#58a6ff', '#ff9a76', '#7ee787', '#d2a8ff'];
    const current = this._hexToRgb(initialValue);
    const overlay = doc.createElement('div');
    overlay.id = 'bam-mobile-color-dialog';
    overlay.innerHTML = `
      <div class="bam-mobile-color-backdrop" style="position:fixed; inset:0; z-index:100001; background:rgba(0,0,0,0.72);"></div>
      <div class="bam-mobile-color-shell" style="position:fixed; inset:0; z-index:100002; box-sizing:border-box; pointer-events:none;">
        <div class="bam-mobile-color-card" style="position:absolute; width:min(360px, calc(100vw - 28px)); max-height:calc(100vh - 96px); background:#1a1a2e; border:1px solid rgba(255,255,255,0.08); border-radius:18px; box-shadow:0 20px 60px rgba(0,0,0,0.45); overflow:hidden; display:flex; flex-direction:column; pointer-events:auto; transition:left 0.12s ease-out, top 0.12s ease-out;">
          <div class="bam-mobile-color-drag-handle" style="display:flex; align-items:center; justify-content:space-between; gap:12px; padding:14px 18px 12px; border-bottom:1px solid rgba(255,255,255,0.06); cursor:grab; touch-action:none;">
            <div style="display:flex; align-items:center; gap:10px; min-width:0;">
              <span style="display:inline-flex; flex-direction:column; gap:3px; opacity:0.45; flex:0 0 auto;">
                <span style="display:block; width:14px; height:2px; border-radius:999px; background:rgba(255,255,255,0.55);"></span>
                <span style="display:block; width:14px; height:2px; border-radius:999px; background:rgba(255,255,255,0.55);"></span>
              </span>
              <div style="min-width:0;">
                <div style="color:#e8e8ee; font-size:15px; font-weight:600; white-space:nowrap; overflow:hidden; text-overflow:ellipsis;">${escapeHtmlAttr(title)}</div>
                <div style="color:#7d7d93; font-size:11px; margin-top:3px;">顶部和底部都可以拖动</div>
              </div>
            </div>
            <button type="button" class="bam-mobile-color-cancel" style="background:none; border:none; color:#888; font-size:22px; line-height:1; padding:0 4px; flex:0 0 auto;">&times;</button>
          </div>
          <div class="bam-mobile-color-body" style="padding:16px 18px 18px; overflow:auto; overscroll-behavior:contain; -webkit-overflow-scrolling:touch;">
            <div style="display:flex; align-items:center; gap:14px; margin-bottom:14px;">
              <div class="bam-mobile-color-preview" style="width:56px; height:56px; border-radius:16px; background:${this._rgbToHex(current.r, current.g, current.b)}; border:1px solid rgba(255,255,255,0.12); box-shadow:inset 0 0 0 1px rgba(255,255,255,0.06);"></div>
              <div style="flex:1; min-width:0;">
                <div style="color:#8b8ba3; font-size:11px; margin-bottom:6px; letter-spacing:0.4px; text-transform:uppercase;">HEX</div>
                <input class="bam-mobile-color-hex" type="text" value="${this._rgbToHex(current.r, current.g, current.b)}" maxlength="7" style="width:100%; background:rgba(255,255,255,0.04); border:1px solid rgba(255,255,255,0.1); border-radius:10px; padding:10px 12px; color:#f3f3f7; font-size:15px; box-sizing:border-box; outline:none;" />
              </div>
            </div>
            <div style="display:flex; gap:8px; flex-wrap:wrap; margin-bottom:16px;">
              ${presetColors.map(color => `<button type="button" class="bam-mobile-color-preset" data-color="${color}" style="width:28px; height:28px; border-radius:50%; border:2px solid rgba(255,255,255,0.14); background:${color}; padding:0;"></button>`).join('')}
            </div>
            ${[
              { key: 'r', label: 'R', color: '#ef4444', value: current.r },
              { key: 'g', label: 'G', color: '#22c55e', value: current.g },
              { key: 'b', label: 'B', color: '#3b82f6', value: current.b }
            ].map(channel => `
              <div style="margin-bottom:14px;">
                <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:6px;">
                  <span style="color:#d0d0d8; font-size:13px; font-weight:600;">${channel.label}</span>
                  <span class="bam-mobile-color-value" data-channel="${channel.key}" style="color:#888; font-size:12px;">${channel.value}</span>
                </div>
                <input class="bam-mobile-color-range" data-channel="${channel.key}" type="range" min="0" max="255" step="1" value="${channel.value}" style="width:100%; accent-color:${channel.color};" />
              </div>
            `).join('')}
            <div style="display:flex; gap:10px; margin-top:18px;">
              <button type="button" class="bam-mobile-color-cancel" style="flex:1; background:rgba(255,255,255,0.06); border:none; color:#c5c5cf; padding:12px 14px; border-radius:10px; font-size:14px;">取消</button>
              <button type="button" class="bam-mobile-color-confirm" style="flex:1; background:#4a6cf7; border:none; color:#fff; padding:12px 14px; border-radius:10px; font-size:14px; font-weight:600;">确定</button>
            </div>
            <div class="bam-mobile-color-bottom-drag" style="display:flex; flex-direction:column; align-items:center; gap:6px; padding-top:14px; margin-top:10px; border-top:1px solid rgba(255,255,255,0.06); cursor:grab; touch-action:none; user-select:none;">
              <span style="display:inline-flex; flex-direction:column; gap:3px; opacity:0.34;">
                <span style="display:block; width:26px; height:2px; border-radius:999px; background:rgba(255,255,255,0.5);"></span>
                <span style="display:block; width:26px; height:2px; border-radius:999px; background:rgba(255,255,255,0.5);"></span>
              </span>
              <span style="color:#7d7d93; font-size:11px; line-height:1;">这里也能拖动面板</span>
            </div>
          </div>
        </div>
      </div>`;
    doc.body.appendChild(overlay);

    const backdrop = overlay.querySelector('.bam-mobile-color-backdrop');
    const shell = overlay.querySelector('.bam-mobile-color-shell');
    const card = overlay.querySelector('.bam-mobile-color-card');
    const dragHandle = overlay.querySelector('.bam-mobile-color-drag-handle');
    const bottomDragHandle = overlay.querySelector('.bam-mobile-color-bottom-drag');
    const dragTargets = [dragHandle, bottomDragHandle].filter(Boolean);
    const previewEl = overlay.querySelector('.bam-mobile-color-preview');
    const hexInput = overlay.querySelector('.bam-mobile-color-hex');
    const rangeEls = Array.from(overlay.querySelectorAll('.bam-mobile-color-range'));
    const valueEls = Array.from(overlay.querySelectorAll('.bam-mobile-color-value'));
    const state = { ...current };
    let dialogPosition = { left: 14, top: 72 };
    let dragState = null;
    let viewportBindings = null;
    let shellPaddingX = 14;
    let preferredTop = 72;
    let preferredBottom = 22;

    const clampNumber = (value, min, max) => {
      if (max < min) return min;
      return Math.min(Math.max(value, min), max);
    };
    const computeDialogMetrics = () => {
      const metrics = this._getViewportMetrics();
      shellPaddingX = metrics.width <= 420 ? 14 : 18;
      preferredTop = Math.max(56, Math.min(112, Math.round(metrics.height * 0.16)));
      preferredBottom = Math.max(18, Math.min(30, Math.round(metrics.height * 0.05)));
      const maxHeight = Math.max(220, metrics.height - preferredTop - preferredBottom);
      const dialogWidth = Math.min(360, Math.max(260, metrics.width - shellPaddingX * 2));
      return { ...metrics, maxHeight, dialogWidth };
    };
    const clampDialogPosition = (left, top) => {
      const shellRect = shell.getBoundingClientRect();
      const cardWidth = Math.max(260, Math.round(card.offsetWidth || 0));
      const cardHeight = Math.max(220, Math.round(card.offsetHeight || 0));
      const maxLeft = Math.max(shellPaddingX, shellRect.width - cardWidth - shellPaddingX);
      const maxTop = Math.max(12, shellRect.height - cardHeight - preferredBottom);
      return {
        left: clampNumber(left, shellPaddingX, maxLeft),
        top: clampNumber(top, 12, maxTop)
      };
    };
    const applyDialogPosition = (left, top) => {
      dialogPosition = clampDialogPosition(left, top);
      card.style.left = `${dialogPosition.left}px`;
      card.style.top = `${dialogPosition.top}px`;
    };
    const syncUI = (syncHex = true) => {
      const hex = this._rgbToHex(state.r, state.g, state.b);
      previewEl.style.background = hex;
      if (syncHex) hexInput.value = hex;
      rangeEls.forEach((el) => { el.value = `${state[el.dataset.channel]}`; });
      valueEls.forEach((el) => { el.textContent = `${state[el.dataset.channel]}`; });
    };
    const applyHex = (value) => {
      const normalized = this._normalizeHexColor(value, null);
      if (!normalized) return false;
      const rgb = this._hexToRgb(normalized);
      state.r = rgb.r;
      state.g = rgb.g;
      state.b = rgb.b;
      syncUI();
      return true;
    };
    const setDragCursor = (cursor) => {
      dragTargets.forEach((el) => {
        el.style.cursor = cursor;
      });
    };
    const finishDrag = (event) => {
      if (!dragState?.active) return;
      if (event?.pointerId !== undefined && dragState.pointerId !== null && event.pointerId !== dragState.pointerId) return;
      const activeTarget = dragState.dragTarget;
      if (dragState.pointerId !== null && activeTarget?.hasPointerCapture?.(dragState.pointerId)) {
        try { activeTarget.releasePointerCapture(dragState.pointerId); } catch (_) { /* ignore */ }
      }
      dragState = null;
      setDragCursor('grab');
      card.style.transition = 'left 0.12s ease-out, top 0.12s ease-out';
      doc.body.style.userSelect = '';
    };
    const syncDialogViewport = ({ recenter = false } = {}) => {
      const { width, height, offsetTop, offsetLeft, maxHeight, dialogWidth } = computeDialogMetrics();
      shell.style.left = `${offsetLeft}px`;
      shell.style.top = `${offsetTop}px`;
      shell.style.width = `${width}px`;
      shell.style.height = `${height}px`;
      card.style.width = `${dialogWidth}px`;
      card.style.maxHeight = `${maxHeight}px`;
      const nextLeft = recenter ? (width - dialogWidth) / 2 : dialogPosition.left;
      const nextTop = recenter ? preferredTop : dialogPosition.top;
      applyDialogPosition(nextLeft, nextTop);
    };
    const teardownViewportSync = () => {
      if (!viewportBindings) return;
      mainWindow.removeEventListener('resize', viewportBindings);
      mainWindow.removeEventListener('orientationchange', viewportBindings);
      mainWindow.visualViewport?.removeEventListener('resize', viewportBindings);
      mainWindow.visualViewport?.removeEventListener('scroll', viewportBindings);
      viewportBindings = null;
    };
    const closeDialog = () => {
      teardownViewportSync();
      finishDrag();
      overlay.remove();
    };

    syncDialogViewport({ recenter: true });
    viewportBindings = () => syncDialogViewport();
    mainWindow.addEventListener('resize', viewportBindings, { passive: true });
    mainWindow.addEventListener('orientationchange', viewportBindings, { passive: true });
    mainWindow.visualViewport?.addEventListener('resize', viewportBindings, { passive: true });
    mainWindow.visualViewport?.addEventListener('scroll', viewportBindings, { passive: true });

    const beginDrag = (event) => {
      if (event.button !== undefined && event.button !== 0) return;
      if (event.target.closest('button, input, select, textarea, label, a')) return;
      event.preventDefault();
      const dragTarget = event.currentTarget;
      dragState = {
        active: true,
        pointerId: event.pointerId ?? null,
        startX: event.clientX,
        startY: event.clientY,
        originLeft: dialogPosition.left,
        originTop: dialogPosition.top,
        dragTarget
      };
      setDragCursor('grabbing');
      card.style.transition = 'none';
      doc.body.style.userSelect = 'none';
      dragTarget?.setPointerCapture?.(event.pointerId);
    };
    const onDragMove = (event) => {
      if (!dragState?.active) return;
      if (dragState.pointerId !== null && event.pointerId !== dragState.pointerId) return;
      applyDialogPosition(
        dragState.originLeft + (event.clientX - dragState.startX),
        dragState.originTop + (event.clientY - dragState.startY),
      );
    };
    dragTargets.forEach((target) => {
      target.addEventListener('pointerdown', beginDrag);
      target.addEventListener('pointermove', onDragMove);
      target.addEventListener('pointerup', finishDrag);
      target.addEventListener('pointercancel', finishDrag);
      target.addEventListener('lostpointercapture', finishDrag);
    });

    overlay.querySelectorAll('.bam-mobile-color-cancel').forEach((btn) => {
      btn.addEventListener('click', closeDialog);
    });
    backdrop?.addEventListener('click', closeDialog);
    overlay.querySelector('.bam-mobile-color-confirm')?.addEventListener('click', () => {
      const nextColor = this._rgbToHex(state.r, state.g, state.b);
      closeDialog();
      onConfirm?.(nextColor);
    });
    rangeEls.forEach((el) => {
      el.addEventListener('input', () => {
        state[el.dataset.channel] = Number.parseInt(el.value, 10) || 0;
        syncUI();
      });
    });
    overlay.querySelectorAll('.bam-mobile-color-preset').forEach((btn) => {
      btn.addEventListener('click', () => applyHex(btn.dataset.color));
    });
    hexInput?.addEventListener('change', () => {
      if (!applyHex(hexInput.value)) syncUI();
    });
    hexInput?.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        if (!applyHex(hexInput.value)) syncUI();
      }
    });
    return true;
  }

  /**
   * 为面板内所有 <input type="color"> 设置统一颜色弹窗。
   */
  _setupColorPickerProxy() {
    const doc = this._getMainDocument();
    const container = doc.getElementById('bam-container');
    if (!container) return;

    container.addEventListener('click', (e) => {
      const colorInput = e.target.closest('input[type="color"]');
      if (!colorInput) return;
      e.preventDefault();
      e.stopPropagation();
      this._openMobileColorDialog({
        title: colorInput.title || '选择颜色',
        initialValue: colorInput.value,
        onConfirm: (nextColor) => {
          colorInput.value = nextColor;
          colorInput.dispatchEvent(new Event('input', { bubbles: true }));
          colorInput.dispatchEvent(new Event('change', { bubbles: true }));
        }
      });
    }, true);
  }

  /**
   * 获取主页面 document
   */
  _getMainDocument() {
    try { return parent.document || document; } catch { return document; }
  }

  /**
   * 获取主页面 window
   */
  _getMainWindow() {
    try { return parent.window || parent || window; } catch { return window; }
  }

  /**
   * 获取当前可见视口尺寸（优先使用 visualViewport，兼容移动端）
   */
  _getViewportMetrics() {
    const mainWindow = this._mainWindow || this._getMainWindow();
    const viewport = mainWindow.visualViewport;
    const width = Math.max(320, Math.round(viewport?.width || mainWindow.innerWidth || document.documentElement.clientWidth || 0));
    const height = Math.max(320, Math.round(viewport?.height || mainWindow.innerHeight || document.documentElement.clientHeight || 0));
    const offsetTop = Math.max(0, Math.round(viewport?.offsetTop || 0));
    const offsetLeft = Math.max(0, Math.round(viewport?.offsetLeft || 0));
    return { width, height, offsetTop, offsetLeft };
  }

  /**
   * 生成遮罩层样式，避免移动端 100vh / safe-area 导致错位
   */
  _buildOverlayStyles() {
    const { width, height, offsetTop, offsetLeft } = this._getViewportMetrics();
    const panelMaxHeight = Math.max(height - 32, 220);
    return `
      #bam-container {
        position:fixed!important;
        top:${offsetTop}px!important;
        left:${offsetLeft}px!important;
        width:${width}px!important;
        height:${height}px!important;
        min-height:${height}px!important;
        background:rgba(0,0,0,0.7)!important;
        z-index:99999!important;
        display:flex!important;
        align-items:flex-start!important;
        justify-content:center!important;
        margin:0!important;
        padding:16px!important;
        padding-top:calc(env(safe-area-inset-top) + 16px)!important;
        padding-right:calc(env(safe-area-inset-right) + 16px)!important;
        padding-bottom:calc(env(safe-area-inset-bottom) + 16px)!important;
        padding-left:calc(env(safe-area-inset-left) + 16px)!important;
        box-sizing:border-box!important;
        overflow:auto!important;
        overscroll-behavior:contain!important;
        font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif!important;
      }
      #bam-panel {
        width:100%!important;
        max-width:460px!important;
        max-height:${panelMaxHeight}px!important;
        margin:0 auto!important;
        flex:0 0 auto!important;
      }
      @media (max-width: 640px) {
        #bam-container {
          padding:12px!important;
          padding-top:calc(env(safe-area-inset-top) + 12px)!important;
          padding-right:calc(env(safe-area-inset-right) + 12px)!important;
          padding-bottom:calc(env(safe-area-inset-bottom) + 12px)!important;
          padding-left:calc(env(safe-area-inset-left) + 12px)!important;
        }
        #bam-panel {
          max-width:100%!important;
          border-radius:14px!important;
        }
      }
    `;
  }

  _syncOverlayLayout() {
    const doc = this._getMainDocument();
    const styleEl = doc.getElementById('bam-style');
    if (!styleEl) return;
    styleEl.textContent = this._buildOverlayStyles();
    this._syncPanelPosition();
  }

  _bindViewportSync() {
    if (!this._mainWindow || this._syncOverlayLayoutBound) return;
    this._syncOverlayLayoutBound = () => this._syncOverlayLayout();
    this._mainWindow.addEventListener('resize', this._syncOverlayLayoutBound, { passive: true });
    this._mainWindow.addEventListener('orientationchange', this._syncOverlayLayoutBound, { passive: true });
    this._mainWindow.visualViewport?.addEventListener('resize', this._syncOverlayLayoutBound, { passive: true });
    this._mainWindow.visualViewport?.addEventListener('scroll', this._syncOverlayLayoutBound, { passive: true });
  }

  _unbindViewportSync() {
    if (!this._mainWindow || !this._syncOverlayLayoutBound) return;
    this._mainWindow.removeEventListener('resize', this._syncOverlayLayoutBound);
    this._mainWindow.removeEventListener('orientationchange', this._syncOverlayLayoutBound);
    this._mainWindow.visualViewport?.removeEventListener('resize', this._syncOverlayLayoutBound);
    this._mainWindow.visualViewport?.removeEventListener('scroll', this._syncOverlayLayoutBound);
    this._syncOverlayLayoutBound = null;
  }

  _getPanelElements() {
    const doc = this._getMainDocument();
    return {
      container: doc.getElementById('bam-container'),
      panel: doc.getElementById('bam-panel'),
      handle: doc.getElementById('bam-drag-handle')
    };
  }

  _applyPanelOffset() {
    const { panel } = this._getPanelElements();
    if (!panel) return;
    panel.style.transform = `translate(${this._panelOffset.x}px, ${this._panelOffset.y}px)`;
  }

  _clampPanelOffset(nextX, nextY) {
    const { container, panel } = this._getPanelElements();
    if (!container || !panel) return { x: nextX, y: nextY };

    const containerRect = container.getBoundingClientRect();
    const panelRect = panel.getBoundingClientRect();
    const currentOffset = this._panelOffset || { x: 0, y: 0 };
    const baseLeft = panelRect.left - currentOffset.x;
    const baseTop = panelRect.top - currentOffset.y;
    const safePadding = 8;
    const clampAxis = (value, min, max) => {
      if (max < min) return min;
      return Math.min(Math.max(value, min), max);
    };

    return {
      x: clampAxis(nextX, containerRect.left + safePadding - baseLeft, containerRect.right - safePadding - panelRect.width - baseLeft),
      y: clampAxis(nextY, containerRect.top + safePadding - baseTop, containerRect.bottom - safePadding - panelRect.height - baseTop)
    };
  }

  _syncPanelPosition() {
    this._panelOffset = this._clampPanelOffset(this._panelOffset.x, this._panelOffset.y);
    this._applyPanelOffset();
  }

  _setupPanelDrag() {
    if (this._panelDragBindings) return;
    const doc = this._getMainDocument();
    const { panel, handle } = this._getPanelElements();
    if (!panel || !handle) return;

    const finishDrag = (event) => {
      const dragState = this._panelDragState;
      if (!dragState?.active) return;
      if (event?.pointerId !== undefined && dragState.pointerId !== null && event.pointerId !== dragState.pointerId) return;
      if (dragState.pointerId !== null && handle.hasPointerCapture?.(dragState.pointerId)) {
        try { handle.releasePointerCapture(dragState.pointerId); } catch (_) { /* ignore */ }
      }
      this._panelDragState = null;
      handle.style.cursor = 'grab';
      panel.style.transition = 'transform 0.12s ease-out';
      doc.body.style.userSelect = '';
    };

    const onPointerMove = (event) => {
      const dragState = this._panelDragState;
      if (!dragState?.active) return;
      if (dragState.pointerId !== null && event.pointerId !== dragState.pointerId) return;
      const deltaX = event.clientX - dragState.startX;
      const deltaY = event.clientY - dragState.startY;
      this._panelOffset = this._clampPanelOffset(
        dragState.originX + deltaX,
        dragState.originY + deltaY,
      );
      this._applyPanelOffset();
    };

    const onPointerDown = (event) => {
      if (event.button !== undefined && event.button !== 0) return;
      if (event.target.closest('button, input, select, textarea, label, a')) return;
      event.preventDefault();
      this._panelDragState = {
        active: true,
        pointerId: event.pointerId ?? null,
        startX: event.clientX,
        startY: event.clientY,
        originX: this._panelOffset.x,
        originY: this._panelOffset.y
      };
      handle.style.cursor = 'grabbing';
      panel.style.transition = 'none';
      doc.body.style.userSelect = 'none';
      handle.setPointerCapture?.(event.pointerId);
    };

    const onWindowBlur = () => finishDrag();

    handle.addEventListener('pointerdown', onPointerDown);
    handle.addEventListener('pointermove', onPointerMove);
    handle.addEventListener('pointerup', finishDrag);
    handle.addEventListener('pointercancel', finishDrag);
    handle.addEventListener('lostpointercapture', finishDrag);
    this._mainWindow?.addEventListener('blur', onWindowBlur);

    this._panelDragBindings = { onPointerDown, onPointerMove, finishDrag, onWindowBlur };
  }

  _teardownPanelDrag() {
    const doc = this._getMainDocument();
    const { handle } = this._getPanelElements();
    if (this._panelDragBindings && handle) {
      handle.removeEventListener('pointerdown', this._panelDragBindings.onPointerDown);
      handle.removeEventListener('pointermove', this._panelDragBindings.onPointerMove);
      handle.removeEventListener('pointerup', this._panelDragBindings.finishDrag);
      handle.removeEventListener('pointercancel', this._panelDragBindings.finishDrag);
      handle.removeEventListener('lostpointercapture', this._panelDragBindings.finishDrag);
    }
    this._mainWindow?.removeEventListener('blur', this._panelDragBindings?.onWindowBlur);
    const pointerId = this._panelDragState?.pointerId;
    if (pointerId !== undefined && pointerId !== null && handle?.hasPointerCapture?.(pointerId)) {
      try { handle.releasePointerCapture(pointerId); } catch (_) { /* ignore */ }
    }
    doc.body.style.userSelect = '';
    this._panelDragBindings = null;
    this._panelDragState = null;
  }

  _getBubbleRenderFrames() {
    const doc = this._getMainDocument();
    return Array.from(doc.querySelectorAll('iframe')).filter((frame) => {
      try {
        if (typeof frame.srcdoc === 'string' && frame.srcdoc.includes('id="dcRoot"')) return true;
        return Boolean(frame.contentDocument?.getElementById('dcRoot'));
      } catch (_) {
        return false;
      }
    });
  }

  _getDialogueLineHeight(fontSize, spacing) {
    const safeFontSize = Number.isFinite(fontSize) ? fontSize : STYLE_DEFAULTS.style_dialogueFontSize;
    const safeSpacing = Number.isFinite(spacing) ? spacing : STYLE_DEFAULTS.style_dialogueSpacing;
    const computed = Math.max(safeFontSize * 1.35, safeFontSize + safeSpacing);
    return Math.round(computed * 100) / 100;
  }

  _composeFontStack(family, fallbackStack) {
    const safeFamily = typeof family === 'string' ? family.trim() : '';
    return safeFamily ? `"${safeFamily.replace(/"/g, '\\"')}",${fallbackStack}` : fallbackStack;
  }

  _getDefaultStyleSettings() {
    return { ...STYLE_DEFAULTS };
  }

  _getFontCacheKey(url) {
    return `${FONT_CACHE_PREFIX}${url}`;
  }

  _readCachedRemoteFontOptions(url) {
    if (!url) return [];
    try {
      const raw = localStorage.getItem(this._getFontCacheKey(url));
      if (!raw) return [];
      const parsed = JSON.parse(raw);
      return Array.isArray(parsed?.fonts) ? parsed.fonts : [];
    } catch (_) {
      return [];
    }
  }

  _writeCachedRemoteFontOptions(url, fonts) {
    if (!url) return;
    try {
      localStorage.setItem(this._getFontCacheKey(url), JSON.stringify({
        version: '1.0',
        savedAt: Date.now(),
        fonts,
      }));
    } catch (_) {
      // ignore cache errors
    }
  }

  async _fetchRemoteFontOptions(url, { forceRefresh = false, silent = true } = {}) {
    const trimmedUrl = typeof url === 'string' ? url.trim() : '';
    if (!trimmedUrl) return [];

    const controller = typeof AbortController === 'function' ? new AbortController() : null;
    const timer = controller ? setTimeout(() => controller.abort(), FONT_FETCH_TIMEOUT_MS) : null;
    try {
      const response = await fetch(trimmedUrl, {
        method: 'GET',
        cache: forceRefresh ? 'no-store' : 'default',
        signal: controller?.signal,
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const payload = await response.json();
      const fonts = normalizeFontPayload(payload);
      this._writeCachedRemoteFontOptions(trimmedUrl, fonts);
      return fonts;
    } catch (err) {
      const cachedFonts = this._readCachedRemoteFontOptions(trimmedUrl);
      if (cachedFonts.length) return cachedFonts;
      if (!silent) throw err;
      console.warn('拉取远程字体配置失败:', trimmedUrl, err);
      return [];
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  async _getAvailableFontOptions(url, options = {}) {
    const builtins = BUILTIN_FONT_OPTIONS.map((font) => ({ ...font }));
    const familySet = new Set(builtins.map((font) => font.family));
    const merged = [...builtins];

    // 本地上传字体
    try {
      const localFonts = await this.db.listLocalFonts();
      localFonts.forEach((f) => {
        if (familySet.has(f.family)) return;
        familySet.add(f.family);
        merged.push({ id: f.id, name: `${f.family}（本地）`, family: f.family, type: 'local' });
      });
    } catch (_) { /* ignore */ }

    // CSS 字体源
    try {
      const cssSources = await this.db.getCssFontSources();
      cssSources.forEach((src) => {
        (src.families || []).forEach((family) => {
          if (familySet.has(family)) return;
          familySet.add(family);
          merged.push({ id: `css-${family}`, name: `${family}（CSS）`, family, type: 'css', url: src.url });
        });
      });
    } catch (_) { /* ignore */ }

    // 远程 JSON 字体
    const remoteFonts = await this._fetchRemoteFontOptions(url, options);
    remoteFonts.forEach((font) => {
      if (familySet.has(font.family)) return;
      familySet.add(font.family);
      merged.push({ ...font });
    });
    return merged;
  }

  _applyFontOptionsToSelect(selectEl, options, selectedFamily, fallbackFamily) {
    if (!selectEl) return;
    const safeFallback = fallbackFamily || options[0]?.family || '';
    const safeSelected = selectedFamily || safeFallback;
    selectEl.innerHTML = options.map((font) => {
      const selectedAttr = font.family === safeSelected ? ' selected' : '';
      return `<option value="${font.family.replace(/"/g, '&quot;')}"${selectedAttr}>${font.name}</option>`;
    }).join('');
    selectEl.value = safeSelected;
    if (!selectEl.value && safeFallback) selectEl.value = safeFallback;
  }

  async _refreshFontSelectors({ forceRemote = false, silent = true } = {}) {
    const doc = this._getMainDocument();
    const url = doc.getElementById('bam-font-url-input')?.value?.trim() || '';
    const options = await this._getAvailableFontOptions(url, { forceRefresh: forceRemote, silent });
    this._applyFontOptionsToSelect(doc.getElementById('bam-select-narration-font'), options, doc.getElementById('bam-select-narration-font')?.value, STYLE_DEFAULTS.style_narrationFontFamily);
    this._applyFontOptionsToSelect(doc.getElementById('bam-select-dialogue-font'), options, doc.getElementById('bam-select-dialogue-font')?.value, STYLE_DEFAULTS.style_dialogueFontFamily);
    this._applyFontOptionsToSelect(doc.getElementById('bam-select-name-font'), options, doc.getElementById('bam-select-name-font')?.value, STYLE_DEFAULTS.style_nameFontFamily);
    return options;
  }

  _syncFrameFontLinks(frameDoc, fonts) {
    if (!frameDoc?.head) return;
    const cssFonts = fonts.filter((font) => font.type === 'css' && font.url);
    cssFonts.forEach((font) => {
      const exists = Array.from(frameDoc.head.querySelectorAll('link[data-bam-font-url]')).some((node) => node.dataset.bamFontUrl === font.url);
      if (exists) return;
      const link = frameDoc.createElement('link');
      link.rel = 'stylesheet';
      link.href = font.url;
      link.dataset.bamFontUrl = font.url;
      frameDoc.head.appendChild(link);
    });

    const fileFonts = fonts.filter((font) => font.type === 'file' && font.url && font.family);
    if (!fileFonts.length) return;
    let styleEl = frameDoc.getElementById('bam-remote-font-face-style');
    if (!styleEl) {
      styleEl = frameDoc.createElement('style');
      styleEl.id = 'bam-remote-font-face-style';
      frameDoc.head.appendChild(styleEl);
    }
    const rules = fileFonts.map((font) => {
      const formatPart = font.format ? ` format('${font.format}')` : '';
      return `@font-face{font-family:'${font.family.replace(/'/g, "\\'")}';src:url('${font.url.replace(/'/g, "\\'")}')${formatPart};font-display:swap;}`;
    }).join('');
    if (styleEl.textContent !== rules) styleEl.textContent = rules;
  }

  async _ensurePreviewFontResources(frameDoc, settings) {
    const fonts = await this._getAvailableFontOptions(settings.style_fontConfigUrl, { silent: true });
    this._syncFrameFontLinks(frameDoc, fonts);

    // 注入本地字体的 @font-face
    try {
      const localFonts = await this.db.listLocalFonts();
      if (localFonts.length && frameDoc?.head) {
        let styleEl = frameDoc.getElementById('bam-local-font-face-style');
        if (!styleEl) {
          styleEl = frameDoc.createElement('style');
          styleEl.id = 'bam-local-font-face-style';
          frameDoc.head.appendChild(styleEl);
        }
        const rules = localFonts
          .filter(f => f.fontBlob && f.family)
          .map(f => {
            const blobUrl = URL.createObjectURL(f.fontBlob);
            const formatPart = f.format ? ` format('${f.format}')` : '';
            return `@font-face{font-family:'${f.family.replace(/'/g, "\\'")}';src:url('${blobUrl}')${formatPart};font-display:swap;}`;
          }).join('');
        if (styleEl.textContent !== rules) styleEl.textContent = rules;
      }
    } catch (_) { /* ignore */ }

    // 注入 CSS 字体源的 <link>
    try {
      const cssSources = await this.db.getCssFontSources();
      cssSources.forEach((src) => {
        if (!src.url || !frameDoc?.head) return;
        const exists = Array.from(frameDoc.head.querySelectorAll('link[data-bam-css-font-url]'))
          .some(node => node.dataset.bamCssFontUrl === src.url);
        if (exists) return;
        const link = frameDoc.createElement('link');
        link.rel = 'stylesheet';
        link.href = src.url;
        link.dataset.bamCssFontUrl = src.url;
        frameDoc.head.appendChild(link);
      });
    } catch (_) { /* ignore */ }

    return fonts;
  }

  _getLiveStyleSettings() {
    const doc = this._getMainDocument();
    const defaults = this._getDefaultStyleSettings();
    const getNumberValue = (id, fallback) => {
      const raw = doc.getElementById(id)?.value;
      const parsed = Number.parseFloat(raw);
      return Number.isFinite(parsed) ? parsed : fallback;
    };
    const getCheckedValue = (name, fallback) => doc.querySelector(`input[name="${name}"]:checked`)?.value || fallback;
    const getSelectValue = (id, fallback) => doc.getElementById(id)?.value || fallback;

    return {
      style_dialogueFontSize: getNumberValue('bam-range-dialogue-font', defaults.style_dialogueFontSize),
      style_narrationFontSize: getNumberValue('bam-range-narration-font', defaults.style_narrationFontSize),
      style_dialogueSpacing: getNumberValue('bam-range-dialogue-spacing', defaults.style_dialogueSpacing),
      style_textColorMode: getCheckedValue('bam-color-mode', defaults.style_textColorMode),
      style_globalTextColor: doc.getElementById('bam-global-color-picker')?.value || defaults.style_globalTextColor,
      style_markdownMode: getCheckedValue('bam-md-mode', defaults.style_markdownMode),
      style_dialogueFontWeight: getNumberValue('bam-range-dialogue-weight', defaults.style_dialogueFontWeight),
      style_narrationFontWeight: getNumberValue('bam-range-narration-weight', defaults.style_narrationFontWeight),
      style_nameFontWeight: getNumberValue('bam-range-name-weight', defaults.style_nameFontWeight),
      style_narrationBgColor: doc.getElementById('bam-narration-bg-color')?.value || defaults.style_narrationBgColor,
      style_narrationBgOpacity: getNumberValue('bam-range-narration-bg-opacity', defaults.style_narrationBgOpacity),
      style_avatarSize: getNumberValue('bam-range-avatar-size', defaults.style_avatarSize),
      style_narrationIndent: getNumberValue('bam-range-narration-indent', defaults.style_narrationIndent),
      style_narrationFontFamily: getSelectValue('bam-select-narration-font', defaults.style_narrationFontFamily),
      style_dialogueFontFamily: getSelectValue('bam-select-dialogue-font', defaults.style_dialogueFontFamily),
      style_nameFontFamily: getSelectValue('bam-select-name-font', defaults.style_nameFontFamily),
      style_fontConfigUrl: doc.getElementById('bam-font-url-input')?.value?.trim() || defaults.style_fontConfigUrl,
      style_narrationBorderRadius: getNumberValue('bam-range-narration-border-radius', defaults.style_narrationBorderRadius),
      style_avatarShape: getCheckedValue('bam-avatar-shape', defaults.style_avatarShape),
      style_thoughtSuffixGap: getNumberValue('bam-range-thought-suffix-gap', defaults.style_thoughtSuffixGap),
      style_thoughtSuffixOffsetY: getNumberValue('bam-range-thought-suffix-offset-y', defaults.style_thoughtSuffixOffsetY),
      // v7.0
      style_narrationTextIndent: getNumberValue('bam-range-narration-text-indent', defaults.style_narrationTextIndent),
      style_narrationLineHeight: getNumberValue('bam-range-narration-line-height', defaults.style_narrationLineHeight),
      style_narrationPaddingRight: getNumberValue('bam-range-narration-padding-right', defaults.style_narrationPaddingRight),
      style_imageCompressEnabled: doc.getElementById('bam-chk-compress-enabled')?.checked !== false,
      style_imageCompressQuality: getNumberValue('bam-range-compress-quality', defaults.style_imageCompressQuality),
    };
  }

  async _applyBubblePreviewStyles(styleSettings = null) {
    const settings = { ...this._getDefaultStyleSettings(), ...(styleSettings || this._getLiveStyleSettings()) };
    const frames = this._getBubbleRenderFrames();
    if (!frames.length) return false;

    const dialogueLineHeight = this._getDialogueLineHeight(settings.style_dialogueFontSize, settings.style_dialogueSpacing);
    const narrationBackground = hexToRgba(settings.style_narrationBgColor, settings.style_narrationBgOpacity);
    const avatarSize = clampNumber(settings.style_avatarSize, 36, 88);
    const narrationIndent = clampNumber(settings.style_narrationIndent, 0, 120);
    const narrationFontStack = this._composeFontStack(settings.style_narrationFontFamily, '"Source Han Sans SC",sans-serif');
    const dialogueFontStack = this._composeFontStack(settings.style_dialogueFontFamily, '"Source Han Serif SC",serif');
    const nameFontStack = this._composeFontStack(settings.style_nameFontFamily, '"Source Han Serif SC",serif');
    const narrationBorderRadius = clampNumber(settings.style_narrationBorderRadius, 0, 24);
    const avatarShapeRadius = settings.style_avatarShape === 'circle' ? '50%' : settings.style_avatarShape === 'square' ? '0px' : '8px';
    const thoughtSuffixGap = clampNumber(settings.style_thoughtSuffixGap, 0, 24);
    const thoughtSuffixOffsetY = clampNumber(settings.style_thoughtSuffixOffsetY, -24, 24);

    for (const frame of frames) {
      let frameDoc;
      try {
        frameDoc = frame.contentDocument;
      } catch (_) {
        continue;
      }
      const root = frameDoc?.getElementById('dcRoot');
      if (!root) continue;

      await this._ensurePreviewFontResources(frameDoc, settings);

      const msgNodes = Array.from(root.querySelectorAll('.dc-msg'));
      const nameColors = new Map();
      if (settings.style_textColorMode === 'character' && msgNodes.length) {
        const charId = this._charId || getCurrentCharId() || GLOBAL_CHAR_ID;
        const names = [...new Set(msgNodes.map((msg) => msg.dataset.name?.trim().toLowerCase()).filter(Boolean))];
        await Promise.all(names.map(async (n) => {
          nameColors.set(n, await this.db.getConfig(buildColorConfigKey(charId, n), null));
        }));
      }

      msgNodes.forEach((msg) => {
        const textEl = msg.querySelector('.dc-msg-text');
        if (!textEl) return;
        const msgName = msg.dataset.name?.trim().toLowerCase();
        const textColor = settings.style_textColorMode === 'character'
          ? nameColors.get(msgName) || settings.style_globalTextColor
          : settings.style_globalTextColor;
        const messagePaddingLeft = avatarSize + 24;
        textEl.style.fontSize = `${settings.style_dialogueFontSize}px`;
        textEl.style.lineHeight = `${dialogueLineHeight}px`;
        textEl.style.color = textColor;
        textEl.style.fontWeight = String(settings.style_dialogueFontWeight);
        textEl.style.fontFamily = dialogueFontStack;
        const thoughtTextEl = msg.querySelector('.dc-msg-text-content-thought');
        if (thoughtTextEl) {
          thoughtTextEl.style.display = 'inline';
          thoughtTextEl.style.maxWidth = '';
          thoughtTextEl.style.transform = 'none';
          thoughtTextEl.style.transformOrigin = '';
          thoughtTextEl.style.verticalAlign = 'baseline';
        }
        const thoughtQuoteEl = msg.querySelector('.dc-msg-quote-thought');
        if (thoughtQuoteEl) {
          thoughtQuoteEl.style.marginLeft = `${thoughtSuffixGap}px`;
          thoughtQuoteEl.style.top = `${thoughtSuffixOffsetY}px`;
          thoughtQuoteEl.style.lineHeight = '1';
          thoughtQuoteEl.style.height = 'auto';
          thoughtQuoteEl.style.verticalAlign = 'baseline';
        }

        const nameEl = msg.querySelector('.dc-msg-name');
        if (nameEl) {
          nameEl.style.color = settings.style_globalTextColor;
          nameEl.style.fontWeight = String(settings.style_nameFontWeight);
          nameEl.style.fontFamily = nameFontStack;
        }
        msg.querySelectorAll('.dc-cn').forEach((charEl) => {
          charEl.style.color = settings.style_globalTextColor;
        });

        const avatarEl = msg.querySelector('.dc-msg-avatar');
        if (avatarEl) {
          avatarEl.style.width = `${avatarSize}px`;
          avatarEl.style.height = `${avatarSize}px`;
          avatarEl.style.borderRadius = avatarShapeRadius;
        }
        const avatarImg = msg.querySelector('.dc-msg-avatar img');
        if (avatarImg) {
          avatarImg.style.width = '100%';
          avatarImg.style.height = '100%';
          avatarImg.style.borderRadius = avatarShapeRadius;
        }
        const avatarPlaceholder = msg.querySelector('.dc-msg-avatar-ph');
        if (avatarPlaceholder) {
          avatarPlaceholder.style.fontSize = `${Math.max(16, Math.round(avatarSize * 0.38))}px`;
          avatarPlaceholder.style.borderRadius = avatarShapeRadius;
        }
        msg.style.paddingLeft = `${messagePaddingLeft}px`;
        msg.style.minHeight = `${Math.max(56, avatarSize + 4)}px`;
      });

      root.querySelectorAll('.dc-narration-block').forEach((narrationEl) => {
        narrationEl.style.fontSize = `${settings.style_narrationFontSize}px`;
        narrationEl.style.color = settings.style_globalTextColor;
        narrationEl.style.fontWeight = String(settings.style_narrationFontWeight);
        narrationEl.style.fontFamily = narrationFontStack;
        narrationEl.style.background = narrationBackground;
        narrationEl.style.paddingLeft = `${narrationIndent}px`;
        narrationEl.style.borderRadius = `${narrationBorderRadius}px`;
        narrationEl.style.lineHeight = String(clampNumber(settings.style_narrationLineHeight, 1.2, 3.0));
        narrationEl.style.paddingRight = `${clampNumber(settings.style_narrationPaddingRight, 0, 120)}px`;
        narrationEl.querySelectorAll('p').forEach((p) => {
          p.style.textIndent = `${clampNumber(settings.style_narrationTextIndent, 0, 4)}em`;
        });
      });
    }

    return true;
  }

  _reloadBubbleFrame(frame) {
    try {
      if (typeof frame.srcdoc === 'string' && frame.srcdoc.includes('id="dcRoot"')) {
        const cachedBaseSrcdoc = frame.dataset.bamBaseSrcdoc;
        const normalizedSrcdoc = typeof cachedBaseSrcdoc === 'string' && cachedBaseSrcdoc.includes('id="dcRoot"')
          ? cachedBaseSrcdoc
          : frame.srcdoc.replace(/\n$/u, '');
        frame.dataset.bamBaseSrcdoc = normalizedSrcdoc;
        frame.srcdoc = `${normalizedSrcdoc}\n`;
        return true;
      }
      frame.contentWindow?.location?.reload?.();
      return true;
    } catch (err) {
      console.warn('Bubble 预览刷新失败:', err);
      return false;
    }
  }

  _refreshBubblePreview() {
    const frames = this._getBubbleRenderFrames();
    if (!frames.length) {
      console.warn('Bubble 预览刷新跳过：未找到可重载的气泡 iframe');
      return;
    }
    frames.forEach((frame) => this._reloadBubbleFrame(frame));
  }

  _scheduleBubblePreviewRefresh(delay = 80) {
    if (this._livePreviewTimer) clearTimeout(this._livePreviewTimer);
    this._livePreviewTimer = setTimeout(() => {
      this._livePreviewTimer = null;
      this._refreshBubblePreview();
    }, delay);
  }

  _requestBubblePreviewRefresh(delay = 80, deferUntilPanelClose = false) {
    if (deferUntilPanelClose && this.isOpen) {
      this._pendingBubbleRefreshDelay = this._pendingBubbleRefresh
        ? Math.min(this._pendingBubbleRefreshDelay, delay)
        : delay;
      this._pendingBubbleRefresh = true;
      return;
    }
    this._scheduleBubblePreviewRefresh(delay);
  }

  _requestAvatarAssetPreviewRefresh(delay = 80) {
    this._requestBubblePreviewRefresh(delay, true);
  }

  async open() {
    if (this.isOpen) { this.close(); }
    this.isOpen = true;
    try {
      await this.db.init();

      this._charId = getCurrentCharId() || GLOBAL_CHAR_ID;
      this._charName = getCurrentCharName();
      this._expandedMoodName = null;

      const doc = this._getMainDocument();
      this._mainWindow = this._getMainWindow();

      const styleEl = doc.createElement('style');
      styleEl.id = 'bam-style';
      doc.head.appendChild(styleEl);
      this._syncOverlayLayout();
      this._bindViewportSync();

      if (this._mainWindow?.document !== doc) {
        console.warn('AvatarManagerPanel: 主窗口与主文档不一致，已回退使用父页面文档渲染');
      }

      const container = doc.createElement('div');
      container.id = 'bam-container';
      container.innerHTML = this._panelHTML();
      doc.body.appendChild(container);
      this._panelOffset = { x: 0, y: 0 };
      this._setupPanelDrag();
      this._syncPanelPosition();
      this._setupColorPickerProxy();

      this._bindEvents();
      await this._refreshList();
    } catch (err) {
      this.isOpen = false;
      console.error('[BubbleDialogue] open() 执行出错:', err);
      throw err;
    }
  }

  close() {
    const doc = this._getMainDocument();
    const shouldRefreshAfterClose = this._pendingBubbleRefresh;
    const refreshDelay = this._pendingBubbleRefreshDelay;
    this._unbindViewportSync();
    this._teardownPanelDrag();
    if (this._livePreviewTimer) {
      clearTimeout(this._livePreviewTimer);
      this._livePreviewTimer = null;
    }
    const el = doc.getElementById('bam-container');
    if (el) el.remove();
    const st = doc.getElementById('bam-style');
    if (st) st.remove();
    this._mainWindow = null;
    this.pendingFile = null;
    this._styleDraftLoaded = false;
    this._styleDraftDirty = false;
    this._moodConfigLoaded = false;
    this._moodConfigDirty = false;
    this._moodConfigDraft = null;
    this._formatRuleDraft = null;
    this._pendingBubbleRefresh = false;
    this._pendingBubbleRefreshDelay = 0;
    this._panelOffset = { x: 0, y: 0 };
    this._charId = '';
    this._charName = '';
    this._expandedMoodName = null;
    this.isOpen = false;
    if (shouldRefreshAfterClose) this._scheduleBubblePreviewRefresh(refreshDelay);
  }

  // -- HTML 模板 --

  _panelHTML() {
    return `
  <div id="bam-panel" style="
    background:#1a1a2e; border-radius:16px; width:460px; max-width:calc(100vw - 32px);
    display:flex; flex-direction:column;
    box-shadow:0 20px 60px rgba(0,0,0,0.5);
    border:1px solid rgba(255,255,255,0.08); overflow:hidden;
    will-change:transform; transition:transform 0.12s ease-out;
  ">
    <div id="bam-drag-handle" style="display:flex; align-items:center; justify-content:space-between;
      padding:16px 20px 12px; border-bottom:1px solid rgba(255,255,255,0.06); cursor:grab; touch-action:none;">
      <div style="display:flex; align-items:center; gap:10px; min-width:0;">
        <span style="display:inline-flex; flex-direction:column; gap:3px; opacity:0.45;">
          <span style="display:block; width:14px; height:2px; border-radius:999px; background:rgba(255,255,255,0.55);"></span>
          <span style="display:block; width:14px; height:2px; border-radius:999px; background:rgba(255,255,255,0.55);"></span>
        </span>
        <div style="font-size:16px; font-weight:600; color:#e0e0e0;">对话气泡</div>
      </div>
      <div style="display:flex; gap:8px;">
        <button id="bam-btn-import" style="background:rgba(255,255,255,0.06); border:none; color:#aaa;
          padding:6px 12px; border-radius:6px; cursor:pointer; font-size:12px;">导入</button>
        <button id="bam-btn-export" style="background:rgba(255,255,255,0.06); border:none; color:#aaa;
          padding:6px 12px; border-radius:6px; cursor:pointer; font-size:12px;">导出</button>
        <button id="bam-btn-close" style="background:none; border:none; color:#888;
          font-size:20px; cursor:pointer; padding:0 4px; line-height:1;">&times;</button>
      </div>
    </div>

    <div id="bam-tab-bar" style="display:flex; padding:0 20px; border-bottom:1px solid rgba(255,255,255,0.06);">
      <button class="bam-tab-btn bam-tab-active" data-tab="avatar" style="
        flex:1; padding:10px 0; border:none; background:none; color:#e0e0e0; font-size:13px;
        font-weight:600; cursor:pointer; border-bottom:2px solid #4a6cf7; transition:all 0.2s;">头像管理</button>
      <button class="bam-tab-btn" data-tab="style" style="
        flex:1; padding:10px 0; border:none; background:none; color:#666; font-size:13px;
        font-weight:500; cursor:pointer; border-bottom:2px solid transparent; transition:all 0.2s;">正文美化</button>
      <button class="bam-tab-btn" data-tab="mood" style="
        flex:1; padding:10px 0; border:none; background:none; color:#666; font-size:13px;
        font-weight:500; cursor:pointer; border-bottom:2px solid transparent; transition:all 0.2s;">情绪配置</button>
    </div>

    <div id="bam-tab-avatar" style="display:flex; flex-direction:column; flex:1; overflow-y:auto; -webkit-overflow-scrolling:touch;">
      <div id="bam-char-info" style="padding:8px 20px; font-size:12px; color:#888; border-bottom:1px solid rgba(255,255,255,0.04); display:flex; flex-direction:column; gap:6px;">
        <div style="display:flex; align-items:center; gap:6px;">
          <span style="opacity:0.6;">📋</span>
          <span>当前角色卡: <span id="bam-char-name" style="color:#ccc;">—</span></span>
        </div>
        <div style="display:flex; align-items:center; gap:12px;">
          <span style="color:#888; font-size:11px;">操作目标:</span>
          <label style="display:flex; align-items:center; gap:4px; cursor:pointer;">
            <input type="radio" name="bam-target-scope" value="character" checked style="accent-color:#4a6cf7;" />
            <span style="color:#bbb; font-size:11px;">当前角色卡</span>
          </label>
          <label style="display:flex; align-items:center; gap:4px; cursor:pointer;">
            <input type="radio" name="bam-target-scope" value="global" style="accent-color:#4a6cf7;" />
            <span style="color:#bbb; font-size:11px;">全局（跨卡共享）</span>
          </label>
        </div>
      </div>
      <div id="bam-upload-area" style="
        margin:16px 20px 8px; border:2px dashed rgba(255,255,255,0.12);
        border-radius:12px; padding:20px; text-align:center; cursor:pointer; transition:all 0.2s;
      ">
        <div style="font-size:28px; margin-bottom:6px;">+</div>
        <div style="color:#888; font-size:13px;">点击或拖拽图片到此处上传</div>
        <div style="color:#555; font-size:11px; margin-top:4px;">支持 JPG / PNG / GIF / WebP，最大 2MB，推荐 200×200 正方形</div>
        <input id="bam-file-input" type="file" accept="image/jpeg,image/png,image/gif,image/webp" style="display:none;" />
      </div>
      <div style="text-align:center; margin:0 20px 8px;">
        <button id="bam-btn-add-remote-avatar" style="background:none; border:1px dashed rgba(74,108,247,0.3); color:#8ba4f7; padding:6px 16px; border-radius:8px; cursor:pointer; font-size:12px; width:100%;">🔗 使用远程图片 URL</button>
      </div>

      <div id="bam-alias-input-area" style="display:none; margin:8px 20px; padding:12px 16px; background:rgba(255,255,255,0.04); border-radius:10px;">
        <div style="display:flex; align-items:center; gap:8px; margin-bottom:8px;">
          <img id="bam-preview-img" style="width:44px; height:44px; border-radius:50%; object-fit:cover; border:2px solid rgba(255,255,255,0.1);" />
          <div style="flex:1;">
            <div style="color:#ccc; font-size:12px; margin-bottom:4px;">设置角色名（AI 输出时使用的全名）</div>
            <input id="bam-alias-input" type="text" placeholder="例如: 城崎诺亚" style="width:100%; background:rgba(0,0,0,0.3); border:1px solid rgba(255,255,255,0.1); border-radius:6px; padding:6px 10px; color:#e0e0e0; font-size:14px; outline:none; box-sizing:border-box;" />
          </div>
        </div>
        <div style="display:flex; align-items:center; gap:8px; margin-bottom:8px;">
          <div style="color:#ccc; font-size:12px; flex-shrink:0;">角色主题色</div>
          <div id="bam-color-presets" style="display:flex; gap:4px; flex-wrap:wrap;">
            <span class="bam-color-dot" data-color="#f47b67" style="width:22px;height:22px;border-radius:50%;background:#f47b67;cursor:pointer;border:2px solid transparent;display:inline-block;"></span>
            <span class="bam-color-dot" data-color="#45ddc0" style="width:22px;height:22px;border-radius:50%;background:#45ddc0;cursor:pointer;border:2px solid transparent;display:inline-block;"></span>
            <span class="bam-color-dot" data-color="#e78bff" style="width:22px;height:22px;border-radius:50%;background:#e78bff;cursor:pointer;border:2px solid transparent;display:inline-block;"></span>
            <span class="bam-color-dot" data-color="#f0b232" style="width:22px;height:22px;border-radius:50%;background:#f0b232;cursor:pointer;border:2px solid transparent;display:inline-block;"></span>
            <span class="bam-color-dot" data-color="#58a6ff" style="width:22px;height:22px;border-radius:50%;background:#58a6ff;cursor:pointer;border:2px solid transparent;display:inline-block;"></span>
            <span class="bam-color-dot" data-color="#ff9a76" style="width:22px;height:22px;border-radius:50%;background:#ff9a76;cursor:pointer;border:2px solid transparent;display:inline-block;"></span>
            <span class="bam-color-dot" data-color="#7ee787" style="width:22px;height:22px;border-radius:50%;background:#7ee787;cursor:pointer;border:2px solid transparent;display:inline-block;"></span>
            <span class="bam-color-dot" data-color="#d2a8ff" style="width:22px;height:22px;border-radius:50%;background:#d2a8ff;cursor:pointer;border:2px solid transparent;display:inline-block;"></span>
          </div>
          <input id="bam-color-input" type="color" value="#58a6ff" style="width:28px;height:28px;border:none;background:none;cursor:pointer;padding:0;" title="自定义颜色" />
        </div>
        <div style="display:flex; gap:8px; justify-content:flex-end;">
          <button id="bam-btn-cancel-upload" style="background:rgba(255,255,255,0.06); border:none; color:#aaa; padding:6px 16px; border-radius:6px; cursor:pointer; font-size:13px;">取消</button>
          <button id="bam-btn-confirm-upload" style="background:#4a6cf7; border:none; color:white; padding:6px 16px; border-radius:6px; cursor:pointer; font-size:13px;">确认添加</button>
        </div>
      </div>

      <div id="bam-avatar-list" style="flex:1; overflow-y:auto; padding:8px 20px 16px; min-height:100px;">
        <div id="bam-empty-tip" style="text-align:center; color:#555; padding:30px 0; font-size:13px;">还没有头像，点击上方区域添加</div>
      </div>

      <div id="bam-stats" style="padding:10px 20px; border-top:1px solid rgba(255,255,255,0.06); font-size:12px; color:#555; text-align:center;">已存储: 0 张 | 总计: 0 KB</div>

      <div id="bam-remote-actions" style="padding:6px 20px 10px; display:flex; gap:8px; flex-wrap:wrap; justify-content:center; border-top:1px solid rgba(255,255,255,0.04);">
        <button id="bam-btn-fetch-remote" style="background:rgba(74,108,247,0.12); border:1px solid rgba(74,108,247,0.25); color:#b9c7ff; padding:5px 12px; border-radius:6px; cursor:pointer; font-size:11px;">拉取远程头像</button>
        <button id="bam-btn-clear-remote-cache" style="background:rgba(255,80,80,0.08); border:1px solid rgba(255,80,80,0.2); color:#e88; padding:5px 12px; border-radius:6px; cursor:pointer; font-size:11px;">清除远程缓存</button>
      </div>

      <div id="bam-cg-section" style="border-top:1px solid rgba(255,255,255,0.06);">
        <div id="bam-cg-header" style="display:flex; align-items:center; justify-content:space-between; padding:10px 20px; cursor:pointer; user-select:none;" data-collapsed="true">
          <span style="color:#888; font-size:12px; font-weight:600;">CG 图片库</span>
          <span id="bam-cg-toggle" style="color:#666; font-size:11px;">▶</span>
        </div>
        <div id="bam-cg-body" style="display:none; padding:0 20px 12px; max-height:50vh; overflow-y:auto; -webkit-overflow-scrolling:touch;">
          <div id="bam-cg-group-list" style="margin-bottom:10px;"></div>
          <div style="display:flex; gap:8px; flex-wrap:wrap;">
            <button id="bam-btn-add-cg-group" style="background:rgba(74,108,247,0.12); border:1px solid rgba(74,108,247,0.25); color:#b9c7ff; padding:5px 10px; border-radius:6px; cursor:pointer; font-size:11px;">手动添加组</button>
            <button id="bam-btn-clear-all-cg" style="background:rgba(255,80,80,0.08); border:1px solid rgba(255,80,80,0.2); color:#e88; padding:5px 10px; border-radius:6px; cursor:pointer; font-size:11px;">清除全部CG缓存</button>
          </div>
        </div>
      </div>
    </div>

    <div id="bam-tab-style" style="display:none; flex-direction:column; flex:1; overflow-y:auto; padding:16px 20px;">
      <div style="color:#666; font-size:11px; text-transform:uppercase; letter-spacing:1px; margin-bottom:10px; border-bottom:1px solid rgba(255,255,255,0.06); padding-bottom:6px;">文字</div>

      <div style="margin-bottom:16px;">
        <div style="display:flex; justify-content:space-between; margin-bottom:6px;"><span style="color:#ccc; font-size:13px;">台词字号</span><span id="bam-val-dialogue-font" style="color:#888; font-size:12px;">${STYLE_DEFAULTS.style_dialogueFontSize}px</span></div>
        <input id="bam-range-dialogue-font" type="range" min="12" max="22" step="0.5" value="${STYLE_DEFAULTS.style_dialogueFontSize}" style="width:100%; accent-color:#4a6cf7; cursor:pointer;" />
      </div>
      <div style="margin-bottom:16px;">
        <div style="display:flex; justify-content:space-between; margin-bottom:6px;"><span style="color:#ccc; font-size:13px;">旁白字号</span><span id="bam-val-narration-font" style="color:#888; font-size:12px;">${STYLE_DEFAULTS.style_narrationFontSize}px</span></div>
        <input id="bam-range-narration-font" type="range" min="12" max="22" step="0.5" value="${STYLE_DEFAULTS.style_narrationFontSize}" style="width:100%; accent-color:#4a6cf7; cursor:pointer;" />
      </div>
      <div style="margin-bottom:16px;">
        <div style="display:flex; justify-content:space-between; margin-bottom:6px;"><span style="color:#ccc; font-size:13px;">台词行距</span><span id="bam-val-dialogue-spacing" style="color:#888; font-size:12px;">${STYLE_DEFAULTS.style_dialogueSpacing}px</span></div>
        <input id="bam-range-dialogue-spacing" type="range" min="4" max="24" step="1" value="${STYLE_DEFAULTS.style_dialogueSpacing}" style="width:100%; accent-color:#4a6cf7; cursor:pointer;" />
      </div>
      <div style="margin-bottom:16px;">
        <div style="display:flex; justify-content:space-between; margin-bottom:6px;"><span style="color:#ccc; font-size:13px;">台词字重</span><span id="bam-val-dialogue-weight" style="color:#888; font-size:12px;">${STYLE_DEFAULTS.style_dialogueFontWeight}</span></div>
        <input id="bam-range-dialogue-weight" type="range" min="100" max="900" step="10" value="${STYLE_DEFAULTS.style_dialogueFontWeight}" style="width:100%; accent-color:#4a6cf7; cursor:pointer;" />
      </div>
      <div style="margin-bottom:16px;">
        <div style="display:flex; justify-content:space-between; margin-bottom:6px;"><span style="color:#ccc; font-size:13px;">旁白字重</span><span id="bam-val-narration-weight" style="color:#888; font-size:12px;">${STYLE_DEFAULTS.style_narrationFontWeight}</span></div>
        <input id="bam-range-narration-weight" type="range" min="100" max="900" step="10" value="${STYLE_DEFAULTS.style_narrationFontWeight}" style="width:100%; accent-color:#4a6cf7; cursor:pointer;" />
      </div>
      <div style="margin-bottom:20px;">
        <div style="display:flex; justify-content:space-between; margin-bottom:6px;"><span style="color:#ccc; font-size:13px;">角色名字重</span><span id="bam-val-name-weight" style="color:#888; font-size:12px;">${STYLE_DEFAULTS.style_nameFontWeight}</span></div>
        <input id="bam-range-name-weight" type="range" min="100" max="900" step="10" value="${STYLE_DEFAULTS.style_nameFontWeight}" style="width:100%; accent-color:#4a6cf7; cursor:pointer;" />
      </div>

      <div style="color:#666; font-size:11px; text-transform:uppercase; letter-spacing:1px; margin-bottom:10px; border-bottom:1px solid rgba(255,255,255,0.06); padding-bottom:6px;">颜色</div>
      <div style="margin-bottom:20px;">
        <label style="display:flex; align-items:center; gap:8px; margin-bottom:8px; cursor:pointer;">
          <input type="radio" name="bam-color-mode" value="global" checked style="accent-color:#4a6cf7;" />
          <span style="color:#ccc; font-size:13px;">全局统一色</span>
          <input id="bam-global-color-picker" type="color" value="${STYLE_DEFAULTS.style_globalTextColor}" style="width:28px; height:28px; border:none; background:none; cursor:pointer; padding:0; margin-left:auto;" />
        </label>
        <label style="display:flex; align-items:center; gap:8px; cursor:pointer;">
          <input type="radio" name="bam-color-mode" value="character" style="accent-color:#4a6cf7;" />
          <span style="color:#ccc; font-size:13px;">跟随角色主题色</span>
        </label>
        <div style="color:#555; font-size:11px; margin-top:6px; padding-left:24px;">旁白颜色始终跟随全局统一色</div>
      </div>
      <div style="display:flex; gap:12px; margin-bottom:10px; align-items:center;">
        <label style="display:flex; align-items:center; gap:8px; flex:1; min-width:0;">
          <span style="color:#ccc; font-size:13px; flex-shrink:0;">旁白背景色</span>
          <input id="bam-narration-bg-color" type="color" value="${STYLE_DEFAULTS.style_narrationBgColor}" style="width:36px; height:30px; border:none; background:none; cursor:pointer; padding:0;" />
        </label>
        <div style="flex:1; min-width:0;">
          <div style="display:flex; justify-content:space-between; margin-bottom:6px;"><span style="color:#ccc; font-size:13px;">旁白透明度</span><span id="bam-val-narration-bg-opacity" style="color:#888; font-size:12px;">${STYLE_DEFAULTS.style_narrationBgOpacity.toFixed(2)}</span></div>
          <input id="bam-range-narration-bg-opacity" type="range" min="0" max="0.4" step="0.01" value="${STYLE_DEFAULTS.style_narrationBgOpacity}" style="width:100%; accent-color:#4a6cf7; cursor:pointer;" />
        </div>
      </div>

      <div style="color:#666; font-size:11px; text-transform:uppercase; letter-spacing:1px; margin:20px 0 10px; border-bottom:1px solid rgba(255,255,255,0.06); padding-bottom:6px;">布局</div>
      <div style="margin-bottom:16px;">
        <div style="display:flex; justify-content:space-between; margin-bottom:6px;"><span style="color:#ccc; font-size:13px;">头像大小</span><span id="bam-val-avatar-size" style="color:#888; font-size:12px;">${STYLE_DEFAULTS.style_avatarSize}px</span></div>
        <input id="bam-range-avatar-size" type="range" min="36" max="88" step="1" value="${STYLE_DEFAULTS.style_avatarSize}" style="width:100%; accent-color:#4a6cf7; cursor:pointer;" />
      </div>
      <div style="margin-bottom:16px;">
        <div style="color:#ccc; font-size:13px; margin-bottom:6px;">头像形状</div>
        <div style="display:flex; gap:12px;">
          <label style="display:flex; align-items:center; gap:6px; cursor:pointer;">
            <input type="radio" name="bam-avatar-shape" value="rounded" checked style="accent-color:#4a6cf7;" />
            <span style="color:#bbb; font-size:12px;">圆角矩形</span>
          </label>
          <label style="display:flex; align-items:center; gap:6px; cursor:pointer;">
            <input type="radio" name="bam-avatar-shape" value="circle" style="accent-color:#4a6cf7;" />
            <span style="color:#bbb; font-size:12px;">纯圆形</span>
          </label>
          <label style="display:flex; align-items:center; gap:6px; cursor:pointer;">
            <input type="radio" name="bam-avatar-shape" value="square" style="accent-color:#4a6cf7;" />
            <span style="color:#bbb; font-size:12px;">纯方形</span>
          </label>
        </div>
      </div>
      <div style="margin-bottom:16px;">
        <div style="display:flex; justify-content:space-between; margin-bottom:6px;"><span style="color:#ccc; font-size:13px;">旁白左侧留白</span><span id="bam-val-narration-indent" style="color:#888; font-size:12px;">${STYLE_DEFAULTS.style_narrationIndent}px</span></div>
        <input id="bam-range-narration-indent" type="range" min="0" max="120" step="2" value="${STYLE_DEFAULTS.style_narrationIndent}" style="width:100%; accent-color:#4a6cf7; cursor:pointer;" />
      </div>
      <div style="margin-bottom:16px;">
        <div style="display:flex; justify-content:space-between; margin-bottom:6px;"><span style="color:#ccc; font-size:13px;">旁白圆角</span><span id="bam-val-narration-border-radius" style="color:#888; font-size:12px;">${STYLE_DEFAULTS.style_narrationBorderRadius}px</span></div>
        <input id="bam-range-narration-border-radius" type="range" min="0" max="24" step="1" value="${STYLE_DEFAULTS.style_narrationBorderRadius}" style="width:100%; accent-color:#4a6cf7; cursor:pointer;" />
      </div>
      <div style="margin-bottom:16px;">
        <div style="display:flex; justify-content:space-between; margin-bottom:6px;"><span style="color:#ccc; font-size:13px;">旁白首行缩进</span><span id="bam-val-narration-text-indent" style="color:#888; font-size:12px;">${STYLE_DEFAULTS.style_narrationTextIndent}em</span></div>
        <input id="bam-range-narration-text-indent" type="range" min="0" max="4" step="0.5" value="${STYLE_DEFAULTS.style_narrationTextIndent}" style="width:100%; accent-color:#4a6cf7; cursor:pointer;" />
      </div>
      <div style="margin-bottom:16px;">
        <div style="display:flex; justify-content:space-between; margin-bottom:6px;"><span style="color:#ccc; font-size:13px;">旁白行距</span><span id="bam-val-narration-line-height" style="color:#888; font-size:12px;">${STYLE_DEFAULTS.style_narrationLineHeight}</span></div>
        <input id="bam-range-narration-line-height" type="range" min="1.2" max="3.0" step="0.05" value="${STYLE_DEFAULTS.style_narrationLineHeight}" style="width:100%; accent-color:#4a6cf7; cursor:pointer;" />
      </div>
      <div style="margin-bottom:16px;">
        <div style="display:flex; justify-content:space-between; margin-bottom:6px;"><span style="color:#ccc; font-size:13px;">旁白右边距</span><span id="bam-val-narration-padding-right" style="color:#888; font-size:12px;">${STYLE_DEFAULTS.style_narrationPaddingRight}px</span></div>
        <input id="bam-range-narration-padding-right" type="range" min="0" max="120" step="2" value="${STYLE_DEFAULTS.style_narrationPaddingRight}" style="width:100%; accent-color:#4a6cf7; cursor:pointer;" />
      </div>
      <div style="margin-bottom:16px;">
        <div style="display:flex; justify-content:space-between; margin-bottom:6px;"><span style="color:#ccc; font-size:13px;">心里话尾符间距</span><span id="bam-val-thought-suffix-gap" style="color:#888; font-size:12px;">${STYLE_DEFAULTS.style_thoughtSuffixGap}px</span></div>
        <input id="bam-range-thought-suffix-gap" type="range" min="0" max="24" step="1" value="${STYLE_DEFAULTS.style_thoughtSuffixGap}" style="width:100%; accent-color:#4a6cf7; cursor:pointer;" />
      </div>
      <div style="margin-bottom:20px;">
        <div style="display:flex; justify-content:space-between; margin-bottom:6px;"><span style="color:#ccc; font-size:13px;">心里话尾符上下偏移</span><span id="bam-val-thought-suffix-offset-y" style="color:#888; font-size:12px;">${STYLE_DEFAULTS.style_thoughtSuffixOffsetY}px</span></div>
        <input id="bam-range-thought-suffix-offset-y" type="range" min="-24" max="24" step="1" value="${STYLE_DEFAULTS.style_thoughtSuffixOffsetY}" style="width:100%; accent-color:#4a6cf7; cursor:pointer;" />
      </div>

      <div style="color:#666; font-size:11px; text-transform:uppercase; letter-spacing:1px; margin:20px 0 10px; border-bottom:1px solid rgba(255,255,255,0.06); padding-bottom:6px;">字体</div>
      <div style="display:grid; gap:12px; margin-bottom:14px;">
        <label style="display:flex; flex-direction:column; gap:6px;">
          <span style="color:#ccc; font-size:13px;">旁白字体</span>
          <select id="bam-select-narration-font" style="background:rgba(0,0,0,0.28); border:1px solid rgba(255,255,255,0.08); color:#e0e0e0; border-radius:8px; padding:8px 10px;"></select>
        </label>
        <label style="display:flex; flex-direction:column; gap:6px;">
          <span style="color:#ccc; font-size:13px;">台词字体</span>
          <select id="bam-select-dialogue-font" style="background:rgba(0,0,0,0.28); border:1px solid rgba(255,255,255,0.08); color:#e0e0e0; border-radius:8px; padding:8px 10px;"></select>
        </label>
        <label style="display:flex; flex-direction:column; gap:6px;">
          <span style="color:#ccc; font-size:13px;">角色名字体</span>
          <select id="bam-select-name-font" style="background:rgba(0,0,0,0.28); border:1px solid rgba(255,255,255,0.08); color:#e0e0e0; border-radius:8px; padding:8px 10px;"></select>
        </label>
      </div>
      <label style="display:flex; flex-direction:column; gap:6px; margin-bottom:10px;">
        <span style="color:#ccc; font-size:13px;">远程字体配置 URL</span>
        <input id="bam-font-url-input" type="url" placeholder="https://example.com/fonts.json" value="${STYLE_DEFAULTS.style_fontConfigUrl}" style="background:rgba(0,0,0,0.28); border:1px solid rgba(255,255,255,0.08); color:#e0e0e0; border-radius:8px; padding:8px 10px;" />
      </label>
      <div style="display:flex; justify-content:flex-end; margin-bottom:20px;">
        <button id="bam-btn-refresh-fonts" style="background:rgba(74,108,247,0.16); border:1px solid rgba(74,108,247,0.35); color:#b9c7ff; padding:8px 12px; border-radius:8px; cursor:pointer; font-size:12px;">刷新字体列表</button>
      </div>

      <label style="display:flex; flex-direction:column; gap:6px; margin-bottom:10px;">
        <span style="color:#ccc; font-size:13px;">在线 CSS 字体导入</span>
        <div style="display:flex; gap:8px;">
          <input id="bam-css-font-url-input" type="url" placeholder="https://fontsapi.xxx.com/.../result.css" style="flex:1; background:rgba(0,0,0,0.28); border:1px solid rgba(255,255,255,0.08); color:#e0e0e0; border-radius:8px; padding:8px 10px; min-width:0;" />
          <button id="bam-btn-import-css-font" style="background:rgba(74,108,247,0.16); border:1px solid rgba(74,108,247,0.35); color:#b9c7ff; padding:8px 12px; border-radius:8px; cursor:pointer; font-size:12px; white-space:nowrap;">解析并导入</button>
        </div>
      </label>
      <div id="bam-css-font-sources" style="margin-bottom:16px; max-height:150px; overflow-y:auto;"></div>

      <div style="display:flex; align-items:center; justify-content:space-between; margin-bottom:8px;">
        <span style="color:#ccc; font-size:13px;">本地字体</span>
        <button id="bam-btn-upload-local-font" style="background:rgba(74,108,247,0.16); border:1px solid rgba(74,108,247,0.35); color:#b9c7ff; padding:6px 12px; border-radius:8px; cursor:pointer; font-size:12px;">+ 上传字体文件</button>
        <input id="bam-local-font-input" type="file" accept="${LOCAL_FONT_ACCEPT}" style="display:none;" />
      </div>
      <div id="bam-local-font-list" style="margin-bottom:20px; max-height:150px; overflow-y:auto;"></div>

      <div style="color:#666; font-size:11px; text-transform:uppercase; letter-spacing:1px; margin:20px 0 10px; border-bottom:1px solid rgba(255,255,255,0.06); padding-bottom:6px;">存储优化</div>
      <div style="margin-bottom:10px;">
        <label style="display:flex; align-items:center; gap:8px; cursor:pointer;">
          <input id="bam-chk-compress-enabled" type="checkbox" checked style="accent-color:#4a6cf7;" />
          <span style="color:#ccc; font-size:13px;">自动压缩图片（存储前转为 WebP）</span>
        </label>
      </div>
      <div style="margin-bottom:16px;">
        <div style="display:flex; justify-content:space-between; margin-bottom:6px;"><span style="color:#ccc; font-size:13px;">压缩质量</span><span id="bam-val-compress-quality" style="color:#888; font-size:12px;">${STYLE_DEFAULTS.style_imageCompressQuality.toFixed(2)}</span></div>
        <input id="bam-range-compress-quality" type="range" min="0.5" max="1.0" step="0.01" value="${STYLE_DEFAULTS.style_imageCompressQuality}" style="width:100%; accent-color:#4a6cf7; cursor:pointer;" />
        <div style="color:#555; font-size:11px; margin-top:4px;">质量 0.8 视觉几乎无损，体积可减少 30~60%。设为 1.0 则近似无损。</div>
      </div>

      <div style="color:#666; font-size:11px; text-transform:uppercase; letter-spacing:1px; margin:20px 0 10px; border-bottom:1px solid rgba(255,255,255,0.06); padding-bottom:6px;">Markdown 渲染</div>
      <div style="margin-bottom:20px;">
        <label style="display:flex; align-items:center; gap:8px; margin-bottom:8px; cursor:pointer;">
          <input type="radio" name="bam-md-mode" value="basic" checked style="accent-color:#4a6cf7;" />
          <span style="color:#ccc; font-size:13px;">基础（粗体 / 斜体 / 删除线）</span>
        </label>
        <label style="display:flex; align-items:center; gap:8px; cursor:pointer;">
          <input type="radio" name="bam-md-mode" value="full" style="accent-color:#4a6cf7;" />
          <span style="color:#ccc; font-size:13px;">完整（全部语法）</span>
        </label>
      </div>

      <div style="display:flex; justify-content:center; gap:12px; margin-bottom:12px;">
        <button id="bam-btn-save-style" style="background:#4a6cf7; border:none; color:#fff; padding:8px 24px; border-radius:6px; cursor:pointer; font-size:13px; opacity:0.65;" disabled>保存样式</button>
        <button id="bam-btn-reset-style" style="background:rgba(255,255,255,0.06); border:none; color:#aaa; padding:8px 24px; border-radius:6px; cursor:pointer; font-size:13px;">恢复默认</button>
      </div>
      <div id="bam-style-save-tip" style="text-align:center; color:#555; font-size:11px; padding:8px 0; border-top:1px solid rgba(255,255,255,0.06);">
        当前样式已保存；调整时只影响预览，点击保存后下次静态重渲染读取新值</div>
    </div>

    <div id="bam-tab-mood" style="display:none; flex-direction:column; flex:1; overflow-y:auto; padding:16px 20px;">
    </div>
  </div>
  <input id="bam-import-input" type="file" accept=".json,.zip" style="display:none;" />`;
  }

  _avatarItemHTML(avatar, blobUrl, color, sourceInfo = '📁') {
    const sizeKB = (avatar.fileSize / 1024).toFixed(1);
    const displayName = avatar.displayName || avatar.alias;
    const safeName = escapeHtmlAttr(displayName);
    const safeImgSrc = blobUrl || 'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7';
    const colorDot = color ? `<span style="display:inline-block;width:10px;height:10px;border-radius:50%;background:${color};margin-right:4px;vertical-align:middle;"></span>` : '';
    return `
<div class="bam-avatar-item" data-name="${safeName}" style="
  display:flex; flex-direction:column; gap:0; margin-bottom:6px;
  background:rgba(255,255,255,0.03); border-radius:10px; overflow:hidden;
">
  <div style="display:flex; align-items:center; gap:12px; padding:10px 12px;">
    <img src="${safeImgSrc}" class="bam-avatar-thumb" data-preview-src="${safeImgSrc}" data-preview-title="${safeName}" style="width:44px; height:44px; border-radius:50%;
      object-fit:cover; flex-shrink:0; border:2px solid ${color || 'rgba(255,255,255,0.1)'}; cursor:pointer;" />
    <div style="flex:1; min-width:0;">
      <div style="color:#e0e0e0; font-size:14px; font-weight:500;
        overflow:hidden; text-overflow:ellipsis; white-space:nowrap;">${colorDot}${safeName}</div>
      <div style="color:#666; font-size:11px; margin-top:2px;">${sourceInfo} ${sizeKB} KB · ${avatar.mimeType.split('/')[1].toUpperCase()}</div>
    </div>
    <div style="display:flex; gap:4px; flex-shrink:0;">
      <button class="bam-action-btn bam-btn-color" data-name="${safeName}" title="修改颜色" style="
        background:rgba(255,255,255,0.06); border:none; color:#888;
        width:28px; height:28px; border-radius:6px; cursor:pointer; font-size:13px;">&#x1F3A8;</button>
      <button class="bam-action-btn bam-btn-replace" data-name="${safeName}" title="替换图片" style="
        background:rgba(255,255,255,0.06); border:none; color:#888;
        width:28px; height:28px; border-radius:6px; cursor:pointer; font-size:13px;">&#x21BB;</button>
      <button class="bam-action-btn bam-btn-rename" data-name="${safeName}" title="重命名" style="
        background:rgba(255,255,255,0.06); border:none; color:#888;
        width:28px; height:28px; border-radius:6px; cursor:pointer; font-size:13px;">&#x270E;</button>
      <button class="bam-action-btn bam-btn-delete" data-name="${safeName}" title="删除" style="
        background:rgba(255,80,80,0.1); border:none; color:#e55;
        width:28px; height:28px; border-radius:6px; cursor:pointer; font-size:13px;">&times;</button>
      <button class="bam-action-btn bam-btn-mood-toggle" data-name="${safeName}" title="情绪差分" style="
        background:rgba(74,108,247,0.12); border:none; color:#8ba4f7;
        width:28px; height:28px; border-radius:6px; cursor:pointer; font-size:11px;">▼</button>
    </div>
  </div>
  <div class="bam-mood-panel" data-name="${safeName}" style="display:none; padding:8px 12px 12px; border-top:1px solid rgba(255,255,255,0.04); max-height:40vh; overflow-y:auto; -webkit-overflow-scrolling:touch;"></div>
</div>`;
  }

  // -- 事件绑定 --

  _bindEvents() {
    const doc = this._getMainDocument();
    const $ = (s) => doc.querySelector(s);

    $('#bam-btn-close').addEventListener('click', () => this.close());

    // - Tab 切换 -
    doc.querySelectorAll('.bam-tab-btn').forEach(btn => {
      btn.addEventListener('click', () => this._switchTab(btn.dataset.tab));
    });

    // - 全局头像切换 -
    doc.querySelectorAll('input[name="bam-target-scope"]').forEach(radio => {
      radio.addEventListener('change', () => this._refreshList());
    });

    // - 远程头像操作 -
    $('#bam-btn-fetch-remote')?.addEventListener('click', async () => {
      const btn = doc.getElementById('bam-btn-fetch-remote');
      const originalText = btn.textContent;
      btn.disabled = true;
      btn.textContent = '检查中...';

      const charId = this._getActiveCharId();
      let fetched = 0, failed = 0;
      const compOpts = await getCompressOptions(this.db);

      // 收集所有需要拉取的记录
      const tasks = [];

      const avatars = await this.db.list(charId);
      for (const av of avatars) {
        const record = await this.db.get(charId, av.displayName);
        if (record && record.sourceUrl && record.sourceUrl !== 'null' && !record.imageBlob) {
          tasks.push({ type: 'avatar', name: av.displayName, record });
        }
      }

      const allMoods = await new Promise((resolve, reject) => {
        const req = this.db.db.transaction(STORE_MOOD_AVATARS, 'readonly').objectStore(STORE_MOOD_AVATARS).getAll();
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(new Error('查询失败'));
      });
      for (const r of allMoods.filter(r => r.charId === charId && r.sourceUrl && r.sourceUrl !== 'null' && !r.imageBlob)) {
        tasks.push({ type: 'mood', record: r });
      }

      if (!tasks.length) {
        btn.textContent = originalText;
        btn.disabled = false;
        alert('没有需要拉取的远程头像');
        return;
      }

      // 逐个拉取并更新进度
      for (let i = 0; i < tasks.length; i++) {
        btn.textContent = `拉取中 ${i + 1}/${tasks.length}...`;
        const task = tasks[i];
        try {
          const resp = await fetch(task.record.sourceUrl);
          if (!resp.ok) { failed++; continue; }
          let blob = await resp.blob();
          blob = await compressImage(blob, compOpts);
          if (task.type === 'avatar') {
            await this.db.update(charId, task.name, blob);
          } else {
            task.record.imageBlob = blob;
            task.record.fileSize = blob.size;
            task.record.mimeType = blob.type || task.record.mimeType;
            task.record.updatedAt = Date.now();
            await this.db._put(STORE_MOOD_AVATARS, task.record);
          }
          fetched++;
        } catch (_) { failed++; }
      }

      btn.textContent = originalText;
      btn.disabled = false;
      alert(`远程头像拉取完成: ${fetched} 张成功${failed ? ', ' + failed + ' 张失败' : ''}`);
      await this._refreshList();
    });
    $('#bam-btn-clear-remote-cache')?.addEventListener('click', async () => {
      if (!confirm('确定清除所有远程头像的本地缓存？下次渲染时会重新拉取。')) return;
      const charId = this._getActiveCharId();
      let cleared = 0;

      // 主头像
      const allAvatars = await new Promise((resolve, reject) => {
        const req = this.db.db.transaction(STORE_AVATARS, 'readonly').objectStore(STORE_AVATARS).getAll();
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(new Error('查询失败'));
      });
      const prefix = charId + CHAR_ID_SEPARATOR;
      for (const r of allAvatars.filter(r => r.alias.startsWith(prefix) && r.sourceUrl && r.sourceUrl !== 'null')) {
        r.imageBlob = null;
        r.fileSize = 0;
        r.updatedAt = Date.now();
        await this.db._put(STORE_AVATARS, r);
        cleared++;
      }

      // 情绪差分头像
      const allMoods = await new Promise((resolve, reject) => {
        const req = this.db.db.transaction(STORE_MOOD_AVATARS, 'readonly').objectStore(STORE_MOOD_AVATARS).getAll();
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(new Error('查询失败'));
      });
      for (const r of allMoods.filter(r => r.charId === charId && r.sourceUrl && r.sourceUrl !== 'null')) {
        r.imageBlob = null;
        r.fileSize = 0;
        r.updatedAt = Date.now();
        await this.db._put(STORE_MOOD_AVATARS, r);
        cleared++;
      }

      alert(`已清除 ${cleared} 张远程头像缓存`);
      this.db._blobUrlCache.clear();
      await this._refreshList();
    });

    // - CG 图片库管理 -
    $('#bam-cg-header')?.addEventListener('click', () => {
      const body = doc.getElementById('bam-cg-body');
      const toggle = doc.getElementById('bam-cg-toggle');
      if (!body) return;
      const collapsed = body.style.display === 'none';
      body.style.display = collapsed ? 'block' : 'none';
      if (toggle) toggle.textContent = collapsed ? '▼' : '▶';
      if (collapsed) this._renderCgGroupList();
    });
    $('#bam-btn-add-cg-group')?.addEventListener('click', async () => {
      const groupName = prompt('CG 组名（如"天之音"）:');
      if (!groupName) return;
      // prompt 不支持多行输入，用自定义弹窗
      this._showTextareaDialog({
        title: '粘贴图片链接（每行一个）或留空后手动上传',
        placeholder: '留空 = 之后用「上传图片」按钮手动添加\n\n或粘贴远程链接：\nhttps://files.catbox.moe/xxx.png\nhttps://files.catbox.moe/yyy.png',
        onConfirm: async (albumUrl) => {
          try {
            await this.db.addCgGroup(groupName.trim(), albumUrl || '', this._getActiveCharId());
            if (albumUrl.trim()) {
              try { await ensureCgGroupIndex(this.db, groupName.trim()); } catch (_) {}
            }
            this._renderCgGroupList();
          } catch (err) { alert('添加失败: ' + err.message); }
        }
      });
    });
    $('#bam-btn-clear-all-cg')?.addEventListener('click', async () => {
      if (!confirm('确定清除所有 CG 图片缓存？')) return;
      await this.db.clearAllCgCache();
      this._renderCgGroupList();
      alert('CG 缓存已全部清除');
    });

    // - 缩略图点击大图预览（头像 + 情绪差分 + CG 统一处理）-
    const container = doc.getElementById('bam-container');
    container?.addEventListener('click', (e) => {
      const thumb = e.target.closest('.bam-avatar-thumb, .bam-cg-thumb');
      if (!thumb) return;
      const src = thumb.dataset.previewSrc;
      if (!src || src.startsWith('data:')) return;
      e.stopPropagation();
      this._openImagePreview(src, thumb.dataset.previewTitle || '');
    });

    // - 头像管理 Tab 事件 -

    $('#bam-btn-add-remote-avatar')?.addEventListener('click', async () => {
      const name = prompt('角色名（用于渲染时匹配）:');
      if (!name || !name.trim()) return;
      const url = prompt('远程图片 URL（如 https://files.catbox.moe/xxx.png）:');
      if (!url || !url.trim()) return;
      const charId = this._getActiveCharId();
      try {
        const existing = await this.db.get(charId, name.trim());
        if (existing) {
          await this.db.update(charId, name.trim(), existing.imageBlob, { sourceUrl: url.trim() });
        } else {
          await this.db.add(charId, name.trim(), null, { sourceUrl: url.trim(), mimeType: 'image/webp' });
        }
        await this._refreshList();
      } catch (err) { alert('添加失败: ' + err.message); }
    });

    $('#bam-upload-area').addEventListener('click', () => $('#bam-file-input').click());

    const uploadArea = $('#bam-upload-area');
    uploadArea.addEventListener('dragover', (e) => {
      e.preventDefault();
      uploadArea.style.borderColor = 'rgba(74,108,247,0.5)';
      uploadArea.style.background = 'rgba(74,108,247,0.05)';
    });
    uploadArea.addEventListener('dragleave', () => {
      uploadArea.style.borderColor = 'rgba(255,255,255,0.12)';
      uploadArea.style.background = 'transparent';
    });
    uploadArea.addEventListener('drop', (e) => {
      e.preventDefault();
      uploadArea.style.borderColor = 'rgba(255,255,255,0.12)';
      uploadArea.style.background = 'transparent';
      const file = e.dataTransfer.files[0];
      if (file && file.type.startsWith('image/')) this._handleFileSelected(file);
    });

    $('#bam-file-input').addEventListener('change', (e) => {
      const file = e.target.files[0];
      if (file) this._handleFileSelected(file);
      e.target.value = '';
    });

    $('#bam-btn-cancel-upload').addEventListener('click', () => this._hideAliasInput());
    $('#bam-btn-confirm-upload').addEventListener('click', () => this._confirmUpload());
    $('#bam-alias-input').addEventListener('keydown', (e) => { if (e.key === 'Enter') this._confirmUpload(); });

    // 颜色预设圆点点击
    this.selectedColor = '#58a6ff';
    doc.querySelectorAll('.bam-color-dot').forEach(dot => {
      dot.addEventListener('click', () => {
        this.selectedColor = dot.dataset.color;
        $('#bam-color-input').value = dot.dataset.color;
        doc.querySelectorAll('.bam-color-dot').forEach(d => d.style.borderColor = 'transparent');
        dot.style.borderColor = '#fff';
      });
    });
    // 自定义颜色输入同步
    $('#bam-color-input').addEventListener('input', (e) => {
      this.selectedColor = e.target.value;
      doc.querySelectorAll('.bam-color-dot').forEach(d => d.style.borderColor = 'transparent');
    });

    $('#bam-btn-export').addEventListener('click', async () => {
      try { await this.db.exportCharacterDataToFile(this._getActiveCharId()); } catch (err) { alert('导出失败: ' + err.message); }
    });

    $('#bam-btn-import').addEventListener('click', () => $('#bam-import-input').click());
    $('#bam-import-input').addEventListener('change', async (e) => {
      const file = e.target.files[0];
      if (!file) return;
      const importBtn = $('#bam-btn-import');
      const origText = importBtn ? importBtn.textContent : '';
      if (importBtn) { importBtn.disabled = true; importBtn.textContent = '导入中...'; }
      try {
        const result = await this.db.importFromFile(file, this._getActiveCharId());
        let msg = `导入完成: 成功 ${result.imported} 项`;
        if (result.skipped) msg += `, 跳过 ${result.skipped} 项`;
        if (result.errors?.length) msg += `\n错误: ${result.errors.join(', ')}`;
        alert(msg);
        await this._refreshList();
        this._requestAvatarAssetPreviewRefresh();
      } catch (err) { alert('导入失败: ' + err.message); }
      finally {
        if (importBtn) { importBtn.disabled = false; importBtn.textContent = origText; }
        e.target.value = '';
      }
    });

    $('#bam-avatar-list').addEventListener('click', (e) => {
      const btn = e.target.closest('.bam-action-btn');
      if (!btn) return;
      const name = btn.dataset.name;
      if (btn.classList.contains('bam-btn-delete')) this._handleDelete(name);
      else if (btn.classList.contains('bam-btn-rename')) this._handleRename(name);
      else if (btn.classList.contains('bam-btn-replace')) this._handleReplace(name);
      else if (btn.classList.contains('bam-btn-color')) this._handleChangeColor(name);
      else if (btn.classList.contains('bam-btn-mood-toggle')) this._handleMoodToggle(name);
    });

    $('#bam-avatar-list').addEventListener('click', (e) => {
      const moodBtn = e.target.closest('.bam-mood-action');
      if (!moodBtn) return;
      const name = moodBtn.dataset.name;
      const moodId = moodBtn.dataset.moodId;
      if (moodBtn.classList.contains('bam-mood-upload')) this._handleMoodUpload(name, moodId);
      else if (moodBtn.classList.contains('bam-mood-delete')) this._handleMoodDelete(name, moodId);
      else if (moodBtn.classList.contains('bam-mood-remote')) this._handleMoodRemoteUrl(name, moodId);
    });

    // - 正文美化 Tab 事件 -
    const applyLiveStylePreview = () => {
      this._applyBubblePreviewStyles().catch((err) => {
        console.warn('Bubble 预览样式应用失败:', err);
      });
    };
    const markStyleDirty = () => {
      if (!this._styleDraftLoaded) this._styleDraftLoaded = true;
      this._setStyleDraftDirty(true);
    };
    const previewAndMarkDirty = () => {
      applyLiveStylePreview();
      markStyleDirty();
    };
    const bindRangeSetting = ({ inputId, valueId, formatter }) => {
      const inputEl = $(inputId);
      const valueEl = $(valueId);
      if (!inputEl || !valueEl) return;
      const syncDisplay = (value) => {
        valueEl.textContent = formatter(value);
      };
      inputEl.addEventListener('input', (e) => {
        syncDisplay(e.target.value);
        previewAndMarkDirty();
      });
      inputEl.addEventListener('change', (e) => {
        syncDisplay(e.target.value);
        previewAndMarkDirty();
      });
    };

    bindRangeSetting({ inputId: '#bam-range-dialogue-font', valueId: '#bam-val-dialogue-font', formatter: (v) => `${v}px` });
    bindRangeSetting({ inputId: '#bam-range-narration-font', valueId: '#bam-val-narration-font', formatter: (v) => `${v}px` });
    bindRangeSetting({ inputId: '#bam-range-dialogue-spacing', valueId: '#bam-val-dialogue-spacing', formatter: (v) => `${v}px` });
    bindRangeSetting({ inputId: '#bam-range-dialogue-weight', valueId: '#bam-val-dialogue-weight', formatter: (v) => `${v}` });
    bindRangeSetting({ inputId: '#bam-range-narration-weight', valueId: '#bam-val-narration-weight', formatter: (v) => `${v}` });
    bindRangeSetting({ inputId: '#bam-range-name-weight', valueId: '#bam-val-name-weight', formatter: (v) => `${v}` });
    bindRangeSetting({ inputId: '#bam-range-narration-bg-opacity', valueId: '#bam-val-narration-bg-opacity', formatter: (v) => Number.parseFloat(v).toFixed(2) });
    bindRangeSetting({ inputId: '#bam-range-avatar-size', valueId: '#bam-val-avatar-size', formatter: (v) => `${v}px` });
    bindRangeSetting({ inputId: '#bam-range-narration-indent', valueId: '#bam-val-narration-indent', formatter: (v) => `${v}px` });
    bindRangeSetting({ inputId: '#bam-range-narration-border-radius', valueId: '#bam-val-narration-border-radius', formatter: (v) => `${v}px` });
    bindRangeSetting({ inputId: '#bam-range-thought-suffix-gap', valueId: '#bam-val-thought-suffix-gap', formatter: (v) => `${v}px` });
    bindRangeSetting({ inputId: '#bam-range-thought-suffix-offset-y', valueId: '#bam-val-thought-suffix-offset-y', formatter: (v) => `${v}px` });
    // v7.0
    bindRangeSetting({ inputId: '#bam-range-narration-text-indent', valueId: '#bam-val-narration-text-indent', formatter: (v) => `${v}em` });
    bindRangeSetting({ inputId: '#bam-range-narration-line-height', valueId: '#bam-val-narration-line-height', formatter: (v) => `${v}` });
    bindRangeSetting({ inputId: '#bam-range-narration-padding-right', valueId: '#bam-val-narration-padding-right', formatter: (v) => `${v}px` });
    bindRangeSetting({ inputId: '#bam-range-compress-quality', valueId: '#bam-val-compress-quality', formatter: (v) => Number.parseFloat(v).toFixed(2) });
    $('#bam-chk-compress-enabled')?.addEventListener('change', () => { markStyleDirty(); });

    doc.querySelectorAll('input[name="bam-avatar-shape"]').forEach((radio) => {
      radio.addEventListener('change', () => {
        previewAndMarkDirty();
      });
    });

    doc.querySelectorAll('input[name="bam-color-mode"]').forEach((radio) => {
      radio.addEventListener('change', () => {
        previewAndMarkDirty();
      });
    });

    ['#bam-global-color-picker', '#bam-narration-bg-color'].forEach((selector) => {
      $(selector)?.addEventListener('input', () => {
        previewAndMarkDirty();
      });
      $(selector)?.addEventListener('change', () => {
        previewAndMarkDirty();
      });
    });

    ['#bam-select-narration-font', '#bam-select-dialogue-font', '#bam-select-name-font'].forEach((selector) => {
      $(selector)?.addEventListener('change', () => {
        previewAndMarkDirty();
      });
    });

    const fontUrlInput = $('#bam-font-url-input');
    fontUrlInput?.addEventListener('input', () => {
      markStyleDirty();
    });
    fontUrlInput?.addEventListener('change', () => {
      markStyleDirty();
    });
    $('#bam-btn-refresh-fonts')?.addEventListener('click', async () => {
      try {
        await this._refreshFontSelectors({ forceRemote: true, silent: false });
        await this._applyBubblePreviewStyles();
        markStyleDirty();
      } catch (err) {
        console.warn('刷新远程字体失败:', err);
        alert(`字体列表刷新失败：${err.message}`);
      }
    });

    // - CSS 字体导入 -
    $('#bam-btn-import-css-font')?.addEventListener('click', async () => {
      const urlInput = doc.getElementById('bam-css-font-url-input');
      const cssUrl = urlInput?.value?.trim();
      if (!cssUrl) { alert('请输入 CSS URL'); return; }
      const btn = doc.getElementById('bam-btn-import-css-font');
      const originalText = btn.textContent;
      btn.textContent = '解析中...';
      btn.disabled = true;
      try {
        const result = await this._parseCssFontFaces(cssUrl);
        if (!result.families.length) { alert('未在 CSS 中找到任何 @font-face 声明'); return; }
        await this.db.addCssFontSource(cssUrl, result.families);
        urlInput.value = '';
        await this._renderCssFontSources();
        await this._refreshFontSelectors({ forceRemote: false, silent: true });
        previewAndMarkDirty();
        alert(`成功导入 ${result.families.length} 个字体族：${result.families.join('、')}`);
      } catch (err) {
        alert(`CSS 字体导入失败：${err.message}`);
      } finally {
        btn.textContent = originalText;
        btn.disabled = false;
      }
    });
    doc.getElementById('bam-css-font-sources')?.addEventListener('click', async (e) => {
      const delBtn = e.target.closest('.bam-css-font-delete');
      if (!delBtn) return;
      const url = delBtn.dataset.url;
      if (!confirm(`确定删除此 CSS 字体源？`)) return;
      await this.db.deleteCssFontSource(url);
      await this._renderCssFontSources();
      await this._refreshFontSelectors({ forceRemote: false, silent: true });
      previewAndMarkDirty();
    });

    // - 本地字体上传 -
    const fontUploadBtn = $('#bam-btn-upload-local-font');
    fontUploadBtn?.addEventListener('click', () => {
      doc.getElementById('bam-local-font-input')?.click();
    });
    $('#bam-local-font-input')?.addEventListener('change', async (e) => {
      const file = e.target.files[0];
      if (!file) return;
      e.target.value = '';
      if (file.size > LOCAL_FONT_MAX_SIZE) { alert(`字体文件不能超过 ${LOCAL_FONT_MAX_SIZE / 1024 / 1024}MB`); return; }
      const ext = file.name.split('.').pop()?.toLowerCase() || '';
      if (!FONT_EXT_FORMAT_MAP[ext]) { alert('不支持的字体格式，请选择 .woff2 / .woff / .ttf / .otf'); return; }
      const family = file.name.replace(/\.[^.]+$/, '').trim();
      if (!family) { alert('无法从文件名提取字体名称'); return; }
      const existing = await this.db.getLocalFont(family);
      if (existing && !confirm(`已存在同名字体「${family}」，是否替换？`)) return;
      const origText = fontUploadBtn ? fontUploadBtn.textContent : '';
      if (fontUploadBtn) { fontUploadBtn.disabled = true; fontUploadBtn.textContent = '上传中...'; }
      try {
        await this.db.addLocalFont(family, file, { fileName: file.name, mimeType: FONT_EXT_MIME_MAP[ext] });
        await this._renderLocalFontList();
        await this._refreshFontSelectors({ forceRemote: false, silent: true });
        previewAndMarkDirty();
      } catch (err) { alert('字体上传失败：' + err.message); }
      finally { if (fontUploadBtn) { fontUploadBtn.disabled = false; fontUploadBtn.textContent = origText; } }
    });
    doc.getElementById('bam-local-font-list')?.addEventListener('click', async (e) => {
      const delBtn = e.target.closest('.bam-local-font-delete');
      if (!delBtn) return;
      const family = delBtn.dataset.family;
      if (!confirm(`确定删除本地字体「${family}」？`)) return;
      try {
        await this.db.deleteLocalFont(family);
        await this._renderLocalFontList();
        await this._refreshFontSelectors({ forceRemote: false, silent: true });
        previewAndMarkDirty();
      } catch (err) { alert('删除失败：' + err.message); }
    });

    doc.querySelectorAll('input[name="bam-md-mode"]').forEach((radio) => {
      radio.addEventListener('change', () => {
        markStyleDirty();
      });
    });

    $('#bam-btn-save-style')?.addEventListener('click', async () => {
      await this._saveCurrentStyleSettings();
    });
    $('#bam-btn-reset-style').addEventListener('click', () => this._resetStyleDefaults());
  }

  // -- CSS 字体解析 --

  async _parseCssFontFaces(cssUrl) {
    const controller = typeof AbortController === 'function' ? new AbortController() : null;
    const timer = controller ? setTimeout(() => controller.abort(), FONT_FETCH_TIMEOUT_MS) : null;
    try {
      const response = await fetch(cssUrl, { method: 'GET', cache: 'no-store', signal: controller?.signal });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const cssText = await response.text();
      const fontFaceRegex = /@font-face\s*\{([^}]+)\}/gi;
      const familyRegex = /font-family\s*:\s*['"]?([^'";]+)['"]?\s*;/i;
      const families = new Set();
      let match;
      while ((match = fontFaceRegex.exec(cssText)) !== null) {
        const familyMatch = familyRegex.exec(match[1]);
        if (familyMatch) families.add(familyMatch[1].trim());
      }
      return { url: cssUrl, families: Array.from(families) };
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  // -- 本地字体列表渲染 --

  async _renderLocalFontList() {
    const doc = this._getMainDocument();
    const container = doc.getElementById('bam-local-font-list');
    if (!container) return;
    try {
      const fonts = await this.db.listLocalFonts();
      if (!fonts.length) {
        container.innerHTML = '<div style="color:#555; font-size:12px; text-align:center; padding:6px 0;">暂无本地字体</div>';
        return;
      }
      container.innerHTML = fonts.map(f => {
        const sizeKB = (f.fileSize / 1024).toFixed(1);
        const safeFamily = escapeHtmlAttr(f.family);
        return `<div style="display:flex; align-items:center; gap:8px; padding:6px 8px; background:rgba(255,255,255,0.03); border-radius:6px; margin-bottom:4px;">
          <span style="color:#ccc; font-size:12px; flex:1; min-width:0; overflow:hidden; text-overflow:ellipsis; white-space:nowrap;" title="${safeFamily}">${safeFamily}</span>
          <span style="color:#666; font-size:11px; flex-shrink:0;">${sizeKB} KB</span>
          <button class="bam-local-font-delete" data-family="${safeFamily}" style="background:rgba(255,80,80,0.1); border:none; color:#e55; width:22px; height:22px; border-radius:4px; cursor:pointer; font-size:12px; flex-shrink:0; line-height:1;">&times;</button>
        </div>`;
      }).join('');
    } catch (_) {
      container.innerHTML = '';
    }
  }

  // -- CSS 字体源列表渲染 --

  async _renderCssFontSources() {
    const doc = this._getMainDocument();
    const container = doc.getElementById('bam-css-font-sources');
    if (!container) return;
    try {
      const sources = await this.db.getCssFontSources();
      if (!sources.length) {
        container.innerHTML = '';
        return;
      }
      container.innerHTML = sources.map(src => {
        const safeUrl = escapeHtmlAttr(src.url);
        const familyText = (src.families || []).join('、') || '未知';
        return `<div style="display:flex; align-items:center; gap:8px; padding:6px 8px; background:rgba(255,255,255,0.03); border-radius:6px; margin-bottom:4px;">
          <div style="flex:1; min-width:0; overflow:hidden;">
            <div style="color:#ccc; font-size:11px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap;" title="${safeUrl}">${safeUrl}</div>
            <div style="color:#888; font-size:10px; margin-top:2px;">字体族：${escapeHtmlAttr(familyText)}</div>
          </div>
          <button class="bam-css-font-delete" data-url="${safeUrl}" style="background:rgba(255,80,80,0.1); border:none; color:#e55; width:22px; height:22px; border-radius:4px; cursor:pointer; font-size:12px; flex-shrink:0; line-height:1;">&times;</button>
        </div>`;
      }).join('');
    } catch (_) {
      container.innerHTML = '';
    }
  }

  // -- 文件处理 --

  _handleFileSelected(file) {
    if (file.size > 2 * 1024 * 1024) { alert('图片不能超过 2MB'); return; }
    if (!file.type.startsWith('image/')) { alert('请选择图片文件'); return; }
    this.pendingFile = file;
    const doc = this._getMainDocument();
    const reader = new FileReader();
    reader.onload = (e) => { doc.getElementById('bam-preview-img').src = e.target.result; };
    reader.readAsDataURL(file);
    const suggested = file.name.replace(/\.[^.]+$/, '').replace(/[^a-zA-Z0-9_\-\u4e00-\u9fff]/g, '').toLowerCase().slice(0, 20);
    doc.getElementById('bam-alias-input').value = suggested;
    this._showAliasInput();
  }

  _showAliasInput() {
    const doc = this._getMainDocument();
    doc.getElementById('bam-alias-input-area').style.display = 'block';
    doc.getElementById('bam-alias-input').focus();
  }

  _hideAliasInput() {
    const doc = this._getMainDocument();
    doc.getElementById('bam-alias-input-area').style.display = 'none';
    this.pendingFile = null;
  }

  async _confirmUpload() {
    if (!this.pendingFile) return;
    const doc = this._getMainDocument();
    const name = doc.getElementById('bam-alias-input').value.trim();
    if (!name) { alert('请输入角色名'); return; }
    if (name.includes(CHAR_ID_SEPARATOR)) { alert('角色名不能包含连续双下划线'); return; }
    const color = this.selectedColor || '#58a6ff';
    const charId = this._getActiveCharId();
    const confirmBtn = doc.getElementById('bam-btn-confirm-upload');
    const origText = confirmBtn ? confirmBtn.textContent : '确认添加';
    if (confirmBtn) { confirmBtn.disabled = true; confirmBtn.textContent = '处理中...'; }
    try {
      const meta = await this._getImageMeta(this.pendingFile);
      const compOpts = await getCompressOptions(this.db);
      const blob = await compressImage(this.pendingFile, compOpts);
      await this.db.add(charId, name, blob, meta);
      await this.db.setConfig(buildColorConfigKey(charId, name), color);
      this._hideAliasInput();
      await this._refreshList();
      this._requestAvatarAssetPreviewRefresh();
    } catch (err) {
      if (err.message.includes('已存在')) {
        if (confirm(`角色名 "${name}" 已存在，是否替换图片和颜色？`)) {
          try {
            const meta = await this._getImageMeta(this.pendingFile);
            const compOpts2 = await getCompressOptions(this.db);
            const rBlob = await compressImage(this.pendingFile, compOpts2);
            await this.db.update(charId, name, rBlob, meta);
            await this.db.setConfig(buildColorConfigKey(charId, name), color);
            this._hideAliasInput();
            await this._refreshList();
            this._requestAvatarAssetPreviewRefresh();
          } catch (e2) { alert('替换失败: ' + e2.message); }
        }
      } else { alert('添加失败: ' + err.message); }
    } finally {
      if (confirmBtn) { confirmBtn.disabled = false; confirmBtn.textContent = origText; }
    }
  }

  _getImageMeta(file) {
    return new Promise((resolve) => {
      const img = new Image();
      img.onload = () => { resolve({ fileName: file.name, width: img.naturalWidth, height: img.naturalHeight }); URL.revokeObjectURL(img.src); };
      img.onerror = () => { resolve({ fileName: file.name, width: 0, height: 0 }); };
      img.src = URL.createObjectURL(file);
    });
  }

  // -- 列表操作 --

  async _handleDelete(name) {
    if (!confirm(`确定删除头像 "${name}" 及其所有情绪差分头像吗？`)) return;
    const charId = this._getActiveCharId();
    try {
      // 尝试用标准 key 删除
      await this.db.delete(charId, name);
      // 同时尝试直接用 alias 删除（兼容旧版脏数据 key 格式不一致的情况）
      try {
        const prefix = String(charId || GLOBAL_CHAR_ID) + CHAR_ID_SEPARATOR;
        const allAvatars = await new Promise((resolve, reject) => {
          const req = this.db.db.transaction(STORE_AVATARS, 'readonly').objectStore(STORE_AVATARS).getAll();
          req.onsuccess = () => resolve(req.result);
          req.onerror = () => reject(new Error('查询失败'));
        });
        for (const r of allAvatars) {
          if (r.alias.startsWith(prefix) && extractDisplayName(r.alias, charId) === name) {
            await new Promise((resolve, reject) => {
              const tx = this.db.db.transaction(STORE_AVATARS, 'readwrite');
              const req = tx.objectStore(STORE_AVATARS).delete(r.alias);
              req.onsuccess = () => resolve();
              req.onerror = () => reject(new Error('删除失败'));
            });
          }
        }
      } catch (_) {}
      await this.db.deleteAllMoodAvatars(charId, name);
      try { await this.db.setConfig(buildColorConfigKey(charId, name), null); } catch (_) { /* ignore */ }
      if (this._expandedMoodName === name) this._expandedMoodName = null;
      await this._refreshList();
      this._requestAvatarAssetPreviewRefresh();
    }
    catch (err) { alert('删除失败: ' + err.message); }
  }

  async _handleChangeColor(name) {
    const charId = this._getActiveCharId();
    const currentColor = await this.db.getConfig(buildColorConfigKey(charId, name), '#58a6ff');
    this._openMobileColorDialog({
      title: `角色主题色 · ${name}`,
      initialValue: currentColor || '#58a6ff',
      onConfirm: async (nextColor) => {
        await this.db.setConfig(buildColorConfigKey(charId, name), nextColor);
        await this._refreshList();
        this._requestAvatarAssetPreviewRefresh();
      }
    });
  }

  async _handleRename(name) {
    const newName = prompt(`将 "${name}" 重命名为:`, name);
    if (!newName || newName.trim().toLowerCase() === name) return;
    try {
      await this.db.rename(this._getActiveCharId(), name, newName.trim());
      await this._refreshList();
      this._requestAvatarAssetPreviewRefresh();
    }
    catch (err) { alert('重命名失败: ' + err.message); }
  }

  async _handleReplace(name) {
    const doc = this._getMainDocument();
    const charId = this._getActiveCharId();
    const replaceBtn = doc.querySelector(`.bam-btn-replace[data-name="${name}"]`);
    const input = doc.createElement('input');
    input.type = 'file';
    input.accept = 'image/jpeg,image/png,image/gif,image/webp';
    input.onchange = async (e) => {
      const file = e.target.files[0];
      if (!file) return;
      if (file.size > 2 * 1024 * 1024) { alert('图片不能超过 2MB'); return; }
      const origText = replaceBtn ? replaceBtn.textContent : '';
      if (replaceBtn) { replaceBtn.disabled = true; replaceBtn.textContent = '处理中...'; }
      try {
        const meta = await this._getImageMeta(file);
        const compOpts = await getCompressOptions(this.db);
        const blob = await compressImage(file, compOpts);
        await this.db.update(charId, name, blob, meta);
        await this._refreshList();
        this._requestAvatarAssetPreviewRefresh();
      } catch (err) {
        alert('替换失败: ' + err.message);
        if (replaceBtn) { replaceBtn.disabled = false; replaceBtn.textContent = origText; }
      }
    };
    input.click();
  }

  _getActiveCharId() {
    const doc = this._getMainDocument();
    const radio = doc.querySelector('input[name="bam-target-scope"]:checked');
    if (radio && radio.value === 'global') return GLOBAL_CHAR_ID;
    return this._charId;
  }

  async _refreshList() {
    const doc = this._getMainDocument();
    const listEl = doc.getElementById('bam-avatar-list');
    const statsEl = doc.getElementById('bam-stats');
    const charNameEl = doc.getElementById('bam-char-name');
    const charId = this._getActiveCharId();

    if (charNameEl) {
      charNameEl.textContent = charId === GLOBAL_CHAR_ID
        ? '⚠ 全局分区'
        : `${this._charName}`;
    }

    const avatars = await this.db.list(charId);
    const stats = await this.db.getStats(charId);
    statsEl.textContent = `已存储: ${stats.count} 张 | 总计: ${(stats.totalSize / 1024).toFixed(1)} KB`;
    if (avatars.length === 0) {
      listEl.innerHTML = '<div style="text-align:center;color:#555;padding:30px 0;font-size:13px;">还没有头像，点击上方区域添加</div>';
      return;
    }
    let html = '';
    for (const avatar of avatars) {
      const record = await this.db.get(charId, avatar.displayName);
      const blobUrl = await this.db.getBlobUrl(charId, avatar.displayName);
      const color = await this.db.getConfig(buildColorConfigKey(charId, avatar.displayName), null);
      const sourceInfo = record?.sourceUrl && record.sourceUrl !== 'null'
        ? (record.imageBlob ? '<span style="color:#58a6ff;font-size:9px;">远程✓</span>' : '<span style="color:#eab308;font-size:9px;">远程⏳</span>')
        : '<span style="color:#7ee787;font-size:9px;">本地</span>';
      html += this._avatarItemHTML(avatar, blobUrl, color, sourceInfo);
    }
    listEl.innerHTML = html;

    if (this._expandedMoodName) {
      await this._renderMoodPanel(this._expandedMoodName);
    }
    this._renderCgGroupList();
  }

  // -- CG 图片库面板 --

  async _renderCgGroupList() {
    const doc = this._getMainDocument();
    const listEl = doc.getElementById('bam-cg-group-list');
    if (!listEl) return;
    const charId = this._getActiveCharId();
    try {
      const groups = await this.db.listCgGroups(charId);
      if (!groups.length) {
        listEl.innerHTML = '<div style="color:#555;font-size:12px;text-align:center;padding:12px 0;">暂无 CG 组</div>';
        return;
      }
      let html = '';
      for (const g of groups) {
        const cached = await this.db.getCgGroupCacheStats(g.group);
        const urls = g.imageUrls || [];
        const total = g.count || urls.length;
        const statusText = total > 0
          ? `${cached}/${total} 张已缓存`
          : '⏳ 未解析';
        const safeGroup = escapeHtmlAttr(g.group);

        // 构建图片清单：缩略图 + 组名#序号 → 来源
        let imageListHtml = '';
        if (urls.length > 0) {
          for (let i = 0; i < urls.length; i++) {
            const isLocal = urls[i].startsWith('local://');
            const shortName = isLocal ? urls[i].replace('local://', '') : (urls[i].split('/').pop() || urls[i]);
            const sourceTag = isLocal ? '<span style="color:#7ee787;font-size:9px;flex-shrink:0;">本地</span>' : '<span style="color:#58a6ff;font-size:9px;flex-shrink:0;">远程</span>';
            const cgCache = await this.db.getCgImage(g.group, i + 1);
            const thumbSrc = (cgCache && cgCache.imageBlob) ? URL.createObjectURL(cgCache.imageBlob) : null;
            const thumbHtml = thumbSrc
              ? `<img src="${thumbSrc}" class="bam-cg-thumb" data-preview-src="${thumbSrc}" data-preview-title="${safeGroup}#${i + 1}" style="width:28px;height:28px;border-radius:3px;object-fit:cover;flex-shrink:0;border:1px solid rgba(255,255,255,0.08);cursor:pointer;" />`
              : `<div style="width:28px;height:28px;border-radius:3px;background:rgba(255,255,255,0.04);flex-shrink:0;display:flex;align-items:center;justify-content:center;color:#555;font-size:10px;">—</div>`;
            const deleteBtn = isLocal ? `<button class="bam-cg-delete-single" data-group="${safeGroup}" data-index="${i + 1}" style="background:none;border:none;color:#e55;cursor:pointer;font-size:12px;padding:0 2px;flex-shrink:0;line-height:1;">&times;</button>` : '';
            imageListHtml += `<div style="display:flex;align-items:center;gap:6px;padding:2px 0;font-size:10px;">
              ${thumbHtml}
              <span style="color:#b9c7ff;min-width:60px;flex-shrink:0;font-family:monospace;">${safeGroup}#${i + 1}</span>
              ${sourceTag}
              <span style="color:#999;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;flex:1;" title="${escapeHtmlAttr(urls[i])}">${escapeHtmlAttr(shortName)}</span>
              ${deleteBtn}
            </div>`;
          }
        } else {
          const lineCount = (g.albumUrl || '').split(/[\n\r]+/).filter(l => l.trim()).length;
          imageListHtml = `<div style="color:#666;font-size:10px;padding:4px 0;">点击「预加载整组」解析清单（${lineCount > 1 ? lineCount + ' 张图片' : '1 个来源'}）</div>`;
        }

        html += `<div style="margin-bottom:8px;padding:8px 10px;background:rgba(255,255,255,0.03);border-radius:8px;">
          <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:4px;">
            <span style="color:#ccc;font-size:12px;font-weight:600;">📁 ${safeGroup}</span>
            <span style="color:#888;font-size:11px;">${statusText}</span>
          </div>
          <div class="bam-cg-image-list" data-group="${safeGroup}" style="max-height:120px;overflow-y:auto;margin-bottom:6px;padding:2px 4px;background:rgba(0,0,0,0.15);border-radius:4px;">
            ${imageListHtml}
          </div>
          <div style="display:flex;gap:6px;">
            <button class="bam-cg-upload" data-group="${safeGroup}" style="background:rgba(74,108,247,0.12);border:1px solid rgba(74,108,247,0.25);color:#b9c7ff;padding:3px 8px;border-radius:4px;cursor:pointer;font-size:10px;">上传图片</button>
            <button class="bam-cg-preload" data-group="${safeGroup}" style="background:rgba(74,108,247,0.12);border:1px solid rgba(74,108,247,0.25);color:#b9c7ff;padding:3px 8px;border-radius:4px;cursor:pointer;font-size:10px;">预加载整组</button>
            <button class="bam-cg-clear" data-group="${safeGroup}" style="background:rgba(255,80,80,0.08);border:1px solid rgba(255,80,80,0.2);color:#e88;padding:3px 8px;border-radius:4px;cursor:pointer;font-size:10px;">清除缓存</button>
            <button class="bam-cg-delete" data-group="${safeGroup}" style="background:rgba(255,80,80,0.08);border:1px solid rgba(255,80,80,0.2);color:#e88;padding:3px 8px;border-radius:4px;cursor:pointer;font-size:10px;">删除</button>
          </div>
        </div>`;
      }
      listEl.innerHTML = html;

      // 绑定 CG 操作事件
      listEl.querySelectorAll('.bam-cg-upload').forEach(btn => {
        btn.addEventListener('click', () => {
          const group = btn.dataset.group;
          const input = doc.createElement('input');
          input.type = 'file';
          input.accept = 'image/jpeg,image/png,image/gif,image/webp';
          input.multiple = true;
          input.onchange = async (e) => {
            const files = Array.from(e.target.files);
            if (!files.length) return;
            const origText = btn.textContent;
            btn.disabled = true;
            btn.textContent = '处理中 0/' + files.length + '...';
            const compOpts = await getCompressOptions(this.db);
            const groupInfo = await this.db.getCgGroup(group);
            let currentCount = groupInfo ? (groupInfo.count || (groupInfo.imageUrls || []).length) : 0;
            let urls = groupInfo ? (groupInfo.imageUrls || []) : [];
            let added = 0;
            for (let i = 0; i < files.length; i++) {
              const file = files[i];
              if (!file.type.startsWith('image/')) continue;
              btn.textContent = `处理中 ${i + 1}/${files.length}...`;
              try {
                let blob = await compressImage(file, compOpts);
                currentCount++;
                await this.db.putCgImage(group, currentCount, blob, 'local://' + file.name);
                urls.push('local://' + file.name);
                added++;
              } catch (_) {}
            }
            if (added > 0) {
              await this.db.updateCgGroup(group, { count: currentCount, imageUrls: urls });
              this._renderCgGroupList();
            } else {
              btn.disabled = false;
              btn.textContent = origText;
            }
          };
          input.click();
        });
      });
      listEl.querySelectorAll('.bam-cg-preload').forEach(btn => {
        btn.addEventListener('click', async () => {
          const group = btn.dataset.group;
          btn.disabled = true;
          btn.textContent = '拉取中...';
          try {
            const result = await preloadCgGroup(this.db, group, (p) => {
              btn.textContent = `拉取中 ${p.current}/${p.total}...`;
            });
            alert(`${group}: 成功 ${result.loaded} 张, 跳过 ${result.skipped} 张${result.failed ? ', 失败 ' + result.failed + ' 张' : ''}`);
          } catch (err) { alert('拉取失败: ' + err.message); }
          this._renderCgGroupList();
        });
      });
      listEl.querySelectorAll('.bam-cg-clear').forEach(btn => {
        btn.addEventListener('click', async () => {
          const group = btn.dataset.group;
          if (!confirm(`确定清除 "${group}" 的图片缓存？`)) return;
          await this.db.clearCgGroupCache(group);
          this._renderCgGroupList();
        });
      });
      listEl.querySelectorAll('.bam-cg-delete').forEach(btn => {
        btn.addEventListener('click', async () => {
          const group = btn.dataset.group;
          if (!confirm(`确定删除 CG 组 "${group}"？`)) return;
          await this.db.deleteCgGroup(group);
          this._renderCgGroupList();
        });
      });
      // 单条图片删除（仅本地上传的）
      listEl.querySelectorAll('.bam-cg-delete-single').forEach(btn => {
        btn.addEventListener('click', async () => {
          const group = btn.dataset.group;
          const index = parseInt(btn.dataset.index, 10);
          if (!confirm(`确定删除 ${group}#${index}？`)) return;
          // 从 cg_images 删除
          const id = 'cg__' + group + '__' + index;
          await new Promise((resolve, reject) => {
            const tx = this.db.db.transaction(STORE_CG_IMAGES, 'readwrite');
            tx.objectStore(STORE_CG_IMAGES).delete(id);
            tx.oncomplete = () => resolve();
            tx.onerror = () => reject(new Error('删除失败'));
          });
          // 从 imageUrls 中移除对应条目并重建序号
          const groupInfo = await this.db.getCgGroup(group);
          if (groupInfo) {
            const urls = (groupInfo.imageUrls || []).slice();
            urls.splice(index - 1, 1);
            // 重建 cg_images 的序号映射（删除旧的，按新序号重写）
            const allImages = await new Promise((resolve, reject) => {
              const tx = this.db.db.transaction(STORE_CG_IMAGES, 'readonly');
              const idx = tx.objectStore(STORE_CG_IMAGES).index('group');
              const req = idx.getAll(IDBKeyRange.only(group));
              req.onsuccess = () => resolve(req.result);
              req.onerror = () => reject(new Error('查询失败'));
            });
            // 清除该组所有旧 cg_images
            await new Promise((resolve, reject) => {
              const tx = this.db.db.transaction(STORE_CG_IMAGES, 'readwrite');
              const store = tx.objectStore(STORE_CG_IMAGES);
              for (const img of allImages) store.delete(img.id);
              tx.oncomplete = () => resolve();
              tx.onerror = () => reject(new Error('清除失败'));
            });
            // 按新序号重写
            const sortedImages = allImages
              .filter(img => img.index !== index)
              .sort((a, b) => a.index - b.index);
            for (let i = 0; i < sortedImages.length; i++) {
              const newIdx = i + 1;
              const img = sortedImages[i];
              img.id = 'cg__' + group + '__' + newIdx;
              img.index = newIdx;
              await this.db._put(STORE_CG_IMAGES, img);
            }
            await this.db.updateCgGroup(group, { count: urls.length, imageUrls: urls });
          }
          this._renderCgGroupList();
        });
      });
    } catch (err) {
      listEl.innerHTML = '<div style="color:#e55;font-size:12px;">加载失败: ' + err.message + '</div>';
    }
  }

  // -- 情绪差分面板 --

  async _handleMoodToggle(name) {
    const doc = this._getMainDocument();
    const panel = doc.querySelector(`.bam-mood-panel[data-name="${name}"]`);
    if (!panel) return;

    if (this._expandedMoodName === name) {
      panel.style.display = 'none';
      this._expandedMoodName = null;
      return;
    }

    doc.querySelectorAll('.bam-mood-panel').forEach(p => { p.style.display = 'none'; });
    this._expandedMoodName = name;
    await this._renderMoodPanel(name);
  }

  async _renderMoodPanel(name) {
    const doc = this._getMainDocument();
    const panel = doc.querySelector(`.bam-mood-panel[data-name="${name}"]`);
    if (!panel) return;

    const charId = this._getActiveCharId();
    const safeName = escapeHtmlAttr(name);
    const moodAvatars = await this.db.listMoodAvatars(charId, name);
    const moodMap = new Map(moodAvatars.map(ma => [ma.moodId, ma]));
    const uploadedCount = moodMap.size;

    // 从 mood_config 动态读取颜色，回退到 MOOD_GROUPS 默认色
    const moodColorMap = new Map(MOOD_GROUPS.map(g => [g.id, g.color]));
    try {
      const raw = await this.db.getConfig('mood_config', null);
      if (raw) {
        const parsed = JSON.parse(raw);
        if (parsed && Array.isArray(parsed.groups)) {
          parsed.groups.forEach(g => { if (g.id && g.color) moodColorMap.set(g.id, g.color); });
        }
      }
    } catch (_) { /* 回退到默认色 */ }

    let html = `<div style="color:#999; font-size:11px; margin-bottom:8px;">情绪差分头像（已上传 ${uploadedCount}/8）</div>`;
    for (const group of MOOD_GROUPS) {
      const groupColor = moodColorMap.get(group.id) || group.color;
      const colorDot = `<span style="width:16px; height:16px; border-radius:50%; background:${groupColor}; display:inline-block; flex-shrink:0;"></span>`;
      const ma = moodMap.get(group.id);
      if (ma) {
        const blobUrl = await this.db.getMoodAvatarBlobUrl(charId, name, group.id);
        const safeMoodSrc = blobUrl || 'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7';
        const moodSourceTag = (ma.sourceUrl && ma.sourceUrl !== 'null')
          ? (ma.imageBlob ? '<span style="color:#58a6ff;font-size:9px;">远程✓</span>' : '<span style="color:#eab308;font-size:9px;">远程⏳</span>')
          : '<span style="color:#7ee787;font-size:9px;">本地</span>';
        html += `<div style="display:flex; align-items:center; gap:8px; padding:4px 0;">
          ${colorDot}
          <span style="width:40px; color:#aaa; font-size:12px;">${group.label}</span>
          <img src="${safeMoodSrc}" class="bam-avatar-thumb" data-preview-src="${safeMoodSrc}" data-preview-title="${safeName} · ${group.label}" style="width:32px; height:32px; border-radius:4px; object-fit:cover; border:1px solid rgba(255,255,255,0.1); cursor:pointer;" />
          ${moodSourceTag}
          <span style="flex:1; color:#666; font-size:11px;">${(ma.fileSize/1024).toFixed(1)} KB</span>
          <button class="bam-mood-action bam-mood-upload" data-name="${safeName}" data-mood-id="${group.id}" style="background:rgba(255,255,255,0.06); border:none; color:#888; padding:3px 8px; border-radius:4px; cursor:pointer; font-size:11px;">替换</button>
          <button class="bam-mood-action bam-mood-delete" data-name="${safeName}" data-mood-id="${group.id}" style="background:rgba(255,80,80,0.1); border:none; color:#e55; padding:3px 8px; border-radius:4px; cursor:pointer; font-size:11px;">删除</button>
        </div>`;
      } else {
        html += `<div style="display:flex; align-items:center; gap:8px; padding:4px 0;">
          ${colorDot}
          <span style="width:40px; color:#aaa; font-size:12px;">${group.label}</span>
          <button class="bam-mood-action bam-mood-upload" data-name="${safeName}" data-mood-id="${group.id}" style="flex:1; background:rgba(255,255,255,0.04); border:1px dashed rgba(255,255,255,0.1); color:#666; padding:4px 0; border-radius:4px; cursor:pointer; font-size:11px; text-align:center;">点击上传</button>
          <button class="bam-mood-action bam-mood-remote" data-name="${safeName}" data-mood-id="${group.id}" style="background:none; border:1px dashed rgba(74,108,247,0.3); color:#8ba4f7; padding:4px 8px; border-radius:4px; cursor:pointer; font-size:11px; flex-shrink:0;">🔗</button>
        </div>`;
      }
    }
    panel.innerHTML = html;
    panel.style.display = 'block';
  }

  async _handleMoodUpload(name, moodId) {
    const doc = this._getMainDocument();
    const charId = this._getActiveCharId();
    const moodBtn = doc.querySelector(`.bam-mood-upload[data-name="${name}"][data-mood-id="${moodId}"]`);
    const input = doc.createElement('input');
    input.type = 'file';
    input.accept = 'image/jpeg,image/png,image/gif,image/webp';
    input.onchange = async (e) => {
      const file = e.target.files[0];
      if (!file) return;
      if (file.size > 2 * 1024 * 1024) { alert('图片不能超过 2MB'); return; }
      const origText = moodBtn ? moodBtn.textContent : '';
      if (moodBtn) { moodBtn.disabled = true; moodBtn.textContent = '处理中...'; }
      try {
        const meta = await this._getImageMeta(file);
        const compOpts = await getCompressOptions(this.db);
        const blob = await compressImage(file, compOpts);
        await this.db.addMoodAvatar(charId, name, moodId, blob, meta);
        await this._renderMoodPanel(name);
        this._requestAvatarAssetPreviewRefresh();
      } catch (err) {
        alert('上传失败: ' + err.message);
        if (moodBtn) { moodBtn.disabled = false; moodBtn.textContent = origText; }
      }
    };
    input.click();
  }

  async _handleMoodRemoteUrl(name, moodId) {
    const url = prompt(`输入 "${name}" 的 ${moodId} 情绪差分远程图片 URL:`);
    if (!url || !url.trim()) return;
    const charId = this._getActiveCharId();
    try {
      const id = buildMoodAvatarKey(charId, name, moodId);
      const existing = await this.db._getByKey(STORE_MOOD_AVATARS, id);
      if (existing) {
        existing.sourceUrl = url.trim();
        existing.updatedAt = Date.now();
        await this.db._put(STORE_MOOD_AVATARS, existing);
      } else {
        const record = {
          id, charId, alias: name.trim().toLowerCase(), moodId,
          imageBlob: null, sourceUrl: url.trim(),
          mimeType: 'image/webp', fileName: '',
          fileSize: 0, width: 0, height: 0,
          createdAt: Date.now(), updatedAt: Date.now()
        };
        await this.db._put(STORE_MOOD_AVATARS, record);
      }
      await this._renderMoodPanel(name);
    } catch (err) { alert('设置失败: ' + err.message); }
  }

  async _handleMoodDelete(name, moodId) {
    const group = MOOD_GROUPS.find(g => g.id === moodId);
    if (!confirm(`确定删除 "${name}" 的 ${group?.label || moodId} 差分头像吗？`)) return;
    try {
      await this.db.deleteMoodAvatar(this._getActiveCharId(), name, moodId);
      await this._renderMoodPanel(name);
      this._requestAvatarAssetPreviewRefresh();
    } catch (err) { alert('删除失败: ' + err.message); }
  }

  // -- Tab 切换 --

  _switchTab(tabName) {
    const doc = this._getMainDocument();
    this.currentTab = tabName;
    doc.querySelectorAll('.bam-tab-btn').forEach(btn => {
      const isActive = btn.dataset.tab === tabName;
      btn.style.color = isActive ? '#e0e0e0' : '#666';
      btn.style.fontWeight = isActive ? '600' : '500';
      btn.style.borderBottomColor = isActive ? '#4a6cf7' : 'transparent';
    });
    const avatarTab = doc.getElementById('bam-tab-avatar');
    const styleTab = doc.getElementById('bam-tab-style');
    const moodTab = doc.getElementById('bam-tab-mood');
    const importBtn = doc.getElementById('bam-btn-import');
    const exportBtn = doc.getElementById('bam-btn-export');

    avatarTab.style.display = 'none';
    styleTab.style.display = 'none';
    moodTab.style.display = 'none';
    importBtn.style.display = 'none';
    exportBtn.style.display = 'none';

    if (tabName === 'avatar') {
      avatarTab.style.display = 'flex';
      importBtn.style.display = '';
      exportBtn.style.display = '';
      // 切换回头像管理时刷新已展开的差分面板（颜色可能在情绪配置页被修改）
      if (this._expandedMoodName) {
        this._renderMoodPanel(this._expandedMoodName);
      }
    } else if (tabName === 'style') {
      styleTab.style.display = 'flex';
      if (!this._styleDraftLoaded) this._loadStyleSettings();
      this._renderLocalFontList();
      this._renderCssFontSources();
    } else if (tabName === 'mood') {
      moodTab.style.display = 'flex';
      if (!this._moodConfigLoaded) this._loadMoodConfigTab();
    }
  }

  // -- 正文美化：加载配置 --

  _applyStyleSettingsToControls(settings) {
    const doc = this._getMainDocument();
    const $ = (s) => doc.querySelector(s);

    $('#bam-range-dialogue-font').value = settings.style_dialogueFontSize;
    $('#bam-val-dialogue-font').textContent = `${settings.style_dialogueFontSize}px`;
    $('#bam-range-narration-font').value = settings.style_narrationFontSize;
    $('#bam-val-narration-font').textContent = `${settings.style_narrationFontSize}px`;
    $('#bam-range-dialogue-spacing').value = settings.style_dialogueSpacing;
    $('#bam-val-dialogue-spacing').textContent = `${settings.style_dialogueSpacing}px`;
    $('#bam-range-dialogue-weight').value = settings.style_dialogueFontWeight;
    $('#bam-val-dialogue-weight').textContent = `${settings.style_dialogueFontWeight}`;
    $('#bam-range-narration-weight').value = settings.style_narrationFontWeight;
    $('#bam-val-narration-weight').textContent = `${settings.style_narrationFontWeight}`;
    $('#bam-range-name-weight').value = settings.style_nameFontWeight;
    $('#bam-val-name-weight').textContent = `${settings.style_nameFontWeight}`;
    $('#bam-global-color-picker').value = settings.style_globalTextColor;
    $('#bam-narration-bg-color').value = settings.style_narrationBgColor;
    $('#bam-range-narration-bg-opacity').value = settings.style_narrationBgOpacity;
    $('#bam-val-narration-bg-opacity').textContent = Number.parseFloat(settings.style_narrationBgOpacity).toFixed(2);
    $('#bam-range-avatar-size').value = settings.style_avatarSize;
    $('#bam-val-avatar-size').textContent = `${settings.style_avatarSize}px`;
    $('#bam-range-narration-indent').value = settings.style_narrationIndent;
    $('#bam-val-narration-indent').textContent = `${settings.style_narrationIndent}px`;
    $('#bam-range-narration-border-radius').value = settings.style_narrationBorderRadius;
    $('#bam-val-narration-border-radius').textContent = `${settings.style_narrationBorderRadius}px`;
    $('#bam-range-thought-suffix-gap').value = settings.style_thoughtSuffixGap;
    $('#bam-val-thought-suffix-gap').textContent = `${settings.style_thoughtSuffixGap}px`;
    $('#bam-range-thought-suffix-offset-y').value = settings.style_thoughtSuffixOffsetY;
    $('#bam-val-thought-suffix-offset-y').textContent = `${settings.style_thoughtSuffixOffsetY}px`;
    // v7.0
    if ($('#bam-range-narration-text-indent')) {
      $('#bam-range-narration-text-indent').value = settings.style_narrationTextIndent;
      $('#bam-val-narration-text-indent').textContent = `${settings.style_narrationTextIndent}em`;
    }
    if ($('#bam-range-narration-line-height')) {
      $('#bam-range-narration-line-height').value = settings.style_narrationLineHeight;
      $('#bam-val-narration-line-height').textContent = `${settings.style_narrationLineHeight}`;
    }
    if ($('#bam-range-narration-padding-right')) {
      $('#bam-range-narration-padding-right').value = settings.style_narrationPaddingRight;
      $('#bam-val-narration-padding-right').textContent = `${settings.style_narrationPaddingRight}px`;
    }
    if ($('#bam-chk-compress-enabled')) {
      $('#bam-chk-compress-enabled').checked = settings.style_imageCompressEnabled !== false && settings.style_imageCompressEnabled !== 'false';
    }
    if ($('#bam-range-compress-quality')) {
      $('#bam-range-compress-quality').value = settings.style_imageCompressQuality;
      $('#bam-val-compress-quality').textContent = `${Number(settings.style_imageCompressQuality).toFixed(2)}`;
    }
    $('#bam-font-url-input').value = settings.style_fontConfigUrl || '';

    doc.querySelectorAll('input[name="bam-color-mode"]').forEach((radio) => {
      radio.checked = radio.value === settings.style_textColorMode;
    });
    doc.querySelectorAll('input[name="bam-md-mode"]').forEach((radio) => {
      radio.checked = radio.value === settings.style_markdownMode;
    });
    doc.querySelectorAll('input[name="bam-avatar-shape"]').forEach((radio) => {
      radio.checked = radio.value === settings.style_avatarShape;
    });

    $('#bam-select-narration-font').value = settings.style_narrationFontFamily;
    $('#bam-select-dialogue-font').value = settings.style_dialogueFontFamily;
    $('#bam-select-name-font').value = settings.style_nameFontFamily;
  }

  _setStyleDraftDirty(isDirty) {
    this._styleDraftDirty = Boolean(isDirty);
    const doc = this._getMainDocument();
    const saveBtn = doc.getElementById('bam-btn-save-style');
    const tipEl = doc.getElementById('bam-style-save-tip');
    if (saveBtn) {
      saveBtn.disabled = !this._styleDraftDirty;
      saveBtn.style.opacity = this._styleDraftDirty ? '1' : '0.65';
      saveBtn.style.cursor = this._styleDraftDirty ? 'pointer' : 'default';
    }
    if (tipEl) {
      tipEl.textContent = this._styleDraftDirty
        ? '当前调整仅作用于预览，点击保存后下次静态重渲染会读取新值'
        : '当前样式已保存；调整时只影响预览，点击保存后下次静态重渲染读取新值';
    }
  }

  async _loadStyleSettings() {
    const settings = this._getDefaultStyleSettings();
    for (const key of Object.keys(settings)) {
      settings[key] = await this.db.getConfig(key, settings[key]);
    }

    this._applyStyleSettingsToControls(settings);
    await this._refreshFontSelectors({ silent: true });
    this._applyStyleSettingsToControls(settings);
    this._styleDraftLoaded = true;
    this._setStyleDraftDirty(false);
    await this._applyBubblePreviewStyles(settings);
  }

  // -- 正文美化：保存当前草稿 --

  async _saveCurrentStyleSettings() {
    const settings = this._getLiveStyleSettings();
    try {
      writeStyleSnapshot(settings, { replace: true });
      await Promise.all(Object.entries(settings).map(([key, value]) => this.db.setConfig(key, value)));
      this._styleDraftLoaded = true;
      this._setStyleDraftDirty(false);
    }
    catch (err) {
      console.error('保存样式配置失败:', err);
      alert('保存样式失败: ' + err.message);
    }
  }

  // -- 正文美化：恢复默认草稿 --

  async _resetStyleDefaults() {
    const defaults = this._getDefaultStyleSettings();
    this._applyStyleSettingsToControls(defaults);
    await this._refreshFontSelectors({ silent: true });
    this._applyStyleSettingsToControls(defaults);
    this._styleDraftLoaded = true;
    this._setStyleDraftDirty(true);
    await this._applyBubblePreviewStyles(defaults);
  }

  // -- 情绪配置 Tab --

  async _loadMoodConfigTab() {
    // 从 IndexedDB 读取已保存的配置，回退到默认值
    const formatRule = await this.db.getConfig('format_rule', null);
    this._formatRuleDraft = (formatRule && typeof formatRule === 'string' && formatRule.trim())
      ? formatRule
      : DEFAULT_FORMAT_RULE;

    // 读取情绪词提示词模板
    const moodPromptTemplate = await this.db.getConfig('mood_prompt_template', null);
    this._moodPromptTemplateDraft = (moodPromptTemplate && typeof moodPromptTemplate === 'string' && moodPromptTemplate.trim())
      ? moodPromptTemplate
      : DEFAULT_MOOD_PROMPT_TEMPLATE;

    const moodConfigRaw = await this.db.getConfig('mood_config', null);
    if (moodConfigRaw) {
      try {
        const parsed = JSON.parse(moodConfigRaw);
        this._moodConfigDraft = Array.isArray(parsed.groups)
          ? parsed.groups.map(g => ({ ...g, words: [...g.words] }))
          : DEFAULT_MOOD_GROUPS.map(g => ({ ...g, words: [...g.words] }));
      } catch (_) {
        this._moodConfigDraft = DEFAULT_MOOD_GROUPS.map(g => ({ ...g, words: [...g.words] }));
      }
    } else {
      this._moodConfigDraft = DEFAULT_MOOD_GROUPS.map(g => ({ ...g, words: [...g.words] }));
    }

    this._moodConfigLoaded = true;
    this._moodConfigDirty = false;
    this._renderMoodConfigContent();
    this._bindMoodConfigEvents();
  }

  _renderMoodConfigContent() {
    const doc = this._getMainDocument();
    const container = doc.getElementById('bam-tab-mood');
    if (!container) return;

    let html = '';

    // 格式规则区域
    html += `
      <div style="color:#666; font-size:11px; text-transform:uppercase; letter-spacing:1px; margin-bottom:10px; border-bottom:1px solid rgba(255,255,255,0.06); padding-bottom:6px;">格式规则</div>
      <div style="color:#b08a3a; font-size:11px; margin-bottom:8px; padding:6px 10px; background:rgba(176,138,58,0.1); border-radius:6px;">⚠ 修改格式规则可能导致 AI 输出格式异常，请谨慎编辑。如遇问题，点击「恢复默认格式」还原。</div>
      <textarea id="bam-format-rule-textarea" style="
        width:100%; min-height:200px; max-height:300px; resize:vertical;
        background:rgba(0,0,0,0.3); border:1px solid rgba(255,255,255,0.1);
        border-radius:8px; padding:10px; color:#d0d0d0; font-size:12px;
        font-family:'Fira Code','Source Code Pro',monospace; line-height:1.5;
        outline:none; box-sizing:border-box;
      ">${escapeHtmlAttr(this._formatRuleDraft)}</textarea>
      <div style="display:flex; justify-content:flex-end; margin:8px 0 16px;">
        <button id="bam-btn-reset-format-rule" style="background:rgba(255,255,255,0.06); border:none; color:#aaa; padding:6px 14px; border-radius:6px; cursor:pointer; font-size:12px;">恢复默认格式</button>
      </div>
    `;

    // 情绪词配置区域
    html += `<div style="color:#666; font-size:11px; text-transform:uppercase; letter-spacing:1px; margin-bottom:10px; border-bottom:1px solid rgba(255,255,255,0.06); padding-bottom:6px;">情绪词配置</div>`;

    for (let gi = 0; gi < this._moodConfigDraft.length; gi++) {
      const group = this._moodConfigDraft[gi];
      html += `
      <div class="bam-mood-group" data-group-index="${gi}" style="margin-bottom:14px;">
        <div style="display:flex; align-items:center; gap:8px; margin-bottom:6px;">
          <span style="width:16px; height:16px; border-radius:50%; background:${group.color}; display:inline-block; flex-shrink:0;"></span>
          <span style="color:#ccc; font-size:13px; font-weight:600;">${group.label}</span>
          <input type="color" class="bam-mood-color-picker" data-group-index="${gi}" value="${group.color}"
            style="width:24px; height:24px; border:none; background:none; cursor:pointer; padding:0; margin-left:auto;" title="修改分类颜色" />
        </div>
        <div class="bam-mood-words-container" data-group-index="${gi}" style="display:flex; flex-wrap:wrap; gap:6px; padding:8px 10px; background:rgba(255,255,255,0.03); border-radius:8px;">`;

      for (let wi = 0; wi < group.words.length; wi++) {
        const word = group.words[wi];
        html += `<span class="bam-mood-word-tag" style="display:inline-flex; align-items:center; gap:4px; padding:3px 8px; background:rgba(255,255,255,0.06); border-radius:4px; font-size:12px; color:#ccc;">
          ${escapeHtmlAttr(word)}<button class="bam-mood-word-delete" data-group-index="${gi}" data-word-index="${wi}" style="background:none; border:none; color:#888; cursor:pointer; font-size:14px; padding:0 2px; line-height:1;">&times;</button>
        </span>`;
      }

      html += `
          <button class="bam-mood-word-add" data-group-index="${gi}" style="display:inline-flex; align-items:center; padding:3px 8px; background:rgba(74,108,247,0.12); border:1px dashed rgba(74,108,247,0.3); border-radius:4px; color:#8ba4f7; font-size:12px; cursor:pointer;">+ 添加</button>
        </div>
      </div>`;
    }

    // 情绪词提示词模板区域
    html += `
      <div style="color:#666; font-size:11px; text-transform:uppercase; letter-spacing:1px; margin:16px 0 10px; border-bottom:1px solid rgba(255,255,255,0.06); padding-bottom:6px;">情绪词提示词模板</div>
      <div style="color:#6b8acd; font-size:11px; margin-bottom:8px; padding:6px 10px; background:rgba(107,138,205,0.1); border-radius:6px;">
        ℹ 此模板控制注入给 AI 的情绪词约束提示词。使用 <code style="background:rgba(255,255,255,0.1);padding:1px 4px;border-radius:3px;">{{mood_groups}}</code> 占位符表示情绪词分组列表（保存时自动替换为实际词库）。
      </div>
      <textarea id="bam-mood-prompt-template-textarea" style="
        width:100%; min-height:120px; max-height:200px; resize:vertical;
        background:rgba(0,0,0,0.3); border:1px solid rgba(255,255,255,0.1);
        border-radius:8px; padding:10px; color:#d0d0d0; font-size:12px;
        font-family:'Fira Code','Source Code Pro',monospace; line-height:1.5;
        outline:none; box-sizing:border-box;
      ">${escapeHtmlAttr(this._moodPromptTemplateDraft)}</textarea>
      <div style="display:flex; justify-content:flex-end; margin:8px 0 16px;">
        <button id="bam-btn-reset-mood-prompt-template" style="background:rgba(255,255,255,0.06); border:none; color:#aaa; padding:6px 14px; border-radius:6px; cursor:pointer; font-size:12px;">恢复默认模板</button>
      </div>
    `;

    // 底部按钮
    html += `
      <div style="display:flex; justify-content:center; gap:12px; margin:16px 0 8px;">
        <button id="bam-btn-save-mood" style="background:#4a6cf7; border:none; color:#fff; padding:8px 24px; border-radius:6px; cursor:pointer; font-size:13px;">保存</button>
        <button id="bam-btn-reset-mood" style="background:rgba(255,255,255,0.06); border:none; color:#aaa; padding:8px 24px; border-radius:6px; cursor:pointer; font-size:13px;">恢复默认</button>
      </div>
      <div id="bam-mood-save-tip" style="text-align:center; color:#555; font-size:11px; padding:8px 0;">
        修改后点击保存生效；保存后格式规则和情绪词将同步更新到 AI 注入</div>
    `;

    container.innerHTML = html;
  }

  _bindMoodConfigEvents() {
    const doc = this._getMainDocument();
    const moodTab = doc.getElementById('bam-tab-mood');
    if (!moodTab) return;

    // 格式规则文本变化
    const textarea = doc.getElementById('bam-format-rule-textarea');
    textarea?.addEventListener('input', () => {
      this._formatRuleDraft = textarea.value;
      this._moodConfigDirty = true;
    });

    // 情绪词提示词模板文本变化
    const moodPromptTextarea = doc.getElementById('bam-mood-prompt-template-textarea');
    moodPromptTextarea?.addEventListener('input', () => {
      this._moodPromptTemplateDraft = moodPromptTextarea.value;
      this._moodConfigDirty = true;
    });

    // 情绪词删除
    moodTab.addEventListener('click', (e) => {
      const delBtn = e.target.closest('.bam-mood-word-delete');
      if (!delBtn) return;
      const gi = parseInt(delBtn.dataset.groupIndex, 10);
      const wi = parseInt(delBtn.dataset.wordIndex, 10);
      const group = this._moodConfigDraft[gi];
      if (!group) return;
      if (group.words.length <= 1) { alert('每个分类至少保留 1 个情绪词'); return; }
      group.words.splice(wi, 1);
      this._moodConfigDirty = true;
      this._renderMoodConfigContent();
      this._rebindMoodConfigDynamicEvents();
    });

    // 情绪词添加
    moodTab.addEventListener('click', (e) => {
      const addBtn = e.target.closest('.bam-mood-word-add');
      if (!addBtn) return;
      const gi = parseInt(addBtn.dataset.groupIndex, 10);
      const group = this._moodConfigDraft[gi];
      if (!group) return;
      const word = prompt('请输入 2~3 个汉字的情绪词：');
      if (!word) return;
      const trimmed = word.trim();
      if (!/^[\u4e00-\u9fff]{2,3}$/.test(trimmed)) { alert('情绪词必须为 2~3 个汉字'); return; }
      // 跨分类去重
      for (const g of this._moodConfigDraft) {
        if (g.words.includes(trimmed)) {
          alert(`「${trimmed}」已存在于「${g.label}」分类中，不可重复`);
          return;
        }
      }
      group.words.push(trimmed);
      this._moodConfigDirty = true;
      this._renderMoodConfigContent();
      this._rebindMoodConfigDynamicEvents();
    });

    // 颜色调色盘
    moodTab.addEventListener('input', (e) => {
      const colorPicker = e.target.closest('.bam-mood-color-picker');
      if (!colorPicker) return;
      const gi = parseInt(colorPicker.dataset.groupIndex, 10);
      if (this._moodConfigDraft[gi]) {
        this._moodConfigDraft[gi].color = colorPicker.value;
        this._moodConfigDirty = true;
        // 同步更新色块
        const groupEl = colorPicker.closest('.bam-mood-group');
        if (groupEl) {
          const dot = groupEl.querySelector('span[style*="border-radius:50%"]');
          if (dot) dot.style.background = colorPicker.value;
        }
      }
    });

    // 保存按钮（事件委托，避免 innerHTML 重建后丢失）
    moodTab.addEventListener('click', async (e) => {
      if (e.target.closest('#bam-btn-save-mood')) {
        await this._saveMoodConfig();
      }
    });

    // 恢复默认按钮（事件委托）
    moodTab.addEventListener('click', (e) => {
      if (e.target.closest('#bam-btn-reset-mood')) {
        if (!confirm('确定恢复为默认的格式规则、情绪词配置和提示词模板？')) return;
        this._formatRuleDraft = DEFAULT_FORMAT_RULE;
        this._moodPromptTemplateDraft = DEFAULT_MOOD_PROMPT_TEMPLATE;
        this._moodConfigDraft = DEFAULT_MOOD_GROUPS.map(g => ({ ...g, words: [...g.words] }));
        this._moodConfigDirty = true;
        this._renderMoodConfigContent();
        this._rebindMoodConfigDynamicEvents();
      }
    });

    // 恢复默认格式按钮（事件委托）
    moodTab.addEventListener('click', (e) => {
      if (e.target.closest('#bam-btn-reset-format-rule')) {
        this._formatRuleDraft = DEFAULT_FORMAT_RULE;
        const ta = doc.getElementById('bam-format-rule-textarea');
        if (ta) ta.value = DEFAULT_FORMAT_RULE;
        this._moodConfigDirty = true;
      }
    });

    // 恢复默认情绪词提示词模板按钮（事件委托）
    moodTab.addEventListener('click', (e) => {
      if (e.target.closest('#bam-btn-reset-mood-prompt-template')) {
        this._moodPromptTemplateDraft = DEFAULT_MOOD_PROMPT_TEMPLATE;
        const ta = doc.getElementById('bam-mood-prompt-template-textarea');
        if (ta) ta.value = DEFAULT_MOOD_PROMPT_TEMPLATE;
        this._moodConfigDirty = true;
      }
    });
  }

  _rebindMoodConfigDynamicEvents() {
    // 重新渲染后需要重新绑定 textarea 的 input 事件
    const doc = this._getMainDocument();
    const textarea = doc.getElementById('bam-format-rule-textarea');
    textarea?.addEventListener('input', () => {
      this._formatRuleDraft = textarea.value;
      this._moodConfigDirty = true;
    });
    const moodPromptTextarea = doc.getElementById('bam-mood-prompt-template-textarea');
    moodPromptTextarea?.addEventListener('input', () => {
      this._moodPromptTemplateDraft = moodPromptTextarea.value;
      this._moodConfigDirty = true;
    });
  }

  async _saveMoodConfig() {
    try {
      // 保存格式规则
      await this.db.setConfig('format_rule', this._formatRuleDraft);

      // 保存情绪词提示词模板
      await this.db.setConfig('mood_prompt_template', this._moodPromptTemplateDraft);

      // 保存情绪配置
      const moodConfig = {
        version: '6.0',
        groups: this._moodConfigDraft.map(g => ({
          id: g.id,
          label: g.label,
          color: g.color,
          words: [...g.words],
        })),
      };
      await this.db.setConfig('mood_config', JSON.stringify(moodConfig));

      // 刷新注入缓存 + 重新注入
      invalidateInjectionCache();
      await applyInjection(this.db);

      // 刷新已展开的情绪差分面板（颜色色块同步）
      if (this._expandedMoodName) {
        await this._renderMoodPanel(this._expandedMoodName);
      }

      // 触发渲染预览刷新（情绪胶囊颜色同步）
      this._requestAvatarAssetPreviewRefresh();

      this._moodConfigDirty = false;
      const tipEl = this._getMainDocument().getElementById('bam-mood-save-tip');
      if (tipEl) tipEl.textContent = '✓ 已保存，格式规则和情绪词已同步更新到 AI 注入';
      setTimeout(() => {
        if (tipEl) tipEl.textContent = '修改后点击保存生效；保存后格式规则和情绪词将同步更新到 AI 注入';
      }, 3000);
    } catch (err) {
      console.error('保存情绪配置失败:', err);
      alert('保存失败: ' + err.message);
    }
  }
}


// ████████████████████████████████████████████████████████████
// █                                                        █
// █  Part 2.5: 格式规则 + 情绪词统一动态注入               █
// █                                                        █
// ████████████████████████████████████████████████████████████

const PROMPT_INJECTION_ID = 'bubble-dialogue-format-and-mood';
let _injectionHandle = null;
let _injectionCache = null;

/**
 * 从 IndexedDB 读取格式规则 + 情绪配置 + 情绪词提示词模板，构建注入文本
 * 格式规则从 config.format_rule 读取（用户可编辑）
 * 情绪配置从 config.mood_config 读取（用户可自定义）
 * 情绪词提示词模板从 config.mood_prompt_template 读取（用户可自定义，支持 {{mood_groups}} 占位符）
 * 首次读取后缓存到内存，配置修改后需调用 invalidateInjectionCache() 刷新
 */
async function buildInjectionPrompt(db) {
  if (_injectionCache) return _injectionCache;

  // 读取格式规则（可编辑文本）
  const formatRule = await db.getConfig('format_rule', null);
  const ruleText = (formatRule && typeof formatRule === 'string' && formatRule.trim())
    ? formatRule.trim()
    : DEFAULT_FORMAT_RULE;

  // 读取情绪配置
  const moodConfigRaw = await db.getConfig('mood_config', null);
  let groups;
  if (moodConfigRaw) {
    try {
      const parsed = JSON.parse(moodConfigRaw);
      groups = Array.isArray(parsed.groups) ? parsed.groups : DEFAULT_MOOD_GROUPS;
    } catch (e) {
      groups = DEFAULT_MOOD_GROUPS;
    }
  } else {
    groups = DEFAULT_MOOD_GROUPS;
  }

  // 读取情绪词提示词模板
  const moodPromptTemplate = await db.getConfig('mood_prompt_template', null);
  const template = (moodPromptTemplate && typeof moodPromptTemplate === 'string' && moodPromptTemplate.trim())
    ? moodPromptTemplate.trim()
    : DEFAULT_MOOD_PROMPT_TEMPLATE;

  // 构建情绪词分组文本
  let groupsText = '';
  for (const group of groups) {
    groupsText += `${group.label}组：${group.words.join('、')}\n`;
  }
  groupsText = groupsText.trimEnd();

  // 用模板渲染：替换 {{mood_groups}} 占位符
  const moodText = template.replace(/\{\{mood_groups\}\}/g, groupsText);

  // 合并：格式规则在前，情绪词约束在后
  _injectionCache = ruleText + '\n\n' + moodText;
  return _injectionCache;
}

/**
 * 刷新注入缓存（配置页保存后调用）
 */
function invalidateInjectionCache() {
  _injectionCache = null;
}

/**
 * 执行注入：优先使用酒馆助手 injectPrompts API，回退到酒馆原生 setExtensionPrompt
 * 三层降级：injectPrompts → setExtensionPrompt → 控制台警告
 */
async function applyInjection(db) {
  // 先清除旧注入
  if (_injectionHandle) {
    try { _injectionHandle.uninject(); } catch (_) {}
    _injectionHandle = null;
  }

  let content;
  try {
    content = await buildInjectionPrompt(db);
  } catch (err) {
    console.warn('[BubbleDialogue] 构建注入文本失败:', err);
    return;
  }

  if (!content) {
    console.warn('[BubbleDialogue] 注入内容为空，跳过注入');
    return;
  }

  // 第一层：酒馆助手 injectPrompts API
  if (typeof injectPrompts === 'function') {
    try {
      _injectionHandle = injectPrompts([{
        id: PROMPT_INJECTION_ID,
        position: 'in_chat',
        depth: 0,
        role: 'system',
        content: content,
        should_scan: false,
      }]);
      console.log('[BubbleDialogue] 格式规则+情绪词已通过 injectPrompts 注入');
      return;
    } catch (err) {
      console.warn('[BubbleDialogue] injectPrompts 调用失败，尝试回退:', err);
    }
  }

  // 第二层：酒馆原生 setExtensionPrompt API
  try {
    const context = getCurrentContext();
    if (context && typeof context.setExtensionPrompt === 'function') {
      context.setExtensionPrompt(
        'bubble-dialogue-format',
        content,
        0,    // position: IN_PROMPT
        0,    // depth: 0（紧贴最新）
        false, // scan: 不扫描世界书
        0     // role: SYSTEM
      );
      console.log('[BubbleDialogue] 格式规则+情绪词已通过 setExtensionPrompt 注入');
      return;
    }
  } catch (err) {
    console.warn('[BubbleDialogue] setExtensionPrompt 调用失败:', err);
  }

  // 第三层：全部失败
  console.warn('[BubbleDialogue] ⚠ 格式规则注入未生效：injectPrompts 和 setExtensionPrompt 均不可用。请检查酒馆助手是否已安装。');
}


// ████████████████████████████████████████████████████████████
// █  Part 2.5: CG 图片库拉取引擎 + 公开 API                  █
// ████████████████████████████████████████████████████████████

async function parseAlbumUrl(input) {
  // 方式一：直接 URL 列表（多行，每行一个图片 URL，无需 fetch）
  const lines = input.split(/[\n\r]+/).map(l => l.trim()).filter(Boolean);
  if (lines.length > 1 || (lines.length === 1 && IMAGE_EXTS_RE.test(lines[0]))) {
    const directUrls = lines.filter(l => /^https?:\/\//i.test(l) && IMAGE_EXTS_RE.test(l));
    if (directUrls.length > 0) return directUrls;
  }

  // 方式二/三：fetch URL → GitHub API / JSON 清单 / HTML 兜底
  const controller = typeof AbortController === 'function' ? new AbortController() : null;
  const timer = controller ? setTimeout(() => controller.abort(), CG_FETCH_TIMEOUT) : null;
  try {
    let resp;
    try {
      resp = await fetch(input, { signal: controller?.signal });
    } catch (fetchErr) {
      throw new Error(`无法访问该 URL（可能被 CORS 拦截）。\n建议改为直接粘贴图片 URL 列表（每行一个）。`);
    }
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    const text = await resp.text();
    let json;
    try { json = JSON.parse(text); } catch (_) { json = null; }

    if (json) {
      // GitHub Contents API 格式
      if (Array.isArray(json) && json.length && json[0].download_url && json[0].type) {
        return json
          .filter(item => item.type === 'file' && IMAGE_EXTS_RE.test(item.name))
          .sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }))
          .map(item => item.download_url);
      }
      // 通用 JSON 清单：{images:[...]} 或纯数组
      const arr = Array.isArray(json) ? json : (Array.isArray(json.images) ? json.images : null);
      if (arr && arr.length && typeof arr[0] === 'string') {
        return arr.filter(u => typeof u === 'string' && IMAGE_EXTS_RE.test(u));
      }
    }

    // HTML 页面（catbox 等）：正则提取图片链接
    const urlPattern = /https?:\/\/[^\s"'<>]+?\.(webp|png|jpg|jpeg|gif|bmp|avif)(?=[?\s"'<>]|$)/gi;
    const allUrls = [...new Set(text.match(urlPattern) || [])];
    return allUrls.filter(u => IMAGE_EXTS_RE.test(u));
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function ensureCgGroupIndex(db, group) {
  const groupInfo = await db.getCgGroup(group);
  if (!groupInfo) throw new Error(`CG 组 "${group}" 未注册`);
  if (groupInfo.imageUrls && groupInfo.imageUrls.length > 0) return groupInfo;
  const urls = await parseAlbumUrl(groupInfo.albumUrl);
  if (!urls.length) throw new Error(`CG 组 "${group}" 清单为空`);
  await db.updateCgGroup(group, { imageUrls: urls, count: urls.length });
  return { ...groupInfo, imageUrls: urls, count: urls.length };
}

async function fetchCgImage(db, group, index) {
  const cached = await db.getCgImage(group, index);
  if (cached && cached.imageBlob) return cached.imageBlob;
  const groupInfo = await ensureCgGroupIndex(db, group);
  if (index < 1 || index > groupInfo.count) return null;
  const url = groupInfo.imageUrls[index - 1];
  if (!url) return null;
  const compOpts = await getCompressOptions(db);
  const controller = typeof AbortController === 'function' ? new AbortController() : null;
  const timer = controller ? setTimeout(() => controller.abort(), CG_FETCH_TIMEOUT) : null;
  try {
    const resp = await fetch(url, { signal: controller?.signal });
    if (!resp.ok) return null;
    let blob = await resp.blob();
    blob = await compressImage(blob, compOpts);
    await db.putCgImage(group, index, blob, url);
    return blob;
  } catch (e) {
    console.warn(`[CG] 拉取 ${group}#${index} 失败:`, e);
    return null;
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function preloadCgGroup(db, group, onProgress) {
  const groupInfo = await ensureCgGroupIndex(db, group);
  const compOpts = await getCompressOptions(db);
  let loaded = 0, skipped = 0, failed = 0;
  for (let i = 1; i <= groupInfo.count; i++) {
    const cached = await db.getCgImage(group, i);
    if (cached && cached.imageBlob) { skipped++; continue; }
    const url = groupInfo.imageUrls[i - 1];
    try {
      const resp = await fetch(url);
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
      let blob = await resp.blob();
      blob = await compressImage(blob, compOpts);
      await db.putCgImage(group, i, blob, url);
      loaded++;
    } catch (_) { failed++; }
    if (onProgress) onProgress({ loaded, skipped, failed, total: groupInfo.count, current: i });
  }
  return { loaded, skipped, failed };
}

// ████████████████████████████████████████████████████████████
// █  Part 3: 初始化入口                                    █
// ████████████████████████████████████████████████████████████

const avatarDB = new AvatarDB();
const avatarManagerPanel = new AvatarManagerPanel(avatarDB);
window.avatarDB = avatarDB;
window.avatarManagerPanel = avatarManagerPanel;

// v7.0: CG 图片库公开 API
window.BubbleCG = {
  async getImage(group, index) {
    const cached = await avatarDB.getCgImage(group, index);
    if (cached && cached.imageBlob) return URL.createObjectURL(cached.imageBlob);
    const blob = await fetchCgImage(avatarDB, group, index);
    return blob ? URL.createObjectURL(blob) : null;
  },
  async getRandomImage(group) {
    const groupInfo = await ensureCgGroupIndex(avatarDB, group);
    if (!groupInfo || !groupInfo.count) return null;
    const index = Math.floor(Math.random() * groupInfo.count) + 1;
    return this.getImage(group, index);
  },
  async preloadGroup(group) {
    return preloadCgGroup(avatarDB, group);
  }
};
// 挂到所有可达的父级 window，让任意层级的 iframe 都能找到
try { if (window.parent && window.parent !== window) window.parent.BubbleCG = window.BubbleCG; } catch (_) {}
try { if (window.top && window.top !== window) window.top.BubbleCG = window.BubbleCG; } catch (_) {}

// v7.0: 头像公开 API
window.BubbleAvatar = {
  async getAvatar(name, charId) {
    const safeCharId = String(charId || getCurrentCharId() || GLOBAL_CHAR_ID);
    // 当前角色卡
    let record = await avatarDB.get(safeCharId, name);
    if (!record && safeCharId !== GLOBAL_CHAR_ID) {
      record = await avatarDB.get(GLOBAL_CHAR_ID, name);
    }
    if (!record) return null;
    if (record.imageBlob) return URL.createObjectURL(record.imageBlob);
    // 远程头像懒加载
    if (record.sourceUrl && record.sourceUrl !== 'null' && record.sourceUrl.startsWith('http')) {
      try {
        const resp = await fetch(record.sourceUrl);
        if (resp.ok) {
          const blob = await resp.blob();
          record.imageBlob = blob; record.fileSize = blob.size; record.updatedAt = Date.now();
          await avatarDB._put(STORE_AVATARS, record);
          return URL.createObjectURL(blob);
        }
      } catch (_) {}
    }
    return null;
  },
  async getMoodAvatar(name, mood, charId) {
    const safeCharId = String(charId || getCurrentCharId() || GLOBAL_CHAR_ID);
    let moodId = mood;
    const group = MOOD_GROUPS.find(g => g.id === mood || g.label === mood);
    if (group) moodId = group.id;
    let record = await avatarDB.getMoodAvatar(safeCharId, name, moodId);
    if (!record && safeCharId !== GLOBAL_CHAR_ID) {
      record = await avatarDB.getMoodAvatar(GLOBAL_CHAR_ID, name, moodId);
    }
    if (!record) return null;
    if (record.imageBlob) return URL.createObjectURL(record.imageBlob);
    // 远程懒加载
    if (record.sourceUrl && record.sourceUrl !== 'null' && record.sourceUrl.startsWith('http')) {
      try {
        const resp = await fetch(record.sourceUrl);
        if (resp.ok) {
          const blob = await resp.blob();
          record.imageBlob = blob; record.fileSize = blob.size; record.updatedAt = Date.now();
          await avatarDB._put(STORE_MOOD_AVATARS, record);
          return URL.createObjectURL(blob);
        }
      } catch (_) {}
    }
    return null;
  },
  async getColor(name, charId) {
    const safeCharId = String(charId || getCurrentCharId() || GLOBAL_CHAR_ID);
    const color = await avatarDB.getConfig(buildColorConfigKey(safeCharId, name), null);
    if (color) return color;
    if (safeCharId !== GLOBAL_CHAR_ID) {
      return avatarDB.getConfig(buildColorConfigKey(GLOBAL_CHAR_ID, name), null);
    }
    return null;
  }
};
try { if (window.parent && window.parent !== window) window.parent.BubbleAvatar = window.BubbleAvatar; } catch (_) {}
try { if (window.top && window.top !== window) window.top.BubbleAvatar = window.BubbleAvatar; } catch (_) {}

function injectWandMenuItem() {
  // 尝试获取酒馆主页面 document（脚本可能跑在 iframe 里）
  let doc;
  const candidates = [];
  try { if (window.top && window.top.document) candidates.push(window.top.document); } catch (_) {}
  try { if (window.parent && window.parent.document && window.parent.document !== document) candidates.push(window.parent.document); } catch (_) {}
  candidates.push(document);

  let menu = null;
  for (const d of candidates) {
    try {
      menu = d.getElementById('extensionsMenu')
        || d.getElementById('extensions_menu')
        || d.querySelector('#extensionsMenu')
        || d.querySelector('.extensions_block .list-group');
      if (menu) { doc = d; break; }
    } catch (_) {}
  }

  if (!menu) {
    setTimeout(injectWandMenuItem, 1000);
    return;
  }
  // 旧按钮残留（事件可能已失效）→ 删掉重建
  const oldBtn = doc.getElementById('bubble-avatar-wand-btn');
  if (oldBtn) oldBtn.remove();

  const mi = doc.createElement('a');
  mi.id = 'bubble-avatar-wand-btn';
  mi.className = 'list-group-item';
  mi.href = 'javascript:void(0)';
  mi.innerHTML = '<span class="fa-solid fa-comments"></span> 对话气泡';
  mi.addEventListener('click', (e) => {
    e.preventDefault(); e.stopPropagation();
    avatarManagerPanel.open().catch(err => {
      console.error('[BubbleDialogue] open() 失败:', err);
    });
    try { menu.parentElement?.click?.(); } catch (_) {}
  });
  menu.appendChild(mi);
}

$(() => {
  // 注册酒馆助手按钮事件（可能尚未加载，用 try-catch 保护）
  try {
    if (typeof eventOn === 'function' && typeof getButtonEvent === 'function') {
      eventOn(getButtonEvent('对话气泡'), () => {
        avatarManagerPanel.open().catch(err => console.error('[BubbleDialogue] open() 失败:', err));
      });
    }
  } catch (e) {
    console.warn('[BubbleDialogue] 酒馆助手按钮事件注册失败:', e);
  }

  avatarDB.init().then(() => {
    // DB 就绪后立即执行首次注入
    applyInjection(avatarDB);
  }).catch((err) => {
    console.warn('[BubbleDialogue] DB 初始化失败:', err);
  });

  injectWandMenuItem();
  // v7.0: 定期重注入魔法棒按钮（酒馆菜单重建或脚本热重载时旧按钮事件会失效）
  setInterval(injectWandMenuItem, 5000);

  // 监听聊天切换事件，重新注入（injectPrompts 注入仅在当前聊天有效）
  try {
    if (typeof tavern_events !== 'undefined' && tavern_events.CHAT_CHANGED) {
      eventOn(tavern_events.CHAT_CHANGED, () => {
        invalidateInjectionCache();
        applyInjection(avatarDB);
      });
    }
  } catch (e) {
    console.warn('[BubbleDialogue] 无法监听 CHAT_CHANGED 事件:', e);
  }
});
$(window).on('pagehide', () => { avatarDB.revokeAllUrls(); });
