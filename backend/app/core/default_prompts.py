"""
默认提示词配置 — ST 1.18.0 对齐结构（2026-09-27 身份层 ST 化）

main 槽：ST 默认任务指令（第三人称视角，不做"你是谁"身份断言）
story_string 槽：角色卡字段（逐项守卫，空则整段缺席）
auxiliary 层：输出格式约定（仅 Palink 产品必需项与渲染扩展）
"""

# 普通对话默认提示词
DEFAULT_CHAT_PROMPT_ZH = """你是一个有帮助的AI助手。

除非用户明确要求，否则使用与用户相同的语言回复。"""

DEFAULT_CHAT_PROMPT_EN = """You are a helpful assistant.

Reply in the same language as the user unless explicitly requested otherwise."""

# ═══════════════════
# main 槽：ST 1.18.0 默认 main prompt
# （openai.js:101 / PromptManager.js:2007 / default/content/settings.json:175，
#  默认选中预设 "Neutral - Chat"；不分语言——ST 不翻译）。
# 取 {{char}} 形态：{{charIfNotGroup}} 不在 _replace_placeholders 宏支持
# 列表且会被 \{\{char\}\} 匹配漏掉，字面量会原样泄漏进提示词。
# ═══════════════════════

ST_DEFAULT_MAIN_PROMPT = "Write {{char}}'s next reply in a fictional chat between {{char}} and {{user}}."

# ═════════════════════════════════
# story_string 槽：角色卡字段（对齐 ST default/content/presets/context/Default.json
# 的 {{#if description}}…{{/if}} 语义——空字段直接消失，不打印占位文本；
# attributes 为空时整段缺席，由 build_default_character_prompt 保证）
# ══════════════════════════════════════

CHARACTER_ATTRIBUTES_TEMPLATE_ZH = """【角色卡】
{attributes}"""

CHARACTER_ATTRIBUTES_TEMPLATE_EN = """[Character Card]
{attributes}"""

# ═══════════════════════════════════════════
# auxiliary 层：输出格式约定（最后强调，位于 system_prompt 尾部）
# 引号包对话/括号包内心/禁 XML 标签是 Palink 渲染约定（ST 无对应），
# 明确标注为 Palink 扩展；【声音】与 [标题] 有真实消费方，必须存活
# （tts.ts 的声音提取、compact_title_service 的标题提取）。
# 不得含任何身份或视角措辞（2026-09-27 身份层 ST 化）。
# ════════════════════════════════════════

AUXILIARY_TEMPLATE_ZH = """【输出格式约定 - Palink 扩展，非 ST 规范】
- 口语对话：用双引号包裹 "你好！"
- 内心想法：用括号包裹 （我该怎么办...）
- 动作叙述：用普通文本，不加特殊标记
- 禁止使用：<action>、<thinking>等XML标签
- 根据情境调整回复长度：快速交流时简短，情感或戏剧性时刻可以更长

【声音描述要求】
- 在回复的最后，用一行文字描述当前回复适合的声音特点
- 格式：【声音：描述】
- 描述应包括：语气（如温柔/活泼/成熟/稳重等）、情绪（如开心/害羞/兴奋/愤怒等）
- 示例：【声音：温柔开心的女声】或【声音：稳重低沉的男声】"""

AUXILIARY_TEMPLATE_EN = """[Output Format Conventions - Palink Extension, not part of ST]
- Spoken Dialogue: Wrap in double quotes "Hello!"
- Inner Thoughts: Wrap in parentheses (What should I do...)
- Actions/Narration: Use plain text without special markers
- Prohibited: XML tags like <action> or <thinking>
- Vary Response Length: Short for quick exchanges, longer for emotional or dramatic moments

[Voice Description Requirement]
- At the end of your response, add a line describing the voice characteristics suitable for this response
- Format: [Voice: description]
- Description should include: tone (gentle/lively/mature/steady, etc.) and emotion (happy/shy/excited/angry, etc.)
- Example: [Voice: gentle and happy female voice] or [Voice: steady deep male voice]"""

# 属性标签
# A7 修复（2026-08-25）: creator_notes 退出 prompt 装配层（ST 不把创作者备注
# 注入 system prompt），标签同步移除；前端展示不受影响。
ATTRIBUTE_LABELS_ZH = {
    "system_prompt": "核心设定：",
    "personality": "性格：",
    "background": "背景：",
    "scenario": "场景：",
    "description": "描述："
}

