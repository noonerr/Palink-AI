/**
 * 卡内 tavern_helper 脚本执行器（2026-09-30 起，用户决策：允许卡片执行自带脚本并从 CDN 拉库）。
 *
 * 背景：生态复杂卡把交互界面（CG 图库悬浮按钮、已解锁/未解锁图鉴、状态栏特效）写在
 * `characters.extensions.tavern_helper.scripts[]` 里，type='script'。此前 Palink 对这块
 * **只读数据不跑代码**（后端 mvu_engine 只正则解析 zod schema，前端 TavernHelperPanel 是
 * 第一方复刻），所以这类卡自带的按钮永远不出现。本模块补上执行通道。
 *
 * 三条硬约束（都是当天那次「整页内容空白」事故的直接教训，见
 * _BACKUPS/2026-09-30_plugininject-注入断点修复前/BACKUP_INFO.md）：
 *   1. **单个脚本坏不得拖垮整批** —— 每条脚本各自 try/catch，失败只记录并继续下一条。
 *   2. **幂等** —— 同一条脚本（按卡内 script id）在文档里只允许存在一份，重复调用不重跑。
 *   3. **可关** —— localStorage `palink_card_tavern_helper_scripts` === '0' 时整体不执行
 *      （默认开；出问题时一键止血，不用重新构建）。
 *
 * 执行形态：卡内脚本有两类，必须分开处理，否则整段被浏览器当非法 JS 丢弃：
 *   - 顶层 `import`/`export` 的（如 `import 'https://.../MagVarUpdate/bundle.js'`）
 *     → 必须以 `<script type="module">` 注入（经典脚本里 import 会 SyntaxError）。
 *   - 其余全局常驻脚本（CG 图库本体）→ 经典 `<script>`，同步执行，能直接用 window 上的
 *     ST 兼容全局（getVariables / getChatMessages / getCurrentMessageId）。
 */

import { recordStubHit } from '@/lib/plugin-system/compat-stub-registry';
import {
  getCardScriptStorage,
  setCardScriptStorageSyncer,
  type CardScriptStorage,
  type CardScriptStorageNs,
} from './card-script-storage';

export { setCardScriptStorageSyncer, type CardScriptStorage };

/** 止血开关的 localStorage 键（'0' = 关闭，其它值/缺省 = 开启） */
export const CARD_SCRIPT_KILL_SWITCH_KEY = 'palink_card_tavern_helper_scripts';
/** 注入节点上的标记属性，用于幂等判定与卸载 */
export const CARD_SCRIPT_ATTR = 'data-palink-card-script-id';
/**
 * 存储隔离失效的降级登记名。落进 `window.__palinkCompatStats`（+ 插件管理页降级统计）。
 * 存在的理由：生产构建 `drop_console: true` 会剥掉全部 console.*，
 * 「改不动却不吭声」的静默面只能靠这个通道在线上留下痕迹。
 */
export const CARD_SCRIPT_STORAGE_STUB = 'card-script:storage-namespace';

/**
 * 卡脚本在 document.body 上直接创建的 UI（CG 悬浮按钮 / 弹窗 / 灯箱等）。
 * 脚本正文里普遍写 `document.body.appendChild(...)`，节点不在我们的容器里，
 * 离开聊天页时 React 管不到它们 —— 不清理就会飘在其它页面上。
 * 这里按「注入那一次 appendChild 期间 body 上新增的直接子节点」精确登记：
 * 时间窗极窄（同步执行），不会误抓应用自己的门户/提示条。
 */
const cardDomByContainer = new WeakMap<HTMLElement, Set<Node>>();

function trackCardBodyDom(container: HTMLElement, added: Node[]): void {
  const set = cardDomByContainer.get(container) ?? new Set<Node>();
  added.forEach((n) => set.add(n));
  cardDomByContainer.set(container, set);
}

