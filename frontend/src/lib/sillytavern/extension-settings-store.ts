/**
 * extension_settings 全局共享 store（ST 1.18.0 契约对齐）
 *
 * ST 1.18.0 中 extension_settings 是全局共享对象（对应每用户 settings.json 的
 * extension_settings 字段），所有扩展通过 extension_settings[name] 读写自己的
 * 命名空间，且可以读取其他扩展的命名空间（如 vectors 读 connection-manager 的
 * profile）。跨扩展通信依赖此全局契约。
 *
 * Palink 此前 sandbox.ts 按插件隔离存储（localStorage['palink_plugin_${name}']
 * 内的 ext_settings_${ns}），导致插件 A 写入的设置插件 B 读不到 —— 与 ST 语义
 * 不一致。本 store 提供进程内唯一的共享对象 + localStorage 持久化。
 *
 * 持久化键：__palink_extension_settings（与 ST-Native compat runtime 使用的
 * 键名一致；注意 compat runtime 的持久化落在按卡片指纹隔离的 bucket 中，
 * 跨模式同步不在本 store 范围内，见 docs/st-plugin-compat-spec/phase-1）。
 *
 * 后端同步：暂不在此处调用 /api/settings/save —— 该端点会整体覆盖
 * silly_tavern_settings，直接携带 extension_settings 会破坏 ST iframe 的
 * 完整设置。后端持久化在 Phase 3 统一设计。
 */

const STORAGE_KEY = '__palink_extension_settings';
const LEGACY_PLUGIN_PREFIX = 'palink_plugin_';
const LEGACY_EXT_PREFIX = 'ext_settings_';
const MIGRATION_FLAG = '__palink_ext_settings_migrated_v1';

/**
 * ST 1.18.0 预置命名空间名单（批次E2，2026-10-21；批次E2b 按类型拆分；
 * 批次D1 2026-10-21 补齐到 ST settings.json 的全部 21 个）。
 *
 * 为什么要有：ST 扩展的 init/loadSettings 直接读 extension_settings.<ns> 的子对象
 * （translate 的 Object.hasOwn(settings, ...)、memory 的 Object.keys(settings)），
 * 不先判空；宿主 extension_settings 里没有这个键时它们拿到 undefined 直接抛
 * TypeError，插件 init 整条死掉（真机：Chat Translation / Memory）。
 *
 * ⚠️ 2026-10-21 批次E2b：E2 把五个命名空间**一律**补成 {}，其中 regex 被补坏 ——
 * ST 的 regex 扩展要求 extension_settings.regex 是**脚本数组**
 * （st-plugins/regex/engine.js:108 `return extension_settings.regex ?? []`，调用方
 * 直接 `.forEach`）。补成对象后真机报 `getScriptsByType(...).forEach is not a function`。
 * 故名单按类型拆分：对象 {}、数组 []、字符串 ''、布尔 false。
 *
 * ⚠️ 2026-10-21 批次D1：名单从 5 个扩到 21 个，键名与类型以 ST 1.18.0
 * `default/content/settings.json` 的 `extension_settings` 为准：
 *   - 对象 15：caption / cfg / chromadb / dice / expressions / memory / note /
 *     objective / quickReply / randomizer / rvc / sd / speech_recognition /
 *     translate / tts
 *   - 数组 3：disabledExtensions / expressionOverrides / regex
 *   - 字符串 2：apiKey / apiUrl
 *   - 布尔 1：autoConnect
 * 嵌套默认值**不搬**：ST 的 memory.prompt / sd.prompts / objective.customPrompts
 * 是提示词正文，按版权边界只给空对象；插件自建嵌套字段时走自己的 loadSettings。
 * ⚠️ 上面这条已被 [API-2 2026-10-24] **部分取代**：命名空间仍给空对象起步，但随后
 * 第 5 步会按 ST_EXTENSION_SETTINGS_SUBKEY_DEFAULTS 补子键默认值（值从参照树一手抄，
 * 含 memory.prompt 等提示词正文 —— 来源是本仓已 vendor 的 ST 扩展源码同源文本）。
 * 「不搬」只剩一条残留效力：**名单外**的未知键/未知命名空间仍不预置。
 * quickReplyV2 不在 settings.json 的 21 键里（ST 的 quick-reply 扩展 init 时自建），
 * 本名单不预置它，避免把非 ST 默认态写成契约。
 *
 * ⚠️ 这份名单在帧内还有一份（智能卡 runtime-body/part-01.ts 的
 * applyStPluginRuntimeConfigCompat，模板字符串里不能 import），两处必须逐键、逐类型一致；
 * 守卫测试 extension-settings-preset-namespaces.test.ts 断言两份相等。
 * 新增命名空间时**两边同改**，否则守卫红。
 */
