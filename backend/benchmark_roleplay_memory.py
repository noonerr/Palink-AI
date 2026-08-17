
"""
角色扮演场景下向量记忆系统性能基准测试
测试内容：
1. 向量嵌入生成速度
2. 存储速度
3. 语义检索性能
4. 不同记忆规模下的检索速度
"""

import os
import sys
import time
import random
import uuid
import statistics
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker
from app.memory_module import MemoryService, memory_config
from app.memory_module.embedder import get_embedder

# 角色扮演对话数据（模拟真实场景）
ROLEPLAY_DATA = [
    ("user", "你好，我是夏娜，今天真是美好的一天！", 0.6),
    ("assistant", "夏娜小姐，今天天气确实不错。要不要去花园里散步？", 0.6),
    ("user", "好呀！不过我想先去看看那只小猫。你知道它最近怎么样吗？", 0.7),
    ("assistant", "它最近很好，经常在花园里晒太阳。我给它准备了新的食物。", 0.6),
    ("user", "太好了！对了，你能帮我拿一下我的发夹吗？我放在书房桌子上。", 0.8),
    ("assistant", "没问题，夏娜小姐。我这就去帮你拿。", 0.5),
    ("user", "谢谢你！你真是太好了。对了，我记得我们下周要去城堡参加派对，你准备好了吗？", 0.7),
    ("assistant", "是的，夏娜小姐。我已经准备好了您的礼服和配饰。", 0.6),
    ("user", "太棒了！我期待见到王子殿下。你觉得他会喜欢我吗？", 0.8),
    ("assistant", "殿下一定会喜欢您的，夏娜小姐。您是如此美丽和善良。", 0.6),
    ("user", "谢谢你的安慰。有时候我会觉得自己不够好...", 0.9),
    ("assistant", "请不要这样想，夏娜小姐。您在我心中是最完美的。", 0.7),
    ("user", "你真会说话。那我们去花园吧！带上小猫一起去。", 0.6),
    ("assistant", "好的，夏娜小姐。我这就去准备。", 0.5),
]

LONG_ROLEPLAY_DATA = ROLEPLAY_DATA * 10  # 放大到 140 条消息


