/**
 * ST 1.18.0 权威命令名清单（包 F F-1，2026-10-18）
 *
 * 为什么需要它：帧内 `SlashCommandParser.commands` 的枚举口径此前只由
 * `/help` 的返回文本解析而来（part-07.ts 的 primeSlashKnownNamesCompat），
 * 上限 = Palink 宿主引擎真注册的命令表，与 ST 1.18 的权威名单差了一大截。
 * 三方卡脚本 / ST 插件用 `'x' in SlashCommandParser.commands`、`Object.keys(commands)`、
 * `for...in` 做能力探测与补全时，看到的与 ST 不一致。
 * 修法：把这份**名单**经宿主侧注入（`getStCompatCommandNames` 动作），
 * 帧内只多一段请求，**不把 293 个字面量写进模板串**（srcdoc 体积红线）。
 *
 * ⚠️ 只负责「存在性 / 枚举」，不负责「能执行」。
 *   未在宿主引擎注册的名字，取到的是合成 entry，执行时照旧报
 *   "Unknown command"（st-compat-commands.ts 红线 1：不注册假实现）。
 *
 * 权威来源：static 真值表
 *   `frontend/src/lib/sillytavern/__tests__/fixtures/st-slash-commands-1.18.0.json`
 *   —— 从 `_reference/sillytavern-1.18.0/public/scripts/` 逐文件抽取（core 220 / extension 73 /
 *   唯一名 293 / aliases 176），抽取器 `.tmp_probe/extract_st_commands_E1.py`（`py ... --write` 可重跑）。
 *   本清单 = 该 fixture 的 `commands` 数组按字母序复制，两者不一致时契约测试直接红
 *   （见 `__tests__/st-command-catalog-contract.test.ts`）。
 *
 * 维护方式：升级 ST 参考源码后 ① 重跑抽取器刷新 fixture ② 重新生成本数组（或手工对齐）
 * ③ 跑 `npx vitest run` 确认漂移守卫仍然绿。
 */

