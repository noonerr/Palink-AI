import sys, os, traceback
log = open("/tmp/test_bge_m3.log", "w", buffering=1)
def L(*a):
    print(*a, file=log, flush=True)
try:
    L("start import get_embedder")
    from app.memory_module.embedder import get_embedder, embed_text
    L("import ok")
    e = get_embedder()
    L("TYPE=" + type(e).__name__ + " DIM=" + str(e.dimension))
    v = embed_text(["测试中文语义检索向量化 bge-m3 模型加载验证"])
    L("EMBED_SHAPE=" + str(getattr(v, "shape", None)))
    L("OK_DONE")
except Exception as ex:
    L("ERROR " + repr(ex))
    traceback.print_exc(file=log)
