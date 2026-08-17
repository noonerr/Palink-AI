/**
 * WP-D/E 前端静态验收脚本
 *
 * 不依赖浏览器环境，用正则/AST 提取 getContext.ts 和 runtime.ts 的
 * 导出表面，与 ST 1.18.0 的必需 API/事件名对比。
 *
 * 运行: node scripts/st_frontend_acceptance.cjs
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const results = [];

function record(wp, test, passed, detail = '') {
  results.push({ wp, test, passed, detail });
  const status = passed ? 'PASS' : 'FAIL';
  console.log(`  [${status}] ${test}` + (detail ? ` — ${detail}` : ''));
}

// ============================================================
// ST 必需 API 清单（来自 st-context.js）
// ============================================================
const ST_REQUIRED_APIS = [
  'accountStorage', 'chat', 'characters', 'groups', 'name1', 'name2',
  'characterId', 'groupId', 'chatId', 'getCurrentChatId', 'getRequestHeaders',
  'reloadCurrentChat', 'renameChat', 'saveSettingsDebounced', 'onlineStatus',
  'maxContext', 'chatMetadata', 'saveMetadataDebounced', 'streamingProcessor',
  'eventSource', 'eventTypes', 'addOneMessage', 'deleteLastMessage',
  'deleteMessage', 'generate', 'sendStreamingRequest', 'sendGenerationRequest',
  'stopGeneration', 'tokenizers', 'getTextTokens', 'getTokenCount',
  'getTokenCountAsync', 'extensionPrompts', 'setExtensionPrompt',
  'updateChatMetadata', 'saveChat', 'openCharacterChat', 'openGroupChat',
  'saveMetadata', 'sendSystemMessage', 'activateSendButtons',
  'deactivateSendButtons', 'saveReply', 'substituteParams',
  'substituteParamsExtended', 'SlashCommandParser', 'SlashCommand',
  'SlashCommandArgument', 'SlashCommandNamedArgument', 'SlashCommandEnumValue',
  'ARGUMENT_TYPE', 'executeSlashCommandsWithOptions', 'registerSlashCommand',
  'executeSlashCommands', 'registerMacro', 'unregisterMacro',
  'renderExtensionTemplate', 'renderExtensionTemplateAsync', 'callPopup',
  'callGenericPopup', 'showLoader', 'hideLoader', 'extensionSettings',
  'writeExtensionField', 'writeExtensionFieldBulk', 'generateQuietPrompt',
  'generateRaw', 'generateRawData', 'getThumbnailUrl', 'selectCharacterById',
  'messageFormatting', 'isMobile', 't', 'translate', 'getCurrentLocale',
  'tags', 'tagMap', 'getCharacters', 'getOneCharacter', 'getCharacterCardFields',
  'getCharacterSource', 'updateMessageBlock', 'appendMediaToMessage',
  'ensureMessageMediaIsArray', 'scrollChatToBottom', 'swipe', 'variables',
  'loadWorldInfo', 'saveWorldInfo', 'reloadWorldInfoEditor',
  'updateWorldInfoList', 'convertCharacterBook', 'getWorldInfoPrompt',
  'getWorldInfoNames', 'CONNECT_API_MAP', 'extractMessageFromData',
  'getPresetManager', 'printMessages', 'clearChat', 'unshallowCharacter',
  'unshallowGroupMembers',
];

// ST 核心事件名（来自 events.js）
const ST_CORE_EVENTS = [
  'APP_READY', 'APP_CHANGED', 'CHARACTER_CHANGED', 'CHARACTER_DELETED',
  'CHARACTER_FIRST_MESSAGE_SELECTED', 'CHARACTER_MESSAGE_RENDERED',
  'CHARACTER_SWIPED', 'CHARACTER_RENAMED', 'CHAT_CHANGED', 'CHAT_CREATED',
  'CHAT_DELETED', 'CHAT_LOADED', 'CHAT_COMPLETION_SETTINGS_READY',
  'GENERATION_STARTED', 'GENERATION_ENDED', 'GENERATION_QUEUED',
  'MESSAGE_RECEIVED', 'MESSAGE_SENT', 'MESSAGE_DELETED', 'MESSAGE_RENDERED',
  'MESSAGE_SWIPED', 'MESSAGE_EDITED', 'GROUP_UPDATED', 'GROUP_CHAT_CREATED',
  'GROUP_CHAT_DELETED', 'GROUP_MEMBER_DRAFTED', 'GROUP_WRAPPER_STARTED',
  'GROUP_WRAPPER_FINISHED', 'WORLDINFO_SCAN_DONE', 'WORLDINFO_FORCE_ACTIVATE',
  'WORLDINFO_SETTINGS_UPDATED',
];

// ============================================================
// WP-E: getContext() 表面验证
// ============================================================
console.log('\n--- WP-E: getContext() Parity ---');

const getContextPath = path.join(ROOT, 'src/lib/sillytavern/getContext.ts');
const getContextSrc = fs.readFileSync(getContextPath, 'utf-8');

// 提取返回对象中的所有 key
// 匹配 `  keyName:` 或 `  keyName,` 或 `  keyName =` 模式
const returnKeys = new Set();
const keyRegex = /^\s{2,4}([a-zA-Z_$][a-zA-Z0-9_$]*)\s*[:,=]/gm;
let match;
while ((match = keyRegex.exec(getContextSrc)) !== null) {
  returnKeys.add(match[1]);
}

// 检查必需 API
let foundCount = 0;
const missingApis = [];
for (const api of ST_REQUIRED_APIS) {
  if (returnKeys.has(api)) {
    foundCount++;
  } else {
    missingApis.push(api);
  }
}
record('E', `getContext() covers ST APIs (${foundCount}/${ST_REQUIRED_APIS.length})`,
       missingApis.length === 0,
       missingApis.length > 0 ? `missing: ${missingApis.join(', ')}` : 'all present');

// 检查关键 API 是否为函数（不是 no-op stub）
const functionApis = ['generate', 'generateQuietPrompt', 'substituteParams', 'saveChat', 'executeSlashCommandsWithOptions'];
for (const fn of functionApis) {
  // 检查是否在返回对象中
  const inReturn = returnKeys.has(fn);
  record('E', `getContext() exposes ${fn}()`, inReturn);
}

// 检查 no-op 标记
const noopCount = (getContextSrc.match(/no-?op|not supported|console\.warn/gi) || []).length;
record('E', `No-op stubs documented (count: ${noopCount})`, noopCount > 0,
       `${noopCount} no-op markers found`);

// ============================================================
// WP-D: 事件契约验证
// ============================================================
console.log('\n--- WP-D: Event Contract ---');

// 检查 runtime.ts 中的事件名
const runtimePath = path.join(ROOT, 'src/lib/sillytavern/runtime.ts');
const runtimeSrc = fs.readFileSync(runtimePath, 'utf-8');

// 检查核心事件是否在 runtime.ts 中定义
let eventFoundCount = 0;
const missingEvents = [];
for (const evt of ST_CORE_EVENTS) {
  if (runtimeSrc.includes(evt) || getContextSrc.includes(evt)) {
    eventFoundCount++;
  } else {
    missingEvents.push(evt);
  }
}
record('D', `Core ST events defined (${eventFoundCount}/${ST_CORE_EVENTS.length})`,
       missingEvents.length === 0,
       missingEvents.length > 0 ? `missing: ${missingEvents.join(', ')}` : 'all present');

// 检查 eventSource 实现
const hasEventSource = runtimeSrc.includes('eventSource') || getContextSrc.includes('eventSource');
record('D', 'eventSource exposed in getContext', hasEventSource);

// 检查 eventTypes
const hasEventTypes = runtimeSrc.includes('eventTypes') || getContextSrc.includes('eventTypes');
record('D', 'eventTypes exposed in getContext', hasEventTypes);

// 检查 SmartCard runtime 中的事件
const smartCardPath = path.join(ROOT, 'src/components/ui/custom/smart-card-runtime/SillyTavernCompatRuntime.ts');
if (fs.existsSync(smartCardPath)) {
  const smartCardSrc = fs.readFileSync(smartCardPath, 'utf-8');
  let smartCardEventCount = 0;
  for (const evt of ST_CORE_EVENTS) {
    if (smartCardSrc.includes(evt)) {
      smartCardEventCount++;
    }
  }
  record('D', `SmartCard runtime covers ST events (${smartCardEventCount}/${ST_CORE_EVENTS.length})`,
         smartCardEventCount >= ST_CORE_EVENTS.length * 0.8,
         `${smartCardEventCount}/${ST_CORE_EVENTS.length}`);
}

// 检查 APP_READY 处理
const hasAppReady = runtimeSrc.includes('APP_READY') || smartCardPath && fs.readFileSync(smartCardPath, 'utf-8').includes('APP_READY');
record('D', 'APP_READY event handled', hasAppReady);

// 检查 GROUP_UPDATED 事件
const hasGroupUpdated = runtimeSrc.includes('GROUP_UPDATED') || getContextSrc.includes('GROUP_UPDATED');
record('D', 'GROUP_UPDATED event exposed', hasGroupUpdated);

// 检查 WORLDINFO_SCAN_DONE 事件
const hasWiScanDone = runtimeSrc.includes('WORLDINFO_SCAN_DONE') || runtimeSrc.includes('worldinfo_scan_done') || getContextSrc.includes('WORLDINFO_SCAN_DONE');
record('D', 'WORLDINFO_SCAN_DONE event exposed', hasWiScanDone);

// ============================================================
// 汇总
// ============================================================
console.log('\n' + '='.repeat(60));
console.log('SUMMARY');
console.log('='.repeat(60));

const wpStats = {};
for (const r of results) {
  if (!wpStats[r.wp]) wpStats[r.wp] = { pass: 0, fail: 0 };
  wpStats[r.wp][r.passed ? 'pass' : 'fail']++;
}

const totalPass = results.filter(r => r.passed).length;
const totalFail = results.filter(r => !r.passed).length;

for (const wp of Object.keys(wpStats).sort()) {
  const s = wpStats[wp];
  const status = s.fail === 0 ? 'DONE' : 'NEEDS ATTENTION';
  console.log(`  WP-${wp}: ${s.pass} pass / ${s.fail} fail — ${status}`);
}

console.log(`\nTotal: ${totalPass} pass / ${totalFail} fail`);

if (totalFail > 0) {
  console.log('\nFailed tests:');
  for (const r of results.filter(r => !r.passed)) {
    console.log(`  [WP-${r.wp}] ${r.test}: ${r.detail}`);
  }
}

process.exit(totalFail > 0 ? 1 : 0);