/** ST 1.18.0 注册的全部斜杠命令名（含启动器内部名 `/` `?` `parser-flag` `break` `breakpoint`）。 */
export const ST_118_COMMAND_NAMES: readonly string[] = [
  "/", "?", "abort", "abs", "add", "addglobalvar",
  "addswipe", "addvar", "api", "api-url", "array-unwrap", "array-wrap",
  "ask", "autobg", "beep", "bg", "bgcol", "branch-create",
  "break", "breakpoint", "bubble", "buttons", "caption", "char-create",
  "char-delete", "char-duplicate", "char-find", "char-get", "char-update", "chat-jump",
  "chat-manager", "chat-reload", "chat-render", "checkpoint-create", "checkpoint-exit", "checkpoint-get",
  "checkpoint-go", "checkpoint-list", "checkpoint-parent", "clipboard-get", "clipboard-set", "closechat",
  "closure-deserialize", "closure-serialize", "comment", "context", "continue", "cos",
  "count", "createentry", "css-var", "cut", "db", "db-add",
  "db-delete", "db-disable", "db-enable", "db-get", "db-ingest", "db-list",
  "db-purge", "db-search", "db-update", "decglobalvar", "decvar", "del",
  "delay", "delchat", "delname", "delswipe", "div", "echo",
  "expression-classify", "expression-fallback", "expression-folder-override", "expression-last", "expression-list", "expression-set",
  "expression-upload", "extension-disable", "extension-enable", "extension-exists", "extension-state", "extension-toggle",
  "findentry", "flat", "flushglobalvar", "flushinject", "flushvar", "forcesave",
  "fuzzy", "gen", "genraw", "getcharbook", "getchatbook", "getchatname",
  "getentryfield", "getglobalbooks", "getglobalvar", "getpersonabook", "getpromptentry", "getvar",
  "go", "hide", "if", "imagine", "imagine-comfy-workflow", "imagine-source",
  "imagine-style", "impersonate", "import", "incglobalvar", "incvar", "inject",
  "input", "instruct", "instruct-off", "instruct-on", "instruct-state", "is-mobile",
  "len", "let", "list-gallery", "listinjects", "listvar", "loader-hide",
  "loader-show", "loader-stop", "loader-wrap", "lockbg", "log", "lower",
  "match", "max", "member-add", "member-count", "member-disable", "member-down",
  "member-enable", "member-get", "member-peek", "member-remove", "member-up", "message-name",
  "message-role", "messages", "min", "mod", "model", "movingui",
  "mul", "newchat", "note", "note-depth", "note-frequency", "note-position",
  "note-role", "panels", "parser-flag", "pass", "persona-create", "persona-delete",
  "persona-duplicate", "persona-get", "persona-lock", "persona-set", "persona-sync", "persona-update",
  "pick-icon", "pm-render", "popup", "pow", "preset", "profile",
  "profile-create", "profile-genstream", "profile-get", "profile-list", "profile-update", "prompt-post-processing",
  "proxy", "qr", "qr-arg", "qr-chat-set", "qr-chat-set-off", "qr-chat-set-on",
  "qr-contextadd", "qr-contextclear", "qr-contextdel", "qr-create", "qr-delete", "qr-get",
  "qr-list", "qr-set", "qr-set-create", "qr-set-delete", "qr-set-list", "qr-set-off",
  "qr-set-on", "qr-set-update", "qr-update", "qrset", "rand", "random",
  "reasoning-collapse", "reasoning-expand", "reasoning-format", "reasoning-get", "reasoning-parse", "reasoning-set",
  "reasoning-template", "reasoning-toggle", "regenerate", "regex", "regex-preset", "regex-state",
  "regex-toggle", "reload-page", "rename-char", "renamechat", "replace", "reroll-pick",
  "resetpanels", "round", "run", "secret-delete", "secret-id", "secret-read",
  "secret-rename", "secret-write", "send", "sendas", "setentryfield", "setglobalvar",
  "setinput", "setpromptentry", "setvar", "show-gallery", "sin", "single",
  "sort", "speak", "sqrt", "start-reply-with", "stop", "stop-strings",
  "sub", "substr", "summarize", "swipe", "sys", "sysgen",
  "sysname", "sysprompt", "sysprompt-off", "sysprompt-on", "sysprompt-state", "tag-add",
  "tag-exists", "tag-import", "tag-list", "tag-remove", "tempchat", "test",
  "theme", "times", "tokenizer", "tokens", "tools-invoke", "tools-list",
  "tools-register", "tools-unregister", "translate", "trigger", "trimend", "trimstart",
  "trimtokens", "unhide", "unlockbg", "upper", "var", "vector-chats-state",
  "vector-files-state", "vector-max-entries", "vector-query", "vector-threshold", "vector-worldinfo-state", "vn",
  "while", "wi-get-timed-effect", "wi-set-timed-effect", "world", "yt-script",
];