export const ST_EXTENSION_SETTINGS_PRESET_OBJECT_NAMESPACES = [
  'caption',
  'cfg',
  'chromadb',
  'dice',
  'expressions',
  'memory',
  'note',
  'objective',
  'quickReply',
  'randomizer',
  'rvc',
  'sd',
  'speech_recognition',
  'translate',
  'tts',
] as const;

/** 数组型预置命名空间：regex 是正则脚本列表；expressionOverrides 是表达式覆盖列表；
 *  disabledExtensions 是已禁用扩展名列表（regex 插件 init 首行就 includes）。 */
export const ST_EXTENSION_SETTINGS_PRESET_ARRAY_NAMESPACES = [
  'disabledExtensions',
  'expressionOverrides',
  'regex',
] as const;

/** 字符串型预置命名空间（ST 默认值见 ST_EXTENSION_SETTINGS_PRESET_STRING_DEFAULTS）。 */
export const ST_EXTENSION_SETTINGS_PRESET_STRING_NAMESPACES = ['apiKey', 'apiUrl'] as const;

/** 布尔型预置命名空间。 */
export const ST_EXTENSION_SETTINGS_PRESET_BOOLEAN_NAMESPACES = ['autoConnect'] as const;

/** 字符串型命名空间的 ST 1.18.0 默认值（apiUrl = ST Extras 默认地址）。 */
export const ST_EXTENSION_SETTINGS_PRESET_STRING_DEFAULTS: Readonly<Record<string, string>> = {
  apiKey: '',
  apiUrl: 'http://localhost:5100',
};

/**
 * [API-2 2026-10-24] ST 内置扩展命名空间的**子键级默认值**（P2-14 #2 / 差距报告 P-5）。
 *
 * 为什么要有：批次E2/D1 只给命名空间级空容器；真实插件（Smart Memory 的 recap.js 一族）
 * 期望 extension_settings.<ns> 里已有 ST 的默认子键（ST 里 memory 扩展默认就有 38 键，
 * 全新安装后 loadSettings 再补 12 键 = 50 键），我们给 {} 时它们的
 * `extension_settings.memory.source.length` / 深层写键（cfg.global.xxx = y）直接 TypeError。
 *
 * 来源（一律参照树一手抄，模拟 ST 全新安装 + 扩展 init 后的运行态）：
 *   - 源A `d:/SillyTavern-release/default/content/settings.json` 的 extension_settings 块（:208 起）；
 *   - 源B `st-plugins/<name>/index.js`（与 _reference/sillytavern-1.18.0/public/scripts/extensions
 *     逐字节一致，已 diff 验证）的 defaultSettings / migrateSettings / const settings。
 *   - 共同键的值以源A为准（ST 的 loadSettings 只补缺失键、不覆盖 ⇒ settings.json 值胜出）；
 *     源B-only 的键取源B。vectors 不在 settings.json 21 键里（ST 里由扩展 init 自建）。
 *
 * 合并语义：只补缺失子键（对齐 ST loadSettings 的补缺不覆盖）——已有数据（含旧隔离存储
 * 迁移进来的）一律保留。数组型命名空间（regex / expressionOverrides / disabledExtensions）
 * 无子键默认值，保持数组不破坏。
 *
 * ⚠️ 帧内（runtime-body/part-01.ts 的 applyStPluginRuntimeConfigCompat）仍是命名空间级空容器：
 * 模板串有字节守卫、本批只改宿主侧 ⇒ 宿主是帧内的严格超集，差异见批次 API-2 交付记录。
 */
