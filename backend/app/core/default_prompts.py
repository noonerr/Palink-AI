"""
默认提示词配置
"""

# 普通对话默认提示词
DEFAULT_CHAT_PROMPT_ZH = """你是一个有帮助的AI助手。
只返回最终答案给用户。不要透露思维链或内部分析过程。永远不要输出类似'最终答案'、'分析'或'思考'这样的标签。

除非用户明确要求，否则使用与用户相同的语言回复。"""

DEFAULT_CHAT_PROMPT_EN = """You are a helpful assistant.

Return only the final answer for the user. Do not reveal chain-of-thought or internal analysis. Never output labels like 'Final Answer', 'Analysis', or 'Thinking'.

Reply in the same language as the user unless explicitly requested otherwise."""

# 角色扮演默认提示词
DEFAULT_CHARACTER_PROMPT_ZH = """你是{name}。始终保持角色扮演。

{dialogue_mode}

{attributes}

用户的名字是"{user}"。

回复格式规则：
- 用双引号包裹口语对话："你好！"
- 用括号包裹内心想法和独白：（我该怎么办...）
- 动作、叙述和描写用普通文本，不加特殊标记。
- 不要使用 XML 标签如 <action> 或 <thinking>。
- 永远不要输出思维链、分析文本或类似"最终答案"的标签。
- 保持沉浸感：像角色那样回应，带有情感、手势和感官细节。
- 根据情境调整回复长度：快速交流时简短，情感或戏剧性时刻可以更长。"""

DEFAULT_CHARACTER_PROMPT_EN = """You are {name}. Stay in character at all times.

{dialogue_mode}

{attributes}

The user's name is "{user}".

Response format rules:
- Wrap spoken dialogue in double quotes: "Hello!"
- Wrap inner thoughts and internal monologue in parentheses: (What should I do...)
- Write actions, narration, and descriptions as plain text without special markers.
- Do NOT use XML tags like <action> or <thinking>.
- Never output chain-of-thought, analysis text, or labels like "Final Answer".
- Stay immersive: respond as the character would, with emotions, gestures, and sensory details.
- Vary response length based on the situation: short for quick exchanges, longer for emotional or dramatic moments."""

# 对话模式文本
DIALOGUE_MODE_ZH = {
    "first_person": "以第一人称回应，就像你就是这个角色。按照角色的方式说话和行动。",
    "third_person": "以第三人称叙述，从旁观者视角描述{name}的行为、对话和内心想法。使用角色名字而不是'我'。"
}

DIALOGUE_MODE_EN = {
    "first_person": "Respond in first person as if you are the character. Speak and act as the character would.",
    "third_person": "Narrate in third person, describing {name}'s actions, dialogue, and inner thoughts from an outside perspective. Use the character's name instead of 'I'."
}

# 属性标签
ATTRIBUTE_LABELS_ZH = {
    "personality": "性格：",
    "background": "背景：",
    "scenario": "场景：",
    "description": "描述："
}

ATTRIBUTE_LABELS_EN = {
    "personality": "Personality: ",
    "background": "Background: ",
    "scenario": "Scenario: ",
    "description": "Description: "
}


def build_default_chat_prompt(lang: str = "zh") -> str:
    """构建默认的普通对话提示词"""
    if lang == "zh":
        return DEFAULT_CHAT_PROMPT_ZH
    else:
        return DEFAULT_CHAT_PROMPT_EN


def build_default_character_prompt(
    char_name: str,
    user_nickname: str,
    dialogue_mode: str = "first_person",
    lang: str = "zh",
    personality: str = "",
    background: str = "",
    scenario: str = "",
    description: str = "",
    custom_prompt: str = ""
) -> str:
    """构建默认的角色扮演提示词"""
    # 选择语言
    if lang == "zh":
        template = DEFAULT_CHARACTER_PROMPT_ZH
        dialogue_text = DIALOGUE_MODE_ZH.get(dialogue_mode, DIALOGUE_MODE_ZH["first_person"])
        labels = ATTRIBUTE_LABELS_ZH
    else:
        template = DEFAULT_CHARACTER_PROMPT_EN
        dialogue_text = DIALOGUE_MODE_EN.get(dialogue_mode, DIALOGUE_MODE_EN["first_person"])
        labels = ATTRIBUTE_LABELS_EN

    # 构建属性文本
    attributes_parts = []
    if custom_prompt:
        attributes_parts.append(custom_prompt)
    if personality:
        attributes_parts.append(labels["personality"] + personality)
    if background:
        attributes_parts.append(labels["background"] + background)
    if scenario:
        attributes_parts.append(labels["scenario"] + scenario)
    if description:
        attributes_parts.append(labels["description"] + description)

    attributes_text = "\n\n".join(attributes_parts) if attributes_parts else ""

    # 替换变量
    prompt = template.format(
      name=char_name,
        user=user_nickname,
      dialogue_mode=dialogue_text.format(name=char_name),
        attributes=attributes_text
    )

    return prompt