/**
 * [包AA A 2026-10-20] ST 1.18.0 的命令别名 → 主名映射（176 条，脚本生成，不手数）。
 *
 * 为什么要有它 —— ST 把别名直接写进 commands 表：
 *   _reference/sillytavern-1.18.0/public/scripts/slash-commands/SlashCommandParser.js:95
 *     this.commands[command.name] = command;
 *   同文件 :97-100
 *     command.aliases.forEach((alias) => { this.commands[alias] = command; });
 *   同文件 :79-82 重名时只 console.trace 告警，:95/:99 照样赋值（后注册者覆盖）。
 * ⇒ ST 的 Object.keys(commands) 本来就有别名，且 commands[alias] 与 commands[base] 是同一个对象。
 *   包F「别名不在表里，ST 亦然」的记录已被证伪；包Z §2.4 列为遗留待裁决；
 *   主脑 2026-10-20 裁决按 ST 语义补齐 ⇒ 本表 + 帧内 slashKnownAliasesCompat。
 *
 * 对账（原始输出 .tmp_probe/AA/reconcile_out.txt）：
 *   权威主名 293 / 别名 176 / 两者交集 0 / 并集 469；别名与主名重名 0 条；
 *   同一别名被两条命令声明 5 条（bind、lock、dupe、persona-data、server），
 *   按 ST 的后注册覆盖取源序最后一条为主名，明细见该文件的 CONFLICT 行。
 *   生成器 .tmp_probe/AA/reconcile_aliases.py 扫两棵参照树（_reference/sillytavern-1.18.0
 *   与 D:/SillyTavern-release），两树逐键相等（bases_equal=True aliases_equal=True）。
 *
 * 口径分工（别混成一个数）：本表只影响「表内键计数」Object.keys(commands)，
 *   不影响「权威名计数」ST_118_COMMAND_NAMES.length = 293
 *   （帧内 window.__palinkSlashSeedNamesCount 仍必须 = 293）。
 */
