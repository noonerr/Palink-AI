"""
记忆模块测试脚本
测试内容：
1. 存储记忆
2. 语义检索
3. 获取上下文
4. 用户画像

注意：运行前需要确保数据库中有测试用户和会话
"""

import os
import sys
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker
from app.memory_module import MemoryService, memory_config
from app.memory_module.embedder import get_embedder, embed_text

def test_embedder():
    """测试嵌入模型"""
    print("\n🧪 测试嵌入模型...")
    try:
        embedder = get_embedder()
        print(f"✅ 嵌入模型: {type(embedder).__name__}")
        print(f"   维度: {embedder.dimension}")
        
        # 测试嵌入
        texts = ["Hello world", "你好世界", "数据分析", "Python programming"]
        embeddings = embedder.embed(texts)
        print(f"✅ 嵌入成功: shape={embeddings.shape}")
        
        # 测试相似度
        from numpy import dot
        from numpy.linalg import norm
        
        sim = dot(embeddings[0], embeddings[1]) / (norm(embeddings[0]) * norm(embeddings[1]))
        print(f"   'Hello world' vs '你好世界' 相似度: {sim:.3f}")
        
        sim2 = dot(embeddings[2], embeddings[3]) / (norm(embeddings[2]) * norm(embeddings[3]))
        print(f"   '数据分析' vs 'Python programming' 相似度: {sim2:.3f}")
        
        return True
    except Exception as e:
        print(f"❌ 嵌入模型测试失败: {e}")
        import traceback
        traceback.print_exc()
        return False

def get_or_create_test_data(db):
    """获取或创建测试数据"""
    from app.main import User, ChatSession
    import uuid
    
    # 查找或创建测试用户
    user = db.query(User).filter(User.username == "test_memory_user").first()
    if not user:
        user = User(
            username="test_memory_user",
            hashed_password="test",
            role="user"
        )
        db.add(user)
        db.commit()
        db.refresh(user)
        print(f"✅ 创建测试用户: id={user.id}")
    else:
        print(f"✅ 使用现有测试用户: id={user.id}")
    
    # 查找或创建测试会话
    session = db.query(ChatSession).filter(
        ChatSession.user_id == user.id
    ).first()
    
    if not session:
        session = ChatSession(
            id=str(uuid.uuid4()),
            user_id=user.id,
            title="Memory Test Session",
            type="chat"
        )
        db.add(session)
        db.commit()
        db.refresh(session)
        print(f"✅ 创建测试会话: id={session.id}")
    else:
        print(f"✅ 使用现有测试会话: id={session.id}")
    
    return user.id, session.id

def test_memory_storage():
    """测试记忆存储和检索"""
    print("\n🧪 测试记忆存储...")
    
    DATABASE_URL = os.getenv(
        "DATABASE_URL",
        "postgresql://ai_user:ai_password@db:5432/ai_hub"
    )
    
    engine = create_engine(DATABASE_URL)
    Session = sessionmaker(bind=engine)
    db = Session()
    
    try:
        # 获取测试数据
        user_id, session_id = get_or_create_test_data(db)
        
        service = MemoryService(db)
        
        if not service.is_available():
            print("⚠️ 记忆模块未启用")
            return False
        
        # 测试存储 - 数据科学相关
        print("   存储测试记忆...")
        test_memories = [
            ("user", "我喜欢使用 Python 进行数据分析，pandas 是我的首选工具", 0.8),
            ("assistant", "Python 是数据科学的首选语言，pandas 和 numpy 是核心库。你可以用 pandas 处理 CSV、Excel 等数据格式。", 0.7),
            ("user", "请帮我分析这个销售数据的 CSV 文件", 0.6),
            ("assistant", "我可以帮你分析销售数据。请上传 CSV 文件，我会使用 pandas 读取并进行统计分析。", 0.6),
            ("user", "我想学习机器学习，从什么开始？", 0.7),
            ("assistant", "建议从 scikit-learn 开始，它提供了简单且一致的 API。先学习监督学习中的分类和回归任务。", 0.7),
        ]
        
        stored_ids = []
        for role, content, importance in test_memories:
            memory_id = service.store_memory(
                user_id=user_id,
                session_id=session_id,
                role=role,
                content=content,
                importance_score=importance
            )
            if memory_id:
                stored_ids.append(memory_id)
                print(f"   ✅ 存储成功: id={memory_id}, role={role}")
            else:
                print(f"   ❌ 存储失败: {content[:30]}...")
        
        print(f"✅ 共存储 {len(stored_ids)}/{len(test_memories)} 条记忆")
        return len(stored_ids) > 0
        
    except Exception as e:
        print(f"❌ 存储测试失败: {e}")
        import traceback
        traceback.print_exc()
        return False
    finally:
        db.close()

