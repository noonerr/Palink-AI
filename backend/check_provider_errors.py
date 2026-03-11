import sqlite3
import json

# 连接数据库
db_path = 'data/palink.db'
conn = sqlite3.connect(db_path)
cursor = conn.cursor()

# 查询provider_test_results表
cursor.execute('''
    SELECT provider_id, provider_name, success, message, base_url, tested_at 
    FROM provider_test_results 
    ORDER BY tested_at DESC 
    LIMIT 10
''')

results = cursor.fetchall()

print("第三方模型测试结果:")
print("-" * 80)

if results:
    for row in results:
        provider_id, provider_name, success, message, base_url, tested_at = row
        status = "成功" if success else "失败"
        print(f"提供商: {provider_name} ({provider_id})")
        print(f"状态: {status}")
        print(f"URL: {base_url}")
        print(f"错误信息: {message}")
        print(f"测试时间: {tested_at}")
        print("-" * 80)
else:
    print("没有找到测试结果")

# 关闭连接
conn.close()

print("\n检查providers.json配置:")
print("-" * 80)

try:
    with open('app/data/providers.json', 'r', encoding='utf-8') as f:
        providers = json.load(f)
    for provider in providers:
        print(f"提供商: {provider.get('name')}")
        print(f"ID: {provider.get('id')}")
        print(f"URL: {provider.get('base_url')}")
        print(f"是否激活: {provider.get('is_active')}")
        print(f"模型数量: {len(provider.get('models', []))}")
        for model in provider.get('models', []):
            print(f"  - {model.get('name')} ({model.get('id')})")
        print("-" * 80)
except Exception as e:
    print(f"读取providers.json失败: {e}")
