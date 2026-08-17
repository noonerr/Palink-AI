#!/usr/bin/env python3
import re
import json
from sqlalchemy import create_engine, text
from sqlalchemy.orm import sessionmaker

# Database URL
DATABASE_URL = "postgresql://ai_user:ai_pass@localhost:5432/ai_hub"

def test_regex():
    try:
        engine = create_engine(DATABASE_URL)
        SessionLocal = sessionmaker(bind=engine)
        db = SessionLocal()
        print("✓ 连接数据库成功")
        
        # Get regex scripts
        scripts = db.execute(text("""
            SELECT ps.script_name, ps.find_regex, ps.replace_string 
            FROM plugin_scripts ps 
            JOIN plugins p ON ps.plugin_id = p.id 
            WHERE ps.script_type = 'regex' AND ps.enabled = true AND p.enabled = true 
            ORDER BY ps.order_no
        """)).all()
        
        print(f"✓ 找到 {len(scripts)} 条启用的正则脚本")
        
        # Test text with <start> and </start> tag
        test_text = """<start>BanG! City 测试消息</start>"""
        print(f"\n测试文本: {test_text[:100]}...")
        
        final = test_text
        for script in scripts:
            script_name, find_regex, replace_string = script
            if find_regex:
                print(f"\n  - 应用: {script_name}")
                try:
                    new_text = re.sub(find_regex, replace_string or "", final)
                    if new_text != final:
                        print(f"    ✓ 替换生效!")
                        final = new_text
                except Exception as e:
                    print(f"    ✗ 错误: {e}")
        
        print(f"\n\n最终结果:")
        print(final[:500] + ("..." if len(final) > 500 else ""))
        
        print("\n\n✓ 测试完成!")
        
    except Exception as e:
        print(f"✗ 错误: {e}")
        import traceback
        traceback.print_exc()
    finally:
        if 'db' in locals():
            db.close()

if __name__ == "__main__":
    test_regex()