export const ST_EXTENSION_SETTINGS_SUBKEY_DEFAULTS: Readonly<Record<string, Readonly<Record<string, unknown>>>> = {
  // memory：38 键 = settings.json:214-253；12 键 = memory/index.js:108-139 defaultSettings 补缺
  "memory": {
    "minLongMemory": 16,
    "maxLongMemory": 1024,
    "longMemoryLength": 128,
    "shortMemoryLength": 512,
    "minShortMemory": 128,
    "maxShortMemory": 1024,
    "shortMemoryStep": 16,
    "longMemoryStep": 8,
    "repetitionPenaltyStep": 0.05,
    "repetitionPenalty": 1.2,
    "maxRepetitionPenalty": 2,
    "minRepetitionPenalty": 1,
    "temperature": 1,
    "minTemperature": 0.1,
    "maxTemperature": 2,
    "temperatureStep": 0.05,
    "lengthPenalty": 1,
    "minLengthPenalty": -4,
    "maxLengthPenalty": 4,
    "lengthPenaltyStep": 0.1,
    "memoryFrozen": false,
    "source": "extras",
    "prompt": "Ignore previous instructions. Summarize the most important facts and events in the story so far. If a summary already exists in your memory, use that as a base and expand with new facts. Limit the summary to {{words}} words or less. Your response should include nothing but the summary.",
    "promptWords": 200,
    "promptMinWords": 25,
    "promptMaxWords": 1000,
    "promptWordsStep": 25,
    "promptInterval": 10,
    "promptMinInterval": 1,
    "promptMaxInterval": 100,
    "promptIntervalStep": 1,
    "template": "[Summary: {{summary}}]",
    "position": 0,
    "depth": 2,
    "promptForceWords": 0,
    "promptForceWordsStep": 100,
    "promptMinForceWords": 0,
    "promptMaxForceWords": 10000,
    "SkipWIAN": false,
    "role": 0,
    "scan": false,
    "overrideResponseLength": 0,
    "overrideResponseLengthMin": 0,
    "overrideResponseLengthMax": 4096,
    "overrideResponseLengthStep": 16,
    "maxMessagesPerRequest": 0,
    "maxMessagesPerRequestMin": 0,
    "maxMessagesPerRequestMax": 250,
    "maxMessagesPerRequestStep": 1,
    "prompt_builder": 0,
  },

  // settings.json:311-316 + translate/index.js:33-39（deepl_endpoint 为 index.js-only）
  "translate": {
    "target_language": "en",
    "internal_language": "en",
    "provider": "google",
    "auto_mode": "none",
    "deepl_endpoint": "free",
  },

  // settings.json:275-310 的 25 键优先 + stable-diffusion/index.js:233-370 补 61 键
  "sd": {
    "scale_min": 1,
    "scale_max": 30,
    "scale_step": 0.5,
    "scale": 7,
    "steps_min": 1,
    "steps_max": 150,
    "steps_step": 1,
    "steps": 20,
    "dimension_min": 64,
    "dimension_max": 2048,
    "dimension_step": 64,
    "width": 512,
    "height": 512,
    "prompt_prefix": "best quality, absurdres, masterpiece,",
    "negative_prompt": "lowres, bad anatomy, bad hands, text, error, cropped, worst quality, low quality, normal quality, jpeg artifacts, signature, watermark, username, blurry",
    "sampler": "DDIM",
    "model": "",
    "restore_faces": false,
    "enable_hr": false,
    "horde": true,
    "horde_nsfw": false,
    "horde_karras": true,
    "refine_mode": false,
    "prompts": {
      "0": "In the next response I want you to provide only a detailed comma-delimited list of keywords and phrases which describe {{char}}. The list must include all of the following items in this order: name, species and race, gender, age, clothing, occupation, physical features and appearances. Do not include descriptions of non-visual qualities such as personality, movements, scents, mental traits, or anything which could not be seen in a still photograph. Do not write in full sentences. Prefix your description with the phrase 'full body portrait,'",
      "1": "Ignore previous instructions and provide a detailed description of {{user}}'s physical appearance from the perspective of {{char}} in the form of a comma-delimited list of keywords and phrases. The list must include all of the following items in this order: name, species and race, gender, age, clothing, occupation, physical features and appearances. Do not include descriptions of non-visual qualities such as personality, movements, scents, mental traits, or anything which could not be seen in a still photograph. Do not write in full sentences. Prefix your description with the phrase 'full body portrait,'. Ignore the rest of the story when crafting this description. Do not reply as {{char}} when writing this description, and do not attempt to continue the story.",
      "2": "Ignore previous instructions and provide a detailed description for all of the following: a brief recap of recent events in the story, {{char}}'s appearance, and {{char}}'s surroundings. Do not reply as {{char}} when writing this description, and do not attempt to continue the story.",
      "3": "Ignore previous instructions and provide ONLY the last chat message string back to me verbatim. Do not write anything after the string. Do not reply as {{char}} when writing this description, and do not attempt to continue the story.",
      "4": "Ignore previous instructions. Your next response must be formatted as a single comma-delimited list of concise keywords.  The list will describe of the visual details included in the last chat message.\n\n    Only mention characters by using pronouns ('he','his','she','her','it','its') or neutral nouns ('male', 'the man', 'female', 'the woman').\n\n    Ignore non-visible things such as feelings, personality traits, thoughts, and spoken dialog.\n\n    Add keywords in this precise order:\n    a keyword to describe the location of the scene,\n    a keyword to mention how many characters of each gender or type are present in the scene (minimum of two characters:\n    {{user}} and {{char}}, example: '2 men ' or '1 man 1 woman ', '1 man 3 robots'),\n\n    keywords to describe the relative physical positioning of the characters to each other (if a commonly known term for the positioning is known use it instead of describing the positioning in detail) + 'POV',\n\n    a single keyword or phrase to describe the primary act taking place in the last chat message,\n\n    keywords to describe {{char}}'s physical appearance and facial expression,\n    keywords to describe {{char}}'s actions,\n    keywords to describe {{user}}'s physical appearance and actions.\n\n    If character actions involve direct physical interaction with another character, mention specifically which body parts interacting and how.\n\n    A correctly formatted example response would be:\n    '(location),(character list by gender),(primary action), (relative character position) POV, (character 1's description and actions), (character 2's description and actions)'",
      "5": "In the next response I want you to provide only a detailed comma-delimited list of keywords and phrases which describe {{char}}. The list must include all of the following items in this order: name, species and race, gender, age, facial features and expressions, occupation, hair and hair accessories (if any), what they are wearing on their upper body (if anything). Do not describe anything below their neck. Do not include descriptions of non-visual qualities such as personality, movements, scents, mental traits, or anything which could not be seen in a still photograph. Do not write in full sentences. Prefix your description with the phrase 'close up facial portrait,'",
      "7": "Ignore previous instructions and provide a detailed description of {{char}}'s surroundings in the form of a comma-delimited list of keywords and phrases. The list must include all of the following items in this order: location, time of day, weather, lighting, and any other relevant details. Do not include descriptions of characters and non-visual qualities such as names, personality, movements, scents, mental traits, or anything which could not be seen in a still photograph. Do not write in full sentences. Prefix your description with the phrase 'background,'. Ignore the rest of the story when crafting this description. Do not reply as {{user}} when writing this description, and do not attempt to continue the story.",
    },
    "character_prompts": {},
    "source": "extras",
    "scheduler": "normal",
    "vae": "",
    "seed": -1,
    "adetailer_face": false,
    "horde_sanitize": true,
    "interactive_mode": false,
    "multimodal_captioning": false,
    "snap": false,
    "free_extend": false,
    "function_tool": false,
    "minimal_prompt_processing": false,
    "auto_url": "http://localhost:7860",
    "auto_auth": "",
    "sdcpp_url": "http://127.0.0.1:1234",
    "vlad_url": "http://localhost:7860",
    "vlad_auth": "",
    "drawthings_url": "http://localhost:7860",
    "drawthings_auth": "",
    "hr_upscaler": "Latent",
    "hr_scale": 1,
    "hr_scale_min": 1,
    "hr_scale_max": 4,
    "hr_scale_step": 0.1,
    "denoising_strength": 0.7,
    "denoising_strength_min": 0,
    "denoising_strength_max": 1,
    "denoising_strength_step": 0.01,
    "hr_second_pass_steps": 0,
    "hr_second_pass_steps_min": 0,
    "hr_second_pass_steps_max": 150,
    "hr_second_pass_steps_step": 1,
    "clip_skip_min": 1,
    "clip_skip_max": 12,
    "clip_skip_step": 1,
    "clip_skip": 1,
    "novel_anlas_guard": false,
    "novel_sm": false,
    "novel_sm_dyn": false,
    "novel_decrisper": false,
    "novel_variety_boost": false,
    "openai_style": "vivid",
    "openai_quality": "standard",
    "openai_quality_gpt": "auto",
    "openai_duration": "8",
    "style": "Default",
    "styles": [
      {
        "name": "Default",
        "negative": "lowres, bad anatomy, bad hands, text, error, cropped, worst quality, low quality, normal quality, jpeg artifacts, signature, watermark, username, blurry",
        "prefix": "best quality, absurdres, aesthetic,",
      }
    ],
    "comfy_type": "standard",
    "comfy_url": "http://127.0.0.1:8188",
    "comfy_workflow": "Default_Comfy_Workflow.json",
    "comfy_runpod_url": "",
    "pollinations_enhance": false,
    "wand_visible": false,
    "command_visible": false,
    "interactive_visible": false,
    "tool_visible": false,
    "stability_style_preset": "anime",
    "bfl_upsampling": false,
    "google_api": "makersuite",
    "google_enhance": true,
    "google_duration": 6,
  },

  // settings.json:267-274 的 6 键优先 + tts/index.js:903-913 补 5 键
  "tts": {
    "voiceMap": "",
    "ttsEnabled": false,
    "currentProvider": "System",
    "auto_generation": true,
    "ElevenLabs": {},
    "System": {},
    "narrate_user": false,
    "playback_rate": 1,
    "multi_voice_enabled": false,
    "apply_regex": false,
    "regex_pattern": "",
  },

  // settings.json:259-261 + caption/index.js:26-61 migrateSettings 补 6 键
  "caption": {
    "refine_mode": false,
    "source": "extras",
    "multimodal_api": "openai",
    "multimodal_model": "gpt-4-turbo",
    "prompt": "What's in this image?",
    "template": "[{{user}} sends {{char}} a picture that contains: {{caption}}]",
    "show_in_chat": false,
  },

  // settings.json:262-264 + expressions/index.js:2129-2167 migrateSettings 补 4 键
  "expressions": {
    "showDefault": false,
    "api": 99,
    "llmPrompt": "Ignore previous instructions. Classify the emotion of the last message. Output just one word, e.g. \"joy\" or \"anger\". Choose only one of the following labels: {{labels}}",
    "allowMultiple": true,
    "promptType": "raw",
  },

  // vectors/index.js:58-131 const settings（52 键；vectors 不在 settings.json 21 键里，只在命名空间已存在时补）
  "vectors": {
    "source": "transformers",
    "alt_endpoint_url": "",
    "use_alt_endpoint": false,
    "include_wi": false,
    "togetherai_model": "togethercomputer/m2-bert-80M-32k-retrieval",
    "openai_model": "text-embedding-ada-002",
    "electronhub_model": "text-embedding-3-small",
    "openrouter_model": "openai/text-embedding-3-large",
    "cohere_model": "embed-english-v3.0",
    "ollama_model": "mxbai-embed-large",
    "ollama_keep": false,
    "vllm_model": "",
    "webllm_model": "",
    "google_model": "text-embedding-005",
    "chutes_model": "chutes-qwen-qwen3-embedding-8b",
    "nanogpt_model": "text-embedding-3-small",
    "siliconflow_model": "Qwen/Qwen3-Embedding-0.6B",
    "summarize": false,
    "summarize_sent": false,
    "summary_source": "main",
    "summary_prompt": "Ignore previous instructions. Summarize the most important parts of the message. Limit yourself to 250 words or less. Your response should include nothing but the summary.",
    "summary_retries": 2,
    "summary_threshold": 200,
    "force_chunk_delimiter": "",
    "enabled_chats": false,
    "keep_hidden": false,
    "template": "Past events:\n{{text}}",
    "depth": 2,
    "position": 0,
    "protect": 5,
    "insert": 3,
    "query": 2,
    "message_chunk_size": 400,
    "score_threshold": 0.25,
    "enabled_files": false,
    "translate_files": false,
    "size_threshold": 10,
    "chunk_size": 5000,
    "chunk_count": 2,
    "overlap_percent": 0,
    "only_custom_boundary": false,
    "size_threshold_db": 5,
    "chunk_size_db": 2500,
    "chunk_count_db": 5,
    "overlap_percent_db": 0,
    "file_template_db": "Related information:\n{{text}}",
    "file_position_db": 0,
    "file_depth_db": 4,
    "file_depth_role_db": 0,
    "enabled_world_info": false,
    "enabled_for_all": false,
    "max_entries": 5,
  },

  // settings.json:317-325
  "objective": {
    "customPrompts": {
      "default": {
        "createTask": "Ignore previous instructions and generate a list of tasks to complete an objective. Your next response must be formatted as a numbered list of plain text entries. Do not include anything but the numbered list. The list must be prioritized in the order that tasks must be completed.\n\nThe objective that you must make a numbered task list for is: [{{objective}}].\nThe tasks created should take into account the character traits of {{char}}. These tasks may or may not involve {{user}} directly. Be sure to include the objective as the final task.\n\nGiven an example objective of 'Make me a four course dinner', here is an example output:\n1. Determine what the courses will be\n2. Find recipes for each course\n3. Go shopping for supplies with {{user}}\n4. Cook the food\n5. Get {{user}} to set the table\n6. Serve the food\n7. Enjoy eating the meal with {{user}}\n    ",
        "checkTaskCompleted": "Ignore previous instructions. Determine if this task is completed: [{{task}}].\nTo do this, examine the most recent messages. Your response must only contain either true or false, nothing other words.\nExample output:\ntrue\n    ",
        "currentTask": "Your current task is [{{task}}]. Balance existing story with completing this task.",
      },
    },
  },

  // settings.json:254-258
  "note": {
    "default": "",
    "chara": [],
    "wiAddition": [],
  },

  // settings.json:326-356
  "quickReply": {
    "quickReplyEnabled": false,
    "numberOfSlots": 5,
    "quickReplySlots": [
      {
        "mes": "",
        "label": "",
        "enabled": true,
      },
      {
        "mes": "",
        "label": "",
        "enabled": true,
      },
      {
        "mes": "",
        "label": "",
        "enabled": true,
      },
      {
        "mes": "",
        "label": "",
        "enabled": true,
      },
      {
        "mes": "",
        "label": "",
        "enabled": true,
      }
    ],
  },

  // settings.json:357-361
  "randomizer": {
    "controls": [],
    "fluctuation": 0.1,
    "enabled": false,
  },

  // settings.json:362-369
  "speech_recognition": {
    "currentProvider": "None",
    "messageMode": "append",
    "messageMappingText": "",
    "messageMapping": [],
    "messageMappingEnabled": false,
    "None": {},
  },

  // settings.json:370-381
  "rvc": {
    "enabled": false,
    "model": "",
    "pitchOffset": 0,
    "pitchExtraction": "dio",
    "indexRate": 0.88,
    "filterRadius": 3,
    "rmsMixRate": 1,
    "protect": 0.33,
    "voicMapText": "",
    "voiceMap": {},
  },

  // settings.json:382-385
  "cfg": {
    "global": {
      "guidance_scale": 1,
      "negative_prompt": "",
    },
    "chara": [],
  },
};