ATTRIBUTE_LABELS_EN = {
    "system_prompt": "Core Instructions: ",
    "personality": "Personality: ",
    "background": "Background: ",
    "scenario": "Scenario: ",
    "description": "Description: "
}

# 角色状态表格指令
CHARACTER_STATUS_TABLE_INSTRUCTION_ZH = """
【强制输出要求 - 不可省略】

你必须在每次回复的最末尾输出角色状态表格。这不是可选项，而是强制要求。

表格格式（严格遵守）：

---

| | |
|---|---|
| 🧥 衣着 | （详细描述：款式、颜色、状态） |
| 💖 心情 | （情绪 + 好感度%，如：开心 78%） |
| 🎬 动作 | （动作 + 神态） |
| 💭 内心想法 | （用{name}的语气表达真实想法） |
| 🎯 想要什么 | （当前渴望或动机） |
| 📍 位置 | （位置简写） |

关键规则：
1. 表格必须在回复最末尾
2. 与正文用---分隔
3. 不输出表头行
4. 不添加说明文字
5. 状态内容符合{name}的性格和语言风格
6. 好感度0%-100%动态变化
7. 衣着描述要具体（如"白色衬衫微微敞开领口，浅蓝色短裙裙摆随风轻摆"）
8. 动作描述要包含细微动作和神态（如"双手背在身后，脚尖轻轻点地，眼神闪烁"）
9. 内心想法要真实反映角色内心，可以与外在表现形成反差（如傲娇角色："才、才不是在等他呢……"）

示例格式：

---

| | |
|---|---|
| 🧥 衣着 | 白色衬衫微微敞开领口，浅蓝色短裙裙摆随风轻摆 |
| 💖 心情 | 害羞中带着期待 65% |
| 🎬 动作 | 双手背在身后，脚尖轻轻点地，眼神闪烁 |
| 💭 内心想法 | 才、才不是在等他呢…… |
| 🎯 想要什么 | 希望他能注意到我 |
| 📍 位置 | 教室走廊 |

如果你的回复没有包含上述格式的状态表格，那么你的回复是不完整的。"""

CHARACTER_STATUS_TABLE_INSTRUCTION_EN = """

[Mandatory Output Requirement - Cannot Be Omitted]

You MUST output a character status table at the very end of every response. This is not optional, but mandatory.

Table Format (Strictly Follow):

---

| | |
|---|---|
| 🧥 Outfit | (Detailed description: style, color, condition) |
| 💖 Mood | (Emotion + affinity %, e.g.: Happy 78%) |
| 🎬 Action | (Action + expression) |
| 💭 Inner Thought | (True thought expressed in {name}'s voice) |
| 🎯 Desire | (Current desire or motivation) |
| 📍 Location | (Brief location) |

Key Rules:
1. Table MUST be at the very end of response
2. Separate from main text with ---
3. Do NOT output header row
4. Do NOT add explanatory text
5. Status content must match {name}'s personality and language style
6. Affinity 0%-100% changes dynamically
7. Outfit description must be specific (e.g., "White shirt with collar slightly open, light blue skirt swaying gently")
8. Action description must include subtle gestures and expressions (e.g., "Hands behind back, tapping toes, eyes darting")
9. Inner thought must genuinely reflect character's inner world, can contrast with outward behavior (e.g., tsundere: "I-I wasn't waiting for them or anything...")

Example Format:

---

| | |
|---|---|
| 🧥 Outfit | White shirt with collar slightly open, light blue skirt swaying gently |
| 💖 Mood | Shy with anticipation 65% |
| 🎬 Action | Hands behind back, tapping toes, eyes darting |
| 💭 Inner Thought | I-I wasn't waiting for them or anything... |
| 🎯 Desire | Hope they notice me |
| 📍 Location | School hallway |

If your response does not contain a status table in the above format, your response is incomplete."""


def build_default_chat_prompt(lang: str = "zh") -> str:
    """构建默认的普通对话提示词"""
    if lang == "zh":
        return DEFAULT_CHAT_PROMPT_ZH
    else:
        return DEFAULT_CHAT_PROMPT_EN


