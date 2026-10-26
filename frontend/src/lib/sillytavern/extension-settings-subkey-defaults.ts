/**
 * ST 内置扩展命名空间的**子键级默认值** —— 宿主与帧内共用的单源常量（纯数据，零 import）。
 *
 * [API-2 2026-10-24] 首批入账（P2-14 #2 / 差距报告 P-5），常量原先内联在
 * extension-settings-store.ts；[帧内同步 2026-10-26] 抽出为独立模块。
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
 * 帧内下发（runtime-body/part-01.ts 的 applyStPluginRuntimeConfigCompat）：模板串不能
 * import，构建期经 JSON.stringify 插值把本常量内联为帧内 ST_PLUGIN_SUBKEY_DEFAULTS_COMPAT
 * （照 BUNDLED_ST_PLUGIN_CSS 同款先例）；插值位点登记于
 * runtime-body-template-literal-guard.test.ts 的 ALLOWED_INTERPOLATIONS，逐键相等由
 * extension-settings-preset-namespaces.test.ts 的帧内守卫锚定。store 侧 re-export 本常量，
 * 公共 API 与既有测试 import 路径不变。
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