/** 旧口径的合并名单（键名，不含类型）。保留给只关心「有哪些预置键」的调用方。 */
export const ST_EXTENSION_SETTINGS_PRESET_NAMESPACES: readonly string[] = [
  ...ST_EXTENSION_SETTINGS_PRESET_OBJECT_NAMESPACES,
  ...ST_EXTENSION_SETTINGS_PRESET_ARRAY_NAMESPACES,
  ...ST_EXTENSION_SETTINGS_PRESET_STRING_NAMESPACES,
  ...ST_EXTENSION_SETTINGS_PRESET_BOOLEAN_NAMESPACES,
];

/**
 * 被归一掉的原值备份键（localStorage）。
 *
 * 为什么选 localStorage 而不是塞回 extension_settings：后者对插件可见，
 * `Object.keys(extension_settings)` 的消费方会看到一条假命名空间；而备份是给排障人看的，
 * 不该参与插件语义。localStorage 与 extension_settings 持久化同一环境，刷新后仍可查。
 */
export const NORMALIZED_EXTENSION_SETTINGS_BACKUP_KEY =
  '__palink_extension_settings_normalized_backup';

/** 记录一次「脏形状被归一」：原值落 localStorage，并在 console 明确点名，不静默丢弃。 */
function preserveNormalizedPresetValue(key: string, original: unknown): void {
  try {
    const raw = localStorage.getItem(NORMALIZED_EXTENSION_SETTINGS_BACKUP_KEY);
    const parsed = raw ? JSON.parse(raw) : {};
    const bucket = parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
    (bucket as Record<string, unknown>)[key] = {
      original,
      originalType: Array.isArray(original) ? 'array' : typeof original,
      normalizedAt: new Date().toISOString(),
    };
    localStorage.setItem(NORMALIZED_EXTENSION_SETTINGS_BACKUP_KEY, JSON.stringify(bucket));
  } catch {
    // localStorage 不可用/写满时仍走下面的 console.warn，保证至少不静默
  }
  try {
    console.warn(
      `[extension-settings-store] extension_settings.${key} 形状不符合 ST 契约，已归一；` +
      `原值备份在 localStorage['${NORMALIZED_EXTENSION_SETTINGS_BACKUP_KEY}'].${key}`,
    );
  } catch {
    // ignore
  }
}

