from datetime import datetime, timezone
from sqlalchemy import Column, Integer, String, Boolean, BigInteger, Float, DateTime, ForeignKey, Text
from sqlalchemy.orm import relationship
from .base import Base

def utc_now():
    return datetime.now(timezone.utc)

class SystemSetting(Base):
    __tablename__ = "settings"
    key = Column(String, primary_key=True)
    value = Column(String)

class UserSetting(Base):
    __tablename__ = "user_settings"
    id = Column(Integer, primary_key=True, index=True)
    user_id = Column(Integer, ForeignKey("users.id"), unique=True)
    show_model_reasoning = Column(Boolean, default=True)
    developer_mode = Column(Boolean, default=False)
    memory_mode = Column(String, default="rule")
    memory_model = Column(String, nullable=True)
    prompt_language = Column(String, default="auto")
    character_display_mode = Column(String, default="framed")
    author_note = Column(Text, nullable=True)
    # ST 1.18.0 author note position — mirrors extension_prompt_types (script.js):
    #   -1 = NONE          (skip injection)
    #    0 = IN_PROMPT      (after post-history; appended to system prompt end)
    #    1 = IN_CHAT        (in-chat at depth via author_note_depth)
    #    2 = BEFORE_PROMPT  (before story string; prepended to system prompt start)
    # Default 1 = IN_CHAT, matching ST DEFAULT_POSITION (authors-note.js).
    # (Migration 0056 converted legacy Palink values 0-4 to this ST-aligned set.)
    author_note_position = Column(Integer, default=1)
    author_note_frequency = Column(Integer, default=0)
    # ST 1.18.0 depth insertion depth when position == 1 (IN_CHAT).
    author_note_depth = Column(Integer, default=4)
    # ST 1.18.0 用户全局 jailbreak（对应 ST 主界面 Jailbreak 框），
    # 与 power_user JSON 中的 jailbreak 同步。NULL 表示未设置。
    jailbreak = Column(Text, nullable=True)
    # Custom prompts
    custom_chat_prompt_zh = Column(Text, nullable=True)
    custom_chat_prompt_en = Column(Text, nullable=True)
    custom_character_prompt_zh = Column(Text, nullable=True)
    custom_character_prompt_en = Column(Text, nullable=True)
    use_custom_prompts = Column(Boolean, default=False)
    show_character_status = Column(Boolean, default=False)
    auto_generate_chat_images = Column(Boolean, default=False)
    silly_tavern_mode = Column(String, default="palink-native")
    silly_tavern_theme = Column(String, default="palink")
    silly_tavern_settings = Column(Text, nullable=True)
    # Active persona id (references Persona.id) — drives persona description
    # injection in roleplay prompt assembly. NULL means no active persona.
    active_persona_id = Column(String, nullable=True)
    # ST 1.18.0 power_user persistence — JSON string storing the full
    # power_user object (font_size / message_style / reduce_motion /
    # auto_scroll / avatar_style / chat_display_name / trim_spaces /
    # collapse_newlines etc.). NULL falls back to hardcoded defaults.
    power_user = Column(Text, nullable=True)
    # ST 1.18.0 UI-specific settings — JSON string for additional UI
    # preferences (panel collapsed states, sidebar width, etc.).
    # Separate from power_user. NULL falls back to empty "{}".
    ui_settings = Column(Text, nullable=True)
    # Instruct mode — when True, assembled messages are wrapped with the
    # bound InstructTemplate's prefix/suffix sequences at prompt-assembly time.
    # instruct_template_id references InstructTemplate.id (NULL = no template).
    instruct_enabled = Column(Boolean, default=False)
    instruct_template_id = Column(Integer, nullable=True)
    user = relationship("User", back_populates="settings")

class GenerationPreset(Base):
    __tablename__ = "generation_presets"
    id = Column(Integer, primary_key=True, index=True)
    user_id = Column(Integer, ForeignKey("users.id"), nullable=True)
    name = Column(String, nullable=False)
    is_default = Column(Boolean, default=False)
    activation_regex = Column(String, nullable=True)
    temperature = Column(Float, default=0.7)
    top_p = Column(Float, default=0.95)
    max_tokens = Column(Integer, default=1024)
    frequency_penalty = Column(Float, default=0.0)
    presence_penalty = Column(Float, default=0.0)
    min_p = Column(Float, default=0.05)
    top_k = Column(Integer, default=40)
    repetition_penalty = Column(Float, default=1.1)
    system_prompt_override = Column(Text, nullable=True)
    post_history_instructions = Column(Text, nullable=True)
    prompts_data = Column(Text, nullable=True)
    # ST 1.18.0 logit_bias / ban_sequences — stored as JSON strings (Text column)
    # ban_sequences: JSON array of strings, each string is a token sequence to ban
    # logit_bias: JSON object {token_id: bias_value}, bias in [-100, 100]
    ban_sequences = Column(Text, nullable=True)
    logit_bias = Column(Text, nullable=True)
    # ST 1.18.0 context template binding — name of ContextTemplate to apply
    # when assembling messages for this preset. NULL/empty falls back to "Default".
    context_template_name = Column(String, nullable=True)
    created_at = Column(DateTime, default=utc_now)
    updated_at = Column(DateTime, default=utc_now, onupdate=utc_now)