def test_memory_retrieval():
    """测试记忆检索"""
    print("\n🧪 测试记忆检索...")
    
    DATABASE_URL = os.getenv(
        "DATABASE_URL",
        "postgresql://ai_user:ai_password@db:5432/ai_hub"
    )
    
    engine = create_engine(DATABASE_URL)
    Session = sessionmaker(bind=engine)
    db = Session()
    
    try:
        from app.main import User
        
        # 获取测试用户
        user = db.query(User).filter(User.username == "test_memory_user").first()
        if not user:
            print("❌ 未找到测试用户")
            return False
        
        service = MemoryService(db)
        
        # 测试语义检索
        test_queries = [
            "数据分析",
            "Python",
            "机器学习",
            "CSV 文件"
        ]
        
        for query in test_queries:
            print(f"\n   检索: '{query}'")
            memories = service.search_memories(
                user_id=user.id,
                query=query,
                limit=3
            )
            
            print(f"   ✅ 检索到 {len(memories)} 条记忆:")
            for i, mem in enumerate(memories, 1):
                print(f"      {i}. [{mem.role}] {mem.content[:60]}...")
        
        # 测试获取上下文
        print("\n   测试上下文获取...")
        context = service.get_context(
            user_id=user.id,
            query="我想学习数据科学",
            max_tokens=1500
        )
        
        print(f"✅ 上下文获取成功:")
        print(f"   - 记忆数量: {len(context.memories)}")
        print(f"   - 总 tokens: {context.total_tokens}")
        print(f"   - 策略: {context.strategy_used}")
        
        if context.user_profile:
            print(f"   - 用户画像: {context.user_profile.summary}")
        
        # 显示检索到的记忆
        if context.memories:
            print("\n   检索到的记忆:")
            for i, mem in enumerate(context.memories, 1):
                print(f"      {i}. [{mem.role}] {mem.content[:80]}...")
        
        return len(context.memories) > 0
        
    except Exception as e:
        print(f"❌ 检索测试失败: {e}")
        import traceback
        traceback.print_exc()
        return False
    finally:
        db.close()

def test_recent_memories():
    """测试获取最近记忆"""
    print("\n🧪 测试最近记忆...")
    
    DATABASE_URL = os.getenv(
        "DATABASE_URL",
        "postgresql://ai_user:ai_password@db:5432/ai_hub"
    )
    
    engine = create_engine(DATABASE_URL)
    Session = sessionmaker(bind=engine)
    db = Session()
    
    try:
        from app.main import User
        
        user = db.query(User).filter(User.username == "test_memory_user").first()
        if not user:
            print("❌ 未找到测试用户")
            return False
        
        service = MemoryService(db)
        
        memories = service.get_recent_memories(
            user_id=user.id,
            limit=5
        )
        
        print(f"✅ 获取到 {len(memories)} 条最近记忆")
        for i, mem in enumerate(memories, 1):
            print(f"   {i}. [{mem.created_at}] [{mem.role}] {mem.content[:50]}...")
        
        return len(memories) > 0
        
    except Exception as e:
        print(f"❌ 最近记忆测试失败: {e}")
        import traceback
        traceback.print_exc()
        return False
    finally:
        db.close()

def run_all_tests():
    """运行所有测试"""
    print("=" * 60)
    print("🚀 记忆模块测试开始")
    print("=" * 60)
    
    results = []
    
    # 测试 1: 嵌入模型
    results.append(("嵌入模型", test_embedder()))
    
    # 测试 2: 存储
    results.append(("记忆存储", test_memory_storage()))
    
    # 测试 3: 检索
    results.append(("记忆检索", test_memory_retrieval()))
    
    # 测试 4: 最近记忆
    results.append(("最近记忆", test_recent_memories()))
    
    # 汇总
    print("\n" + "=" * 60)
    print("📊 测试结果汇总")
    print("=" * 60)
    
    for name, passed in results:
        status = "✅ 通过" if passed else "❌ 失败"
        print(f"{status} - {name}")
    
    total = len(results)
    passed = sum(1 for _, p in results if p)
    print(f"\n总计: {passed}/{total} 通过")
    
    if passed == total:
        print("\n🎉 所有测试通过！记忆模块工作正常。")
        print("\n💡 现在可以在前端聊天测试记忆功能：")
        print("   1. 打开 http://localhost:3000")
        print("   2. 发送几条关于'数据分析'、'Python'的消息")
        print("   3. 之后询问相关问题，AI 会引用之前的记忆")
    else:
        print("\n⚠️ 部分测试失败，请检查日志。")

if __name__ == "__main__":
    run_all_tests()