export const ST_118_COMMAND_ALIASES: Readonly<Record<string, string>> = Object.freeze({
  "#": "/",
  "addchatvar": "addvar",
  "addmember": "member-add",
  "background": "bg",
  "bgauto": "autobg",
  "bglock": "lockbg",
  "bgunlock": "unlockbg",
  "bind": "persona-lock",
  "bubbles": "bubble",
  "call": "run",
  "cancel": "delname",
  "char": "go",
  "char-data": "char-get",
  "chat-history": "chat-manager",
  "chat-scrollto": "chat-jump",
  "classify": "expression-classify",
  "collapse-reasoning": "reasoning-collapse",
  "cont": "continue",
  "costume": "expression-folder-override",
  "countmember": "member-count",
  "createlore": "createentry",
  "createwi": "createentry",
  "custom-stop-strings": "stop-strings",
  "custom-stopping-strings": "stop-strings",
  "data-bank": "db",
  "data-bank-add": "db-add",
  "data-bank-delete": "db-delete",
  "data-bank-disable": "db-disable",
  "data-bank-enable": "db-enable",
  "data-bank-get": "db-get",
  "data-bank-ingest": "db-ingest",
  "data-bank-list": "db-list",
  "data-bank-purge": "db-purge",
  "data-bank-search": "db-search",
  "data-bank-update": "db-update",
  "databank": "db",
  "databank-add": "db-add",
  "databank-delete": "db-delete",
  "databank-disable": "db-disable",
  "databank-enable": "db-enable",
  "databank-get": "db-get",
  "databank-ingest": "db-ingest",
  "databank-list": "db-list",
  "databank-purge": "db-purge",
  "databank-search": "db-search",
  "databank-update": "db-update",
  "decchatvar": "decvar",
  "default": "flat",
  "delete": "del",
  "delmode": "del",
  "depth": "note-depth",
  "ding": "beep",
  "disable": "member-disable",
  "disablemember": "member-disable",
  "downmember": "member-down",
  "dupe": "char-duplicate",
  "emote": "expression-set",
  "enable": "member-enable",
  "enablemember": "member-enable",
  "exec": "run",
  "expand-reasoning": "reasoning-expand",
  "expressions": "expression-list",
  "extension-installed": "extension-exists",
  "findchar": "char-find",
  "findlore": "findentry",
  "findwi": "findentry",
  "floor-teleport": "chat-jump",
  "flushchatvar": "flushvar",
  "flushinjects": "flushinject",
  "format-reasoning": "reasoning-format",
  "freq": "note-frequency",
  "generate-stop": "stop",
  "get-reasoning": "reasoning-get",
  "getcharlore": "getcharbook",
  "getcharwi": "getcharbook",
  "getchatlore": "getchatbook",
  "getchatvar": "getvar",
  "getchatwi": "getchatbook",
  "getgloballore": "getglobalbooks",
  "getglobalwi": "getglobalbooks",
  "getlorefield": "getentryfield",
  "getmember": "member-get",
  "getpersonalore": "getpersonabook",
  "getpersonawi": "getpersonabook",
  "getpromptentries": "getpromptentry",
  "getwifield": "getentryfield",
  "help": "?",
  "icw": "imagine-comfy-workflow",
  "image": "imagine",
  "img": "imagine",
  "img-source": "imagine-source",
  "img-style": "imagine-style",
  "imp": "impersonate",
  "incchatvar": "incvar",
  "instruct-toggle": "instruct-state",
  "lastsprite": "expression-last",
  "length": "len",
  "lg": "list-gallery",
  "list-unwrap": "array-unwrap",
  "list-wrap": "array-wrap",
  "listchatvar": "listvar",
  "lock": "persona-lock",
  "lowercase": "lower",
  "manage-chats": "chat-manager",
  "memberadd": "member-add",
  "membercount": "member-count",
  "memberdisable": "member-disable",
  "memberdown": "member-down",
  "memberenable": "member-enable",
  "memberget": "member-get",
  "memberpeek": "member-peek",
  "memberremove": "member-remove",
  "memberup": "member-up",
  "message": "messages",
  "name": "persona-set",
  "nar": "sys",
  "narrate": "speak",
  "note-freq": "note-frequency",
  "note-pos": "note-position",
  "parse-reasoning": "reasoning-parse",
  "peek": "member-peek",
  "peekmember": "member-peek",
  "persona": "persona-set",
  "persona-data": "persona-get",
  "pos": "note-position",
  "ppp": "prompt-post-processing",
  "prompt": "input",
  "qr-presetadd": "qr-set-create",
  "qr-presetdelete": "qr-set-delete",
  "qr-presetupdate": "qr-set-update",
  "re": "replace",
  "reasoning-formatting": "reasoning-template",
  "reasoning-preset": "reasoning-template",
  "regen": "regenerate",
  "removemember": "member-remove",
  "resetui": "resetpanels",
  "return": "pass",
  "sd": "imagine",
  "sd-source": "imagine-source",
  "sd-style": "imagine-style",
  "secret-find": "secret-read",
  "secret-get": "secret-read",
  "secret-rotate": "secret-id",
  "server": "api-url",
  "set-reasoning": "reasoning-set",
  "setchatvar": "setvar",
  "setlorefield": "setentryfield",
  "setpromptentries": "setpromptentry",
  "setwifield": "setentryfield",
  "sg": "show-gallery",
  "sleep": "delay",
  "sprite": "expression-set",
  "spriteoverride": "expression-folder-override",
  "stopping-strings": "stop-strings",
  "story": "single",
  "substring": "substr",
  "swipeadd": "addswipe",
  "swipedel": "delswipe",
  "sync": "persona-sync",
  "sysprompt-disable": "sysprompt-off",
  "sysprompt-enable": "sysprompt-on",
  "sysprompt-toggle": "sysprompt-state",
  "system-prompt": "sysprompt",
  "to-lower": "lower",
  "to-upper": "upper",
  "toggle-reasoning": "reasoning-toggle",
  "togglepanels": "panels",
  "tool-invoke": "tools-invoke",
  "tool-list": "tools-list",
  "tool-register": "tools-register",
  "tool-unregister": "tools-unregister",
  "tts": "speak",
  "uploadsprite": "expression-upload",
  "upmember": "member-up",
  "uppercase": "upper",
  "wait": "delay",
});

/** 帧内别名种子：alias → base 的可序列化副本（与上面的对账口径同源）。 */
export function getStCompatCommandAliases(): Record<string, string> {
  return { ...ST_118_COMMAND_ALIASES };
}

/** 帧内枚举种子：返回一份可序列化的副本（避免调用方改写冰常量）。 */
export function getStCompatCommandNames(): string[] {
  return ST_118_COMMAND_NAMES.slice();
}
