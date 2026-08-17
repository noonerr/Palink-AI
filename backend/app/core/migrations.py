import logging
import os

from alembic import command
from alembic.config import Config
import sqlalchemy as sa
from sqlalchemy.schema import CreateColumn

logger = logging.getLogger(__name__)


_RUNTIME_COMPAT_COLUMNS = (
    ("user_settings", "auto_generate_chat_images", sa.Boolean()),
    ("user_settings", "silly_tavern_mode", sa.String()),
    ("user_settings", "silly_tavern_theme", sa.String()),
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
