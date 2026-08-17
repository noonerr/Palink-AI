#!/usr/bin/env python3
import re
import json
import sys
import os
sys.path.insert(0, '/app')
from app.db import SessionLocal
from app.models.plugin import Plugin, PluginScript

def test_regex():
    try:
        db = SessionLocal()
        print("✓ 连接数据库成功")
        
        # Get regex scripts
        scripts = db.query(PluginScript).join(Plugin).filter(
            Plugin.enabled == True,
            PluginScript.enabled == True,
            PluginScript.script_type == "regex"
        ).order_by(PluginScript.order_no).all()
        
        print(f"✓ 找到 {len(scripts)} 条启用的正则脚本")
        
        # Test text with <start> and </start> tag
        test_text = """<start>BanG! City 测试消息</start>"""
        print(f"\n测试文本: {test_text}")
        
        final = test_text
        for script in scripts:
            print(f"\n  - 应用: {script.script_name}")
            if script.find_regex:
                try:
                    new_text = re.sub(script.find_regex, script.replace_string or "", final)
                    if new_text != final:
                        print(f"    ✓ 替换生效!")
                        final = new_text
                except Exception as e:
                    print(f"    ✗ 错误: {e}")
        
        print(f"\n\n最终结果:")
        print(final[:1000] + ("..." if len(final) > 1000 else ""))
        
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
