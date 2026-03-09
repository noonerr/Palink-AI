from sqlalchemy import text

def run_migrations(engine):
    """运行数据库迁移"""
    with engine.connect() as conn:
        # 添加缺失的列
        try:
            conn.execute(text("ALTER TABLE sessions ADD COLUMN type TEXT DEFAULT 'chat'"))
            conn.commit()
        except:
            pass
        
        try:
            conn.execute(text("ALTER TABLE user_files ADD COLUMN summary TEXT"))
            conn.commit()
        except:
            pass
        
        try:
            conn.execute(text("ALTER TABLE characters ADD COLUMN scenario TEXT"))
            conn.commit()
        except:
            pass
        
        try:
            conn.execute(text("ALTER TABLE characters ADD COLUMN first_mes TEXT"))
            conn.commit()
        except:
            pass
        
        try:
            conn.execute(text("ALTER TABLE characters ADD COLUMN mes_example TEXT"))
            conn.commit()
        except:
            pass
        
        try:
            conn.execute(text("ALTER TABLE characters ADD COLUMN system_prompt TEXT"))
            conn.commit()
        except:
            pass
