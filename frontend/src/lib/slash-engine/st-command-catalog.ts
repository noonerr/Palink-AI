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

/** 帧内枚举种子：返回一份可序列化的副本（避免调用方改写冰常量）。 */
export function getStCompatCommandNames(): string[] {
  return ST_118_COMMAND_NAMES.slice();
}
