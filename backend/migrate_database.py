import sqlite3
import os

DATA_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "data")
DB_PATH = os.path.join(DATA_DIR, "palink.db")

def migrate_database():
    print(f"正在连接数据库: {DB_PATH}")
    
    conn = sqlite3.connect(DB_PATH)
    cursor = conn.cursor()
    
    try:
        # 检查 user_nickname 列是否存在
        cursor.execute("PRAGMA table_info(characters)")
        columns = [column[1] for column in cursor.fetchall()]
        print(f"当前列: {columns}")
        
        if "user_nickname" not in columns:
            print("添加 user_nickname 列...")
            cursor.execute("ALTER TABLE characters ADD COLUMN user_nickname TEXT")
            print("user_nickname 列添加成功")
        else:
            print("user_nickname 列已存在")
        
        if "is_processing" not in columns:
            print("添加 is_processing 列...")
            cursor.execute("ALTER TABLE characters ADD COLUMN is_processing BOOLEAN DEFAULT 0")
            print("is_processing 列添加成功")
        else:
            print("is_processing 列已存在")
        
        conn.commit()
        print("数据库迁移完成！")
        
    except Exception as e:
        print(f"迁移过程中出错: {e}")
        conn.rollback()
    finally:
        conn.close()

if __name__ == "__main__":
    migrate_database()