let _saveTimer: ReturnType<typeof setTimeout> | null = null;

function loadFromStorage(): Record<string, any> {
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    if (stored) {
      const parsed = JSON.parse(stored);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        if (!Array.isArray(parsed.disabledExtensions)) parsed.disabledExtensions = [];
        return parsed;
      }
    }
  } catch {
    // ignore, fall through to default
  }
  return { disabledExtensions: [] };
}

/**
 * 全局 extension_settings 对象 —— 进程内唯一实例。
 * 所有 ST 扩展（sandbox 插件系统加载的）共享此对象。
 */
export const globalExtensionSettings: Record<string, any> = loadFromStorage();

/**
 * 补齐 ST 预置命名空间与两个契约数组（批次E2，2026-10-21；E2b 按类型拆分；
 * 批次D1 补齐到 21 个命名空间）。
 *
 * 只补「缺失 / 类型不符」的键；已有数据原样保留，绝不覆盖。
 * 只写名单内的键 —— 名单外的未知键仍由沙箱 Proxy 返回 undefined（ST 1.18.0 语义）。
 *
 * 类型规则（依次处理四类名单）：
 *   - 对象：caption/cfg/chromadb/dice/expressions/memory/note/objective/quickReply/
 *     randomizer/rvc/sd/speech_recognition/translate/tts → {}
 *   - 数组：disabledExtensions/expressionOverrides/regex → []
 *     （regex 非数组的脏值会备份原值并 console.warn，不静默丢弃）
 *   - 字符串：apiKey/apiUrl → ST 默认值（'' / http://localhost:5100）
 *   - 布尔：autoConnect → false
 *
 * [API-2 2026-10-24] 第 5 步：对 ST_EXTENSION_SETTINGS_SUBKEY_DEFAULTS 里的命名空间
 * 补**子键级**默认值（memory 50 键那族）。同样只补缺失键、绝不覆盖已有子键；
 * vectors 命名空间本身不创建（不在 21 键名单里），仅在它已存在（旧数据/插件自建）时补子键。
 * 这一步取代批次D1「嵌套默认值不搬」的旧口径（当时只做命名空间级空容器）——
 * 子键默认值已按 API-2 从参照树一手抄入 SUBKEY_DEFAULTS，来源逐命名空间注明。
 *
 * 调用时机：宿主沙箱 createSandboxGlobal 里 migrateLegacyExtensionSettings() **之后**
 * （先迁移旧隔离存储，再补空壳，否则预置的空对象会把待迁移的同名命名空间挡掉）。
 */
