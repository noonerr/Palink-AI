"""全量重算 conversation_memories 的 embedding 为 bge-m3 (SentenceTransformer, 1024 维)。

背景（2026-08-18 后续）：
- 此前容器配置 MEMORY_EMBEDDING_PROVIDER=ollama / OLLAMA_MODEL=bge-m3，但本环境无法安装 Ollama
  （GitHub 被封锁、docker.io 不可达），OllamaEmbedder.embed() 静默降级为 fastembed (512 维)。
  库里 1085 条记忆全是 512 维 fastembed 向量。
- 最终方案：改用 SentenceTransformer 直接加载 BAAI/bge-m3（经 HF 镜像 hf-mirror.com），
  产出与 Ollama+bge-m3 同维度(1024)的向量，无需 Ollama 进程。
- 本脚本把全部 1085 条（assistant + user 两角色）重算为 bge-m3 1024 维，统一语义基准。

行为：
- 仅重写 embedding 列，不动 content / role / 其它字段。
- 预检：当前 embedder 必须真实返回 1024 维（排除依赖未就绪/实际维度非 1024 的情况），否则中止，避免白做。
- 批量推理：每 BATCH 条内容一次性送入 embed_text（CPU 批处理加速），逐行校验维度==1024 后再写库。
- 分批 commit，单批失败回滚该批并继续。

前置：backend 镜像已内置 sentence-transformers，且 BAAI/bge-m3 已下载到
/app/models/sentence_transformers（经 HF 镜像 hf-mirror.com）。容器环境变量
MEMORY_EMBEDDING_PROVIDER=sentencetransformer 生效，get_embedder() 返回
SentenceTransformerEmbedder（1024 维）。本机/容器均无需 Ollama。

用法（在 backend 容器内执行）：
    docker cp backend/scripts/reembed_all_to_bge_m3.py palink-ai-backend-1:/tmp/
    docker exec -w /app -e PYTHONPATH=/app -e MEMORY_EMBEDDING_PROVIDER=sentencetransformer \
        palink-ai-backend-1 python /tmp/reembed_all_to_bge_m3.py
"""

import sys
import json
import logging

sys.path.insert(0, "/app")

from sqlalchemy import text
from app.core.database import SessionLocal
from app.memory_module.embedder import get_embedder, embed_text

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
logger = logging.getLogger("reembed_bge_m3")

TARGET_DIM = 1024
BATCH = 64  # 批量推理条数（CPU 批处理加速）


def preflight() -> None:
    """必须真实返回 1024 维才允许继续；否则直接退出。"""
    emb = get_embedder()
    logger.info("embedder 类型=%s", type(emb).__name__)
    try:
        test = embed_text("连通性自检-需返回1024维")
        dim = int(test.shape[-1])
    except Exception as e:  # noqa: BLE001
        logger.error("embed 预检异常: %s", e)
        sys.exit(2)
    if dim != TARGET_DIM:
        logger.error(
            "当前 embedder 实际维度=%d，非 %d（依赖未就绪或实际维度非 1024）。"
            "中止以免重算成错误维度白做。",
            dim, TARGET_DIM,
        )
        sys.exit(3)
    logger.info("预检通过：embedder=%s 维度=%d", type(emb).__name__, dim)


def main() -> None:
    preflight()

    db = SessionLocal()
    try:
        rows = db.execute(
            text("SELECT id, role, content FROM conversation_memories ORDER BY id")
        ).fetchall()

        total = len(rows)
        ok = 0
        skipped = 0
        failed = 0

        logger.info("待重算总数=%d（批量大小=%d）", total, BATCH)

        i = 0
        while i < total:
            chunk = rows[i : i + BATCH]
            ids = []
            texts = []
            for r in chunk:
                c = r.content or ""
                if not c.strip():
                    skipped += 1
                    continue
                ids.append(r.id)
                texts.append(c)

            if texts:
                try:
                    vecs = embed_text(texts)
                    if len(vecs.shape) == 1:
                        vecs = vecs.reshape(1, -1)
                    if vecs.shape[1] != TARGET_DIM:
                        raise ValueError(f"批量维度异常={vecs.shape[1]}，疑似降级")
                    arr = vecs.tolist()
                    for j, mid in enumerate(ids):
                        v = arr[j]
                        if len(v) != TARGET_DIM:
                            raise ValueError(f"单行维度={len(v)}，疑似降级")
                        db.execute(
                            text(
                                "UPDATE conversation_memories "
                                "SET embedding = :embedding WHERE id = :id"
                            ),
                            {"embedding": json.dumps(v), "id": mid},
                        )
                    ok += len(ids)
                    db.commit()
                    logger.info("进度 ok=%d/%d", ok, total)
                except Exception as e:  # noqa: BLE001
                    db.rollback()
                    failed += len(ids)
                    logger.error("FAIL batch first_id=%s: %s", ids[0] if ids else None, e)

            i += len(chunk)

        db.commit()
        logger.info(
            "SUMMARY total=%d ok=%d skipped=%d failed=%d",
            total, ok, skipped, failed,
        )
        if failed > 0:
            logger.warning("存在失败条目，请检查日志后重跑（已成功的不会重复破坏）")
    finally:
        db.close()


if __name__ == "__main__":
    main()
