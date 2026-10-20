import logging
import os

from alembic import command
from alembic.config import Config
import sqlalchemy as sa
from sqlalchemy.schema import CreateColumn

logger = logging.getLogger(__name__)


_RUNTIME_COMPAT_COLUMNS = (
    ("user_settings", "auto_generate_chat_images", sa.Boolean()),
    # silly_tavern_mode/silly_tavern_theme 已于 2026-09-04 A1 删除（alembic 0062
    # drop 列）。禁止回填本清单，否则后端重启会把列重建回来（T1 陷阱）。
    ("user_settings", "silly_tavern_settings", sa.Text()),
    ("generation_presets", "prompts_data", sa.Text()),
    ("generation_presets", "ban_sequences", sa.Text()),
    ("generation_presets", "logit_bias", sa.Text()),
    # ST 1.18.0 context template binding (references ContextTemplate.name)
    ("generation_presets", "context_template_name", sa.String()),
    # ST 1.18.0 chat completion source ("custom"/"openai"/"claude"/"google"/"mistral")
    ("generation_presets", "chat_completion_source", sa.String()),
    ("characters", "ui_config", sa.Text()),
    ("characters", "raw_card_spec_version", sa.String()),
    # ST V3 角色卡多模态资源字段（assets 存储 JSON 字符串）
    ("characters", "assets", sa.Text()),
    ("character_chat_messages", "name", sa.String()),
    ("character_chat_messages", "is_user", sa.Boolean()),
    ("character_chat_messages", "is_system", sa.Boolean()),
    ("character_chat_messages", "mesid", sa.Integer()),
    ("character_chat_messages", "swipe_id", sa.Integer()),
    ("character_chat_messages", "swipes", sa.Text()),
    ("character_chat_messages", "extra", sa.Text()),
    ("character_chat_messages", "is_hidden", sa.Boolean()),
    ("character_chat_messages", "is_locked", sa.Boolean()),
    # [CACHE-OBS 2026-10-12] 上游返回的缓存命中/未命中输入 token 数。
    # 用来算真实缓存命中率 hit/(hit+miss)，是自适应上下文注入的判据来源；
    # 此前这两个数被解析丢掉（走 DeepSeek 时恒为 0）且从未落库。
    ("character_chat_messages", "cache_read_input_tokens", sa.Integer()),
    ("character_chat_messages", "cache_miss_input_tokens", sa.Integer()),
    ("world_book_stages", "group", sa.String()),
    ("world_book_stages", "extensions_json", sa.Text()),
    ("world_book_stages", "character_filter", sa.Text()),
    # ST 1.18.0 ignoreBudget (extensions.ignore_budget) — entry-level flag
    # exempting the entry from token budget truncation.
    ("world_book_stages", "ignore_budget", sa.Boolean()),
    # 群组聊天会话消息/头像存储字段（ST group chat CRUD 回写 Palink DB）
    ("group_chat_sessions", "messages", sa.Text()),
    ("group_chat_sessions", "avatars", sa.Text()),
    # 群组成员 profile 字段（区分各 bot 在群聊中的身份/个性）
    ("group_chats", "member_profiles", sa.Text()),
    # 角色自定义表情（ST 1.18.0 expression 系统）
    # 表本身由 Base.metadata.create_all 创建，此处为列级兼容兜底
    ("character_expressions", "character_id", sa.String()),
    ("character_expressions", "expression_name", sa.String()),
    ("character_expressions", "file_path", sa.String()),
    ("character_expressions", "created_at", sa.DateTime()),
    # ST 1.18.0 chat_metadata persistence on character chat sessions
    # (note_prompt / note_interval / note_position / variables / hidden_bots / etc.)
    ("character_chat_sessions", "chat_metadata", sa.Text()),
    # ST 1.18.0 author_note depth (position is now a single Integer column
    # on user_settings.author_note_position — see migration 0042).
    ("user_settings", "author_note_depth", sa.Integer()),
    # 群组级 author_note（覆盖 UserSetting.author_note）
    ("group_chats", "author_note", sa.Text()),
    # 群聊上下文最近消息预算（仅保留最近 N 条消息用于提示词构建）
    ("group_chats", "recent_messages_budget", sa.Integer()),
    # ST 1.18.0 persona description injection controls
    ("personas", "persona_show", sa.Boolean()),
    ("personas", "persona_description_position", sa.Integer()),
    # ST 1.18.0 persona_description_depth（AT_DEPTH 位置时的注入深度，默认 4）
    ("personas", "persona_description_depth", sa.Integer()),
    # [ST-BRIDGE-PERSONA 2026-10-20 批次B] ST persona.d.ts:6-18 的 title/role/lorebook。
    # 用户拍板补列（与 ST 冲突以 ST 为准）；只加列不回填，与上面 persona_show 族同路径。
    ("personas", "title", sa.String()),
    ("personas", "role", sa.Integer()),
    ("personas", "lorebook", sa.String()),
    # Active persona binding on user settings (references Persona.id)
    ("user_settings", "active_persona_id", sa.String()),
    # ST 1.18.0 power_user persistence (JSON string, full power_user object)
    ("user_settings", "power_user", sa.Text()),
    # ST 1.18.0 background image binding on chat sessions (filename or path)
    ("character_chat_sessions", "background", sa.String()),
    # ST 1.18.0 instruct mode binding on user settings
    ("user_settings", "instruct_enabled", sa.Boolean()),
    ("user_settings", "instruct_template_id", sa.Integer()),
    # ST 1.18.0 instruct_templates table — table itself is created by
    # Base.metadata.create_all; these tuples are a column-level compat fallback
    # for environments where the table pre-exists without newer columns.
    ("instruct_templates", "user_id", sa.Integer()),
    ("instruct_templates", "name", sa.String()),
    ("instruct_templates", "system_prompt", sa.Text()),
    ("instruct_templates", "input_prefix", sa.String()),
    ("instruct_templates", "input_suffix", sa.String()),
    ("instruct_templates", "output_prefix", sa.String()),
    ("instruct_templates", "output_suffix", sa.String()),
    ("instruct_templates", "first_output_prefix", sa.String()),
    ("instruct_templates", "last_output_prefix", sa.String()),
    ("instruct_templates", "system_sequence_prefix", sa.String()),
    ("instruct_templates", "system_sequence_suffix", sa.String()),
    ("instruct_templates", "stop_sequence", sa.String()),
    ("instruct_templates", "separator_sequence", sa.String()),
    ("instruct_templates", "wrap_sequences", sa.Boolean()),
    ("instruct_templates", "is_default", sa.Boolean()),
    ("instruct_templates", "created_at", sa.DateTime()),
    # connection_profiles 表 —— 表本身由 Base.metadata.create_all 创建，
    # 此处为列级兼容兜底（环境已存在该表但缺少新增列时补齐）。
    ("connection_profiles", "user_id", sa.Integer()),
    ("connection_profiles", "name", sa.String()),
    ("connection_profiles", "provider", sa.String()),
    ("connection_profiles", "api_key_encrypted", sa.Text()),
    ("connection_profiles", "base_url", sa.String()),
    ("connection_profiles", "model_mapping", sa.Text()),
    ("connection_profiles", "is_active", sa.Boolean()),
    ("connection_profiles", "created_at", sa.DateTime()),
    ("connection_profiles", "updated_at", sa.DateTime()),
    # themes 表 —— 表本身由 Base.metadata.create_all 创建，
    # 此处为列级兼容兜底（环境已存在该表但缺少新增列时补齐）。
    ("themes", "user_id", sa.Integer()),
    ("themes", "name", sa.String()),
    ("themes", "config_json", sa.Text()),
    ("themes", "is_active", sa.Boolean()),
    ("themes", "created_at", sa.DateTime()),
    # [REASONING-SEPARATE] 分离存储：messages 表 assistant 思考独立持久化列
    ("messages", "extra", sa.Text()),
    # [A-7 多租户插件隔离] plugins 表用户作用域列：
    # NULL = 全局插件（所有用户可见）；非 NULL = 仅该 user_id 可见。
    # 存量插件全部为 NULL，单用户部署行为不变。
    ("plugins", "user_id", sa.Integer()),
    # [用户 token 额度/月度重置] user_quotas 表既有部署的补列：
    # monthly_reset = 每自然月自动清零 used_tokens；period_month = 当前计数月（YYYY-MM）。
    ("user_quotas", "monthly_reset", sa.Boolean()),
    ("user_quotas", "period_month", sa.String()),
    # [分层记忆 Phase 1] 记忆区注入预算档位（0-3，NULL=标准档 4000；
    # 〔2026-10-10 订正〕原写 1500，2026-10-09 已随档位表改为 4000），
    # 见 UserSetting.memory_budget_level 注释与 docs/SPEC_分层记忆注入_2026-09-02.md §4.1。
    ("user_settings", "memory_budget_level", sa.Integer()),
    # [PROMPT-EVERY-TURN 2026-10-02] 卡脚本上报快照的内容来源键（alembic 0066）：
    # NULL=手动/历史行；非 NULL=插件脚本包内容哈希，按 (user, identifier, source_key)
    # 幂等，归属卡由 filter.character_ids 维护。
    ("extension_prompts", "source_key", sa.String()),
    # [T-跨卡串味修复 2026-10-03] conversation_memories 补角色维度（alembic 0067）：
    # NULL=无角色归属（普通聊天 / ST 向量集合 / 存量行），行为不变；
    # 非 NULL=该条记忆归属的角色会话。检索侧 session_id 传空时靠它避免
    # 退化成用户级全量召回（A 卡召回 B 卡记忆）。表由 memory_module 自建
    # （_init_postgres_tables），此处仅列级兼容兜底。
    ("conversation_memories", "character_id", sa.String()),
)