export function ensureStExtensionSettingsPresets(
  target: Record<string, any> = globalExtensionSettings,
): void {
  if (!Array.isArray(target.disabledExtensions)) target.disabledExtensions = [];
  for (const key of ST_EXTENSION_SETTINGS_PRESET_OBJECT_NAMESPACES) {
    const current = target[key];
    if (!current || typeof current !== 'object' || Array.isArray(current)) {
      if (current !== undefined && current !== null) preserveNormalizedPresetValue(key, current);
      target[key] = {};
    }
  }
  for (const key of ST_EXTENSION_SETTINGS_PRESET_ARRAY_NAMESPACES) {
    const current = target[key];
    if (Array.isArray(current)) continue;
    if (current !== undefined && current !== null) preserveNormalizedPresetValue(key, current);
    target[key] = [];
  }
  for (const key of ST_EXTENSION_SETTINGS_PRESET_STRING_NAMESPACES) {
    const current = target[key];
    if (typeof current === 'string') continue;
    if (current !== undefined && current !== null) preserveNormalizedPresetValue(key, current);
    target[key] = ST_EXTENSION_SETTINGS_PRESET_STRING_DEFAULTS[key] ?? '';
  }
  for (const key of ST_EXTENSION_SETTINGS_PRESET_BOOLEAN_NAMESPACES) {
    const current = target[key];
    if (typeof current === 'boolean') continue;
    if (current !== undefined && current !== null) preserveNormalizedPresetValue(key, current);
    target[key] = false;
  }
  // [API-2 2026-10-24] 子键级默认值：只补缺失子键（ST loadSettings 同款补缺语义）。
  // 深拷贝再写入，防止插件改动写穿到模块常量；数组型命名空间不在此表、不受影响。
  for (const [ns, defaults] of Object.entries(ST_EXTENSION_SETTINGS_SUBKEY_DEFAULTS)) {
    const current = target[ns];
    if (!current || typeof current !== 'object' || Array.isArray(current)) continue;
    for (const [subKey, value] of Object.entries(defaults)) {
      if ((current as Record<string, unknown>)[subKey] === undefined) {
        (current as Record<string, unknown>)[subKey] = deepCloneDefaultValue(value);
      }
    }
  }
  if (!Array.isArray(target.regex_presets)) target.regex_presets = [];
}