class ContextTemplate(Base):
    """ST 1.18.0 context template — defines how chat messages are assembled.

    Mirrors the subset of SillyTavern's context template configuration that
    Palink uses for prompt assembly. The `story_string` field is the system
    prompt assembly template and may contain placeholders such as
    `{{description}}`, `{{personality}}`, `{{scenario}}`, `{{char}}`, `{{user}}`.
    """
    __tablename__ = "context_templates"
    id = Column(Integer, primary_key=True, index=True)
    name = Column(String, nullable=False, unique=True, index=True)
    display_name = Column(String, nullable=True)
    # System prompt assembly template (placeholders replaced at runtime).
    story_string = Column(Text, nullable=True)
    # Marker inserted at the start of the chat history block.
    chat_start = Column(String, nullable=True)
    # Optional prefix prepended to the assembled system prompt.
    system_prompt = Column(String, nullable=True)
    # Optional jailbreak prompt appended after the system prompt.
    jailbreak = Column(String, nullable=True)
    # Default user-side prompt template.
    normal_prompt = Column(String, nullable=True)
    # Group chat prompt template.
    group_prompt = Column(String, nullable=True)
    # Built-in templates cannot be deleted by users.
    is_builtin = Column(Boolean, default=True, nullable=False)
    created_at = Column(DateTime, default=utc_now)
    updated_at = Column(DateTime, default=utc_now, onupdate=utc_now)


class ProviderTestResult(Base):
    __tablename__ = "provider_test_results"
    id = Column(Integer, primary_key=True, index=True)
    provider_id = Column(String, nullable=False)
    provider_name = Column(String, nullable=False)
    success = Column(Boolean, nullable=False)
    message = Column(String, nullable=True)
    base_url = Column(String, nullable=True)
    tested_at = Column(DateTime, default=utc_now)
    user_id = Column(Integer, ForeignKey("users.id"), nullable=True)


