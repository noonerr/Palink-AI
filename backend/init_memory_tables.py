"""
初始化记忆模块数据库表
"""
import os
import sys

# 添加 app 到路径
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from sqlalchemy import create_engine, text
from sqlalchemy.orm import sessionmaker

# 数据库连接
DATABASE_URL = os.getenv(
    "DATABASE_URL",
    "postgresql://postgres:postgres@db:5432/palink"
)

def init_memory_tables():
    """创建记忆模块所需的表"""
    engine = create_engine(DATABASE_URL)
    
    with engine.connect() as conn:
        # 创建 pgvector 扩展
        conn.execute(text("CREATE EXTENSION IF NOT EXISTS vector"))
        conn.commit()
        print("✅ pgvector 扩展已创建")
        
        # 创建对话记忆表
        conn.execute(text("""
            CREATE TABLE IF NOT EXISTS conversation_memories (
                id SERIAL PRIMARY KEY,
                user_id INTEGER REFERENCES users(id),
                session_id VARCHAR REFERENCES sessions(id),
                role VARCHAR NOT NULL,
                content TEXT NOT NULL,
                content_summary TEXT,
                embedding vector(384),
                importance_score FLOAT DEFAULT 0.5,
                topics JSONB DEFAULT '[]',
                tokens_count INTEGER DEFAULT 0,
                created_at TIMESTAMP DEFAULT NOW()
            )
        """))
        conn.commit()
        print("✅ conversation_memories 表已创建")
        
        # 创建索引
        conn.execute(text("CREATE INDEX IF NOT EXISTS idx_memory_user_id ON conversation_memories(user_id)"))
        conn.execute(text("CREATE INDEX IF NOT EXISTS idx_memory_session_id ON conversation_memories(session_id)"))
        conn.execute(text("CREATE INDEX IF NOT EXISTS idx_memory_created_at ON conversation_memories(created_at)"))
        conn.commit()
        print("✅ 记忆表索引已创建")
        
        # 创建用户画像表
        conn.execute(text("""
            CREATE TABLE IF NOT EXISTS user_profiles (
                id SERIAL PRIMARY KEY,
                user_id INTEGER UNIQUE REFERENCES users(id),
                preferences JSONB DEFAULT '{}',
                goals JSONB DEFAULT '[]',
                common_topics JSONB DEFAULT '[]',
                communication_style VARCHAR,
                summary TEXT,
                total_conversations INTEGER DEFAULT 0,
                total_messages INTEGER DEFAULT 0,
                updated_at TIMESTAMP DEFAULT NOW()
            )
        """))
        conn.commit()
        print("✅ user_profiles 表已创建")
        
        # 创建画像表索引
        conn.execute(text("CREATE INDEX IF NOT EXISTS idx_profile_user_id ON user_profiles(user_id)"))
        conn.commit()
        print("✅ 画像表索引已创建")
        
    print("\n🎉 记忆模块数据库初始化完成！")

if __name__ == "__main__":
    init_memory_tables()