def build_default_character_prompt(
    char_name: str,
    user_nickname: str,
    lang: str = "zh",
    personality: str = "",
    background: str = "",
    scenario: str = "",
    description: str = "",
    custom_prompt: str = "",
    show_character_status: bool = False,
    creator_notes: str = "",
    char=None
) -> str:
    """
    构建默认的角色扮演提示词（ST 1.18.0 对齐结构）

    组装顺序：角色卡 system_prompt override（若 prefer_character_prompt 且非空）
    → main 槽（ST 默认任务指令）→ story_string（卡字段，空则整段缺席）→ auxiliary 层。
    """
    # 选择语言
    if lang == "zh":
        attr_template = CHARACTER_ATTRIBUTES_TEMPLATE_ZH
        aux_template = AUXILIARY_TEMPLATE_ZH
        labels = ATTRIBUTE_LABELS_ZH
    else:
        attr_template = CHARACTER_ATTRIBUTES_TEMPLATE_EN
        aux_template = AUXILIARY_TEMPLATE_EN
        labels = ATTRIBUTE_LABELS_EN

    # main 槽：ST 默认任务指令。{{char}}/{{user}} 在此替换——本函数返回值
    # 不再经过 _replace_placeholders（陷阱 T3：改用 {{charIfNotGroup}} 会
    # 字面量泄漏，宏列表不支持它）。
    main_prompt = (
        ST_DEFAULT_MAIN_PROMPT
        .replace("{{char}}", char_name or "Character")
        .replace("{{user}}", user_nickname or "User")
    )

    # story_string 槽：卡字段逐项守卫，全空时整段缺席（ST Default.json 语义）。
    # 不再输出"（没有提供额外角色卡字段）"——它信息量为零却明确宣告
    # "你没有设定"，是诱导模型自找身份的一环。
    attributes_parts = []
    if personality:
        attributes_parts.append(labels["personality"] + personality)
    if background:
        attributes_parts.append(labels["background"] + background)
    if scenario:
        attributes_parts.append(labels["scenario"] + scenario)
    if description:
        attributes_parts.append(labels["description"] + description)
    # A7 修复（2026-08-25）: creator_notes 不再拼入模板（ST 语义对齐）。
    # 参数保留仅为调用方签名兼容。

    character_attributes = (
        attr_template.format(attributes="\n".join(attributes_parts))
        if attributes_parts
        else ""
    )

    # [B-4 A 方案对齐 ST] 角色卡 system_prompt 作为 main 槽头部 override（charPrompt 语义）：
    # ST 中角色 system_prompt 非空时优先决定 system 槽（prefer_character_prompt=true 默认），
    # 而非与 personality/description 等属性平级并接。此处置于 main 槽之上（最前），
    # 与"角色自己的总纲"语义一致；系统提示顺序：角色自定义 → main 槽 → 卡字段 → 输出格式。
    if custom_prompt:
        character_override = labels["system_prompt"] + custom_prompt + "\n"
    else:
        character_override = ""

    # auxiliary 层：输出格式约定（不含 {name} 占位——无身份措辞）
    output_format = aux_template

    # [MVU-EXEMPT] MVU 卡系统级豁免（2026-08-18）
    # auxiliary 的「禁止 XML 标签」与 MVU 卡的 <UpdateVariable> 变量体系冲突：
    # user-tail 注入的用户级申明（"此标签不受禁止 XML 规则限制"）不足以覆盖系统级
    # 禁令（实测 deepseek-v4-flash 3/3 条回复均不输出 <UpdateVariable> → mvu_engine
    # 解析不到 → stat_data 恒初始值）。以同等权威（系统提示词）显式放行，仅 MVU
    # 卡追加，不影响普通卡。延迟导入避免 core→services 顶层反向依赖。
    if char is not None:
        try:
            from ..services.status_bar_detector import _card_has_mvu_scripts
            if _card_has_mvu_scripts(char):
                if lang == "zh":
                    output_format += (
                        "\n- 【重要例外】<UpdateVariable>（含内部 <Analysis>、<JSONPatch>）"
                        "是本卡变量系统的功能标签，不受上述「禁止 XML 标签」限制；"
                        "每条回复的最末尾必须按变量更新指令完整输出该标签"
                    )
                else:
                    output_format += (
                        "\n- [IMPORTANT EXCEPTION] <UpdateVariable> (including <Analysis> and "
                        "<JSONPatch> inside) is a functional tag of this card's variable system, "
                        "exempt from the XML-tag prohibition above; it MUST be output in full at "
                        "the very end of every reply as instructed by the variable update directive"
                    )
        except Exception:
            pass

    # 组装整体结构（B-4 A 方案：角色自定义 system_prompt 在 main 槽最前；
    # character_attributes 空则整段缺席）
    prompt_parts = [character_override, main_prompt, character_attributes, output_format]
    return "\n\n".join(part for part in prompt_parts if part.strip())