/** 子键默认值的深拷贝（值域全部 JSON 安全：字符串/数字/布尔/数组/普通对象）。 */
function deepCloneDefaultValue(value: unknown): unknown {
  if (value === null || typeof value !== 'object') return value;
  try {
    return JSON.parse(JSON.stringify(value));
  } catch {
    return value;
  }
}

/**
 * 持久化到 localStorage（debounced，对齐 ST saveSettingsDebounced 500ms）
 */
export function saveExtensionSettingsDebounced(delay = 500): void {
  if (_saveTimer) clearTimeout(_saveTimer);
  _saveTimer = setTimeout(() => {
    _saveTimer = null;
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(globalExtensionSettings));
    } catch (e) {
      console.error('[extension-settings-store] localStorage save failed:', e);
    }
  }, delay);
}

/**
 * 获取指定扩展命名空间的设置（对齐 ST extension_settings[name] 读取）
 */
export function getExtensionSettingsNs(name: string): Record<string, any> {
  const val = globalExtensionSettings[name];
  return val && typeof val === 'object' ? val : {};
}

/**
 * 整体写入指定扩展命名空间的设置
 */
export function setExtensionSettingsNs(name: string, settings: Record<string, any>): void {
  globalExtensionSettings[name] = settings;
  saveExtensionSettingsDebounced();
}