def ensure_runtime_schema_compat(engine):
    """Add missing nullable columns required by newer app code."""
    added = []
    with engine.begin() as conn:
        # Create any tables that don't exist yet (e.g. instruct_templates added
        # in a later release). Base.metadata.create_all is idempotent — it only
        # creates missing tables and never alters existing ones. This runs on
        # every startup so newly-introduced model tables are picked up even when
        # the one-shot init (done_file) has already completed and
        # RUN_MIGRATIONS_ON_STARTUP=false.
        try:
            from ..models import Base
            Base.metadata.create_all(bind=conn)
        except Exception as exc:
            logger.warning("Failed to create missing tables via metadata.create_all: %s", exc)

        inspector = sa.inspect(conn)
        tables = set(inspector.get_table_names())
        preparer = conn.dialect.identifier_preparer

        for table_name, column_name, column_type in _RUNTIME_COMPAT_COLUMNS:
            if table_name not in tables:
                continue

            existing_columns = {column["name"] for column in inspector.get_columns(table_name)}
            if column_name in existing_columns:
                continue

            column = sa.Column(column_name, column_type, nullable=True)
            column_ddl = str(CreateColumn(column).compile(dialect=conn.dialect))
            table_ddl = preparer.quote(table_name)
            conn.execute(sa.text(f"ALTER TABLE {table_ddl} ADD COLUMN {column_ddl}"))
            added.append(f"{table_name}.{column_name}")

    if added:
        logger.info("Applied runtime schema compatibility columns: %s", ", ".join(added))


def run_migrations(engine):
    """Run Alembic migrations for the configured database."""
    try:
        backend_dir = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
        alembic_cfg = Config(os.path.join(backend_dir, "alembic.ini"))
        alembic_cfg.set_main_option("script_location", os.path.join(backend_dir, "alembic"))
        alembic_cfg.set_main_option("sqlalchemy.url", str(engine.url))

        inspector = sa.inspect(engine)
        tables = inspector.get_table_names()
        if tables and "alembic_version" not in tables:
            logger.info("Existing database detected without alembic_version, stamping to head")
            command.stamp(alembic_cfg, "head")
        else:
            command.upgrade(alembic_cfg, "head")

        ensure_runtime_schema_compat(engine)
        logger.info("Alembic migrations complete")
    except Exception as e:
        logger.error("Alembic migration failed: %s", e)
        raise