def benchmark_embedding_speed(embedder, samples=50):
    """测试向量嵌入生成速度"""
    print("\n" + "=" * 60)
    print("📊 测试 1: 向量嵌入生成速度")
    print("=" * 60)
    
    texts = [item[1] for item in ROLEPLAY_DATA]
    single_times = []
    batch_times = []
    
    # 单个文本嵌入
    print(f"\n  单样本嵌入测试 (n={samples})...")
    for i in range(samples):
        text = random.choice(texts)
        start = time.time()
        embedder.embed(text)
        single_times.append(time.time() - start)
    
    # 批量嵌入
    batch_sizes = [1, 5, 10, 20, 50]
    for batch_size in batch_sizes:
        batch_texts = texts[:batch_size] if len(texts) >= batch_size else texts * (batch_size // len(texts) + 1)
        batch_texts = batch_texts[:batch_size]
        
        start = time.time()
        embedder.embed(batch_texts)
        batch_times.append((batch_size, time.time() - start))
    
    print(f"\n  📈 结果：")
    print(f"    单个平均: {statistics.mean(single_times)*1000:.2f}ms")
    print(f"    单个标准差: {statistics.stdev(single_times)*1000:.2f}ms")
    print(f"    单个最快: {min(single_times)*1000:.2f}ms")
    print(f"    单个最慢: {max(single_times)*1000:.2f}ms")
    print()
    for size, t in batch_times:
        print(f"    批量 {size} 条: {t*1000:.2f}ms ({(t/size)*1000:.2f}ms/条)")
    
    return {
        "single_avg": statistics.mean(single_times),
        "single_std": statistics.stdev(single_times),
        "batch": batch_times
    }


def benchmark_memory_storage(db, user_id, session_id):
    """测试记忆存储性能"""
    print("\n" + "=" * 60)
    print("📊 测试 2: 记忆存储性能")
    print("=" * 60)
    
    service = MemoryService(db)
    
    storage_times = []
    print(f"\n  存储 {len(LONG_ROLEPLAY_DATA)} 条角色扮演记忆...")
    
    for role, content, importance in LONG_ROLEPLAY_DATA:
        start = time.time()
        memory_id = service.store_memory(
            user_id=user_id,
            session_id=session_id,
            role=role,
            content=content,
            importance_score=importance
        )
        storage_times.append(time.time() - start)
    
    print(f"\n  📈 结果：")
    print(f"    平均存储: {statistics.mean(storage_times)*1000:.2f}ms/条")
    print(f"    存储标准差: {statistics.stdev(storage_times)*1000:.2f}ms")
    print(f"    总耗时: {sum(storage_times)*1000:.2f}ms")
    print(f"    总条数: {len(storage_times)}")
    
    return {
        "avg": statistics.mean(storage_times),
        "std": statistics.stdev(storage_times),
        "total": sum(storage_times)
    }


def benchmark_memory_retrieval(db, user_id, session_id):
    """测试记忆检索性能"""
    print("\n" + "=" * 60)
    print("📊 测试 3: 记忆检索性能")
    print("=" * 60)
    
    service = MemoryService(db)
    
    # 测试查询
    queries = [
        "夏娜",
        "小猫",
        "花园",
        "派对",
        "礼服",
        "王子",
        "发夹",
        "你觉得"
    ]
    
    retrieval_times = []
    retrieval_counts = []
    
    for query in queries:
        start = time.time()
        memories = service.search_memories(
            user_id=user_id,
            query=query,
            limit=10
        )
        elapsed = time.time() - start
        retrieval_times.append(elapsed)
        retrieval_counts.append(len(memories))
        
        print(f"  查询 '{query}': {elapsed*1000:.2f}ms, {len(memories)} 条")
    
    print(f"\n  📈 结果：")
    print(f"    平均检索: {statistics.mean(retrieval_times)*1000:.2f}ms")
    print(f"    检索标准差: {statistics.stdev(retrieval_times)*1000:.2f}ms")
    print(f"    平均返回: {statistics.mean(retrieval_counts):.1f} 条")
    
    # 测试上下文获取（完整检索）
    print(f"\n  测试上下文获取...")
    import asyncio
    context = asyncio.run(service.get_context(
        user_id=user_id,
        query="夏娜准备去派对",
        max_tokens=1500
    ))
    print(f"    策略: {context.strategy_used}")
    print(f"    记忆数: {len(context.memories)}")
    print(f"    总 tokens: {context.total_tokens}")
    
    return {
        "avg_retrieval": statistics.mean(retrieval_times),
        "std_retrieval": statistics.stdev(retrieval_times),
        "avg_count": statistics.mean(retrieval_counts)
    }


def get_or_create_test_data(db):
    """获取或创建测试数据"""
    from app.models.user import User
    from app.models.session import ChatSession
    
    # 查找或创建测试用户
    user = db.query(User).filter(User.username == "benchmark_user").first()
    if not user:
        user = User(
            username="benchmark_user",
            hashed_password="test",
            role="user"
        )
        db.add(user)
        db.commit()
        db.refresh(user)
        print(f"✅ 创建测试用户: id={user.id}")
    else:
        print(f"✅ 使用现有测试用户: id={user.id}")
    
    # 创建新测试会话
    session = ChatSession(
        id=str(uuid.uuid4()),
        user_id=user.id,
        title="Benchmark Session",
        type="chat"
    )
    db.add(session)
    db.commit()
    db.refresh(session)
    print(f"✅ 创建新测试会话: id={session.id}")
    
    return user.id, session.id


def run_full_benchmark():
    """运行完整基准测试"""
    print("\n" + "=" * 60)
    print("🚀 角色扮演向量记忆系统性能基准测试")
    print("=" * 60)
    
    # 数据库连接
    DATABASE_URL = os.getenv(
        "DATABASE_URL",
        "postgresql://ai_user:ai_password@db:5432/ai_hub"
    )
    
    engine = create_engine(DATABASE_URL)
    Session = sessionmaker(bind=engine)
    db = Session()
    
    try:
        # 测试 0: 环境信息
        print("\n" + "=" * 60)
        print("📊 测试 0: 系统信息")
        print("=" * 60)
        
        embedder = get_embedder()
        print(f"\n  嵌入器类型: {type(embedder).__name__}")
        print(f"  向量维度: {embedder.dimension}")
        print(f"  数据库: {DATABASE_URL.split('@')[1] if '@' in DATABASE_URL else DATABASE_URL}")
        print(f"  记忆配置: {memory_config.__dict__}")
        
        # 获取测试数据
        user_id, session_id = get_or_create_test_data(db)
        
        # 测试 1: 嵌入速度
        embedding_result = benchmark_embedding_speed(embedder)
        
        # 测试 2: 存储速度
        storage_result = benchmark_memory_storage(db, user_id, session_id)
        
        # 测试 3: 检索速度
        retrieval_result = benchmark_memory_retrieval(db, user_id, session_id)
        
        # 汇总结果
        print("\n" + "=" * 60)
        print("📊 完整基准测试结果汇总")
        print("=" * 60)
        
        print(f"\n  📌 嵌入生成")
        print(f"     单条平均: {embedding_result['single_avg']*1000:.2f}ms")
        print(f"     标准差: {embedding_result['single_std']*1000:.2f}ms")
        
        print(f"\n  📌 记忆存储")
        print(f"     单条平均: {storage_result['avg']*1000:.2f}ms")
        print(f"     总耗时: {storage_result['total']*1000:.2f}ms ({len(LONG_ROLEPLAY_DATA)} 条)")
        
        print(f"\n  📌 记忆检索")
        print(f"     单次平均: {retrieval_result['avg_retrieval']*1000:.2f}ms")
        print(f"     标准差: {retrieval_result['std_retrieval']*1000:.2f}ms")
        print(f"     平均返回: {retrieval_result['avg_count']:.1f} 条")
        
        # 性能评估
        print("\n" + "=" * 60)
        print("🏆 性能评估")
        print("=" * 60)
        
        print("\n  ✨ 系统性能等级：")
        if embedding_result['single_avg'] < 0.01:
            print("     嵌入: 🟢 极快")
        elif embedding_result['single_avg'] < 0.05:
            print("     嵌入: 🟢 快")
        elif embedding_result['single_avg'] < 0.2:
            print("     嵌入: 🟡 中等")
        else:
            print("     嵌入: 🔴 慢")
        
        if retrieval_result['avg_retrieval'] < 0.01:
            print("     检索: 🟢 极快")
        elif retrieval_result['avg_retrieval'] < 0.05:
            print("     检索: 🟢 快")
        elif retrieval_result['avg_retrieval'] < 0.2:
            print("     检索: 🟡 中等")
        else:
            print("     检索: 🔴 慢")
        
        if storage_result['avg'] < 0.05:
            print("     存储: 🟢 极快")
        elif storage_result['avg'] < 0.1:
            print("     存储: 🟢 快")
        elif storage_result['avg'] < 0.3:
            print("     存储: 🟡 中等")
        else:
            print("     存储: 🔴 慢")
        
        print("\n🎉 基准测试完成！")
        
    except Exception as e:
        print(f"\n❌ 测试失败: {e}")
        import traceback
        traceback.print_exc()
    finally:
        db.close()


if __name__ == "__main__":
    run_full_benchmark()
