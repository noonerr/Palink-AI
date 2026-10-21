from typing import Optional
from pydantic import BaseModel

class UserUpdate(BaseModel):
    avatar: Optional[str] = None
    username: Optional[str] = None

class ChangePassword(BaseModel):
    old_password: str
    new_password: str

class UserSettingUpdate(BaseModel):
    show_model_reasoning: Optional[bool] = None
    developer_mode: Optional[bool] = None
    memory_mode: Optional[str] = None
    memory_model: Optional[str] = None
    prompt_language: Optional[str] = None
    character_display_mode: Optional[str] = None
    author_note: Optional[str] = None
    # ST 1.18.0 author note position —— 取值与 ST extension_prompt_types 一致
    # （public/script.js:483-488，参照树 d:/SillyTavern-release）：
    #   -1 = NONE          （不注入）
    #    0 = IN_PROMPT      （After Main Prompt / Story String，追加到 system 末尾）
    #    1 = IN_CHAT        （In-chat @ Depth，按 author_note_depth 插入历史；ST 默认）
    #    2 = BEFORE_PROMPT  （Before Main Prompt / Story String，前插到 system 开头）
    # 〔2026-10-21 批次UI1 订正〕旧注释写的 "0=in story / 1=after post-history /
    # 2=last in chat / 3=inactive" 是迁移 0056 之前的**旧 Palink 值域**，与 ST 源码、
    # models/system.py:27-33 及装配读取（roleplay_prompt_assembly.py:3546-3564）均不一致；
    # 列里现存的已是 0056 转换后的 ST 对齐值，以本节为准。
    author_note_position: Optional[int] = None
    # ST 1.18.0 Insertion Frequency：0 = 停用、1 = 每条（index.html:7775-7779）。
    # ⚠️ 本仓装配（roleplay_prompt_assembly.py:3606-3619）把 0 与 1 都视为"每条"
    # （0 是历史默认值，改语义会改变存量用户行为），停用请用 position=-1。
    author_note_frequency: Optional[int] = None
    # ST 1.18.0 In-chat @ Depth 的深度（仅 position==1 时生效；ST 默认 4）。
    author_note_depth: Optional[int] = None
    # ST 1.18.0 用户全局破甲（主界面 Jailbreak 框），对应 UserSetting.jailbreak。
    # 空串 = 显式清空 = 不注入（装配侧 strip 后为空即跳过）；None = PUT 不改。
    # 优先级：卡片 jailbreak > 上下文模板 jailbreak > 本字段
    # （character_message_builder.py:342-374；ST openai.js:1496-1504）。
    jailbreak: Optional[str] = None
    custom_chat_prompt_zh: Optional[str] = None
    custom_chat_prompt_en: Optional[str] = None
    custom_character_prompt_zh: Optional[str] = None
    custom_character_prompt_en: Optional[str] = None
    use_custom_prompts: Optional[bool] = None
    show_character_status: Optional[bool] = None
    auto_generate_chat_images: Optional[bool] = None
    # silly_tavern_mode/silly_tavern_theme 已于 2026-09-04 A1 删除（alembic 0062）；
    # PUT 请求体携带这两个键时被 pydantic 忽略，不再落库。
    # Active persona id (references Persona.id). NULL clears the active persona.
    active_persona_id: Optional[str] = None
    # ST 1.18.0 power_user persistence (JSON string of full power_user object).
    power_user: Optional[str] = None
    # MVU 副 AI 变量更新（2026-08-19）：副模型 ID（空=不启用）+ 开关。
    mvu_secondary_model: Optional[str] = None
    mvu_secondary_enabled: Optional[bool] = None
    # [MVU-SECONDARY-PARAMS 2026-10-05] 副模型采样参数 + 重试次数。
    # None = 不改（PUT）/ 用代码内默认（GET 读模型列）。写入侧做防呆夹紧：
    # temperature 0-2 / max_tokens 256-8192 / retries 0-3。
    mvu_secondary_temperature: Optional[float] = None
    mvu_secondary_max_tokens: Optional[int] = None
    mvu_secondary_retries: Optional[int] = None
    # 分层记忆 Phase 1：记忆区注入预算档位（0-3，None=不改）。
    memory_budget_level: Optional[int] = None

class PasswordReset(BaseModel):
    new_password: str