export interface CardScriptRunResult {
  /** 实际注入的脚本 id */
  ran: string[];
  /** 执行/解析失败的脚本 */
  failed: Array<{ id: string; name: string; error: string }>;
  /** 未注入的脚本及原因（开关关闭、重复、非 script 类型等） */
  skipped: Array<{ id: string; name: string; reason: string }>;
  /** 已被 localStorage 命名空间改写命中的脚本 id（P0，便于现场排障「为什么键名变了」） */
  namespaced: string[];
  /**
   * 提到 localStorage/sessionStorage 却**一处都没改写成功**的脚本（P0 隔离静默失效名单）。
   * 两种情况都会进来：①所有命中处改写后编译不过、被逐处回退；②调用方没传 characterId。
   * 这条清单存在的理由：本次事故连着两个构建没人发现，就是因为旧实现静默整条回退。
   */
  storagePatchFailed: Array<{
    id: string;
    name: string;
    keywordHits: number;
    applied: number;
    rolledBack: number;
  }>;
}

export interface CardScriptBridge {
  /** 返回当前会话级变量对象（MVU 的 `getVariables()` 契约：含 stat_data） */
  getVariables: () => Record<string, unknown>;
  /** 当前（最后一条）消息下标，ST 语义里用于配对 getChatMessages */
  getCurrentMessageId: () => number;
}

interface CardScriptEntry {
  id?: string;
  name?: string;
  type?: string;
  enabled?: boolean;
  content?: string;
}