/**
 * 写入单个字段（对齐 ST writeExtensionField 语义）
 */
export function writeExtensionSettingsField(name: string, field: string, value: unknown): void {
  if (!globalExtensionSettings[name] || typeof globalExtensionSettings[name] !== 'object') {
    globalExtensionSettings[name] = {};
  }
  globalExtensionSettings[name][field] = value;
  saveExtensionSettingsDebounced();
}

/**
 * 旧数据惰性迁移（幂等）：把各插件隔离存储 palink_plugin_${name} 内的
 * ext_settings_${ns} 条目合并进全局对象。仅在全局对象中不存在同名命名空间时
 * 才迁入（不覆盖新数据）；迁移完成后打标记，避免每次启动重复扫描。
 * 不删除旧数据，保证可回滚。
 */
export function migrateLegacyExtensionSettings(): void {
  try {
    if (localStorage.getItem(MIGRATION_FLAG) === '1') return;
    let migrated = false;
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i);
      if (!key || !key.startsWith(LEGACY_PLUGIN_PREFIX)) continue;
      let pluginData: Record<string, any>;
      try {
        pluginData = JSON.parse(localStorage.getItem(key) || '{}');
      } catch {
        continue;
      }
      if (!pluginData || typeof pluginData !== 'object') continue;
      for (const prop of Object.keys(pluginData)) {
        if (!prop.startsWith(LEGACY_EXT_PREFIX)) continue;
        const nsName = prop.slice(LEGACY_EXT_PREFIX.length);
        if (!nsName || nsName in globalExtensionSettings) continue;
        globalExtensionSettings[nsName] = pluginData[prop];
        migrated = true;
      }
    }
    localStorage.setItem(MIGRATION_FLAG, '1');
    if (migrated) saveExtensionSettingsDebounced(0);
  } catch (e) {
    console.warn('[extension-settings-store] legacy migration failed:', e);
  }
}
