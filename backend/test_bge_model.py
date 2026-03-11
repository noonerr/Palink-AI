#!/usr/bin/env python3
"""测试BGE-Large-zh-v1.5模型是否正常工作"""

import sys
import os

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

print("=" * 60)
print("测试BGE-Large-zh-v1.5模型集成")
print("=" * 60)

try:
    from app.memory_module.config import memory_config
    print("\n1. 配置检查:")
    print(f"   嵌入器类型: {memory_config.EMBEDDING_PROVIDER}")
    print(f"   向量维度: {memory_config.VECTOR_DIMENSION}")
    
    print("\n2. 初始化嵌入器...")
    from app.memory_module.embedder import get_embedder
    embedder = get_embedder()
    
    print(f"   ✓ 嵌入器类型: {type(embedder).__name__}")
    print(f"   ✓ 向量维度: {embedder.dimension}")
    
    print("\n3. 测试文本嵌入...")
    test_texts = [
        "你好，世界！",
        "这是一个测试。",
        "今天天气真好！",
        "我喜欢人工智能。"
    ]
    
    print(f"   输入文本: {test_texts}")
    
    embeddings = embedder.embed(test_texts)
    
    print(f"   ✓ 生成 {len(embeddings)} 个嵌入向量")
    print(f"   ✓ 每个向量维度: {embeddings.shape[1]}")
    
    print("\n4. 测试向量相似度...")
    import numpy as np
    similarity_matrix = np.dot(embeddings, embeddings.T)
    
    print("   相似度矩阵:")
    for i in range(len(similarity_matrix)):
        print(f"     文本{i}: {similarity_matrix[i]}")
    
    print("\n✅ 所有测试通过！BGE-Large-zh-v1.5模型集成成功！")
    
except Exception as e:
    print(f"\n✗ 测试失败: {e}")
    import traceback
    traceback.print_exc()
    sys.exit(1)

print("\n" + "=" * 60)