/** 顶层 ESM 语法判定：只认正文开头的 import/export，避免把注释里的词误判 */
export function isTopLevelEsm(content: string): boolean {
  const head = String(content || '').replace(/^\s*(?:\/\*[\s\S]*?\*\/|\/\/[^\n]*\n?)*/g, '');
  return /^\s*(?:import|export)\s[\s\S]*?['{(;*=]/.test(head) || /^\s*export\s+(?:const|let|var|function|class|default)\b/.test(head);
}

function cardScriptsOf(extensions: unknown): CardScriptEntry[] {
  const th = (extensions as any)?.tavern_helper;
  const scripts = th?.scripts;
  return Array.isArray(scripts) ? (scripts as CardScriptEntry[]) : [];
}

function existingIds(): Set<string> {
  const set = new Set<string>();
  document.querySelectorAll(`[${CARD_SCRIPT_ATTR}]`).forEach((el) => {
    const v = el.getAttribute(CARD_SCRIPT_ATTR);
    if (v) set.add(v);
  });
  return set;
}

function killSwitchOn(): boolean {
  try {
    return window.localStorage.getItem(CARD_SCRIPT_KILL_SWITCH_KEY) !== '0';
  } catch {
    return true;
  }
}

/** 与 inline-sanitize 的 INLINE_CARD_INIT_EVENT 同名：卡脚本靠它替代 DOMContentLoaded */
const CARD_INIT_EVENT = 'palink-card-init';

/**
 * 把卡脚本里的 `document.addEventListener('DOMContentLoaded', …)` 改写为
 * `palink-card-init`。内联注入发生在 document 早已 ready 之后，DOMContentLoaded
 * 永远不会再触发 —— 不改写的话，卡内 CG 图库这类「初始化挂在 DOMContentLoaded 上」
 * 的脚本会静默不启动（按钮在、点了没反应、网格空）。口径对齐
 * `smart-card-runtime/inline/inline-sanitize.ts:patchDomContentLoaded`。
 */
export function patchCardContentLoaded(code: string): string {
  return String(code || '').replace(
    /document\s*\.\s*addEventListener\s*\(\s*(['"])DOMContentLoaded\1/g,
    'document.addEventListener($1' + CARD_INIT_EVENT + '$1',
  );
}

// ── [P0] 卡脚本 localStorage 命名空间改写（2026-10-02）─────────────────────
// 卡内脚本硬编码了全局键名（如 'tavern_cg_album_unlocked'），而 Key 写在卡里、
// 卡又改不了，只能在注入前把脚本正文里的 Storage 访问替换成按角色隔离的视图。
// 走 Source改写（SPEC §5 路线甲），**不做 window.localStorage 全局劫持（路线乙）**。

/**
 * 卡脚本常见的「宿主窗口」取法。
 *
 * 2026-10-02 返工（P0 第二次未生效的定位结果）：原实现只允许**一层**宿主前缀
 * （`(?:window|self|top|…)\s*\.\s*`），于是链式取法
 * `window.top.localStorage` / `window.parent.localStorage` / `window.frames[0].localStorage`
 * **一处都匹配不上**。而「先爬到顶层窗口、再取 Storage」恰恰是这类卡最典型的写法
 * （SPEC §2.2 已证卡脚本里有 `topWin` 取法），只认一层等于漏掉主要目标。
 *
 * 现在改成允许**宿主任意链**（每段 `名字` 后跟 `.` 或 `[下标]`），上限 6 段 ——
 * 上限只为压住回溯量，不是语义限制。
 */
const STORAGE_HOST_NAME =
  '(?:window|self|top|parent|globalThis|frames|topWin|parentWin|mainWindow|win|document|defaultView)';
const STORAGE_HOST_UNIT = `${STORAGE_HOST_NAME}\\s*(?:\\.\\s*|\\[\\s*[^\\]]{0,32}\\]\\s*\\.\\s*)`;
const STORAGE_HOST_ACCESS = `(?:${STORAGE_HOST_UNIT}){0,6}`;

/**
 * 前导守卫。三类位置都不改写：
 *   - 标识符字符 / `$`：挡住 `mylocalStorage`；
 *   - `.`：挡住 `foo.bar.localStorage`（对象自有属性，不是 Web Storage）；
 *   - **引号（单引号 / 双引号 / 反引号）**：挡住字符串字面量里的关键词。
 *     这一条是本次返工新增的：卡脚本里 `console.warn('localStorage 不可用')` 这类
 *     文案会命中旧正则，改写后把字符串劈断 → 整条脚本编译不过 → 被旧闸门**整条回退**
 *     → 一层隔离全废。实测复现见 `__tests__/card-script-storage.test.ts`。
 */
const STORAGE_PREFIX_GUARD = '[^\\w$.\'"`]';

/**
 * 匹配 `localStorage` / `sessionStorage` 的**使用点**，要求后面紧跟 Storage 成员访问
 * （`.getItem(...)`、`[...]`、`.length`），或一个把语句收住的分隔符（`;` `)` `,` `+` …），
 * 或整个正文结束（`$`，覆盖 `var x = typeof localStorage` 这类收尾写法）。
 *
 * 每次调用返回新实例：带 `g` 的正则是有状态的（`lastIndex`），模块级单例会跨调用串味。
 */
function storageAccessRe(): RegExp {
  return new RegExp(
    `(^|${STORAGE_PREFIX_GUARD})${STORAGE_HOST_ACCESS}(localStorage|sessionStorage)` +
      `(?=\\s*(?:\\.\\s*[A-Za-z_$][\\w$]*|\\[|[^\\w$.\\s]|$))`,
    'g',
  );
}

/** 当前这张卡的 UUID。为 null 时 `__palinkCardStorage` 退回匿名共享桶（不隔离但不崩）。 */
let activeStorageCharacterId: string | null = null;

/**
 * 纯语法校验（编译不执行）。改写是把标识符换成函数调用，理论上在任何位置都合法，
 * 但卡脚本来源完全不可控，加一道「改写后编译不过就回退原文」的闸门更稳妥 ——
 * 宁可没隔离，也不能让整张卡的脚本因为 SyntaxError 一条都跑不起来。
 */
function compilesAsScript(code: string): boolean {
  try {
    new Function(code); // eslint-disable-line no-new-func
    return true;
  } catch {
    return false;
  }
}

/** 正文里出现关键词的次数（含字符串/注释内）—— 只数关键词，不判断是否可改写 */
function countStorageKeywords(code: string): number {
  const found = code.match(/\b(?:localStorage|sessionStorage)\b/g);
  return found ? found.length : 0;
}

/** 改写计数。用于「有命中却一处没改」的响亮诊断（静默回退正是本次事故的成因）。 */
export interface CardStoragePatchStats {
  /** 正文里关键词出现次数 */
  keywordHits: number;
  /** 真正改写成命名空间视图的处数 */
  applied: number;
  /** 命中但因改写后编译不过被**逐处**回退的处数（旧实现会因此整条放弃） */
  rolledBack: number;
}

/**
 * 逐处改写 + 逐处回退。
 *
 * 返工要点（2026-10-02）：旧闸门是「全有或全无」—— 只要**一处**位置改写后破坏语法，
 * 整条脚本静默退回原文，且不打任何日志。于是「0 个命名空间键 + 旧全局键原封不动」
 * 这个用户可见现象，可以只由脚本里一句 `console.warn('localStorage 不可用')` 造成。
 * 现在改成逐处验证、逐处回退，并把计数交回调用方出声。
 */
export function patchCardStorageNamespacesWithStats(code: string): {
  code: string;
  stats: CardStoragePatchStats;
} {
  const source = String(code || '');
  const stats: CardStoragePatchStats = {
    keywordHits: countStorageKeywords(source),
    applied: 0,
    rolledBack: 0,
  };
  if (!source) return { code: source, stats };

  const matches = Array.from(source.matchAll(storageAccessRe())).map((m) => {
    const prefix = m[1] || '';
    const at = m.index ?? 0;
    const ns: CardScriptStorageNs = m[2] === 'sessionStorage' ? 'session' : 'local';
    return {
      // 区间必须**含前缀字符**：替换串里也带着它（`prefix + __palinkCardStorage(...)`）。
      // 起点写成 `at + prefix.length` 会让前缀被注入两次 —— 轻则多一个空格，
      // 重则 `if((…)` 括号失衡 → 触发逐处回退 → 该处静默不改写。
      start: at,
      end: at + m[0].length,
      replacement: `${prefix}__palinkCardStorage('${ns}')`,
    };
  });
  if (matches.length === 0) return { code: source, stats };
  // 原文本身就编译不过：那是卡自己的事，不替它「修」，原样放行（与返工前口径一致）
  if (!compilesAsScript(source)) return { code: source, stats };

  // 从后往前替换（避免下标位移），每处替换后单独验证可编译性：
  // 过不了只回退这一处，其余照改 —— 一处冷门写法不该废掉整层隔离。
  let out = source;
  for (let i = matches.length - 1; i >= 0; i -= 1) {
    const m = matches[i];
    const candidate = out.slice(0, m.start) + m.replacement + out.slice(m.end);
    if (compilesAsScript(candidate)) {
      out = candidate;
      stats.applied += 1;
    } else {
      stats.rolledBack += 1;
    }
  }
  return { code: stats.applied > 0 ? out : source, stats };
}

/**
 * 把卡脚本里的 localStorage / sessionStorage 访问改写为按角色隔离的视图调用。
 *
 * 保守原则：改写后编译不过的位置**逐处**退回原文，其余保留；正文本身不可编译则原样放行
 * （那种卡本来就跑不起来，不归我们背锅，也不替它「修」）。
 */
export function patchCardStorageNamespaces(code: string): string {
  return patchCardStorageNamespacesWithStats(code).code;
}

/** 卡脚本可调的那个桥接函数：`__palinkCardStorage('local'|'session')` */
function installCardScriptStorageGlobals(): void {
  const w = window as unknown as Record<string, unknown>;
  if (typeof w.__palinkCardStorage === 'function') return;
  w.__palinkCardStorage = function palinkCardStorage(kind?: unknown) {
    const ns: CardScriptStorageNs = kind === 'session' ? 'session' : 'local';
    // 没有角色身份时退回匿名桶而不是返回 null：宁可不隔离，也绝不让脚本拿到空对象引用去调方法
    return getCardScriptStorage(activeStorageCharacterId || '__anonymous__', ns);
  };
}

export interface CardScriptRunOptions {
  /**
   * 角色 UUID（`characters.id`）。**缺省时不改写脚本正文**（保持旧的全部行为），
   * 这样「拿不到身份」的场景最多是没有隔离，不会额外引入改写风险。
   */
  characterId?: string | null;
}

/**
 * 把 ST 语义的变量/消息 API 桥到 window 上，供卡内经典脚本使用。
 * 只在缺失时定义，不覆盖既有实现（沙箱轨与 iframe 轨各有自己的注入）。
 */
export function ensureCardScriptBridge(bridge: CardScriptBridge): void {
  const w = window as any;
  if (typeof w.getVariables !== 'function') {
    w.getVariables = function getVariables() {
      try {
        return bridge.getVariables() || {};
      } catch (error) {
        console.warn('[card-script] getVariables 取数失败:', error);
        return {};
      }
    };
  }
  if (typeof w.getCurrentMessageId !== 'function') {
    w.getCurrentMessageId = function getCurrentMessageId() {
      try {
        return bridge.getCurrentMessageId();
      } catch {
        return -1;
      }
    };
  }
  // Palink 尚未开放「卡内脚本回写」的通道：一律做**显式降级登记**，让插件管理页的
  // 降级统计能看到，而不是静默失效或裸 ReferenceError（同 compat-stub-registry 的立项理由）。
  //
  // [写口族补全 2026-10-05] 原实现只登记了 setVariables / setVariable 两个名字，
  // 而 MVU 变量框架（卡脚本 `backend/data/smart_card_assets/0c646fb31a…js`，307,179 B）
  // 实际调用的是这一整族：replaceVariables ×7、updateVariablesWith ×8、deleteVariable ×1、
  // insertOrAssignVariables ×1、setChatMessage ×1（计数为实测 `grep -o` 统计）。
  // 这些名字在本轨**全是裸 undefined** → MVU 的更新管线每轮抛 ReferenceError
  // （是"崩溃"而不是"降级"），与"写口族已登记降级"的既有口径不一致，故按同一口径补齐。
  //
  // 语义：**只登记、不写入**。Palink 的变量更新走后端 mvu_engine（生成时解析
  // <UpdateVariable> 并落库）、正文也由后端剥离后写入 —— 卡脚本再写一遍会形成双写。
  // 真实写入通道的开放属独立议题，见
  // `docs/REPORT_MVU变量框架与Palink自有变量体系重叠专题_2026-10-04.md` §8 的 P2 项。
  const WRITE_DEGRADED_REASON =
    '卡内脚本回写未开放（Palink 的变量更新与正文写入走后端链路，避免双写）';
  const degradedWrite = (name: string, ret: () => unknown) =>
    function palinkDegradedWrite() {
      recordStubHit(name, WRITE_DEGRADED_REASON);
      return ret();
    };
  // 异步族：TavernHelper 契约返回 Promise，用 resolved Promise 兜底，
  // 避免调用方 `await`/`.then()` 拿到 undefined 再炸一次（换汤不换药的第二个坑）。
  const ASYNC_WRITE_NAMES = [
    'setVariables',
    'setVariable',
    'replaceVariables',
    'updateVariablesWith',
    'insertOrAssignVariables',
    'setChatMessage',
  ] as const;
  for (const name of ASYNC_WRITE_NAMES) {
    if (typeof w[name] !== 'function') {
      w[name] = degradedWrite(name, () => Promise.resolve());
    }
  }
  // 同步族：deleteVariable 的 TavernHelper 契约返回 `{variables, delete_occurred}`，
  // 用**同形状的空结果**兜底，而不是 Promise —— 调用方可能直接读字段。
  if (typeof w.deleteVariable !== 'function') {
    w.deleteVariable = degradedWrite('deleteVariable', () => ({
      variables: {},
      delete_occurred: false,
    }));
  }
}

/**
 * 执行卡内 tavern_helper 脚本。幂等：重复调用只补注入新增的脚本。
 */
export function runCardTavernHelperScripts(
  extensions: unknown,
  container: HTMLElement,
  options: CardScriptRunOptions = {},
): CardScriptRunResult {
  const result: CardScriptRunResult = {
    ran: [],
    failed: [],
    skipped: [],
    namespaced: [],
    storagePatchFailed: [],
  };
  const scripts = cardScriptsOf(extensions);
  if (scripts.length === 0) return result;
  const characterId = options.characterId || null;

  // 先装好 __palinkCardStorage 再跑脚本：改写后的正文依赖这个全局存在。
  // 顺序绝不能反 —— 桥缺失会让引用处直接 ReferenceError，等于把整条脚本打死。
  //
  // **每次调用都要覆盖**（含覆盖成 null）：这是模块级变量，不覆盖就会把**上一张卡**的 id
  // 留给这一批脚本用 —— 用户从卡 A 切到卡 B、而这一次没拿到 id 时，B 的解锁会被写进
  // A 的命名空间，等于反向串卡（返工复核实测到：跨用例/跨卡都复现）。
  activeStorageCharacterId = characterId;
  if (characterId) {
    try {
      installCardScriptStorageGlobals();
    } catch (error) {
      console.warn('[card-script] 安装命名空间存储桥失败，退回原 Storage:', error);
      activeStorageCharacterId = null;
    }
  }

  if (!killSwitchOn()) {
    for (const s of scripts) {
      result.skipped.push({
        id: String(s?.id || s?.name || 'unknown'),
        name: String(s?.name || ''),
        reason: `止血开关已关闭（localStorage ${CARD_SCRIPT_KILL_SWITCH_KEY}=0）`,
      });
    }
    console.warn(
      `[card-script] 跳过 ${scripts.length} 条卡内脚本：${CARD_SCRIPT_KILL_SWITCH_KEY}=0`,
    );
    return result;
  }

  const done = existingIds();
  let classicRan = 0;

  const dispatchCardInit = () => {
    try {
      document.dispatchEvent(new Event(CARD_INIT_EVENT));
    } catch (error) {
      console.warn('[card-script] 派发 ' + CARD_INIT_EVENT + ' 失败:', error);
    }
  };

  scripts.forEach((entry, index) => {
    const id = String(entry?.id || `idx-${index}`);
    const name = String(entry?.name || '');
    const content = String(entry?.content || '');

    if (entry?.enabled === false) {
      result.skipped.push({ id, name, reason: '卡内该脚本 enabled=false' });
      return;
    }
    if ((entry?.type || 'script') !== 'script') {
      result.skipped.push({ id, name, reason: `type=${entry?.type} 非脚本` });
      return;
    }
    if (!content.trim()) {
      result.skipped.push({ id, name, reason: 'content 为空' });
      return;
    }
    if (done.has(id)) {
      result.skipped.push({ id, name, reason: '已注入过（幂等跳过）' });
      return;
    }

    const asModule = isTopLevelEsm(content);
    const el = document.createElement('script');
    el.setAttribute(CARD_SCRIPT_ATTR, id);
    if (asModule) {
      el.type = 'module';
      el.textContent = content;
    } else {
      el.type = 'text/javascript';
      // 与插件注入同源的 nonce 约定：页面若有 CSP，nonce 缺失会被拦
      el.setAttribute('nonce', 'palink-smart-card');
      // 经典脚本才需要改写 —— 模块脚本有自己的求值时序，多为第三方 CDN 库
      // （MVU bundle 之类），改它的 Storage 访问收益小、风险大，本期不碰。
      const contentLoaded = patchCardContentLoaded(content);
      // 经典脚本才需要改写 —— 模块脚本有自己的求值时序，多为第三方 CDN 库
      // （MVU bundle 之类），改它的 Storage 访问收益小、风险大，本期不碰。
      let wrapped = contentLoaded;
      let patchStats: CardStoragePatchStats = {
        keywordHits: countStorageKeywords(contentLoaded),
        applied: 0,
        rolledBack: 0,
      };
      if (activeStorageCharacterId) {
        const patched = patchCardStorageNamespacesWithStats(contentLoaded);
        wrapped = patched.code;
        patchStats = patched.stats;
      }
      if (wrapped !== contentLoaded) {
        result.namespaced.push(id);
        if (patchStats.rolledBack > 0) {
          console.warn(
            `[card-script][P0-STORAGE] 部分位置回退：${name || id}` +
              `（已改写 ${patchStats.applied} 处，回退 ${patchStats.rolledBack} 处；回退处仍是全局存储）`,
          );
        }
      } else if (patchStats.keywordHits > 0) {
        // 有命中却一处没改 —— 这就是本次事故的静默面。必须留痕，只报计数不报正文。
        result.storagePatchFailed.push({ id, name, ...patchStats });
        // ⚠️ 留痕必须走降级登记，不能只靠 console：vite.config.ts 的 terser
        // `drop_console: true` 会把**全部** console.*（含 warn，不只 log/info）从生产产物里剥掉
        // —— 实测确认。写进 window.__palinkCompatStats 才能在线上被看见
        // （插件管理页的降级统计面板读的就是它）。
        recordStubHit(
          CARD_SCRIPT_STORAGE_STUB,
          `${name || id}: 关键词 ${patchStats.keywordHits} 处 / 已改写 0 处 / 回退 ${patchStats.rolledBack} 处` +
            (activeStorageCharacterId ? '' : '（未拿到角色 id）'),
        );
        console.warn(
          activeStorageCharacterId
            ? `[card-script][P0-STORAGE] 脚本提到 localStorage/sessionStorage 但一处都没改写：${name || id}` +
              `（关键词 ${patchStats.keywordHits} 处，回退 ${patchStats.rolledBack} 处）` +
              ' —— 该脚本的存储仍是全局共享，跨卡隔离对它无效'
            : `[card-script][P0-STORAGE] 未拿到角色 id，本次跳过存储隔离改写：${name || id}` +
              `（关键词 ${patchStats.keywordHits} 处，脚本会继续写全局键 = 跨卡共享）。` +
              '检查调用方是否传了 characterId。',
        );
      }
      el.textContent = wrapped;
    }
    // 顶层 const 重复声明会整段抛 SyntaxError（多卡/重进会话同场景），
    // 这里保留原代码不降级为 var：卡脚本靠 const 顶层作用域注册自己，改写风险更大。
    // 失败由下面的 catch/onerror 承接，只影响这一条。
    if (asModule) {
      // 模块脚本异步取 CDN，执行错误不回抛到 appendChild，只能靠 onerror 观测
      el.onerror = (event) => {
        result.failed.push({
          id,
          name,
          error: typeof event === 'string' ? event : 'module script error',
        });
        console.warn(`[card-script] 模块脚本执行失败 ${name || id}:`, event);
      };
    }
    const bodyBefore = Array.from(document.body.children) as Element[];
    try {
      container.appendChild(el);
      result.ran.push(id);
      done.add(id);
      const bodyAfter = Array.from(document.body.children) as Element[];
      const beforeSet = new Set<Node>(bodyBefore);
      const spawned = bodyAfter.filter((n) => !beforeSet.has(n));
      if (spawned.length > 0) trackCardBodyDom(container, spawned);
      if (!asModule) {
        classicRan += 1;
        // 对齐 ST 侧 palink-smart-card.js：每插入一条就派发一次，
        // 让「先注册监听、后被别的脚本触发初始化」的卡脚本也能收到
        dispatchCardInit();
      }
    } catch (error) {
      result.failed.push({
        id,
        name,
        error: error instanceof Error ? `${error.name}: ${error.message}` : String(error),
      });
      console.error(
        `[card-script] 注入失败（已隔离，不影响其余脚本）${name || id}:`,
        error,
      );
      try {
        el.remove();
      } catch {
        /* 节点可能已被脚本自身移除 */
      }
    }
  });

  // 兜底再派发一次：覆盖「后面的脚本注册监听时，前面的派发已经过去」的情况
  if (classicRan > 0) dispatchCardInit();

  return result;
}

/**
 * 卸载：摘掉本容器注入的卡脚本节点，并清掉脚本在 body 上直接创建的 UI
 * （悬浮按钮/弹窗/灯箱）。幂等，重复调用安全。
 */
export function removeCardTavernHelperScripts(container: HTMLElement): number {
  const nodes = Array.from(container.querySelectorAll(`[${CARD_SCRIPT_ATTR}]`));
  nodes.forEach((n) => {
    try {
      n.remove();
    } catch {
      /* ignore */
    }
  });
  const tracked = cardDomByContainer.get(container);
  let domRemoved = 0;
  if (tracked) {
    tracked.forEach((n) => {
      try {
        n.parentNode?.removeChild(n);
        domRemoved += 1;
      } catch {
        /* 脚本可能已自行移除 */
      }
    });
    tracked.clear();
  }
  return nodes.length + domRemoved;
}