class InstructTemplate(Base):
    """ST 1.18.0 instruct template — defines how chat messages are wrapped
    with prefix/suffix sequences for instruct-style (text-completion) models.

    When instruct mode is enabled on a user's settings, the roleplay prompt
    assembly wraps each assembled message with the matching prefix/suffix:
    system messages use system_sequence_prefix/suffix, user messages use
    input_prefix/suffix, assistant messages use output_prefix/suffix. The
    stop_sequence is exposed so callers can pass it to the model endpoint.

    user_id NULL rows are system-preset templates shared across users and
    cannot be deleted (only updated). User-defined templates are scoped to
    the owning user.

    ST 1.18.0 alignment (Task 3.6):
      - ``skip_examples``: when True, dialogue examples are NOT wrapped with
        instruct sequences (ST 1.18.0 ``instruct.skip_examples``).
      - ``names_behavior``: replaces the obsolete ``names`` /
        ``names_force_groups`` pair. Values: 'none' / 'force' / 'always'.
        'force' preserves the legacy group-chat name injection behavior.
      - ``system_sequence`` / ``system_suffix``: ST 1.18.0 names for the
        system message prefix/suffix. When empty, the assembly falls back to
        the legacy ``system_sequence_prefix`` / ``system_sequence_suffix``
        (kept for backward compat with pre-existing seeds).
      - ``last_system_sequence``: sequence used for the final system message.
      - ``first_input_sequence`` / ``last_input_sequence``: first/last user
        input prefixes (fall back to ``input_prefix`` when empty).
      - ``user_alignment_message``: appended after the last output sequence.
      - ``story_string_prefix`` / ``story_string_suffix``: wrap the story
        string (system prompt) when it is not in-chat position.
      - ``macro``: when True, instruct sequences are macro-evaluated before
        being applied (ST 1.18.0 ``instruct.macro``).
      - ``system_same_as_user``: when True, narrator/system messages use the
        user input prefix/suffix instead of the dedicated system sequences.
      - ``sequences_as_stop_strings``: when True, non-empty instruct
        sequences are added to the stop strings passed to the model.
    """
    __tablename__ = "instruct_templates"
    id = Column(Integer, primary_key=True, index=True)
    user_id = Column(Integer, ForeignKey("users.id"), nullable=True)  # null = 系统预置
    name = Column(String, nullable=False)
    system_prompt = Column(Text, default="")
    input_prefix = Column(String, default="")
    input_suffix = Column(String, default="")
    output_prefix = Column(String, default="")
    output_suffix = Column(String, default="")
    first_output_prefix = Column(String, default="")
    last_output_prefix = Column(String, default="")
    # Legacy system message prefix/suffix (pre-ST 1.18.0 names). Kept for
    # backward compat with existing seeds; ``system_sequence`` /
    # ``system_suffix`` below are the ST 1.18.0 preferred fields.
    system_sequence_prefix = Column(String, default="")
    system_sequence_suffix = Column(String, default="")
    # ST 1.18.0 preferred system message prefix/suffix. When non-empty,
    # these take priority over the legacy fields above.
    system_sequence = Column(String, default="")
    system_suffix = Column(String, default="")
    # ST 1.18.0 last system message sequence (used for the final system
    # message in a generation, falls back to output_sequence when empty).
    last_system_sequence = Column(String, default="")
    # ST 1.18.0 first/last user input prefixes (fall back to input_prefix
    # when empty, matching ST's ``instruct.first_input_sequence``).
    first_input_sequence = Column(String, default="")
    last_input_sequence = Column(String, default="")
    # ST 1.18.0 user alignment message appended after the last output
    # sequence.
    user_alignment_message = Column(String, default="")
    # ST 1.18.0 story string prefix/suffix (wrap the system prompt when it
    # is not in-chat position).
    story_string_prefix = Column(String, default="")
    story_string_suffix = Column(String, default="")
    stop_sequence = Column(String, default="")
    separator_sequence = Column(String, default="")
    wrap_sequences = Column(Boolean, default=False)
    # ST 1.18.0 Task 3.6.2: when True, dialogue examples (mes_example) are
    # NOT wrapped with instruct sequences (returned as plain text).
    skip_examples = Column(Boolean, default=False)
    # ST 1.18.0 Task 3.6.3: names_behavior replaces names_force_for_groups.
    # 'none' = never include names; 'force' = include names in group chat
    # and for example_user; 'always' = always include names.
    names_behavior = Column(String, default="force")
    # ST 1.18.0: when True, instruct sequences are macro-evaluated before
    # being applied (substituteParams with name1/name2 overrides).
    macro = Column(Boolean, default=False)
    # ST 1.18.0: when True, narrator/system messages use the user input
    # prefix/suffix instead of the dedicated system_sequence/system_suffix.
    system_same_as_user = Column(Boolean, default=False)
    # ST 1.18.0: when True, non-empty instruct sequences are added to the
    # stop strings passed to the model endpoint.
    sequences_as_stop_strings = Column(Boolean, default=True)
    is_default = Column(Boolean, default=False)
    created_at = Column(DateTime, default=utc_now)


class ConnectionProfile(Base):
    """用户级 API 连接配置 —— 加密存储 API Key，支持自定义端点与模型映射。

    每个用户可拥有多个 profile，其中至多一个 is_active=True（当前激活）。
    推理路径优先使用激活 profile 的解密凭证，回退到全局 providers.json。
    """
    __tablename__ = "connection_profiles"
    id = Column(Integer, primary_key=True, index=True)
    user_id = Column(Integer, ForeignKey("users.id"), nullable=False)
    name = Column(String, nullable=False)  # 配置名，如 "OpenAI 主账号"
    provider = Column(String, nullable=False)  # openai/claude/google/mistral/custom
    api_key_encrypted = Column(Text, nullable=True)  # Fernet 加密后的 API Key
    base_url = Column(String, nullable=True)  # 自定义 API 端点
    model_mapping = Column(Text, default="{}")  # JSON，模型名映射
    is_active = Column(Boolean, default=False)  # 当前激活的 profile
    created_at = Column(DateTime, default=utc_now)
    updated_at = Column(DateTime, default=utc_now, onupdate=utc_now)


class Theme(Base):
    """主题配置 —— 支持系统预置 (user_id is NULL) 与用户自定义主题。

    config_json 存储 JSON 主题配置（颜色、字体、间距等），is_active 标记
    当前激活主题。每个用户至多一个 is_active=True 的主题。
    """
    __tablename__ = "themes"
    id = Column(Integer, primary_key=True, index=True)
    user_id = Column(Integer, ForeignKey("users.id"), nullable=True)  # null = 系统预置
    name = Column(String, nullable=False)
    config_json = Column(Text, default="{}")  # JSON 主题配置
    is_active = Column(Boolean, default=False)
    created_at = Column(DateTime, default=utc_now)
